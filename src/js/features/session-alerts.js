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
import { getTasksArray, isTaskOverdue, isTaskUnscored, getTaskOverrunStatus } from '../utils.js';
import { exportProjectJSON } from './export.js';

var BACKUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
var backupQueue = [];

export function checkProjectAlerts(){
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
