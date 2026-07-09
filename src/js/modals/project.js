"use strict";
import { ui, toast, resetFilters } from '../ui.js';
import { state } from '../storage.js';
import { localDateValueToUTCISO, utcISOToLocalDateValue } from '../date-utils.js';
import { addProject, renameProject } from '../mutations.js';
import { renderAll } from '../views/board.js';
import { checkProjectAlerts } from '../features/session-alerts.js';
import { isServerAuthoritative, isServerLoggedIn, createProjectOnServer, updateProjectOnServer } from '../features/migration.js';

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
export async function saveProjectFromModal(){
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
  var editingProject = ui.editingProjectId ? state.db.projects[ui.editingProjectId] : null;

  if(!isNewProject && isServerAuthoritative(editingProject)){
    try {
      await updateProjectOnServer(editingProject, name, key, startISO, endISO);
      closeProjectModal();
      renderAll();
      toast('Project updated.');
    } catch(e){
      toast('Could not update project on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  // A brand new project has no server-authoritative state of its own to check (it doesn't exist
  // yet) — if this browser is already logged in, create it directly on the server instead of making
  // the user go through the extra local-then-Migrate-to-Server round trip.
  if(isNewProject && isServerLoggedIn()){
    try {
      var result = await createProjectOnServer(name, key, startISO, endISO);
      resetFilters();
      closeProjectModal();
      renderAll();
      checkProjectAlerts();
      toast('Project created.' + (result.warning ? ' ' + result.warning : ''));
    } catch(e){
      toast('Could not create project on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

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
