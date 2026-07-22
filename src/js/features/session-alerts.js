"use strict";

/* =========================================================
   PROJECT ALERT CHECKS
   Chains: checkOverdueAlert -> checkOverrunAlert -> checkDefaultScoreAlert
           -> checkBackupReminders -> advanceBackupQueue.
   Each function shows its own modal (if it has something to say) and
   otherwise falls through to the next link, so dismissing one alert
   immediately reveals the next. `checkProjectAlerts()` is the one
   public entry point — call it any time the user starts looking at a
   (possibly different) project: on initial app load, and again on
   every project switch (the project selector, deleting the current
   project, importing/overwriting a project, or creating a new one).
   ========================================================= */
import { state, isTimeTrackingEnabled } from '../storage.js';
import { getCurrentProject } from '../store.js';
import { hydrateIcons } from '../icons.js';
import { clampTaskScore, utcISOToLocalDisplayDate } from '../date-utils.js';
import { getTasksArray, isTaskOverdue, isTaskUnscored, getTaskOverrunStatus, escapeHTML } from '../utils.js';
import { exportProjectJSON } from './export.js';
import { isServerAuthoritative, isServerLoggedIn } from './migration.js';
import { announcementState, getUnacknowledgedAnnouncements, getActiveDisruptions, acknowledgeAnnouncement, refreshAnnouncementData } from './announcements.js';
import { markdownToHtml } from '../rich-text/markdown.js';

var BACKUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
var backupQueue = [];

export function checkProjectAlerts(){
  // Local-only sessions have no org/announcements concept at all (isServerAuthoritative-style
  // gating, see root CLAUDE.md §5) — skip straight to the existing per-project chain for them.
  // A logged-in session re-fetches fresh active announcements first (rather than trusting whatever
  // announcementState already held from a previous call) since this can run at page-load time before
  // app.js's own initAnnouncements() call for the "still logged in" reload path has had a chance to.
  if(isServerLoggedIn()){
    refreshAnnouncementData().then(checkAnnouncementsAlert);
  } else {
    checkOverdueAlert();
  }
}

/* First link in the chain — Org-Admin-curated broadcast content takes precedence over the automatic
   per-project checks below. Unlike those (one category at a time), this shows ONE modal listing
   every currently-active, unacknowledged announcement (Kind='announcement' only — disruption notices
   are never acknowledged/queued here, they're a persistent banner instead, see
   renderDisruptionBanner()) as a digest list, each with its own "Don't show this one again" checkbox,
   and a single close button that acknowledges whichever are checked. */
function checkAnnouncementsAlert(){
  var items = getUnacknowledgedAnnouncements();
  if(items.length === 0){ checkOverdueAlert(); return; }

  var listEl = document.getElementById('announcementsAlertList');
  listEl.innerHTML = items.map(function(a, i){
    return '<div class="kf-announcement-alert-row">' +
      '<div class="kf-announcement-alert-title">' + escapeHTML(a.title) + '</div>' +
      '<div class="kf-announcement-alert-body">' + markdownToHtml(a.body || '') + '</div>' +
      '<label class="kf-announcement-alert-ack">' +
        '<input type="checkbox" data-announcement-id="' + a.id + '"> Don’t show this one again' +
      '</label>' +
    '</div>';
  }).join('');

  document.getElementById('announcementsAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('announcementsAlertOverlay'));
}

export function closeAnnouncementsAlert(){
  var overlay = document.getElementById('announcementsAlertOverlay');
  overlay.querySelectorAll('input[data-announcement-id]:checked').forEach(function(cb){
    acknowledgeAnnouncement(cb.getAttribute('data-announcement-id'));
  });
  overlay.classList.add('hidden');
  checkOverdueAlert();
}

function checkOverdueAlert(){
  var project = getCurrentProject();
  if(!project){ checkOverrunAlert(); return; }

  var overdueTasks = getTasksArray(project).filter(function(t){ return isTaskOverdue(project, t); });
  if(overdueTasks.length === 0){ checkOverrunAlert(); return; }

  overdueTasks.sort(function(a, b){ return new Date(a.endDate).getTime() - new Date(b.endDate).getTime(); });

  var msg = '“' + project.name + '” has ' + overdueTasks.length + ' task' +
            (overdueTasks.length === 1 ? '' : 's') + ' with an end date in the past.';
  document.getElementById('overdueAlertMessage').textContent = msg;

  var listEl = document.getElementById('overdueAlertList');
  listEl.innerHTML = '';
  var maxShown = 6;
  overdueTasks.slice(0, maxShown).forEach(function(t){
    var row = document.createElement('div');
    row.className = 'kf-overdue-alert-row';
    var d = document.createElement('div');
    d.innerHTML =
      '<span class="kf-dep-key"></span>' +
      '<span class="kf-overdue-alert-title"></span>' +
      '<span class="kf-overdue-alert-date"></span>';
    d.querySelector('.kf-dep-key').textContent = t.key;
    d.querySelector('.kf-overdue-alert-title').textContent = t.title;
    d.querySelector('.kf-overdue-alert-date').textContent = utcISOToLocalDisplayDate(t.endDate);
    row.appendChild(d.querySelector('.kf-dep-key'));
    row.appendChild(d.querySelector('.kf-overdue-alert-title'));
    row.appendChild(d.querySelector('.kf-overdue-alert-date'));
    listEl.appendChild(row);
  });
  if(overdueTasks.length > maxShown){
    var more = document.createElement('div');
    more.className = 'kf-overdue-alert-more';
    more.textContent = '+ ' + (overdueTasks.length - maxShown) + ' more';
    listEl.appendChild(more);
  }

  document.getElementById('overdueAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('overdueAlertOverlay'));
}

export function closeOverdueAlert(){
  document.getElementById('overdueAlertOverlay').classList.add('hidden');
  checkOverrunAlert();
}

/* Per-task overrun prediction (see getTaskOverrunStatus in utils.js) —
   only ever shows the 'atRisk' (predicted) tasks; 'over' tasks are
   either already covered by the Overdue alert above (date case) or
   just get a red card/row border with no separate nag here (effort
   case). Current-project-only, same scope as the two alerts it sits
   between. */
function checkOverrunAlert(){
  var project = getCurrentProject();
  if(!project){ checkDefaultScoreAlert(); return; }
  if(!isTimeTrackingEnabled(project)){ checkDefaultScoreAlert(); return; }

  var atRiskTasks = getTasksArray(project)
    .map(function(t){ return {task: t, status: getTaskOverrunStatus(project, t)}; })
    .filter(function(entry){ return entry.status && entry.status.level === 'atRisk'; });
  if(atRiskTasks.length === 0){ checkDefaultScoreAlert(); return; }

  atRiskTasks.sort(function(a, b){ return a.task.key.localeCompare(b.task.key, undefined, {numeric: true}); });

  var msg = '“' + project.name + '” has ' + atRiskTasks.length + ' task' +
            (atRiskTasks.length === 1 ? '' : 's') + ' predicted to run over.';
  document.getElementById('overrunAlertMessage').textContent = msg;

  var listEl = document.getElementById('overrunAlertList');
  listEl.innerHTML = '';
  var maxShown = 6;
  atRiskTasks.slice(0, maxShown).forEach(function(entry){
    var t = entry.task;
    var row = document.createElement('div');
    row.className = 'kf-overrun-alert-row';
    var main = document.createElement('div');
    main.className = 'kf-overrun-alert-row-main';
    var keyEl = document.createElement('span');
    keyEl.className = 'kf-dep-key';
    keyEl.textContent = t.key;
    var titleEl = document.createElement('span');
    titleEl.className = 'kf-overrun-alert-title';
    titleEl.textContent = t.title;
    main.appendChild(keyEl);
    main.appendChild(titleEl);
    var reasonEl = document.createElement('div');
    reasonEl.className = 'kf-overrun-alert-reason';
    reasonEl.textContent = entry.status.reasons.map(function(r){ return r.message; }).join(' · ');
    row.appendChild(main);
    row.appendChild(reasonEl);
    listEl.appendChild(row);
  });
  if(atRiskTasks.length > maxShown){
    var more = document.createElement('div');
    more.className = 'kf-overrun-alert-more';
    more.textContent = '+ ' + (atRiskTasks.length - maxShown) + ' more';
    listEl.appendChild(more);
  }

  document.getElementById('overrunAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('overrunAlertOverlay'));
}

export function closeOverrunAlert(){
  document.getElementById('overrunAlertOverlay').classList.add('hidden');
  checkDefaultScoreAlert();
}

function checkDefaultScoreAlert(){
  var project = getCurrentProject();
  if(!project){ checkBackupReminders(); return; }

  var unscoredTasks = getTasksArray(project).filter(function(t){
    return !t.archived && isTaskUnscored(t);
  });
  if(unscoredTasks.length === 0){ checkBackupReminders(); return; }

  unscoredTasks.sort(function(a, b){ return a.key.localeCompare(b.key, undefined, {numeric: true}); });

  var msg = project.name + ' has ' + unscoredTasks.length + ' task' +
            (unscoredTasks.length === 1 ? '' : 's') + ' that ' + (unscoredTasks.length === 1 ? 'has not' : 'have not') + ' been scored — ' +
            'Business Value and Task Cost are still at the default of 1.';
  document.getElementById('defaultScoreAlertMessage').textContent = msg;

  var listEl = document.getElementById('defaultScoreAlertList');
  listEl.innerHTML = '';
  var maxShown = 6;
  unscoredTasks.slice(0, maxShown).forEach(function(t){
    var row = document.createElement('div');
    row.className = 'kf-defaultscore-alert-row';
    var keyEl = document.createElement('span');
    keyEl.className = 'kf-dep-key';
    keyEl.textContent = t.key;
    var titleEl = document.createElement('span');
    titleEl.className = 'kf-defaultscore-alert-title';
    titleEl.textContent = t.title;
    var scoreEl = document.createElement('span');
    scoreEl.className = 'kf-defaultscore-alert-scores';
    scoreEl.textContent = 'BV ' + clampTaskScore(t.businessValue) + ' · Cost ' + clampTaskScore(t.taskCost);
    row.appendChild(keyEl);
    row.appendChild(titleEl);
    row.appendChild(scoreEl);
    listEl.appendChild(row);
  });
  if(unscoredTasks.length > maxShown){
    var more = document.createElement('div');
    more.className = 'kf-defaultscore-alert-more';
    more.textContent = '+ ' + (unscoredTasks.length - maxShown) + ' more';
    listEl.appendChild(more);
  }

  document.getElementById('defaultScoreAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('defaultScoreAlertOverlay'));
}

export function closeDefaultScoreAlert(){
  document.getElementById('defaultScoreAlertOverlay').classList.add('hidden');
  checkBackupReminders();
}

/* Unlike the three checks above (current-project-only, freshly
   recomputed from scratch each call), this one scans every project and
   accumulates into a shared queue — since it can now be triggered many
   times in a session (not just once at startup), pids already queued
   are skipped rather than re-pushed, so switching projects repeatedly
   before working through the queue can't pile up duplicate entries. */
function checkBackupReminders(){
  var db = state.db;
  var now = Date.now();
  db.projectOrder.forEach(function(pid){
    var p = db.projects[pid];
    if(!p) return;
    // Cloud (server-authoritative) projects live safely on the server — a local JSON export isn't
    // the only copy of their data the way it is for a local-only project, so they never need this
    // nag regardless of how long it's been since one was last exported.
    if(isServerAuthoritative(p)) return;
    var referenceDate = p.dateLastExported || p.dateCreated || null;
    if(!referenceDate) return;
    var age = now - new Date(referenceDate).getTime();
    if(age > BACKUP_THRESHOLD_MS && backupQueue.indexOf(pid) === -1){
      backupQueue.push(pid);
    }
  });
  advanceBackupQueue();
}

function advanceBackupQueue(){
  if(backupQueue.length === 0) return;
  var db = state.db;
  var pid = backupQueue[0];
  var project = db.projects[pid];
  if(!project){ backupQueue.shift(); advanceBackupQueue(); return; }

  var refDate = project.dateLastExported || project.dateCreated;
  var daysSince = Math.floor((Date.now() - new Date(refDate).getTime()) / (24 * 60 * 60 * 1000));
  var action = project.dateLastExported ? 'last backed up' : 'created';
  var msg =
    '“' + project.name + '” (' + project.key + ') was ' + action + ' ' + daysSince +
    ' day' + (daysSince === 1 ? '' : 's') + ' ago and has no recent backup. ' +
    'Would you like to export a backup now?';

  document.getElementById('backupReminderMessage').textContent = msg;
  document.getElementById('backupReminderOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('backupReminderOverlay'));
}

export function closeBackupReminderModal(){
  document.getElementById('backupReminderOverlay').classList.add('hidden');
}

export function dismissBackupReminder(){
  backupQueue.shift();
  closeBackupReminderModal();
  if(backupQueue.length > 0){
    setTimeout(advanceBackupQueue, 300);
  }
}

export function runBackupForReminder(){
  var db = state.db;
  var pid = backupQueue[0];
  var project = pid ? db.projects[pid] : null;
  closeBackupReminderModal();
  backupQueue.shift();
  if(project){
    exportProjectJSON(project);
  }
  if(backupQueue.length > 0){
    setTimeout(advanceBackupQueue, 400);
  }
}

/* =========================================================
   ALERT STATUS (header button) — a pure, read-only re-derivation of the same four checks above
   (overdue / overrun / unscored / backup), WITHOUT opening any of their modals or touching
   backupQueue. Lets "what would I see if I reloaded right now" be answered on demand from the
   header, rather than only ever appearing once at load/project-switch time. Each individual check
   above stays exactly as it was (chained modals) — this is a separate, side-effect-free summary
   using the same predicates, not a replacement for them.
   ========================================================= */
export function summarizeProjectAlerts(){
  var alerts = [];

  // Announcements/Disruption Notices always show here regardless of acknowledgment state — Alert
  // Status is "what's currently being communicated," even for things already dismissed from the
  // session-start digest modal (checkAnnouncementsAlert above).
  announcementState.active.forEach(function(a){
    alerts.push({
      icon: a.kind === 'disruption' ? 'warning' : 'bell',
      message: a.title
    });
  });

  var project = getCurrentProject();

  if(project){
    var overdueTasks = getTasksArray(project).filter(function(t){ return isTaskOverdue(project, t); });
    if(overdueTasks.length > 0){
      alerts.push({
        icon: 'clock',
        message: overdueTasks.length + ' task' + (overdueTasks.length === 1 ? '' : 's') + ' with an end date in the past.'
      });
    }

    if(isTimeTrackingEnabled(project)){
      var atRiskCount = getTasksArray(project).filter(function(t){
        var status = getTaskOverrunStatus(project, t);
        return status && status.level === 'atRisk';
      }).length;
      if(atRiskCount > 0){
        alerts.push({
          icon: 'warning',
          message: atRiskCount + ' task' + (atRiskCount === 1 ? '' : 's') + ' predicted to run over.'
        });
      }
    }

    var unscoredCount = getTasksArray(project).filter(function(t){ return !t.archived && isTaskUnscored(t); }).length;
    if(unscoredCount > 0){
      alerts.push({
        icon: 'target',
        message: unscoredCount + ' task' + (unscoredCount === 1 ? '' : 's') + ' not yet scored (Business Value / Task Cost still at default).'
      });
    }
  }

  // Backup reminders are cross-project, same scope checkBackupReminders itself uses — summarized
  // here as one combined row rather than one row per overdue project.
  var db = state.db;
  var now = Date.now();
  var overdueBackupCount = db.projectOrder.filter(function(pid){
    var p = db.projects[pid];
    if(!p || isServerAuthoritative(p)) return false;
    var referenceDate = p.dateLastExported || p.dateCreated || null;
    if(!referenceDate) return false;
    return (now - new Date(referenceDate).getTime()) > BACKUP_THRESHOLD_MS;
  }).length;
  if(overdueBackupCount > 0){
    alerts.push({
      icon: 'download',
      message: overdueBackupCount + ' local project' + (overdueBackupCount === 1 ? '' : 's') + ' overdue for a backup export.'
    });
  }

  return alerts;
}

export function renderAlertStatusPanel(){
  var panel = document.getElementById('alertStatusPanel');
  var alerts = summarizeProjectAlerts();
  if(alerts.length === 0){
    panel.innerHTML = '<div class="kf-alert-status-empty">No alerts right now.</div>';
  } else {
    panel.innerHTML = alerts.map(function(a){
      return '<div class="kf-alert-status-row"><span class="kf-icon" data-icon="' + a.icon + '" data-size="15"></span><span>' +
        escapeHTML(a.message) +
        '</span></div>';
    }).join('');
  }
  hydrateIcons(panel);
}
