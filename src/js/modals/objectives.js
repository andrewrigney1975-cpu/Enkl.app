"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { utcISOToLocalDisplayDate } from '../date-utils.js';
import { getObjectiveById } from '../utils.js';
import { addObjective, updateObjective, deleteObjective } from '../mutations.js';
import { renderItemPickerInto, getCheckedItemIdsFrom } from './pickers.js';
import { confirmDialog } from './confirm.js';
import { objectiveApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';

// Lazily created on first showObjectivesFormView() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor.
var objectiveDescEditor = null;
function getObjectiveDescEditor(){
  if(!objectiveDescEditor){
    objectiveDescEditor = createRichTextEditor(document.getElementById('objectiveDescEditor'), document.getElementById('objectiveDescToolbar'), { maxLength: 4000 });
  }
  return objectiveDescEditor;
}

export function openObjectivesOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.objectivesSearchTerm = '';
  document.getElementById('objectivesSearchInput').value = '';
  showObjectivesListView();
  document.getElementById('objectivesOverlay').classList.remove('hidden');
}
export function closeObjectivesOverlay(){
  document.getElementById('objectivesOverlay').classList.add('hidden');
}
export function isObjectivesOverlayOpen(){
  return !document.getElementById('objectivesOverlay').classList.contains('hidden');
}

export function showObjectivesListView(){
  ui.editingObjectiveId = null;
  document.getElementById('objectivesModalTitle').textContent = 'Objectives';
  document.getElementById('objectivesListView').classList.remove('hidden');
  document.getElementById('objectivesFormView').classList.add('hidden');
  document.getElementById('objectivesListFooter').classList.remove('hidden');
  document.getElementById('objectivesFormFooter').classList.add('hidden');
  renderObjectivesList();
}

export function showObjectivesFormView(objectiveId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingObjectiveId = objectiveId || null;
  var objective = objectiveId ? getObjectiveById(project, objectiveId) : null;

  document.getElementById('objectivesModalTitle').textContent = objective ? 'Edit Objective' : 'New Objective';
  document.getElementById('objectivesListView').classList.add('hidden');
  document.getElementById('objectivesFormView').classList.remove('hidden');
  document.getElementById('objectivesListFooter').classList.add('hidden');
  document.getElementById('objectivesFormFooter').classList.remove('hidden');
  document.getElementById('deleteObjectiveBtn').classList.toggle('hidden', !objective);

  document.getElementById('objectiveTitleInput').value = objective ? objective.title : '';
  getObjectiveDescEditor().setMarkdown(objective ? objective.description : '');
  renderItemPickerInto('objectivePrinciplePicker', project.principles || [], objective ? objective.principleIds : [], 'No principles in this project yet.');

  var metaEl = document.getElementById('objectiveMetaDates');
  if(objective){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(objective.dateCreated) +
      (objective.dateLastModified && objective.dateLastModified !== objective.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(objective.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('objectiveTitleInput').focus();
}

export function renderObjectivesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('objectivesList');
  listEl.innerHTML = '';
  if(!project) return;

  var allObjectives = (project.objectives || []).slice().sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allObjectives.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No objectives yet. Add one above to start tracking this project\'s goals.</div>';
    return;
  }

  var term = ui.objectivesSearchTerm.trim().toLowerCase();
  var objectives = term ? allObjectives.filter(function(o){
    var hay = [o.key, o.title, o.description].join(' ').toLowerCase();
    return hay.indexOf(term) !== -1;
  }) : allObjectives;

  if(objectives.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No objectives match “' + escapeHTML(ui.objectivesSearchTerm.trim()) + '”.</div>';
    return;
  }

  objectives.forEach(function(o){
    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-objective-id', o.id);

    var metaHTML = '<span>Added ' + escapeHTML(utcISOToLocalDisplayDate(o.dateCreated)) + '</span>';
    if(o.principleIds && o.principleIds.length > 0){
      metaHTML += '<span>' + o.principleIds.length + ' principle' + (o.principleIds.length === 1 ? '' : 's') + '</span>';
    }

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(o.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(o.title) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    row.addEventListener('click', function(){ showObjectivesFormView(o.id); });
    listEl.appendChild(row);
  });
}

export async function saveObjectiveFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('objectiveTitleInput').value.trim();
  if(!title){ toast('Please enter an objective title.'); return; }

  var data = {
    title: title,
    description: getObjectiveDescEditor().getMarkdown(),
    principleIds: getCheckedItemIdsFrom('objectivePrinciplePicker')
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingObjectiveId;
      if(editingId) await objectiveApi.update(project.serverProjectId, editingId, data);
      else await objectiveApi.create(project.serverProjectId, data);
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Objective updated.' : 'Objective created.');
      showObjectivesListView();
    } catch(e){
      toast('Could not save objective on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingObjectiveId){
    updateObjective(project, ui.editingObjectiveId, data);
    toast('Objective updated.');
  } else {
    addObjective(project, data);
    toast('Objective created.');
  }
  showObjectivesListView();
}

export function deleteObjectiveFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingObjectiveId) return;
  var objective = getObjectiveById(project, ui.editingObjectiveId);
  if(!objective) return;
  confirmDialog(
    'Delete ' + objective.key + '?',
    'Any risks or decisions linking to this objective will have the link removed.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await objectiveApi.remove(project.serverProjectId, objective.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + objective.key + '.');
          showObjectivesListView();
        } catch(e){
          toast('Could not delete objective on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      var unlinked = deleteObjective(project, objective.id);
      toast('Deleted ' + objective.key + (unlinked > 0 ? ' — removed ' + unlinked + ' link(s) from risks/decisions.' : '.'));
      showObjectivesListView();
    }
  );
}
