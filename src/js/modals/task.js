"use strict";
import { ui, toast, getPriority } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { getTasksArray, getDescendants, wouldCreateCycle } from '../utils.js';
import { clampTaskScore, clampProgress, clampEffortHours, utcISOToLocalDateValue, localDateValueToUTCISO, defaultStartDateValue, defaultEndDateValue } from '../date-utils.js';
import { iconSvg } from '../icons.js';
import { PRIORITY_ORDER } from '../config.js';
import { escapeHTML, renderBoard } from '../views/board.js';
import { addTask, updateTask, deleteTask, normalizeDocumentationUrl } from '../mutations.js';
import { normalizeHeaderButtonVisibility } from '../storage.js';
import { confirmDialog } from './confirm.js';
import { getReachableColumnIds } from '../features/workflow-engine.js';
import { encryptText } from '../features/crypto.js';
import { openSetPrivateKeyModal } from './private-key-set.js';
import { openUnlockPrivateTaskModal } from './private-key-unlock.js';
import { setTaskHash, clearTaskHash } from '../features/hash-router.js';

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

      if(result.mode === 'continue'){
        ui.taskModalUnlockedDerivedBits = null;
        showTaskFullFields(false);
        document.getElementById('taskModalTitle').textContent = 'Edit ' + task.key;
        document.getElementById('taskPrivateReducedTitle').textContent = task.title;
        document.getElementById('taskDeleteBtn').classList.add('kf-vis-hidden');
        document.getElementById('taskOverlay').classList.remove('hidden');
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

  renderDependencyPicker();
  document.getElementById('taskOverlay').classList.remove('hidden');
  document.getElementById('taskTitleInput').focus();
  if(task) setTaskHash(task.key);
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
    dependencies: ui.taskModalDeps.slice()
  };

  var checkId = ui.editingTaskId || '__new__';
  if(wouldCreateCycle(project, checkId, data.dependencies)){
    toast('That would create a circular dependency. Please review your selections.');
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

function finishSave(project, data){
  if(ui.editingTaskId){
    var blocked = updateTask(project, ui.editingTaskId, data);
    if(blocked){ toast(blocked.message); return; }
    toast('Task updated.');
  } else {
    addTask(project, data);
    toast('Task created.');
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
    function(){
      deleteTask(project, ui.editingTaskId);
      closeTaskModal();
      renderBoard();
      toast('Task deleted.');
    }
  );
}
