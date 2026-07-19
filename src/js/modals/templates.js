"use strict";
import { toast } from '../ui.js';
import { state, buildTemplateSnapshotFromProject } from '../storage.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { addTemplate, renameTemplate, deleteTemplate } from '../mutations.js';
import { isServerLoggedIn, createTemplateOnServer, fetchTemplatesFromServer } from '../features/migration.js';
import { isOrgAdmin, renameTemplateApi, deleteTemplateApi } from '../api.js';
import { confirmDialog } from './confirm.js';
import { hydrateIcons } from '../icons.js';

/* ---- Save as Template (Projects menu) ---- */
export function openSaveAsTemplateModal(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  document.getElementById('saveAsTemplateNameInput').value = project.name + ' Template';
  document.getElementById('saveAsTemplateOverlay').classList.remove('hidden');
  document.getElementById('saveAsTemplateNameInput').focus();
}
export function closeSaveAsTemplateModal(){
  document.getElementById('saveAsTemplateOverlay').classList.add('hidden');
}
export function saveAsTemplateFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var name = document.getElementById('saveAsTemplateNameInput').value.trim();
  if(!name){ toast('Please enter a template name.'); return; }

  var snapshot = buildTemplateSnapshotFromProject(project);

  if(isServerLoggedIn()){
    createTemplateOnServer(name, snapshot).then(function(){
      closeSaveAsTemplateModal();
      toast('Template "' + name + '" saved.');
    }, function(e){
      toast('Could not save template: ' + (e.message || 'unknown error'));
    });
    return;
  }

  addTemplate(name, snapshot);
  closeSaveAsTemplateModal();
  toast('Template "' + name + '" saved.');
}

/* ---- Manage Templates (Admin, next to Manage Users) ---- */
export function openTemplatesModal(){
  if(isServerLoggedIn() && !isOrgAdmin()){ toast('Only an organisation admin can manage templates.'); return; }
  renderTemplatesList();
  document.getElementById('templatesOverlay').classList.remove('hidden');
}
export function closeTemplatesModal(){
  document.getElementById('templatesOverlay').classList.add('hidden');
}

export function renderTemplatesList(){
  var listEl = document.getElementById('templatesList');

  if(isServerLoggedIn()){
    listEl.innerHTML = '<div class="kf-member-empty">Loading…</div>';
    fetchTemplatesFromServer().then(function(templates){
      renderTemplateRows(templates, true);
    }, function(e){
      listEl.innerHTML = '<div class="kf-member-empty">Could not load templates.</div>';
      toast('Could not load templates: ' + (e.message || 'unknown error'));
    });
    return;
  }

  renderTemplateRows(state.db.templates, false);
}

function renderTemplateRows(templates, isServer){
  var listEl = document.getElementById('templatesList');
  listEl.innerHTML = '';
  if(!templates || templates.length === 0){
    listEl.innerHTML = '<div class="kf-member-empty">No templates yet. Use "Save as Template..." from the Projects menu.</div>';
    return;
  }

  templates.slice().sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); }).forEach(function(t){
    var row = document.createElement('div');
    row.className = 'kf-member-row';
    row.innerHTML =
      '<input type="text" class="kf-member-name-input" value="' + escapeHTML(t.name) + '" maxlength="200" aria-label="Template name">' +
      '<button class="kf-btn kf-btn-ghost" data-action="remove-template" title="Delete template">' + '<span class="kf-icon" data-icon="trash" data-size="14"></span>' + '</button>';

    var nameInput = row.querySelector('.kf-member-name-input');
    nameInput.addEventListener('change', function(){
      var newName = nameInput.value.trim();
      if(!newName){ nameInput.value = t.name; return; }

      if(isServer){
        renameTemplateApi(t.id, newName).then(function(){
          renderTemplatesList();
        }, function(e){
          nameInput.value = t.name;
          toast('Could not rename template: ' + (e.message || 'unknown error'));
        });
        return;
      }
      renameTemplate(t.id, newName);
      renderTemplatesList();
    });

    row.querySelector('[data-action="remove-template"]').addEventListener('click', function(){
      confirmDialog(
        'Delete "' + t.name + '"?',
        'This cannot be undone. Projects already created from this template are not affected.',
        function(){
          if(isServer){
            deleteTemplateApi(t.id).then(function(){
              renderTemplatesList();
              toast('Deleted "' + t.name + '".');
            }, function(e){
              toast('Could not delete template: ' + (e.message || 'unknown error'));
            });
            return;
          }
          deleteTemplate(t.id);
          renderTemplatesList();
          toast('Deleted "' + t.name + '".');
        }
      );
    });

    listEl.appendChild(row);
  });

  hydrateIcons(listEl);
}
