"use strict";
import { ui, toast, resetFilters } from '../ui.js';
import { state } from '../storage.js';
import { localDateValueToUTCISO, utcISOToLocalDateValue } from '../date-utils.js';
import { addProject, renameProject } from '../mutations.js';
import { renderAll, escapeHTML } from '../views/board.js';
import { checkProjectAlerts } from '../features/session-alerts.js';
import { isServerAuthoritative, isServerLoggedIn, createProjectOnServer, updateProjectOnServer, fetchTemplatesFromServer } from '../features/migration.js';

export function openProjectModal(mode){
  ui.editingProjectId = mode === 'edit' ? state.db.currentProjectId : null;
  var project = ui.editingProjectId ? state.db.projects[ui.editingProjectId] : null;
  var isNew = !ui.editingProjectId;
  document.getElementById('projectModalTitle').textContent = project ? 'Edit project' : 'New project';
  document.getElementById('projectNameInput').value = project ? project.name : '';
  document.getElementById('projectKeyInput').value = project ? project.key : '';
  document.getElementById('projectStartDateInput').value = project ? utcISOToLocalDateValue(project.startDate) : '';
  document.getElementById('projectEndDateInput').value = project ? utcISOToLocalDateValue(project.endDate) : '';
  document.getElementById('projectTemplateField').classList.toggle('hidden', !isNew);
  if(isNew) populateProjectTemplateSelect();
  document.getElementById('projectOverlay').classList.remove('hidden');
  document.getElementById('projectNameInput').focus();
}

/* Only shown for a brand new project — templates only ever apply at creation time. Populated from
   the server (Organisation-owned, shared across every member) when signed in, else from this
   browser's local fallback list (state.db.templates, see mutations.js addTemplate). */
function populateProjectTemplateSelect(){
  var select = document.getElementById('projectTemplateSelect');
  select.innerHTML = '<option value="">Blank project</option>';

  function appendOptions(templates){
    templates.slice().sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); }).forEach(function(t){
      select.insertAdjacentHTML('beforeend', '<option value="' + t.id + '">' + escapeHTML(t.name) + '</option>');
    });
  }

  if(isServerLoggedIn()){
    fetchTemplatesFromServer().then(appendOptions, function(){ /* leave just "Blank project" on failure */ });
  } else {
    appendOptions(state.db.templates);
  }
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
  var templateId = isNewProject ? (document.getElementById('projectTemplateSelect').value || null) : null;

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
      var result = await createProjectOnServer(name, key, startISO, endISO, templateId);
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
    addProject(name, key, startISO, endISO, templateId);
    resetFilters();
    toast('Project created.');
  }
  closeProjectModal();
  renderAll();
  if(isNewProject) checkProjectAlerts();
}
