"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg } from '../icons.js';
import { memberInitials, utcISOToLocalDateValue, utcISOToLocalDisplayDate } from '../date-utils.js';
import { getMemberById, getTasksArray, getDocumentById } from '../utils.js';
import { addDocument, updateDocument, deleteDocument, normalizeDocumentationUrl } from '../mutations.js';
import { renderDocumentPickerInto, getCheckedDocumentIdsFrom } from './pickers.js';
import { confirmDialog } from './confirm.js';
import { scheduleDocumentSuggestions, disposeDocumentSuggestionWorker } from '../features/document-suggestions.js';
import { documentApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';

// Lazily created on first showDocumentsFormView() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor (see its comment for why "create once, reuse via
// setMarkdown()" is safe here too: this modal's DOM subtree is static, never removed/replaced).
var documentDescEditor = null;
function getDocumentDescEditor(){
  if(!documentDescEditor){
    documentDescEditor = createRichTextEditor(document.getElementById('documentDescEditor'), document.getElementById('documentDescToolbar'), { maxLength: 1000 });
  }
  return documentDescEditor;
}

/* =========================================================
   DOCUMENT RELATIONSHIP MAP
   Renders project.documents as a radial tree per connected
   component of the (undirected) "related document(s)" graph —
   the most-connected document in each cluster sits at the
   center, with its neighbors spaced evenly around it in rings
   by BFS depth. Documents with no relationships at all are
   placed separately below, as faded, unconnected nodes.
   ========================================================= */
var DOCMAP_NODE_W = 200;
var DOCMAP_NODE_H = 64;
var DOCMAP_RING_GAP = 170;
var DOCMAP_CLUSTER_GAP = 60;
var DOCMAP_ISOLATED_GAP_X = 24;
var DOCMAP_ISOLATED_GAP_Y = 20;
var DOCMAP_MARGIN = 30;

function buildDocumentGraph(docs){
  var adjacency = {};
  docs.forEach(function(d){ adjacency[d.id] = new Set(); });
  docs.forEach(function(d){
    (d.relatedDocumentIds || []).forEach(function(otherId){
      if(!adjacency.hasOwnProperty(otherId)) return;
      adjacency[d.id].add(otherId);
      adjacency[otherId].add(d.id);
    });
  });
  return adjacency;
}

function computeConnectedComponents(docs, adjacency){
  var docMap = {};
  docs.forEach(function(d){ docMap[d.id] = d; });
  var visited = {};
  var components = [];
  docs.forEach(function(d){
    if(visited[d.id]) return;
    visited[d.id] = true;
    var queue = [d.id];
    var comp = [];
    while(queue.length){
      var id = queue.shift();
      comp.push(docMap[id]);
      adjacency[id].forEach(function(neighborId){
        if(!visited[neighborId]){ visited[neighborId] = true; queue.push(neighborId); }
      });
    }
    components.push(comp);
  });
  return components;
}

/* BFS from the highest-degree node in the component, assigning each
   node a ring (its BFS depth) and spacing nodes within a ring at
   equal angles around a full circle — the same "good enough, no
   crossing-minimization" heuristic the dependency map's barycenter
   sort and the org chart's tree layout already rely on. Returns
   node positions relative to the cluster's own center (0,0). */
function computeRadialClusterLayout(component, adjacency){
  var docMap = {};
  component.forEach(function(d){ docMap[d.id] = d; });

  var root = component.slice().sort(function(a, b){
    var degDiff = adjacency[b.id].size - adjacency[a.id].size;
    return degDiff !== 0 ? degDiff : a.key.localeCompare(b.key, undefined, {numeric: true});
  })[0];

  var depth = {};
  depth[root.id] = 0;
  var ringIds = [[root.id]];
  var queue = [root.id];
  while(queue.length){
    var id = queue.shift();
    var d = depth[id];
    adjacency[id].forEach(function(neighborId){
      if(!docMap[neighborId] || depth.hasOwnProperty(neighborId)) return;
      depth[neighborId] = d + 1;
      if(!ringIds[d + 1]) ringIds[d + 1] = [];
      ringIds[d + 1].push(neighborId);
      queue.push(neighborId);
    });
  }

  var nodes = [{doc: root, cx: 0, cy: 0}];
  var maxRadius = 0;
  for(var ring = 1; ring < ringIds.length; ring++){
    var ids = ringIds[ring];
    if(!ids || ids.length === 0) continue;
    var r = ring * DOCMAP_RING_GAP;
    maxRadius = Math.max(maxRadius, r);
    ids.sort(function(a, b){ return docMap[a].key.localeCompare(docMap[b].key, undefined, {numeric: true}); });
    ids.forEach(function(id, idx){
      var angle = (idx / ids.length) * Math.PI * 2 - Math.PI / 2;
      nodes.push({doc: docMap[id], cx: r * Math.cos(angle), cy: r * Math.sin(angle)});
    });
  }

  var boundingRadius = maxRadius + Math.max(DOCMAP_NODE_W, DOCMAP_NODE_H) / 2;
  return {nodes: nodes, radius: boundingRadius};
}

function computeDocumentMapLayout(project){
  var docs = project.documents || [];
  var adjacency = buildDocumentGraph(docs);
  var components = computeConnectedComponents(docs, adjacency);
  var connectedComponents = components.filter(function(c){ return c.length > 1; });
  var isolatedDocs = components.filter(function(c){ return c.length === 1; }).map(function(c){ return c[0]; })
    .sort(function(a, b){ return a.key.localeCompare(b.key, undefined, {numeric: true}); });

  var allNodes = [];
  var xCursor = DOCMAP_MARGIN;
  var maxClusterHeight = 0;

  connectedComponents.forEach(function(comp){
    var cluster = computeRadialClusterLayout(comp, adjacency);
    var centerX = xCursor + cluster.radius;
    var centerY = DOCMAP_MARGIN + cluster.radius;
    cluster.nodes.forEach(function(n){
      allNodes.push({
        doc: n.doc,
        x: centerX + n.cx - DOCMAP_NODE_W / 2,
        y: centerY + n.cy - DOCMAP_NODE_H / 2,
        cx: centerX + n.cx,
        cy: centerY + n.cy
      });
    });
    xCursor += cluster.radius * 2 + DOCMAP_CLUSTER_GAP;
    maxClusterHeight = Math.max(maxClusterHeight, cluster.radius * 2);
  });

  var clustersWidth = connectedComponents.length ? (xCursor - DOCMAP_CLUSTER_GAP + DOCMAP_MARGIN) : DOCMAP_MARGIN * 2;
  var colWidth = DOCMAP_NODE_W + DOCMAP_ISOLATED_GAP_X;
  var cols = Math.max(1, Math.floor((clustersWidth - DOCMAP_MARGIN) / colWidth));
  var isolatedY = DOCMAP_MARGIN + maxClusterHeight + (connectedComponents.length ? 60 : 0);
  isolatedDocs.forEach(function(d, idx){
    var col = idx % cols;
    var row = Math.floor(idx / cols);
    var x = DOCMAP_MARGIN + col * colWidth;
    var y = isolatedY + row * (DOCMAP_NODE_H + DOCMAP_ISOLATED_GAP_Y);
    allNodes.push({doc: d, x: x, y: y, cx: x + DOCMAP_NODE_W / 2, cy: y + DOCMAP_NODE_H / 2, isolated: true});
  });

  var positions = {};
  allNodes.forEach(function(n){ positions[n.doc.id] = n; });

  var edges = [];
  var seenEdges = {};
  Object.keys(adjacency).forEach(function(id){
    if(!positions[id]) return;
    adjacency[id].forEach(function(otherId){
      if(!positions[otherId]) return;
      var edgeKey = [id, otherId].sort().join('|');
      if(seenEdges[edgeKey]) return;
      seenEdges[edgeKey] = true;
      edges.push({fromId: id, toId: otherId});
    });
  });

  var maxX = DOCMAP_MARGIN, maxY = DOCMAP_MARGIN;
  allNodes.forEach(function(n){
    maxX = Math.max(maxX, n.x + DOCMAP_NODE_W);
    maxY = Math.max(maxY, n.y + DOCMAP_NODE_H);
  });

  return {
    nodes: allNodes,
    edges: edges,
    positions: positions,
    width: allNodes.length ? maxX + DOCMAP_MARGIN : DOCMAP_MARGIN * 2,
    height: allNodes.length ? maxY + DOCMAP_MARGIN : DOCMAP_MARGIN * 2
  };
}

function renderDocumentMap(){
  var project = getCurrentProject();
  var chartEl = document.getElementById('documentsMapChart');
  var noDataEl = document.getElementById('documentsMapNoData');
  var legendEl = document.getElementById('documentsMapLegend');
  var docs = project ? (project.documents || []) : [];

  if(docs.length === 0){
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'No documents yet — add one above to see the relationship map here.';
    return;
  }
  noDataEl.classList.add('hidden');

  var layout = computeDocumentMapLayout(project);

  var edgesHTML = layout.edges.map(function(e){
    var from = layout.positions[e.fromId], to = layout.positions[e.toId];
    if(!from || !to) return '';
    return '<line class="kf-docmap-edge" x1="' + from.cx + '" y1="' + from.cy + '" x2="' + to.cx + '" y2="' + to.cy + '" stroke="var(--kf-border-strong)" stroke-width="2"></line>';
  }).join('');

  var nodesHTML = layout.nodes.map(function(n){
    var d = n.doc;
    var owner = getMemberById(project, d.ownerId);
    var title = d.title.length > 24 ? d.title.slice(0, 23) + '…' : d.title;
    var linkBadge = d.url
      ? '<g transform="translate(' + (DOCMAP_NODE_W - 24) + ',8)" style="color:var(--kf-text-secondary);"><title>Has a linked URL</title>' + iconSvg('externalLink', 16) + '</g>'
      : '';
    var ownerBadge = owner
      ? '<g><title>' + escapeHTML(owner.name) + '</title><circle cx="' + (DOCMAP_NODE_W - 18) + '" cy="' + (DOCMAP_NODE_H - 16) + '" r="10" fill="' + owner.color + '"></circle>' +
        '<text x="' + (DOCMAP_NODE_W - 18) + '" y="' + (DOCMAP_NODE_H - 12.5) + '" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">' + escapeHTML(memberInitials(owner.name)) + '</text></g>'
      : '';
    return (
      '<g class="kf-docmap-node' + (n.isolated ? ' kf-docmap-node-isolated' : '') + '" data-document-id="' + d.id + '" transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect class="kf-docmap-node-box" x="0" y="0" width="' + DOCMAP_NODE_W + '" height="' + DOCMAP_NODE_H + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border);" stroke-width="1.5"></rect>' +
        '<text x="16" y="20" font-size="10" font-weight="700" style="fill:var(--kf-text-faint);">' + escapeHTML(d.key) + '</text>' +
        '<text x="16" y="38" font-size="13" font-weight="600" style="fill:var(--kf-text);"><title>' + escapeHTML(d.title) + '</title>' + escapeHTML(title) + '</text>' +
        linkBadge + ownerBadge +
      '</g>'
    );
  }).join('');

  chartEl.innerHTML =
    '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
      edgesHTML + nodesHTML +
    '</svg>';

  legendEl.innerHTML =
    '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:var(--kf-border-strong);"></span>Line = related documents</span>' +
    '<span class="kf-health-legend-item" style="opacity:0.85;"><span class="kf-health-legend-swatch" style="background:var(--kf-border-strong);opacity:0.6;"></span>Faded node = no related documents yet</span>' +
    '<span class="kf-health-legend-item">' + iconSvg('externalLink', 12) + ' Has a linked URL</span>';
}

export function updateDocUrlOpenButtonVisibilityFor(inputId, btnId){
  var hasValue = document.getElementById(inputId).value.trim().length > 0;
  document.getElementById(btnId).classList.toggle('hidden', !hasValue);
}
export function openUrlInputInNewTab(inputId){
  var url = normalizeDocumentationUrl(document.getElementById(inputId).value);
  if(!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function populateOwnerSelect(selectEl, project, currentOwnerId){
  selectEl.innerHTML = '<option value="">Unassigned</option>';
  (project.members || []).forEach(function(m){
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentOwnerId || '';
}
export function populateTaskSelect(selectEl, project, currentTaskId){
  selectEl.innerHTML = '<option value="">No task linked</option>';
  getTasksArray(project).filter(function(t){ return !t.archived; }).forEach(function(t){
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.key + ' — ' + t.title;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentTaskId || '';
}

export function openDocumentsOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.documentsSearchTerm = '';
  document.getElementById('documentsSearchInput').value = '';
  showDocumentsListView();
  document.getElementById('documentsOverlay').classList.remove('hidden');
}
export function closeDocumentsOverlay(){
  disposeDocumentSuggestionWorker();
  document.getElementById('documentsOverlay').classList.add('hidden');
}
export function isDocumentsOverlayOpen(){
  return !document.getElementById('documentsOverlay').classList.contains('hidden');
}

export function showDocumentsListView(){
  disposeDocumentSuggestionWorker();
  ui.editingDocumentId = null;
  document.getElementById('documentsModalTitle').textContent = 'Documents';
  document.getElementById('documentsListView').classList.remove('hidden');
  document.getElementById('documentsFormView').classList.add('hidden');
  document.getElementById('documentsListFooter').classList.remove('hidden');
  document.getElementById('documentsFormFooter').classList.add('hidden');
  renderDocumentsList();
}

export function showDocumentsFormView(docId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingDocumentId = docId || null;
  var doc = docId ? getDocumentById(project, docId) : null;

  document.getElementById('documentsModalTitle').textContent = doc ? 'Edit Document' : 'New Document';
  document.getElementById('documentsListView').classList.add('hidden');
  document.getElementById('documentsFormView').classList.remove('hidden');
  document.getElementById('documentsListFooter').classList.add('hidden');
  document.getElementById('documentsFormFooter').classList.remove('hidden');
  document.getElementById('deleteDocumentBtn').classList.toggle('hidden', !doc);

  document.getElementById('documentTitleInput').value = doc ? doc.title : '';
  document.getElementById('documentUrlInput').value = doc && doc.url ? doc.url : '';
  updateDocUrlOpenButtonVisibilityFor('documentUrlInput', 'documentUrlOpenBtn');
  getDocumentDescEditor().setMarkdown(doc ? doc.description : '');
  populateOwnerSelect(document.getElementById('documentOwnerSelect'), project, doc ? doc.ownerId : null);
  populateTaskSelect(document.getElementById('documentTaskSelect'), project, doc ? doc.taskId : null);
  renderDocumentPickerInto('documentRelatedPicker', project, doc ? doc.relatedDocumentIds : [], docId || null);
  scheduleDocumentSuggestions(project, docId || null);

  var metaEl = document.getElementById('documentMetaDates');
  if(doc){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(doc.dateCreated) +
      (doc.dateLastModified && doc.dateLastModified !== doc.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(doc.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('documentTitleInput').focus();
}

export function renderDocumentsList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('documentsList');
  listEl.innerHTML = '';
  if(!project) return;

  var allDocs = (project.documents || []).slice().sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allDocs.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No documents yet. Add one above to start building this project\'s document register.</div>';
    renderDocumentMap();
    return;
  }

  var term = ui.documentsSearchTerm.trim().toLowerCase();
  var docs = term ? allDocs.filter(function(d){
    var owner = getMemberById(project, d.ownerId);
    var hay = [d.key, d.title, d.description, owner ? owner.name : ''].join(' ').toLowerCase();
    return hay.indexOf(term) !== -1;
  }) : allDocs;

  if(docs.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No documents match “' + escapeHTML(ui.documentsSearchTerm.trim()) + '”.</div>';
    renderDocumentMap();
    return;
  }

  docs.forEach(function(d){
    var owner = getMemberById(project, d.ownerId);
    var linkedTask = d.taskId ? project.tasks[d.taskId] : null;

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-document-id', d.id);

    var metaHTML = '';
    if(owner){
      metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + owner.color + ';">' + escapeHTML(memberInitials(owner.name)) + '</span><span>' + escapeHTML(owner.name) + '</span>';
    } else {
      metaHTML += '<span>Unassigned</span>';
    }
    metaHTML += '<span>Added ' + escapeHTML(utcISOToLocalDisplayDate(d.dateCreated)) + '</span>';
    if(linkedTask) metaHTML += '<span>' + escapeHTML(linkedTask.key) + '</span>';
    if(d.relatedDocumentIds && d.relatedDocumentIds.length > 0){
      metaHTML += '<span>' + d.relatedDocumentIds.length + ' related</span>';
    }

    var urlLinkHTML = d.url
      ? '<a class="kf-doc-row-link" href="' + escapeHTML(d.url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + escapeHTML(d.url) + ' in a new tab" aria-label="Open document link in a new tab">' + iconSvg('externalLink', 14) + '</a>'
      : '';

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(d.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(d.title) + '</span>' +
        urlLinkHTML +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    var urlLinkEl = row.querySelector('.kf-doc-row-link');
    if(urlLinkEl){
      urlLinkEl.addEventListener('click', function(e){ e.stopPropagation(); });
    }
    row.addEventListener('click', function(){ showDocumentsFormView(d.id); });
    listEl.appendChild(row);
  });

  renderDocumentMap();
}

export async function saveDocumentFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('documentTitleInput').value.trim();
  if(!title){ toast('Please enter a document title.'); return; }

  var data = {
    title: title,
    url: document.getElementById('documentUrlInput').value,
    description: getDocumentDescEditor().getMarkdown(),
    ownerId: document.getElementById('documentOwnerSelect').value || null,
    taskId: document.getElementById('documentTaskSelect').value || null,
    relatedDocumentIds: getCheckedDocumentIdsFrom('documentRelatedPicker')
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingDocumentId;
      var body = Object.assign({}, data, {url: normalizeDocumentationUrl(data.url)});
      if(editingId) await documentApi.update(project.serverProjectId, editingId, body);
      else await documentApi.create(project.serverProjectId, body);
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Document updated.' : 'Document created.');
      showDocumentsListView();
    } catch(e){
      toast('Could not save document on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingDocumentId){
    updateDocument(project, ui.editingDocumentId, data);
    toast('Document updated.');
  } else {
    addDocument(project, data);
    toast('Document created.');
  }
  showDocumentsListView();
}

export function deleteDocumentFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingDocumentId) return;
  var doc = getDocumentById(project, ui.editingDocumentId);
  if(!doc) return;
  confirmDialog(
    'Delete ' + doc.key + '?',
    'Any risks or decisions linking to this document will have the link removed.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await documentApi.remove(project.serverProjectId, doc.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + doc.key + '.');
          showDocumentsListView();
        } catch(e){
          toast('Could not delete document on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      var unlinked = deleteDocument(project, doc.id);
      toast('Deleted ' + doc.key + (unlinked > 0 ? ' — removed ' + unlinked + ' link(s) from risks/decisions.' : '.'));
      showDocumentsListView();
    }
  );
}
