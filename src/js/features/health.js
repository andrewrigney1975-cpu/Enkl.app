"use strict";
import { getTasksArray, getColumn, getMemberById, isTaskOverdue, isTaskUnscored } from '../utils.js';
import { normalizeReleaseStatus, normalizeRiskStatus, normalizeDecisionStatus } from '../mutations.js';
import { utcISOToLocalDisplayDate } from '../date-utils.js';

/* =========================================================
   PROJECT HEALTH DASHBOARD — data layer
   Every individual condition is expressed as "% in a healthy state"
   so they all combine consistently: higher is always better, on
   every metric, everywhere in this dashboard. A null pct means
   "no data to measure" (e.g. zero risks exist) rather than 0% or
   100%, so an empty category is never mistaken for either a perfect
   or a failing score.
   ========================================================= */
export function healthPct(numerator, denominator){
  if(denominator <= 0) return null;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

/* 0-1 fraction of how far today sits within the project's own
   start/end date range, or null if there's no usable range. */
export function computeTimelineProgress(project){
  if(!project.startDate || !project.endDate) return null;
  var start = new Date(project.startDate).getTime();
  var end = new Date(project.endDate).getTime();
  if(!isFinite(start) || !isFinite(end) || end <= start) return null;
  return Math.max(0, Math.min(1, (Date.now() - start) / (end - start)));
}

/* ---- Releases ---- */
export function isReleasePastDue(release){
  if(!release.endDate) return false;
  if(normalizeReleaseStatus(release.status) === 'deployed') return false;
  var end = new Date(release.endDate).getTime();
  return isFinite(end) && end < Date.now();
}
export function computeReleasesHealth(project){
  var releases = project.releases || [];
  if(releases.length === 0) return {pct: null, total: 0, onTrackCount: 0};
  var onTrackCount = releases.filter(function(r){ return !isReleasePastDue(r); }).length;
  return {pct: healthPct(onTrackCount, releases.length), total: releases.length, onTrackCount: onTrackCount};
}

/* ---- Tasks ----
   Done% weight scales from 10% of the gauge at project start up to
   90% near the end (the remaining three conditions evenly split
   whatever weight Done% isn't using). With no usable project
   timeline, all four conditions are weighted equally instead, rather
   than fabricating urgency that doesn't exist. */
export function computeTasksHealth(project){
  var tasks = getTasksArray(project).filter(function(t){ return !t.archived; });
  var total = tasks.length;
  if(total === 0){
    return {pct: null, donePct: null, onSchedulePct: null, scoredPct: null, releaseAssignedPct: null, timelineProgress: null, doneWeight: null};
  }

  var doneTasks = tasks.filter(function(t){ var c = getColumn(project, t.columnId); return c && c.done; });
  var nonDoneTasks = tasks.filter(function(t){ var c = getColumn(project, t.columnId); return !(c && c.done); });

  var donePct = healthPct(doneTasks.length, total);

  var datedNonDone = nonDoneTasks.filter(function(t){ return !!t.endDate; });
  var onScheduleCount = datedNonDone.filter(function(t){ return !isTaskOverdue(project, t); }).length;
  var onSchedulePct = healthPct(onScheduleCount, datedNonDone.length);

  var scoredCount = tasks.filter(function(t){ return !isTaskUnscored(t); }).length;
  var scoredPct = healthPct(scoredCount, total);

  var releaseAssignedCount = nonDoneTasks.filter(function(t){ return !!t.releaseId; }).length;
  var releaseAssignedPct = healthPct(releaseAssignedCount, nonDoneTasks.length);

  var timelineProgress = computeTimelineProgress(project);
  var doneWeight, otherWeight;
  if(timelineProgress === null){
    doneWeight = 0.25; otherWeight = 0.25;
  } else {
    doneWeight = 0.1 + 0.8 * timelineProgress;
    otherWeight = (1 - doneWeight) / 3;
  }

  var parts = [], weights = [];
  if(donePct !== null){ parts.push(donePct); weights.push(doneWeight); }
  if(onSchedulePct !== null){ parts.push(onSchedulePct); weights.push(otherWeight); }
  if(scoredPct !== null){ parts.push(scoredPct); weights.push(otherWeight); }
  if(releaseAssignedPct !== null){ parts.push(releaseAssignedPct); weights.push(otherWeight); }
  var totalWeight = weights.reduce(function(a,b){ return a + b; }, 0);
  var weightedPct = totalWeight > 0
    ? parts.reduce(function(sum, p, i){ return sum + p * weights[i]; }, 0) / totalWeight
    : null;

  return {
    pct: weightedPct,
    donePct: donePct, onSchedulePct: onSchedulePct, scoredPct: scoredPct, releaseAssignedPct: releaseAssignedPct,
    timelineProgress: timelineProgress, doneWeight: doneWeight
  };
}

/* ---- Risks ----
   "Closed by target date" covers both: a risk still open whose
   target date has already passed, AND a risk that was eventually
   closed but only after its target date had already passed. */
export function isRiskClosedLate(risk){
  if(!risk.dateToClose) return false;
  var target = new Date(risk.dateToClose).getTime();
  if(!isFinite(target)) return false;
  if(normalizeRiskStatus(risk.status) === 'closed'){
    if(!risk.dateClosed) return false;
    var closed = new Date(risk.dateClosed).getTime();
    return isFinite(closed) && closed > target;
  }
  return target < Date.now();
}
export function computeRisksHealth(project){
  var risks = project.risks || [];
  if(risks.length === 0) return {pct: null, mitigatedPct: null, closedPct: null, closedOnTimePct: null, ownedPct: null};

  var mitigatedCount = risks.filter(function(r){ return (r.mitigations || '').trim().length > 0; }).length;
  var closedCount = risks.filter(function(r){ return normalizeRiskStatus(r.status) === 'closed'; }).length;
  var closedOnTimeCount = risks.filter(function(r){ return !isRiskClosedLate(r); }).length;
  var ownedCount = risks.filter(function(r){ return !!r.ownerId; }).length;

  var mitigatedPct = healthPct(mitigatedCount, risks.length);
  var closedPct = healthPct(closedCount, risks.length);
  var closedOnTimePct = healthPct(closedOnTimeCount, risks.length);
  var ownedPct = healthPct(ownedCount, risks.length);

  var parts = [mitigatedPct, closedPct, closedOnTimePct, ownedPct].filter(function(p){ return p !== null; });
  var pct = parts.length > 0 ? parts.reduce(function(a,b){ return a+b; }, 0) / parts.length : null;

  return {pct: pct, mitigatedPct: mitigatedPct, closedPct: closedPct, closedOnTimePct: closedOnTimePct, ownedPct: ownedPct};
}

/* ---- Decisions ---- */
export function computeDecisionsHealth(project){
  var decisions = project.decisions || [];
  if(decisions.length === 0) return {pct: null, completedPct: null, ownedPct: null};

  var completedCount = decisions.filter(function(d){ return normalizeDecisionStatus(d.status) === 'completed'; }).length;
  var ownedCount = decisions.filter(function(d){ return !!d.ownerId; }).length;
  var completedPct = healthPct(completedCount, decisions.length);
  var ownedPct = healthPct(ownedCount, decisions.length);

  var parts = [completedPct, ownedPct].filter(function(p){ return p !== null; });
  var pct = parts.length > 0 ? parts.reduce(function(a,b){ return a+b; }, 0) / parts.length : null;

  return {pct: pct, completedPct: completedPct, ownedPct: ownedPct};
}

/* ---- Burndown / velocity ----
   Velocity is inferred from dateDone on tasks currently sitting in a
   Done column — the timestamp set when a task actually transitions
   into Done (see moveTaskToColumn in mutations.js), not touched by
   later unrelated edits the way dateLastModified is — over a trailing
   4-week window. If there's no completed-task history to measure
   from, hasEnoughData is false and the caller must show an explicit
   "not enough data" message rather than fabricate a projection. */
export var BURNDOWN_VELOCITY_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
export var MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
export function computeBurndownData(project){
  var tasks = getTasksArray(project).filter(function(t){ return !t.archived; });
  var total = tasks.length;
  var doneTasks = tasks.filter(function(t){ var c = getColumn(project, t.columnId); return c && c.done; });
  var remainingCount = total - doneTasks.length;

  if(!project.startDate || !project.endDate){
    return {hasEnoughData: false, reason: 'no-dates', remainingCount: remainingCount, total: total, doneCount: doneTasks.length};
  }
  var start = new Date(project.startDate).getTime();
  var end = new Date(project.endDate).getTime();
  if(!isFinite(start) || !isFinite(end) || end <= start){
    return {hasEnoughData: false, reason: 'no-dates', remainingCount: remainingCount, total: total, doneCount: doneTasks.length};
  }

  var now = Date.now();
  var windowStart = now - BURNDOWN_VELOCITY_WINDOW_MS;
  var completedInWindow = doneTasks.filter(function(t){
    var doneAt = t.dateDone ? new Date(t.dateDone).getTime() : NaN;
    return isFinite(doneAt) && doneAt >= windowStart && doneAt <= now;
  }).length;

  if(doneTasks.length === 0 || completedInWindow === 0){
    return {hasEnoughData: false, reason: 'no-velocity', remainingCount: remainingCount, total: total, doneCount: doneTasks.length, startDate: start, endDate: end};
  }

  var elapsedSinceStart = Math.max(now - start, 1);
  var windowWeeks = Math.min(BURNDOWN_VELOCITY_WINDOW_MS, elapsedSinceStart) / MS_PER_WEEK;
  var velocityPerWeek = completedInWindow / Math.max(windowWeeks, 1 / 7);

  var weeksToFinish = remainingCount / velocityPerWeek;
  var projectedCompletionDate = now + weeksToFinish * MS_PER_WEEK;
  var isOverrun = remainingCount > 0 && projectedCompletionDate > end;

  return {
    hasEnoughData: true,
    remainingCount: remainingCount, total: total, doneCount: doneTasks.length,
    velocityPerWeek: velocityPerWeek,
    projectedCompletionDate: projectedCompletionDate,
    isOverrun: isOverrun,
    startDate: start, endDate: end
  };
}

/* Overall Health's overrun penalty scales with how far through the
   timeline the project already is — a small deduction if an overrun
   is projected early (plenty of runway to recover), a much larger one
   if it's projected late, mirroring the same urgency curve used for
   Done% weighting in the Tasks gauge. */
export function computeOverrunPenalty(project, burndown){
  if(!burndown.hasEnoughData || !burndown.isOverrun) return 0;
  var timelineProgress = computeTimelineProgress(project);
  var progress = timelineProgress === null ? 0.5 : timelineProgress;
  return 5 + 25 * progress;
}

/* ---- Overall Health ----
   Equal-weighted average of the 4 composite gauges (categories with
   no data at all are excluded from the average, not counted as 0),
   reduced by the burndown overrun penalty. */
export function computeOverallHealth(project){
  var releases = computeReleasesHealth(project);
  var tasksHealth = computeTasksHealth(project);
  var risks = computeRisksHealth(project);
  var decisions = computeDecisionsHealth(project);
  var burndown = computeBurndownData(project);

  var parts = [releases.pct, tasksHealth.pct, risks.pct, decisions.pct].filter(function(p){ return p !== null; });
  var basePct = parts.length > 0 ? parts.reduce(function(a,b){ return a+b; }, 0) / parts.length : null;

  var penalty = basePct === null ? 0 : computeOverrunPenalty(project, burndown);
  var overallPct = basePct === null ? null : Math.max(0, basePct - penalty);

  return {
    overallPct: overallPct,
    releases: releases, tasks: tasksHealth, risks: risks, decisions: decisions, burndown: burndown,
    overrunPenalty: penalty
  };
}

/* ---- Top N team members by active & remaining work ----
   Counts only non-archived, non-Done tasks (current workload, not lifetime total). Excludes
   Unassigned. Ties broken alphabetically. Default behavior (no options) is unchanged from before:
   top 5, grouped by each task's own project-scoped assigneeId (memberId).

   options.limit: how many rows to return (default 5).
   options.groupByUserId: the Portfolio Dashboard's cross-project use — the SAME person has a
   DIFFERENT memberId (ProjectMember.Id) in each project they're on, so grouping by raw assigneeId
   would undercount them as several different people. When true, groups by each resolved member's
   userId instead (available once the aggregate payload's members carry it — see
   modals/portfolio-dashboard.js's buildPortfolioPseudoProject) — a real, org-stable identity, unlike
   memberId which only makes sense within one project. */
export function computeTopTeamMembers(project, options){
  options = options || {};
  var limit = options.limit || 5;
  var groupByUserId = !!options.groupByUserId;

  var counts = {};
  var infoByKey = {};
  getTasksArray(project).filter(function(t){ return !t.archived; }).forEach(function(t){
    if(!t.assigneeId) return;
    var c = getColumn(project, t.columnId);
    if(c && c.done) return;
    var m = getMemberById(project, t.assigneeId);
    var key = (groupByUserId && m && m.userId) ? m.userId : t.assigneeId;
    counts[key] = (counts[key] || 0) + 1;
    if(!infoByKey[key]){
      infoByKey[key] = {name: m ? m.name : 'Unknown', role: m ? (m.role || null) : null, color: m ? m.color : '#8993a4'};
    }
  });
  var rows = Object.keys(counts).map(function(key){
    var info = infoByKey[key];
    return {memberId: key, name: info.name, role: info.role, color: info.color, count: counts[key]};
  });
  rows.sort(function(a, b){
    if(b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return rows.slice(0, limit);
}
