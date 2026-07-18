"use strict";
import { ui, toast, getPriority } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { getTasksArray } from '../utils.js';
import { iconSvg } from '../icons.js';
import { escapeHTML, renderBoard } from '../views/board.js';
import { reactivateTasks, archiveTasks } from '../mutations.js';
import { isServerAuthoritative, setTasksArchivedOnServer } from './migration.js';

export function getArchivedTasks(project){
  return getTasksArray(project).filter(function(t){ return t.archived; });
}

export function refreshArchivedCountBadge(){
  var badge = document.getElementById('archivedCountBadge');
  var navBadge = document.getElementById('navArchivedCountBadge');
  if(!badge) return;
  var project = getCurrentProject();
  var count = project ? getArchivedTasks(project).length : 0;
  if(count > 0){
    badge.textContent = count;
    badge.classList.remove('kf-vis-hidden');
    if(navBadge){
      navBadge.textContent = count;
      navBadge.classList.remove('kf-vis-hidden');
    }
  } else {
    badge.classList.add('kf-vis-hidden');
    if(navBadge) navBadge.classList.add('kf-vis-hidden');
  }
}

export function openArchivedTasksOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.archivedSelected = new Set();
  document.getElementById('archivedTasksTitle').textContent = 'Archived tasks — ' + project.name;
  document.getElementById('archivedSelectAllCheckbox').checked = false;
  renderArchivedTasksList();
  document.getElementById('archivedTasksOverlay').classList.remove('hidden');
}
export function closeArchivedTasksOverlay(){
  document.getElementById('archivedTasksOverlay').classList.add('hidden');
}
export function isArchivedTasksOverlayOpen(){
  return !document.getElementById('archivedTasksOverlay').classList.contains('hidden');
}

export function renderArchivedTasksList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('archivedTasksList');
  listEl.innerHTML = '';
  if(!project) return;

  var archived = getArchivedTasks(project).sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  document.getElementById('archivedSelectedCount').textContent =
    ui.archivedSelected.size + ' of ' + archived.length + ' selected';
  document.getElementById('reactivateSelectedBtn').disabled = ui.archivedSelected.size === 0;
  document.getElementById('archivedSelectAllCheckbox').checked =
    archived.length > 0 && ui.archivedSelected.size === archived.length;

  if(archived.length === 0){
    listEl.innerHTML = '<div class="kf-member-empty">No archived tasks in this project.</div>';
    return;
  }

  archived.forEach(function(t){
    var prio = getPriority(t.priority);
    var row = document.createElement('label');
    row.className = 'kf-archived-row';
    var checked = ui.archivedSelected.has(t.id);
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dep-key">' + escapeHTML(t.key) + '</span>' +
      '<span class="kf-archived-row-title">' + escapeHTML(t.title) + '</span>' +
      '<span class="kf-priority-pill" style="color:' + prio.color + ';background:' + prio.bg + ';">' + iconSvg(prio.icon,12) + escapeHTML(prio.label) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.archivedSelected.add(t.id);
      else ui.archivedSelected.delete(t.id);
      renderArchivedTasksList();
    });
    listEl.appendChild(row);
  });
}

export function reactivateSelectedArchivedTasks(){
  var project = getCurrentProject();
  if(!project || ui.archivedSelected.size === 0) return;
  var ids = Array.from(ui.archivedSelected);

  if(isServerAuthoritative(project)){
    setTasksArchivedOnServer(project, ids, false).then(function(){
      ui.archivedSelected = new Set();
      renderArchivedTasksList();
      renderBoard();
      refreshArchivedCountBadge();
      toast('Reactivated ' + ids.length + ' task' + (ids.length === 1 ? '' : 's') + '.');
    }, function(err){
      toast('Could not reactivate on the server: ' + (err.message || 'unknown error'));
    });
    return;
  }

  var count = reactivateTasks(project, ids);
  ui.archivedSelected = new Set();
  renderArchivedTasksList();
  renderBoard();
  refreshArchivedCountBadge();
  toast('Reactivated ' + count + ' task' + (count === 1 ? '' : 's') + '.');
}

/* "Archive Done Tasks" button (Archived Tasks modal footer) — a bulk shortcut for the common
   end-of-sprint cleanup: every active (non-archived) task sitting in a "Done" column (Column.done,
   see utils.js's getColumn()/board.js's moveTaskToColumn() for the same flag) gets archived in one
   go, rather than archiving each task individually via its own modal's Archived checkbox. Not
   selection-driven (unlike reactivateSelectedArchivedTasks) — it always acts on every qualifying
   task, so there's nothing to select first. */
export function archiveDoneTasksFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var doneColumnIds = project.columns.filter(function(c){ return c.done; }).map(function(c){ return c.id; });
  var ids = getTasksArray(project)
    .filter(function(t){ return !t.archived && doneColumnIds.indexOf(t.columnId) !== -1; })
    .map(function(t){ return t.id; });

  if(ids.length === 0){ toast('No active tasks in a Done column to archive.'); return; }

  function afterArchive(count){
    renderBoard();
    openArchivedTasksOverlay();
    refreshArchivedCountBadge();
    toast('Archived ' + count + ' task' + (count === 1 ? '' : 's') + '.');
  }

  if(isServerAuthoritative(project)){
    setTasksArchivedOnServer(project, ids, true).then(function(){
      afterArchive(ids.length);
    }, function(err){
      toast('Could not archive on the server: ' + (err.message || 'unknown error'));
    });
    return;
  }

  var count = archiveTasks(project, ids);
  afterArchive(count);
}
