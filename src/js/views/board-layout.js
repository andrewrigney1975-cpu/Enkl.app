"use strict";

/* =========================================================
   BOARD LAYOUT — the 2560px+ widescreen Task-modal-docking logic, extracted from board.js
   (ARCHITECTURE-REVIEW.md finding #4, option 1: pure file split, zero behavior change — see
   CLAUDE.md for the two other approaches that were tried and reverted before this one). Genuinely
   unrelated to rendering or filtering: no imports needed at all, purely window/DOM geometry.
   ========================================================= */

var WIDESCREEN_TASK_DOCK_QUERY = '(min-width: 2560px)';

/* Below the 2560px breakpoint the Task modal is a centered, backdropped overlay sitting ON TOP of
   the board (see styles.css) — the board underneath needs no changes at all. At 2560px+ it instead
   docks flush to the right as a full-height panel that shares the screen with the board (see that
   media query's comment). Everything above the modal needs to narrow in lockstep for this to read
   as a reveal rather than a broken layout: the header (a full-width sibling of the side
   nav/board, not a descendant of either) and .kf-main-content (the flex column holding BOTH toolbar
   rows and .kf-board-wrap — narrowing board-wrap alone left the toolbars stranded at their old full
   width, floating over/past the docked modal). Both are narrowed to end flush at the modal's own
   left edge — an instant resize, not animated.
   (This used to also scroll the board to center the task's own column, but that turned out to be
   an annoying surprise in practice — reopening a task shouldn't yank the board's scroll position —
   so it was removed; only the width narrowing remains.) */
export function fitBoardForTaskModal(){
  if(!window.matchMedia || !window.matchMedia(WIDESCREEN_TASK_DOCK_QUERY).matches) return;
  var header = document.querySelector('.kf-header');
  var mainContent = document.querySelector('.kf-main-content');
  var modalEl = document.querySelector('#taskOverlay .kf-modal');
  if(!header || !mainContent || !modalEl) return;

  var headerRect = header.getBoundingClientRect();
  var mainContentRect = mainContent.getBoundingClientRect();
  var modalRect = modalEl.getBoundingClientRect();

  // Each narrowed to its OWN available space up to the modal's left edge — the header starts at the
  // true left edge of the page, while .kf-main-content starts after the side nav, so they need
  // different target widths to end up flush with each other above/beside the same docked panel.
  var headerWidth = Math.max(200, Math.round(modalRect.left - headerRect.left));
  var mainContentWidth = Math.max(200, Math.round(modalRect.left - mainContentRect.left));
  header.style.width = headerWidth + 'px';
  mainContent.style.flexGrow = '0';
  mainContent.style.flexShrink = '0';
  mainContent.style.flexBasis = mainContentWidth + 'px';
}

function clearBoardInlineSizing(){
  var header = document.querySelector('.kf-header');
  var mainContent = document.querySelector('.kf-main-content');
  if(header) header.style.width = '';
  if(mainContent){
    mainContent.style.flexGrow = '';
    mainContent.style.flexShrink = '';
    mainContent.style.flexBasis = '';
  }
}

/* Undoes fitBoardForTaskModal's inline sizing once the Task modal closes, handing the board back to
   its normal CSS-driven flex:1 width. Harmless no-op if the modal never actually docked (below the
   breakpoint, or fitBoardForTaskModal was never called this session). */
export function restoreBoardAfterTaskModal(){
  clearBoardInlineSizing();
}

/* Called from app.js's window resize handler so dragging the browser across the 2560px threshold —
   or just resizing while already past it — keeps the board correctly narrowed/widened without
   requiring the Task modal to be closed and reopened. A no-op whenever the modal isn't currently
   open. */
export function refitBoardForOpenTaskModal(){
  var overlay = document.getElementById('taskOverlay');
  if(!overlay || overlay.classList.contains('hidden')) return;
  if(!window.matchMedia || !window.matchMedia(WIDESCREEN_TASK_DOCK_QUERY).matches){
    clearBoardInlineSizing();
    return;
  }
  fitBoardForTaskModal();
}
