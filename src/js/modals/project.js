"use strict";
import { ui, toast, resetFilters } from '../ui.js';
import { state } from '../storage.js';
import { localDateValueToUTCISO, utcISOToLocalDateValue } from '../date-utils.js';
import { addProject, renameProject, normalizeLocalProjectKey, isLocalProjectKeyAvailable, changeLocalProjectKey } from '../mutations.js';
import { renderAll, escapeHTML } from '../views/board.js';
import { checkProjectAlerts } from '../features/session-alerts.js';
import { isServerAuthoritative, isServerLoggedIn, createProjectOnServer, updateProjectOnServer, refreshProjectFromServer, fetchTemplatesFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';
import { getProjectHashtags } from '../features/hashtags.js';
import { isOrgAdmin, checkProjectKeyAvailabilityApi, changeProjectKeyApi, checkNewProjectKeyAvailabilityApi } from '../api.js';
import { confirmDialog } from './confirm.js';

// Lazily created on first openProjectModal() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor.
var projectDescEditor = null;
function getProjectDescEditor(){
  if(!projectDescEditor){
    // Whatever project is currently open (state.db.currentProjectId) — for a brand-new project
    // (mode !== 'edit') that's whichever project was open before this modal, or none at all, in
    // which case getProjectHashtags(null) just returns an empty list; the callback is only ever
    // invoked lazily while typing, never at editor-creation time.
    projectDescEditor = createRichTextEditor(document.getElementById('projectDescEditor'), document.getElementById('projectDescToolbar'), { maxLength: 4000, getHashtags: function(){ return getProjectHashtags(state.db.projects[state.db.currentProjectId] || null); } });
  }
  return projectDescEditor;
}

export function openProjectModal(mode){
  ui.editingProjectId = mode === 'edit' ? state.db.currentProjectId : null;
  var project = ui.editingProjectId ? state.db.projects[ui.editingProjectId] : null;
  var isNew = !ui.editingProjectId;
  document.getElementById('projectModalTitle').textContent = project ? 'Edit project' : 'New project';
  document.getElementById('projectNameInput').value = project ? project.name : '';
  var keyInput = document.getElementById('projectKeyInput');
  keyInput.value = project ? project.key : '';
  // Changing an EXISTING server-authoritative project's key cascades to every task's Key column and
  // is Org-Admin-only (see ProjectService.ChangeKeyAsync's own doc comment) — a brand new project has
  // no key to change yet, and a local-only project has no org/roles concept at all (CLAUDE.md §5), so
  // neither case locks the field.
  var lockKey = !isNew && isServerAuthoritative(project) && !isOrgAdmin();
  keyInput.readOnly = lockKey;
  keyInput.classList.toggle('kf-readonly-field', lockKey);
  keyInput.title = lockKey ? 'Only an Org Admin can change the project key.' : '';
  document.getElementById('projectStartDateInput').value = project ? utcISOToLocalDateValue(project.startDate) : '';
  document.getElementById('projectEndDateInput').value = project ? utcISOToLocalDateValue(project.endDate) : '';
  getProjectDescEditor().setMarkdown(project ? project.description : '');
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
  var description = getProjectDescEditor().getMarkdown();

  var isNewProject = !ui.editingProjectId;
  var editingProject = ui.editingProjectId ? state.db.projects[ui.editingProjectId] : null;
  var templateId = isNewProject ? (document.getElementById('projectTemplateSelect').value || null) : null;

  if(!isNewProject && isServerAuthoritative(editingProject)){
    var keyChanged = key !== editingProject.key;
    if(keyChanged && !isOrgAdmin()){
      // Defense in depth — the input is already readOnly for a non-Org-Admin, this only matters if
      // that guard is ever bypassed directly.
      toast('Only an Org Admin can change the project key.');
      return;
    }
    if(keyChanged){
      var avail;
      try {
        avail = await checkProjectKeyAvailabilityApi(editingProject.serverProjectId, key);
      } catch(e){
        toast('Could not check key availability: ' + (e.message || 'unknown error'));
        return;
      }
      if(!avail.available){
        toast('That project key is already in use in your organisation. Please choose a different key.');
        var keyInputEl = document.getElementById('projectKeyInput');
        keyInputEl.focus();
        keyInputEl.select();
        return; // force another key to be entered — modal stays open, nothing saved yet
      }
      confirmDialog(
        'Change project key to "' + avail.normalizedKey + '"?',
        'This updates the key on every task in this project — active and archived — and cannot be undone. ' +
        'Any external links or bookmarks using the old "' + editingProject.key + '-" prefix will stop working.',
        async function(){
          try {
            await updateProjectOnServer(editingProject, name, editingProject.key, startISO, endISO, description);
            await changeProjectKeyApi(editingProject.serverProjectId, avail.normalizedKey);
            await refreshProjectFromServer(editingProject.id);
            closeProjectModal();
            renderAll();
            toast('Project key updated.');
          } catch(e){
            toast('Could not update project key: ' + (e.message || 'unknown error'));
          }
        }
      );
      return;
    }
    try {
      await updateProjectOnServer(editingProject, name, key, startISO, endISO, description);
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
  // the user go through the extra local-then-Migrate-to-Server round trip. Checked for org-wide
  // uniqueness first — the server would otherwise silently auto-suffix a collision (ProjectKeyResolver.
  // ResolveUniqueKeyAsync) with no explicit warning, which is surprising for a key the user just typed.
  if(isNewProject && isServerLoggedIn()){
    var availCreate;
    try {
      availCreate = await checkNewProjectKeyAvailabilityApi(key);
    } catch(e){
      toast('Could not check key availability: ' + (e.message || 'unknown error'));
      return;
    }
    if(!availCreate.available){
      toast('That project key is already in use in your organisation. Please choose a different key.');
      var keyInputCreate = document.getElementById('projectKeyInput');
      keyInputCreate.focus();
      keyInputCreate.select();
      return; // force another key to be entered — nothing created yet
    }
    try {
      var result = await createProjectOnServer(name, availCreate.normalizedKey, startISO, endISO, templateId, description);
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

  // Local-only, editing an EXISTING project: a key change gets the same availability-check + confirm
  // + cascade shape as the cloud Org-Admin flow above, just entirely client-side — no org concept, no
  // role gate (every local user can do this; see CLAUDE.md's "no accounts, no roles" note for
  // local-only projects), but the same "irreversible, touches every task" stakes still apply.
  if(!isNewProject && !isServerAuthoritative(editingProject)){
    var normalizedLocalKey = normalizeLocalProjectKey(key);
    var localKeyChanged = normalizedLocalKey !== editingProject.key;
    if(localKeyChanged){
      if(!isLocalProjectKeyAvailable(normalizedLocalKey, editingProject.id)){
        toast('That project key is already in use by another local project. Please choose a different key.');
        var keyInputLocalEdit = document.getElementById('projectKeyInput');
        keyInputLocalEdit.focus();
        keyInputLocalEdit.select();
        return; // force another key to be entered — nothing saved yet
      }
      confirmDialog(
        'Change project key to "' + normalizedLocalKey + '"?',
        'This updates the key on every task in this project — active and archived — and cannot be undone.',
        function(){
          renameProject(editingProject.id, name, editingProject.key, startISO, endISO, description);
          changeLocalProjectKey(editingProject.id, normalizedLocalKey);
          closeProjectModal();
          renderAll();
          toast('Project key updated.');
        }
      );
      return;
    }
    renameProject(editingProject.id, name, key, startISO, endISO, description);
    toast('Project updated.');
    closeProjectModal();
    renderAll();
    return;
  }

  // Local-only, brand new project: uniqueness is scoped to this browser's own localStorage (there's
  // no organisation to check against yet), same normalization renameProject/createDefaultProject
  // already apply so what's checked here matches exactly what gets stored.
  var normalizedNewLocalKey = normalizeLocalProjectKey(key);
  if(!isLocalProjectKeyAvailable(normalizedNewLocalKey, null)){
    toast('That project key is already in use by another local project. Please choose a different key.');
    var keyInputNewLocal = document.getElementById('projectKeyInput');
    keyInputNewLocal.focus();
    keyInputNewLocal.select();
    return; // force another key to be entered — nothing created yet
  }
  addProject(name, normalizedNewLocalKey, startISO, endISO, templateId, description);
  resetFilters();
  toast('Project created.');
  closeProjectModal();
  renderAll();
  checkProjectAlerts();
}
