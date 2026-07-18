"use strict";
import { getCurrentProject } from '../store.js';
import { escapeHTML, canCurrentUserManageProject, applyHeaderButtonVisibility } from '../views/board.js';
import { hydrateIcons } from '../icons.js';
import { TEAM_COMMITTEE_TYPES } from '../config.js';
import { toast } from '../ui.js';
import { PROJECT_SEARCH_MIN_CHARS, buildProjectSearchGroups, buildSearchSnippetHTML } from '../features/project-search.js';
import { executeQuery, QueryError } from '../features/query-engine.js';
import { buildSchemaErdSvg } from '../features/schema-erd.js';
import { csvEscapeValue } from '../views/task-list.js';
import { openTaskModal } from './task.js';
import { openTeamModal } from './team.js';
import { openPrinciplesOverlay, showPrinciplesFormView } from './principles.js';
import { openObjectivesOverlay, showObjectivesFormView } from './objectives.js';
import { openDocumentsOverlay, showDocumentsFormView } from './documents.js';
import { openRisksOverlay, showRisksFormView } from './risks.js';
import { openDecisionsOverlay, showDecisionsFormView } from './decisions.js';
import { openTeamsCommitteesOverlay, showTeamCommitteeFormView } from './teams-committees.js';
import { confirmDialog } from './confirm.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { addSavedQuery, updateSavedQuery, deleteSavedQuery } from '../mutations.js';
import { savedQueryApi, testSavedQueryApi } from '../api.js';
import { computeIntellisense, getCaretPixelPosition } from '../features/sql-intellisense.js';
import { formatSql } from '../features/sql-formatter.js';

var projectSearchDebounceId = null;
var lastQueryResult = null;
var queryResultViewMode = 'table';

var PROJECT_SEARCH_GROUP_ICONS = {
  tasks: 'board', members: 'team', principles: 'compass', objectives: 'target',
  documents: 'ty_document', risks: 'warning', decisions: 'ty_approve',
  teamsCommittees: 'orgChart'
};

export function openProjectSearchOverlay(){
  var project = getCurrentProject();
  if(!project) return;
  document.getElementById('projectSearchInput').value = '';
  renderProjectSearchResults('');
  // Advanced Query tab is Project-Admin/Org-Admin-only — canCurrentUserManageProject() already
  // means "Project Admin OR Org Admin" (isProjectAdmin() short-circuits true for Org Admins
  // internally), same gate every other admin-only entry point in this app uses. Re-evaluated on
  // every open since admin status can change between opens.
  document.getElementById('projectSearchTabQueryBtn').classList.toggle('kf-vis-hidden', !canCurrentUserManageProject());
  showProjectSearchSimpleView();
  document.getElementById('projectSearchOverlay').classList.remove('hidden');
  document.getElementById('projectSearchInput').focus();
}

export function closeProjectSearchOverlay(){
  clearTimeout(projectSearchDebounceId);
  document.getElementById('projectSearchOverlay').classList.add('hidden');
  // Defensive: don't leave the ERD stuck full-screen (covering the whole viewport, above this very
  // overlay) the next time Project Search is reopened.
  closeProjectQueryErdFullscreen();
}

export function isProjectSearchOverlayOpen(){
  return !document.getElementById('projectSearchOverlay').classList.contains('hidden');
}

export function getProjectSearchDebounceId(){ return projectSearchDebounceId; }
export function setProjectSearchDebounceId(id){ projectSearchDebounceId = id; }

function renderProjectSearchResults(rawTerm){
  var project = getCurrentProject();
  var resultsEl = document.getElementById('projectSearchResults');
  if(!project){ resultsEl.innerHTML = ''; return; }

  var term = rawTerm.trim();
  if(term.length < PROJECT_SEARCH_MIN_CHARS){
    resultsEl.innerHTML = '<div class="kf-search-empty">Type at least ' + PROJECT_SEARCH_MIN_CHARS + ' characters to search.</div>';
    return;
  }

  var groups = buildProjectSearchGroups(project, term).filter(function(g){ return g.results.length > 0; });
  if(groups.length === 0){
    resultsEl.innerHTML = '<div class="kf-search-empty">No results for "' + escapeHTML(term) + '".</div>';
    return;
  }

  resultsEl.innerHTML = groups.map(function(g){
    var rowsHTML = g.results.map(function(r){
      if(g.type === 'teamsCommittees'){
        var typePill = '<span class="kf-decision-type-pill">' + escapeHTML(TEAM_COMMITTEE_TYPES[r.tcType] || r.tcType) + '</span>';
        var parentLine = r.parentName ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">Parent:</span> ' + escapeHTML(r.parentName) + '</div>' : '';
        var membersLine = r.members.length > 0
          ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">Members:</span> ' + r.members.map(function(m){ return escapeHTML(m.name); }).join(', ') + '</div>'
          : '<div class="kf-search-result-snippet" style="color:var(--kf-text-faint);">No members</div>';
        var descSnippet = (r.match.label && r.match.label !== null)
          ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">' + escapeHTML(r.match.label) + ':</span> ' + buildSearchSnippetHTML(r.match.value, term) + '</div>'
          : '';
        return '<div class="kf-search-result-row" data-result-type="teamsCommittees" data-result-id="' + r.id + '">' +
          '<div class="kf-search-result-top">' +
            '<a class="kf-search-result-link" data-result-type="teamsCommittees" data-result-id="' + r.id + '">' + escapeHTML(r.title) + '</a>' +
            typePill +
          '</div>' +
          parentLine + membersLine + descSnippet +
        '</div>';
      }
      var fieldLabelHTML = r.match.label ? '<span class="kf-search-result-field-label">' + escapeHTML(r.match.label) + ':</span> ' : '';
      var snippetHTML = buildSearchSnippetHTML(r.match.value, term);
      return '<div class="kf-search-result-row" data-result-type="' + g.type + '" data-result-id="' + r.id + '">' +
        '<div class="kf-search-result-top">' +
          '<a class="kf-search-result-link" data-result-type="' + g.type + '" data-result-id="' + r.id + '">' + escapeHTML(r.title) + '</a>' +
          (r.archived ? '<span class="kf-search-archived-badge">Archived</span>' : '') +
        '</div>' +
        '<div class="kf-search-result-snippet">' + fieldLabelHTML + snippetHTML + '</div>' +
      '</div>';
    }).join('');
    var moreNote = g.total > g.results.length ? '<div class="kf-search-more-note">+' + (g.total - g.results.length) + ' more in ' + escapeHTML(g.label) + '</div>' : '';
    return '<div class="kf-search-group">' +
      '<h3 class="kf-search-group-title"><span class="kf-icon" data-icon="' + PROJECT_SEARCH_GROUP_ICONS[g.type] + '" data-size="13"></span>' + escapeHTML(g.label) + ' (' + g.total + ')</h3>' +
      rowsHTML + moreNote +
    '</div>';
  }).join('');
  hydrateIcons(resultsEl);
}

export function handleProjectSearchInput(value){
  clearTimeout(projectSearchDebounceId);
  projectSearchDebounceId = setTimeout(function(){ renderProjectSearchResults(value); }, 200);
}

export function handleProjectSearchResultClick(e){
  var link = e.target.closest('.kf-search-result-link, .kf-search-result-row');
  if(!link) return;
  e.preventDefault();
  var type = link.getAttribute('data-result-type');
  var id = link.getAttribute('data-result-id');
  if(!type || !id) return;

  var project = getCurrentProject();
  if(!project) return;
  closeProjectSearchOverlay();
  if(type === 'tasks'){
    var task = project.tasks[id];
    if(task) openTaskModal(id, task.columnId);
  } else if(type === 'members'){
    openTeamModal();
  } else if(type === 'principles'){
    openPrinciplesOverlay();
    showPrinciplesFormView(id);
  } else if(type === 'objectives'){
    openObjectivesOverlay();
    showObjectivesFormView(id);
  } else if(type === 'documents'){
    openDocumentsOverlay();
    showDocumentsFormView(id);
  } else if(type === 'risks'){
    openRisksOverlay();
    showRisksFormView(id);
  } else if(type === 'decisions'){
    openDecisionsOverlay();
    showDecisionsFormView(id);
  } else if(type === 'teamsCommittees'){
    openTeamsCommitteesOverlay();
    showTeamCommitteeFormView(id);
  }
}

/* =========================================================
   ADVANCED QUERY (Project-Admin/Org-Admin only)
   Two-view toggle modeled on modals/releases.js's showReleasesListView()/showReleasesFormView()
   pattern (title/footer swap, .hidden class toggle) — not a new tab-widget component.
   ========================================================= */

export function showProjectSearchSimpleView(){
  document.getElementById('projectSearchTabSearchBtn').classList.add('active');
  document.getElementById('projectSearchTabQueryBtn').classList.remove('active');
  document.getElementById('projectSearchSimpleView').classList.remove('hidden');
  document.getElementById('projectSearchQueryView').classList.add('hidden');
  document.getElementById('projectSearchSimpleFooter').classList.remove('hidden');
  document.getElementById('projectSearchQueryFooter').classList.add('hidden');
}

export function showProjectSearchQueryView(){
  // Defense in depth, matching project-storage.js's openProjectStorageModal() — not just relying on
  // the tab button being hidden — in case this is ever invoked directly while ungated.
  if(!canCurrentUserManageProject()){
    toast('Only a Project Administrator or Org Admin can run advanced queries.');
    return;
  }
  document.getElementById('projectSearchTabSearchBtn').classList.remove('active');
  document.getElementById('projectSearchTabQueryBtn').classList.add('active');
  document.getElementById('projectSearchSimpleView').classList.add('hidden');
  document.getElementById('projectSearchQueryView').classList.remove('hidden');
  document.getElementById('projectSearchSimpleFooter').classList.add('hidden');
  document.getElementById('projectSearchQueryFooter').classList.remove('hidden');
  document.getElementById('projectQuerySaveRow').classList.add('hidden');
  document.getElementById('projectQuerySavedPanel').classList.add('hidden');
  // Expose via API has no meaning for a local-only project — there's no server row of any kind to
  // attach an API key or a view-filter to (see CLAUDE.md §20) — so the control isn't offered at all,
  // not merely disabled, same exemption every other server-only permission gate in this app makes.
  document.getElementById('projectQueryExposeApiRow').classList.toggle('hidden', !isServerAuthoritative(getCurrentProject()));
  openProjectQuerySchemaPanel(); // Tables & Columns is shown by default when the Advanced Query view opens
  hideProjectQueryIntellisense();
  clearLoadedSavedQuery();
  showProjectQueryResultsTableView();
  document.getElementById('projectQuerySql').focus();
}

/* =========================================================
   SQL INTELLISENSE (inline autocomplete)
   DOM/keyboard wiring around features/sql-intellisense.js's pure computeIntellisense() — that module
   owns the suggestion logic and caret-pixel measurement, this file owns the dropdown DOM and how it
   reacts to typing/keys/mouse. app.js wires the actual input/keydown/mousedown/blur/scroll listeners
   (matching every other feature's split in this file) and calls the functions below.
   ========================================================= */
var intellisenseState = {open: false, options: [], start: 0, end: 0, activeIndex: 0};

// 'join' (a smart TABLE_RELATIONSHIPS-derived ON-condition suggestion) keeps a plain letter badge —
// only K/T/F (keyword/table/field) were asked to become icons. Everything else in this table renders
// as an icon via the standard data-icon + hydrateIcons() placeholder idiom (matches
// renderSavedQueriesList()'s own delete-icon rows above); 'field' (a plain, non-key column) renders
// with no icon and no text at all, per the ask, but the badge <span> stays in the markup so every
// row's label still starts at the same x-offset.
var INTELLISENSE_KIND_ICON = {table: 'grid', 'field-pk': 'key', 'field-fk': 'key'};
var INTELLISENSE_KIND_LETTER = {join: 'J'};

function renderIntellisenseDropdown(){
  var dropdown = document.getElementById('projectQueryIntellisenseDropdown');
  dropdown.innerHTML = intellisenseState.options.map(function(opt, i){
    var badgeContent;
    if(opt.kind === 'keyword') badgeContent = 'SQL';
    else if(INTELLISENSE_KIND_ICON[opt.kind]) badgeContent = '<span class="kf-icon" data-icon="' + INTELLISENSE_KIND_ICON[opt.kind] + '" data-size="11"></span>';
    else badgeContent = INTELLISENSE_KIND_LETTER[opt.kind] || '';
    return '<div class="kf-intellisense-option' + (i === intellisenseState.activeIndex ? ' active' : '') + '" data-option-index="' + i + '">' +
      '<span class="kf-intellisense-option-type kf-intellisense-type-' + opt.kind + '">' + badgeContent + '</span>' +
      '<span>' + escapeHTML(opt.label) + '</span>' +
    '</div>';
  }).join('');
  hydrateIcons(dropdown);
}

function positionIntellisenseDropdown(){
  var textarea = document.getElementById('projectQuerySql');
  var dropdown = document.getElementById('projectQueryIntellisenseDropdown');
  var rect = textarea.getBoundingClientRect();
  var caret = getCaretPixelPosition(textarea);
  dropdown.style.left = Math.round(rect.left + caret.left - textarea.scrollLeft) + 'px';
  dropdown.style.top = Math.round(rect.top + caret.top + caret.lineHeight - textarea.scrollTop) + 'px';
}

/* Called on every keystroke/click/scroll in the SQL textarea — a context that's no longer valid
   (computeIntellisense returns null) naturally closes the dropdown, so there's no separate
   close-tracking needed beyond this one recompute. */
export function updateProjectQueryIntellisense(){
  var textarea = document.getElementById('projectQuerySql');
  var result = computeIntellisense(textarea.value, textarea.selectionStart);
  if(!result){
    hideProjectQueryIntellisense();
    return;
  }
  intellisenseState.open = true;
  intellisenseState.options = result.options;
  intellisenseState.start = result.start;
  intellisenseState.end = result.end;
  intellisenseState.type = result.type;
  intellisenseState.activeIndex = 0;
  renderIntellisenseDropdown();
  positionIntellisenseDropdown();
  document.getElementById('projectQueryIntellisenseDropdown').classList.remove('hidden');
}

export function repositionProjectQueryIntellisense(){
  if(!intellisenseState.open) return;
  positionIntellisenseDropdown();
}

export function hideProjectQueryIntellisense(){
  if(!intellisenseState.open) return;
  intellisenseState.open = false;
  intellisenseState.options = [];
  document.getElementById('projectQueryIntellisenseDropdown').classList.add('hidden');
}

export function isProjectQueryIntellisenseOpen(){
  return intellisenseState.open;
}

export function moveProjectQueryIntellisenseActive(delta){
  if(!intellisenseState.open || intellisenseState.options.length === 0) return;
  var n = intellisenseState.options.length;
  intellisenseState.activeIndex = ((intellisenseState.activeIndex + delta) % n + n) % n;
  renderIntellisenseDropdown();
}

function acceptIntellisenseOption(index){
  if(!intellisenseState.open) return;
  var option = intellisenseState.options[index];
  if(!option) return;
  var textarea = document.getElementById('projectQuerySql');
  var value = textarea.value;
  var newValue = value.slice(0, intellisenseState.start) + option.insertText + value.slice(intellisenseState.end);
  var newCaret = intellisenseState.start + option.insertText.length;
  textarea.value = newValue;
  textarea.selectionStart = textarea.selectionEnd = newCaret;
  hideProjectQueryIntellisense();
  textarea.focus();
}

export function acceptProjectQueryIntellisenseSuggestion(){
  acceptIntellisenseOption(intellisenseState.activeIndex);
}

export function handleProjectQueryIntellisenseClick(e){
  var row = e.target.closest('[data-option-index]');
  if(!row) return;
  acceptIntellisenseOption(parseInt(row.getAttribute('data-option-index'), 10));
}

/* =========================================================
   ERD PAN / ZOOM / EXPORT
   Same pan/zoom idiom as views/dependency-map.js's depMapState/applyDepMapZoom/zoomDepMapAtPoint
   (reused, not reinvented — org-chart.js/gov-map.js/cost-benefit.js all duplicate this same small
   idiom rather than sharing a helper, matching this codebase's existing convention for this class of
   view). erdZoomState is exported so app.js's mousedown/mousemove/mouseup wiring can read/mutate its
   panActive/panMoved/panStart* fields directly, same as depMapState.
   ========================================================= */
export var erdZoomState = {scale: 1, panActive: false, panMoved: false, panStartX: 0, panStartY: 0, panStartScrollLeft: 0, panStartScrollTop: 0};
var ERD_MIN_ZOOM = 0.3;
var ERD_MAX_ZOOM = 2.5;
var lastErdLayout = null;

function applyErdZoom(){
  var svg = document.querySelector('#projectQuerySchemaErdInner svg');
  var label = document.getElementById('projectQueryErdZoomLabel');
  if(label) label.textContent = Math.round(erdZoomState.scale * 100) + '%';
  if(!svg || !lastErdLayout) return;
  svg.setAttribute('width', Math.round(lastErdLayout.width * erdZoomState.scale));
  svg.setAttribute('height', Math.round(lastErdLayout.height * erdZoomState.scale));
}

export function setProjectQueryErdZoom(delta){
  erdZoomState.scale = Math.max(ERD_MIN_ZOOM, Math.min(ERD_MAX_ZOOM, Math.round((erdZoomState.scale + delta) * 100) / 100));
  applyErdZoom();
}

export function resetProjectQueryErdZoom(){
  erdZoomState.scale = 1;
  applyErdZoom();
  var scroll = document.getElementById('projectQueryErdScroll');
  if(scroll){ scroll.scrollLeft = 0; scroll.scrollTop = 0; }
}

// Breathing room (px) left around the diagram at fit-to-screen zoom, so it doesn't touch the
// viewport's edges.
var ERD_FIT_PADDING = 48;

/* Picks whichever zoom level fits the WHOLE diagram inside the current #projectQueryErdScroll
   viewport on both axes (classic "zoom to fit" — same contain-not-cover idea as CSS
   background-size:contain), then resets scroll to 0,0. Deliberately NOT capped at 100%: a small
   diagram should zoom IN to fill the screen just as readily as a large one zooms out to fit,
   which is the whole point of a "fill the screen as best as possible" full-screen view. Reads
   scroll.clientWidth/Height, so this only gives the right answer once the caller's own layout
   change (e.g. adding .kf-erd-fullscreen) has actually taken effect -- querying a layout property
   like clientWidth forces the browser to flush that first, so no extra delay/rAF is needed as
   long as this runs AFTER the class toggle, not before. */
function fitProjectQueryErdToViewport(){
  var scroll = document.getElementById('projectQueryErdScroll');
  if(!scroll || !lastErdLayout || lastErdLayout.width <= 0 || lastErdLayout.height <= 0){
    resetProjectQueryErdZoom();
    return;
  }
  var availableWidth = Math.max(50, scroll.clientWidth - ERD_FIT_PADDING);
  var availableHeight = Math.max(50, scroll.clientHeight - ERD_FIT_PADDING);
  var fitScale = Math.min(availableWidth / lastErdLayout.width, availableHeight / lastErdLayout.height);
  erdZoomState.scale = Math.max(ERD_MIN_ZOOM, Math.min(ERD_MAX_ZOOM, Math.round(fitScale * 100) / 100));
  applyErdZoom();
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
}

/* Zoom by `deltaScale`, keeping the point under (clientX, clientY) visually fixed — see
   zoomDepMapAtPoint()'s own doc comment in views/dependency-map.js for the identical technique. */
export function zoomProjectQueryErdAtPoint(deltaScale, clientX, clientY){
  if(!lastErdLayout) return;
  var scroll = document.getElementById('projectQueryErdScroll');
  if(!scroll) return;

  var oldScale = erdZoomState.scale;
  var newScale = Math.max(ERD_MIN_ZOOM, Math.min(ERD_MAX_ZOOM, Math.round((oldScale + deltaScale) * 100) / 100));
  if(newScale === oldScale) return;

  var rect = scroll.getBoundingClientRect();
  var offsetX = clientX != null ? clientX - rect.left : rect.width / 2;
  var offsetY = clientY != null ? clientY - rect.top : rect.height / 2;

  var oldWidth = lastErdLayout.width * oldScale;
  var oldHeight = lastErdLayout.height * oldScale;
  var fracX = oldWidth > 0 ? (scroll.scrollLeft + offsetX) / oldWidth : 0;
  var fracY = oldHeight > 0 ? (scroll.scrollTop + offsetY) / oldHeight : 0;

  erdZoomState.scale = newScale;
  applyErdZoom();

  var newWidth = lastErdLayout.width * newScale;
  var newHeight = lastErdLayout.height * newScale;
  scroll.scrollLeft = fracX * newWidth - offsetX;
  scroll.scrollTop = fracY * newHeight - offsetY;
}

/* Full-screen ERD: a pure CSS state toggle (see #projectQuerySchemaPanel.kf-erd-fullscreen in
   styles.css) that pops the existing panel out to cover the whole viewport, above the Project
   Search modal itself — no separate overlay/modal element, no second copy of the toolbar/scroll
   markup to keep in sync. Entry fits+centers the diagram to the new, much bigger viewport (see
   fitProjectQueryErdToViewport()); exit resets to the small panel's own normal 100% starting
   point, same as opening the panel itself already does. */
var erdFullscreenActive = false;

export function isProjectQueryErdFullscreenOpen(){
  return erdFullscreenActive;
}

function setErdFullscreenButtonState(active){
  var btn = document.getElementById('projectQueryErdFullscreenBtn');
  if(!btn) return;
  var icon = btn.querySelector('.kf-icon');
  if(icon){
    icon.setAttribute('data-icon', active ? 'collapse' : 'expand');
    hydrateIcons(btn);
  }
  btn.title = active ? 'Exit Full Screen' : 'View Full Screen';
}

export function openProjectQueryErdFullscreen(){
  if(erdFullscreenActive) return;
  erdFullscreenActive = true;
  document.getElementById('projectQuerySchemaPanel').classList.add('kf-erd-fullscreen');
  setErdFullscreenButtonState(true);
  // Must come after the class toggle above -- fitProjectQueryErdToViewport() reads the scroll
  // container's now-full-viewport clientWidth/Height, not its old small-panel size.
  fitProjectQueryErdToViewport();
}

export function closeProjectQueryErdFullscreen(){
  if(!erdFullscreenActive) return;
  erdFullscreenActive = false;
  document.getElementById('projectQuerySchemaPanel').classList.remove('kf-erd-fullscreen');
  setErdFullscreenButtonState(false);
  resetProjectQueryErdZoom();
}

export function toggleProjectQueryErdFullscreen(){
  if(erdFullscreenActive) closeProjectQueryErdFullscreen();
  else openProjectQueryErdFullscreen();
}

export function openProjectQuerySchemaPanel(){
  var panel = document.getElementById('projectQuerySchemaPanel');
  // Regenerated fresh every time the panel opens, straight from query-engine.js's own
  // TABLE_SCHEMAS/TABLE_RELATIONSHIPS — never a stale cached diagram.
  var inner = document.getElementById('projectQuerySchemaErdInner');
  inner.innerHTML = buildSchemaErdSvg();
  var svg = inner.querySelector('svg');
  lastErdLayout = svg ? {width: parseFloat(svg.getAttribute('width')), height: parseFloat(svg.getAttribute('height'))} : null;
  erdZoomState.scale = 1;
  applyErdZoom();
  var scroll = document.getElementById('projectQueryErdScroll');
  if(scroll){ scroll.scrollLeft = 0; scroll.scrollTop = 0; }
  panel.classList.remove('hidden');
  document.getElementById('projectQuerySavedPanel').classList.add('hidden');
}

export function toggleProjectQuerySchemaPanel(){
  var panel = document.getElementById('projectQuerySchemaPanel');
  if(panel.classList.contains('hidden')) openProjectQuerySchemaPanel();
  else panel.classList.add('hidden');
}

/* =========================================================
   ERD RELATIONSHIP HIGHLIGHTING
   Click a table -> everything not connected to it (by any relationship) dims to 25% opacity (a 75%
   dim, per the ask). Click a relationship connector -> only its own two tables and that one edge
   stay at full opacity, everything else dims, INCLUDING other edges between that same table pair
   (dimming is scoped to "this one connector", not "every connector touching either endpoint"). Click
   whitespace (the scroll container's own background, or the SVG canvas outside any table/edge) ->
   clears back to the fully-visible starting state. Dimming is a single `.kf-erd-dimmed` CSS class
   (styles.css) applied per <g class="kf-erd-table"|"kf-erd-edge"> element — schema-erd.js is what
   stamps those data-table/data-from/data-to attributes on, so this file never has to re-derive the
   diagram's own layout/adjacency, only read what's already in the DOM.
   ========================================================= */
function clearSchemaErdHighlight(){
  var inner = document.getElementById('projectQuerySchemaErdInner');
  if(!inner) return;
  inner.querySelectorAll('.kf-erd-dimmed').forEach(function(el){ el.classList.remove('kf-erd-dimmed'); });
}

function highlightSchemaErdTable(tableName){
  var inner = document.getElementById('projectQuerySchemaErdInner');
  if(!inner) return;
  var connected = {};
  connected[tableName] = true;
  inner.querySelectorAll('.kf-erd-edge').forEach(function(edge){
    var from = edge.getAttribute('data-from'), to = edge.getAttribute('data-to');
    if(from === tableName) connected[to] = true;
    if(to === tableName) connected[from] = true;
  });
  inner.querySelectorAll('.kf-erd-table').forEach(function(box){
    box.classList.toggle('kf-erd-dimmed', !connected[box.getAttribute('data-table')]);
  });
  inner.querySelectorAll('.kf-erd-edge').forEach(function(edge){
    var from = edge.getAttribute('data-from'), to = edge.getAttribute('data-to');
    edge.classList.toggle('kf-erd-dimmed', !(from === tableName || to === tableName));
  });
}

function highlightSchemaErdEdge(edgeEl){
  var inner = document.getElementById('projectQuerySchemaErdInner');
  if(!inner) return;
  var from = edgeEl.getAttribute('data-from'), to = edgeEl.getAttribute('data-to');
  var relIndex = edgeEl.getAttribute('data-rel-index');
  inner.querySelectorAll('.kf-erd-table').forEach(function(box){
    var name = box.getAttribute('data-table');
    box.classList.toggle('kf-erd-dimmed', !(name === from || name === to));
  });
  inner.querySelectorAll('.kf-erd-edge').forEach(function(edge){
    edge.classList.toggle('kf-erd-dimmed', edge.getAttribute('data-rel-index') !== relIndex);
  });
}

export function handleSchemaErdClick(e){
  if(erdZoomState.panMoved) return;
  var edge = e.target.closest('.kf-erd-edge');
  if(edge){ highlightSchemaErdEdge(edge); return; }
  var table = e.target.closest('.kf-erd-table');
  if(table){ highlightSchemaErdTable(table.getAttribute('data-table')); return; }
  clearSchemaErdHighlight();
}

/* =========================================================
   SAVED QUERY LIBRARY
   Shared, project-scoped entity (local-only: project.savedQueries in localStorage; server-
   authoritative: SavedQueries table, one shared list every project member sees) — same
   isServerAuthoritative() branch every other entity mutation in this app uses (see
   modals/risks.js's saveRiskFromModal()).
   ========================================================= */

// Which saved query (if any) is currently loaded into the textarea — once set, the "Save Query"
// button becomes "Update Query" and overwrites this same saved query (with a confirm first) instead
// of creating a new one. Cleared whenever the Advanced Query view is (re)opened or the loaded query
// itself is deleted, so the button always reflects a saved query that still actually exists.
var loadedSavedQueryId = null;
var loadedSavedQueryName = null;
// The loaded query's own SQL as of the last load/save/update — the "New" button's dirty-check
// baseline (see isLoadedQueryDirty()). Kept in sync on every successful update so a second edit in
// the same session is compared against the just-saved text, not the original load.
var loadedSavedQuerySql = null;

function updateSaveQueryButtonLabel(){
  document.getElementById('projectQuerySaveBtn').textContent = loadedSavedQueryId ? 'Update Query' : 'Save Query';
}

// Builds the public URL a 3rd-party caller would hit for this saved query — same-origin path per
// api.js's own convention (nginx reverse-proxies /api/* alongside the frontend, see PublicQueryController's
// own note on the /api/public/v1/ prefix), so no separate base-URL config is needed here. Exported so
// modals/api-endpoints.js can build the same URL for every exposed query without duplicating this.
export function projectQueryApiUrl(queryId){
  return window.location.origin + '/api/public/v1/queries/' + queryId + '/results';
}

// The saved query id the "Test API" button should actually call — tracked separately from
// loadedSavedQueryId since showProjectQueryApiUrl() is also called right after a brand-new query is
// created (confirmSaveProjectQuery doesn't load the new query, see its own comment), when
// loadedSavedQueryId is still null.
var currentApiUrlQueryId = null;

function showProjectQueryApiUrl(queryId){
  currentApiUrlQueryId = queryId;
  document.getElementById('projectQueryApiUrlText').textContent = projectQueryApiUrl(queryId);
  document.getElementById('projectQueryApiUrlRow').classList.remove('hidden');
  hideProjectQueryApiTestPanel();
}

function hideProjectQueryApiUrl(){
  currentApiUrlQueryId = null;
  document.getElementById('projectQueryApiUrlRow').classList.add('hidden');
  hideProjectQueryApiTestPanel();
}

function hideProjectQueryApiTestPanel(){
  document.getElementById('projectQueryApiTestPanel').classList.add('hidden');
  document.getElementById('projectQueryApiTestResult').textContent = '';
  document.getElementById('projectQueryApiTestStatus').textContent = '';
  document.getElementById('projectQueryApiTestStatus').className = 'kf-query-api-test-status';
}

// "Test API (GET)" button — see api.js's testSavedQueryApi() for why this goes through an
// authenticated project endpoint rather than the real public one (no retrievable API key to send).
export async function testProjectQueryApi(){
  var project = getCurrentProject();
  if(!project || !currentApiUrlQueryId) return;

  var statusEl = document.getElementById('projectQueryApiTestStatus');
  var resultEl = document.getElementById('projectQueryApiTestResult');
  document.getElementById('projectQueryApiTestPanel').classList.remove('hidden');
  statusEl.className = 'kf-query-api-test-status';
  statusEl.textContent = 'Running...';
  resultEl.textContent = '';

  try {
    var result = await testSavedQueryApi(project.serverProjectId, currentApiUrlQueryId);
    statusEl.className = 'kf-query-api-test-status kf-query-api-test-status-ok';
    statusEl.textContent = '200 OK — ' + result.rows.length + ' row' + (result.rows.length === 1 ? '' : 's') +
      (result.truncated ? ' (truncated)' : '');
    resultEl.textContent = JSON.stringify(result, null, 2);
  } catch(e){
    statusEl.className = 'kf-query-api-test-status kf-query-api-test-status-error';
    statusEl.textContent = 'Request failed';
    resultEl.textContent = e.message || 'Unknown error';
  }
}

function setLoadedSavedQuery(id, name, sql, exposeViaApi){
  loadedSavedQueryId = id;
  loadedSavedQueryName = name;
  loadedSavedQuerySql = sql;
  updateSaveQueryButtonLabel();
  document.getElementById('projectQueryExposeApiCheckbox').checked = !!exposeViaApi;
  if(exposeViaApi) showProjectQueryApiUrl(id);
  else hideProjectQueryApiUrl();
}

export function clearLoadedSavedQuery(){
  loadedSavedQueryId = null;
  loadedSavedQueryName = null;
  loadedSavedQuerySql = null;
  updateSaveQueryButtonLabel();
  document.getElementById('projectQueryExposeApiCheckbox').checked = false;
  hideProjectQueryApiUrl();
}

// "Dirty" only has meaning relative to a saved baseline — a query that was never saved has nothing
// to compare against, so the New button's save-prompt is scoped to "a saved query is loaded AND its
// text has changed since", not "the box has any content at all".
function isLoadedQueryDirty(){
  if(loadedSavedQueryId === null) return false;
  return document.getElementById('projectQuerySql').value !== loadedSavedQuerySql;
}

function renderSavedQueriesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('projectQuerySavedList');
  var queries = (project && project.savedQueries) || [];
  if(queries.length === 0){
    listEl.innerHTML = '<div class="kf-query-saved-empty">No saved queries yet.</div>';
    return;
  }
  listEl.innerHTML = queries.map(function(q){
    return '<div class="kf-query-saved-row" data-query-id="' + q.id + '">' +
      '<span class="kf-query-saved-row-name">' + escapeHTML(q.name) + '</span>' +
      '<button type="button" class="kf-query-saved-row-delete" data-query-delete-id="' + q.id + '" title="Delete"><span class="kf-icon" data-icon="trash" data-size="14"></span></button>' +
    '</div>';
  }).join('');
  hydrateIcons(listEl);
}

export function toggleProjectQuerySavedPanel(){
  var panel = document.getElementById('projectQuerySavedPanel');
  var willShow = panel.classList.contains('hidden');
  if(willShow) renderSavedQueriesList();
  panel.classList.toggle('hidden', !willShow);
  if(willShow) document.getElementById('projectQuerySchemaPanel').classList.add('hidden');
}

export function handleProjectQuerySavedListClick(e){
  var deleteBtn = e.target.closest('[data-query-delete-id]');
  if(deleteBtn){
    e.stopPropagation();
    deleteSavedQueryRow(deleteBtn.getAttribute('data-query-delete-id'));
    return;
  }
  var row = e.target.closest('[data-query-id]');
  if(!row) return;
  var project = getCurrentProject();
  if(!project) return;
  var query = (project.savedQueries || []).find(function(q){ return q.id === row.getAttribute('data-query-id'); });
  if(!query) return;
  document.getElementById('projectQuerySql').value = query.sql;
  document.getElementById('projectQuerySavedPanel').classList.add('hidden');
  hideProjectQueryIntellisense();
  setLoadedSavedQuery(query.id, query.name, query.sql, query.exposeViaApi);
}

function deleteSavedQueryRow(queryId){
  var project = getCurrentProject();
  if(!project) return;
  var query = (project.savedQueries || []).find(function(q){ return q.id === queryId; });
  if(!query) return;
  confirmDialog(
    'Delete "' + query.name + '"?',
    'This cannot be undone.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await savedQueryApi.remove(project.serverProjectId, queryId);
          await refreshProjectFromServer(project.id);
          toast('Deleted "' + query.name + '".');
          renderSavedQueriesList();
          if(queryId === loadedSavedQueryId) clearLoadedSavedQuery();
        } catch(e){
          toast('Could not delete query on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      deleteSavedQuery(project, queryId);
      toast('Deleted "' + query.name + '".');
      renderSavedQueriesList();
      if(queryId === loadedSavedQueryId) clearLoadedSavedQuery();
    }
  );
}

// Dispatcher for the one Save/Update button: a saved query currently loaded into the textarea means
// "Update Query" — confirm, then overwrite that same saved query's SQL in place; otherwise "Save
// Query" — reveal the inline name-input row to create a brand new one, same as before this feature.
export function handleProjectQuerySaveOrUpdateClick(){
  if(loadedSavedQueryId) confirmUpdateProjectQuery();
  else showProjectQuerySaveRow();
}

// The raw update action, no confirm dialog of its own — used both by the "Update Query" button
// (wrapped in a confirm, see confirmUpdateProjectQuery below) and by the "New" button's own confirm
// dialog (which already asked "save first?", so a second nested confirm here would be redundant).
// `onSaved` fires only after a genuinely successful save, never on a server error, so a failed save
// can't silently discard the user's edits behind it (e.g. New's own reset-to-empty step).
async function performSavedQueryUpdate(onSaved){
  var project = getCurrentProject();
  if(!project) return;
  // Always formatted before persisting (§18's own bracket-wrap-every-identifier convention) — not
  // just a style nicety: an unformatted, unbracketed query is exactly the shape that broke the
  // Public Query API against Postgres (see CLAUDE.md §20's two live-bug writeups), so persisting the
  // formatted form is a real defensive measure, not only cosmetic. The textarea is updated to match
  // so what's displayed never silently diverges from what's actually saved.
  var textarea = document.getElementById('projectQuerySql');
  var sql = formatSql(textarea.value);
  textarea.value = sql;
  hideProjectQueryIntellisense();
  var queryId = loadedSavedQueryId;
  var name = loadedSavedQueryName;
  var exposeViaApi = document.getElementById('projectQueryExposeApiCheckbox').checked;

  if(isServerAuthoritative(project)){
    try {
      await savedQueryApi.update(project.serverProjectId, queryId, {name: name, sql: sql, exposeViaApi: exposeViaApi});
      await refreshProjectFromServer(project.id);
      applyHeaderButtonVisibility();
      toast('Query updated.');
      loadedSavedQuerySql = sql;
      if(exposeViaApi) showProjectQueryApiUrl(queryId);
      else hideProjectQueryApiUrl();
      if(onSaved) onSaved();
    } catch(e){
      toast('Could not update query on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }
  updateSavedQuery(project, queryId, {name: name, sql: sql});
  toast('Query updated.');
  loadedSavedQuerySql = sql;
  if(onSaved) onSaved();
}

function confirmUpdateProjectQuery(){
  var sql = document.getElementById('projectQuerySql').value;
  if(!sql.trim()){ toast('Enter a query first.'); return; }
  confirmDialog(
    'Update "' + loadedSavedQueryName + '"?',
    'This will overwrite the saved query with the current SQL. This cannot be undone.',
    function(){ performSavedQueryUpdate(); }
  );
}

/* =========================================================
   NEW QUERY
   Clears the textarea back to empty. If a saved query is loaded and has been edited since (see
   isLoadedQueryDirty()), confirms whether to save those changes first — Confirm saves (reusing the
   same update path "Update Query" uses) then clears; the dialog's own Cancel button discards the
   changes and clears anyway; the X/outside-click dismissal aborts New entirely, leaving the edit in
   place (see confirm.js's onCancel doc comment for why only the labeled Cancel button fires it).
   ========================================================= */
function resetProjectQueryToNew(){
  var textarea = document.getElementById('projectQuerySql');
  textarea.value = '';
  hideProjectQueryIntellisense();
  clearLoadedSavedQuery();
  document.getElementById('projectQueryResultsWrap').innerHTML = '';
  document.getElementById('projectQueryResultsJson').textContent = '';
  document.getElementById('projectQueryRowCount').textContent = '';
  var errorEl = document.getElementById('projectQueryError');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  textarea.focus();
}

export function handleProjectQueryNewClick(){
  if(!isLoadedQueryDirty()){
    resetProjectQueryToNew();
    return;
  }
  confirmDialog(
    'Save changes to "' + loadedSavedQueryName + '"?',
    'This query has unsaved changes. Click Confirm to save them before starting a new query, or Cancel to discard the changes.',
    function(){ performSavedQueryUpdate(resetProjectQueryToNew); },
    function(){ resetProjectQueryToNew(); }
  );
}

export function showProjectQuerySaveRow(){
  var sql = document.getElementById('projectQuerySql').value.trim();
  if(!sql){ toast('Enter a query first.'); return; }
  document.getElementById('projectQuerySaveRow').classList.remove('hidden');
  var nameInput = document.getElementById('projectQuerySaveNameInput');
  nameInput.value = '';
  nameInput.focus();
}

export function hideProjectQuerySaveRow(){
  document.getElementById('projectQuerySaveRow').classList.add('hidden');
}

export async function confirmSaveProjectQuery(){
  var project = getCurrentProject();
  if(!project) return;
  var name = document.getElementById('projectQuerySaveNameInput').value.trim();
  var textarea = document.getElementById('projectQuerySql');
  if(!name){ toast('Please enter a name for the query.'); return; }
  if(!textarea.value.trim()){ toast('Enter a query first.'); return; }
  // Always formatted before persisting — see performSavedQueryUpdate's own comment for why this is
  // a real defensive measure (bracket-wraps every identifier), not just a style nicety.
  var sql = formatSql(textarea.value);
  textarea.value = sql;
  hideProjectQueryIntellisense();

  if(isServerAuthoritative(project)){
    var exposeViaApi = document.getElementById('projectQueryExposeApiCheckbox').checked;
    try {
      var created = await savedQueryApi.create(project.serverProjectId, {name: name, sql: sql, exposeViaApi: exposeViaApi});
      await refreshProjectFromServer(project.id);
      applyHeaderButtonVisibility();
      toast('Query saved.');
      hideProjectQuerySaveRow();
      if(exposeViaApi) showProjectQueryApiUrl(created.id);
      else hideProjectQueryApiUrl();
    } catch(e){
      toast('Could not save query on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }
  addSavedQuery(project, {name: name, sql: sql});
  toast('Query saved.');
  hideProjectQuerySaveRow();
}

function renderQueryResultsTable(result){
  var wrap = document.getElementById('projectQueryResultsWrap');
  var rowCountEl = document.getElementById('projectQueryRowCount');
  if(result.rows.length === 0){
    wrap.innerHTML = '<div class="kf-search-empty">Query ran successfully — 0 rows returned.</div>';
    rowCountEl.textContent = '';
    return;
  }
  rowCountEl.textContent = result.rows.length + (result.rows.length === 1 ? ' row' : ' rows');
  var theadHTML = '<thead><tr>' + result.columns.map(function(c){ return '<th>' + escapeHTML(c) + '</th>'; }).join('') + '</tr></thead>';
  var tbodyHTML = '<tbody>' + result.rows.map(function(row){
    return '<tr>' + result.columns.map(function(c){
      var v = row[c];
      return '<td>' + escapeHTML(v == null ? '' : String(v)) + '</td>';
    }).join('') + '</tr>';
  }).join('') + '</tbody>';
  wrap.innerHTML = '<table class="kf-query-results-table">' + theadHTML + tbodyHTML + '</table>';
}

function renderQueryResultsJson(result){
  document.getElementById('projectQueryResultsJson').textContent = JSON.stringify(result.rows, null, 2);
}

/* =========================================================
   RESULT VIEW MODE (Table / JSON)
   Same .active-button + .hidden-sibling-pane toggle idiom as showProjectSearchSimpleView()/
   showProjectSearchQueryView() above, sized down as an icon-button pair.
   ========================================================= */

function applyQueryResultViewMode(){
  var isJson = queryResultViewMode === 'json';
  document.getElementById('projectQueryViewTableBtn').classList.toggle('active', !isJson);
  document.getElementById('projectQueryViewJsonBtn').classList.toggle('active', isJson);
  document.getElementById('projectQueryResultsWrap').classList.toggle('hidden', isJson);
  document.getElementById('projectQueryResultsJson').classList.toggle('hidden', !isJson);
  document.getElementById('projectQueryExportCsvBtn').classList.toggle('hidden', isJson);
  document.getElementById('projectQueryCopyJsonBtn').classList.toggle('hidden', !isJson);
  document.getElementById('projectQueryExportJsonBtn').classList.toggle('hidden', !isJson);
}

export function showProjectQueryResultsTableView(){
  queryResultViewMode = 'table';
  applyQueryResultViewMode();
}

export function showProjectQueryResultsJsonView(){
  queryResultViewMode = 'json';
  applyQueryResultViewMode();
}

export function formatProjectQuerySql(){
  var textarea = document.getElementById('projectQuerySql');
  if(!textarea.value.trim()){ toast('Enter a query first.'); return; }
  textarea.value = formatSql(textarea.value);
  hideProjectQueryIntellisense(); // the caret position that produced any open suggestion no longer applies
  textarea.focus();
}

export function runProjectQuery(){
  var project = getCurrentProject();
  var sql = document.getElementById('projectQuerySql').value;
  var errorEl = document.getElementById('projectQueryError');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  try {
    lastQueryResult = executeQuery(project, sql);
    renderQueryResultsTable(lastQueryResult);
    renderQueryResultsJson(lastQueryResult);
  } catch(e){
    lastQueryResult = null;
    document.getElementById('projectQueryResultsWrap').innerHTML = '';
    document.getElementById('projectQueryResultsJson').textContent = '';
    document.getElementById('projectQueryRowCount').textContent = '';
    errorEl.textContent = e instanceof QueryError ? e.message : ('Unexpected error: ' + (e && e.message ? e.message : e));
    errorEl.classList.remove('hidden');
  }
  applyQueryResultViewMode();
}

// Same Blob + <a download> technique as views/task-list.js's exportTaskListAsCsv() /
// features/svg-export.js's PNG export — each keeps its own tiny copy of this rather than sharing one,
// matching this codebase's existing convention.
function downloadBlob(blob, filename){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportProjectQueryResultsAsCsv(){
  if(!lastQueryResult || lastQueryResult.rows.length === 0){
    toast('Run a query with results first.');
    return;
  }
  var project = getCurrentProject();
  var lines = [lastQueryResult.columns.map(csvEscapeValue).join(',')];
  lastQueryResult.rows.forEach(function(row){
    lines.push(lastQueryResult.columns.map(function(c){ return csvEscapeValue(row[c]); }).join(','));
  });
  var blob = new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  var filename = (project ? project.key : 'query') + '-query-' + new Date().toISOString().slice(0,10) + '.csv';
  downloadBlob(blob, filename);
  toast('Exported ' + filename);
}

export function copyProjectQueryApiUrl(){
  var url = document.getElementById('projectQueryApiUrlText').textContent;
  if(!url) return;
  if(!navigator.clipboard || !navigator.clipboard.writeText){
    toast('Clipboard access is not available in this browser.');
    return;
  }
  navigator.clipboard.writeText(url).then(function(){
    toast('Copied API URL to clipboard.');
  }, function(){
    toast('Could not copy to clipboard.');
  });
}

export function copyProjectQueryResultsAsJson(){
  if(!lastQueryResult || lastQueryResult.rows.length === 0){
    toast('Run a query with results first.');
    return;
  }
  if(!navigator.clipboard || !navigator.clipboard.writeText){
    toast('Clipboard access is not available in this browser.');
    return;
  }
  var json = JSON.stringify(lastQueryResult.rows, null, 2);
  navigator.clipboard.writeText(json).then(function(){
    toast('Copied results to clipboard.');
  }, function(){
    toast('Could not copy to clipboard.');
  });
}

export function exportProjectQueryResultsAsJson(){
  if(!lastQueryResult || lastQueryResult.rows.length === 0){
    toast('Run a query with results first.');
    return;
  }
  var project = getCurrentProject();
  var blob = new Blob([JSON.stringify(lastQueryResult.rows, null, 2)], {type: 'application/json'});
  var filename = (project ? project.key : 'query') + '-query-results-' + new Date().toISOString().slice(0,10) + '.json';
  downloadBlob(blob, filename);
  toast('Exported ' + filename);
}

export function printProjectQueryResults(){
  window.print();
}
