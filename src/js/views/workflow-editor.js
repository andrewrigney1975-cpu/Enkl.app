"use strict";
import { getCurrentProject } from '../store.js';
import { iconSvg } from '../icons.js';
import { ensureProjectWorkflow, WORKFLOW_NODE_W, WORKFLOW_NODE_H, WORKFLOW_MARGIN, WORKFLOW_CONDITION_FIELDS, WORKFLOW_CONDITION_OPERATORS, WORKFLOW_DEFAULT_CONDITION, getWorkflowConditionField } from '../features/workflow-engine.js';
import { setWorkflowNodePosition, addWorkflowEdge, updateWorkflowEdge, deleteWorkflowEdge, reflowWorkflowLayout, setColumnCap } from '../mutations.js';
import { isServerAuthoritative, pullWorkflowFromServer, refreshProjectFromServer } from '../features/migration.js';
import { updateProjectWorkflowApi, updateColumnApi } from '../api.js';
import { escapeHTML, getColumn } from '../utils.js';
import { clampColumnCap } from '../storage.js';
import { renderBoard } from './board.js';
import { roundedOrthogonalPathD, DEPMAP_CORNER_RADIUS } from './dependency-map.js';

/* Stub distance a connector travels straight out from a node's face before its first bend — same
   role as dependency-map.js's own DEPMAP_EDGE_STUB, kept as this view's own constant since Workflow
   nodes attach from any of 4 sides (not just left/right), so the two views' routing geometry differs
   even though they share the same fillet-rounding renderer. */
var WORKFLOW_EDGE_STUB = 24;

function iconHTML(name, size){ return '<span class="kf-icon">'+iconSvg(name,size)+'</span>'; }

var _toast = function(msg){ console.error(msg); };
var _confirmDialog = function(title, msg, cb){ if(window.confirm(title + '\n' + msg)) cb(); };
export function setWorkflowEditorDeps(deps){
  if(deps.toast) _toast = deps.toast;
  if(deps.confirmDialog) _confirmDialog = deps.confirmDialog;
}

/* =========================================================
   SVG WORKFLOW EDITOR
   One node per project column, positioned at project.workflow.nodes
   (auto-laid-out left-to-right the first time the workflow is
   materialized, freely draggable and persisted after that — see
   ensureProjectWorkflow in features/workflow-engine.js). Edges are
   directed Allowed/Disallowed/Conditional Allow connectors drawn
   between nodes.
   ========================================================= */
export var workflowEditorState = {
  scale: 1,
  panActive: false, panMoved: false, panStartX: 0, panStartY: 0, panStartScrollLeft: 0, panStartScrollTop: 0,
  mode: 'select',                 // 'select' | 'allowed' | 'disallowed' | 'conditional'
  draggingColumnId: null, dragMoved: false, dragPointerStartX: 0, dragPointerStartY: 0, dragNodeStartX: 0, dragNodeStartY: 0,
  drawingFromColumnId: null,
  popoverEdgeId: null,
  popoverColumnId: null,
  /* True once a local mutation has happened that "Save Workflow" hasn't pushed to the server yet —
     see updateHeaderButtonVisibilitySetting-style save flow, but batched: unlike every other entity,
     workflow edits (drag-heavy, many events/sec) stay local-only until this browser explicitly saves,
     rather than round-tripping the server on every mutation. Guards both openWorkflowOverlay's
     "pull fresh from server" step and the Save button's enabled state. */
  dirty: false
};
var WORKFLOW_EDGE_COLOR = {allowed: 'var(--kf-good-fg)', disallowed: 'var(--kf-danger)', conditional: 'var(--kf-overdue-fg)'};

/* Stroked/hollow circle at the start, filled circle at the end —
   matching dependency-map.js's kf-dot-start / kf-arrow circle markers
   (that view's "arrow" marker is actually a filled dot). */
function dotMarkerPair(id, color){
  return (
    '<marker id="kf-wf-dot-start-' + id + '" viewBox="0 0 10 10" refX="0.75" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="var(--kf-surface)" stroke="' + color + '" stroke-width="1.6"/></marker>' +
    '<marker id="kf-wf-dot-end-' + id + '" viewBox="0 0 10 10" refX="9.25" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="' + color + '" stroke="' + color + '" stroke-width="1.6"/></marker>'
  );
}

function describeWorkflowCondition(condition){
  if(!condition) return '';
  var field = getWorkflowConditionField(condition.field);
  var fieldLabel = field ? field.label : condition.field;
  var opDef = field ? (WORKFLOW_CONDITION_OPERATORS[field.valueKind] || []).filter(function(o){ return o.key === condition.operator; })[0] : null;
  var opLabel = opDef ? opDef.label : condition.operator;
  var valueLabel = '';
  if(opDef && opDef.needsValue){
    if(field && field.valueKind === 'enum'){
      var opt = (field.options || []).filter(function(o){ return o.value === condition.value; })[0];
      valueLabel = ' ' + (opt ? opt.label : condition.value);
    } else {
      valueLabel = ' ' + condition.value;
    }
  }
  return fieldLabel + ' ' + opLabel + valueLabel;
}
export var WORKFLOW_MIN_ZOOM = 0.3;
export var WORKFLOW_MAX_ZOOM = 2.5;
export var lastWorkflowLayout = null;

export function computeWorkflowLayout(project){
  var positions = {};
  var maxX = WORKFLOW_MARGIN, maxY = WORKFLOW_MARGIN;
  project.columns.forEach(function(col){
    var pos = (project.workflow && project.workflow.nodes[col.id]) || {x: WORKFLOW_MARGIN, y: WORKFLOW_MARGIN};
    positions[col.id] = {x: pos.x, y: pos.y};
    maxX = Math.max(maxX, pos.x + WORKFLOW_NODE_W);
    maxY = Math.max(maxY, pos.y + WORKFLOW_NODE_H);
  });
  return {
    positions: positions,
    width: maxX + WORKFLOW_MARGIN,
    height: maxY + WORKFLOW_MARGIN
  };
}

/* Which side of a node's rectangle an edge should attach to, given the
   node's center and the point it's heading toward — whichever axis has
   the larger delta wins, so a mostly-horizontal relationship attaches
   left/right and a mostly-vertical one attaches top/bottom. */
function pickAttachmentSide(fromCenter, toCenter){
  var dx = toCenter.x - fromCenter.x, dy = toCenter.y - fromCenter.y;
  if(Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}
function sideMidpoint(pos, side){
  switch(side){
    case 'right':  return {x: pos.x + WORKFLOW_NODE_W, y: pos.y + WORKFLOW_NODE_H / 2};
    case 'left':   return {x: pos.x, y: pos.y + WORKFLOW_NODE_H / 2};
    case 'top':    return {x: pos.x + WORKFLOW_NODE_W / 2, y: pos.y};
    default:       return {x: pos.x + WORKFLOW_NODE_W / 2, y: pos.y + WORKFLOW_NODE_H};
  }
}
function sideNormal(side){
  return {right: {x: 1, y: 0}, left: {x: -1, y: 0}, top: {x: 0, y: -1}, bottom: {x: 0, y: 1}}[side];
}

/* Orthogonal connector with rounded (filleted) corners — same visual style as dependency-map.js's
   edges (roundedOrthogonalPathD, imported above), generalized from that view's fixed left-to-right
   attachment to any of the 4 sides: each endpoint attaches at the midpoint of whichever side faces
   the other node, and the vertex list between them is built here (dependency-map.js's own
   buildOrthogonalPoints assumes both ends exit horizontally, which doesn't hold once a node can
   attach from its top/bottom too). */
function buildWorkflowOrthogonalPoints(start, dir1, end, dir2){
  // Already a straight shot out of both faces — skip the stub/bend entirely, same as
  // dependency-map.js's own y1===y2 "simple" case, rather than drawing needless dog-legs on the
  // most common adjacent-node layout.
  if(dir1.x !== 0 && dir2.x !== 0 && start.y === end.y) return [start, end];
  if(dir1.y !== 0 && dir2.y !== 0 && start.x === end.x) return [start, end];

  var p1 = {x: start.x + dir1.x * WORKFLOW_EDGE_STUB, y: start.y + dir1.y * WORKFLOW_EDGE_STUB};
  var p2 = {x: end.x + dir2.x * WORKFLOW_EDGE_STUB, y: end.y + dir2.y * WORKFLOW_EDGE_STUB};
  var mid;
  if(dir1.x !== 0 && dir2.x !== 0){
    var midX = (p1.x + p2.x) / 2;
    mid = [{x: midX, y: p1.y}, {x: midX, y: p2.y}];
  } else if(dir1.y !== 0 && dir2.y !== 0){
    var midY = (p1.y + p2.y) / 2;
    mid = [{x: p1.x, y: midY}, {x: p2.x, y: midY}];
  } else if(dir1.x !== 0){
    // One side exits horizontally, the other vertically — a single corner, aligned to the
    // horizontal exit's x-travel first, then turning to match the vertical exit's approach.
    mid = [{x: p2.x, y: p1.y}];
  } else {
    mid = [{x: p1.x, y: p2.y}];
  }
  return [start, p1].concat(mid, [p2, end]);
}

function edgePathD(fromPos, toPos){
  var fromCenter = {x: fromPos.x + WORKFLOW_NODE_W / 2, y: fromPos.y + WORKFLOW_NODE_H / 2};
  var toCenter = {x: toPos.x + WORKFLOW_NODE_W / 2, y: toPos.y + WORKFLOW_NODE_H / 2};
  var startSide = pickAttachmentSide(fromCenter, toCenter);
  var endSide = pickAttachmentSide(toCenter, fromCenter);
  var start = sideMidpoint(fromPos, startSide);
  var end = sideMidpoint(toPos, endSide);
  var points = buildWorkflowOrthogonalPoints(start, sideNormal(startSide), end, sideNormal(endSide));
  return roundedOrthogonalPathD(points, DEPMAP_CORNER_RADIUS);
}

export function updateWorkflowModeButtons(){
  document.querySelectorAll('.kf-workflow-mode-btn').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-mode') === workflowEditorState.mode);
  });
}

export function setWorkflowMode(mode){
  workflowEditorState.mode = (mode === 'allowed' || mode === 'disallowed' || mode === 'conditional') ? mode : 'select';
  workflowEditorState.drawingFromColumnId = null;
  var draft = document.getElementById('workflowDraftEdge');
  if(draft) draft.remove();
  updateWorkflowModeButtons();
}

export function renderWorkflowEditor(){
  var project = getCurrentProject();
  var inner = document.getElementById('workflowInner');
  document.getElementById('workflowTitle').textContent = 'Workflow' + (project ? ' — ' + project.name : '');
  if(!project){
    inner.innerHTML = '';
    lastWorkflowLayout = null;
    return;
  }
  ensureProjectWorkflow(project);

  if(project.columns.length === 0){
    inner.innerHTML = '<div class="kf-depmap-empty">' + iconHTML('inbox', 36) + '<div>This board has no columns yet — add some columns to build a workflow.</div></div>';
    lastWorkflowLayout = null;
    return;
  }

  var layout = computeWorkflowLayout(project);
  lastWorkflowLayout = layout;

  var defsHTML = '<defs>' + dotMarkerPair('allowed', 'var(--kf-good-fg)') + dotMarkerPair('disallowed', 'var(--kf-danger)') + dotMarkerPair('conditional', 'var(--kf-overdue-fg)') + '</defs>';

  var edgesHTML = project.workflow.edges.map(function(e){
    var fromPos = layout.positions[e.fromColumnId], toPos = layout.positions[e.toColumnId];
    if(!fromPos || !toPos) return '';
    var d = edgePathD(fromPos, toPos);
    var color = WORKFLOW_EDGE_COLOR[e.type] || WORKFLOW_EDGE_COLOR.allowed;
    var dashAttr = e.type === 'conditional' ? ' stroke-dasharray="5,5"' : '';
    var titleText = e.type === 'conditional' ? describeWorkflowCondition(e.condition) + (e.message ? ' — ' + e.message : '') : e.message;
    return (
      '<g class="kf-wfedge-group" data-edge-id="' + e.id + '">' +
        (titleText ? '<title>' + escapeHTML(titleText) + '</title>' : '') +
        '<path class="kf-wfedge" d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5"' + dashAttr + ' marker-start="url(#kf-wf-dot-start-' + e.type + ')" marker-end="url(#kf-wf-dot-end-' + e.type + ')"></path>' +
        '<path class="kf-wfedge-hit" data-edge-id="' + e.id + '" d="' + d + '" fill="none" stroke="transparent" stroke-width="16"></path>' +
      '</g>'
    );
  }).join('');

  var nodesHTML = project.columns.map(function(col, idx){
    var pos = layout.positions[col.id];
    var label = (idx + 1) + '. ' + col.name;
    var displayLabel = label.length > 24 ? label.slice(0, 23) + '…' : label;
    // A capped column (col.cap a positive integer, -1 == uncapped) gets a second line showing its
    // limit — the node's hover title also switches to the fuller "<name> - Maximum capacity : <cap>"
    // wording so it's readable even when the name itself is truncated above.
    var hasCap = col.cap != null && col.cap !== -1;
    var titleText = hasCap ? (col.name + ' - Maximum capacity : ' + col.cap) : label;
    var mainLabelY = hasCap ? (WORKFLOW_NODE_H / 2 - 4) : (WORKFLOW_NODE_H / 2 + 5);
    var capHTML = hasCap
      ? '<text x="16" y="' + (WORKFLOW_NODE_H / 2 + 16) + '" font-size="11" style="fill:var(--kf-text-secondary);">Maximum capacity: ' + escapeHTML(String(col.cap)) + '</text>'
      : '';
    return (
      '<g class="kf-wfnode" data-column-id="' + col.id + '" transform="translate(' + pos.x + ',' + pos.y + ')">' +
        '<rect class="kf-wfnode-box" x="0" y="0" width="' + WORKFLOW_NODE_W + '" height="' + WORKFLOW_NODE_H + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border-strong);" stroke-width="1.5"></rect>' +
        (col.done ? '<rect x="0" y="0" width="5" height="' + WORKFLOW_NODE_H + '" rx="2" fill="#22a06b"></rect>' : '') +
        '<text x="16" y="' + mainLabelY + '" font-size="13" font-weight="600" style="fill:var(--kf-text);"><title>' + escapeHTML(titleText) + '</title>' + escapeHTML(displayLabel) + '</text>' +
        capHTML +
      '</g>'
    );
  }).join('');

  var svgHTML =
    '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
      defsHTML + edgesHTML + nodesHTML +
    '</svg>';

  inner.innerHTML = svgHTML;
  applyWorkflowZoom();
}

export function applyWorkflowZoom(){
  var svg = document.querySelector('#workflowInner svg');
  document.getElementById('workflowZoomLabel').textContent = Math.round(workflowEditorState.scale * 100) + '%';
  if(!svg || !lastWorkflowLayout) return;
  svg.setAttribute('width', Math.round(lastWorkflowLayout.width * workflowEditorState.scale));
  svg.setAttribute('height', Math.round(lastWorkflowLayout.height * workflowEditorState.scale));
}
export function setWorkflowZoom(delta){
  workflowEditorState.scale = Math.max(WORKFLOW_MIN_ZOOM, Math.min(WORKFLOW_MAX_ZOOM, Math.round((workflowEditorState.scale + delta) * 100) / 100));
  applyWorkflowZoom();
}
export function resetWorkflowZoom(){
  workflowEditorState.scale = 1;
  applyWorkflowZoom();
  var scroll = document.getElementById('workflowScroll');
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
}
export function zoomWorkflowAtPoint(deltaScale, clientX, clientY){
  if(!lastWorkflowLayout) return;
  var scroll = document.getElementById('workflowScroll');
  if(!scroll) return;

  var oldScale = workflowEditorState.scale;
  var newScale = Math.max(WORKFLOW_MIN_ZOOM, Math.min(WORKFLOW_MAX_ZOOM, Math.round((oldScale + deltaScale) * 100) / 100));
  if(newScale === oldScale) return;

  var rect = scroll.getBoundingClientRect();
  var offsetX = clientX != null ? clientX - rect.left : rect.width / 2;
  var offsetY = clientY != null ? clientY - rect.top : rect.height / 2;

  var oldWidth = lastWorkflowLayout.width * oldScale;
  var oldHeight = lastWorkflowLayout.height * oldScale;
  var fracX = oldWidth > 0 ? (scroll.scrollLeft + offsetX) / oldWidth : 0;
  var fracY = oldHeight > 0 ? (scroll.scrollTop + offsetY) / oldHeight : 0;

  workflowEditorState.scale = newScale;
  applyWorkflowZoom();

  var newWidth = lastWorkflowLayout.width * newScale;
  var newHeight = lastWorkflowLayout.height * newScale;
  scroll.scrollLeft = fracX * newWidth - offsetX;
  scroll.scrollTop = fracY * newHeight - offsetY;
}

/* Rearranges every node into a clean, ordinality-preserving grid that
   reduces how often connectors overlap unrelated nodes — see
   computeReflowedLayout in features/workflow-engine.js for the
   algorithm. Confirms first since it discards any custom positions
   the user has dragged. */
export function handleWorkflowReflow(){
  var project = getCurrentProject();
  if(!project || !project.workflow) return;
  _confirmDialog(
    'Reflow this workflow?',
    'Nodes will be rearranged into a clean grid to reduce connector overlap. Any custom positions you’ve dragged will be replaced.',
    function(){
      reflowWorkflowLayout(project);
      workflowEditorState.dirty = true;
      renderWorkflowEditor();
    }
  );
}

export async function openWorkflowOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  workflowEditorState.scale = 1;
  workflowEditorState.panActive = false;
  workflowEditorState.panMoved = false;
  workflowEditorState.mode = 'select';
  workflowEditorState.draggingColumnId = null;
  workflowEditorState.drawingFromColumnId = null;
  closeWorkflowEdgePopover();
  closeWorkflowColumnCapPopover();
  updateWorkflowModeButtons();

  // Start each session from the server's current workflow — but only when this browser has no
  // unsaved local draft (see workflowEditorState.dirty's comment above) to avoid clobbering it.
  if(isServerAuthoritative(project) && !workflowEditorState.dirty){
    try {
      await pullWorkflowFromServer(project);
    } catch(e){
      _toast('Could not load the latest workflow from the server — showing the local copy.');
    }
  }

  renderWorkflowEditor();
  updateWorkflowSaveButton();
  document.getElementById('workflowOverlay').classList.remove('hidden');
}
export function closeWorkflowOverlay(){
  document.getElementById('workflowOverlay').classList.add('hidden');
  workflowEditorState.panActive = false;
  workflowEditorState.panMoved = false;
  workflowEditorState.draggingColumnId = null;
  workflowEditorState.drawingFromColumnId = null;
  closeWorkflowEdgePopover();
  closeWorkflowColumnCapPopover();
  document.getElementById('workflowScroll').classList.remove('kf-depmap-panning');
}
export function isWorkflowOverlayOpen(){
  return !document.getElementById('workflowOverlay').classList.contains('hidden');
}

/* Reflects workflowEditorState.dirty on the Save button — only meaningful for a server-authoritative
   project (a local-only project has nothing to push, since every edit already lands in local
   storage the normal way — see mutations.js). */
export function updateWorkflowSaveButton(){
  var project = getCurrentProject();
  var btn = document.getElementById('workflowSaveBtn');
  if(!btn) return;
  var applicable = isServerAuthoritative(project);
  btn.classList.toggle('hidden', !applicable);
  btn.classList.toggle('kf-workflow-save-dirty', applicable && workflowEditorState.dirty);
  btn.disabled = !applicable || !workflowEditorState.dirty;
  btn.textContent = workflowEditorState.dirty ? 'Save Workflow*' : 'Save Workflow';
}

export async function saveWorkflowToServer(){
  var project = getCurrentProject();
  if(!project || !isServerAuthoritative(project)) return;
  try {
    await updateProjectWorkflowApi(project.serverProjectId, project.workflow);
    workflowEditorState.dirty = false;
    updateWorkflowSaveButton();
    _toast('Workflow saved.');
  } catch(e){
    _toast('Could not save workflow on the server: ' + (e.message || 'unknown error'));
  }
}

function clientPointToSvgPoint(clientX, clientY){
  var svg = document.querySelector('#workflowInner svg');
  if(!svg) return {x: 0, y: 0};
  var rect = svg.getBoundingClientRect();
  var scale = workflowEditorState.scale || 1;
  return {x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale};
}

function startWorkflowNodeDrag(columnId, clientX, clientY){
  var project = getCurrentProject();
  if(!project || !project.workflow) return;
  var node = project.workflow.nodes[columnId];
  if(!node) return;
  workflowEditorState.draggingColumnId = columnId;
  workflowEditorState.dragMoved = false;
  workflowEditorState.dragPointerStartX = clientX;
  workflowEditorState.dragPointerStartY = clientY;
  workflowEditorState.dragNodeStartX = node.x;
  workflowEditorState.dragNodeStartY = node.y;
}

function updateWorkflowDraftEdge(clientX, clientY){
  var project = getCurrentProject();
  var draft = document.getElementById('workflowDraftEdge');
  if(!draft || !project || !project.workflow) return;
  var fromNode = project.workflow.nodes[workflowEditorState.drawingFromColumnId];
  if(!fromNode) return;
  var point = clientPointToSvgPoint(clientX, clientY);
  var fromCenter = {x: fromNode.x + WORKFLOW_NODE_W / 2, y: fromNode.y + WORKFLOW_NODE_H / 2};
  var side = pickAttachmentSide(fromCenter, point);
  var start = sideMidpoint(fromNode, side);
  var dir1 = sideNormal(side);
  // No "end side" exists yet while still dragging (the cursor isn't attached to a node) — a single
  // stub-out-then-straight-to-cursor segment, filleted the same way, rather than the full two-sided
  // routing edgePathD does once a real target side is known.
  var stub = {x: start.x + dir1.x * WORKFLOW_EDGE_STUB, y: start.y + dir1.y * WORKFLOW_EDGE_STUB};
  draft.setAttribute('d', roundedOrthogonalPathD([start, stub, point], DEPMAP_CORNER_RADIUS));
}

function startWorkflowEdgeDraw(columnId, clientX, clientY){
  workflowEditorState.drawingFromColumnId = columnId;
  var svg = document.querySelector('#workflowInner svg');
  if(!svg) return;
  var draft = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  draft.setAttribute('id', 'workflowDraftEdge');
  draft.setAttribute('fill', 'none');
  draft.setAttribute('stroke', WORKFLOW_EDGE_COLOR[workflowEditorState.mode] || WORKFLOW_EDGE_COLOR.allowed);
  draft.setAttribute('stroke-width', '2.5');
  draft.setAttribute('stroke-dasharray', '5,4');
  svg.appendChild(draft);
  updateWorkflowDraftEdge(clientX, clientY);
}

function updateConnectedWorkflowEdges(project, columnId){
  var layout = lastWorkflowLayout;
  if(!layout) return;
  layout.positions[columnId] = {x: project.workflow.nodes[columnId].x, y: project.workflow.nodes[columnId].y};
  project.workflow.edges.forEach(function(e){
    if(e.fromColumnId !== columnId && e.toColumnId !== columnId) return;
    var fromPos = layout.positions[e.fromColumnId], toPos = layout.positions[e.toColumnId];
    if(!fromPos || !toPos) return;
    var d = edgePathD(fromPos, toPos);
    var group = document.querySelector('.kf-wfedge-group[data-edge-id="' + e.id + '"]');
    if(!group) return;
    var path = group.querySelector('.kf-wfedge');
    var hit = group.querySelector('.kf-wfedge-hit');
    if(path) path.setAttribute('d', d);
    if(hit) hit.setAttribute('d', d);
  });
}

/* Single mousedown entry point for the scroll container: dispatches to
   node-drag or edge-draw when the pointer is down on a node, otherwise
   falls through to panning — mirroring the org chart / dependency map
   pan wiring, but node/edge interactions take priority over pan. */
export function handleWorkflowScrollMouseDown(e){
  if(e.button !== 0) return;
  var nodeEl = e.target.closest ? e.target.closest('.kf-wfnode') : null;
  if(nodeEl){
    var columnId = nodeEl.getAttribute('data-column-id');
    if(workflowEditorState.mode === 'select') startWorkflowNodeDrag(columnId, e.clientX, e.clientY);
    else startWorkflowEdgeDraw(columnId, e.clientX, e.clientY);
    return;
  }
  workflowEditorState.panActive = true;
  workflowEditorState.panMoved = false;
  workflowEditorState.panStartX = e.clientX;
  workflowEditorState.panStartY = e.clientY;
  var scroll = document.getElementById('workflowScroll');
  workflowEditorState.panStartScrollLeft = scroll.scrollLeft;
  workflowEditorState.panStartScrollTop = scroll.scrollTop;
  scroll.classList.add('kf-depmap-panning');
}

export function handleWorkflowPointerMove(e){
  if(workflowEditorState.draggingColumnId){
    var project = getCurrentProject();
    if(!project || !project.workflow) return;
    var dxScreen = e.clientX - workflowEditorState.dragPointerStartX;
    var dyScreen = e.clientY - workflowEditorState.dragPointerStartY;
    if(Math.abs(dxScreen) > 2 || Math.abs(dyScreen) > 2) workflowEditorState.dragMoved = true;
    var scale = workflowEditorState.scale || 1;
    var newX = Math.max(0, workflowEditorState.dragNodeStartX + dxScreen / scale);
    var newY = Math.max(0, workflowEditorState.dragNodeStartY + dyScreen / scale);
    var node = project.workflow.nodes[workflowEditorState.draggingColumnId];
    if(!node) return;
    node.x = newX;
    node.y = newY;
    var nodeEl = document.querySelector('.kf-wfnode[data-column-id="' + workflowEditorState.draggingColumnId + '"]');
    if(nodeEl) nodeEl.setAttribute('transform', 'translate(' + newX + ',' + newY + ')');
    updateConnectedWorkflowEdges(project, workflowEditorState.draggingColumnId);
    return;
  }
  if(workflowEditorState.drawingFromColumnId){
    updateWorkflowDraftEdge(e.clientX, e.clientY);
    return;
  }
  if(workflowEditorState.panActive){
    var scroll = document.getElementById('workflowScroll');
    var dx = e.clientX - workflowEditorState.panStartX;
    var dy = e.clientY - workflowEditorState.panStartY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) workflowEditorState.panMoved = true;
    if(workflowEditorState.panMoved){
      scroll.scrollLeft = workflowEditorState.panStartScrollLeft - dx;
      scroll.scrollTop = workflowEditorState.panStartScrollTop - dy;
    }
  }
}

export function handleWorkflowPointerUp(e){
  if(workflowEditorState.draggingColumnId){
    var project = getCurrentProject();
    var columnId = workflowEditorState.draggingColumnId;
    workflowEditorState.draggingColumnId = null;
    /* Only persist + re-render when the node actually moved. A plain click (mousedown+mouseup with
       no drag) must leave the SVG's DOM untouched — re-rendering here replaces #workflowInner's
       innerHTML BEFORE the browser's synthetic 'click' event fires, detaching the very node that
       was clicked and silently swallowing the click before handleWorkflowInnerClick ever sees it
       (this is what broke the column-click Cap popover: a re-render on every click, moved or not,
       meant the click bubbled through an already-removed subtree). */
    if(workflowEditorState.dragMoved && project && project.workflow && project.workflow.nodes[columnId]){
      var node = project.workflow.nodes[columnId];
      setWorkflowNodePosition(project, columnId, node.x, node.y);
      workflowEditorState.dirty = true;
      updateWorkflowSaveButton();
      renderWorkflowEditor();
    }
    /* dragMoved stays true through the synthetic 'click' this mouseup
       is about to trigger (so a drag that happens to release over a
       connector doesn't also pop its properties open), then clears on
       a delay — mirrors ui.dragWasMove's card-drag-vs-click guard in
       views/board.js. Without this reset, dragMoved stuck true forever
       after the first node drag, silently blocking every future
       connector click for the rest of the session. */
    if(workflowEditorState.dragMoved){
      setTimeout(function(){ workflowEditorState.dragMoved = false; }, 50);
    }
    return;
  }
  if(workflowEditorState.drawingFromColumnId){
    var fromColumnId = workflowEditorState.drawingFromColumnId;
    workflowEditorState.drawingFromColumnId = null;
    var draft = document.getElementById('workflowDraftEdge');
    if(draft) draft.remove();
    var targetEl = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
    var targetNodeEl = targetEl && targetEl.closest ? targetEl.closest('.kf-wfnode') : null;
    var toColumnId = targetNodeEl ? targetNodeEl.getAttribute('data-column-id') : null;
    if(toColumnId && toColumnId !== fromColumnId){
      var project2 = getCurrentProject();
      var condition = workflowEditorState.mode === 'conditional' ? WORKFLOW_DEFAULT_CONDITION : null;
      var edge = addWorkflowEdge(project2, fromColumnId, toColumnId, workflowEditorState.mode, null, condition);
      workflowEditorState.dirty = true;
      updateWorkflowSaveButton();
      renderWorkflowEditor();
      if(edge && (workflowEditorState.mode === 'disallowed' || workflowEditorState.mode === 'conditional')){
        openWorkflowEdgePopover(edge.id, e.clientX, e.clientY);
      }
    }
    return;
  }
  if(workflowEditorState.panActive){
    workflowEditorState.panActive = false;
    var scroll = document.getElementById('workflowScroll');
    if(scroll) scroll.classList.remove('kf-depmap-panning');
  }
}

export function handleWorkflowInnerClick(e){
  if(workflowEditorState.panMoved || workflowEditorState.dragMoved) return;
  if(workflowEditorState.mode !== 'select') return;
  var hit = e.target.closest ? e.target.closest('.kf-wfedge-hit') : null;
  if(hit){
    openWorkflowEdgePopover(hit.getAttribute('data-edge-id'), e.clientX, e.clientY);
    return;
  }
  var nodeHit = e.target.closest ? e.target.closest('.kf-wfnode') : null;
  if(!nodeHit) return;
  openWorkflowColumnCapPopover(nodeHit.getAttribute('data-column-id'), e.clientX, e.clientY);
}

function populateWorkflowEdgeConditionFieldOptions(){
  var select = document.getElementById('workflowEdgeConditionFieldSelect');
  if(select.options.length > 0) return;
  WORKFLOW_CONDITION_FIELDS.forEach(function(f){
    var opt = document.createElement('option');
    opt.value = f.key;
    opt.textContent = f.label;
    select.appendChild(opt);
  });
}

/* Repopulates the operator <select> for whichever field is currently
   chosen, and shows/hides the value control (a <select> for enum
   fields like Priority, a text/number <input> otherwise) — every
   operator for a given field shares the same "needs a value?" answer
   (presence/boolean operators never need one; enum/number operators
   always do), so visibility only depends on the field, not which
   operator is picked. Pass the edge's saved operator/value to restore
   them if still valid for the (possibly just-changed) field; omit them
   to reset to that field's first operator with an empty value. */
function updateWorkflowEdgeOperatorOptions(preserveOperator, preserveValue){
  var fieldKey = document.getElementById('workflowEdgeConditionFieldSelect').value;
  var field = getWorkflowConditionField(fieldKey) || WORKFLOW_CONDITION_FIELDS[0];
  var operators = WORKFLOW_CONDITION_OPERATORS[field.valueKind] || [];
  var opSelect = document.getElementById('workflowEdgeConditionOperatorSelect');
  opSelect.innerHTML = '';
  operators.forEach(function(o){
    var opt = document.createElement('option');
    opt.value = o.key;
    opt.textContent = o.label;
    opSelect.appendChild(opt);
  });
  opSelect.value = operators.some(function(o){ return o.key === preserveOperator; }) ? preserveOperator : (operators[0] ? operators[0].key : '');

  var needsValue = operators.length > 0 && operators[0].needsValue;
  var valueField = document.getElementById('workflowEdgeConditionValueField');
  var valueSelect = document.getElementById('workflowEdgeConditionValueSelect');
  var valueInput = document.getElementById('workflowEdgeConditionValueInput');
  valueField.classList.toggle('hidden', !needsValue);
  if(!needsValue) return;
  if(field.valueKind === 'enum'){
    valueSelect.innerHTML = '';
    (field.options || []).forEach(function(o){
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      valueSelect.appendChild(opt);
    });
    valueSelect.value = (field.options || []).some(function(o){ return o.value === preserveValue; }) ? preserveValue : (field.options[0] && field.options[0].value);
    valueSelect.classList.remove('hidden');
    valueInput.classList.add('hidden');
  } else {
    valueInput.type = field.valueKind === 'number' ? 'number' : 'text';
    valueInput.value = preserveValue != null ? preserveValue : '';
    valueInput.classList.remove('hidden');
    valueSelect.classList.add('hidden');
  }
}

export function openWorkflowEdgePopover(edgeId, clientX, clientY){
  var project = getCurrentProject();
  var edge = project && project.workflow ? project.workflow.edges.filter(function(e){ return e.id === edgeId; })[0] : null;
  if(!edge) return;
  workflowEditorState.popoverEdgeId = edgeId;
  var fromCol = project.columns.filter(function(c){ return c.id === edge.fromColumnId; })[0];
  var toCol = project.columns.filter(function(c){ return c.id === edge.toColumnId; })[0];
  document.getElementById('workflowEdgePopoverTitle').textContent =
    (fromCol ? fromCol.name : '?') + ' → ' + (toCol ? toCol.name : '?');
  document.getElementById('workflowEdgeTypeSelect').value = edge.type;
  document.getElementById('workflowEdgeMessageInput').value = edge.message || '';

  populateWorkflowEdgeConditionFieldOptions();
  var condition = edge.condition || WORKFLOW_DEFAULT_CONDITION;
  document.getElementById('workflowEdgeConditionFieldSelect').value = condition.field;
  updateWorkflowEdgeOperatorOptions(condition.operator, condition.value);
  updateWorkflowEdgePopoverMessageVisibility();

  var popover = document.getElementById('workflowEdgePopover');
  popover.classList.remove('hidden');
  var popW = popover.offsetWidth || 280;
  var left = Math.min(clientX, window.innerWidth - popW - 12);
  left = Math.max(8, left);
  var top = Math.min(clientY, window.innerHeight - 12);
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}
/* Handles the type <select>'s change: shown for the currently-selected
   type. The message field is shown for both Disallowed and Conditional
   Allow (a Conditional edge needs a message for its block path too);
   the condition builder is shown only for Conditional Allow. */
export function updateWorkflowEdgePopoverMessageVisibility(){
  var type = document.getElementById('workflowEdgeTypeSelect').value;
  document.getElementById('workflowEdgeMessageField').classList.toggle('hidden', type === 'allowed');
  document.getElementById('workflowEdgeConditionRow').classList.toggle('hidden', type !== 'conditional');
  if(type !== 'conditional') document.getElementById('workflowEdgeConditionValueField').classList.add('hidden');
}
/* Called when the type select changes to (or within) Conditional Allow
   so the operator/value controls reflect whatever field is currently
   chosen, even if the edge wasn't Conditional a moment ago. */
export function refreshWorkflowEdgeConditionControls(){
  if(document.getElementById('workflowEdgeTypeSelect').value !== 'conditional') return;
  populateWorkflowEdgeConditionFieldOptions();
  updateWorkflowEdgeOperatorOptions(
    document.getElementById('workflowEdgeConditionOperatorSelect').value,
    document.getElementById('workflowEdgeConditionValueSelect').value
  );
}
export function handleWorkflowEdgeConditionFieldChange(){
  updateWorkflowEdgeOperatorOptions();
}
export function closeWorkflowEdgePopover(){
  document.getElementById('workflowEdgePopover').classList.add('hidden');
  workflowEditorState.popoverEdgeId = null;
}
export function isWorkflowEdgePopoverOpen(){
  return !document.getElementById('workflowEdgePopover').classList.contains('hidden');
}
export function saveWorkflowEdgePopover(){
  var project = getCurrentProject();
  if(!project || !workflowEditorState.popoverEdgeId) return;
  var type = document.getElementById('workflowEdgeTypeSelect').value;
  var message = document.getElementById('workflowEdgeMessageInput').value;
  var condition = null;
  if(type === 'conditional'){
    var fieldKey = document.getElementById('workflowEdgeConditionFieldSelect').value;
    var operator = document.getElementById('workflowEdgeConditionOperatorSelect').value;
    var field = getWorkflowConditionField(fieldKey);
    var valueEl = (field && field.valueKind === 'enum')
      ? document.getElementById('workflowEdgeConditionValueSelect')
      : document.getElementById('workflowEdgeConditionValueInput');
    condition = {field: fieldKey, operator: operator, value: valueEl.classList.contains('hidden') ? null : valueEl.value};
  }
  updateWorkflowEdge(project, workflowEditorState.popoverEdgeId, type, message, condition);
  workflowEditorState.dirty = true;
  updateWorkflowSaveButton();
  closeWorkflowEdgePopover();
  renderWorkflowEditor();
}
export function deleteWorkflowEdgeFromPopover(){
  var project = getCurrentProject();
  if(!project || !workflowEditorState.popoverEdgeId) return;
  deleteWorkflowEdge(project, workflowEditorState.popoverEdgeId);
  workflowEditorState.dirty = true;
  updateWorkflowSaveButton();
  closeWorkflowEdgePopover();
  renderWorkflowEditor();
}

export function openWorkflowColumnCapPopover(columnId, clientX, clientY){
  var project = getCurrentProject();
  var col = project ? getColumn(project, columnId) : null;
  if(!col) return;
  workflowEditorState.popoverColumnId = columnId;
  document.getElementById('workflowColumnCapPopoverTitle').textContent = col.name;
  document.getElementById('workflowColumnCapInput').value = (col.cap == null || col.cap === -1) ? '' : col.cap;

  var popover = document.getElementById('workflowColumnCapPopover');
  popover.classList.remove('hidden');
  var popW = popover.offsetWidth || 240;
  var left = Math.min(clientX, window.innerWidth - popW - 12);
  left = Math.max(8, left);
  var top = Math.min(clientY, window.innerHeight - 12);
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}
export function closeWorkflowColumnCapPopover(){
  document.getElementById('workflowColumnCapPopover').classList.add('hidden');
  workflowEditorState.popoverColumnId = null;
}
export function isWorkflowColumnCapPopoverOpen(){
  return !document.getElementById('workflowColumnCapPopover').classList.contains('hidden');
}
/* Cap lives on the Column entity itself, not the batched project.workflow blob (see the
   Context note on this feature), so a server-authoritative project's save bypasses the
   "Save Workflow" dirty-flag flow entirely and PUTs the column immediately. */
export async function saveWorkflowColumnCapPopover(){
  var project = getCurrentProject();
  var columnId = workflowEditorState.popoverColumnId;
  if(!project || !columnId) return;
  var col = getColumn(project, columnId);
  if(!col) return;
  var cap = clampColumnCap(document.getElementById('workflowColumnCapInput').value);

  if(isServerAuthoritative(project)){
    try {
      var order = project.columns.findIndex(function(c){ return c.id === columnId; });
      await updateColumnApi(project.serverProjectId, columnId, col.name, col.done, col.color, order, cap);
      await refreshProjectFromServer(project.id);
    } catch(e){
      _toast('Could not save the column cap on the server: ' + (e.message || 'unknown error'));
      return;
    }
  } else {
    setColumnCap(project, columnId, cap);
  }
  closeWorkflowColumnCapPopover();
  renderWorkflowEditor();
  // The board's own count badge shows "<current> of <cap>" once a column is capped (see
  // views/board.js's renderColumn) — without this, that badge kept showing whatever it last
  // rendered until some unrelated re-render happened to run after the Workflow Manager closed.
  renderBoard();
}
