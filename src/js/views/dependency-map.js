"use strict";
import { state, isTimeTrackingEnabled, isSubTasksEnabled } from '../storage.js';
import { getTasksArray, getColumn, getMemberById, getTaskTypeById, isTaskBlocked, isTaskOverdue, buildChildrenMap } from '../utils.js';
import { getCurrentProject } from '../store.js';
import { PRIORITY_COLORS } from '../config.js';
import { iconSvg } from '../icons.js';
import { memberInitials, utcISOToLocalDisplayDate, clampProgress } from '../date-utils.js';
import { ui } from '../ui.js';
import { getPriority } from '../ui.js';

function escapeHTML(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
export function buildEl(tag, className, innerHTML){ var el = document.createElement(tag); if(className) el.className = className; if(innerHTML !== undefined) el.innerHTML = innerHTML; return el; }
function iconHTML(name, size){ return '<span class="kf-icon">'+iconSvg(name,size)+'</span>'; }

var _toast = function(msg){ console.error(msg); };
var _openTaskModal = function(){};
export function setDepMapDeps(deps){
  if(deps.toast) _toast = deps.toast;
  if(deps.openTaskModal) _openTaskModal = deps.openTaskModal;
}

/* =========================================================
   SVG DEPENDENCY MAP
   Lays the current project's tasks out as a layered, left-to-
   right directed graph: tasks with no dependencies sit in the
   left-most column; every other task sits one column to the
   right of its deepest dependency. Node order within a column
   uses a barycenter heuristic (average position of its
   dependencies) to keep edges reasonably untangled.
   ========================================================= */
export var depMapState = {scale: 1, panActive: false, panMoved: false, panStartX: 0, panStartY: 0, panStartScrollLeft: 0, panStartScrollTop: 0};
export var DEPMAP_MIN_ZOOM = 0.3;
export var DEPMAP_MAX_ZOOM = 2.5;
export var lastDepLayout = null;

export var DEPMAP_NODE_W = 200;
export var DEPMAP_NODE_H = 80;
export var DEPMAP_GAP_X = 100;
export var DEPMAP_GAP_Y = 18;
export var DEPMAP_MARGIN = 30;

function depMapTaskVisible(t){
  return (!t.archived || ui.depMapShowArchived) &&
    (ui.depMapColumnFilter.size === 0 || ui.depMapColumnFilter.has(t.columnId));
}

export function computeDepGraphLayout(project){
  var tasks = getTasksArray(project).filter(depMapTaskVisible);
  var taskMap = {};
  tasks.forEach(function(t){ taskMap[t.id] = t; });

  /* Depth = longest dependency chain ending at this task (DFS, memoized).
     The app prevents cycles on save, but we still guard against one here
     so a corrupted/imported file can't hang the layout. */
  var depthCache = {};
  function depthOf(id, seen){
    if(depthCache.hasOwnProperty(id)) return depthCache[id];
    seen = seen || new Set();
    if(seen.has(id)) return 0;
    seen.add(id);
    var t = taskMap[id];
    var deps = (t.dependencies || []).filter(function(d){ return taskMap[d]; });
    var depth = 0;
    deps.forEach(function(d){ depth = Math.max(depth, depthOf(d, seen) + 1); });
    depthCache[id] = depth;
    return depth;
  }
  tasks.forEach(function(t){ depthOf(t.id); });

  var maxDepth = 0;
  tasks.forEach(function(t){ maxDepth = Math.max(maxDepth, depthCache[t.id]); });

  var columns = [];
  for(var i = 0; i <= maxDepth; i++) columns.push([]);
  tasks.forEach(function(t){ columns[depthCache[t.id]].push(t); });

  var positions = {};

  columns.forEach(function(colTasks, colIndex){
    if(colIndex === 0){
      colTasks.sort(function(a,b){ return a.key.localeCompare(b.key, undefined, {numeric:true}); });
    } else {
      colTasks.sort(function(a,b){
        function baryY(t){
          var deps = (t.dependencies || []).filter(function(d){ return positions[d]; });
          if(deps.length === 0) return Number.MAX_SAFE_INTEGER;
          var sum = 0;
          deps.forEach(function(d){ sum += positions[d].y; });
          return sum / deps.length;
        }
        var diff = baryY(a) - baryY(b);
        return diff !== 0 ? diff : a.key.localeCompare(b.key, undefined, {numeric:true});
      });
    }
    var x = DEPMAP_MARGIN + colIndex * (DEPMAP_NODE_W + DEPMAP_GAP_X);
    colTasks.forEach(function(t, idx){
      var y = DEPMAP_MARGIN + idx * (DEPMAP_NODE_H + DEPMAP_GAP_Y);
      positions[t.id] = {x: x, y: y};
    });
  });

  var nodes = tasks.map(function(t){
    var pos = positions[t.id];
    return {task: t, x: pos.x, y: pos.y, w: DEPMAP_NODE_W, h: DEPMAP_NODE_H};
  });

  var edges = [];
  tasks.forEach(function(t){
    (t.dependencies || []).forEach(function(depId){
      if(!taskMap[depId]) return;
      var depCol = getColumn(project, taskMap[depId].columnId);
      var blocked = !(depCol && depCol.done);
      edges.push({from: depId, to: t.id, blocked: blocked});
    });
  });

  /* Sub-task (parentTaskId) edges — a separate relationship from
     `dependencies` above, drawn as dashed lines over the same
     dependency-depth layout rather than influencing it. Only ever
     rendered when the Sub-Tasks feature is on, but computed here
     unconditionally (cheap) so the gating lives in one place, at
     render time, same as the progress bar's per-node gating. */
  var subtaskEdges = [];
  tasks.forEach(function(t){
    if(t.parentTaskId && taskMap[t.parentTaskId]){
      subtaskEdges.push({from: t.parentTaskId, to: t.id});
    }
  });

  var maxX = DEPMAP_MARGIN, maxY = DEPMAP_MARGIN;
  nodes.forEach(function(n){
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  });

  return {
    nodes: nodes,
    edges: edges,
    subtaskEdges: subtaskEdges,
    positions: positions,
    width: maxX + DEPMAP_MARGIN,
    height: maxY + DEPMAP_MARGIN
  };
}

export function renderDependencyMap(){
  var project = getCurrentProject();
  var inner = document.getElementById('depMapInner');
  var legend = document.getElementById('depMapLegend');
  document.getElementById('depMapTitle').textContent = 'Dependency Map' + (project ? ' — ' + project.name : '');

  legend.innerHTML =
    '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:#de350b;"></span>Blocking dependency</span>' +
    '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:#8993a4;"></span>Completed dependency</span>' +
    '<span class="kf-legend-item"><span class="kf-legend-dot" style="background:' + getPriority('critical').accent + ';"></span>Left edge color = priority</span>' +
    '<span class="kf-legend-item">' + iconSvg('warning',12) + ' Task is currently blocked</span>' +
    '<span class="kf-legend-item" style="color:var(--kf-overdue-fg);">' + iconSvg('clock',12) + ' Task is overdue</span>' +
    (ui.depMapShowArchived ? '<span class="kf-legend-item">' + iconSvg('archive',12) + ' Task is archived (greyed out)</span>' : '') +
    (project && isTimeTrackingEnabled(project) ? '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:var(--kf-blue);"></span>Bottom bar = progress</span>' : '') +
    (project && isSubTasksEnabled(project) ? '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:repeating-linear-gradient(to right,#6554c0 0 4px,transparent 4px 7px);"></span>Dashed = sub-task</span>' : '');

  var hasVisibleTasks = project && getTasksArray(project).some(depMapTaskVisible);
  if(!hasVisibleTasks){
    inner.innerHTML = '';
    inner.appendChild(buildEl('div', 'kf-depmap-empty', iconHTML('inbox',36) + '<div>No tasks yet — add some tasks to see how they depend on each other.</div>'));
    lastDepLayout = null;
    return;
  }

  var layout = computeDepGraphLayout(project);
  lastDepLayout = layout;

  var defsHTML =
    '<defs>' +
      '<marker id="kf-arrow-blocked" viewBox="0 0 10 10" refX="9.25" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="#de350b" stroke="#de350b" stroke-width="1.6"/></marker>' +
      '<marker id="kf-arrow-done" viewBox="0 0 10 10" refX="9.25" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="#8993a4" stroke="#8993a4" stroke-width="1.6"/></marker>' +
      '<marker id="kf-dot-start-blocked" viewBox="0 0 10 10" refX="0.75" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="var(--kf-surface)" stroke="#de350b" stroke-width="1.6"/></marker>' +
      '<marker id="kf-dot-start-done" viewBox="0 0 10 10" refX="0.75" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="var(--kf-surface)" stroke="#8993a4" stroke-width="1.6"/></marker>' +
    '</defs>';

  var edgesHTML = layout.edges.map(function(e){
    var fromPos = layout.positions[e.from], toPos = layout.positions[e.to];
    if(!fromPos || !toPos) return '';
    var x1 = fromPos.x + DEPMAP_NODE_W, y1 = fromPos.y + DEPMAP_NODE_H / 2;
    var x2 = toPos.x, y2 = toPos.y + DEPMAP_NODE_H / 2;
    var bend = Math.max(40, (x2 - x1) * 0.5);
    var path = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    var color = e.blocked ? '#de350b' : '#8993a4';
    var marker = e.blocked ? 'url(#kf-arrow-blocked)' : 'url(#kf-arrow-done)';
    var startMarker = e.blocked ? 'url(#kf-dot-start-blocked)' : 'url(#kf-dot-start-done)';
    return '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.85" marker-start="' + startMarker + '" marker-end="' + marker + '"></path>';
  }).join('');

  var subtaskEdgesHTML = (project && isSubTasksEnabled(project)) ? layout.subtaskEdges.map(function(e){
    var fromPos = layout.positions[e.from], toPos = layout.positions[e.to];
    if(!fromPos || !toPos) return '';
    var x1 = fromPos.x + DEPMAP_NODE_W, y1 = fromPos.y + DEPMAP_NODE_H / 2;
    var x2 = toPos.x, y2 = toPos.y + DEPMAP_NODE_H / 2;
    var bend = Math.max(40, (x2 - x1) * 0.5);
    var path = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    return '<path d="' + path + '" fill="none" stroke="#6554c0" stroke-width="2" stroke-dasharray="5 4" opacity="0.75"></path>';
  }).join('') : '';

  var nodesHTML = layout.nodes.map(function(n){
    var t = n.task;
    var prio = getPriority(t.priority);
    var blocked = isTaskBlocked(project, t);
    var overdue = isTaskOverdue(project, t);
    var assignee = getMemberById(project, t.assigneeId);
    var taskType = getTaskTypeById(project, t.typeId);
    var title = t.title.length > 26 ? t.title.slice(0,25) + '…' : t.title;
    var warningBadge = blocked
      ? '<g transform="translate(' + (n.w - 24) + ',8)" style="color:#de350b;"><title>Blocked by unfinished dependencies</title>' + iconSvg('warning',16) + '</g>'
      : '';
    var overdueBadge = overdue
      ? '<g transform="translate(' + (blocked ? n.w - 46 : n.w - 24) + ',8)" style="color:var(--kf-overdue-fg);"><title>Overdue — end date was ' + escapeHTML(utcISOToLocalDisplayDate(t.endDate)) + '</title>' + iconSvg('clock',16) + '</g>'
      : '';
    var lockBadge = t.isPrivate
      ? '<g transform="translate(' + (n.w - 24 - ((blocked?1:0)+(overdue?1:0)) * 22) + ',8)" style="color:var(--kf-text-secondary);"><title>Private task</title>' + iconSvg('lock',16) + '</g>'
      : '';
    var typeBadge = '';
    if(taskType && taskType.iconName){
      var precedingBadgeCount = (blocked ? 1 : 0) + (overdue ? 1 : 0) + (t.isPrivate ? 1 : 0);
      typeBadge = '<g transform="translate(' + (n.w - 24 - precedingBadgeCount * 22) + ',8)" style="color:var(--kf-text-secondary);"><title>' + escapeHTML(taskType.name) + '</title>' + iconSvg(taskType.iconName,16) + '</g>';
    }
    var avatarBadge = assignee
      ? '<g><title>' + escapeHTML(assignee.name) + '</title><circle cx="' + (n.w - 18) + '" cy="' + (n.h - 22) + '" r="10" fill="' + assignee.color + '"></circle>' +
        '<text x="' + (n.w - 18) + '" y="' + (n.h - 18.5) + '" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">' + escapeHTML(memberInitials(assignee.name)) + '</text></g>'
      : '';
    var archivedBadge = t.archived
      ? '<g transform="translate(4,7)" style="color:var(--kf-text-faint);"><title>Archived</title>' + iconSvg('archive',14) + '</g>'
      : '';
    var progressBadge = '';
    if(isTimeTrackingEnabled(project)){
      var progress = clampProgress(t.progress);
      var barX = 6, barW = n.w - 12, barY = n.h - 8, barH = 4;
      progressBadge =
        '<g><title>Progress: ' + progress + '%</title>' +
          '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="1.5" fill="var(--kf-border)"></rect>' +
          '<rect x="' + barX + '" y="' + barY + '" width="' + (barW * progress / 100) + '" height="' + barH + '" rx="1.5" fill="var(--kf-blue)"></rect>' +
        '</g>';
    }
    var keyX = t.archived ? 30 : 16;
    return (
      '<g class="kf-depnode' + (t.archived ? ' kf-depnode-archived' : '') + '" data-task-id="' + t.id + '" transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect class="kf-depnode-box" x="0" y="0" width="' + n.w + '" height="' + n.h + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border);" stroke-width="1.5"></rect>' +
        '<rect x="0" y="0" width="5" height="' + n.h + '" rx="2" fill="' + prio.accent + '"></rect>' +
        archivedBadge +
        '<text x="' + keyX + '" y="20" font-size="10" font-weight="700" style="fill:var(--kf-text-faint);">' + escapeHTML(t.key) + '</text>' +
        '<text x="16" y="40" font-size="13" font-weight="600" style="fill:var(--kf-text);">' + escapeHTML(title) + '</text>' +
        '<circle cx="21" cy="58" r="4" fill="' + prio.accent + '"></circle>' +
        '<text x="30" y="61.5" font-size="10" font-weight="700" fill="' + prio.accent + '">' + escapeHTML(prio.label) + '</text>' +
        warningBadge +
        overdueBadge +
        lockBadge +
        typeBadge +
        avatarBadge +
        progressBadge +
      '</g>'
    );
  }).join('');

  var svgHTML =
    '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
      defsHTML + subtaskEdgesHTML + edgesHTML + nodesHTML +
    '</svg>';

  inner.innerHTML = svgHTML;
  applyDepMapZoom();
}

export function applyDepMapZoom(){
  var svg = document.querySelector('#depMapInner svg');
  document.getElementById('depMapZoomLabel').textContent = Math.round(depMapState.scale * 100) + '%';
  if(!svg || !lastDepLayout) return;
  svg.setAttribute('width', Math.round(lastDepLayout.width * depMapState.scale));
  svg.setAttribute('height', Math.round(lastDepLayout.height * depMapState.scale));
}

export function setDepMapZoom(delta){
  depMapState.scale = Math.max(DEPMAP_MIN_ZOOM, Math.min(DEPMAP_MAX_ZOOM, Math.round((depMapState.scale + delta) * 100) / 100));
  applyDepMapZoom();
}
export function resetDepMapZoom(){
  depMapState.scale = 1;
  applyDepMapZoom();
  var scroll = document.getElementById('depMapScroll');
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
}

/* Zoom by `deltaScale`, keeping the point under (clientX, clientY) visually
   fixed — the standard "zoom toward the cursor" behavior for scroll-wheel
   zoom. Falls back to zooming around the viewport center if no cursor
   position is given (e.g. from the toolbar zoom buttons). */
export function zoomDepMapAtPoint(deltaScale, clientX, clientY){
  if(!lastDepLayout) return;
  var scroll = document.getElementById('depMapScroll');
  if(!scroll) return;

  var oldScale = depMapState.scale;
  var newScale = Math.max(DEPMAP_MIN_ZOOM, Math.min(DEPMAP_MAX_ZOOM, Math.round((oldScale + deltaScale) * 100) / 100));
  if(newScale === oldScale) return;

  var rect = scroll.getBoundingClientRect();
  var offsetX = clientX != null ? clientX - rect.left : rect.width / 2;
  var offsetY = clientY != null ? clientY - rect.top : rect.height / 2;

  var oldWidth = lastDepLayout.width * oldScale;
  var oldHeight = lastDepLayout.height * oldScale;
  var fracX = oldWidth > 0 ? (scroll.scrollLeft + offsetX) / oldWidth : 0;
  var fracY = oldHeight > 0 ? (scroll.scrollTop + offsetY) / oldHeight : 0;

  depMapState.scale = newScale;
  applyDepMapZoom();

  var newWidth = lastDepLayout.width * newScale;
  var newHeight = lastDepLayout.height * newScale;
  scroll.scrollLeft = fracX * newWidth - offsetX;
  scroll.scrollTop = fracY * newHeight - offsetY;
}

export function updateDepMapArchiveToggleButton(){
  var btn = document.getElementById('depMapArchiveToggle');
  var label = document.getElementById('depMapArchiveToggleLabel');
  if(!btn) return;
  btn.classList.toggle('active', ui.depMapShowArchived);
  label.textContent = ui.depMapShowArchived ? 'Hide archived' : 'Show archived';
  btn.title = ui.depMapShowArchived ? 'Hide archived tasks' : 'Show archived tasks';
}

export function toggleDepMapShowArchived(){
  ui.depMapShowArchived = !ui.depMapShowArchived;
  updateDepMapArchiveToggleButton();
  renderDependencyMap();
}

/* Column filter dropdown — mirrors the Assignee filter on the main
   board toolbar (see renderAssigneeFilterChips() in views/board.js):
   a button showing the current selection, a checkbox-list panel, and
   a "Clear selection" row once something is checked. */
export function renderDepMapColumnFilterPanel(){
  var project = getCurrentProject();
  var wrap = document.getElementById('depMapColumnFilterWrap');
  var panel = document.getElementById('depMapColumnFilterPanel');
  var label = document.getElementById('depMapColumnFilterLabel');
  if(!wrap || !project) return;

  var columns = project.columns || [];
  var n = ui.depMapColumnFilter.size;
  if(n === 0){
    label.textContent = 'Column';
  } else if(n === 1){
    var onlyCol = getColumn(project, ui.depMapColumnFilter.values().next().value);
    label.textContent = onlyCol ? onlyCol.name : 'Column';
  } else {
    label.textContent = n + ' columns';
  }
  wrap.classList.toggle('active', n > 0);

  panel.innerHTML = '';
  columns.forEach(function(c){
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row';
    var checked = ui.depMapColumnFilter.has(c.id);
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dot" style="background:' + (c.color || '#c1c7d0') + '"></span>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(c.name) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.depMapColumnFilter.add(c.id);
      else ui.depMapColumnFilter.delete(c.id);
      renderDepMapColumnFilterPanel();
      renderDependencyMap();
    });
    panel.appendChild(row);
  });

  if(n > 0){
    var divider = document.createElement('div');
    divider.className = 'kf-dropdown-filter-divider';
    panel.appendChild(divider);
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'kf-dropdown-filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', function(){
      ui.depMapColumnFilter.clear();
      renderDepMapColumnFilterPanel();
      renderDependencyMap();
    });
    panel.appendChild(clearBtn);
  }
}
export function toggleDepMapColumnFilterPanel(){
  document.getElementById('depMapColumnFilterPanel').classList.toggle('hidden');
}
export function closeDepMapColumnFilterPanel(){
  document.getElementById('depMapColumnFilterPanel').classList.add('hidden');
}

export function openDepMapOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  depMapState.scale = 1;
  depMapState.panActive = false;
  depMapState.panMoved = false;
  updateDepMapArchiveToggleButton();
  renderDepMapColumnFilterPanel();
  renderDependencyMap();
  document.getElementById('depMapOverlay').classList.remove('hidden');
}
export function closeDepMapOverlay(){
  document.getElementById('depMapOverlay').classList.add('hidden');
  depMapState.panActive = false;
  depMapState.panMoved = false;
  document.getElementById('depMapScroll').classList.remove('kf-depmap-panning');
}
export function isDepMapOpen(){
  return !document.getElementById('depMapOverlay').classList.contains('hidden');
}
