"use strict";
import { state, isTimeTrackingEnabled, isSubTasksEnabled } from '../storage.js';
import { getTasksArray, getColumn, getMemberById, getTaskTypeById, isTaskBlocked, isTaskOverdue, buildChildrenMap, escapeHTML } from '../utils.js';
import { getCurrentProject } from '../store.js';
import { PRIORITY_COLORS } from '../config.js';
import { iconSvg } from '../icons.js';
import { memberInitials, utcISOToLocalDisplayDate, clampProgress } from '../date-utils.js';
import { ui } from '../ui.js';
import { getPriority } from '../ui.js';

export function buildEl(tag, className, innerHTML){ var el = document.createElement(tag); if(className) el.className = className; if(innerHTML !== undefined) el.innerHTML = innerHTML; return el; }

/* SVG has no text-wrapping/line-clamp primitive, so a task node's title is hand-wrapped into
   at most two ~26-char lines (breaking on the last space that fits), with the second line
   ellipsis-truncated if there's still more left over — the SVG equivalent of the board card's
   `-webkit-line-clamp: 2` title. */
function wrapDepNodeTitle(title){
  var maxLineLen = 26;
  if(title.length <= maxLineLen) return [title, ''];
  var breakAt = title.lastIndexOf(' ', maxLineLen);
  if(breakAt < 10) breakAt = maxLineLen;
  var line1 = title.slice(0, breakAt).trim();
  var rest = title.slice(breakAt).trim();
  if(rest.length > maxLineLen) rest = rest.slice(0, maxLineLen - 1) + '…';
  return [line1, rest];
}
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

export var DEPMAP_NODE_W = 220;
export var DEPMAP_NODE_H = 104;
export var DEPMAP_GAP_X = 100;
export var DEPMAP_GAP_Y = 18;
export var DEPMAP_MARGIN = 30;
export var DEPMAP_CORNER_RADIUS = 8;
var DEPMAP_EDGE_STUB = 24;
var DEPMAP_ANCHOR_MARGIN = 20;

/* Builds the straight-segment vertex list for an orthogonal (Manhattan)
   connector between two node-edge anchor points, each with an "outward"
   travel direction (+1 = rightward, -1 = leftward) matching which side of
   the node it's attached to. When the two directions/positions line up
   (the common left-to-right dependency case, or a clearly-separated
   subtask pair), a simple 2-corner "Z" path is enough. Otherwise the
   anchors are on sides that can't reach each other without doubling back,
   so each leaves via a short stub in its own outward direction first, then
   the two stubs are joined — this is what keeps a same-column subtask
   connector from being drawn straight through the card(s) between it. */
function orthogonalPointsAreSimple(x1, y1, dir1, x2, y2, dir2){
  var midX = (x1 + x2) / 2;
  return (dir1 > 0 ? midX >= x1 : midX <= x1) && (dir2 < 0 ? midX <= x2 : midX >= x2);
}

/* midXOverride lets multiple edges that share an identical (x1,x2) column
   pair — and would otherwise all bend at the exact same computed midpoint,
   drawing directly on top of each other along their shared y-range — take
   distinct vertical lanes instead. See the fan-out pass in
   renderDependencyMap for how it's chosen. */
function buildOrthogonalPoints(x1, y1, dir1, x2, y2, dir2, midXOverride){
  var simpleOk = orthogonalPointsAreSimple(x1, y1, dir1, x2, y2, dir2);
  if(simpleOk){
    if(y1 === y2) return [{x:x1,y:y1},{x:x2,y:y2}];
    var midX = midXOverride != null ? midXOverride : (x1 + x2) / 2;
    return [{x:x1,y:y1},{x:midX,y:y1},{x:midX,y:y2},{x:x2,y:y2}];
  }
  var outX1 = x1 + dir1 * DEPMAP_EDGE_STUB;
  var outX2 = x2 + dir2 * DEPMAP_EDGE_STUB;
  var ymid = y1 === y2 ? y1 - (DEPMAP_NODE_H / 2 + 20) : (y1 + y2) / 2;
  return [{x:x1,y:y1},{x:outX1,y:y1},{x:outX1,y:ymid},{x:outX2,y:ymid},{x:outX2,y:y2},{x:x2,y:y2}];
}

/* Companion to distributeEdgeAnchors: two edges can still share the exact
   same (x1,x2) column pair after anchor fan-out (e.g. two dependencies
   into the same task, both starting in the same source column) — their
   default midX bend would be identical, so their vertical segments draw
   directly on top of each other wherever their y-ranges overlap. This
   groups edges by that shared channel and spreads their bend x-position
   across the gap instead of leaving them all on the shared midpoint.
   `geomById` maps edge id -> {x1,y1,dir1,x2,y2,dir2}; mutates each entry
   with a `laneMidX` when it's part of a group of 2+. */
function assignVerticalLanes(geomById){
  var groups = {};
  Object.keys(geomById).forEach(function(id){
    var g = geomById[id];
    if(g.y1 === g.y2) return;
    if(!orthogonalPointsAreSimple(g.x1, g.y1, g.dir1, g.x2, g.y2, g.dir2)) return;
    var key = Math.round(g.x1) + '_' + Math.round(g.x2);
    (groups[key] = groups[key] || []).push(id);
  });
  Object.keys(groups).forEach(function(key){
    var ids = groups[key];
    var n = ids.length;
    if(n < 2) return;
    ids.sort(function(a, b){ return (geomById[a].y1 + geomById[a].y2) - (geomById[b].y1 + geomById[b].y2); });
    ids.forEach(function(id, i){
      var g = geomById[id];
      var frac = 0.3 + 0.4 * i / (n - 1);
      g.laneMidX = g.x1 + (g.x2 - g.x1) * frac;
    });
  });
}

/* Renders a vertex list (from buildOrthogonalPoints) as an SVG path with
   every 90-degree corner rounded to a small fillet — each straight segment
   is shortened by the fillet radius on either side of a bend, joined by a
   quadratic curve through the original corner point. */
function roundedOrthogonalPathD(points, radius){
  if(points.length < 2) return '';
  var pts = points.filter(function(p, i){
    return i === 0 || p.x !== points[i-1].x || p.y !== points[i-1].y;
  });
  if(pts.length < 2) return '';
  var d = 'M ' + pts[0].x + ' ' + pts[0].y;
  for(var i = 1; i < pts.length - 1; i++){
    var prev = pts[i-1], cur = pts[i], next = pts[i+1];
    var len1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    var len2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    var r = Math.min(radius, len1 / 2, len2 / 2);
    var p1x = cur.x - (cur.x - prev.x) / len1 * r;
    var p1y = cur.y - (cur.y - prev.y) / len1 * r;
    var p2x = cur.x + (next.x - cur.x) / len2 * r;
    var p2y = cur.y + (next.y - cur.y) / len2 * r;
    d += ' L ' + p1x + ' ' + p1y + ' Q ' + cur.x + ' ' + cur.y + ' ' + p2x + ' ' + p2y;
  }
  var last = pts[pts.length - 1];
  d += ' L ' + last.x + ' ' + last.y;
  return d;
}

/* A dependency edge always flows from a shallower to a strictly deeper
   layout column (see computeDepGraphLayout's depth math), so it always
   attaches source-right -> target-left. A sub-task edge is NOT laid out
   by depth at all (see the "Sub-task edges" comment below) — parent and
   child can land in the same column, or with the child to the left of the
   parent — so its anchor SIDES are picked per-pair here, preferring
   whichever side keeps the connector from being drawn across either
   card's face. The actual y position on that side is decided later, by
   distributeEdgeAnchors, once every edge touching a node is known. */
function subtaskEdgeSides(parentNode, childNode, layoutWidth){
  var pLeft = parentNode.x, pRight = parentNode.x + parentNode.w;
  var cLeft = childNode.x, cRight = childNode.x + childNode.w;
  if(cLeft >= pRight) return {fromSide: 'right', toSide: 'left'};
  if(cRight <= pLeft) return {fromSide: 'left', toSide: 'right'};
  var pCenterX = (pLeft + pRight) / 2;
  return pCenterX < layoutWidth / 2 ? {fromSide: 'right', toSide: 'right'} : {fromSide: 'left', toSide: 'left'};
}

/* Multiple connectors landing on the exact same node side (e.g. a task
   with three dependencies, or a parent with several sub-tasks) would
   otherwise all leave/arrive from that side's dead-center point and sit
   exactly on top of each other for their first/last stretch. This spreads
   every edge attached to a given (node, side) across that side's usable
   height instead of a single shared point — ordered by where the OTHER
   end of each edge sits, so the fan-out doesn't introduce needless
   crossings. Takes/returns edge descriptors of the shape
   {id, from, to, fromSide, toSide}; nodesById maps task id -> layout node
   ({x,y,w,h}). Returns a map of "<edgeId>:from"/"<edgeId>:to" -> y. */
function distributeEdgeAnchors(edgeDescs, nodesById){
  var groups = {};
  edgeDescs.forEach(function(ed){
    var fromNode = nodesById[ed.from], toNode = nodesById[ed.to];
    if(!fromNode || !toNode) return;
    var fromKey = ed.from + '|' + ed.fromSide;
    var toKey = ed.to + '|' + ed.toSide;
    (groups[fromKey] = groups[fromKey] || []).push({anchorKey: ed.id + ':from', otherY: toNode.y + toNode.h / 2});
    (groups[toKey] = groups[toKey] || []).push({anchorKey: ed.id + ':to', otherY: fromNode.y + fromNode.h / 2});
  });
  var anchorY = {};
  Object.keys(groups).forEach(function(key){
    var nodeId = key.slice(0, key.lastIndexOf('|'));
    var node = nodesById[nodeId];
    var group = groups[key];
    var n = group.length;
    if(n === 1){
      anchorY[group[0].anchorKey] = node.y + node.h / 2;
      return;
    }
    group.sort(function(a, b){ return a.otherY - b.otherY; });
    var usable = node.h - DEPMAP_ANCHOR_MARGIN * 2;
    group.forEach(function(p, i){
      anchorY[p.anchorKey] = node.y + DEPMAP_ANCHOR_MARGIN + usable * i / (n - 1);
    });
  });
  return anchorY;
}

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
    (project && isSubTasksEnabled(project) ? '<span class="kf-legend-item"><span class="kf-legend-swatch" style="background:repeating-linear-gradient(to right,#6554c0 0 4px,transparent 4px 7px);"></span>Sub-task</span>' : '') +
    '<span class="kf-legend-item">' + iconSvg('warning',12) + ' Task is currently blocked</span>' +
    '<span class="kf-legend-item">' + iconSvg('clock',12) + ' Task is overdue</span>' +
    (ui.depMapShowArchived ? '<span class="kf-legend-item">' + iconSvg('archive',12) + ' Task is archived (greyed out)</span>' : '');

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
      (project && isSubTasksEnabled(project) && layout.subtaskEdges.length > 0 ?
        '<marker id="kf-arrow-subtask" viewBox="0 0 10 10" refX="9.25" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="#6554c0" stroke="#6554c0" stroke-width="1.6"/></marker>' +
        '<marker id="kf-dot-start-subtask" viewBox="0 0 10 10" refX="0.75" refY="5" markerWidth="8" markerHeight="8" orient="auto"><circle cx="5" cy="5" r="3" fill="var(--kf-surface)" stroke="#6554c0" stroke-width="1.6"/></marker>'
      : '') +
    '</defs>';

  var nodesById = {};
  layout.nodes.forEach(function(n){ nodesById[n.task.id] = n; });
  var subtasksOn = project && isSubTasksEnabled(project);

  /* Every edge's anchor SIDE is decided first (dependency edges always
     right->left; sub-task edges via subtaskEdgeSides), then every edge
     touching a given node+side is fanned out together in one pass
     (distributeEdgeAnchors) so edges sharing a node never leave/arrive at
     the exact same point — see that function's comment for why. */
  var edgeDescs = layout.edges.map(function(e, i){
    return {id: 'dep' + i, from: e.from, to: e.to, fromSide: 'right', toSide: 'left', blocked: e.blocked};
  });
  var subtaskDescs = subtasksOn ? layout.subtaskEdges.map(function(e, i){
    var sides = subtaskEdgeSides(nodesById[e.from], nodesById[e.to], layout.width);
    return {id: 'sub' + i, from: e.from, to: e.to, fromSide: sides.fromSide, toSide: sides.toSide};
  }) : [];
  var anchorY = distributeEdgeAnchors(edgeDescs.concat(subtaskDescs), nodesById);

  function sideDir(side){ return side === 'right' ? 1 : -1; }
  function sideX(node, side){ return side === 'right' ? node.x + node.w : node.x; }

  var geomById = {};
  edgeDescs.concat(subtaskDescs).forEach(function(ed){
    var fromNode = nodesById[ed.from], toNode = nodesById[ed.to];
    if(!fromNode || !toNode) return;
    geomById[ed.id] = {
      x1: sideX(fromNode, ed.fromSide), y1: anchorY[ed.id + ':from'], dir1: sideDir(ed.fromSide),
      x2: sideX(toNode, ed.toSide), y2: anchorY[ed.id + ':to'], dir2: sideDir(ed.toSide)
    };
  });
  assignVerticalLanes(geomById);

  var edgesHTML = edgeDescs.map(function(ed){
    var g = geomById[ed.id];
    if(!g) return '';
    var points = buildOrthogonalPoints(g.x1, g.y1, g.dir1, g.x2, g.y2, g.dir2, g.laneMidX);
    var path = roundedOrthogonalPathD(points, DEPMAP_CORNER_RADIUS);
    var color = ed.blocked ? '#de350b' : '#8993a4';
    var marker = ed.blocked ? 'url(#kf-arrow-blocked)' : 'url(#kf-arrow-done)';
    var startMarker = ed.blocked ? 'url(#kf-dot-start-blocked)' : 'url(#kf-dot-start-done)';
    return '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.85" marker-start="' + startMarker + '" marker-end="' + marker + '"></path>';
  }).join('');

  var subtaskEdgesHTML = subtaskDescs.map(function(ed){
    var g = geomById[ed.id];
    if(!g) return '';
    var points = buildOrthogonalPoints(g.x1, g.y1, g.dir1, g.x2, g.y2, g.dir2, g.laneMidX);
    var path = roundedOrthogonalPathD(points, DEPMAP_CORNER_RADIUS);
    return '<path d="' + path + '" fill="none" stroke="#6554c0" stroke-width="2" stroke-dasharray="5 4" opacity="0.75" marker-start="url(#kf-dot-start-subtask)" marker-end="url(#kf-arrow-subtask)"></path>';
  }).join('');

  /* Node content is grouped into the same row order as the board card (Board§renderCard):
     key+type-icon+avatar row, up-to-2-line title, priority+related+blocked+overdue row,
     progress row — each badge sits at a FIXED x/y regardless of which optional elements are
     present, the SVG equivalent of the board card's reserved-space slots (an absolutely-
     positioned element never shifts based on its siblings, so no extra slot markup is needed
     here the way it is in HTML/CSS). */
  var nodesHTML = layout.nodes.map(function(n){
    var t = n.task;
    var prio = getPriority(t.priority);
    var blocked = isTaskBlocked(project, t);
    var overdue = isTaskOverdue(project, t);
    var assignee = getMemberById(project, t.assigneeId);
    var taskType = getTaskTypeById(project, t.typeId);
    var depCount = (t.dependencies || []).length;
    var titleLines = wrapDepNodeTitle(t.title);

    // Row 1: key (+ private lock + type icon) left, assignee avatar right — fixed positions.
    var lockBadge = t.isPrivate
      ? '<g transform="translate(50,7)" style="color:var(--kf-text-secondary);"><title>Private task</title>' + iconSvg('lock',14) + '</g>'
      : '';
    var typeBadge = (taskType && taskType.iconName)
      ? '<g transform="translate(74,6)" style="color:var(--kf-text-secondary);"><title>' + escapeHTML(taskType.name) + '</title>' + iconSvg(taskType.iconName,16) + '</g>'
      : '';
    var avatarBadge = assignee
      ? '<g><title>' + escapeHTML(assignee.name) + '</title><circle cx="' + (n.w - 19) + '" cy="17" r="9" fill="' + assignee.color + '"></circle>' +
        '<text x="' + (n.w - 19) + '" y="20.5" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">' + escapeHTML(memberInitials(assignee.name)) + '</text></g>'
      : '';
    var archivedBadge = t.archived
      ? '<g transform="translate(4,7)" style="color:var(--kf-text-faint);"><title>Archived</title>' + iconSvg('archive',14) + '</g>'
      : '';

    // Title: two fixed baselines (line-clamp-2 equivalent), the 2nd only rendered if needed.
    var titleHTML = '<text x="16" y="42" font-size="13" font-weight="600" style="fill:var(--kf-text);">' + escapeHTML(titleLines[0]) + '</text>' +
      (titleLines[1] ? '<text x="16" y="58" font-size="13" font-weight="600" style="fill:var(--kf-text);">' + escapeHTML(titleLines[1]) + '</text>' : '');

    // Row 3: priority (always present) + blocked + overdue — fixed slots.
    var warningBadge = blocked
      ? '<g transform="translate(90,70)" style="color:var(--kf-blocked-fg);"><title>Blocked by unfinished dependencies</title>' + iconSvg('warning',12) +
        '<text x="16" y="10" font-size="9" font-weight="600" fill="var(--kf-blocked-fg)">Blocked</text></g>'
      : '';
    var overdueBadge = overdue
      ? '<g transform="translate(150,70)" style="color:var(--kf-overdue-fg);"><title>Overdue — end date was ' + escapeHTML(utcISOToLocalDisplayDate(t.endDate)) + '</title>' + iconSvg('clock',12) +
        '<text x="16" y="10" font-size="9" font-weight="600" fill="var(--kf-overdue-fg)">Overdue</text></g>'
      : '';

    /* Row 4: progress graph on the left — same track + fill + % label as the board card's
       progress chip (kf-progress-chip/-track/-fill in styles.css), just redrawn in SVG rather
       than HTML/CSS — stretched as wide as the row allows, i.e. up to whatever space the
       dep-count badge (pinned bottom-right) doesn't need, matching the board card's flex:1
       track. */
    var progressBadge = '';
    var trackY = n.h - 12;
    // Dep badge is always rendered now (even at zero), so it's always reserved out of the
    // track's available width, not just when depCount > 0.
    var depBadgeW = 34;
    var trackX = 16, trackRightMargin = 14, labelW = 30;
    var trackEndX = n.w - trackRightMargin - depBadgeW;
    var trackW = Math.max(20, trackEndX - trackX - labelW);
    if(isTimeTrackingEnabled(project)){
      var progress = clampProgress(t.progress);
      var trackH = 5;
      progressBadge =
        '<g><title>Progress: ' + progress + '%</title>' +
          '<rect x="' + trackX + '" y="' + trackY + '" width="' + trackW + '" height="' + trackH + '" rx="2.5" fill="var(--kf-border)"></rect>' +
          '<rect x="' + trackX + '" y="' + trackY + '" width="' + (trackW * progress / 100) + '" height="' + trackH + '" rx="2.5" fill="' + (progress === 100 ? 'var(--kf-good-fg)' : 'var(--kf-blue)') + '"></rect>' +
          '<text x="' + (trackX + trackW + 6) + '" y="' + (trackY + trackH + 1) + '" font-size="9" font-weight="600" fill="var(--kf-text-secondary)">' + progress + '%</text>' +
        '</g>';
    }
    // Always rendered (even at zero), dimmed to 50% opacity when there are no dependencies —
    // same treatment as the board card's dep chip.
    var depBadge = '<g transform="translate(' + (n.w - depBadgeW) + ',' + (trackY - 3) + ')" style="color:var(--kf-text-secondary);' + (depCount === 0 ? 'opacity:0.5;' : '') + '"><title>' +
        (depCount > 0 ? 'Depends on ' + depCount + ' task(s)' : 'No dependencies') + '</title>' + iconSvg('link',12) +
        '<text x="16" y="10" font-size="10" font-weight="600" fill="var(--kf-text-secondary)">' + depCount + '</text></g>';
    var keyX = t.archived ? 30 : 16;
    return (
      '<g class="kf-depnode' + (t.archived ? ' kf-depnode-archived' : '') + '" data-task-id="' + t.id + '" transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect class="kf-depnode-box" x="0" y="0" width="' + n.w + '" height="' + n.h + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border);" stroke-width="1.5"></rect>' +
        '<rect x="0" y="0" width="5" height="' + n.h + '" rx="2" fill="' + prio.accent + '"></rect>' +
        archivedBadge +
        '<text x="' + keyX + '" y="20" font-size="10" font-weight="700" style="fill:var(--kf-text-faint);">' + escapeHTML(t.key) + '</text>' +
        lockBadge +
        typeBadge +
        avatarBadge +
        titleHTML +
        '<circle cx="21" cy="76" r="4" fill="' + prio.accent + '"></circle>' +
        '<text x="30" y="79.5" font-size="10" font-weight="700" fill="' + prio.accent + '">' + escapeHTML(prio.label) + '</text>' +
        depBadge +
        warningBadge +
        overdueBadge +
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
