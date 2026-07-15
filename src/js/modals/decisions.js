"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { memberInitials, utcISOToLocalDisplayDate } from '../date-utils.js';
import { getMemberById, getDecisionById } from '../utils.js';
import { addDecision, updateDecision, deleteDecision, normalizeDecisionType, normalizeDecisionStatus, getDecisionStatusMeta, getDecisionTypeMeta } from '../mutations.js';
import { renderDocumentPickerInto, renderRiskPickerInto, renderItemPickerInto, getCheckedDocumentIdsFrom, getCheckedRiskIdsFrom, getCheckedItemIdsFrom } from './pickers.js';
import { populateOwnerSelect, populateTaskSelect } from './documents.js';
import { populateVocabularyDatalist } from './team.js';
import { confirmDialog } from './confirm.js';
import { decisionApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';

// Lazily created on first showDecisionsFormView() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor.
var decisionDescEditor = null;
function getDecisionDescEditor(){
  if(!decisionDescEditor){
    decisionDescEditor = createRichTextEditor(document.getElementById('decisionDescEditor'), document.getElementById('decisionDescToolbar'), { maxLength: 4000 });
  }
  return decisionDescEditor;
}

export function populateApproverOptions(project){
  var committeeNames = (project.teamsCommittees || [])
    .filter(function(tc){ return tc.type === 'committee'; })
    .map(function(tc){ return tc.name; });
  var combined = (project.approvers || []).slice();
  committeeNames.forEach(function(name){
    var exists = combined.some(function(a){ return a.toLowerCase() === name.toLowerCase(); });
    if(!exists) combined.push(name);
  });
  populateVocabularyDatalist('decisionApproverOptions', combined);
}

function populateDecisionTypeSelect(currentType){
  document.getElementById('decisionTypeSelect').value = normalizeDecisionType(currentType);
}

export function openDecisionsOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.decisionsSearchTerm = '';
  ui.decisionsTypeFilter = '';
  ui.decisionsStatusFilter = '';
  document.getElementById('decisionsSearchInput').value = '';
  document.getElementById('decisionsTypeFilter').value = '';
  document.getElementById('decisionsStatusFilter').value = '';
  showDecisionsListView();
  document.getElementById('decisionsOverlay').classList.remove('hidden');
}
export function closeDecisionsOverlay(){
  document.getElementById('decisionsOverlay').classList.add('hidden');
}
export function isDecisionsOverlayOpen(){
  return !document.getElementById('decisionsOverlay').classList.contains('hidden');
}

export function showDecisionsListView(){
  ui.editingDecisionId = null;
  document.getElementById('decisionsModalTitle').textContent = 'Decisions';
  document.getElementById('decisionsListView').classList.remove('hidden');
  document.getElementById('decisionsFormView').classList.add('hidden');
  document.getElementById('decisionsListFooter').classList.remove('hidden');
  document.getElementById('decisionsFormFooter').classList.add('hidden');
  renderDecisionsList();
}

export function showDecisionsFormView(decisionId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingDecisionId = decisionId || null;
  var decision = decisionId ? getDecisionById(project, decisionId) : null;

  document.getElementById('decisionsModalTitle').textContent = decision ? 'Edit Decision' : 'New Decision';
  document.getElementById('decisionsListView').classList.add('hidden');
  document.getElementById('decisionsFormView').classList.remove('hidden');
  document.getElementById('decisionsListFooter').classList.add('hidden');
  document.getElementById('decisionsFormFooter').classList.remove('hidden');
  document.getElementById('deleteDecisionBtn').classList.toggle('hidden', !decision);

  document.getElementById('decisionTitleInput').value = decision ? decision.title : '';
  getDecisionDescEditor().setMarkdown(decision ? decision.description : '');
  populateDecisionTypeSelect(decision ? decision.type : 'strategy');
  document.getElementById('decisionStatusSelect').value = decision ? normalizeDecisionStatus(decision.status) : 'open';
  populateOwnerSelect(document.getElementById('decisionOwnerSelect'), project, decision ? decision.ownerId : null);
  populateApproverOptions(project);
  document.getElementById('decisionApproverInput').value = decision ? (decision.approver || '') : '';
  populateTaskSelect(document.getElementById('decisionTaskSelect'), project, decision ? decision.taskId : null);
  renderDocumentPickerInto('decisionDocumentPicker', project, decision ? decision.documentIds : []);
  renderRiskPickerInto('decisionRiskPicker', project, decision ? decision.riskIds : []);
  renderItemPickerInto('decisionPrinciplePicker', project.principles || [], decision ? decision.principleIds : [], 'No principles in this project yet.');
  renderItemPickerInto('decisionObjectivePicker', project.objectives || [], decision ? decision.objectiveIds : [], 'No objectives in this project yet.');
  document.getElementById('decisionOutcomeInput').value = decision ? decision.outcome : '';

  var metaEl = document.getElementById('decisionMetaDates');
  if(decision){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(decision.dateCreated) +
      (decision.dateLastModified && decision.dateLastModified !== decision.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(decision.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('decisionTitleInput').focus();
}

export function renderDecisionsList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('decisionsList');
  listEl.innerHTML = '';
  if(!project) return;

  var allDecisions = (project.decisions || []).slice().sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allDecisions.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No decisions yet. Add one above to start this project\'s decision log.</div>';
    return;
  }

  var term = ui.decisionsSearchTerm.trim().toLowerCase();
  var typeFilter = ui.decisionsTypeFilter;
  var statusFilter = ui.decisionsStatusFilter;

  var decisions = allDecisions.filter(function(dec){
    if(typeFilter && normalizeDecisionType(dec.type) !== typeFilter) return false;
    if(statusFilter && normalizeDecisionStatus(dec.status) !== statusFilter) return false;
    if(term){
      var owner = getMemberById(project, dec.ownerId);
      var hay = [dec.key, dec.title, dec.description, dec.outcome, dec.approver || '', owner ? owner.name : ''].join(' ').toLowerCase();
      if(hay.indexOf(term) === -1) return false;
    }
    return true;
  });

  if(decisions.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No decisions match the current filters.</div>';
    return;
  }

  decisions.forEach(function(dec){
    var owner = getMemberById(project, dec.ownerId);
    var typeMeta = getDecisionTypeMeta(dec.type);
    var statusMeta = getDecisionStatusMeta(dec.status);
    var linkedTask = dec.taskId ? project.tasks[dec.taskId] : null;

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-decision-id', dec.id);

    var metaHTML = '';
    if(owner){
      metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + owner.color + ';">' + escapeHTML(memberInitials(owner.name)) + '</span><span>' + escapeHTML(owner.name) + '</span>';
    } else {
      metaHTML += '<span>Unassigned</span>';
    }
    metaHTML += '<span>Added ' + escapeHTML(utcISOToLocalDisplayDate(dec.dateCreated)) + '</span>';
    if(dec.approver) metaHTML += '<span>Approver: ' + escapeHTML(dec.approver) + '</span>';
    if(linkedTask) metaHTML += '<span>' + escapeHTML(linkedTask.key) + '</span>';
    if(dec.documentIds && dec.documentIds.length > 0){
      metaHTML += '<span>' + dec.documentIds.length + ' doc' + (dec.documentIds.length === 1 ? '' : 's') + '</span>';
    }
    if(dec.riskIds && dec.riskIds.length > 0){
      metaHTML += '<span>' + dec.riskIds.length + ' risk' + (dec.riskIds.length === 1 ? '' : 's') + '</span>';
    }
    if(dec.principleIds && dec.principleIds.length > 0){
      metaHTML += '<span>' + dec.principleIds.length + ' principle' + (dec.principleIds.length === 1 ? '' : 's') + '</span>';
    }
    if(dec.objectiveIds && dec.objectiveIds.length > 0){
      metaHTML += '<span>' + dec.objectiveIds.length + ' objective' + (dec.objectiveIds.length === 1 ? '' : 's') + '</span>';
    }

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(dec.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(dec.title) + '</span>' +
        '<span class="kf-decision-type-pill">' + escapeHTML(typeMeta.label) + '</span>' +
        '<span class="kf-decision-status-pill ' + normalizeDecisionStatus(dec.status) + '">' + escapeHTML(statusMeta.label) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    row.addEventListener('click', function(){ showDecisionsFormView(dec.id); });
    listEl.appendChild(row);
  });
}

export async function saveDecisionFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('decisionTitleInput').value.trim();
  if(!title){ toast('Please enter a decision title.'); return; }

  var data = {
    title: title,
    description: getDecisionDescEditor().getMarkdown(),
    type: document.getElementById('decisionTypeSelect').value,
    status: document.getElementById('decisionStatusSelect').value,
    outcome: document.getElementById('decisionOutcomeInput').value,
    ownerId: document.getElementById('decisionOwnerSelect').value || null,
    approver: document.getElementById('decisionApproverInput').value,
    taskId: document.getElementById('decisionTaskSelect').value || null,
    documentIds: getCheckedDocumentIdsFrom('decisionDocumentPicker'),
    riskIds: getCheckedRiskIdsFrom('decisionRiskPicker'),
    principleIds: getCheckedItemIdsFrom('decisionPrinciplePicker'),
    objectiveIds: getCheckedItemIdsFrom('decisionObjectivePicker')
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingDecisionId;
      if(editingId) await decisionApi.update(project.serverProjectId, editingId, data);
      else await decisionApi.create(project.serverProjectId, data);
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Decision updated.' : 'Decision created.');
      showDecisionsListView();
    } catch(e){
      toast('Could not save decision on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingDecisionId){
    updateDecision(project, ui.editingDecisionId, data);
    toast('Decision updated.');
  } else {
    addDecision(project, data);
    toast('Decision created.');
  }
  showDecisionsListView();
}

export function deleteDecisionFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingDecisionId) return;
  var decision = getDecisionById(project, ui.editingDecisionId);
  if(!decision) return;
  confirmDialog(
    'Delete ' + decision.key + '?',
    'This cannot be undone.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await decisionApi.remove(project.serverProjectId, decision.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + decision.key + '.');
          showDecisionsListView();
        } catch(e){
          toast('Could not delete decision on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      deleteDecision(project, decision.id);
      toast('Deleted ' + decision.key + '.');
      showDecisionsListView();
    }
  );
}
