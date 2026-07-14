"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { getColumn } from '../utils.js';
import { addColumn, updateColumn, deleteColumn } from '../mutations.js';
import { renderBoard } from '../views/board.js';
import { confirmDialog } from './confirm.js';
import { addColumnApi, updateColumnApi } from '../api.js';
import { refreshProjectFromServer, isServerAuthoritative, deleteColumnOnServer } from '../features/migration.js';

/* Once isServerAuthoritative(project) (see features/migration.js), the server is the sole source of
   truth: column CRUD goes through the API only (no local mutations.js write), and on success the
   whole project is re-pulled from the server so this browser's view — and every other
   collaborator's — stays consistent. Projects that have never been migrated are unaffected and keep
   writing straight to local state as before. */

export function openColumnModal(columnId){
  var project = getCurrentProject();
  ui.editingColumnId = columnId;
  var col = columnId ? getColumn(project, columnId) : null;
  document.getElementById('columnModalTitle').textContent = col ? 'Edit column' : 'New column';
  document.getElementById('columnNameInput').value = col ? col.name : '';
  document.getElementById('columnDoneCheckbox').checked = col ? col.done : false;
  document.getElementById('columnColorEnabledCheckbox').checked = !!(col && col.color);
  document.getElementById('columnColorInput').value = (col && col.color) || '#4f46e5';
  document.getElementById('columnColorInput').disabled = !(col && col.color);
  document.getElementById('columnDeleteBtn').classList.toggle('kf-vis-hidden', !col);
  document.getElementById('columnOverlay').classList.remove('hidden');
  document.getElementById('columnNameInput').focus();
}
export function closeColumnModal(){
  document.getElementById('columnOverlay').classList.add('hidden');
  ui.editingColumnId = null;
}

export async function saveColumnFromModal(){
  var project = getCurrentProject();
  var name = document.getElementById('columnNameInput').value.trim();
  if(!name){ toast('Please enter a column name.'); return; }
  var done = document.getElementById('columnDoneCheckbox').checked;
  var colorEnabled = document.getElementById('columnColorEnabledCheckbox').checked;
  var color = colorEnabled ? document.getElementById('columnColorInput').value : null;
  var editingId = ui.editingColumnId;

  if(isServerAuthoritative(project)){
    try {
      if(editingId){
        var order = project.columns.findIndex(function(c){ return c.id === editingId; });
        var existingCol = getColumn(project, editingId);
        await updateColumnApi(project.serverProjectId, editingId, name, done, color, order, existingCol ? existingCol.cap : -1);
      } else {
        await addColumnApi(project.serverProjectId, name, done, color);
      }
      await refreshProjectFromServer(project.id);
      closeColumnModal();
      renderBoard();
      toast(editingId ? 'Column updated.' : 'Column added.');
    } catch(e){
      toast('Could not save column on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(editingId){
    updateColumn(project, editingId, name, done, color);
    toast('Column updated.');
  } else {
    addColumn(project, name, done, color);
    toast('Column added.');
  }
  closeColumnModal();
  renderBoard();
}

export function deleteColumnFromModal(){
  var project = getCurrentProject();
  var col = getColumn(project, ui.editingColumnId);
  if(!col) return;
  confirmDialog(
    'Delete column "' + col.name + '"?',
    col.order.length > 0 ? 'Its ' + col.order.length + ' task(s) will be permanently deleted.' : 'This column has no tasks.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await deleteColumnOnServer(project, col.id);
          closeColumnModal();
          renderBoard();
          toast('Column deleted.');
        } catch(e){
          toast('Could not delete column on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      if(deleteColumn(project, ui.editingColumnId)){
        closeColumnModal();
        renderBoard();
        toast('Column deleted.');
      }
    }
  );
}
