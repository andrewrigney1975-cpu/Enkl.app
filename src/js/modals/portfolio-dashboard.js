"use strict";
import { toast } from '../ui.js';
import { escapeHTML } from '../views/board.js';
import { memberInitials } from '../date-utils.js';
import { memberLabel } from '../utils.js';
import { getPortfolioSelectedProjectIds, setPortfolioSelectedProjectIds } from '../storage.js';
import { portfolioApi, isOrgAdmin } from '../api.js';
import { computeOverallHealth, computeTopTeamMembers } from '../features/health.js';
import { buildGaugeBlock, startHealthGaugeAnimation, cancelHealthGaugeAnimation } from './health.js';
import { buildRiskMatrixSvg } from '../mutations.js';
import { buildTimelineColumns, tlDateToPixel, tlPixelToDate } from '../views/timeline.js';
import { projectBarSVG, noDatesPatternDefsSVG } from '../portfolio-bars.js';

/* =========================================================
   PORTFOLIO DASHBOARD — Org-Admin-only, cross-project reporting across 1+ of the caller's
   organisation's server-hosted projects. Every figure here comes from portfolioApi, which is gated
   OrgAdmin-only server-side and independently re-validates every requested project id against the
   caller's own organisation (see PortfolioService.cs/.php) — nothing here ever trusts a client-side
   project-id list as authoritative. Selected-project persistence is localStorage-only (per explicit
   product decision), so it's a per-browser convenience, not a security boundary.
   ========================================================= */

// A handful of distinct, CVD-safe categorical colors for "which project did this come from" —
// assigned in a fixed order per selected project (sorted by name), not cycled/randomized, matching
// this app's own categorical-color convention.
var PORTFOLIO_PROJECT_COLORS = ['#0c66e4', '#7f5af0', '#e8590c', '#2f9e44', '#c2255c', '#0b7285', '#f08c00', '#495057'];

var _allProjects = [];
var _selectedProjectIds = [];
var _projectSearchTerm = '';
var _aggregate = null;
var _activity = null;
// Org-wide, independent of _selectedProjectIds/the project picker entirely — see
// PortfolioService.GetResourcingSummaryAsync's doc comment for why (placeholder resources only ever
// exist on inactive projects, which the picker below deliberately excludes). Fetched once when the
// dashboard opens and re-rendered (unchanged) on every renderAll() the same as the summary boxes.
var _resourcingSummary = null;

var _timelineState = {granularity: 'month', start: null, end: null};
var _activityChartState = {granularity: 'week', start: null, end: null};

export function openPortfolioDashboardOverlay(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can open the Portfolio Dashboard.'); return; }
  document.getElementById('portfolioDashboardOverlay').classList.remove('hidden');
  loadPortfolioProjectsAndRender();
}
export function closePortfolioDashboardOverlay(){
  cancelHealthGaugeAnimation();
  closeProjectFilterPanel();
  document.getElementById('portfolioDashboardOverlay').classList.add('hidden');
}
export function isPortfolioDashboardOverlayOpen(){
  return !document.getElementById('portfolioDashboardOverlay').classList.contains('hidden');
}

function loadPortfolioProjectsAndRender(){
  var pickerEl = document.getElementById('portfolioProjectPicker');
  pickerEl.innerHTML = '<div class="kf-health-empty">Loading projects…</div>';
  portfolioApi.listProjects().then(function(projects){
    _allProjects = projects || [];
    // A stale selection (a project deleted since last time, or from a browser/profile that was
    // ever pointed at a different org) is filtered down to whatever still actually exists — never
    // trusted outright, same defensive spirit as normalizeHeaderButtonVisibility.
    var existingIds = _allProjects.map(function(p){ return p.id; });
    _selectedProjectIds = getPortfolioSelectedProjectIds().filter(function(id){ return existingIds.indexOf(id) !== -1; });
    renderProjectPicker();
    renderProjectFilterButtonLabel();
    refreshPortfolioData();
  }, function(){
    pickerEl.innerHTML = '<div class="kf-health-empty">Could not load projects.</div>';
  });

  _resourcingSummary = null;
  renderResourcingSummary();
  portfolioApi.getResourcingSummary().then(function(summary){
    _resourcingSummary = summary;
    renderResourcingSummary();
  }, function(){
    document.getElementById('portfolioUnfilledRoles').innerHTML = '<div class="kf-health-empty">Could not load resourcing data.</div>';
    document.getElementById('portfolioUserAllocations').innerHTML = '';
  });
}

/* Combobox: a button (kf-dropdown-filter-btn) opens a searchable checkbox panel, same shell as the
   board's existing Team/Assignee/Type filter dropdowns (kf-dropdown-filter*, see board.js), sized
   wider (kf-dropdown-filter-panel-wide) since rows here carry a key + full project name rather than
   just a short name — built fresh rather than reusing the board's own picker because an org can have
   far more projects than any one project has team members, which is exactly the "gets long and
   cumbersome" case a plain checkbox list doesn't scale to. */
function renderProjectPicker(){
  var pickerEl = document.getElementById('portfolioProjectPicker');
  var noMatchesEl = document.getElementById('portfolioProjectNoMatches');
  // Inactive (Portfolio-Planner placeholder) projects are never offered in this picker — an admin
  // can still see one on the Timeline if it was selected before going inactive (persisted selection
  // is never filtered against this), but can't newly add one from here.
  var activeProjects = _allProjects.filter(function(p){ return p.isActive !== false; });
  if(activeProjects.length === 0){
    pickerEl.innerHTML = '<div class="kf-health-empty">No projects exist in this organisation yet.</div>';
    noMatchesEl.classList.add('hidden');
    return;
  }
  var term = _projectSearchTerm.trim().toLowerCase();
  var sorted = activeProjects.slice().sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  var filtered = term
    ? sorted.filter(function(p){ return p.name.toLowerCase().indexOf(term) !== -1 || p.key.toLowerCase().indexOf(term) !== -1; })
    : sorted;

  if(filtered.length === 0){
    pickerEl.innerHTML = '';
    noMatchesEl.classList.remove('hidden');
    return;
  }
  noMatchesEl.classList.add('hidden');
  pickerEl.innerHTML = filtered.map(function(p){
    var checked = _selectedProjectIds.indexOf(p.id) !== -1;
    return '<label class="kf-dropdown-filter-row">' +
      '<input type="checkbox" data-project-id="' + p.id + '" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dep-key">' + escapeHTML(p.key) + '</span>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(p.name) + '</span>' +
    '</label>';
  }).join('');
}

function renderProjectFilterButtonLabel(){
  var wrap = document.getElementById('portfolioProjectFilterWrap');
  var label = document.getElementById('portfolioProjectFilterLabel');
  var n = _selectedProjectIds.length;
  if(n === 0){
    label.textContent = 'Select projects';
  } else if(n === 1){
    var only = _allProjects.filter(function(p){ return p.id === _selectedProjectIds[0]; })[0];
    label.textContent = only ? only.name : '1 project selected';
  } else {
    label.textContent = n + ' projects selected';
  }
  wrap.classList.toggle('active', n > 0);
}

/* Delegated (one listener on the panel, wired in app.js) rather than per-row — but updates
   _selectedProjectIds incrementally from the SPECIFIC checkbox that changed, not by re-scanning every
   checkbox currently in the DOM. That distinction matters here specifically because of the search
   filter: a project already selected can be scrolled out of the CURRENT filtered view, and re-deriving
   the whole selection from "checkboxes visible right now" would silently drop it. */
export function onPortfolioProjectSelectionChanged(e){
  var checkbox = e.target.closest ? e.target.closest('input[type=checkbox][data-project-id]') : null;
  if(!checkbox) return;
  var projectId = checkbox.getAttribute('data-project-id');
  if(checkbox.checked){
    if(_selectedProjectIds.indexOf(projectId) === -1) _selectedProjectIds.push(projectId);
  } else {
    _selectedProjectIds = _selectedProjectIds.filter(function(id){ return id !== projectId; });
  }
  setPortfolioSelectedProjectIds(_selectedProjectIds);
  renderProjectFilterButtonLabel();
  refreshPortfolioData();
}

export function onPortfolioProjectSearchInput(e){
  _projectSearchTerm = e.target.value || '';
  renderProjectPicker();
}

export function toggleProjectFilterPanel(){
  var panel = document.getElementById('portfolioProjectFilterPanel');
  var wasHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if(wasHidden){
    var searchInput = document.getElementById('portfolioProjectSearchInput');
    searchInput.focus();
  }
}
export function closeProjectFilterPanel(){
  document.getElementById('portfolioProjectFilterPanel').classList.add('hidden');
}
export function isProjectFilterPanelOpen(){
  return !document.getElementById('portfolioProjectFilterPanel').classList.contains('hidden');
}

function projectColorFor(projectId){
  var sorted = _allProjects.slice().sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  var idx = sorted.map(function(p){ return p.id; }).indexOf(projectId);
  return PORTFOLIO_PROJECT_COLORS[idx >= 0 ? idx % PORTFOLIO_PROJECT_COLORS.length : 0];
}

function refreshPortfolioData(){
  if(_selectedProjectIds.length === 0){
    _aggregate = null;
    _activity = null;
    renderAll();
    return;
  }
  portfolioApi.getAggregate(_selectedProjectIds).then(function(aggregate){
    _aggregate = aggregate;
    // Reporting range defaults to the current calendar year (1-Jan to 31-Dec) the first time data
    // loads for this selection — an admin who changes the selection keeps whatever custom range
    // they'd already set, rather than silently resetting it underneath them.
    if(!_timelineState.start || !_timelineState.end){
      var timelineDefault = defaultYearRange();
      _timelineState.start = timelineDefault.start;
      _timelineState.end = timelineDefault.end;
    }
    if(!_activityChartState.start || !_activityChartState.end){
      var activityDefault = defaultYearRange();
      _activityChartState.start = activityDefault.start;
      _activityChartState.end = activityDefault.end;
    }
    return fetchActivityAndRender();
  }, function(){
    toast('Could not load Portfolio Dashboard data.');
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

function fetchActivityAndRender(){
  return portfolioApi.getActivity(_selectedProjectIds, toServerDateOnly(_activityChartState.start), toServerDateOnly(_activityChartState.end)).then(function(activity){
    _activity = activity;
    renderAll();
  }, function(){
    toast('Could not load Portfolio Dashboard activity data.');
    renderAll();
  });
}

/* =========================================================
   ADAPTER — builds the minimal client-project shape the EXISTING per-project health math
   (computeOverallHealth/computeTopTeamMembers, features/health.js) and buildRiskMatrixSvg
   (mutations.js) already read, from the server's merged PortfolioAggregateDto. This is the one
   place server field names get translated into what those unchanged functions expect — everything
   downstream of this call is the SAME code the per-project Health Dashboard runs.
   ========================================================= */
function buildPortfolioPseudoProject(aggregate){
  var tasks = {};
  (aggregate.tasks || []).forEach(function(t){
    tasks[t.id] = {
      id: t.id, columnId: t.columnId, assigneeId: t.assigneeId || null, archived: !!t.archived,
      releaseId: t.releaseId || null, endDate: t.endDate || null, dateDone: t.dateDone || null,
      businessValue: t.businessValue, taskCost: t.taskCost, progress: t.progress,
      estimatedEffort: t.estimatedEffort, actualEffort: t.actualEffort
    };
  });
  var columns = (aggregate.columns || []).map(function(c){ return {id: c.id, done: c.done}; });
  var members = (aggregate.members || []).map(function(m){
    return {id: m.id, userId: m.userId, name: m.displayName, color: m.color, role: m.role || null, isActive: m.isActive !== false};
  });
  var releases = (aggregate.releases || []).map(function(r){ return {id: r.id, status: r.status, endDate: r.endDate}; });
  var risks = (aggregate.risks || []).map(function(r){
    return {
      id: r.id, key: r.key, title: r.title, likelihood: r.likelihood, impact: r.impact,
      mitigations: r.mitigations, ownerId: r.ownerId, status: r.status,
      dateToClose: r.dateToClose, dateClosed: r.dateClosed,
      projectId: r.projectId, projectKey: r.projectKey
    };
  });
  var decisions = (aggregate.decisions || []).map(function(d){ return {id: d.id, status: d.status, ownerId: d.ownerId}; });

  return {
    tasks: tasks, columns: columns, members: members,
    releases: releases, risks: risks, decisions: decisions,
    startDate: aggregate.startDate || null, endDate: aggregate.endDate || null
  };
}

function renderAll(){
  renderSummaryBoxes();
  renderGauges();
  renderRiskMatrix();
  renderTopMembers();
  renderResourcingSummary();
  renderTimelineControls();
  renderTimelineChart();
  renderActivityControls();
  renderActivityChart();
}

/* =========================================================
   RESOURCING — org-wide unfilled-role + individual-allocation summary, entirely independent of the
   project picker above (see _resourcingSummary's own comment for why). Each user's bar plots their
   real ProjectMember.AllocatedFraction total and their planned ProjectResourcePlaceholder total as
   two stacked segments against a scale that always shows at least up to 150%, with a marker line at
   the 100% mark — so a combined bar crossing that line is the at-a-glance "this person is
   over-committed" signal, not just a plain number.
   ========================================================= */
function renderResourcingSummary(){
  var unfilledEl = document.getElementById('portfolioUnfilledRoles');
  var userAllocEl = document.getElementById('portfolioUserAllocations');
  if(!_resourcingSummary){
    unfilledEl.innerHTML = '<div class="kf-health-empty">Loading…</div>';
    userAllocEl.innerHTML = '';
    return;
  }

  var unfilled = _resourcingSummary.unfilledRoles || [];
  if(unfilled.length === 0){
    unfilledEl.innerHTML = '<div class="kf-health-empty">No unfilled placeholder roles.</div>';
  } else {
    unfilledEl.innerHTML = unfilled.map(function(r){
      return '<div class="kf-portfolio-resourcing-unfilled-row">' +
        '<span class="kf-dep-key">' + escapeHTML(r.projectKey) + '</span>' +
        '<span class="kf-portfolio-planner-project-name">' + escapeHTML(r.projectName) + '</span>' +
        '<span class="kf-portfolio-resourcing-role">' + escapeHTML(r.role) + '</span>' +
        '<span class="kf-portfolio-resourcing-pct">' + r.allocatedFraction + '% allocated</span>' +
      '</div>';
    }).join('');
  }

  var users = _resourcingSummary.userAllocations || [];
  if(users.length === 0){
    userAllocEl.innerHTML = '<div class="kf-health-empty">No allocation figures recorded yet — set an Allocated Fraction on a team member, or assign someone to a placeholder resource, to see them here.</div>';
  } else {
    userAllocEl.innerHTML = users.map(function(u){
      var total = u.realAllocationTotal + u.placeholderAllocationTotal;
      var scaleMax = Math.max(150, total);
      var realPct = (u.realAllocationTotal / scaleMax) * 100;
      var placeholderPct = (u.placeholderAllocationTotal / scaleMax) * 100;
      var hundredMarkPct = (100 / scaleMax) * 100;
      var overBadge = total > 100 ? '<span class="kf-portfolio-resourcing-over-badge">Over-allocated</span>' : '';
      return '<div class="kf-portfolio-resourcing-user-row">' +
        '<span class="kf-portfolio-resourcing-user-name">' + escapeHTML(u.displayName) + '</span>' +
        '<span class="kf-portfolio-resourcing-bar-track">' +
          '<span class="kf-portfolio-resourcing-bar-real" style="width:' + realPct + '%;"></span>' +
          '<span class="kf-portfolio-resourcing-bar-placeholder" style="width:' + placeholderPct + '%;left:' + realPct + '%;"></span>' +
          '<span class="kf-portfolio-resourcing-bar-marker" style="left:' + hundredMarkPct + '%;"></span>' +
        '</span>' +
        '<span class="kf-portfolio-resourcing-total">' + total + '%<span class="kf-portfolio-resourcing-split"> (' + u.realAllocationTotal + '% currently active + ' + u.placeholderAllocationTotal + '% planned)</span></span>' +
        overBadge +
      '</div>';
    }).join('');
  }
}

function renderSummaryBoxes(){
  var el = document.getElementById('portfolioSummaryBoxes');
  if(!_aggregate){
    el.innerHTML = '';
    return;
  }
  var distinctUserCount = new Set((_aggregate.members || []).map(function(m){ return m.userId; })).size;
  var boxes = [
    {label: 'Org Users', value: _aggregate.orgUserCount},
    {label: 'Total Team Members', value: distinctUserCount},
    {label: 'Principles', value: _aggregate.principleCount},
    {label: 'Objectives', value: _aggregate.objectiveCount},
    {label: 'Decisions', value: (_aggregate.decisions || []).length},
    {label: 'Documents', value: _aggregate.documentCount},
    {label: 'Retrospectives', value: _aggregate.retrospectiveCount}
  ];
  el.innerHTML = boxes.map(function(b){
    return '<div class="kf-portfolio-summary-box">' +
      '<div class="kf-portfolio-summary-value">' + b.value + '</div>' +
      '<div class="kf-portfolio-summary-label">' + escapeHTML(b.label) + '</div>' +
    '</div>';
  }).join('');
}

function renderGauges(){
  var gaugesEl = document.getElementById('portfolioGaugesRow');
  var overallEl = document.getElementById('portfolioOverallGauge');
  var noteEl = document.getElementById('portfolioOverallNote');
  if(_selectedProjectIds.length === 0){
    overallEl.innerHTML = '';
    noteEl.textContent = 'Select one or more projects above to see aggregated health.';
    gaugesEl.innerHTML = '';
    return;
  }
  var pseudo = buildPortfolioPseudoProject(_aggregate);
  var health = computeOverallHealth(pseudo);
  overallEl.innerHTML = buildGaugeBlock(health.overallPct, 'Overall Health', 200, true);
  noteEl.textContent = health.overallPct === null
    ? 'Not enough data yet to compute an aggregated health score for the selected projects.'
    : 'Combines Releases, Tasks, Risks, and Decisions health across every selected project, equally weighted.';
  gaugesEl.innerHTML =
    buildGaugeBlock(health.releases.pct, 'Releases', 140, true) +
    buildGaugeBlock(health.tasks.pct, 'Tasks', 140, true) +
    buildGaugeBlock(health.risks.pct, 'Risks', 140, true) +
    buildGaugeBlock(health.decisions.pct, 'Decisions', 140, true);
  startHealthGaugeAnimation('#portfolioDashboardBody');
}

function renderRiskMatrix(){
  var chartEl = document.getElementById('portfolioRiskMatrixChart');
  var noDataEl = document.getElementById('portfolioRiskMatrixNoData');
  var legendEl = document.getElementById('portfolioRiskMatrixLegend');
  var risks = _aggregate ? (_aggregate.risks || []) : [];
  if(risks.length === 0){
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = _selectedProjectIds.length === 0
      ? 'Select one or more projects above to plot their risks here.'
      : 'None of the selected projects have any risks logged yet.';
    return;
  }
  noDataEl.classList.add('hidden');
  chartEl.innerHTML = buildRiskMatrixSvg(risks, 560, {
    colorForRisk: function(r){ return projectColorFor(r.projectId); }
  });
  var sortedProjects = _allProjects.filter(function(p){ return _selectedProjectIds.indexOf(p.id) !== -1; })
    .sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  legendEl.innerHTML = sortedProjects.map(function(p){
    return '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:' + projectColorFor(p.id) + ';border-radius:50%;width:8px;height:8px;"></span>' + escapeHTML(p.key) + '</span>';
  }).join('') + '<span class="kf-health-legend-item kf-risk-matrix-point-faded" style="opacity:0.55;"><span class="kf-health-legend-swatch" style="background:#8993a4;border-radius:50%;width:8px;height:8px;"></span>Faded = closed risk</span>';
}

function renderTopMembers(){
  var el = document.getElementById('portfolioTopMembers');
  if(!_aggregate || _selectedProjectIds.length === 0){
    el.innerHTML = '<div class="kf-health-empty">Select one or more projects above to see top team members.</div>';
    return;
  }
  var pseudo = buildPortfolioPseudoProject(_aggregate);
  var topMembers = computeTopTeamMembers(pseudo, {limit: 10, groupByUserId: true});
  if(topMembers.length === 0){
    el.innerHTML = '<div class="kf-health-empty">No active tasks are currently assigned to any team member across the selected projects.</div>';
    return;
  }
  var maxCount = topMembers[0].count;
  el.innerHTML = topMembers.map(function(row, idx){
    var barPct = maxCount > 0 ? (row.count / maxCount) * 100 : 0;
    return '<div class="kf-health-top-member-row">' +
      '<span class="kf-health-top-member-rank">' + (idx + 1) + '</span>' +
      '<span class="kf-avatar kf-avatar-sm" style="background:' + row.color + ';">' + escapeHTML(memberInitials(row.name)) + '</span>' +
      '<span class="kf-health-top-member-name">' + escapeHTML(memberLabel(row)) + (row.role ? ' <span class="kf-health-top-member-role">' + escapeHTML(row.role) + '</span>' : '') + '</span>' +
      '<span class="kf-health-top-member-bar-track"><span class="kf-health-top-member-bar-fill" style="width:' + barPct + '%;"></span></span>' +
      '<span class="kf-health-top-member-count">' + row.count + '</span>' +
    '</div>';
  }).join('');
}

/* =========================================================
   TIMELINE — one bar per selected project, from its own StartDate to EndDate. Independent
   granularity + date-range controls, per "like the Vendor Portal charts" (each chart owns its own
   state, never a single shared date-range control across every chart on this dashboard).
   ========================================================= */
function renderTimelineControls(){
  var scaleSelect = document.getElementById('portfolioTimelineScaleSelect');
  var startInput = document.getElementById('portfolioTimelineStartInput');
  var endInput = document.getElementById('portfolioTimelineEndInput');
  scaleSelect.value = _timelineState.granularity;
  if(_timelineState.start) startInput.value = toServerDateOnly(_timelineState.start);
  if(_timelineState.end) endInput.value = toServerDateOnly(_timelineState.end);
}
export function onPortfolioTimelineControlsChanged(){
  var scaleSelect = document.getElementById('portfolioTimelineScaleSelect');
  var startInput = document.getElementById('portfolioTimelineStartInput');
  var endInput = document.getElementById('portfolioTimelineEndInput');
  _timelineState.granularity = scaleSelect.value;
  if(startInput.value) _timelineState.start = new Date(startInput.value + 'T00:00:00');
  if(endInput.value) _timelineState.end = new Date(endInput.value + 'T00:00:00');
  renderTimelineChart();
}
/* Cached from the most recent renderTimelineChart() — the drag handlers below need the EXACT same
   nameColWidth/scaledColumns a render used to place bars, so tlPixelToDate's inverse lands on the
   same dates tlDateToPixel placed them at. Never read during a render itself, only by drag code
   that runs strictly after one has already completed. */
var _timelineLayout = null;
var _timelineDrag = null;
var TIMELINE_HANDLE_WIDTH = 8;
var TIMELINE_DRAG_CLICK_THRESHOLD = 4; // px of pointer movement (client space) before a press counts as a drag, not a click

function renderTimelineChart(){
  var chartEl = document.getElementById('portfolioTimelineChart');
  var noDataEl = document.getElementById('portfolioTimelineNoData');
  // Every selected project gets a row now, not just ones with both dates set — one lacking either
  // date still renders (see the hatch-pattern branch below), so an Org Admin can see at a glance
  // which projects in the selection have no timeline set yet, rather than that project silently
  // vanishing from the chart.
  var projects = _allProjects.filter(function(p){ return _selectedProjectIds.indexOf(p.id) !== -1; });
  if(!_timelineState.start || !_timelineState.end || projects.length === 0){
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'Select one or more projects above to plot their timeline here.';
    _timelineLayout = null;
    return;
  }
  noDataEl.classList.add('hidden');

  var nameColWidth = 160, rowHeight = 32, marginTop = 40;
  var trackWidth = Math.max(600, (chartEl.clientWidth || 800) - nameColWidth - 40);
  var columns = buildTimelineColumns(_timelineState.start, _timelineState.end, _timelineState.granularity, 70);
  var totalTrackWidth = columns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var scale = totalTrackWidth > 0 ? Math.max(trackWidth / totalTrackWidth, 0.3) : 1;
  var scaledColumns = columns.map(function(c){ return {start: c.start, end: c.end, label: c.label, width: c.width * scale}; });
  var scaledTrackWidth = scaledColumns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var width = nameColWidth + scaledTrackWidth + 20;
  var height = marginTop + projects.length * rowHeight + 10;

  _timelineLayout = {nameColWidth: nameColWidth, rowHeight: rowHeight, marginTop: marginTop, scaledColumns: scaledColumns, scaledTrackWidth: scaledTrackWidth};

  var defsHTML = noDatesPatternDefsSVG();

  var headerHTML = '';
  var x = nameColWidth;
  scaledColumns.forEach(function(c){
    headerHTML += '<text x="' + (x + c.width / 2) + '" y="' + (marginTop - 12) + '" font-size="10" font-weight="600" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(c.label) + '</text>' +
      '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';
    x += c.width;
  });
  headerHTML += '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';

  // Dated projects first (earliest start first), undated ones after (alphabetically) — sorting by
  // start date alone would put every undated project first via an Invalid Date comparison.
  var sortedProjects = projects.slice().sort(function(a, b){
    var aHasDates = !!(a.startDate && a.endDate), bHasDates = !!(b.startDate && b.endDate);
    if(aHasDates && bHasDates) return new Date(a.startDate) - new Date(b.startDate);
    if(aHasDates !== bHasDates) return aHasDates ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
  });
  var rowsHTML = sortedProjects.map(function(p, idx){
    var y = marginTop + idx * rowHeight;
    var barY = y + 6, barHeight = rowHeight - 14;
    var nameHTML = '<text x="8" y="' + (y + rowHeight / 2 + 4) + '" font-size="11" font-weight="600" fill="var(--kf-text)">' + escapeHTML(p.key) + '</text>';
    if(!p.startDate || !p.endDate){
      // Click-only (nothing to drag from) — always opens the dates modal, same as clicking a dated
      // bar without moving it does.
      return nameHTML + projectBarSVG(p, nameColWidth, barY, scaledTrackWidth, barHeight, null, TIMELINE_HANDLE_WIDTH);
    }
    var barStartX = nameColWidth + tlDateToPixel(new Date(p.startDate), scaledColumns);
    var barEndX = nameColWidth + tlDateToPixel(new Date(p.endDate), scaledColumns);
    var barWidth = Math.max(4, barEndX - barStartX);
    var color = projectColorFor(p.id);
    // Grouped in a <g> (not flat siblings) so the handle-reveal-on-hover CSS can scope to just this
    // row's own handles — a plain CSS sibling combinator can't tell "this row's handles" apart from
    // every other row's, since every row's shapes would otherwise sit as flat siblings of each other
    // under the same <svg>.
    return nameHTML + projectBarSVG(p, barStartX, barY, barWidth, barHeight, color, TIMELINE_HANDLE_WIDTH);
  }).join('');

  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="kf-portfolio-timeline-svg">' + defsHTML + headerHTML + rowsHTML + '</svg>';
}

/* =========================================================
   TIMELINE DRAG-TO-SCHEDULE — a click (no meaningful pointer movement) on any bar, handle, or the
   grey "no dates" placeholder opens the dates modal below. Actually dragging a bar body shifts both
   dates together (duration preserved); dragging an edge handle resizes just that one date. Built on
   tlPixelToDate (views/timeline.js), the exact inverse of the tlDateToPixel this chart already draws
   bars with — kept as a generic pixel<->date pair specifically so a future proper planning-tool Gantt
   view can reuse the same drag mechanics against the same column model, not just this chart.
   ========================================================= */
export function onPortfolioTimelineBarPointerDown(e){
  var target = e.target.closest ? e.target.closest('[data-project-id]') : null;
  if(!target || !_timelineLayout) return;
  var projectId = target.getAttribute('data-project-id');
  var role = target.getAttribute('data-role');
  var project = _allProjects.filter(function(p){ return p.id === projectId; })[0];
  if(!project) return;

  if(role === 'click-only'){
    openPortfolioProjectDatesModal(projectId);
    return;
  }

  var svgEl = document.querySelector('#portfolioTimelineChart svg');
  if(!svgEl) return;
  e.preventDefault();

  var barEl = svgEl.querySelector('.kf-portfolio-timeline-bar[data-project-id="' + cssEscape(projectId) + '"]');
  var startHandleEl = svgEl.querySelector('.kf-portfolio-timeline-handle[data-project-id="' + cssEscape(projectId) + '"][data-role="resize-start"]');
  var endHandleEl = svgEl.querySelector('.kf-portfolio-timeline-handle[data-project-id="' + cssEscape(projectId) + '"][data-role="resize-end"]');
  if(!barEl || !startHandleEl || !endHandleEl) return;

  var vb = svgEl.viewBox.baseVal;
  var rect = svgEl.getBoundingClientRect();
  var scaleRatio = rect.width > 0 ? vb.width / rect.width : 1;

  var layout = _timelineLayout;
  var barStartX = layout.nameColWidth + tlDateToPixel(new Date(project.startDate), layout.scaledColumns);
  var barEndX = layout.nameColWidth + tlDateToPixel(new Date(project.endDate), layout.scaledColumns);

  _timelineDrag = {
    projectId: projectId, role: role, scaleRatio: scaleRatio,
    pointerStartClientX: e.clientX, moved: false,
    origBarStartX: barStartX, origBarEndX: barEndX,
    liveBarStartX: barStartX, liveBarEndX: barEndX,
    barEl: barEl, startHandleEl: startHandleEl, endHandleEl: endHandleEl,
    handleWidth: TIMELINE_HANDLE_WIDTH
  };
  document.addEventListener('mousemove', onPortfolioTimelineDragMove);
  document.addEventListener('mouseup', onPortfolioTimelineDragEnd);
}

function onPortfolioTimelineDragMove(e){
  if(!_timelineDrag || !_timelineLayout) return;
  var d = _timelineDrag;
  var deltaXClient = e.clientX - d.pointerStartClientX;
  if(Math.abs(deltaXClient) >= TIMELINE_DRAG_CLICK_THRESHOLD) d.moved = true;
  var deltaX = deltaXClient * d.scaleRatio;

  var layout = _timelineLayout;
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

function onPortfolioTimelineDragEnd(){
  if(!_timelineDrag) return;
  var d = _timelineDrag;
  document.removeEventListener('mousemove', onPortfolioTimelineDragMove);
  document.removeEventListener('mouseup', onPortfolioTimelineDragEnd);
  _timelineDrag = null;

  if(!d.moved){
    openPortfolioProjectDatesModal(d.projectId);
    return;
  }

  var layout = _timelineLayout;
  var newStartDate = tlPixelToDate(d.liveBarStartX - layout.nameColWidth, layout.scaledColumns);
  var newEndDate = tlPixelToDate(d.liveBarEndX - layout.nameColWidth, layout.scaledColumns);
  var startVal = toServerDateOnly(newStartDate);
  var endVal = toServerDateOnly(newEndDate);

  portfolioApi.updateProjectDates(d.projectId, startVal, endVal).then(function(){
    applyLocalProjectDates(d.projectId, startVal, endVal);
    renderTimelineChart();
  }, function(){
    toast('Could not update project dates.');
    renderTimelineChart();
  });
}

/* Minimal fallback for browsers/environments without window.CSS.escape (project ids are GUIDs, so
   in practice only needed for the astronomically unlikely case that ever changes). */
function cssEscape(value){
  return (window.CSS && window.CSS.escape) ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function applyLocalProjectDates(projectId, startVal, endVal){
  _allProjects = _allProjects.map(function(p){
    return p.id === projectId ? Object.assign({}, p, {startDate: startVal, endDate: endVal}) : p;
  });
}

/* =========================================================
   PROJECT DATES MODAL — click-to-edit counterpart to the drag gestures above. Opened either by a
   non-dragging click on a bar/handle, or by clicking the grey "no dates" placeholder (which has
   nothing to drag from at all).
   ========================================================= */
var _projectDatesModalProjectId = null;

export function openPortfolioProjectDatesModal(projectId){
  var project = _allProjects.filter(function(p){ return p.id === projectId; })[0];
  if(!project) return;
  _projectDatesModalProjectId = projectId;
  document.getElementById('portfolioProjectDatesTitle').textContent = project.name;
  document.getElementById('portfolioProjectDatesStartInput').value = project.startDate || '';
  document.getElementById('portfolioProjectDatesEndInput').value = project.endDate || '';
  document.getElementById('portfolioProjectDatesOverlay').classList.remove('hidden');
}
export function closePortfolioProjectDatesModal(){
  document.getElementById('portfolioProjectDatesOverlay').classList.add('hidden');
  _projectDatesModalProjectId = null;
}
export function isPortfolioProjectDatesModalOpen(){
  return !document.getElementById('portfolioProjectDatesOverlay').classList.contains('hidden');
}
export function clearPortfolioProjectDatesInModal(){
  document.getElementById('portfolioProjectDatesStartInput').value = '';
  document.getElementById('portfolioProjectDatesEndInput').value = '';
}
export function savePortfolioProjectDatesFromModal(){
  if(!_projectDatesModalProjectId) return;
  var startVal = document.getElementById('portfolioProjectDatesStartInput').value || null;
  var endVal = document.getElementById('portfolioProjectDatesEndInput').value || null;
  if(startVal && endVal && endVal < startVal){
    toast('End date cannot be before the start date.');
    return;
  }
  var projectId = _projectDatesModalProjectId;
  portfolioApi.updateProjectDates(projectId, startVal, endVal).then(function(){
    applyLocalProjectDates(projectId, startVal, endVal);
    closePortfolioProjectDatesModal();
    renderTimelineChart();
  }, function(){
    toast('Could not update project dates.');
  });
}

/* =========================================================
   ACTIVITY — full-width chart of tasks created/edited/done across every selected project, within a
   reporting date range, at a selectable granularity. Daily counts come from the server
   (PortfolioActivityDto); bucketing into the chosen granularity happens here, reusing the exact
   same day/week/month/etc. column generator the Timeline above (and the app's own Timeline view)
   already uses.
   ========================================================= */
var ACTIVITY_SERIES = [
  {key: 'created', label: 'Created', color: '#0c66e4'},
  {key: 'edited', label: 'Edited', color: '#f08c00'},
  {key: 'done', label: 'Done', color: '#2f9e44'}
];

function renderActivityControls(){
  var scaleSelect = document.getElementById('portfolioActivityScaleSelect');
  var startInput = document.getElementById('portfolioActivityStartInput');
  var endInput = document.getElementById('portfolioActivityEndInput');
  scaleSelect.value = _activityChartState.granularity;
  if(_activityChartState.start) startInput.value = toServerDateOnly(_activityChartState.start);
  if(_activityChartState.end) endInput.value = toServerDateOnly(_activityChartState.end);
}
export function onPortfolioActivityControlsChanged(){
  var scaleSelect = document.getElementById('portfolioActivityScaleSelect');
  var startInput = document.getElementById('portfolioActivityStartInput');
  var endInput = document.getElementById('portfolioActivityEndInput');
  _activityChartState.granularity = scaleSelect.value;
  var rangeChanged = false;
  if(startInput.value){
    var newStart = new Date(startInput.value + 'T00:00:00');
    if(!_activityChartState.start || newStart.getTime() !== _activityChartState.start.getTime()){ _activityChartState.start = newStart; rangeChanged = true; }
  }
  if(endInput.value){
    var newEnd = new Date(endInput.value + 'T00:00:00');
    if(!_activityChartState.end || newEnd.getTime() !== _activityChartState.end.getTime()){ _activityChartState.end = newEnd; rangeChanged = true; }
  }
  if(rangeChanged && _selectedProjectIds.length > 0){
    fetchActivityAndRender();
  } else {
    renderActivityChart();
  }
}

/* DD/MM only for this chart's own x-axis — deliberately not a TIMESCALE_CONFIG.labelFn change,
   since that's shared with the Timeline chart above and the main app's Timeline view, neither of
   which this request was about. */
function formatDDMM(date){
  var d = String(date.getDate()).padStart(2, '0'), m = String(date.getMonth() + 1).padStart(2, '0');
  return d + '/' + m;
}

function bucketDailyPointsIntoColumns(dailyPoints, columns){
  var byDate = {};
  (dailyPoints || []).forEach(function(pt){ byDate[pt.date] = (byDate[pt.date] || 0) + pt.count; });
  return columns.map(function(col){
    var sum = 0;
    for(var d = new Date(col.start); d.getTime() < col.end.getTime(); d.setDate(d.getDate() + 1)){
      sum += byDate[toServerDateOnly(d)] || 0;
    }
    return sum;
  });
}

function renderActivityChart(){
  var chartEl = document.getElementById('portfolioActivityChart');
  var noDataEl = document.getElementById('portfolioActivityNoData');
  var legendEl = document.getElementById('portfolioActivityLegend');
  if(_selectedProjectIds.length === 0 || !_activity || !_activityChartState.start || !_activityChartState.end){
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'Select one or more projects above to see aggregated activity here.';
    return;
  }
  noDataEl.classList.add('hidden');
  legendEl.innerHTML = ACTIVITY_SERIES.map(function(s){
    return '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:' + s.color + ';"></span>' + s.label + '</span>';
  }).join('');

  var columns = buildTimelineColumns(_activityChartState.start, _activityChartState.end, _activityChartState.granularity, 60);
  var seriesData = ACTIVITY_SERIES.map(function(s){ return bucketDailyPointsIntoColumns(_activity[s.key], columns); });
  var maxValue = Math.max(1, Math.max.apply(null, seriesData.reduce(function(all, arr){ return all.concat(arr); }, [])));

  var marginLeft = 44, marginRight = 20, marginTop = 16, marginBottom = 44;
  var plotWidth = Math.max(600, (chartEl.clientWidth || 900) - marginLeft - marginRight);
  var colWidth = plotWidth / Math.max(columns.length, 1);
  var plotHeight = 260;

  var ySteps = [0, 0.25, 0.5, 0.75, 1].map(function(f){ return Math.round(maxValue * f); });
  var gridHTML = ySteps.map(function(v){
    var gy = marginTop + plotHeight - (v / maxValue) * plotHeight;
    return '<line x1="' + marginLeft + '" y1="' + gy + '" x2="' + (marginLeft + plotWidth) + '" y2="' + gy + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="3,3"/>' +
      '<text x="' + (marginLeft - 8) + '" y="' + (gy + 4) + '" font-size="10" text-anchor="end" fill="var(--kf-text-secondary)">' + v + '</text>';
  }).join('');

  var barGroupWidth = colWidth * 0.7;
  var barWidth = barGroupWidth / ACTIVITY_SERIES.length;
  var barsHTML = '';
  var labelsHTML = '';
  columns.forEach(function(col, colIdx){
    var groupX = marginLeft + colIdx * colWidth + (colWidth - barGroupWidth) / 2;
    ACTIVITY_SERIES.forEach(function(s, sIdx){
      var value = seriesData[sIdx][colIdx];
      var barHeight = (value / maxValue) * plotHeight;
      var bx = groupX + sIdx * barWidth;
      var by = marginTop + plotHeight - barHeight;
      barsHTML += '<rect x="' + bx + '" y="' + by + '" width="' + Math.max(1, barWidth - 2) + '" height="' + Math.max(0, barHeight) + '" rx="2" fill="' + s.color + '"><title>' + s.label + ': ' + value + '</title></rect>';
    });
    labelsHTML += '<text x="' + (marginLeft + colIdx * colWidth + colWidth / 2) + '" y="' + (marginTop + plotHeight + 18) + '" font-size="10" text-anchor="middle" fill="var(--kf-text-secondary)">' + formatDDMM(col.start) + '</text>';
  });

  var width = marginLeft + plotWidth + marginRight;
  var height = marginTop + plotHeight + marginBottom;
  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="kf-portfolio-activity-svg">' + gridHTML + barsHTML + labelsHTML + '</svg>';
}
