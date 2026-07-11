"use strict";
import { toast } from '../ui.js';
import { escapeHTML } from '../views/board.js';
import { memberInitials } from '../date-utils.js';
import { getPortfolioSelectedProjectIds, setPortfolioSelectedProjectIds } from '../storage.js';
import { portfolioApi, isOrgAdmin } from '../api.js';
import { computeOverallHealth, computeTopTeamMembers } from '../features/health.js';
import { buildGaugeBlock, startHealthGaugeAnimation, cancelHealthGaugeAnimation } from './health.js';
import { buildRiskMatrixSvg } from '../mutations.js';
import { buildTimelineColumns, tlDateToPixel } from '../views/timeline.js';

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
var _aggregate = null;
var _activity = null;

var _timelineState = {granularity: 'month', start: null, end: null};
var _activityChartState = {granularity: 'week', start: null, end: null};

export function openPortfolioDashboardOverlay(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can open the Portfolio Dashboard.'); return; }
  document.getElementById('portfolioDashboardOverlay').classList.remove('hidden');
  loadPortfolioProjectsAndRender();
}
export function closePortfolioDashboardOverlay(){
  cancelHealthGaugeAnimation();
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
    refreshPortfolioData();
  }, function(){
    pickerEl.innerHTML = '<div class="kf-health-empty">Could not load projects.</div>';
  });
}

function renderProjectPicker(){
  var pickerEl = document.getElementById('portfolioProjectPicker');
  if(_allProjects.length === 0){
    pickerEl.innerHTML = '<div class="kf-health-empty">No projects exist in this organisation yet.</div>';
    return;
  }
  var sorted = _allProjects.slice().sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  pickerEl.innerHTML = sorted.map(function(p){
    var checked = _selectedProjectIds.indexOf(p.id) !== -1;
    return '<label class="kf-risk-doc-picker-row">' +
      '<input type="checkbox" data-project-id="' + p.id + '" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dep-key">' + escapeHTML(p.key) + '</span>' +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(p.name) + '</span>' +
    '</label>';
  }).join('');
}

export function onPortfolioProjectSelectionChanged(){
  var checked = Array.from(document.querySelectorAll('#portfolioProjectPicker input[type=checkbox]:checked'))
    .map(function(cb){ return cb.getAttribute('data-project-id'); });
  _selectedProjectIds = checked;
  setPortfolioSelectedProjectIds(_selectedProjectIds);
  refreshPortfolioData();
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
    // Reporting range defaults follow the aggregate's own bounding project date range the first
    // time data loads for this selection — an admin who changes the selection keeps whatever
    // custom range they'd already set, rather than silently resetting it underneath them.
    if(!_timelineState.start || !_timelineState.end){
      _timelineState.start = aggregate.startDate ? new Date(aggregate.startDate) : defaultRangeStart();
      _timelineState.end = aggregate.endDate ? new Date(aggregate.endDate) : new Date();
    }
    if(!_activityChartState.start || !_activityChartState.end){
      _activityChartState.end = new Date();
      _activityChartState.start = defaultRangeStart();
    }
    return fetchActivityAndRender();
  }, function(){
    toast('Could not load Portfolio Dashboard data.');
  });
}

function defaultRangeStart(){
  var d = new Date();
  d.setDate(d.getDate() - 90);
  return d;
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
    return {id: m.id, userId: m.userId, name: m.displayName, color: m.color, role: m.role || null};
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
  renderTimelineControls();
  renderTimelineChart();
  renderActivityControls();
  renderActivityChart();
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
      '<span class="kf-health-top-member-name">' + escapeHTML(row.name) + (row.role ? ' <span class="kf-health-top-member-role">' + escapeHTML(row.role) + '</span>' : '') + '</span>' +
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
function renderTimelineChart(){
  var chartEl = document.getElementById('portfolioTimelineChart');
  var noDataEl = document.getElementById('portfolioTimelineNoData');
  var projects = _allProjects.filter(function(p){ return _selectedProjectIds.indexOf(p.id) !== -1 && p.startDate && p.endDate; });
  if(!_timelineState.start || !_timelineState.end || projects.length === 0){
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = _selectedProjectIds.length === 0
      ? 'Select one or more projects above to plot their timeline here.'
      : 'None of the selected projects have both a start and end date set.';
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

  var headerHTML = '';
  var x = nameColWidth;
  scaledColumns.forEach(function(c){
    headerHTML += '<text x="' + (x + c.width / 2) + '" y="' + (marginTop - 12) + '" font-size="10" font-weight="600" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(c.label) + '</text>' +
      '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';
    x += c.width;
  });
  headerHTML += '<line x1="' + x + '" y1="' + (marginTop - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';

  var sortedProjects = projects.slice().sort(function(a, b){ return new Date(a.startDate) - new Date(b.startDate); });
  var rowsHTML = sortedProjects.map(function(p, idx){
    var y = marginTop + idx * rowHeight;
    var barStartX = nameColWidth + tlDateToPixel(new Date(p.startDate), scaledColumns);
    var barEndX = nameColWidth + tlDateToPixel(new Date(p.endDate), scaledColumns);
    var barWidth = Math.max(4, barEndX - barStartX);
    var color = projectColorFor(p.id);
    return '<text x="8" y="' + (y + rowHeight / 2 + 4) + '" font-size="11" font-weight="600" fill="var(--kf-text)">' + escapeHTML(p.key) + '</text>' +
      '<rect x="' + barStartX + '" y="' + (y + 6) + '" width="' + barWidth + '" height="' + (rowHeight - 14) + '" rx="4" fill="' + color + '"><title>' + escapeHTML(p.name) + '</title></rect>';
  }).join('');

  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="auto" class="kf-portfolio-timeline-svg">' + headerHTML + rowsHTML + '</svg>';
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
    labelsHTML += '<text x="' + (marginLeft + colIdx * colWidth + colWidth / 2) + '" y="' + (marginTop + plotHeight + 18) + '" font-size="10" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(col.label) + '</text>';
  });

  var width = marginLeft + plotWidth + marginRight;
  var height = marginTop + plotHeight + marginBottom;
  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="auto" class="kf-portfolio-activity-svg">' + gridHTML + barsHTML + labelsHTML + '</svg>';
}
