"use strict";
import { getPriority } from './ui.js';
import { escapeHTML } from './views/board.js';
import { contrastTextColor } from './date-utils.js';

/* =========================================================
   Shared Gantt-bar rendering for the Portfolio Dashboard's Timeline chart and the Portfolio
   Planner's own chart — both need identical priority-marker + inactive-project styling on their
   project bars, so this lives here rather than either overlay importing the other's internals.
   Zero DOM/state dependencies: every function is pure, given plain data.
   ========================================================= */

/* Single source of truth for the "no dates" hatch pattern's markup — both charts' <defs> must
   define the exact same #portfolioNoDatesPattern id that projectBarSVG's undated-bar fill
   references below, so this is called once per <svg> by each caller rather than copy-pasted. The
   tile's base rect is --kf-surface (the chart's own background, i.e. .kf-modal's background) rather
   than --kf-column-bg, so the whole placeholder reads as one solid, obviously-clickable block instead
   of blending into a differently-tinted background between the diagonal hatch lines. */
export function noDatesPatternDefsSVG(){
  return '<defs><pattern id="portfolioNoDatesPattern" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
    '<rect width="6" height="6" fill="var(--kf-surface)"></rect>' +
    '<line x1="0" y1="0" x2="0" y2="6" stroke="var(--kf-text-faint)" stroke-width="1.5" opacity="0.6"></line>' +
  '</pattern></defs>';
}

/* Radius 5, non-interactive (no data-project-id, pointer-events:none) so it never intercepts a
   click/drag meant for the underlying bar/handle beneath it — see the Timeline chart's
   onPortfolioTimelineBarPointerDown, whose e.target.closest('[data-project-id]') hit-testing has no
   catch-all branch for an unrecognized data-role, so anything with data-project-id would otherwise
   fall into the generic drag-setup path. */
export function priorityMarkerSVG(priority, cx, cy){
  var prio = getPriority(priority);
  return '<circle class="kf-portfolio-priority-marker" cx="' + cx + '" cy="' + cy + '" r="5" ' +
    'fill="' + prio.accent + '" stroke="var(--kf-column-bg)" stroke-width="1.5" pointer-events="none">' +
    '<title>' + escapeHTML(prio.label) + ' priority</title></circle>';
}


/**
 * Renders one project's Gantt row content (bar + resize handles, or the click-only "no dates"
 * placeholder + priority marker) — x/y/width/height describe the bar/placeholder's own position,
 * chosen by the caller (a dated bar's real start/width, or the full track width for an undated
 * project). `hasDates` (derived from p.startDate/p.endDate) decides placeholder-vs-bar shape and
 * marker offset; `p.isActive` is checked FIRST and overrides fill entirely for a DATED bar (colored
 * fill vs. a solid grey outline with no fill) — an inactive project's "no dates" hatch is replaced by
 * a plain grey outline, not layered with it, so "administratively inactive" and "not yet scheduled"
 * never read as one ambiguous glyph. An undated placeholder always gets a solid chart-background fill
 * either way (hatched when active, plain when inactive) rather than fill:none, since it spans the
 * full track width and any unfilled part of it would read as empty space nobody would click.
 *
 * `priorityColored` (the Portfolio Planner's own mode — the Dashboard's Timeline chart leaves it
 * falsy and keeps its original per-project hash-color + always-visible-marker look) switches a DATED
 * bar's fill/border to the project's own priority color instead of the caller-supplied `color`: full
 * opacity fill+border for an active project, a 15%-opacity fill with a full-opacity border of the same
 * color for an inactive one. Since the bar's own color already encodes priority in this mode, the
 * marker becomes redundant for an active project and is dropped; an inactive project's fill is only
 * a faint tint, so the marker is kept there as the clearer priority cue. Outside this mode, every
 * project — active or not, dated or not — still gets the marker, unchanged from before.
 */
export function projectBarSVG(p, x, y, width, height, color, handleWidth, priorityColored){
  var hasDates = !!(p.startDate && p.endDate);
  var isActive = p.isActive !== false;
  var hw = handleWidth || 8;
  var prio = getPriority(p.priority);

  // fill="transparent", not "none" — SVG's default pointer-events (visiblePainted) only hit-tests a
  // shape's fill if it's actually painted; "none" means the shape's interior is a permanent click-
  // through hole (only its 1.5px stroke would be draggable/clickable), while a transparent color still
  // counts as painted, keeping the whole bar body clickable/draggable with the identical no-fill look.
  var inactiveAttrs = 'fill="transparent" stroke="var(--kf-text-faint)" stroke-width="1.5"';
  var showMarker = !priorityColored || !isActive;
  // Centered vertically (cy = y + height/2) AND horizontally offset by that same height/2 — with the
  // marker's own radius subtracted, that makes the gap from the bar's left edge to the marker exactly
  // equal to the gap from the bar's top edge to the marker (both = height/2 - r), rather than an
  // arbitrary fixed left inset that wouldn't line up with the vertical centering.
  var markerHTML = showMarker ? priorityMarkerSVG(p.priority, x + height / 2, y + height / 2) : '';

  if(!hasDates){
    // Always a solid fill (chart-background hatch for active, plain chart-background for inactive)
    // rather than ever fill:none — an unscheduled project's placeholder spans the FULL track width,
    // so leaving any part of it unfilled reads as empty space nobody would think to click, unlike a
    // dated bar whose own edges already imply its clickable extent.
    var placeholderAttrs = isActive
      ? 'fill="url(#portfolioNoDatesPattern)" stroke="var(--kf-text-faint)" stroke-width="1" stroke-dasharray="5,3"'
      : 'fill="var(--kf-surface)" stroke="var(--kf-text-faint)" stroke-width="1.5"';
    return '<rect class="kf-portfolio-timeline-nodatesbar" data-project-id="' + p.id + '" data-role="click-only" ' +
      'x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" rx="4" ' + placeholderAttrs + '>' +
      '<title>' + escapeHTML(p.name) + ' — click to set a start/end date</title></rect>' + markerHTML;
  }

  var barEndX = x + width;
  var barAttrs = priorityColored
    ? (isActive
        ? 'fill="' + prio.accent + '" stroke="' + prio.accent + '" stroke-width="1.5"'
        : 'fill="' + prio.accent + '" fill-opacity="0.15" stroke="' + prio.accent + '" stroke-width="1.5"')
    : (isActive ? 'fill="' + color + '"' : inactiveAttrs);

  // Planner-only (priorityColored). An ACTIVE bar's fill is a solid, known color (the raw priority
  // accent), so its label color is picked via a real WCAG contrast check (contrastTextColor below).
  // An INACTIVE bar's fill is that same accent at 15% opacity over the chart's own background, which
  // this module (deliberately zero-DOM-dependency, see file header) has no way to resolve to a
  // concrete color to contrast-check — its label is always black instead (a fixed, explicit choice,
  // not computed), since the 15%-opacity tint stays light enough in this app's own palette/themes for
  // black text to read clearly there in practice. Text is measured with a rough monospace-ish
  // average-char-width estimate (SVG has no synchronous "will this text fit" query without a real DOM
  // measurement, which would break this file's purity) — conservative enough that a false negative
  // (room exists, label skipped) is far more likely than a false positive (label overflows the bar).
  var keyLabelHTML = '';
  if(priorityColored && p.key){
    var keyLabelX = x + height / 2 + 5 + 4; // marker's right edge (cx + r) + a small gap
    var keyLabelFontSize = 11;
    var estCharWidth = keyLabelFontSize * 0.62;
    var availableWidth = (barEndX - hw / 2 - 4) - keyLabelX; // stop short of the resize-end handle
    if(availableWidth >= p.key.length * estCharWidth){
      var keyLabelFill = isActive ? contrastTextColor(prio.accent) : '#000000';
      keyLabelHTML = '<text x="' + keyLabelX + '" y="' + (y + height / 2) + '" dominant-baseline="central" ' +
        'font-size="' + keyLabelFontSize + '" font-weight="600" fill="' + keyLabelFill + '" ' +
        'pointer-events="none">' + escapeHTML(p.key) + '</text>';
    }
  }

  return '<g class="kf-portfolio-timeline-row">' +
    '<rect class="kf-portfolio-timeline-bar" data-project-id="' + p.id + '" data-role="move" ' +
    'x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" rx="4" ' + barAttrs + '>' +
    '<title>' + escapeHTML(p.name) + ' — drag to reschedule, drag an edge to resize, click to edit dates</title></rect>' +
    '<rect class="kf-portfolio-timeline-handle" data-project-id="' + p.id + '" data-role="resize-start" ' +
    'x="' + (x - hw / 2) + '" y="' + y + '" width="' + hw + '" height="' + height + '" rx="2"></rect>' +
    '<rect class="kf-portfolio-timeline-handle" data-project-id="' + p.id + '" data-role="resize-end" ' +
    'x="' + (barEndX - hw / 2) + '" y="' + y + '" width="' + hw + '" height="' + height + '" rx="2"></rect>' +
    keyLabelHTML +
    '</g>' + markerHTML;
}
