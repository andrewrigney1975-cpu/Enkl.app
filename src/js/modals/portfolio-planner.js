"use strict";
import { toast, getPriority } from '../ui.js';
import { escapeHTML } from '../views/board.js';
import { portfolioApi, isOrgAdmin, getMyOrganisationApi } from '../api.js';
import { PRIORITY_META, PRIORITY_ORDER } from '../config.js';
import { confirmDialog } from './confirm.js';
import { buildTimelineColumns, tlDateToPixel, tlPixelToDate } from '../views/timeline.js';
import { projectBarSVG, noDatesPatternDefsSVG } from '../portfolio-bars.js';
import { iconSvg } from '../icons.js';

/* =========================================================
   PORTFOLIO PLANNER — Org-Admin-only. Lets an org sketch out its whole suite of activities
   (Projects created here start IsActive=false, no ProjectMember row, no token mint — see
   PortfolioService.CreateProjectAsync's doc comment), group them into user-definable categories,
   set rough/firm dates, and activate a project once it has both a start and end date. Every figure
   here comes from portfolioApi, which is OrgAdmin-gated server-side and independently re-validates
   every id against the caller's own organisation (see PortfolioService.cs/.php) — nothing here ever
   trusts a client-side id as authoritative. Category collapse state is in-memory only (resets each
   time the overlay opens), not persisted.
   ========================================================= */

var PLANNER_HANDLE_WIDTH = 8;
var PLANNER_DRAG_CLICK_THRESHOLD = 4;
// A plain click's own "open the Dates modal" action is delayed by this long before actually firing —
// long enough for a genuine double-click's second mousedown/mouseup to arrive and cancel it (see
// scheduleBarSingleClick/onPortfolioPlannerBarDblClick), short enough that a real single click still
// feels instant.
var PLANNER_CLICK_DELAY_MS = 250;

var _categories = [];
var _allProjects = [];
var _collapsedCategoryIds = new Set();
var _plannerState = {granularity: 'month', start: null, end: null};
var _addProjectCategoryId = null;

// Same chip-toggle idiom as the Board's ui.activePriorities (views/board.js's
// renderPriorityFilterChips), but kept as its own Set rather than sharing that one — this filters
// the org-wide Timeline chart below, not any single project's board, so conflating the two would mean
// toggling a priority here unexpectedly also filtered whichever project's board the user came from.
// Empty set = no filter = every project shown, same convention as the Board's.
var _plannerActivePriorities = new Set();

// Same multi-select dropdown idiom as the Board's ui.activeAssignees (views/board.js's
// renderAssigneeFilterChips) — a real category's own id, or '' as the Uncategorised catch-all
// sentinel (matching groupProjectsByCategory's own key convention for that pseudo-group, same as
// _collapsedCategoryIds above), mirroring how Assignee's Set holds either a real member id or the
// UNASSIGNED_FILTER_KEY sentinel. Unlike the priority filter (which drops non-matching PROJECTS out
// of every band), this drops whole non-matching BANDS — selecting a category means "show only that
// swimlane", not "show only same-priority projects within every swimlane".
var _plannerActiveCategories = new Set();

// Cached from the most recent renderPortfolioPlannerChart() — see the identical pattern/comment on
// _timelineLayout in portfolio-dashboard.js.
var _plannerLayout = null;
var _plannerDrag = null;
var _plannerClickTimer = null;

export function openPortfolioPlannerOverlay(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can open the Portfolio Planner.'); return; }
  document.getElementById('portfolioPlannerOverlay').classList.remove('hidden');
  loadPortfolioPlannerDataAndRender();
}
export function closePortfolioPlannerOverlay(){
  document.getElementById('portfolioPlannerOverlay').classList.add('hidden');
}
export function isPortfolioPlannerOverlayOpen(){
  return !document.getElementById('portfolioPlannerOverlay').classList.contains('hidden');
}

function loadPortfolioPlannerDataAndRender(){
  var groupsEl = document.getElementById('portfolioPlannerGroups');
  groupsEl.innerHTML = '<div class="kf-health-empty">Loading…</div>';
  Promise.all([portfolioApi.listProjects(), portfolioApi.listCategories()]).then(function(results){
    _allProjects = results[0] || [];
    _categories = results[1] || [];
    if(!_plannerState.start || !_plannerState.end){
      var range = defaultYearRange();
      _plannerState.start = range.start;
      _plannerState.end = range.end;
    }
    renderPortfolioPlannerAll();
  }, function(){
    groupsEl.innerHTML = '<div class="kf-health-empty">Could not load Portfolio Planner data.</div>';
  });
}

function defaultYearRange(){
  var year = new Date().getFullYear();
  return {start: new Date(year, 0, 1), end: new Date(year, 11, 31)};
}
function toServerDateOnly(date){
  var y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function renderPortfolioPlannerAll(){
  renderPortfolioPlannerGroups();
  renderPortfolioPlannerControls();
  renderPortfolioPlannerPriorityFilterChips();
  renderPortfolioPlannerCategoryFilterChips();
  renderPortfolioPlannerChart();
}

/* Identical chip markup/behavior to the Board's renderPriorityFilterChips (views/board.js) — toggles
   membership in _plannerActivePriorities and re-renders just the chips + chart, not the Categories
   panel above, which isn't priority-filtered. Filters BOTH active and inactive projects alike, since
   this is a portfolio-wide scheduling view, not a "what's live" view. */
function renderPortfolioPlannerPriorityFilterChips(){
  var wrap = document.getElementById('portfolioPlannerPriorityFilterChips');
  if(!wrap) return;
  wrap.innerHTML = '';
  PRIORITY_ORDER.forEach(function(key){
    var conf = getPriority(key);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'kf-chip-filter' + (_plannerActivePriorities.has(key) ? ' active' : '');
    chip.setAttribute('data-priority', key);
    chip.innerHTML = '<span class="kf-dot" style="background:' + conf.accent + '"></span>' + conf.label;
    chip.addEventListener('click', function(){
      if(_plannerActivePriorities.has(key)) _plannerActivePriorities.delete(key);
      else _plannerActivePriorities.add(key);
      renderPortfolioPlannerPriorityFilterChips();
      renderPortfolioPlannerChart();
    });
    wrap.appendChild(chip);
  });
}

/* Same button-label/panel/clear-selection shape as the Board's renderAssigneeFilterChips
   (views/board.js), including a trailing catch-all row for items with no real id (Assignee's
   "Unassigned", here "Uncategorised"). Rows have no color dot — unlike a Member, a PortfolioCategory
   carries no color field to show one for (same reasoning as the Board's Team filter, which is also
   dot-less for the same reason). */
function renderPortfolioPlannerCategoryFilterChips(){
  var wrap = document.getElementById('portfolioPlannerCategoryFilterWrap');
  var panel = document.getElementById('portfolioPlannerCategoryFilterPanel');
  var label = document.getElementById('portfolioPlannerCategoryFilterLabel');
  if(!wrap) return;

  var sortedCategories = _categories.slice().sort(function(a, b){ return a.sortOrder - b.sortOrder; });

  var n = _plannerActiveCategories.size;
  if(n === 0){
    label.textContent = 'Category';
  } else if(n === 1){
    var onlyKey = _plannerActiveCategories.values().next().value;
    if(onlyKey === ''){
      label.textContent = 'Uncategorised';
    } else {
      var onlyCategory = sortedCategories.filter(function(c){ return c.id === onlyKey; })[0];
      label.textContent = onlyCategory ? onlyCategory.name : 'Category';
    }
  } else {
    label.textContent = n + ' categories';
  }
  wrap.classList.toggle('active', n > 0);

  panel.innerHTML = '';
  sortedCategories.forEach(function(c){
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row';
    var checked = _plannerActiveCategories.has(c.id);
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(c.name) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) _plannerActiveCategories.add(c.id);
      else _plannerActiveCategories.delete(c.id);
      renderPortfolioPlannerCategoryFilterChips();
      renderPortfolioPlannerChart();
    });
    panel.appendChild(row);
  });

  var uncategorizedRow = document.createElement('label');
  uncategorizedRow.className = 'kf-dropdown-filter-row';
  var uncategorizedChecked = _plannerActiveCategories.has('');
  uncategorizedRow.innerHTML =
    '<input type="checkbox" ' + (uncategorizedChecked ? 'checked' : '') + '>' +
    '<span class="kf-dropdown-filter-name">Uncategorised</span>';
  uncategorizedRow.querySelector('input').addEventListener('change', function(e){
    if(e.target.checked) _plannerActiveCategories.add('');
    else _plannerActiveCategories.delete('');
    renderPortfolioPlannerCategoryFilterChips();
    renderPortfolioPlannerChart();
  });
  panel.appendChild(uncategorizedRow);

  if(n > 0){
    var divider = document.createElement('div');
    divider.className = 'kf-dropdown-filter-divider';
    panel.appendChild(divider);
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'kf-dropdown-filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', function(){
      _plannerActiveCategories.clear();
      renderPortfolioPlannerCategoryFilterChips();
      renderPortfolioPlannerChart();
    });
    panel.appendChild(clearBtn);
  }
}
export function togglePortfolioPlannerCategoryFilterPanel(){
  document.getElementById('portfolioPlannerCategoryFilterPanel').classList.toggle('hidden');
}
export function closePortfolioPlannerCategoryFilterPanel(){
  document.getElementById('portfolioPlannerCategoryFilterPanel').classList.add('hidden');
}

/* Real categories (sorted by SortOrder) first, then a fixed trailing "Uncategorised" pseudo-group
   for CategoryId === null — `key` is the empty string for that pseudo-group (never a real category
   id) so data-category-id="" reads back as `null` at every call site below. */
function groupProjectsByCategory(){
  var sorted = _categories.slice().sort(function(a, b){ return a.sortOrder - b.sortOrder; });
  var groups = sorted.map(function(c){
    return {key: c.id, label: c.name, isRealCategory: true, projects: []};
  });
  var uncategorized = {key: '', label: 'Uncategorised', isRealCategory: false, projects: []};
  _allProjects.forEach(function(p){
    var group = p.categoryId ? groups.filter(function(g){ return g.key === p.categoryId; })[0] : null;
    (group || uncategorized).projects.push(p);
  });
  groups.forEach(function(g){
    g.projects.sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  });
  uncategorized.projects.sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  groups.push(uncategorized);
  return groups;
}

// Collapse state is scoped to the Categories list only — the Gantt chart below always renders
// every project regardless (it's a visualization of the whole portfolio, not the management panel),
// so none of these touch renderPortfolioPlannerChart().
export function expandAllPortfolioPlannerCategories(){
  _collapsedCategoryIds.clear();
  renderPortfolioPlannerGroups();
}
export function collapseAllPortfolioPlannerCategories(){
  // Same key convention as groupProjectsByCategory/toggle-collapse — real category ids plus the
  // empty-string sentinel for the trailing Uncategorised group.
  _collapsedCategoryIds = new Set(_categories.map(function(c){ return c.id; }).concat(['']));
  renderPortfolioPlannerGroups();
}

/* =========================================================
   CATEGORY GROUPS (HTML) — rename/reorder/delete/add-project/activate/category-reassignment all
   live here as plain form controls; the chart below is purely the visual Gantt.
   ========================================================= */
function renderPortfolioPlannerGroups(){
  var groupsEl = document.getElementById('portfolioPlannerGroups');
  var groups = groupProjectsByCategory();

  groupsEl.innerHTML = groups.map(function(g, idx){
    var collapsed = _collapsedCategoryIds.has(g.key);
    var isFirstRealCategory = g.isRealCategory && idx === 0;
    var isLastRealCategory = g.isRealCategory && (idx === groups.length - 2 || !groups[idx + 1].isRealCategory);
    var headerControlsHTML = g.isRealCategory
      ? '<input type="text" class="kf-portfolio-planner-category-name-input" data-action="rename-category" value="' + escapeHTML(g.label) + '" maxlength="100" aria-label="Category name">' +
        '<button type="button" class="kf-btn kf-btn-ghost kf-btn-sm" data-action="move-category-up"' + (isFirstRealCategory ? ' disabled' : '') + ' title="Move up">&uarr;</button>' +
        '<button type="button" class="kf-btn kf-btn-ghost kf-btn-sm" data-action="move-category-down"' + (isLastRealCategory ? ' disabled' : '') + ' title="Move down">&darr;</button>' +
        '<button type="button" class="kf-btn kf-btn-ghost kf-btn-sm" data-action="delete-category" title="Delete category">Delete</button>'
      : '<span class="kf-portfolio-planner-category-name">' + escapeHTML(g.label) + '</span>';

    var rowsHTML = g.projects.length === 0
      ? '<div class="kf-health-empty">No projects in this category yet.</div>'
      : g.projects.map(renderPortfolioPlannerProjectRow).join('');

    return '<div class="kf-portfolio-planner-group" data-category-id="' + g.key + '">' +
      '<div class="kf-portfolio-planner-group-header">' +
        '<button type="button" class="kf-btn kf-btn-ghost kf-btn-sm kf-portfolio-planner-collapse-btn' + (collapsed ? ' kf-portfolio-planner-collapsed' : '') + '" data-action="toggle-collapse" title="Collapse/expand">' + iconSvg('chevronDown', 14) + '</button>' +
        headerControlsHTML +
        '<span class="kf-portfolio-planner-group-count">' + g.projects.length + ' project' + (g.projects.length === 1 ? '' : 's') + '</span>' +
        '<span class="kf-portfolio-planner-group-spacer"></span>' +
        '<button type="button" class="kf-btn kf-btn-secondary kf-btn-sm" data-action="add-project" title="Add project">' + iconSvg('plus', 14) + 'Add project</button>' +
      '</div>' +
      '<div class="kf-portfolio-planner-group-body' + (collapsed ? ' hidden' : '') + '">' + rowsHTML + '</div>' +
    '</div>';
  }).join('');
}

function renderPortfolioPlannerProjectRow(p){
  var hasDates = !!(p.startDate && p.endDate);
  var categoryOptionsHTML = '<option value="">Uncategorised</option>' + _categories.slice()
    .sort(function(a, b){ return a.sortOrder - b.sortOrder; })
    .map(function(c){ return '<option value="' + c.id + '"' + (p.categoryId === c.id ? ' selected' : '') + '>' + escapeHTML(c.name) + '</option>'; })
    .join('');

  var activateHTML = p.isActive
    ? '<span class="kf-portfolio-planner-active-label">Active</span>'
    : '<button type="button" class="kf-btn kf-btn-secondary kf-btn-sm" data-action="activate"' +
        (hasDates ? '' : ' disabled title="Set both a start and end date before activating."') + '>Activate</button>';

  return '<div class="kf-portfolio-planner-project-row" data-project-id="' + p.id + '">' +
    '<span class="kf-dep-key">' + escapeHTML(p.key) + '</span>' +
    '<span class="kf-portfolio-planner-project-name">' + escapeHTML(p.name) + '</span>' +
    (p.isActive ? '' : '<span class="kf-portfolio-planner-inactive-badge">Inactive</span>') +
    '<input type="date" class="kf-portfolio-planner-date-input" data-action="change-start-date" value="' + (p.startDate || '') + '" aria-label="Start date">' +
    '<input type="date" class="kf-portfolio-planner-date-input" data-action="change-end-date" value="' + (p.endDate || '') + '" aria-label="End date">' +
    '<select class="kf-portfolio-planner-category-select" data-action="change-category" aria-label="Category">' + categoryOptionsHTML + '</select>' +
    '<button type="button" class="kf-btn kf-btn-secondary kf-btn-sm" data-action="edit-resources" title="Placeholder resourcing">Resources</button>' +
    activateHTML +
  '</div>';
}

export function onPortfolioPlannerNewCategoryFromInput(){
  var input = document.getElementById('portfolioPlannerNewCategoryInput');
  var name = input.value.trim();
  if(!name){ toast('Please enter a category name.'); return; }
  portfolioApi.createCategory(name).then(function(category){
    _categories.push(category);
    input.value = '';
    renderPortfolioPlannerGroups();
    renderPortfolioPlannerCategoryFilterChips();
    renderPortfolioPlannerChart();
  }, function(){
    toast('Could not create category.');
  });
}

export function onPortfolioPlannerGroupsClick(e){
  var actionEl = e.target.closest ? e.target.closest('[data-action]') : null;
  if(!actionEl) return;
  var action = actionEl.getAttribute('data-action');
  var groupEl = e.target.closest('[data-category-id]');
  var categoryId = groupEl ? (groupEl.getAttribute('data-category-id') || null) : null;
  var rowEl = e.target.closest('[data-project-id]');
  var projectId = rowEl ? rowEl.getAttribute('data-project-id') : null;

  if(action === 'toggle-collapse'){
    // Scoped to the Categories list only — see the doc comment on expandAllPortfolioPlannerCategories
    // for why the chart is never re-rendered here.
    var key = groupEl.getAttribute('data-category-id');
    if(_collapsedCategoryIds.has(key)) _collapsedCategoryIds.delete(key);
    else _collapsedCategoryIds.add(key);
    renderPortfolioPlannerGroups();
  } else if(action === 'move-category-up'){
    moveCategory(categoryId, -1);
  } else if(action === 'move-category-down'){
    moveCategory(categoryId, 1);
  } else if(action === 'delete-category'){
    var category = _categories.filter(function(c){ return c.id === categoryId; })[0];
    if(!category) return;
    confirmDialog('Delete "' + category.name + '"?', 'Projects in this category will become Uncategorised — they will not be deleted.', function(){
      portfolioApi.deleteCategory(categoryId).then(function(){
        _categories = _categories.filter(function(c){ return c.id !== categoryId; });
        _allProjects = _allProjects.map(function(p){ return p.categoryId === categoryId ? Object.assign({}, p, {categoryId: null}) : p; });
        _plannerActiveCategories.delete(categoryId);
        renderPortfolioPlannerGroups();
        renderPortfolioPlannerCategoryFilterChips();
        renderPortfolioPlannerChart();
      }, function(){
        toast('Could not delete category.');
      });
    });
  } else if(action === 'add-project'){
    openPortfolioPlannerAddProjectModal(categoryId);
  } else if(action === 'edit-resources'){
    openPortfolioPlannerResourcesModal(projectId);
  } else if(action === 'activate'){
    portfolioApi.updateProjectActive(projectId, true).then(function(){
      _allProjects = _allProjects.map(function(p){ return p.id === projectId ? Object.assign({}, p, {isActive: true}) : p; });
      renderPortfolioPlannerGroups();
      renderPortfolioPlannerChart();
    }, function(err){
      toast((err && err.message) || 'Could not activate project.');
    });
  }
}

function moveCategory(categoryId, direction){
  var sorted = _categories.slice().sort(function(a, b){ return a.sortOrder - b.sortOrder; });
  var idx = sorted.map(function(c){ return c.id; }).indexOf(categoryId);
  var swapIdx = idx + direction;
  if(idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;

  var a = sorted[idx], b = sorted[swapIdx];
  var aSortOrder = a.sortOrder, bSortOrder = b.sortOrder;
  Promise.all([
    portfolioApi.updateCategorySortOrder(a.id, bSortOrder),
    portfolioApi.updateCategorySortOrder(b.id, aSortOrder)
  ]).then(function(){
    _categories = _categories.map(function(c){
      if(c.id === a.id) return Object.assign({}, c, {sortOrder: bSortOrder});
      if(c.id === b.id) return Object.assign({}, c, {sortOrder: aSortOrder});
      return c;
    });
    renderPortfolioPlannerGroups();
    renderPortfolioPlannerCategoryFilterChips();
    renderPortfolioPlannerChart();
  }, function(){
    toast('Could not reorder categories.');
  });
}

export function onPortfolioPlannerGroupsChange(e){
  var renameInput = e.target.closest ? e.target.closest('input[data-action="rename-category"]') : null;
  if(renameInput){
    var groupEl = renameInput.closest('[data-category-id]');
    var categoryId = groupEl.getAttribute('data-category-id');
    var newName = renameInput.value.trim();
    if(!newName){ renderPortfolioPlannerGroups(); return; }
    portfolioApi.updateCategory(categoryId, newName).then(function(updated){
      _categories = _categories.map(function(c){ return c.id === categoryId ? Object.assign({}, c, {name: updated.name}) : c; });
      renderPortfolioPlannerGroups();
      renderPortfolioPlannerCategoryFilterChips();
      renderPortfolioPlannerChart();
    }, function(){
      toast('Could not rename category.');
      renderPortfolioPlannerGroups();
    });
    return;
  }

  var categorySelect = e.target.closest ? e.target.closest('select[data-action="change-category"]') : null;
  if(categorySelect){
    var rowEl = categorySelect.closest('[data-project-id]');
    var projectId = rowEl.getAttribute('data-project-id');
    var newCategoryId = categorySelect.value || null;
    portfolioApi.updateProjectCategory(projectId, newCategoryId).then(function(){
      _allProjects = _allProjects.map(function(p){ return p.id === projectId ? Object.assign({}, p, {categoryId: newCategoryId}) : p; });
      renderPortfolioPlannerGroups();
      renderPortfolioPlannerChart();
    }, function(){
      toast('Could not update project category.');
      renderPortfolioPlannerGroups();
    });
    return;
  }

  var dateInput = e.target.closest ? e.target.closest('input.kf-portfolio-planner-date-input') : null;
  if(dateInput){
    var dateRowEl = dateInput.closest('[data-project-id]');
    var dateProjectId = dateRowEl.getAttribute('data-project-id');
    var startVal = dateRowEl.querySelector('[data-action="change-start-date"]').value || null;
    var endVal = dateRowEl.querySelector('[data-action="change-end-date"]').value || null;
    if(startVal && endVal && endVal < startVal){
      toast('End date cannot be before the start date.');
      renderPortfolioPlannerGroups();
      return;
    }
    applyProjectDatesUpdate(dateProjectId, startVal, endVal);
  }
}

function applyProjectDatesUpdate(projectId, startVal, endVal){
  portfolioApi.updateProjectDates(projectId, startVal, endVal).then(function(){
    _allProjects = _allProjects.map(function(p){ return p.id === projectId ? Object.assign({}, p, {startDate: startVal, endDate: endVal}) : p; });
    renderPortfolioPlannerGroups();
    renderPortfolioPlannerChart();
  }, function(){
    toast('Could not update project dates.');
    renderPortfolioPlannerGroups();
  });
}

/* =========================================================
   PROJECT DATES MODAL — click-to-edit counterpart to the chart's drag gestures, same interaction
   model as the Portfolio Dashboard's own equivalent (openPortfolioProjectDatesModal in
   portfolio-dashboard.js) but operating on this module's own _allProjects and its own overlay/ids,
   since the two overlays can be open independently of each other.
   ========================================================= */
var _projectDatesModalProjectId = null;

export function openPortfolioPlannerProjectDatesModal(projectId){
  var project = _allProjects.filter(function(p){ return p.id === projectId; })[0];
  if(!project) return;
  _projectDatesModalProjectId = projectId;
  document.getElementById('portfolioPlannerProjectDatesTitle').textContent = project.name;
  document.getElementById('portfolioPlannerProjectDatesStartInput').value = project.startDate || '';
  document.getElementById('portfolioPlannerProjectDatesEndInput').value = project.endDate || '';
  document.getElementById('portfolioPlannerProjectDatesOverlay').classList.remove('hidden');
}
export function closePortfolioPlannerProjectDatesModal(){
  document.getElementById('portfolioPlannerProjectDatesOverlay').classList.add('hidden');
  _projectDatesModalProjectId = null;
}
export function isPortfolioPlannerProjectDatesModalOpen(){
  return !document.getElementById('portfolioPlannerProjectDatesOverlay').classList.contains('hidden');
}
export function clearPortfolioPlannerProjectDatesInModal(){
  document.getElementById('portfolioPlannerProjectDatesStartInput').value = '';
  document.getElementById('portfolioPlannerProjectDatesEndInput').value = '';
}
export function savePortfolioPlannerProjectDatesFromModal(){
  if(!_projectDatesModalProjectId) return;
  var startVal = document.getElementById('portfolioPlannerProjectDatesStartInput').value || null;
  var endVal = document.getElementById('portfolioPlannerProjectDatesEndInput').value || null;
  if(startVal && endVal && endVal < startVal){
    toast('End date cannot be before the start date.');
    return;
  }
  var projectId = _projectDatesModalProjectId;
  portfolioApi.updateProjectDates(projectId, startVal, endVal).then(function(){
    _allProjects = _allProjects.map(function(p){ return p.id === projectId ? Object.assign({}, p, {startDate: startVal, endDate: endVal}) : p; });
    closePortfolioPlannerProjectDatesModal();
    renderPortfolioPlannerGroups();
    renderPortfolioPlannerChart();
  }, function(){
    toast('Could not update project dates.');
  });
}

/* =========================================================
   ADD PROJECT MODAL
   ========================================================= */
export function openPortfolioPlannerAddProjectModal(categoryId){
  _addProjectCategoryId = categoryId || null;
  document.getElementById('portfolioPlannerAddProjectNameInput').value = '';
  document.getElementById('portfolioPlannerAddProjectKeyInput').value = '';
  document.getElementById('portfolioPlannerAddProjectStartInput').value = '';
  document.getElementById('portfolioPlannerAddProjectEndInput').value = '';
  var prioritySelect = document.getElementById('portfolioPlannerAddProjectPrioritySelect');
  prioritySelect.innerHTML = PRIORITY_ORDER.map(function(key){
    return '<option value="' + key + '"' + (key === 'medium' ? ' selected' : '') + '>' + escapeHTML(PRIORITY_META[key].label) + '</option>';
  }).join('');
  document.getElementById('portfolioPlannerAddProjectOverlay').classList.remove('hidden');
  document.getElementById('portfolioPlannerAddProjectNameInput').focus();
}
export function closePortfolioPlannerAddProjectModal(){
  document.getElementById('portfolioPlannerAddProjectOverlay').classList.add('hidden');
  _addProjectCategoryId = null;
}
export function isPortfolioPlannerAddProjectModalOpen(){
  return !document.getElementById('portfolioPlannerAddProjectOverlay').classList.contains('hidden');
}
export function savePortfolioPlannerAddProjectFromModal(){
  var name = document.getElementById('portfolioPlannerAddProjectNameInput').value.trim();
  if(!name){ toast('Please enter a name.'); return; }
  var key = document.getElementById('portfolioPlannerAddProjectKeyInput').value.trim();
  var priority = document.getElementById('portfolioPlannerAddProjectPrioritySelect').value;
  var startVal = document.getElementById('portfolioPlannerAddProjectStartInput').value || null;
  var endVal = document.getElementById('portfolioPlannerAddProjectEndInput').value || null;
  if(startVal && endVal && endVal < startVal){
    toast('End date cannot be before the start date.');
    return;
  }

  portfolioApi.createProject(name, priority, _addProjectCategoryId, startVal, endVal, key).then(function(project){
    _allProjects.push(project);
    closePortfolioPlannerAddProjectModal();
    renderPortfolioPlannerGroups();
    renderPortfolioPlannerChart();
  }, function(err){
    toast((err && err.message) || 'Could not create project.');
  });
}

/* =========================================================
   RESOURCES MODAL — placeholder role + optional real person + % resourcing for one project, so an
   Org Admin can rough out staffing (and report on unfilled roles / over-allocated people, see the
   Portfolio Dashboard's Resourcing section) before a project has any real ProjectMembers. A row with
   no person is an unfilled role; a row with a person counts toward that person's total workload
   alongside their real ProjectMember.AllocatedFraction elsewhere. Every field change persists to the
   server immediately (Add / edit-in-place / Remove), same as the Team modal's own member rows —
   there's no "stage several rows, batch-save" convention anywhere else in this codebase to follow
   instead. Role is free-text, offered as suggestions (via the org's existing ProjectMember.Role
   vocabulary) rather than a strict picklist, same UX as the Team modal's own role input.
   ========================================================= */
var _resourcesModalProjectId = null;
var _resourcesList = [];
var _orgRoles = [];
var _orgUsers = [];

export function openPortfolioPlannerResourcesModal(projectId){
  var project = _allProjects.filter(function(p){ return p.id === projectId; })[0];
  if(!project) return;
  _resourcesModalProjectId = projectId;
  document.getElementById('portfolioPlannerResourcesTitle').textContent = project.name + ' — Resources';
  document.getElementById('portfolioPlannerResourcesList').innerHTML = '<div class="kf-health-empty">Loading…</div>';
  document.getElementById('portfolioPlannerResourceRoleInput').value = '';
  document.getElementById('portfolioPlannerResourceAllocatedInput').value = '100';
  document.getElementById('portfolioPlannerResourcePersonSelect').innerHTML = '<option value="">Unassigned</option>';
  document.getElementById('portfolioPlannerResourcesOverlay').classList.remove('hidden');

  Promise.all([portfolioApi.listResources(projectId), portfolioApi.listRoles(), getMyOrganisationApi()]).then(function(results){
    if(_resourcesModalProjectId !== projectId) return; // closed/switched before this resolved
    _resourcesList = results[0] || [];
    _orgRoles = results[1] || [];
    // Deactivated accounts are never offered as a placeholder assignee.
    _orgUsers = (results[2] && results[2].users || []).filter(function(u){ return u.isActive !== false; })
      .sort(function(a, b){ return a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'}); });
    populatePersonSelectOptions(document.getElementById('portfolioPlannerResourcePersonSelect'));
    renderPortfolioPlannerResourcesList();
  }, function(){
    document.getElementById('portfolioPlannerResourcesList').innerHTML = '<div class="kf-health-empty">Could not load resources.</div>';
  });
}
export function closePortfolioPlannerResourcesModal(){
  document.getElementById('portfolioPlannerResourcesOverlay').classList.add('hidden');
  _resourcesModalProjectId = null;
  _resourcesList = [];
}
export function isPortfolioPlannerResourcesModalOpen(){
  return !document.getElementById('portfolioPlannerResourcesOverlay').classList.contains('hidden');
}

function populatePersonSelectOptions(selectEl, selectedUserId){
  selectEl.innerHTML = '<option value="">Unassigned</option>' + _orgUsers.map(function(u){
    return '<option value="' + u.id + '"' + (selectedUserId === u.id ? ' selected' : '') + '>' + escapeHTML(u.displayName) + '</option>';
  }).join('');
}

function renderPortfolioPlannerResourcesList(){
  populateVocabularyDatalist('portfolioPlannerResourceRoleOptions', _orgRoles);
  var listEl = document.getElementById('portfolioPlannerResourcesList');
  if(_resourcesList.length === 0){
    listEl.innerHTML = '<div class="kf-member-empty">No resources added yet.</div>';
    return;
  }
  listEl.innerHTML = _resourcesList.map(function(r){
    return '<div class="kf-member-row" data-resource-id="' + r.id + '">' +
      '<input type="text" class="kf-member-role-input kf-portfolio-planner-resource-role-input" value="' + escapeHTML(r.role) + '" maxlength="100" list="portfolioPlannerResourceRoleOptions" placeholder="Role" aria-label="Role">' +
      '<select class="kf-portfolio-planner-resource-person-select" aria-label="Assigned person"></select>' +
      '<input type="number" class="kf-member-allocated-fraction-input" min="0" max="100" step="1" value="' + r.allocatedFraction + '" placeholder="%" aria-label="Allocated fraction">' +
      '<button class="kf-btn kf-btn-ghost" data-action="remove-resource" title="Remove resource">' + iconSvg('trash', 14) + '</button>' +
    '</div>';
  }).join('');
  // <select> options can't be expressed as a plain HTML string attribute the way a text input's
  // value can — each row's person select is populated as a DOM operation right after the innerHTML
  // assignment above, same two-step reason escapeHTML+selected wouldn't otherwise compose cleanly.
  _resourcesList.forEach(function(r){
    var rowEl = listEl.querySelector('[data-resource-id="' + r.id + '"]');
    if(rowEl) populatePersonSelectOptions(rowEl.querySelector('.kf-portfolio-planner-resource-person-select'), r.userId || null);
  });
}

// Local copy of modals/team.js's populateVocabularyDatalist — kept independent rather than imported
// to avoid a cross-modal coupling for one tiny DOM helper (this module already stands alone from
// team.js entirely otherwise).
function populateVocabularyDatalist(datalistId, values){
  var list = document.getElementById(datalistId);
  list.innerHTML = '';
  (values || []).slice().sort(function(a, b){ return a.localeCompare(b, undefined, {sensitivity:'base'}); }).forEach(function(name){
    var opt = document.createElement('option');
    opt.value = name;
    list.appendChild(opt);
  });
}

export function addPortfolioPlannerResourceFromModal(){
  if(!_resourcesModalProjectId) return;
  var roleInput = document.getElementById('portfolioPlannerResourceRoleInput');
  var personSelect = document.getElementById('portfolioPlannerResourcePersonSelect');
  var allocatedInput = document.getElementById('portfolioPlannerResourceAllocatedInput');
  var role = roleInput.value.trim();
  if(!role){ toast('Please enter a role.'); return; }
  var allocatedFraction = Math.round(Number(allocatedInput.value));
  if(!isFinite(allocatedFraction)) allocatedFraction = 0;
  allocatedFraction = Math.max(0, Math.min(100, allocatedFraction));

  var projectId = _resourcesModalProjectId;
  portfolioApi.addResource(projectId, role, personSelect.value || null, allocatedFraction).then(function(resource){
    if(_resourcesModalProjectId !== projectId) return;
    _resourcesList.push(resource);
    roleInput.value = '';
    personSelect.value = '';
    allocatedInput.value = '100';
    renderPortfolioPlannerResourcesList();
    roleInput.focus();
  }, function(err){
    toast((err && err.message) || 'Could not add resource.');
  });
}

export function onPortfolioPlannerResourcesListClick(e){
  var actionEl = e.target.closest ? e.target.closest('[data-action="remove-resource"]') : null;
  if(!actionEl || !_resourcesModalProjectId) return;
  var rowEl = actionEl.closest('[data-resource-id]');
  var resourceId = rowEl.getAttribute('data-resource-id');
  var projectId = _resourcesModalProjectId;
  portfolioApi.removeResource(projectId, resourceId).then(function(){
    if(_resourcesModalProjectId !== projectId) return;
    _resourcesList = _resourcesList.filter(function(r){ return r.id !== resourceId; });
    renderPortfolioPlannerResourcesList();
  }, function(){
    toast('Could not remove resource.');
  });
}

// Editing any of an existing row's three fields saves all three together (role/person/allocation) —
// UpdateProjectResourcePlaceholderRequest has no notion of "only this one field changed", same shape
// modals/team.js's buildServerMemberBody uses for the analogous reason.
export function onPortfolioPlannerResourcesListChange(e){
  var rowEl = e.target.closest ? e.target.closest('[data-resource-id]') : null;
  if(!rowEl || !_resourcesModalProjectId) return;
  var resourceId = rowEl.getAttribute('data-resource-id');
  var resource = _resourcesList.filter(function(r){ return r.id === resourceId; })[0];
  if(!resource) return;

  var role = rowEl.querySelector('.kf-portfolio-planner-resource-role-input').value.trim() || 'Unspecified';
  var userId = rowEl.querySelector('.kf-portfolio-planner-resource-person-select').value || null;
  var allocatedFraction = Math.round(Number(rowEl.querySelector('.kf-member-allocated-fraction-input').value));
  if(!isFinite(allocatedFraction)) allocatedFraction = 0;
  allocatedFraction = Math.max(0, Math.min(100, allocatedFraction));

  var projectId = _resourcesModalProjectId;
  portfolioApi.updateResource(projectId, resourceId, role, userId, allocatedFraction).then(function(updated){
    if(_resourcesModalProjectId !== projectId) return;
    _resourcesList = _resourcesList.map(function(r){ return r.id === resourceId ? updated : r; });
    renderPortfolioPlannerResourcesList();
  }, function(err){
    toast((err && err.message) || 'Could not update resource.');
    renderPortfolioPlannerResourcesList();
  });
}

/* =========================================================
   TIMELINE CHART — a single Gantt chart spanning every project, banded into swimlanes (one per
   category, in the same order as the category groups above, plus a trailing Uncategorised band).
   Reuses the exact same buildTimelineColumns/tlDateToPixel/tlPixelToDate + projectBarSVG the
   Portfolio Dashboard's own Timeline chart uses, so drag-to-reschedule behaves identically here.
   Unlike the Dashboard, an undated/click-only bar has no click-to-edit modal in the Planner — dates
   are set via each project row's own date inputs above instead, so a plain (non-dragging) click on
   a bar here is simply a no-op.
   ========================================================= */
function renderPortfolioPlannerControls(){
  document.getElementById('portfolioPlannerScaleSelect').value = _plannerState.granularity;
  if(_plannerState.start) document.getElementById('portfolioPlannerStartInput').value = toServerDateOnly(_plannerState.start);
  if(_plannerState.end) document.getElementById('portfolioPlannerEndInput').value = toServerDateOnly(_plannerState.end);
}
export function onPortfolioPlannerControlsChanged(){
  var scaleSelect = document.getElementById('portfolioPlannerScaleSelect');
  var startInput = document.getElementById('portfolioPlannerStartInput');
  var endInput = document.getElementById('portfolioPlannerEndInput');
  _plannerState.granularity = scaleSelect.value;
  if(startInput.value) _plannerState.start = new Date(startInput.value + 'T00:00:00');
  if(endInput.value) _plannerState.end = new Date(endInput.value + 'T00:00:00');
  renderPortfolioPlannerChart();
}

/* "Fit to projects": 3 months before the earliest scheduled project's start and 3 months after the
   latest scheduled project's end. Only projects with BOTH dates set contribute a bound — an
   unscheduled project (active or inactive) has no date to contribute in the first place, so this
   naturally excludes unscheduled inactive projects (and every other unscheduled project) without
   needing an isActive check of its own. */
export function onPortfolioPlannerFitToProjectsClick(){
  var datedProjects = _allProjects.filter(function(p){ return p.startDate && p.endDate; });
  if(datedProjects.length === 0){
    toast('No scheduled projects to fit the timeline to.');
    return;
  }
  var minStart = new Date(Math.min.apply(null, datedProjects.map(function(p){ return new Date(p.startDate).getTime(); })));
  var maxEnd = new Date(Math.max.apply(null, datedProjects.map(function(p){ return new Date(p.endDate).getTime(); })));
  minStart.setMonth(minStart.getMonth() - 3);
  maxEnd.setMonth(maxEnd.getMonth() + 3);
  _plannerState.start = minStart;
  _plannerState.end = maxEnd;
  renderPortfolioPlannerControls();
  renderPortfolioPlannerChart();
}

function renderPortfolioPlannerChart(){
  var chartEl = document.getElementById('portfolioPlannerChart');
  var noDataEl = document.getElementById('portfolioPlannerNoData');
  if(!_plannerState.start || !_plannerState.end || _allProjects.length === 0){
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = _allProjects.length === 0
      ? 'No projects exist in this organisation yet. Use "Add project" above to sketch one out.'
      : 'Set a start and end date above to plot the timeline.';
    _plannerLayout = null;
    return;
  }
  noDataEl.classList.add('hidden');

  var nameColWidth = 160, rowHeight = 32, bandHeaderHeight = 22, marginTop = 40;
  var trackWidth = Math.max(600, (chartEl.clientWidth || 800) - nameColWidth - 40);
  var columns = buildTimelineColumns(_plannerState.start, _plannerState.end, _plannerState.granularity, 70);
  var totalTrackWidth = columns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var scale = totalTrackWidth > 0 ? Math.max(trackWidth / totalTrackWidth, 0.3) : 1;
  var scaledColumns = columns.map(function(c){ return {start: c.start, end: c.end, label: c.label, width: c.width * scale}; });
  var scaledTrackWidth = scaledColumns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var width = nameColWidth + scaledTrackWidth + 20;

  // Collapse state never affects the chart — it's a visualization of the whole portfolio, not the
  // Categories management panel above, so every band always renders its full row set here regardless
  // of whether that category happens to be collapsed in the list. The priority and category filters,
  // unlike collapse state, DO apply here (and only here, not the Categories panel) — an empty Set
  // means no filter, same convention as the Board's chips. Category filtering drops whole non-matching
  // bands first; priority filtering then thins the projects within whatever bands remain.
  var groups = groupProjectsByCategory();
  if(_plannerActiveCategories.size > 0){
    groups = groups.filter(function(g){ return _plannerActiveCategories.has(g.key); });
  }
  if(_plannerActivePriorities.size > 0){
    groups = groups.map(function(g){
      return {key: g.key, label: g.label, isRealCategory: g.isRealCategory, projects: g.projects.filter(function(p){ return _plannerActivePriorities.has(p.priority); })};
    });
  }
  var y = marginTop;
  var bandBounds = groups.map(function(g){
    var bandStart = y;
    y += bandHeaderHeight;
    y += Math.max(g.projects.length, 1) * rowHeight;
    return {start: bandStart, end: y};
  });
  var height = y + 10;

  _plannerLayout = {nameColWidth: nameColWidth, scaledColumns: scaledColumns, scaledTrackWidth: scaledTrackWidth};

  var defsHTML = noDatesPatternDefsSVG();

  var headerHTML = '';
  var x = nameColWidth;
  scaledColumns.forEach(function(c){
    headerHTML += '<text x="' + (x + c.width / 2) + '" y="' + (marginTop - 12) + '" font-size="10" font-weight="600" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(c.label) + '</text>' +
      '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';
    x += c.width;
  });
  headerHTML += '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';

  var bandsHTML = groups.map(function(g, gi){
    var b = bandBounds[gi];
    return '<rect x="0" y="' + b.start + '" width="' + width + '" height="' + (b.end - b.start) + '" fill="' + (gi % 2 === 0 ? 'var(--kf-column-bg)' : 'transparent') + '" opacity="0.5"></rect>';
  }).join('');

  // Swimlane dividers: one dotted horizontal line above and below every project row, in the same
  // style as the vertical calendar-division lines above, so each project's lane is visually bracketed.
  var rowLinesHTML = groups.map(function(g, gi){
    var b = bandBounds[gi];
    var rowCount = Math.max(g.projects.length, 1);
    var lines = '';
    for(var pi = 0; pi <= rowCount; pi++){
      var lineY = b.start + bandHeaderHeight + pi * rowHeight;
      lines += '<line x1="0" y1="' + lineY + '" x2="' + width + '" y2="' + lineY + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';
    }
    return lines;
  }).join('');

  // Font-size/weight match the Category section above exactly — .kf-portfolio-planner-category-name
  // (13px/600) for a band's label, .kf-portfolio-planner-project-name (13px/400, no bold) for a
  // project's — so labels read as one consistent system rather than a smaller/bolder chart-only style.
  var rowsHTML = groups.map(function(g, gi){
    var b = bandBounds[gi];
    var labelHTML = '<text x="8" y="' + (b.start + 16) + '" font-size="13" font-weight="600" fill="var(--kf-text)">' + escapeHTML(g.label) + '</text>';
    if(g.projects.length === 0){
      return labelHTML + '<text x="8" y="' + (b.start + bandHeaderHeight + rowHeight / 2 + 4) + '" font-size="11" fill="var(--kf-text-secondary)">No projects</text>';
    }
    return labelHTML + g.projects.map(function(p, pi){
      var rowY = b.start + bandHeaderHeight + pi * rowHeight;
      var barY = rowY + 6, barHeight = rowHeight - 14;
      var nameHTML = '<text x="8" y="' + (rowY + rowHeight / 2 + 4) + '" font-size="13" font-weight="400" fill="var(--kf-text)">' + escapeHTML(p.key) + '</text>';
      if(!p.startDate || !p.endDate){
        return nameHTML + projectBarSVG(p, nameColWidth, barY, scaledTrackWidth, barHeight, null, PLANNER_HANDLE_WIDTH, true);
      }
      var barStartX = nameColWidth + tlDateToPixel(new Date(p.startDate), scaledColumns);
      var barEndX = nameColWidth + tlDateToPixel(new Date(p.endDate), scaledColumns);
      var barWidth = Math.max(4, barEndX - barStartX);
      return nameHTML + projectBarSVG(p, barStartX, barY, barWidth, barHeight, null, PLANNER_HANDLE_WIDTH, true);
    }).join('');
  }).join('');

  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="kf-portfolio-planner-svg">' + defsHTML + bandsHTML + rowLinesHTML + headerHTML + rowsHTML + '</svg>';
}

export function onPortfolioPlannerBarPointerDown(e){
  var target = e.target.closest ? e.target.closest('[data-project-id]') : null;
  if(!target || !_plannerLayout) return;
  var projectId = target.getAttribute('data-project-id');
  var role = target.getAttribute('data-role');
  var project = _allProjects.filter(function(p){ return p.id === projectId; })[0];
  if(!project) return;

  // "no dates" placeholder bars have nothing to drag from — same as the Dashboard's chart, clicking
  // one opens the dates modal (delayed — see scheduleBarSingleClick — so a double-click can still
  // cancel this and open Resources instead).
  if(role === 'click-only'){
    scheduleBarSingleClick(projectId);
    return;
  }

  var svgEl = document.querySelector('#portfolioPlannerChart svg');
  if(!svgEl) return;
  e.preventDefault();

  var barEl = svgEl.querySelector('.kf-portfolio-timeline-bar[data-project-id="' + cssEscape(projectId) + '"]');
  var startHandleEl = svgEl.querySelector('.kf-portfolio-timeline-handle[data-project-id="' + cssEscape(projectId) + '"][data-role="resize-start"]');
  var endHandleEl = svgEl.querySelector('.kf-portfolio-timeline-handle[data-project-id="' + cssEscape(projectId) + '"][data-role="resize-end"]');
  if(!barEl || !startHandleEl || !endHandleEl) return;

  var vb = svgEl.viewBox.baseVal;
  var rect = svgEl.getBoundingClientRect();
  var scaleRatio = rect.width > 0 ? vb.width / rect.width : 1;

  var layout = _plannerLayout;
  var barStartX = layout.nameColWidth + tlDateToPixel(new Date(project.startDate), layout.scaledColumns);
  var barEndX = layout.nameColWidth + tlDateToPixel(new Date(project.endDate), layout.scaledColumns);

  _plannerDrag = {
    projectId: projectId, role: role, scaleRatio: scaleRatio,
    pointerStartClientX: e.clientX, moved: false,
    origBarStartX: barStartX, origBarEndX: barEndX,
    liveBarStartX: barStartX, liveBarEndX: barEndX,
    barEl: barEl, startHandleEl: startHandleEl, endHandleEl: endHandleEl,
    handleWidth: PLANNER_HANDLE_WIDTH
  };
  document.addEventListener('mousemove', onPortfolioPlannerDragMove);
  document.addEventListener('mouseup', onPortfolioPlannerDragEnd);
}

function onPortfolioPlannerDragMove(e){
  if(!_plannerDrag || !_plannerLayout) return;
  var d = _plannerDrag;
  var deltaXClient = e.clientX - d.pointerStartClientX;
  if(Math.abs(deltaXClient) >= PLANNER_DRAG_CLICK_THRESHOLD) d.moved = true;
  var deltaX = deltaXClient * d.scaleRatio;

  var layout = _plannerLayout;
  var minBarWidth = 8;
  var chartMinX = layout.nameColWidth;
  var chartMaxX = layout.nameColWidth + layout.scaledTrackWidth;
  var newStartX = d.origBarStartX, newEndX = d.origBarEndX;

  if(d.role === 'move'){
    var span = d.origBarEndX - d.origBarStartX;
    newStartX = d.origBarStartX + deltaX;
    newEndX = d.origBarEndX + deltaX;
    if(newStartX < chartMinX){ newStartX = chartMinX; newEndX = newStartX + span; }
    if(newEndX > chartMaxX){ newEndX = chartMaxX; newStartX = newEndX - span; }
  } else if(d.role === 'resize-start'){
    newStartX = d.origBarStartX + deltaX;
    if(newStartX < chartMinX) newStartX = chartMinX;
    if(newStartX > d.origBarEndX - minBarWidth) newStartX = d.origBarEndX - minBarWidth;
  } else if(d.role === 'resize-end'){
    newEndX = d.origBarEndX + deltaX;
    if(newEndX > chartMaxX) newEndX = chartMaxX;
    if(newEndX < d.origBarStartX + minBarWidth) newEndX = d.origBarStartX + minBarWidth;
  }

  d.liveBarStartX = newStartX;
  d.liveBarEndX = newEndX;
  d.barEl.setAttribute('x', newStartX);
  d.barEl.setAttribute('width', Math.max(1, newEndX - newStartX));
  d.startHandleEl.setAttribute('x', newStartX - d.handleWidth / 2);
  d.endHandleEl.setAttribute('x', newEndX - d.handleWidth / 2);
}

function onPortfolioPlannerDragEnd(){
  if(!_plannerDrag) return;
  var d = _plannerDrag;
  document.removeEventListener('mousemove', onPortfolioPlannerDragMove);
  document.removeEventListener('mouseup', onPortfolioPlannerDragEnd);
  _plannerDrag = null;

  if(!d.moved){
    scheduleBarSingleClick(d.projectId);
    return;
  }

  var layout = _plannerLayout;
  var newStartDate = tlPixelToDate(d.liveBarStartX - layout.nameColWidth, layout.scaledColumns);
  var newEndDate = tlPixelToDate(d.liveBarEndX - layout.nameColWidth, layout.scaledColumns);
  var startVal = toServerDateOnly(newStartDate);
  var endVal = toServerDateOnly(newEndDate);

  applyProjectDatesUpdate(d.projectId, startVal, endVal);
}

// Delays a plain click's "open Dates modal" action just long enough for a genuine double-click's
// second click to arrive and cancel it (see onPortfolioPlannerBarDblClick) — always clears any
// already-pending timer first, so at most one is ever outstanding regardless of how quickly repeat
// clicks land, and a dblclick landing anywhere in that window cleanly cancels exactly the right one.
function scheduleBarSingleClick(projectId){
  if(_plannerClickTimer) clearTimeout(_plannerClickTimer);
  _plannerClickTimer = setTimeout(function(){
    _plannerClickTimer = null;
    openPortfolioPlannerProjectDatesModal(projectId);
  }, PLANNER_CLICK_DELAY_MS);
}

// Double-clicking any project bar (dated or the "no dates" placeholder) opens Resources instead of
// Dates — cancels whichever single-click Dates-modal open is currently pending (native dblclick fires
// after both clicks' own mousedown/mouseup/click cycles, so by this point exactly one such timer is
// always the outstanding one, per scheduleBarSingleClick's own always-clear-first behavior) so the
// Dates modal never flashes open first.
export function onPortfolioPlannerBarDblClick(e){
  var target = e.target.closest ? e.target.closest('[data-project-id]') : null;
  if(!target) return;
  if(_plannerClickTimer){ clearTimeout(_plannerClickTimer); _plannerClickTimer = null; }
  openPortfolioPlannerResourcesModal(target.getAttribute('data-project-id'));
}

/* Minimal fallback for browsers/environments without window.CSS.escape (project ids are GUIDs, so
   in practice only needed for the astronomically unlikely case that ever changes) — same helper as
   portfolio-dashboard.js's own copy. */
function cssEscape(value){
  return (window.CSS && window.CSS.escape) ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
