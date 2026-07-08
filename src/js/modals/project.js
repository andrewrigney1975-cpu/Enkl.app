"use strict";
import { ui, toast, resetFilters } from '../ui.js';
import { state } from '../storage.js';
import { localDateValueToUTCISO, utcISOToLocalDateValue } from '../date-utils.js';
import { addProject, renameProject } from '../mutations.js';
import { renderAll } from '../views/board.js';
import { checkProjectAlerts } from '../features/session-alerts.js';

export function openProjectModal(mode){
  ui.editingProjectId = mode === 'edit' ? state.db.currentProjectId : null;
  var project = ui.editingProjectId ? state.db.projects[ui.editingProjectId] : null;
  document.getElementById('projectModalTitle').textContent = project ? 'Edit project' : 'New project';
  document.getElementById('projectNameInput').value = project ? project.name : '';
  document.getElementById('projectKeyInput').value = project ? project.key : '';
  document.getElementById('projectStartDateInput').value = project ? utcISOToLocalDateValue(project.startDate) : '';
  document.getElementById('projectEndDateInput').value = project ? utcISOToLocalDateValue(project.endDate) : '';
  document.getElementById('projectOverlay').classList.remove('hidden');
  document.getElementById('projectNameInput').focus();
}
export function closeProjectModal(){
  document.getElementById('projectOverlay').classList.add('hidden');
}
export function saveProjectFromModal(){
  var name = document.getElementById('projectNameInput').value.trim();
  if(!name){ toast('Please enter a project name.'); return; }
  var key = document.getElementById('projectKeyInput').value.trim() || name.replace(/[^A-Za-z]/g,'').slice(0,4).toUpperCase() || 'PROJ';

  var startISO = localDateValueToUTCISO(document.getElementById('projectStartDateInput').value);
  var endISO = localDateValueToUTCISO(document.getElementById('projectEndDateInput').value);
  if(startISO && endISO && new Date(endISO).getTime() < new Date(startISO).getTime()){
    toast('End date cannot be before the start date.');
    return;
  }

  var isNewProject = !ui.editingProjectId;
  if(ui.editingProjectId){
    renameProject(ui.editingProjectId, name, key, startISO, endISO);
    toast('Project updated.');
  } else {
    addProject(name, key, startISO, endISO);
    resetFilters();
    toast('Project created.');
  }
  closeProjectModal();
  renderAll();
  if(isNewProject) checkProjectAlerts();
}
