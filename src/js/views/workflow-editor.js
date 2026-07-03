"use strict";
import { getCurrentProject } from '../store.js';
import { iconSvg } from '../icons.js';
import { ensureProjectWorkflow, WORKFLOW_NODE_W, WORKFLOW_NODE_H, WORKFLOW_MARGIN, WORKFLOW_CONDITION_FIELDS, WORKFLOW_CONDITION_OPERATORS, WORKFLOW_DEFAULT_CONDITION, getWorkflowConditionField } from '../features/workflow-engine.js';
import { setWorkflowNodePosition, addWorkflowEdge, updateWorkflowEdge, deleteWorkflowEdge } from '../mutations.js';

function escapeHTML(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function iconHTML(name, size){ return '<span class="kf-icon">'+iconSvg(name,size)+'</span>'; }

var _toast = function(msg){ console.error(msg); };
export function setWorkflowEditorDeps(deps){
  if(deps.toast) _toast = deps.toast;
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
  popoverEdgeId: null
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

/* Curved connector (matching dependency-map.js's cubic-bezier edges),
   generalized from that view's fixed left-to-right attachment to any
   of the 4 sides — each endpoint attaches at the midpoint of whichever
   side faces the other node, with control points pulling the curve out
   perpendicular to that side so it flows smoothly out of the box. */
function edgePathD(fromPos, toPos){
  var fromCenter = {x: fromPos.x + WORKFLOW_NODE_W / 2, y: fromPos.y + WORKFLOW_NODE_H / 2};
  var toCenter = {x: toPos.x + WORKFLOW_NODE_W / 2, y: toPos.y + WORKFLOW_NODE_H / 2};
  var startSide = pickAttachmentSide(fromCenter, toCenter);
  var endSide = pickAttachmentSide(toCenter, fromCenter);
  var start = sideMidpoint(fromPos, startSide);
  var end = sideMidpoint(toPos, endSide);
  var dist = Math.hypot(end.x - start.x, end.y - start.y);
  var bend = Math.max(40, dist * 0.4);
  var sn = sideNormal(startSide), en = sideNormal(endSide);
  var c1 = {x: start.x + sn.x * bend, y: start.y + sn.y * bend};
  var c2 = {x: end.x + en.x * bend, y: end.y + en.y * bend};
  return 'M ' + start.x + ' ' + start.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + end.x + ' ' + end.y;
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
    return (
      '<g class="kf-wfnode" data-column-id="' + col.id + '" transform="translate(' + pos.x + ',' + pos.y + ')">' +
        '<rect class="kf-wfnode-box" x="0" y="0" width="' + WORKFLOW_NODE_W + '" height="' + WORKFLOW_NODE_H + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border-strong);" stroke-width="1.5"></rect>' +
        (col.done ? '<rect x="0" y="0" width="5" height="' + WORKFLOW_NODE_H + '" rx="2" fill="#22a06b"></rect>' : '') +
        '<text x="16" y="' + (WORKFLOW_NODE_H / 2 + 5) + '" font-size="13" font-weight="600" style="fill:var(--kf-text);"><title>' + escapeHTML(label) + '</title>' + escapeHTML(displayLabel) + '</text>' +
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

export function openWorkflowOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  workflowEditorState.scale = 1;
  workflowEditorState.panActive = false;
  workflowEditorState.panMoved = false;
  workflowEditorState.mode = 'select';
  workflowEditorState.draggingColumnId = null;
  workflowEditorState.drawingFromColumnId = null;
  closeWorkflowEdgePopover();
  updateWorkflowModeButtons();
  renderWorkflowEditor();
  document.getElementById('workflowOverlay').classList.remove('hidden');
}
export function closeWorkflowOverlay(){
  document.getElementById('workflowOverlay').classList.add('hidden');
  workflowEditorState.panActive = false;
  workflowEditorState.panMoved = false;
  workflowEditorState.draggingColumnId = null;
  workflowEditorState.drawingFromColumnId = null;
  closeWorkflowEdgePopover();
  document.getElementById('workflowScroll').classList.remove('kf-depmap-panning');
}
export function isWorkflowOverlayOpen(){
  return !document.getElementById('workflowOverlay').classList.contains('hidden');
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
  var sn = sideNormal(side);
  var bend = Math.max(40, Math.hypot(point.x - start.x, point.y - start.y) * 0.4);
  var c1 = {x: start.x + sn.x * bend, y: start.y + sn.y * bend};
  draft.setAttribute('d', 'M ' + start.x + ' ' + start.y + ' C ' + c1.x + ' ' + c1.y + ', ' + point.x + ' ' + point.y + ', ' + point.x + ' ' + point.y);
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
    if(project && project.workflow && project.workflow.nodes[columnId]){
      var node = project.workflow.nodes[columnId];
      setWorkflowNodePosition(project, columnId, node.x, node.y);
    }
    renderWorkflowEditor();
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
  if(!hit) return;
  openWorkflowEdgePopover(hit.getAttribute('data-edge-id'), e.clientX, e.clientY);
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
  closeWorkflowEdgePopover();
  renderWorkflowEditor();
}
export function deleteWorkflowEdgeFromPopover(){
  var project = getCurrentProject();
  if(!project || !workflowEditorState.popoverEdgeId) return;
  deleteWorkflowEdge(project, workflowEditorState.popoverEdgeId);
  closeWorkflowEdgePopover();
  renderWorkflowEditor();
}
