"use strict";
import { getCurrentProject } from '../store.js';
import { normalizeHeaderButtonVisibility } from '../storage.js';
import { iconSvg } from '../icons.js';
import { ui } from '../ui.js';

function escapeHTML(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function buildEl(tag, className, innerHTML){ var el = document.createElement(tag); if(className) el.className = className; if(innerHTML !== undefined) el.innerHTML = innerHTML; return el; }
function iconHTML(name, size){ return '<span class="kf-icon">'+iconSvg(name,size)+'</span>'; }

var _toast = function(msg){ console.error(msg); };
export function setGovMapDeps(deps){
  if(deps.toast) _toast = deps.toast;
}

/* =========================================================
   GOVERNANCE MAP
   A radial tree: the Project sits at the center, the 5
   governance artefact types form a ring of category hubs
   around it (only the types enabled in App Settings), and each
   hub's individual artefacts form an outer leaf ring, spread
   across that hub's angular sector. Curved lines layered on top
   of the tree show cross-artefact relationships (e.g. a Decision
   linking to Documents/Risks/Principles/Objectives).
   ========================================================= */
export var govMapState = {scale: 1, panActive: false, panMoved: false, panStartX: 0, panStartY: 0, panStartScrollLeft: 0, panStartScrollTop: 0};
export var GOVMAP_MIN_ZOOM = 0.3;
export var GOVMAP_MAX_ZOOM = 2.5;
export var lastGovMapLayout = null;

export var GOVMAP_CENTER_NODE_R = 34;
export var GOVMAP_HUB_NODE_R = 22;
export var GOVMAP_LEAF_NODE_R = 9;
export var GOVMAP_HUB_RADIUS = 150;
export var GOVMAP_LEAF_RADIUS_MIN = 300;
export var GOVMAP_LEAF_ARC_MIN = 46;
export var GOVMAP_MARGIN = 60;

export var GOVMAP_CATEGORIES = [
  {key: 'principles', label: 'Principles', icon: 'compass',     getItems: function(p){ return p.principles || []; }},
  {key: 'objectives', label: 'Objectives', icon: 'target',      getItems: function(p){ return p.objectives || []; }},
  {key: 'documents',  label: 'Documents',  icon: 'ty_document', getItems: function(p){ return p.documents || []; }},
  {key: 'risks',      label: 'Risks',      icon: 'warning',     getItems: function(p){ return p.risks || []; }},
  {key: 'decisions',  label: 'Decisions',  icon: 'ty_approve',  getItems: function(p){ return p.decisions || []; }}
];

export var GOVMAP_TYPE_ACCENT = {
  principles: '#6554c0',
  objectives: '#00875a',
  documents:  '#0c66e4',
  risks:      '#de350b',
  decisions:  '#ff991f'
};

export function isGovernanceMapEnabled(visibility){
  return GOVMAP_CATEGORIES.some(function(c){ return visibility[c.key]; });
}

/* Angle wraparound-safe midpoint: if the two angles are more than half a
   turn apart, one of them is on the "wrong side" of the 0/2π seam for a
   plain average, so normalize by adding a full turn to the smaller one
   first. */
function angularMidpoint(a, b){
  if(Math.abs(a - b) > Math.PI){
    if(a < b) a += Math.PI * 2; else b += Math.PI * 2;
  }
  return (a + b) / 2;
}

export function computeGovernanceMapLayout(project){
  var visibility = normalizeHeaderButtonVisibility(project.headerButtonVisibility);
  var categories = GOVMAP_CATEGORIES.filter(function(c){ return visibility[c.key]; });

  var byId = {};
  categories.forEach(function(c){
    c.getItems(project).forEach(function(item){ byId[item.id] = {item: item, type: c.key}; });
  });

  var totalLeaves = 0;
  categories.forEach(function(c){ totalLeaves += c.getItems(project).length; });
  var leafRadius = Math.max(GOVMAP_LEAF_RADIUS_MIN, (totalLeaves * GOVMAP_LEAF_ARC_MIN) / (2 * Math.PI));

  var size = 2 * (leafRadius + GOVMAP_MARGIN);
  var cx = leafRadius + GOVMAP_MARGIN;
  var cy = leafRadius + GOVMAP_MARGIN;
  var rotationOffset = -Math.PI / 2;

  var hubs = [];
  var leaves = [];
  var positions = {};

  var sectorAngle = categories.length > 0 ? (Math.PI * 2) / categories.length : 0;
  categories.forEach(function(cat, i){
    var sectorStart = i * sectorAngle;
    var hubAngle = sectorStart + sectorAngle / 2;
    var finalHubAngle = hubAngle + rotationOffset;
    var hubPos = {angle: finalHubAngle, radius: GOVMAP_HUB_RADIUS, x: cx + GOVMAP_HUB_RADIUS * Math.cos(finalHubAngle), y: cy + GOVMAP_HUB_RADIUS * Math.sin(finalHubAngle)};
    positions[cat.key] = hubPos;

    var items = cat.getItems(project);
    var sectorInset = Math.max(sectorAngle * 0.08, 0.03);
    var usableArc = Math.max(sectorAngle - 2 * sectorInset, 0);

    var catLeaves = items.map(function(item, j){
      var angle;
      if(items.length === 1) angle = hubAngle;
      else angle = sectorStart + sectorInset + (usableArc * j) / (items.length - 1);
      var finalAngle = angle + rotationOffset;
      var pos = {angle: finalAngle, radius: leafRadius, x: cx + leafRadius * Math.cos(finalAngle), y: cy + leafRadius * Math.sin(finalAngle), type: cat.key, item: item};
      positions[item.id] = pos;
      return pos;
    });

    hubs.push({key: cat.key, label: cat.label, icon: cat.icon, empty: items.length === 0, pos: hubPos});
    leaves = leaves.concat(catLeaves);
  });

  /* Relationship edges — the complete in-scope cross-artefact edge set.
     Principles never link outward; they're pure leaves/targets. */
  var relationshipEdges = [];
  function addEdge(fromId, toId, fromType, toType){
    if(!positions[fromId] || !positions[toId]) return;
    relationshipEdges.push({fromId: fromId, toId: toId, fromType: fromType, toType: toType});
  }
  (project.objectives || []).forEach(function(o){
    (o.principleIds || []).forEach(function(id){ addEdge(o.id, id, 'objectives', 'principles'); });
  });
  (project.documents || []).forEach(function(d){
    (d.relatedDocumentIds || []).forEach(function(id){ if(id !== d.id) addEdge(d.id, id, 'documents', 'documents'); });
  });
  (project.risks || []).forEach(function(r){
    (r.documentIds || []).forEach(function(id){ addEdge(r.id, id, 'risks', 'documents'); });
    (r.principleIds || []).forEach(function(id){ addEdge(r.id, id, 'risks', 'principles'); });
    (r.objectiveIds || []).forEach(function(id){ addEdge(r.id, id, 'risks', 'objectives'); });
  });
  (project.decisions || []).forEach(function(d){
    (d.documentIds || []).forEach(function(id){ addEdge(d.id, id, 'decisions', 'documents'); });
    (d.riskIds || []).forEach(function(id){ addEdge(d.id, id, 'decisions', 'risks'); });
    (d.principleIds || []).forEach(function(id){ addEdge(d.id, id, 'decisions', 'principles'); });
    (d.objectiveIds || []).forEach(function(id){ addEdge(d.id, id, 'decisions', 'objectives'); });
  });

  return {
    categories: categories,
    hubs: hubs,
    leaves: leaves,
    relationshipEdges: relationshipEdges,
    positions: positions,
    center: {x: cx, y: cy},
    leafRadius: leafRadius,
    width: size,
    height: size
  };
}

function truncateTitle(title){
  return title.length > 22 ? title.slice(0, 21) + '…' : title;
}

export function renderGovernanceMap(){
  var project = getCurrentProject();
  var inner = document.getElementById('govMapInner');
  var legend = document.getElementById('govMapLegend');
  document.getElementById('govMapTitle').textContent = 'Governance Map' + (project ? ' — ' + project.name : '');

  var enabled = project && isGovernanceMapEnabled(normalizeHeaderButtonVisibility(project.headerButtonVisibility));
  if(!enabled){
    legend.innerHTML = '';
    inner.innerHTML = '';
    inner.appendChild(buildEl('div', 'kf-depmap-empty', iconHTML('radar', 36) + '<div>No governance artefact types are enabled — turn on Principles, Objectives, Documents, Risks or Decisions in App Settings to use the Governance Map.</div>'));
    lastGovMapLayout = null;
    return;
  }

  var layout = computeGovernanceMapLayout(project);
  lastGovMapLayout = layout;

  legend.innerHTML = layout.categories.map(function(c){
    return '<span class="kf-legend-item"><span class="kf-legend-dot" style="background:' + GOVMAP_TYPE_ACCENT[c.key] + ';"></span>' + escapeHTML(c.label) + '</span>';
  }).join('') + (ui.govMapShowRelationships ? '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:#8993a4;"></span>Relationship</span>' : '');

  var cx = layout.center.x, cy = layout.center.y;

  var treeEdgesHTML = layout.hubs.map(function(h){
    return '<path class="kf-govmap-tree-edge" data-a="center" data-b="' + h.key + '" d="M ' + cx + ' ' + cy + ' L ' + h.pos.x + ' ' + h.pos.y + '"></path>';
  }).join('') + layout.leaves.map(function(l){
    var hub = layout.positions[l.type];
    return '<path class="kf-govmap-tree-edge" data-a="' + l.type + '" data-b="' + l.item.id + '" d="M ' + hub.x + ' ' + hub.y + ' L ' + l.x + ' ' + l.y + '"></path>';
  }).join('');

  var relationshipEdgesHTML = !ui.govMapShowRelationships ? '' : layout.relationshipEdges.map(function(e){
    var from = layout.positions[e.fromId], to = layout.positions[e.toId];
    var midAngle = angularMidpoint(from.angle, to.angle);
    var controlRadius = layout.leafRadius * 0.35;
    var cpx = cx + controlRadius * Math.cos(midAngle);
    var cpy = cy + controlRadius * Math.sin(midAngle);
    return '<path class="kf-govmap-edge" data-a="' + e.fromId + '" data-b="' + e.toId + '" d="M ' + from.x + ' ' + from.y + ' Q ' + cpx + ' ' + cpy + ' ' + to.x + ' ' + to.y + '"></path>';
  }).join('');

  var centerHTML =
    '<g class="kf-govmap-center" data-node-key="center" transform="translate(' + cx + ',' + cy + ')">' +
      '<circle r="' + GOVMAP_CENTER_NODE_R + '"></circle>' +
      '<text y="' + (GOVMAP_CENTER_NODE_R + 18) + '" text-anchor="middle">' + escapeHTML(truncateTitle(project.name || 'Project')) + '</text>' +
    '</g>';

  var hubsHTML = layout.hubs.map(function(h){
    return (
      '<g class="kf-govmap-node kf-govmap-hub' + (h.empty ? ' kf-govmap-hub-empty' : '') + '" data-type="' + h.key + '" data-node-key="' + h.key + '" transform="translate(' + h.pos.x + ',' + h.pos.y + ')">' +
        '<circle r="' + GOVMAP_HUB_NODE_R + '" style="fill:' + GOVMAP_TYPE_ACCENT[h.key] + ';"></circle>' +
        '<text y="' + (GOVMAP_HUB_NODE_R + 16) + '" text-anchor="middle">' + escapeHTML(h.label) + '</text>' +
      '</g>'
    );
  }).join('');

  var leavesHTML = layout.leaves.map(function(l){
    var degrees = l.angle * 180 / Math.PI;
    var title = truncateTitle(l.item.title || l.item.name || '');
    var labelHTML = Math.cos(l.angle) >= 0
      ? '<g transform="rotate(' + degrees + ')"><text x="' + (GOVMAP_LEAF_NODE_R + 6) + '" y="4" text-anchor="start">' + escapeHTML(title) + '</text></g>'
      : '<g transform="rotate(' + degrees + ')"><text x="-' + (GOVMAP_LEAF_NODE_R + 6) + '" y="4" transform="rotate(180)" text-anchor="end">' + escapeHTML(title) + '</text></g>';
    return (
      '<g class="kf-govmap-node kf-govmap-leaf" data-type="' + l.type + '" data-id="' + l.item.id + '" data-node-key="' + l.item.id + '" transform="translate(' + l.x + ',' + l.y + ')">' +
        '<title>' + escapeHTML(l.item.title || l.item.name || '') + '</title>' +
        '<circle r="' + GOVMAP_LEAF_NODE_R + '" style="fill:' + GOVMAP_TYPE_ACCENT[l.type] + ';"></circle>' +
        labelHTML +
      '</g>'
    );
  }).join('');

  var svgHTML =
    '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
      treeEdgesHTML + relationshipEdgesHTML + centerHTML + hubsHTML + leavesHTML +
    '</svg>';

  inner.innerHTML = svgHTML;
  applyGovMapZoom();
  wireGovMapHover();
}

/* Hovering a node isolates the connectors touching it — every other
   tree/relationship edge is hidden so the hovered node's links stand
   out in a dense map. Wired once against the stable #govMapInner
   container (only its innerHTML is replaced on re-render, so a single
   delegated listener survives across renders). */
var govMapHoverWired = false;
function wireGovMapHover(){
  if(govMapHoverWired) return;
  govMapHoverWired = true;
  var inner = document.getElementById('govMapInner');
  inner.addEventListener('mouseover', function(e){
    var node = e.target.closest('[data-node-key]');
    if(!node) return;
    highlightGovMapNode(node.getAttribute('data-node-key'));
  });
  inner.addEventListener('mouseout', function(e){
    var node = e.target.closest('[data-node-key]');
    if(!node) return;
    var related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-node-key]') : null;
    if(related === node) return;
    clearGovMapHighlight();
  });
}

function highlightGovMapNode(key){
  var inner = document.getElementById('govMapInner');
  inner.querySelectorAll('.kf-govmap-tree-edge, .kf-govmap-edge').forEach(function(edge){
    var connected = edge.getAttribute('data-a') === key || edge.getAttribute('data-b') === key;
    edge.classList.toggle('kf-govmap-edge-hidden', !connected);
  });
}

function clearGovMapHighlight(){
  var inner = document.getElementById('govMapInner');
  inner.querySelectorAll('.kf-govmap-edge-hidden').forEach(function(edge){ edge.classList.remove('kf-govmap-edge-hidden'); });
}

export function applyGovMapZoom(){
  var svg = document.querySelector('#govMapInner svg');
  document.getElementById('govMapZoomLabel').textContent = Math.round(govMapState.scale * 100) + '%';
  if(!svg || !lastGovMapLayout) return;
  svg.setAttribute('width', Math.round(lastGovMapLayout.width * govMapState.scale));
  svg.setAttribute('height', Math.round(lastGovMapLayout.height * govMapState.scale));
}

export function setGovMapZoom(delta){
  govMapState.scale = Math.max(GOVMAP_MIN_ZOOM, Math.min(GOVMAP_MAX_ZOOM, Math.round((govMapState.scale + delta) * 100) / 100));
  applyGovMapZoom();
}
function centerGovMapHorizontally(){
  var scroll = document.getElementById('govMapScroll');
  if(!scroll) return;
  scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
}

export function resetGovMapZoom(){
  govMapState.scale = 1;
  applyGovMapZoom();
  var scroll = document.getElementById('govMapScroll');
  scroll.scrollTop = 0;
  centerGovMapHorizontally();
}

export function zoomGovMapAtPoint(deltaScale, clientX, clientY){
  if(!lastGovMapLayout) return;
  var scroll = document.getElementById('govMapScroll');
  if(!scroll) return;

  var oldScale = govMapState.scale;
  var newScale = Math.max(GOVMAP_MIN_ZOOM, Math.min(GOVMAP_MAX_ZOOM, Math.round((oldScale + deltaScale) * 100) / 100));
  if(newScale === oldScale) return;

  var rect = scroll.getBoundingClientRect();
  var offsetX = clientX != null ? clientX - rect.left : rect.width / 2;
  var offsetY = clientY != null ? clientY - rect.top : rect.height / 2;

  var oldWidth = lastGovMapLayout.width * oldScale;
  var oldHeight = lastGovMapLayout.height * oldScale;
  var fracX = oldWidth > 0 ? (scroll.scrollLeft + offsetX) / oldWidth : 0;
  var fracY = oldHeight > 0 ? (scroll.scrollTop + offsetY) / oldHeight : 0;

  govMapState.scale = newScale;
  applyGovMapZoom();

  var newWidth = lastGovMapLayout.width * newScale;
  var newHeight = lastGovMapLayout.height * newScale;
  scroll.scrollLeft = fracX * newWidth - offsetX;
  scroll.scrollTop = fracY * newHeight - offsetY;
}

export function updateGovMapRelationshipsToggleButton(){
  var btn = document.getElementById('govMapRelationshipsToggle');
  var label = document.getElementById('govMapRelationshipsToggleLabel');
  if(!btn) return;
  btn.classList.toggle('active', !ui.govMapShowRelationships);
  label.textContent = ui.govMapShowRelationships ? 'Hide relationships' : 'Show relationships';
  btn.title = ui.govMapShowRelationships ? 'Hide relationships' : 'Show relationships';
}

export function toggleGovMapShowRelationships(){
  ui.govMapShowRelationships = !ui.govMapShowRelationships;
  updateGovMapRelationshipsToggleButton();
  renderGovernanceMap();
}

export function openGovMapOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  if(!isGovernanceMapEnabled(normalizeHeaderButtonVisibility(project.headerButtonVisibility))){ _toast('Enable at least one governance artefact type in App Settings first.'); return; }
  govMapState.scale = 1;
  govMapState.panActive = false;
  govMapState.panMoved = false;
  updateGovMapRelationshipsToggleButton();
  document.getElementById('govMapOverlay').classList.remove('hidden');
  renderGovernanceMap();
  centerGovMapHorizontally();
}
export function closeGovMapOverlay(){
  document.getElementById('govMapOverlay').classList.add('hidden');
  govMapState.panActive = false;
  govMapState.panMoved = false;
  document.getElementById('govMapScroll').classList.remove('kf-govmap-panning');
}
export function isGovMapOpen(){
  return !document.getElementById('govMapOverlay').classList.contains('hidden');
}
