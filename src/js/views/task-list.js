"use strict";
import { getTasksArray, getColumn, getMemberById, getTaskTypeById, getReleaseById, isTaskOverdue, isTaskBlocked, getTaskOverrunStatus } from '../utils.js';
import { getCurrentProject } from '../store.js';
import { ui } from '../ui.js';
import { getPriority } from '../ui.js';
import { iconSvg } from '../icons.js';
import { utcISOToLocalDisplayDate, utcISOToLocalDateValue, clampTaskScore, clampProgress, memberInitials } from '../date-utils.js';
import { PRIORITY_ORDER, PRIORITY_META } from '../config.js';
import { isTimeTrackingEnabled } from '../storage.js';

function escapeHTML(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
var _toast = function(msg){ console.error(msg); };
var _openTaskModal = function(){};
export function setTaskListDeps(deps){
  if(deps.toast) _toast = deps.toast;
  if(deps.openTaskModal) _openTaskModal = deps.openTaskModal;
}

/* =========================================================
   RELEASE STATUS HELPERS (local — not yet a shared module)
   ========================================================= */
var RELEASE_STATUS_META = {
  pending: {label: 'Pending'},
  in_progress: {label: 'In Progress'},
  deployed: {label: 'Deployed'}
};
function normalizeReleaseStatus(value){
  return RELEASE_STATUS_META.hasOwnProperty(value) ? value : 'pending';
}
function getReleaseStatusMeta(value){
  return RELEASE_STATUS_META[normalizeReleaseStatus(value)];
}

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

/* =========================================================
   TASK LIST VIEW
   ========================================================= */
export function computeValueProposition(task){
  var bv = clampTaskScore(task.businessValue);
  var tc = clampTaskScore(task.taskCost);
  return bv / tc;
}
export function valuePropClass(v){
  if(v > 1) return 'good';
  if(v < 1) return 'bad';
  return 'neutral';
}
export function formatValueProp(v){
  return v.toFixed(2);
}
/* Aggregate Value Proposition for a release: sum of Business Value
   across its tasks divided by the sum of Task Cost — a weighted
   ratio, not an average of each task's individual ratio. */
export function computeReleaseValueProposition(tasks){
  var totalValue = 0, totalCost = 0;
  tasks.forEach(function(t){
    totalValue += clampTaskScore(t.businessValue);
    totalCost += clampTaskScore(t.taskCost);
  });
  if(totalCost === 0) return 0;
  return totalValue / totalCost;
}

export var TASKLIST_COLUMNS = [
  {field:'key', label:'Key'},
  {field:'title', label:'Title'},
  {field:'column', label:'Column'},
  {field:'assignee', label:'Assignee'},
  {field:'priority', label:'Priority'},
  {field:'startDate', label:'Start'},
  {field:'endDate', label:'End'},
  {field:'valueProp', label:'Value Prop.'}
];
export var NO_RELEASE_GROUP_KEY = '__no_release__';

/* Progress is an opt-in extra column, appended at the end so its
   presence/absence never shifts the position of any other column
   (tests and muscle-memory both rely on those staying put). */
export function getTaskListColumns(project){
  return isTimeTrackingEnabled(project)
    ? TASKLIST_COLUMNS.concat([{field:'progress', label:'Progress'}])
    : TASKLIST_COLUMNS;
}

export function openTaskListOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  ui.taskListSearch = '';
  ui.taskListExpanded = new Set();
  ui.taskListCollapsedGroups = new Set();
  document.getElementById('taskListSearchInput').value = '';
  document.getElementById('taskListTitle').textContent = 'Task List — ' + project.name;
  renderTaskListHeader();
  renderTaskListBody();
  document.getElementById('taskListOverlay').classList.remove('hidden');
}
export function closeTaskListOverlay(){
  document.getElementById('taskListOverlay').classList.add('hidden');
}
export function isTaskListOpen(){
  return !document.getElementById('taskListOverlay').classList.contains('hidden');
}

export function renderTaskListHeader(){
  var header = document.getElementById('taskListHeader');
  var project = getCurrentProject();
  var timeTracking = isTimeTrackingEnabled(project);
  header.classList.toggle('kf-tasklist-has-progress', timeTracking);
  var html = '<div></div>'; // empty cell above the chevron column
  getTaskListColumns(project).forEach(function(col){
    var sorted = ui.taskListSort.field === col.field;
    var arrow = sorted ? (ui.taskListSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    html += '<div class="kf-tasklist-header-cell' + (sorted ? ' sorted' : '') + '" data-sort-field="' + col.field + '">' + escapeHTML(col.label) + arrow + '</div>';
  });
  header.innerHTML = html;
  header.querySelectorAll('[data-sort-field]').forEach(function(cell){
    cell.addEventListener('click', function(){
      var field = cell.getAttribute('data-sort-field');
      if(ui.taskListSort.field === field){
        ui.taskListSort.dir = ui.taskListSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        ui.taskListSort = {field: field, dir: 'asc'};
      }
      renderTaskListHeader();
      renderTaskListBody();
    });
  });
}

export function sortTaskListRows(project, rows){
  var field = ui.taskListSort.field;
  var dir = ui.taskListSort.dir === 'asc' ? 1 : -1;
  rows.sort(function(a, b){
    var av, bv;
    switch(field){
      case 'title':
        av = a.title.toLowerCase(); bv = b.title.toLowerCase();
        break;
      case 'column':
        av = project.columns.findIndex(function(c){ return c.id === a.columnId; });
        bv = project.columns.findIndex(function(c){ return c.id === b.columnId; });
        break;
      case 'assignee':
        av = (getMemberById(project, a.assigneeId) || {name:''}).name.toLowerCase();
        bv = (getMemberById(project, b.assigneeId) || {name:''}).name.toLowerCase();
        break;
      case 'priority':
        av = PRIORITY_ORDER.indexOf(a.priority); bv = PRIORITY_ORDER.indexOf(b.priority);
        break;
      case 'startDate':
        av = a.startDate ? new Date(a.startDate).getTime() : -Infinity;
        bv = b.startDate ? new Date(b.startDate).getTime() : -Infinity;
        break;
      case 'endDate':
        av = a.endDate ? new Date(a.endDate).getTime() : -Infinity;
        bv = b.endDate ? new Date(b.endDate).getTime() : -Infinity;
        break;
      case 'valueProp':
        av = computeValueProposition(a); bv = computeValueProposition(b);
        break;
      case 'progress':
        av = clampProgress(a.progress); bv = clampProgress(b.progress);
        break;
      case 'key':
      default:
        av = null; bv = null;
    }
    if(av === null){
      return a.key.localeCompare(b.key, undefined, {numeric:true}) * dir;
    }
    if(av < bv) return -1 * dir;
    if(av > bv) return 1 * dir;
    return a.key.localeCompare(b.key, undefined, {numeric:true});
  });
  return rows;
}

/* Shared by renderTaskListBody and the CSV export, so both can never
   drift out of sync with each other — the CSV always reflects exactly
   what's filtered and ordered on screen (just not collapse state,
   since that's a pure display concern, not a data one). */
export function getOrderedTaskListRows(project){
  var term = ui.taskListSearch.trim().toLowerCase();
  var rows = getTasksArray(project).filter(function(t){
    if(t.archived) return false;
    if(!term) return true;
    var hay = (t.key + ' ' + t.title + ' ' + (t.description||'')).toLowerCase();
    return hay.indexOf(term) !== -1;
  });

  var groups = {};
  rows.forEach(function(t){
    var key = t.releaseId || NO_RELEASE_GROUP_KEY;
    if(!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  var releaseGroupKeys = Object.keys(groups).filter(function(k){ return k !== NO_RELEASE_GROUP_KEY; });
  releaseGroupKeys.sort(function(aId, bId){
    var ra = getReleaseById(project, aId);
    var rb = getReleaseById(project, bId);
    var aHas = !!(ra && ra.startDate);
    var bHas = !!(rb && rb.startDate);
    if(aHas && bHas) return new Date(ra.startDate).getTime() - new Date(rb.startDate).getTime();
    if(aHas && !bHas) return -1;
    if(!aHas && bHas) return 1;
    var an = ra ? ra.name.toLowerCase() : '';
    var bn = rb ? rb.name.toLowerCase() : '';
    return an.localeCompare(bn);
  });
  var orderedGroupKeys = releaseGroupKeys.concat(groups.hasOwnProperty(NO_RELEASE_GROUP_KEY) ? [NO_RELEASE_GROUP_KEY] : []);

  var ordered = [];
  orderedGroupKeys.forEach(function(groupKey){
    var groupTasks = groups[groupKey];
    sortTaskListRows(project, groupTasks);
    ordered = ordered.concat(groupTasks);
  });
  return ordered;
}

export function renderTaskListBody(){
  var project = getCurrentProject();
  var body = document.getElementById('taskListBody');
  body.innerHTML = '';
  if(!project) return;

  var rows = getOrderedTaskListRows(project);

  document.getElementById('taskListCount').textContent = rows.length + ' task' + (rows.length === 1 ? '' : 's');

  if(rows.length === 0){
    body.innerHTML = '<div class="kf-tasklist-empty">No matching tasks.</div>';
    return;
  }

  /* Group by release, with releases ordered by startDate ascending.
     Releases with no startDate sort after dated ones (by name), and
     tasks with no release at all form their own group at the very end. */
  var groups = {};
  rows.forEach(function(t){
    var key = t.releaseId || NO_RELEASE_GROUP_KEY;
    if(!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  var releaseGroupKeys = Object.keys(groups).filter(function(k){ return k !== NO_RELEASE_GROUP_KEY; });
  releaseGroupKeys.sort(function(aId, bId){
    var ra = getReleaseById(project, aId);
    var rb = getReleaseById(project, bId);
    var aHas = !!(ra && ra.startDate);
    var bHas = !!(rb && rb.startDate);
    if(aHas && bHas) return new Date(ra.startDate).getTime() - new Date(rb.startDate).getTime();
    if(aHas && !bHas) return -1;
    if(!aHas && bHas) return 1;
    var an = ra ? ra.name.toLowerCase() : '';
    var bn = rb ? rb.name.toLowerCase() : '';
    return an.localeCompare(bn);
  });
  var orderedGroupKeys = releaseGroupKeys.concat(groups.hasOwnProperty(NO_RELEASE_GROUP_KEY) ? [NO_RELEASE_GROUP_KEY] : []);

  orderedGroupKeys.forEach(function(groupKey){
    var groupTasks = groups[groupKey];
    sortTaskListRows(project, groupTasks);
    var collapsed = ui.taskListCollapsedGroups.has(groupKey);
    body.appendChild(buildTaskListGroupHeader(project, groupKey, groupTasks, collapsed));
    if(collapsed) return;
    groupTasks.forEach(function(t){
      body.appendChild(buildTaskListRow(project, t));
      if(ui.taskListExpanded.has(t.id)){
        body.appendChild(renderTaskListDetail(project, t));
      }
    });
  });

  body.querySelectorAll('[data-toggle-id]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var id = btn.getAttribute('data-toggle-id');
      if(ui.taskListExpanded.has(id)) ui.taskListExpanded.delete(id);
      else ui.taskListExpanded.add(id);
      renderTaskListBody();
    });
  });

  body.querySelectorAll('[data-group-key]').forEach(function(header){
    header.addEventListener('click', function(){
      var key = header.getAttribute('data-group-key');
      if(ui.taskListCollapsedGroups.has(key)) ui.taskListCollapsedGroups.delete(key);
      else ui.taskListCollapsedGroups.add(key);
      renderTaskListBody();
    });
  });
}

/* =========================================================
   LIST VIEW: EXPORT AS CSV
   ========================================================= */
export function csvEscapeValue(value){
  var str = String(value == null ? '' : value);
  if(/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
export function buildTaskListCsv(project){
  var orderedTasks = getOrderedTaskListRows(project);
  var timeTracking = isTimeTrackingEnabled(project);
  var lines = [getTaskListColumns(project).map(function(c){ return csvEscapeValue(c.label); }).join(',')];
  orderedTasks.forEach(function(t){
    var assignee = getMemberById(project, t.assigneeId);
    var col = getColumn(project, t.columnId);
    var prio = getPriority(t.priority);
    var vp = computeValueProposition(t);
    var fields = [
      t.key,
      t.title,
      col ? col.name : '',
      assignee ? assignee.name : '',
      prio.label,
      t.startDate ? utcISOToLocalDisplayDate(t.startDate) : '',
      t.endDate ? utcISOToLocalDisplayDate(t.endDate) : '',
      formatValueProp(vp)
    ];
    if(timeTracking) fields.push(clampProgress(t.progress));
    lines.push(fields.map(csvEscapeValue).join(','));
  });
  return lines.join('\r\n');
}
export function exportTaskListAsCsv(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  var csv = buildTaskListCsv(project);
  var blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
  var filename = project.key + '-task-list-' + new Date().toISOString().slice(0,10) + '.csv';
  downloadBlob(blob, filename);
  _toast('Exported ' + filename);
}

export function buildTaskListGroupHeader(project, groupKey, groupTasks, collapsed){
  var header = document.createElement('div');
  header.className = 'kf-tasklist-group-header';
  header.setAttribute('data-group-key', groupKey);
  header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  var count = groupTasks.length;
  var chevronHTML = '<span class="kf-tasklist-chevron' + (collapsed ? '' : ' expanded') + '" aria-hidden="true">' + iconSvg('chevronDown', 14) + '</span>';

  var release = (groupKey !== NO_RELEASE_GROUP_KEY) ? getReleaseById(project, groupKey) : null;
  if(release){
    var statusMeta = getReleaseStatusMeta(release.status);
    var dateRangeText = (release.startDate || release.endDate)
      ? (release.startDate ? utcISOToLocalDisplayDate(release.startDate) : '—') + ' – ' + (release.endDate ? utcISOToLocalDisplayDate(release.endDate) : '—')
      : '';
    var vp = computeReleaseValueProposition(groupTasks);
    var vpClass = valuePropClass(vp);
    header.innerHTML =
      chevronHTML +
      '<span class="kf-tasklist-group-name">' + escapeHTML(release.name) + '</span>' +
      '<span class="kf-release-status-pill ' + normalizeReleaseStatus(release.status) + '">' + escapeHTML(statusMeta.label) + '</span>' +
      (dateRangeText ? '<span class="kf-tasklist-group-dates">' + escapeHTML(dateRangeText) + '</span>' : '') +
      '<span class="kf-tasklist-group-right">' +
        '<span class="kf-valueprop-pill ' + vpClass + '" title="Aggregate Value Proposition: total Business Value ÷ total Task Cost across this release\'s tasks">' + formatValueProp(vp) + '</span>' +
        '<span class="kf-tasklist-group-count">' + count + ' task' + (count === 1 ? '' : 's') + '</span>' +
      '</span>';
  } else {
    header.innerHTML =
      chevronHTML +
      '<span class="kf-tasklist-group-name kf-tasklist-group-name-none">No Release</span>' +
      '<span class="kf-tasklist-group-right">' +
        '<span class="kf-tasklist-group-count">' + count + ' task' + (count === 1 ? '' : 's') + '</span>' +
      '</span>';
  }
  return header;
}

/* "Collapse all" only collapses groups that currently have at least
   one matching task under the active search term — groups already
   hidden by the filter are left alone rather than silently affected. */
export function collapseAllTaskListGroups(){
  var project = getCurrentProject();
  if(!project) return;
  var term = ui.taskListSearch.trim().toLowerCase();
  var rows = getTasksArray(project).filter(function(t){
    if(t.archived) return false;
    if(!term) return true;
    var hay = (t.key + ' ' + t.title + ' ' + (t.description||'')).toLowerCase();
    return hay.indexOf(term) !== -1;
  });
  rows.forEach(function(t){
    ui.taskListCollapsedGroups.add(t.releaseId || NO_RELEASE_GROUP_KEY);
  });
  renderTaskListBody();
}
export function expandAllTaskListGroups(){
  ui.taskListCollapsedGroups = new Set();
  renderTaskListBody();
}

export function buildTaskListRow(project, t){
  var expanded = ui.taskListExpanded.has(t.id);
  var prio = getPriority(t.priority);
  var assignee = getMemberById(project, t.assigneeId);
  var overdue = isTaskOverdue(project, t);
  var vp = computeValueProposition(t);
  var vpClass = valuePropClass(vp);
  var col = getColumn(project, t.columnId);

  var assigneeHTML = assignee
    ? '<span class="kf-avatar kf-avatar-sm" style="background:' + assignee.color + ';">' + escapeHTML(memberInitials(assignee.name)) + '</span><span>' + escapeHTML(assignee.name) + '</span>'
    : '<span style="color:var(--kf-text-faint);">Unassigned</span>';

  var taskType = getTaskTypeById(project, t.typeId);
  var typeIconHTML = '';
  if(taskType && taskType.iconName){
    typeIconHTML = '<span class="kf-tasklist-type-icon" title="' + escapeHTML(taskType.name) + '">' + iconSvg(taskType.iconName, 13) + '</span>';
  }

  var timeTracking = isTimeTrackingEnabled(project);
  var progressHTML = '';
  if(timeTracking){
    var progress = clampProgress(t.progress);
    progressHTML = '<span class="kf-tasklist-progress" title="Progress: ' + progress + '%">' +
      '<span class="kf-progress-track"><span class="kf-progress-fill" style="width:' + progress + '%;"></span></span>' +
      '<span class="kf-progress-label">' + progress + '%</span>' +
    '</span>';
  }
  var overrun = timeTracking ? getTaskOverrunStatus(project, t) : null;

  var row = document.createElement('div');
  row.className = 'kf-tasklist-row' + (timeTracking ? ' kf-tasklist-has-progress' : '') +
    (overrun ? (overrun.level === 'over' ? ' kf-tasklist-row-over' : ' kf-tasklist-row-atrisk') : '');
  row.innerHTML =
    '<button type="button" class="kf-tasklist-chevron' + (expanded ? ' expanded' : '') + '" data-toggle-id="' + t.id + '" aria-label="Toggle details">' + iconSvg('chevronDown',14) + '</button>' +
    '<span class="kf-tasklist-key">' + typeIconHTML + escapeHTML(t.key) + '</span>' +
    '<span class="kf-tasklist-title" title="' + escapeHTML(t.title) + '">' + escapeHTML(t.title) + '</span>' +
    '<span class="kf-tasklist-column" title="' + escapeHTML(col ? col.name : '') + '">' + escapeHTML(col ? col.name : '—') + '</span>' +
    '<span class="kf-tasklist-assignee">' + assigneeHTML + '</span>' +
    '<span class="kf-priority-pill" style="color:' + prio.color + ';background:' + prio.bg + ';">' + iconSvg(prio.icon,12) + escapeHTML(prio.label) + '</span>' +
    '<span class="kf-tasklist-date">' + (t.startDate ? escapeHTML(utcISOToLocalDisplayDate(t.startDate)) : '—') + '</span>' +
    '<span class="kf-tasklist-date' + (overdue ? ' overdue' : '') + '">' + (t.endDate ? escapeHTML(utcISOToLocalDisplayDate(t.endDate)) : '—') + '</span>' +
    '<span class="kf-valueprop-pill ' + vpClass + '" title="Business Value ' + t.businessValue + ' ÷ Task Cost ' + t.taskCost + '">' + formatValueProp(vp) + '</span>' +
    progressHTML;
  return row;
}

export function renderTaskListDetail(project, t){
  var blocked = isTaskBlocked(project, t);
  var overdue = isTaskOverdue(project, t);
  var col = getColumn(project, t.columnId);
  var depKeys = (t.dependencies || []).map(function(id){
    var d = project.tasks[id];
    return d ? d.key : null;
  }).filter(Boolean);

  var badgesHTML = '';
  if(blocked) badgesHTML += '<span class="kf-blocked-chip">' + iconSvg('warning',12) + 'Blocked</span>';
  if(overdue) badgesHTML += '<span class="kf-overdue-chip">' + iconSvg('clock',12) + 'Overdue</span>';

  var detail = document.createElement('div');
  detail.className = 'kf-tasklist-detail';
  detail.innerHTML =
    (t.description ? '<div>' + escapeHTML(t.description) + '</div>' : '<div style="color:var(--kf-text-faint);">No description.</div>') +
    (badgesHTML ? '<div style="margin-top:8px;display:flex;gap:6px;">' + badgesHTML + '</div>' : '') +
    '<div class="kf-tasklist-detail-grid">' +
      '<div><div class="kf-tasklist-detail-label">Column</div><div class="kf-tasklist-detail-value">' + escapeHTML(col ? col.name : '—') + '</div></div>' +
      '<div><div class="kf-tasklist-detail-label">Business Value</div><div class="kf-tasklist-detail-value">' + t.businessValue + '</div></div>' +
      '<div><div class="kf-tasklist-detail-label">Task Cost</div><div class="kf-tasklist-detail-value">' + t.taskCost + '</div></div>' +
      '<div><div class="kf-tasklist-detail-label">Depends on</div><div class="kf-tasklist-detail-value">' + (depKeys.length ? escapeHTML(depKeys.join(', ')) : '—') + '</div></div>' +
    '</div>' +
    '<button type="button" class="kf-btn kf-btn-secondary kf-tasklist-edit-btn" data-edit-id="' + t.id + '"><span class="kf-icon">' + iconSvg('edit',13) + '</span>Edit task</button>';

  detail.querySelector('[data-edit-id]').addEventListener('click', function(){
    closeTaskListOverlay();
    _openTaskModal(t.id, t.columnId);
  });

  return detail;
}
