"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg, hydrateIcons } from '../icons.js';
import { memberInitials, utcISOToLocalDisplayDate } from '../date-utils.js';
import { memberLabel } from '../utils.js';
import { normalizeHeaderButtonVisibility } from '../storage.js';
import { computeOverallHealth, computeTopTeamMembers, computeBurndownData } from '../features/health.js';
import { buildRiskMatrixSvg } from '../mutations.js';

/* ---- Dial gauge rendering ---- */
function healthGaugeColor(pct){
  if(pct === null) return '#8993a4';
  if(pct >= 70) return '#1f845a';
  if(pct >= 40) return '#974f0c';
  return '#ae2e24';
}
function polarPoint(cx, cy, r, angleDeg){
  var rad = angleDeg * Math.PI / 180;
  return {x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad)};
}
function describeSemicircleArc(cx, cy, r, startAngle, endAngle){
  var p1 = polarPoint(cx, cy, r, startAngle);
  var p2 = polarPoint(cx, cy, r, endAngle);
  return 'M ' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2) + ' A ' + r + ' ' + r + ' 0 0 1 ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
}
function buildGaugeSvg(pct, size, startAtZero){
  size = size || 160;
  var cx = size / 2, cy = size * 0.56, r = size * 0.4, strokeW = size * 0.1;
  var displayPct = (pct === null || startAtZero) ? 0 : pct;
  var valueColor = healthGaugeColor(pct);
  var trackPath = describeSemicircleArc(cx, cy, r, 180, 0);
  var valueEndAngle = 180 - (displayPct / 100) * 180;
  var valuePathD = displayPct > 0 ? describeSemicircleArc(cx, cy, r, 180, valueEndAngle) : '';
  var labelText = pct === null ? 'N/A' : Math.round(displayPct) + '%';
  return '<svg viewBox="0 0 ' + size + ' ' + (size * 0.72) + '" width="' + size + '" height="' + (size * 0.72) + '" class="kf-gauge-svg" data-target-pct="' + (pct === null ? '' : pct) + '" data-size="' + size + '">' +
    '<path d="' + trackPath + '" fill="none" stroke="var(--kf-border)" stroke-width="' + strokeW + '" stroke-linecap="round"/>' +
    '<path class="kf-gauge-value-path" d="' + valuePathD + '" fill="none" stroke="' + valueColor + '" stroke-width="' + strokeW + '" stroke-linecap="round"/>' +
    '<text class="kf-gauge-value-text" x="' + cx + '" y="' + (cy - r * 0.15) + '" text-anchor="middle" font-size="' + (size * 0.17) + '" font-weight="700" fill="var(--kf-text)">' + labelText + '</text>' +
  '</svg>';
}
/* Exported so the Portfolio Dashboard (modals/portfolio-dashboard.js) can render the exact same
   gauge markup for its own aggregated pct values — "use the same health dials" is satisfied by
   reusing this unchanged, not re-deriving gauge SVG drawing a second time. */
export function buildGaugeBlock(pct, label, size, startAtZero){
  return '<div class="kf-health-gauge-block">' +
    buildGaugeSvg(pct, size, startAtZero) +
    '<div class="kf-health-gauge-label">' + escapeHTML(label) + '</div>' +
  '</div>';
}

/* ---- Gauge animation ---- */
var HEALTH_GAUGE_ANIM_DELAY_MS = 500;
var HEALTH_GAUGE_ANIM_DURATION_MS = 900;

export function cancelHealthGaugeAnimation(){
  if(ui.healthGaugeAnimTimeoutId){ clearTimeout(ui.healthGaugeAnimTimeoutId); ui.healthGaugeAnimTimeoutId = null; }
  if(ui.healthGaugeAnimFrameId){ cancelAnimationFrame(ui.healthGaugeAnimFrameId); ui.healthGaugeAnimFrameId = null; }
}
function applyGaugeDisplayValue(svgEl, displayPct, finalPct, size){
  var cx = size / 2, cy = size * 0.56, r = size * 0.4;
  var clamped = Math.max(0, Math.min(100, displayPct));
  var valuePathEl = svgEl.querySelector('.kf-gauge-value-path');
  var textEl = svgEl.querySelector('.kf-gauge-value-text');
  var valueColor = healthGaugeColor(finalPct);
  var valueEndAngle = 180 - (clamped / 100) * 180;
  var d = clamped > 0 ? describeSemicircleArc(cx, cy, r, 180, valueEndAngle) : '';
  valuePathEl.setAttribute('d', d);
  valuePathEl.setAttribute('stroke', valueColor);
  textEl.textContent = Math.round(clamped) + '%';
}
/* containerSelector defaults to the per-project Health Dashboard's own body — the Portfolio
   Dashboard (modals/portfolio-dashboard.js) passes its own gauges row's id instead, so the two
   modals' gauge animations never interfere with each other even if somehow both were mid-animation
   at once. */
export function startHealthGaugeAnimation(containerSelector){
  cancelHealthGaugeAnimation();
  ui.healthGaugeAnimTimeoutId = setTimeout(function(){
    ui.healthGaugeAnimTimeoutId = null;
    var gaugeEls = Array.prototype.slice.call(document.querySelectorAll((containerSelector || '#healthBody') + ' .kf-gauge-svg')).filter(function(el){
      return el.getAttribute('data-target-pct') !== '';
    });
    if(gaugeEls.length === 0) return;
    var startTime = null;
    function tick(now){
      if(startTime === null) startTime = now;
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / HEALTH_GAUGE_ANIM_DURATION_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      gaugeEls.forEach(function(svgEl){
        var finalPct = parseFloat(svgEl.getAttribute('data-target-pct'));
        var size = parseFloat(svgEl.getAttribute('data-size')) || 160;
        applyGaugeDisplayValue(svgEl, finalPct * eased, finalPct, size);
      });
      if(t < 1){
        ui.healthGaugeAnimFrameId = requestAnimationFrame(tick);
      } else {
        ui.healthGaugeAnimFrameId = null;
      }
    }
    ui.healthGaugeAnimFrameId = requestAnimationFrame(tick);
  }, HEALTH_GAUGE_ANIM_DELAY_MS);
}

/* ---- Burndown chart ---- */
function buildBurndownActualPoints(project, burndown){
  var getColumn = function(p, id){ return p.columns.find(function(c){ return c.id === id; }); };
  var getTasksArr = function(p){ return Object.keys(p.tasks).map(function(id){ return p.tasks[id]; }); };
  var tasks = getTasksArr(project).filter(function(t){ return !t.archived; });
  var doneTasks = tasks.filter(function(t){ var c = getColumn(project, t.columnId); return c && c.done; });
  var completions = doneTasks
    .map(function(t){ return t.dateDone ? new Date(t.dateDone).getTime() : NaN; })
    .filter(function(ts){ return isFinite(ts) && ts >= burndown.startDate; })
    .sort(function(a, b){ return a - b; });

  var points = [{date: burndown.startDate, remaining: burndown.total}];
  var remaining = burndown.total;
  completions.forEach(function(ts){
    remaining = Math.max(0, remaining - 1);
    points.push({date: ts, remaining: remaining});
  });
  var now = Date.now();
  if(points[points.length - 1].date < now){
    points.push({date: now, remaining: burndown.remainingCount});
  }
  return points;
}
function buildBurndownChartSvg(project, burndown, width, height){
  width = width || 760; height = height || 280;
  var marginLeft = 50, marginRight = 30, marginTop = 24, marginBottom = 36;
  var plotW = width - marginLeft - marginRight;
  var plotH = height - marginTop - marginBottom;

  var xMin = burndown.startDate;
  var xMax = burndown.endDate;
  if(burndown.hasEnoughData && burndown.isOverrun){
    xMax = Math.max(xMax, burndown.projectedCompletionDate);
  }
  var yMax = Math.max(burndown.total, 1);

  function xPos(t){ return marginLeft + (t - xMin) / Math.max(xMax - xMin, 1) * plotW; }
  function yPos(v){ return marginTop + plotH - (v / yMax) * plotH; }

  var numXLabels = Math.min(6, Math.floor(plotW / 80));
  var xLabelsHTML = '';
  for(var li = 0; li <= numXLabels; li++){
    var labelDate = xMin + (xMax - xMin) * (li / numXLabels);
    var lx = xPos(labelDate);
    xLabelsHTML += '<text x="' + lx + '" y="' + (marginTop + plotH + 16) + '" font-size="10" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(new Date(labelDate).toLocaleDateString(undefined, {month:'short', day:'numeric'})) + '</text>';
  }
  var ySteps = [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax];
  var yGridHTML = ySteps.map(function(v){
    var gy = yPos(v);
    return '<line x1="' + marginLeft + '" y1="' + gy + '" x2="' + (marginLeft + plotW) + '" y2="' + gy + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="3,3"/>' +
      '<text x="' + (marginLeft - 6) + '" y="' + (gy + 4) + '" font-size="10" text-anchor="end" fill="var(--kf-text-secondary)">' + v + '</text>';
  }).join('');

  var idealPoints = [
    {date: burndown.startDate, remaining: burndown.total},
    {date: burndown.endDate, remaining: 0}
  ];
  function pointsToPath(pts){
    return pts.map(function(p, i){ return (i === 0 ? 'M' : 'L') + ' ' + xPos(p.date).toFixed(1) + ' ' + yPos(p.remaining).toFixed(1); }).join(' ');
  }
  var idealPath = pointsToPath(idealPoints);

  var actualPoints = buildBurndownActualPoints(project, burndown);
  var actualEndDate = actualPoints[actualPoints.length - 1].date;
  var actualEndRemaining = actualPoints[actualPoints.length - 1].remaining;
  var actualPath = pointsToPath(actualPoints);

  var projPath = '';
  if(burndown.isOverrun && burndown.projectedCompletionDate > actualEndDate){
    var projPoints = [
      {date: actualEndDate, remaining: actualEndRemaining},
      {date: burndown.projectedCompletionDate, remaining: 0}
    ];
    projPath = '<path d="' + pointsToPath(projPoints) + '" fill="none" stroke="#ae2e24" stroke-width="2" stroke-dasharray="6,3"/>';
  } else if(!burndown.isOverrun && burndown.projectedCompletionDate < burndown.endDate){
    var projPointsEarly = [
      {date: actualEndDate, remaining: actualEndRemaining},
      {date: burndown.projectedCompletionDate, remaining: 0}
    ];
    projPath = '<path d="' + pointsToPath(projPointsEarly) + '" fill="none" stroke="var(--kf-text-faint)" stroke-width="2" stroke-dasharray="6,3"/>';
  }

  return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="kf-health-burndown-svg">' +
    yGridHTML + xLabelsHTML +
    '<path d="' + idealPath + '" fill="none" stroke="var(--kf-border-strong)" stroke-width="2" stroke-dasharray="6,3"/>' +
    '<path d="' + actualPath + '" fill="none" stroke="#0c66e4" stroke-width="2.5"/>' +
    projPath +
  '</svg>';
}

export function openHealthOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  renderHealthDashboard();
  document.getElementById('healthOverlay').classList.remove('hidden');
}
export function closeHealthOverlay(){
  cancelHealthGaugeAnimation();
  document.getElementById('healthOverlay').classList.add('hidden');
}
export function isHealthOverlayOpen(){
  return !document.getElementById('healthOverlay').classList.contains('hidden');
}

export function renderHealthDashboard(){
  var project = getCurrentProject();
  if(!project) return;
  var health = computeOverallHealth(project);

  document.getElementById('healthOverallGauge').innerHTML = buildGaugeBlock(health.overallPct, 'Overall Health', 200, true);

  var noteEl = document.getElementById('healthOverallNote');
  if(health.overallPct === null){
    noteEl.textContent = 'Not enough data yet to compute an overall health score for this project.';
  } else if(health.overrunPenalty > 0){
    noteEl.textContent = 'A projected timeline overrun has reduced this score by ' + Math.round(health.overrunPenalty) + ' point(s). See Task Burndown below.';
  } else {
    noteEl.textContent = 'Combines Releases, Tasks, Risks, and Decisions health, equally weighted.';
  }

  var gaugesRow = document.getElementById('healthGaugesRow');
  gaugesRow.innerHTML =
    buildGaugeBlock(health.releases.pct, 'Releases', 140, true) +
    buildGaugeBlock(health.tasks.pct, 'Tasks', 140, true) +
    buildGaugeBlock(health.risks.pct, 'Risks', 140, true) +
    buildGaugeBlock(health.decisions.pct, 'Decisions', 140, true);

  var burndown = health.burndown;
  var warningEl = document.getElementById('healthBurndownWarning');
  var chartEl = document.getElementById('healthBurndownChart');
  var noDataEl = document.getElementById('healthBurndownNoData');

  if(!burndown.hasEnoughData){
    warningEl.classList.add('hidden');
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = burndown.reason === 'no-dates'
      ? 'Set a project start and end date to enable the burndown chart and velocity projection.'
      : 'Not enough data exists to determine velocity or project completion. Complete a few tasks to begin tracking velocity.';
  } else {
    noDataEl.classList.add('hidden');
    chartEl.innerHTML = buildBurndownChartSvg(project, burndown, 760, 280) +
      '<div class="kf-health-legend">' +
        '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:var(--kf-border-strong);"></span>Ideal pace</span>' +
        '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:#0c66e4;"></span>Actual remaining</span>' +
        '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:' + (burndown.isOverrun ? '#ae2e24' : 'var(--kf-text-faint)') + ';"></span>Projected</span>' +
      '</div>';
    if(burndown.isOverrun){
      warningEl.classList.remove('hidden');
      warningEl.innerHTML = '<span class="kf-icon" data-icon="warning" data-size="16"></span><span>At the current velocity (' +
        burndown.velocityPerWeek.toFixed(1) + ' tasks/week), remaining work is projected to finish on ' +
        escapeHTML(utcISOToLocalDisplayDate(new Date(burndown.projectedCompletionDate).toISOString())) +
        ' — after the planned end date of ' + escapeHTML(utcISOToLocalDisplayDate(new Date(burndown.endDate).toISOString())) + '.</span>';
      hydrateIcons(warningEl);
    } else {
      warningEl.classList.add('hidden');
    }
  }

  var riskMatrixSection = document.getElementById('healthRiskMatrixSection');
  var riskFeatureEnabled = normalizeHeaderButtonVisibility(project.headerButtonVisibility).risks;
  riskMatrixSection.classList.toggle('hidden', !riskFeatureEnabled);
  if(riskFeatureEnabled){
    var allRisks = project.risks || [];
    var matrixChartEl = document.getElementById('healthRiskMatrixChart');
    var matrixNoDataEl = document.getElementById('healthRiskMatrixNoData');
    var matrixLegendEl = document.getElementById('healthRiskMatrixLegend');
    if(allRisks.length === 0){
      matrixChartEl.innerHTML = '';
      matrixLegendEl.innerHTML = '';
      matrixNoDataEl.classList.remove('hidden');
      matrixNoDataEl.textContent = 'No risks logged yet — add one from the Risks button to plot it here.';
    } else {
      matrixNoDataEl.classList.add('hidden');
      matrixChartEl.innerHTML = buildRiskMatrixSvg(allRisks, 560);
      matrixLegendEl.innerHTML =
        '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:#1b2a4a;border-radius:50%;width:8px;height:8px;"></span>Solid marker = open/in review risk</span>' +
        '<span class="kf-health-legend-item kf-risk-matrix-point-faded" style="opacity:0.55;"><span class="kf-health-legend-swatch" style="background:#1b2a4a;border-radius:50%;width:8px;height:8px;"></span>Faded marker = closed risk</span>';
    }
  }

  var topMembers = computeTopTeamMembers(project);
  var topMembersEl = document.getElementById('healthTopMembers');
  if(topMembers.length === 0){
    topMembersEl.innerHTML = '<div class="kf-health-empty">No active tasks are currently assigned to any team member.</div>';
  } else {
    var maxCount = topMembers[0].count;
    topMembersEl.innerHTML = topMembers.map(function(row, idx){
      var barPct = maxCount > 0 ? (row.count / maxCount) * 100 : 0;
      return '<div class="kf-health-top-member-row">' +
        '<span class="kf-health-top-member-rank">' + (idx + 1) + '</span>' +
        '<span class="kf-avatar kf-avatar-sm" style="background:' + row.color + ';">' + escapeHTML(memberInitials(row.name)) + '</span>' +
        '<span class="kf-health-top-member-name">' + escapeHTML(memberLabel(row)) +
          (row.allocatedFraction != null ? ' <span class="kf-health-top-member-allocated">(' + row.allocatedFraction + '% allocated fraction)</span>' : '') +
          (row.role ? ' <span class="kf-health-top-member-role">' + escapeHTML(row.role) + '</span>' : '') + '</span>' +
        '<span class="kf-health-top-member-bar-track"><span class="kf-health-top-member-bar-fill" style="width:' + barPct + '%;"></span></span>' +
        '<span class="kf-health-top-member-count">' + row.count + '</span>' +
      '</div>';
    }).join('');
  }

  startHealthGaugeAnimation();
}
