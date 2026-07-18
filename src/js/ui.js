"use strict";
import { THEME_STORAGE_KEY, PRIORITY_META, PRIORITY_COLORS, PRIORITY_ORDER, MOBILE_BREAKPOINT, ICON_PATHS } from './config.js';
import { iconSvg, hydrateIcons } from './icons.js';
import { memberColorForIndex, memberInitials } from './date-utils.js';

/* =========================================================
   THEME (light / dark)
   The DOM attribute html[data-theme] is the single source of truth —
   an inline script in <head> already applies any saved preference
   before first paint, so there's no flash of the wrong theme.
   ========================================================= */

export function currentTheme(){
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme){
  if(theme === 'dark'){
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try{ localStorage.setItem(THEME_STORAGE_KEY, theme); }catch(e){ /* ignore */ }
  renderThemeToggleIcon();
}

export function renderThemeToggleIcon(){
  var btn = document.getElementById('themeToggleBtn');
  if(!btn) return;
  var dark = currentTheme() === 'dark';
  btn.innerHTML = iconSvg(dark ? 'sun' : 'moon', 16);
  btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('data-mobile-label', dark ? 'Light theme' : 'Dark theme');
}

/* Lazy deps for toggleTheme — injected by the main module after all
   render functions are defined, to avoid circular imports. */
var _renderBoardFn = function(){};
var _renderDepMapFn = function(){ return false; };
var _isDepMapOpenFn = function(){ return false; };
var _updatePriorityIconFn = function(){};
var _renderPriorityFilterChipsFn = function(){};

export function setThemeDeps(deps){
  if(deps.renderBoard) _renderBoardFn = deps.renderBoard;
  if(deps.renderDependencyMap) _renderDepMapFn = deps.renderDependencyMap;
  if(deps.isDepMapOpen) _isDepMapOpenFn = deps.isDepMapOpen;
  if(deps.updatePriorityIcon) _updatePriorityIconFn = deps.updatePriorityIcon;
  if(deps.renderPriorityFilterChips) _renderPriorityFilterChipsFn = deps.renderPriorityFilterChips;
}

export function toggleTheme(){
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  _renderPriorityFilterChipsFn();
  _renderBoardFn();
  if(_isDepMapOpenFn()) _renderDepMapFn();
  var overlay = document.getElementById('taskOverlay');
  if(overlay && !overlay.classList.contains('hidden')) _updatePriorityIconFn();
}

/* =========================================================
   MOBILE / TABLET HEADER DRAWER
   Below the 1024px breakpoint, the header's controls (project
   picker, new/import/export, theme toggle) live in this same DOM
   container — CSS repositions it into a fixed off-canvas drawer at
   that width rather than duplicating any markup/ids.
   ========================================================= */
export function openMobileDrawer(){
  document.getElementById('headerControls').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('open');
}
export function closeMobileDrawer(){
  document.getElementById('headerControls').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('open');
}
export function toggleMobileDrawer(){
  if(document.getElementById('headerControls').classList.contains('open')){
    closeMobileDrawer();
  } else {
    openMobileDrawer();
  }
}
export function isMobileDrawerOpen(){
  return document.getElementById('headerControls').classList.contains('open');
}

/* Below the 1024px breakpoint, the "Views" group (List View /
   Timeline / Dependency Map / Cost-Benefit Chart) and the "Tools"
   group (Bulk Edit / Archived / Task Types / Releases) each move into
   their own labeled section in the header drawer — same elements,
   just reparented, so their ids/listeners/state are untouched either
   way. On desktop, the two groups swap rows: Tools sits in row 1
   (alongside search/filters) and Views sits in row 2 (alongside the
   Column button, which never relocates at all). */
export function relocateViewButtonsForViewport(){
  var wrapper = document.getElementById('toolbarViewButtons');   // "Views" group
  var wrapper2 = document.getElementById('toolbarRow2Buttons');  // "Tools" group
  var viewsSlot = document.getElementById('drawerViewButtonsSlot');
  var toolsSlot = document.getElementById('drawerToolsButtonsSlot');
  var toolbar = document.getElementById('toolbarRow1');
  var toolbar2 = document.getElementById('toolbarRow2');
  if(!wrapper || !viewsSlot || !toolbar) return;

  var isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  if(isMobile){
    if(wrapper.parentElement !== viewsSlot) viewsSlot.appendChild(wrapper);
    if(wrapper2 && toolsSlot && wrapper2.parentElement !== toolsSlot) toolsSlot.appendChild(wrapper2);
  } else {
    /* Views now lives in row 2, restored to the front, ahead of the
       spacer + Column button. Tools now lives in row 1, appended
       after the search/filter controls. */
    if(toolbar2 && wrapper.parentElement !== toolbar2){
      toolbar2.insertBefore(wrapper, toolbar2.firstChild);
    }
    if(wrapper2 && wrapper2.parentElement !== toolbar){
      toolbar.appendChild(wrapper2);
    }
  }

  /* Column button: stays in row 2 (its normal position) on mobile/
     tablet, where the two-row toolbar still looks as it always has.
     On desktop, where Views/Tools have moved into the side nav and
     row 2 is hidden entirely, Column moves to the end of the now
     single, tightened toolbar row. */
  var columnBtn = document.getElementById('addColumnTopBtn');
  if(columnBtn && toolbar && toolbar2){
    if(isMobile){
      if(columnBtn.parentElement !== toolbar2) toolbar2.appendChild(columnBtn);
    } else if(columnBtn.parentElement !== toolbar){
      toolbar.appendChild(columnBtn);
    }
  }
}

export function toggleSideNav(){
  ui.sideNavExpanded = !ui.sideNavExpanded;
  var nav = document.getElementById('sideNav');
  var toggleBtn = document.getElementById('sideNavToggle');
  nav.classList.toggle('expanded', ui.sideNavExpanded);
  toggleBtn.innerHTML = '<span class="kf-icon" data-icon="' + (ui.sideNavExpanded ? 'chevronLeft' : 'chevronRight') + '" data-size="16"></span>';
  toggleBtn.title = ui.sideNavExpanded ? 'Collapse navigation' : 'Expand navigation';
  toggleBtn.setAttribute('aria-expanded', ui.sideNavExpanded ? 'true' : 'false');
  hydrateIcons(toggleBtn);
}

/* =========================================================
   PRIORITY HELPER
   ========================================================= */
export function getPriority(key){
  var meta = PRIORITY_META[key] || PRIORITY_META.medium;
  var palette = PRIORITY_COLORS[currentTheme()] || PRIORITY_COLORS.light;
  var colors = palette[key] || palette.medium;
  return {label: meta.label, icon: meta.icon, color: colors.color, bg: colors.bg, accent: colors.accent};
}

/* =========================================================
   UI STATE
   ========================================================= */
export var ui = {
  searchTerm: '',
  activePriorities: new Set(),
  activeAssignees: new Set(),
  activeTeams: new Set(),
  activeTaskTypes: new Set(),
  activeStatuses: new Set(),
  editingTaskId: null,
  taskModalColumnId: null,
  taskModalDeps: [],
  /* Derived key bits from a successful unlock, held only for the
     lifetime of the current open Task modal session — never persisted,
     never surviving a close/reopen. Cleared in closeTaskModal(). */
  taskModalUnlockedDerivedBits: null,
  depSearchTerm: '',
  taskModalParentId: null,
  taskModalSubtaskIds: [],
  subtaskSearchTerm: '',
  editingColumnId: null,
  editingProjectId: null,
  draggedTaskId: null,
  draggedColumnId: null,
  dragWasMove: false,
  taskListSearch: '',
  taskListSort: {field: 'key', dir: 'asc'},
  taskListExpanded: new Set(),
  archivedSelected: new Set(),
  depMapShowArchived: false,
  depMapColumnFilter: new Set(),
  cbShowArchived: false,
  cbColumnFilter: new Set(),
  bulkEdits: {},
  timelineScale: 'week',
  timelineShowArchived: false,
  editingReleaseId: null,
  editingDocumentId: null,
  editingRiskId: null,
  editingDecisionId: null,
  editingPrincipleId: null,
  editingObjectiveId: null,
  editingTeamCommitteeId: null,
  editingRetrospectiveId: null,
  retroPromotingItemId: null,
  principlesActiveTab: 'mine',
  tcSearchTerm: '',
  tcCollapsedIds: new Set(),
  healthGaugeAnimTimeoutId: null,
  healthGaugeAnimFrameId: null,
  documentsSearchTerm: '',
  risksSearchTerm: '',
  risksSeverityFilter: '',
  risksStatusFilter: '',
  decisionsSearchTerm: '',
  decisionsTypeFilter: '',
  decisionsStatusFilter: '',
  principlesSearchTerm: '',
  objectivesSearchTerm: '',
  taskListCollapsedGroups: new Set(),
  sideNavExpanded: false,
  orgChartFilter: 'team',
  govMapShowRelationships: true
};

export function resetFilters(){
  ui.searchTerm = '';
  ui.activePriorities = new Set();
  ui.activeAssignees = new Set();
  ui.activeTeams = new Set();
  ui.activeTaskTypes = new Set();
  ui.activeStatuses = new Set();
  ui.depMapColumnFilter = new Set();
  ui.cbColumnFilter = new Set();
  var searchInput = document.getElementById('searchInput');
  if(searchInput) searchInput.value = '';
  // Not imported from board-filters.js (would risk a circular import back into this module) - plain
  // direct DOM manipulation instead, matching how this function already touches #searchInput itself.
  var searchClearBtn = document.getElementById('searchClearBtn');
  if(searchClearBtn) searchClearBtn.classList.add('kf-vis-hidden');
  var searchHashtagPanel = document.getElementById('searchHashtagPanel');
  if(searchHashtagPanel) searchHashtagPanel.classList.add('hidden');
}

export function toast(message){
  var wrap = document.getElementById('toastWrap');
  var el = document.createElement('div');
  el.className = 'kf-toast';
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(function(){
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(function(){ el.remove(); }, 200);
  }, 2600);
}

/* Like toast(), but with an optional action button and a manual dismiss (x) — used where the plain
   2.6s auto-dismiss toast wouldn't give the user time to act, e.g. features/live-updates.js's "reload
   to see this change" prompt. Lingers for 10s (still auto-dismisses eventually rather than piling up
   forever) instead of vanishing before it can be clicked. */
export function toastWithAction(message, actionLabel, actionFn){
  var wrap = document.getElementById('toastWrap');
  var el = document.createElement('div');
  el.className = 'kf-toast';

  var textEl = document.createElement('span');
  textEl.textContent = message;
  el.appendChild(textEl);

  function dismiss(){
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(function(){ el.remove(); }, 200);
  }

  if(actionLabel && actionFn){
    var actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'kf-toast-action';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', function(){
      dismiss();
      actionFn();
    });
    el.appendChild(actionBtn);
  }

  var dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'kf-toast-dismiss';
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.textContent = '×';
  dismissBtn.addEventListener('click', dismiss);
  el.appendChild(dismissBtn);

  wrap.appendChild(el);
  setTimeout(dismiss, 10000);
}
