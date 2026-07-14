"use strict";
import { ui, toast, getPriority } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { getTasksArray, getDescendants, wouldCreateCycle, getColumn, getMemberById, getReleaseById, getTaskTypeById, getTaskAncestorIds, getSubtasksOf, getSubtaskDescendantIds, wouldCreateParentCycle } from '../utils.js';
import { clampTaskScore, clampProgress, clampEffortHours, utcISOToLocalDateValue, utcISOToLocalDisplayDate, utcISOToLocalDisplayDateTime, localDateValueToUTCISO, defaultStartDateValue, defaultEndDateValue, isoToServerDateOnly } from '../date-utils.js';
import { iconSvg } from '../icons.js';
import { PRIORITY_ORDER } from '../config.js';
import { escapeHTML, renderBoard, fitBoardForTaskModal, restoreBoardAfterTaskModal } from '../views/board.js';
import { addTask, updateTask, deleteTask, normalizeDocumentationUrl, getAuditFieldLabel, setTaskSubtasks } from '../mutations.js';
import { normalizeHeaderButtonVisibility, isSubTasksEnabled } from '../storage.js';
import { confirmDialog } from './confirm.js';
import { getReachableColumnIds, evaluateColumnMove } from '../features/workflow-engine.js';
import { encryptText } from '../features/crypto.js';
import { openSetPrivateKeyModal } from './private-key-set.js';
import { openUnlockPrivateTaskModal } from './private-key-unlock.js';
import { setTaskHash, clearTaskHash } from '../features/hash-router.js';
import { taskApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';

function buildServerTaskBody(data){
  return {
    title: data.title, description: data.description, priority: data.priority,
    columnId: data.columnId, assigneeId: data.assigneeId || null,
    releaseId: data.releaseId || null, typeId: data.typeId || null,
    parentTaskId: data.parentTaskId || null, dependsOnTaskIds: data.dependencies || [],
    documentationUrl: data.documentationUrl || null,
    startDate: isoToServerDateOnly(data.startDate), endDate: isoToServerDateOnly(data.endDate),
    businessValue: data.businessValue, taskCost: data.taskCost, progress: data.progress,
    estimatedEffort: data.estimatedEffort, actualEffort: data.actualEffort, archived: data.archived
  };
}

/* Mirrors setTaskSubtasks (mutations.js) for the server-authoritative path: there's no dedicated
   "set children" endpoint, so each task whose desired child-of-taskId membership actually changed
   gets a normal full task update with just parentTaskId changed — its other fields come from this
   browser's current (just-refreshed) local copy. */
async function syncSubtasksToServer(project, taskId, desiredSubtaskIds){
  var desired = new Set(desiredSubtaskIds || []);
  var updates = [];
  Object.keys(project.tasks).forEach(function(id){
    if(id === taskId) return;
    var t = project.tasks[id];
    var shouldBeChild = desired.has(id);
    var isChild = t.parentTaskId === taskId;
    if(shouldBeChild === isChild) return;
    updates.push({id: id, task: t, newParentId: shouldBeChild ? taskId : null});
  });
  for(var i = 0; i < updates.length; i++){
    var u = updates[i];
    await taskApi.update(project.serverProjectId, u.id, buildServerTaskBody({
      title: u.task.title, description: u.task.description, priority: u.task.priority,
      columnId: u.task.columnId, assigneeId: u.task.assigneeId, releaseId: u.task.releaseId,
      typeId: u.task.typeId, parentTaskId: u.newParentId, dependencies: u.task.dependencies,
      documentationUrl: u.task.documentationUrl, startDate: u.task.startDate, endDate: u.task.endDate,
      businessValue: u.task.businessValue, taskCost: u.task.taskCost, progress: u.task.progress,
      estimatedEffort: u.task.estimatedEffort, actualEffort: u.task.actualEffort, archived: u.task.archived
    }));
  }
}

/* Toggles between the full editable form and the "private, no key
   given" reduced view (title only, read-only, no Save/Delete). */
function showTaskFullFields(show){
  document.getElementById('taskFullFields').classList.toggle('hidden', !show);
  document.getElementById('taskPrivateReducedView').classList.toggle('hidden', show);
  document.getElementById('taskSaveBtn').classList.toggle('kf-vis-hidden', !show);
}

export function openTaskModal(taskId, defaultColumnId){
  var project = getCurrentProject();
  if(!project) return;

  var task = taskId ? project.tasks[taskId] : null;

  if(task && task.isPrivate){
    openUnlockPrivateTaskModal(task, function(result){
      if(result.mode === 'cancel') return;

      ui.editingTaskId = taskId;
      ui.taskModalColumnId = defaultColumnId || (project.columns[0] && project.columns[0].id);
      ui.depSearchTerm = '';
      ui.taskModalDeps = (task.dependencies || []).slice();
      ui.taskModalParentId = task.parentTaskId || null;
      ui.taskModalSubtaskIds = getSubtasksOf(project, task.id).map(function(t){ return t.id; });
      ui.subtaskSearchTerm = '';

      if(result.mode === 'continue'){
        ui.taskModalUnlockedDerivedBits = null;
        showTaskFullFields(false);
        document.getElementById('taskModalTitle').textContent = 'Edit ' + task.key;
        document.getElementById('taskPrivateReducedTitle').textContent = task.title;
        document.getElementById('taskDeleteBtn').classList.add('kf-vis-hidden');
        document.getElementById('taskOverlay').classList.remove('hidden');
        fitBoardForTaskModal();
        setTaskHash(task.key);
      } else { // 'unlocked'
        ui.taskModalUnlockedDerivedBits = result.derivedBits;
        showTaskFullFields(true);
        populateFullForm(project, task, result.description);
      }
    });
    return;
  }

  ui.editingTaskId = taskId;
  ui.taskModalColumnId = defaultColumnId || (project.columns[0] && project.columns[0].id);
  ui.depSearchTerm = '';
  ui.taskModalDeps = task ? (task.dependencies || []).slice() : [];
  ui.taskModalUnlockedDerivedBits = null;
  ui.taskModalParentId = task ? (task.parentTaskId || null) : null;
  ui.taskModalSubtaskIds = task ? getSubtasksOf(project, task.id).map(function(t){ return t.id; }) : [];
  ui.subtaskSearchTerm = '';

  showTaskFullFields(true);
  populateFullForm(project, task, task ? task.description : '');
}

function populateFullForm(project, task, descriptionValue){
  document.getElementById('taskModalTitle').textContent = task ? 'Edit ' + task.key : 'New task';
  var typeSelect = document.getElementById('taskTypeSelect');
  typeSelect.innerHTML = '';
  var noTypeOpt = document.createElement('option');
  noTypeOpt.value = '';
  noTypeOpt.textContent = 'No type';
  typeSelect.appendChild(noTypeOpt);
  (project.taskTypes || []).forEach(function(tt){
    var opt = document.createElement('option');
    opt.value = tt.id;
    opt.textContent = tt.name;
    if(task && task.typeId === tt.id) opt.selected = true;
    typeSelect.appendChild(opt);
  });

  document.getElementById('taskTitleInput').value = task ? task.title : '';
  document.getElementById('taskDescInput').value = descriptionValue || '';
  document.getElementById('taskDocUrlInput').value = task && task.documentationUrl ? task.documentationUrl : '';
  updateDocUrlOpenButtonVisibility();
  document.getElementById('taskPrioritySelect').value = task ? task.priority : 'medium';
  updatePriorityIcon();

  var colSelect = document.getElementById('taskColumnSelect');
  colSelect.innerHTML = '';
  var currentColumnId = task ? task.columnId : ui.taskModalColumnId;
  /* A Conditional edge needs real task properties to evaluate against.
     An existing task has them; a brand-new one doesn't yet, so a
     synthetic task shaped like what addTask() would create is used
     instead — the same defaults the form itself starts with. */
  var taskForReachability = task || {
    columnId: ui.taskModalColumnId,
    assigneeId: null, releaseId: null, typeId: null, documentationUrl: null,
    priority: 'medium', businessValue: 1, taskCost: 1, archived: false, dependencies: []
  };
  var reachableColumnIds = getReachableColumnIds(project, taskForReachability);
  project.columns.forEach(function(c){
    if(!reachableColumnIds.has(c.id)) return;
    var opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if(currentColumnId === c.id) opt.selected = true;
    colSelect.appendChild(opt);
  });

  var releaseSelect = document.getElementById('taskReleaseSelect');
  releaseSelect.innerHTML = '';
  var noReleaseOpt = document.createElement('option');
  noReleaseOpt.value = '';
  noReleaseOpt.textContent = 'No release';
  releaseSelect.appendChild(noReleaseOpt);
  (project.releases || []).slice().sort(function(a, b){
    return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
  }).forEach(function(r){
    var opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if(task && task.releaseId === r.id) opt.selected = true;
    releaseSelect.appendChild(opt);
  });

  var assigneeSelect = document.getElementById('taskAssigneeSelect');
  assigneeSelect.innerHTML = '';
  var unassignedOpt = document.createElement('option');
  unassignedOpt.value = '';
  unassignedOpt.textContent = 'Unassigned';
  assigneeSelect.appendChild(unassignedOpt);
  (project.members || []).forEach(function(m){
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if(task && task.assigneeId === m.id) opt.selected = true;
    assigneeSelect.appendChild(opt);
  });
  if(!task || !task.assigneeId) unassignedOpt.selected = true;

  document.getElementById('taskStartDateInput').value = task ? utcISOToLocalDateValue(task.startDate) : defaultStartDateValue();
  document.getElementById('taskEndDateInput').value = task ? utcISOToLocalDateValue(task.endDate) : defaultEndDateValue();
  var progressValue = task ? clampProgress(task.progress) : 0;
  document.getElementById('taskProgressInput').value = progressValue;
  document.getElementById('taskProgressValueLabel').textContent = progressValue + '%';
  document.getElementById('taskEstEffortInput').value = task ? clampEffortHours(task.estimatedEffort) : 0;
  document.getElementById('taskActualEffortInput').value = task ? clampEffortHours(task.actualEffort) : 0;
  var timeTrackingEnabled = normalizeHeaderButtonVisibility(project.headerButtonVisibility).timeTracking;
  document.getElementById('taskTimeTrackingFields').classList.toggle('kf-vis-hidden', !timeTrackingEnabled);
  document.getElementById('taskBusinessValueInput').value = task ? clampTaskScore(task.businessValue) : 1;
  document.getElementById('taskCostInput').value = task ? clampTaskScore(task.taskCost) : 1;
  document.getElementById('taskArchivedCheckbox').checked = !!(task && task.archived);
  document.getElementById('taskPrivateCheckbox').checked = !!(task && task.isPrivate);

  document.getElementById('taskDeleteBtn').classList.toggle('kf-vis-hidden', !task);
  document.getElementById('depSearchInput').value = '';

  var subTasksEnabled = isSubTasksEnabled(project);
  document.getElementById('taskSubTasksFields').classList.toggle('kf-vis-hidden', !subTasksEnabled);
  document.getElementById('subtaskSearchInput').value = '';

  renderParentTaskSelect(project);
  renderSubtaskPicker(project);
  renderDependencyPicker();
  renderAuditTrail(project, task);
  document.getElementById('taskOverlay').classList.remove('hidden');
  fitBoardForTaskModal();
  document.getElementById('taskTitleInput').focus();
  if(task) setTaskHash(task.key);
}

/* Renders a single before/after value for the audit trail, resolving
   ids to the human-readable names shown everywhere else in the app
   (rather than the raw id an entry actually stores). A stale id (e.g.
   a dependency or assignee deleted since the change was recorded, or
   left dangling by an id-remapping import) falls back to an em dash
   instead of showing "undefined" or a raw id. */
function formatAuditValue(project, field, value){
  if(value === null || value === undefined || value === '') return '—';
  switch(field){
    case 'columnId': return (getColumn(project, value) || {}).name || '—';
    case 'parentTaskId': return (project.tasks[value] || {}).key || '—';
    case 'assigneeId': return (getMemberById(project, value) || {}).name || '—';
    case 'releaseId': return (getReleaseById(project, value) || {}).name || '—';
    case 'typeId': return (getTaskTypeById(project, value) || {}).name || '—';
    case 'priority': return getPriority(value).label;
    case 'startDate':
    case 'endDate':
      return utcISOToLocalDisplayDate(value) || '—';
    case 'archived':
    case 'isPrivate':
      return value ? 'Yes' : 'No';
    case 'progress': return value + '%';
    case 'dependencies':
      var ids = Array.isArray(value) ? value : [];
      if(ids.length === 0) return '—';
      var keys = ids.map(function(id){ var t = project.tasks[id]; return t ? t.key : null; }).filter(Boolean);
      return keys.length ? keys.join(', ') : '—';
    default: return String(value);
  }
}

/* Renders the Audit Trail section, gated entirely by the Change
   Auditing App Setting — the section (and any entries already
   recorded on this task) is hidden whenever the setting is off, same
   as Time Tracking's fields above. Always starts collapsed; re-opening
   the modal doesn't remember the previous expand state. */
function renderAuditTrail(project, task){
  var section = document.getElementById('taskAuditSection');
  var enabled = normalizeHeaderButtonVisibility(project.headerButtonVisibility).changeAuditing;
  section.classList.toggle('kf-vis-hidden', !enabled);
  document.getElementById('taskAuditBody').classList.add('kf-vis-hidden');
  document.getElementById('taskAuditChevron').classList.remove('expanded');
  if(!enabled) return;

  var entries = (task && Array.isArray(task.auditLog)) ? task.auditLog : [];
  document.getElementById('taskAuditCount').textContent = entries.length > 0 ? '(' + entries.length + ')' : '';

  var body = document.getElementById('taskAuditBody');
  if(entries.length === 0){
    body.innerHTML = '<div class="kf-audit-empty">No changes recorded yet.</div>';
    return;
  }
  body.innerHTML = entries.map(function(entry){
    // changedBy is only ever set for a change made through the server (a logged-in user) — see
    // TasksController.Update/RecordAuditEntries on the API side. Local-only edits have no login
    // concept, so entry.changedBy is simply absent there and the "by ..." suffix is omitted.
    var byWho = entry.changedBy ? ' · by ' + escapeHTML(entry.changedBy) : '';
    return '<div class="kf-audit-entry">' +
      '<div class="kf-audit-entry-time">' + escapeHTML(utcISOToLocalDisplayDateTime(entry.timestamp)) + byWho + '</div>' +
      '<div class="kf-audit-entry-field">' + escapeHTML(getAuditFieldLabel(entry.field)) + '</div>' +
      '<div class="kf-audit-entry-change">' +
        escapeHTML(formatAuditValue(project, entry.field, entry.oldValue)) + ' → ' + escapeHTML(formatAuditValue(project, entry.field, entry.newValue)) +
      '</div>' +
    '</div>';
  }).join('');
}

export function toggleAuditTrail(){
  var body = document.getElementById('taskAuditBody');
  var wasHidden = body.classList.contains('kf-vis-hidden');
  body.classList.toggle('kf-vis-hidden', !wasHidden);
  document.getElementById('taskAuditChevron').classList.toggle('expanded', wasHidden);
}

export function updatePriorityIcon(){
  var val = document.getElementById('taskPrioritySelect').value;
  var conf = getPriority(val);
  var iconEl = document.getElementById('taskPriorityIcon');
  iconEl.style.color = conf.color;
  iconEl.innerHTML = iconSvg(conf.icon, 18);
}

export function updateDocUrlOpenButtonVisibility(){
  var hasValue = document.getElementById('taskDocUrlInput').value.trim().length > 0;
  document.getElementById('taskDocUrlOpenBtn').classList.toggle('hidden', !hasValue);
}
export function openDocUrlInNewTab(){
  var raw = document.getElementById('taskDocUrlInput').value;
  var url = normalizeDocumentationUrl(raw);
  if(!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* Every id that would create a cycle if picked as THIS task's parent:
   itself, its existing sub-tree, plus anything already pending in the
   Sub-Tasks picker this session (and their existing sub-trees) — since
   picking one of those as your own parent right now would close a
   loop before either edit is even saved. */
function getDisallowedParentIds(project){
  var disallowed = new Set();
  if(ui.editingTaskId){
    disallowed.add(ui.editingTaskId);
    getSubtaskDescendantIds(project, ui.editingTaskId).forEach(function(id){ disallowed.add(id); });
  }
  ui.taskModalSubtaskIds.forEach(function(id){
    disallowed.add(id);
    getSubtaskDescendantIds(project, id).forEach(function(d){ disallowed.add(d); });
  });
  return disallowed;
}

/* Every id that would create a cycle if picked as a sub-task of THIS
   task: itself, plus its own ancestor chain starting from whichever
   parent is currently pending in the Parent Task select. */
function getDisallowedSubtaskIds(project){
  var disallowed = new Set();
  if(ui.editingTaskId) disallowed.add(ui.editingTaskId);
  getTaskAncestorIds(project, ui.taskModalParentId).forEach(function(id){ disallowed.add(id); });
  return disallowed;
}

export function renderParentTaskSelect(project){
  var select = document.getElementById('taskParentTaskSelect');
  select.innerHTML = '';
  var noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'No parent';
  select.appendChild(noneOpt);

  var disallowed = getDisallowedParentIds(project);
  var currentParentId = ui.taskModalParentId;
  getTasksArray(project).filter(function(t){
    if(disallowed.has(t.id)) return false;
    if(t.archived && t.id !== currentParentId) return false;
    return true;
  }).sort(function(a,b){ return a.key.localeCompare(b.key, undefined, {numeric:true}); }).forEach(function(t){
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.key + ' — ' + t.title;
    if(currentParentId === t.id) opt.selected = true;
    select.appendChild(opt);
  });
  if(!currentParentId) noneOpt.selected = true;
}

export function onParentTaskSelectChange(){
  ui.taskModalParentId = document.getElementById('taskParentTaskSelect').value || null;
  var project = getCurrentProject();
  /* Choosing a parent can newly disallow some sub-task candidates (its
     own ancestor chain), so the sub-task picker's candidate list needs
     a fresh render too — not just the select itself. */
  renderSubtaskPicker(project);
}

export function renderSubtaskPicker(project){
  var chipsWrap = document.getElementById('subtaskChipsSelected');
  var listWrap = document.getElementById('subtaskList');
  chipsWrap.innerHTML = '';
  listWrap.innerHTML = '';

  if(ui.taskModalSubtaskIds.length === 0){
    chipsWrap.innerHTML = '<span style="font-size:12px;color:var(--kf-text-faint);">No sub-tasks selected</span>';
  }
  ui.taskModalSubtaskIds.forEach(function(subId){
    var t = project.tasks[subId];
    if(!t) return;
    var chip = document.createElement('span');
    chip.className = 'kf-dep-chip-removable';
    chip.innerHTML = '<span>' + escapeHTML(t.key) + '</span><button type="button" aria-label="Remove sub-task">' + iconSvg('close',12) + '</button>';
    chip.querySelector('button').addEventListener('click', function(){
      ui.taskModalSubtaskIds = ui.taskModalSubtaskIds.filter(function(id){ return id !== subId; });
      renderSubtaskPicker(project);
      renderParentTaskSelect(project);
    });
    chipsWrap.appendChild(chip);
  });

  var disallowed = getDisallowedSubtaskIds(project);

  var candidates = getTasksArray(project).filter(function(t){
    if(t.id === ui.editingTaskId) return false;
    if(t.archived) return false;
    if(ui.subtaskSearchTerm){
      var hay = (t.key + ' ' + t.title).toLowerCase();
      if(hay.indexOf(ui.subtaskSearchTerm.toLowerCase()) === -1) return false;
    }
    return true;
  }).sort(function(a,b){ return a.key.localeCompare(b.key, undefined, {numeric:true}); });

  if(candidates.length === 0){
    listWrap.innerHTML = '<div class="kf-empty-note">No matching tasks.</div>';
    return;
  }

  candidates.forEach(function(t){
    var row = document.createElement('label');
    var isDisallowed = disallowed.has(t.id);
    row.className = 'kf-dep-row' + (isDisallowed ? ' disabled' : '');
    var checked = ui.taskModalSubtaskIds.indexOf(t.id) !== -1;
    row.innerHTML =
      '<input type="checkbox" ' + (checked?'checked':'') + (isDisallowed?'disabled':'') + '>' +
      '<span class="kf-dep-key">' + escapeHTML(t.key) + '</span>' +
      '<span class="kf-dep-title">' + escapeHTML(t.title) + '</span>';
    if(isDisallowed){
      row.title = 'Selecting this would create a circular parent/sub-task relationship';
    }
    var cb = row.querySelector('input');
    cb.addEventListener('change', function(){
      if(cb.checked){
        if(ui.taskModalSubtaskIds.indexOf(t.id) === -1) ui.taskModalSubtaskIds.push(t.id);
      } else {
        ui.taskModalSubtaskIds = ui.taskModalSubtaskIds.filter(function(id){ return id !== t.id; });
      }
      renderSubtaskPicker(project);
      renderParentTaskSelect(project);
    });
    listWrap.appendChild(row);
  });
}

export function renderDependencyPicker(){
  var project = getCurrentProject();
  var chipsWrap = document.getElementById('depChipsSelected');
  var listWrap = document.getElementById('depList');
  chipsWrap.innerHTML = '';
  listWrap.innerHTML = '';

  if(ui.taskModalDeps.length === 0){
    chipsWrap.innerHTML = '<span style="font-size:12px;color:var(--kf-text-faint);">No dependencies selected</span>';
  }
  ui.taskModalDeps.forEach(function(depId){
    var t = project.tasks[depId];
    if(!t) return;
    var chip = document.createElement('span');
    chip.className = 'kf-dep-chip-removable';
    chip.innerHTML = '<span>' + escapeHTML(t.key) + '</span><button type="button" aria-label="Remove dependency">' + iconSvg('close',12) + '</button>';
    chip.querySelector('button').addEventListener('click', function(){
      ui.taskModalDeps = ui.taskModalDeps.filter(function(id){ return id !== depId; });
      renderDependencyPicker();
    });
    chipsWrap.appendChild(chip);
  });

  var disallowed = new Set();
  disallowed.add(ui.editingTaskId);
  if(ui.editingTaskId){
    getDescendants(project, ui.editingTaskId).forEach(function(id){ disallowed.add(id); });
  }

  var candidates = getTasksArray(project).filter(function(t){
    if(t.id === ui.editingTaskId) return false;
    if(t.archived) return false;
    if(ui.depSearchTerm){
      var hay = (t.key + ' ' + t.title).toLowerCase();
      if(hay.indexOf(ui.depSearchTerm.toLowerCase()) === -1) return false;
    }
    return true;
  }).sort(function(a,b){ return a.key.localeCompare(b.key, undefined, {numeric:true}); });

  if(candidates.length === 0){
    listWrap.innerHTML = '<div class="kf-empty-note">No matching tasks.</div>';
    return;
  }

  candidates.forEach(function(t){
    var row = document.createElement('label');
    var isDisallowed = disallowed.has(t.id);
    row.className = 'kf-dep-row' + (isDisallowed ? ' disabled' : '');
    var checked = ui.taskModalDeps.indexOf(t.id) !== -1;
    row.innerHTML =
      '<input type="checkbox" ' + (checked?'checked':'') + (isDisallowed?'disabled':'') + '>' +
      '<span class="kf-dep-key">' + escapeHTML(t.key) + '</span>' +
      '<span class="kf-dep-title">' + escapeHTML(t.title) + '</span>';
    if(isDisallowed){
      row.title = 'Selecting this would create a circular dependency';
    }
    var cb = row.querySelector('input');
    cb.addEventListener('change', function(){
      if(cb.checked){
        if(ui.taskModalDeps.indexOf(t.id) === -1) ui.taskModalDeps.push(t.id);
      } else {
        ui.taskModalDeps = ui.taskModalDeps.filter(function(id){ return id !== t.id; });
      }
      renderDependencyPicker();
    });
    listWrap.appendChild(row);
  });
}

export function closeTaskModal(){
  document.getElementById('taskOverlay').classList.add('hidden');
  ui.editingTaskId = null;
  ui.taskModalUnlockedDerivedBits = null;
  restoreBoardAfterTaskModal();
  clearTaskHash();
}

export async function saveTaskFromModal(){
  var project = getCurrentProject();
  var title = document.getElementById('taskTitleInput').value.trim();
  if(!title){
    toast('Please enter a task title.');
    document.getElementById('taskTitleInput').focus();
    return;
  }

  var startDateValue = document.getElementById('taskStartDateInput').value;
  var endDateValue = document.getElementById('taskEndDateInput').value;
  var startISO = localDateValueToUTCISO(startDateValue);
  var endISO = localDateValueToUTCISO(endDateValue);
  if(startISO && endISO && new Date(endISO).getTime() < new Date(startISO).getTime()){
    toast('End date cannot be before the start date.');
    document.getElementById('taskEndDateInput').focus();
    return;
  }

  var data = {
    title: title,
    description: document.getElementById('taskDescInput').value.trim(),
    priority: document.getElementById('taskPrioritySelect').value,
    columnId: document.getElementById('taskColumnSelect').value,
    assigneeId: document.getElementById('taskAssigneeSelect').value || null,
    releaseId: document.getElementById('taskReleaseSelect').value || null,
    typeId: document.getElementById('taskTypeSelect').value || null,
    documentationUrl: document.getElementById('taskDocUrlInput').value,
    startDate: startISO,
    endDate: endISO,
    businessValue: clampTaskScore(document.getElementById('taskBusinessValueInput').value),
    taskCost: clampTaskScore(document.getElementById('taskCostInput').value),
    progress: clampProgress(document.getElementById('taskProgressInput').value),
    estimatedEffort: clampEffortHours(document.getElementById('taskEstEffortInput').value),
    actualEffort: clampEffortHours(document.getElementById('taskActualEffortInput').value),
    archived: document.getElementById('taskArchivedCheckbox').checked,
    dependencies: ui.taskModalDeps.slice(),
    parentTaskId: ui.taskModalParentId || null
  };

  var checkId = ui.editingTaskId || '__new__';
  if(wouldCreateCycle(project, checkId, data.dependencies)){
    toast('That would create a circular dependency. Please review your selections.');
    return;
  }
  if(ui.editingTaskId && wouldCreateParentCycle(project, ui.editingTaskId, data.parentTaskId)){
    toast('That would create a circular parent/sub-task relationship. Please review your selections.');
    return;
  }

  var existingTask = ui.editingTaskId ? project.tasks[ui.editingTaskId] : null;
  var wantsPrivate = document.getElementById('taskPrivateCheckbox').checked;

  if(wantsPrivate && !(existingTask && existingTask.privateSalt)){
    /* Newly made private (a brand-new task, or an existing non-private
       one) — a key has never been set for this task, so ask for one. */
    openSetPrivateKeyModal(async function(keyResult){
      var enc = await encryptText(data.description, keyResult.derivedBits);
      data.isPrivate = true;
      data.privateSalt = keyResult.salt;
      data.privateVerifier = keyResult.verifier;
      data.encryptedDescription = enc.ciphertext;
      data.encryptionIv = enc.iv;
      data.description = '';
      finishSave(project, data);
    });
    return;
  }

  if(!wantsPrivate && existingTask && existingTask.isPrivate){
    /* Turning privacy off. Only reachable while unlocked — the checkbox
       lives inside #taskFullFields, which reduced view never shows. */
    data.isPrivate = false;
    data.privateSalt = null;
    data.privateVerifier = null;
    data.encryptedDescription = null;
    data.encryptionIv = null;
    finishSave(project, data);
    return;
  }

  if(wantsPrivate && existingTask && existingTask.isPrivate){
    /* Stays private, already unlocked this modal session — re-encrypt
       with the same derived bits, no re-prompt (mid-session edit, not a
       new "view"). Fresh IV on every re-encryption. */
    var enc = await encryptText(data.description, ui.taskModalUnlockedDerivedBits);
    data.isPrivate = true;
    data.privateSalt = existingTask.privateSalt;
    data.privateVerifier = existingTask.privateVerifier;
    data.encryptedDescription = enc.ciphertext;
    data.encryptionIv = enc.iv;
    data.description = '';
    finishSave(project, data);
    return;
  }

  finishSave(project, data);
}

async function finishSave(project, data){
  var existingTask = ui.editingTaskId ? project.tasks[ui.editingTaskId] : null;
  // Private-task encryption isn't modeled server-side yet (see features/crypto.js — the API has no
  // fields for privateSalt/privateVerifier/encryptedDescription/encryptionIv), so any task that IS
  // or WAS private stays on the local-only path even for a server-authoritative project, rather
  // than silently losing its encrypted content on the next server refresh.
  var isPrivateInvolved = !!data.isPrivate || !!(existingTask && existingTask.isPrivate);

  if(isServerAuthoritative(project) && !isPrivateInvolved){
    if(existingTask && data.columnId !== existingTask.columnId){
      var transition = evaluateColumnMove(project, existingTask, data.columnId);
      if(!transition.allowed){ toast(transition.message); return; }
    }
    try {
      var editingId = ui.editingTaskId;
      var resultTaskId;
      if(editingId){
        await taskApi.update(project.serverProjectId, editingId, buildServerTaskBody(data));
        resultTaskId = editingId;
      } else {
        var created = await taskApi.create(project.serverProjectId, buildServerTaskBody(data));
        resultTaskId = created.id;
      }
      await syncSubtasksToServer(project, resultTaskId, ui.taskModalSubtaskIds);
      await refreshProjectFromServer(project.id);
      closeTaskModal();
      renderBoard();
      toast(editingId ? 'Task updated.' : 'Task created.');
    } catch(e){
      toast('Could not save task on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingTaskId){
    var blocked = updateTask(project, ui.editingTaskId, data);
    /* Sub-task reconciliation is independent of the column move — it
       still applies even if the transition above got blocked, same as
       every other field on this task already did. */
    setTaskSubtasks(project, ui.editingTaskId, ui.taskModalSubtaskIds);
    if(blocked){ toast(blocked.message); return; }
    toast('Task updated.' + (isPrivateInvolved && isServerAuthoritative(project) ? ' (Private tasks are not synced to the server.)' : ''));
  } else {
    var newId = addTask(project, data);
    setTaskSubtasks(project, newId, ui.taskModalSubtaskIds);
    toast('Task created.' + (isPrivateInvolved && isServerAuthoritative(project) ? ' (Private tasks are not synced to the server.)' : ''));
  }
  closeTaskModal();
  renderBoard();
}

export function deleteTaskFromModal(){
  var project = getCurrentProject();
  var task = project.tasks[ui.editingTaskId];
  if(!task) return;
  confirmDialog(
    'Delete ' + task.key + '?',
    'This will permanently remove "' + task.title + '" and unlink it from any dependent tasks.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await taskApi.remove(project.serverProjectId, ui.editingTaskId);
          await refreshProjectFromServer(project.id);
          closeTaskModal();
          renderBoard();
          toast('Task deleted.');
        } catch(e){
          toast('Could not delete task on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      deleteTask(project, ui.editingTaskId);
      closeTaskModal();
      renderBoard();
      toast('Task deleted.');
    }
  );
}
