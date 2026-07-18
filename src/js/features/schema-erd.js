"use strict";
import { TABLE_SCHEMAS, TABLE_RELATIONSHIPS } from './query-engine.js';
import { escapeHTML } from '../utils.js';

/* =========================================================
   SCHEMA ERD
   Hand-rolled SVG entity-relationship diagram for the Advanced Query tab's "Tables & Columns"
   reference panel (modals/project-search.js) — same "no charting library, ever" principle as
   views/dependency-map.js/timeline.js. Connectors are orthogonal (right-angle elbow) polylines,
   matching classic ERD-tool conventions, rather than the curved bezier edges dependency-map.js uses
   for its dependency graph — a deliberately different edge style for a deliberately different kind of
   diagram (this one's about table relationships, not a directed task-dependency flow).

   Built directly from query-engine.js's TABLE_SCHEMAS/TABLE_RELATIONSHIPS — the single source of
   truth the query engine itself reads from — so this diagram can never drift out of sync with what's
   actually queryable; there is no separate "diagram data" to maintain. Generated fresh every time the
   panel opens (buildSchemaErdSvg() has no cached state), not a static asset.

   Every table box is a `<g class="kf-erd-table" data-table="name">` and every relationship is a
   `<g class="kf-erd-edge" data-rel-index data-from data-to">` (paired invisible-fat-hitbox +
   visible-thin-line paths, since the real stroke is only 1.2px) so modals/project-search.js's click
   handler (handleSchemaErdClick) can dim/un-dim by selector alone — no separate id-lookup table to
   keep in sync with the layout.
   ========================================================= */

var BOX_WIDTH = 210;
var ROW_HEIGHT = 14;
var HEADER_HEIGHT = 22;
var BOX_PADDING_TOP = 6;
var BOX_PADDING_BOTTOM = 8;
var COL_GAP = 70;
var ROW_GAP = 26;
var COLUMNS = 5;
var MARGIN = 20;
// Fixed spacing between two edges' parallel segments whenever they'd otherwise sit exactly on top of
// each other (same corridor between two columns, same same-column detour lane, or the same box's
// self-referential loops) — small enough to keep the diagram compact, large enough that no two
// relationship lines are ever visually indistinguishable from one another.
var LANE_GAP = 9;
// Separate, smaller spacing for staggering where multiple relationships arriving at the SAME target
// table each touch its edge — kept tight enough that the cluster of entry points stays visually
// anchored to the target's header/id row rather than spreading down into its field list.
var ENTRY_GAP = 4;

function tableBoxHeight(table){
  var fields = TABLE_SCHEMAS[table] || [];
  return HEADER_HEIGHT + BOX_PADDING_TOP + fields.length * ROW_HEIGHT + BOX_PADDING_BOTTOM;
}

/* True crossing-minimization is NP-hard; this is a cheap, effective heuristic instead — same spirit
   as dependency-map.js's own barycenter heuristic for the same class of problem. A breadth-first
   walk of the relationship graph, starting from the most-connected table, visits closely-related
   tables in quick succession; feeding THAT order (instead of an arbitrary alphabetical one) into the
   masonry packer below tends to land related tables in the same or neighboring columns, which is
   what actually keeps edges short and reduces how often they cross each other. Self-referential FKs
   are excluded from the adjacency graph (they don't inform clustering — a table is always "next to
   itself"). */
function clusteredTableOrder(){
  var names = Object.keys(TABLE_SCHEMAS);
  var adjacency = {};
  names.forEach(function(n){ adjacency[n] = []; });
  TABLE_RELATIONSHIPS.forEach(function(rel){
    if(rel.from === rel.to) return;
    if(adjacency[rel.from].indexOf(rel.to) === -1) adjacency[rel.from].push(rel.to);
    if(adjacency[rel.to].indexOf(rel.from) === -1) adjacency[rel.to].push(rel.from);
  });

  var startNode = names.slice().sort(function(a, b){ return adjacency[b].length - adjacency[a].length; })[0];
  var visited = {};
  var order = [];
  var queue = [startNode];
  visited[startNode] = true;
  while(queue.length){
    var current = queue.shift();
    order.push(current);
    adjacency[current].slice().sort().forEach(function(neighbor){
      if(!visited[neighbor]){ visited[neighbor] = true; queue.push(neighbor); }
    });
  }
  // Any table with no relationships at all (disconnected from the graph) wouldn't be reached by the
  // walk above — append defensively so it still renders, just wherever the packer has room.
  names.sort().forEach(function(n){ if(!visited[n]) order.push(n); });
  return order;
}

/* Greedy masonry packing — each table goes into whichever of the fixed COLUMNS is currently
   shortest, same idea as a Pinterest-style layout. Table field counts vary a lot here (3 fields for
   taskTypes, 24 for tasks), so a fixed grid would waste a lot of space; this keeps the diagram
   reasonably compact without a full bin-packing algorithm. */
function layoutTables(){
  var tableNames = clusteredTableOrder();
  var colHeights = [];
  for(var i = 0; i < COLUMNS; i++) colHeights.push(MARGIN);
  var positions = {};
  tableNames.forEach(function(name){
    var h = tableBoxHeight(name);
    var col = 0;
    for(var c = 1; c < COLUMNS; c++){ if(colHeights[c] < colHeights[col]) col = c; }
    var x = MARGIN + col * (BOX_WIDTH + COL_GAP);
    var y = colHeights[col];
    positions[name] = {x: x, y: y, w: BOX_WIDTH, h: h, col: col, fields: TABLE_SCHEMAS[name]};
    colHeights[col] = y + h + ROW_GAP;
  });
  var width = MARGIN * 2 + COLUMNS * BOX_WIDTH + (COLUMNS - 1) * COL_GAP;
  var height = Math.max.apply(null, colHeights);
  return {positions: positions, width: width, height: height};
}

/* Which physical corridor a relationship's elbow bend will travel through — the key thing this needs
   to get right is that it's keyed by PHYSICAL POSITION (which pair of grid columns, or which single
   column for a same-column detour, or which specific box for a self-loop), not by the specific pair
   of tables involved. Two edges between two entirely different table pairs still overlap if they
   happen to cross the same corridor, and grouping by table pair alone misses that. */
function corridorKey(fromBox, toBox){
  if(fromBox === toBox) return 'self:' + fromBox.col + ':' + fromBox.y;
  if(fromBox.col === toBox.col) return 'stack:' + fromBox.col;
  var lo = Math.min(fromBox.col, toBox.col), hi = Math.max(fromBox.col, toBox.col);
  return 'span:' + lo + '-' + hi;
}

function fieldRowY(box, fieldName){
  var idx = box.fields.indexOf(fieldName);
  if(idx === -1) idx = 0;
  return box.y + HEADER_HEIGHT + BOX_PADDING_TOP + idx * ROW_HEIGHT + ROW_HEIGHT * 0.72;
}

// Fillet radius applied to every elbow's angled corners (all 90°, since every segment this diagram
// draws is purely horizontal or vertical) — purely cosmetic, softens the classic hard-cornered ERD
// look without touching any of the lane/corridor math above it.
var CORNER_RADIUS = 4;

/* Turns a plain polyline (an array of [x, y] points) into an SVG path string whose interior corners
   are rounded to CORNER_RADIUS — a quadratic Bezier (`Q`) at each interior point, using the corner
   itself as the control point (so the curve stays tangent to both adjacent segments, the standard
   "fillet" construction for an axis-aligned polyline). `r` is clamped to half of whichever adjacent
   segment is shorter so a fillet can never eat past a neighboring corner on a short elbow leg (e.g.
   the tight self-loop brackets), degrading gracefully to a sharp corner (r=0) rather than
   overshooting into a visible kink. */
function roundedPolylinePath(points){
  var d = 'M ' + points[0][0] + ' ' + points[0][1];
  for(var i = 1; i < points.length - 1; i++){
    var prev = points[i - 1], curr = points[i], next = points[i + 1];
    var inLen = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    var outLen = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    var r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    if(r <= 0){
      d += ' L ' + curr[0] + ' ' + curr[1];
      continue;
    }
    var p1x = curr[0] - (curr[0] - prev[0]) / inLen * r;
    var p1y = curr[1] - (curr[1] - prev[1]) / inLen * r;
    var p2x = curr[0] + (next[0] - curr[0]) / outLen * r;
    var p2y = curr[1] + (next[1] - curr[1]) / outLen * r;
    d += ' L ' + p1x + ' ' + p1y + ' Q ' + curr[0] + ' ' + curr[1] + ' ' + p2x + ' ' + p2y;
  }
  var last = points[points.length - 1];
  d += ' L ' + last[0] + ' ' + last[1];
  return d;
}

/* Orthogonal (right-angle elbow) connector, rounded at each bend via roundedPolylinePath() above —
   still no curves in the routing itself, purely a cosmetic fillet on top of the same polyline.
   - `offset` is this edge's lane position within its CORRIDOR group (see corridorKey() and the
     grouping pass in buildSchemaErdSvg()) — a multiple of LANE_GAP — so every edge sharing a
     physical corridor gets its own parallel track through it.
   - `entryOffset` is a second, independent stagger for where the line actually touches the TARGET
     box, grouped by target table alone. Multiple different relationships very commonly point at the
     same table (e.g. several tables all reference members.id) — without this they'd all converge on
     the exact same y on the target's edge and run coincident for their whole final approach, which is
     the specific "lines overlapping" case a single corridor-lane offset doesn't fix. */
function buildElbowPath(fromBox, fromField, toBox, toField, offset, entryOffset){
  var y1 = fieldRowY(fromBox, fromField);
  var fromRight = fromBox.x + fromBox.w;
  var toLeft = toBox.x;
  var toRight = toBox.x + toBox.w;

  if(fromBox === toBox){
    // Self-referential FK (e.g. tasks.parentTaskId -> tasks.id) — a small right-angle bracket off
    // the box's own right edge, from the FK field's row back up to the id row.
    var y2self = fieldRowY(toBox, toField);
    var loopX = fromRight + 16 + offset;
    return roundedPolylinePath([[fromRight, y1], [loopX, y1], [loopX, y2self], [fromRight, y2self]]);
  }

  var y2 = toBox.y + HEADER_HEIGHT / 2 + entryOffset;

  if(fromRight <= toLeft){
    // Target sits to the right — horizontal out, one vertical bend at the corridor midpoint, then
    // horizontal into the target's left edge.
    var midX = (fromRight + toLeft) / 2 + offset;
    return roundedPolylinePath([[fromRight, y1], [midX, y1], [midX, y2], [toLeft, y2]]);
  }
  if(toRight <= fromBox.x){
    // Target sits to the left — mirror image of the above.
    var midXLeft = (fromBox.x + toRight) / 2 + offset;
    return roundedPolylinePath([[fromBox.x, y1], [midXLeft, y1], [midXLeft, y2], [toRight, y2]]);
  }
  // Same column (stacked vertically) — route out to the right of whichever box, down/up past it,
  // then back in, rather than a straight line that would cut through anything stacked in between.
  var detourX = Math.max(fromRight, toRight) + 16 + offset;
  return roundedPolylinePath([[fromRight, y1], [detourX, y1], [detourX, y2], [toRight, y2]]);
}

/* Field names ending in Id/Ids (plus the literal "id") are highlighted as key-ish — a simple, always-
   in-sync heuristic rather than a second hand-maintained "which fields are keys" list; every FK field
   in TABLE_SCHEMAS already follows this naming convention throughout the codebase (see
   query-engine.js's own field lists). */
function isKeyishField(name){
  return name === 'id' || /Ids?$/.test(name);
}

export function buildSchemaErdSvg(){
  var layout = layoutTables();
  var pos = layout.positions;

  // Group relationships by the PHYSICAL corridor their elbow bend will travel through (see
  // corridorKey()'s own doc comment for why this has to be positional, not just "same table pair")
  // so every edge sharing a corridor gets a distinct LANE_GAP-spaced parallel track through it.
  var corridorGroups = {};
  var edgeCorridor = TABLE_RELATIONSHIPS.map(function(rel){
    var fromBox = pos[rel.from], toBox = pos[rel.to];
    if(!fromBox || !toBox) return null;
    var key = corridorKey(fromBox, toBox);
    if(!corridorGroups[key]) corridorGroups[key] = [];
    corridorGroups[key].push(rel);
    return key;
  });

  // Second, independent grouping — by TARGET TABLE alone — so relationships arriving at the same
  // table (very common: several tables all reference members.id) don't all converge on the exact
  // same point and run coincident for their final approach. Excludes self-refs, which already enter
  // at their own specific field row rather than a shared header point.
  var targetGroups = {};
  TABLE_RELATIONSHIPS.forEach(function(rel){
    if(rel.from === rel.to) return;
    if(!targetGroups[rel.to]) targetGroups[rel.to] = [];
    targetGroups[rel.to].push(rel);
  });

  var edgesHTML = TABLE_RELATIONSHIPS.map(function(rel, i){
    var fromBox = pos[rel.from], toBox = pos[rel.to];
    if(!fromBox || !toBox) return '';
    var key = edgeCorridor[i];
    var group = corridorGroups[key];
    var laneIndex = group.indexOf(rel);
    // "span" corridors (crossing between two columns) center their lanes on the gap's midpoint —
    // visually balanced, room on both sides. "stack"/"self" corridors only ever detour to ONE side
    // (the right, past the box's own edge), so their lanes count up from 0 instead of centering — a
    // negative offset there would push the line back across the box itself.
    var offset = key.indexOf('span:') === 0
      ? (laneIndex - (group.length - 1) / 2) * LANE_GAP
      : laneIndex * LANE_GAP;

    var entryOffset = 0;
    if(rel.from !== rel.to){
      var targetGroup = targetGroups[rel.to];
      var entryIndex = targetGroup.indexOf(rel);
      entryOffset = (entryIndex - (targetGroup.length - 1) / 2) * ENTRY_GAP;
    }

    var path = buildElbowPath(fromBox, rel.fromField, toBox, rel.toField, offset, entryOffset);
    var title = rel.from + '.' + rel.fromField + ' → ' + rel.to + '.' + rel.toField;
    // Two coincident paths per relationship: a fat, invisible one purely to widen the clickable hit
    // area (the visible stroke is only 1.2px, far too thin to reliably click), and the real visible
    // one on top. Both share data-from/data-to so a click handler's `closest('.kf-erd-edge')` finds
    // the group regardless of which of the two paths the pointer actually lands on.
    return '<g class="kf-erd-edge" data-rel-index="' + i + '" data-from="' + escapeHTML(rel.from) + '" data-to="' + escapeHTML(rel.to) + '">' +
      '<path d="' + path + '" fill="none" stroke="transparent" stroke-width="10"></path>' +
      '<path d="' + path + '" fill="none" stroke="var(--kf-text-faint)" stroke-width="1.2" opacity="0.6" marker-end="url(#kf-erd-arrow)"><title>' +
      escapeHTML(title) + '</title></path>' +
    '</g>';
  }).join('');

  var boxesHTML = Object.keys(pos).sort().map(function(name){
    var box = pos[name];
    var fieldsHTML = box.fields.map(function(f, i){
      var keyish = isKeyishField(f);
      var y = box.y + HEADER_HEIGHT + BOX_PADDING_TOP + i * ROW_HEIGHT + ROW_HEIGHT * 0.78;
      return '<text x="' + (box.x + 8) + '" y="' + y + '" font-size="9.5" font-weight="' + (keyish ? '700' : '400') + '" fill="' + (keyish ? 'var(--kf-blue)' : 'var(--kf-text-secondary)') + '">' + escapeHTML(f) + '</text>';
    }).join('');
    return (
      '<g class="kf-erd-table" data-table="' + escapeHTML(name) + '">' +
        '<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="5" fill="var(--kf-surface)" stroke="var(--kf-border-strong)" stroke-width="1.2"></rect>' +
        '<path d="M ' + box.x + ' ' + (box.y + 5) + ' a 5 5 0 0 1 5 -5 h ' + (box.w - 10) + ' a 5 5 0 0 1 5 5 v ' + (HEADER_HEIGHT - 5) + ' h -' + box.w + ' Z" fill="var(--kf-blue)"></path>' +
        '<text x="' + (box.x + 8) + '" y="' + (box.y + 15) + '" font-size="11" font-weight="700" fill="#ffffff">' + escapeHTML(name) + '</text>' +
        fieldsHTML +
      '</g>'
    );
  }).join('');

  return '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><marker id="kf-erd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--kf-text-faint)"></path></marker></defs>' +
    edgesHTML + boxesHTML +
  '</svg>';
}
