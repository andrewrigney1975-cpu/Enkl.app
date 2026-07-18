"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { memberInitials, utcISOToLocalDateValue, localDateValueToUTCISO, utcISOToLocalDisplayDate, isoToServerDateOnly } from '../date-utils.js';
import { getMemberById, getRiskById } from '../utils.js';
import { RISK_LIKELIHOOD_META, RISK_IMPACT_META } from '../config.js';
import { addRisk, updateRisk, deleteRisk, normalizeRiskStatus, getRiskStatusMeta, riskScore, riskScoreBand, clampRiskScoreValue, buildRiskMatrixSvg } from '../mutations.js';
import { renderDocumentPickerInto, renderItemPickerInto, getCheckedDocumentIdsFrom, getCheckedItemIdsFrom } from './pickers.js';
import { populateOwnerSelect, populateTaskSelect } from './documents.js';
import { confirmDialog } from './confirm.js';
import { riskApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';
import { getProjectHashtags } from '../features/hashtags.js';

// Lazily created on first showRisksFormView() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor.
var riskDescEditor = null;
function getRiskDescEditor(){
  if(!riskDescEditor){
    riskDescEditor = createRichTextEditor(document.getElementById('riskDescEditor'), document.getElementById('riskDescToolbar'), { maxLength: 4000, getHashtags: function(){ return getProjectHashtags(getCurrentProject()); } });
  }
  return riskDescEditor;
}

export function populateRiskScoreSelect(selectEl, meta, currentValue){
  selectEl.innerHTML = '';
  [1,2,3,4,5].forEach(function(n){
    var opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n + ' — ' + meta[n].label;
    opt.title = meta[n].description;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentValue || 1;
}
export function updateRiskScorePreview(){
  var likelihood = clampRiskScoreValue(document.getElementById('riskLikelihoodSelect').value);
  var impact = clampRiskScoreValue(document.getElementById('riskImpactSelect').value);
  var score = likelihood * impact;
  var band = riskScoreBand(score);
  var bandLabel = band.charAt(0).toUpperCase() + band.slice(1);
  document.getElementById('riskScorePreview').innerHTML =
    '<span class="kf-risk-score-badge ' + band + '">Score ' + score + ' · ' + bandLabel + '</span>';
}

function renderRiskDocumentPicker(project, selectedDocIds){
  renderDocumentPickerInto('riskDocumentPicker', project, selectedDocIds);
}
function getCheckedRiskDocumentIds(){
  return getCheckedDocumentIdsFrom('riskDocumentPicker');
}

export function openRisksOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.risksSearchTerm = '';
  ui.risksSeverityFilter = '';
  ui.risksStatusFilter = '';
  document.getElementById('risksSearchInput').value = '';
  document.getElementById('risksSeverityFilter').value = '';
  document.getElementById('risksStatusFilter').value = '';
  showRisksListView();
  document.getElementById('risksOverlay').classList.remove('hidden');
}
export function closeRisksOverlay(){
  document.getElementById('risksOverlay').classList.add('hidden');
}
export function isRisksOverlayOpen(){
  return !document.getElementById('risksOverlay').classList.contains('hidden');
}

export function showRisksListView(){
  ui.editingRiskId = null;
  document.getElementById('risksModalTitle').textContent = 'Risks';
  document.getElementById('risksListView').classList.remove('hidden');
  document.getElementById('risksFormView').classList.add('hidden');
  document.getElementById('risksListFooter').classList.remove('hidden');
  document.getElementById('risksFormFooter').classList.add('hidden');
  renderRisksList();
}

export function showRisksFormView(riskId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingRiskId = riskId || null;
  var risk = riskId ? getRiskById(project, riskId) : null;

  document.getElementById('risksModalTitle').textContent = risk ? 'Edit Risk' : 'New Risk';
  document.getElementById('risksListView').classList.add('hidden');
  document.getElementById('risksFormView').classList.remove('hidden');
  document.getElementById('risksListFooter').classList.add('hidden');
  document.getElementById('risksFormFooter').classList.remove('hidden');
  document.getElementById('deleteRiskBtn').classList.toggle('hidden', !risk);

  document.getElementById('riskTitleInput').value = risk ? risk.title : '';
  getRiskDescEditor().setMarkdown(risk ? risk.description : '');
  populateRiskScoreSelect(document.getElementById('riskLikelihoodSelect'), RISK_LIKELIHOOD_META, risk ? risk.likelihood : 1);
  populateRiskScoreSelect(document.getElementById('riskImpactSelect'), RISK_IMPACT_META, risk ? risk.impact : 1);
  updateRiskScorePreview();
  document.getElementById('riskMitigationsInput').value = risk ? risk.mitigations : '';
  document.getElementById('riskStatusSelect').value = risk ? normalizeRiskStatus(risk.status) : 'new';
  populateOwnerSelect(document.getElementById('riskOwnerSelect'), project, risk ? risk.ownerId : null);
  populateTaskSelect(document.getElementById('riskTaskSelect'), project, risk ? risk.taskId : null);
  document.getElementById('riskCloseTargetInput').value = risk ? utcISOToLocalDateValue(risk.dateToClose) : '';
  document.getElementById('riskClosedDateInput').value = risk ? utcISOToLocalDateValue(risk.dateClosed) : '';
  renderRiskDocumentPicker(project, risk ? risk.documentIds : []);
  renderItemPickerInto('riskPrinciplePicker', project.principles || [], risk ? risk.principleIds : [], 'No principles in this project yet.');
  renderItemPickerInto('riskObjectivePicker', project.objectives || [], risk ? risk.objectiveIds : [], 'No objectives in this project yet.');

  document.getElementById('riskTitleInput').focus();
}

export function renderRisksList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('risksList');
  listEl.innerHTML = '';
  if(!project) return;

  var allRisks = (project.risks || []).slice().sort(function(a, b){
    return riskScore(b) - riskScore(a) || a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allRisks.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No risks yet. Add one above to start this project\'s risk register.</div>';
    renderRisksMatrix(allRisks);
    return;
  }

  var term = ui.risksSearchTerm.trim().toLowerCase();
  var statusMatch = /^status:\s*(.*)$/.exec(term);
  var severityFilter = ui.risksSeverityFilter;
  var statusFilter = ui.risksStatusFilter;

  var risks = allRisks.filter(function(r){
    if(severityFilter && riskScoreBand(riskScore(r)) !== severityFilter) return false;
    if(statusFilter && normalizeRiskStatus(r.status) !== statusFilter) return false;
    if(statusMatch){
      var statusQuery = statusMatch[1].trim().replace(/_/g, ' ');
      return getRiskStatusMeta(r.status).label.toLowerCase().indexOf(statusQuery) !== -1;
    }
    if(term){
      var owner = getMemberById(project, r.ownerId);
      var hay = [r.key, r.title, r.description, r.mitigations, owner ? owner.name : ''].join(' ').toLowerCase();
      return hay.indexOf(term) !== -1;
    }
    return true;
  });

  if(risks.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No risks match the current filters.</div>';
    renderRisksMatrix(allRisks);
    return;
  }

  risks.forEach(function(r){
    var owner = getMemberById(project, r.ownerId);
    var statusMeta = getRiskStatusMeta(r.status);
    var score = riskScore(r);
    var band = riskScoreBand(score);

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-risk-id', r.id);

    var metaHTML = '';
    if(owner){
      metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + owner.color + ';">' + escapeHTML(memberInitials(owner.name)) + '</span><span>' + escapeHTML(owner.name) + '</span>';
    } else {
      metaHTML += '<span>Unassigned</span>';
    }
    metaHTML += '<span class="kf-risk-score-badge ' + band + '">Score ' + score + '</span>';
    if(r.documentIds && r.documentIds.length > 0){
      metaHTML += '<span>' + r.documentIds.length + ' doc' + (r.documentIds.length === 1 ? '' : 's') + '</span>';
    }
    if(r.principleIds && r.principleIds.length > 0){
      metaHTML += '<span>' + r.principleIds.length + ' principle' + (r.principleIds.length === 1 ? '' : 's') + '</span>';
    }
    if(r.objectiveIds && r.objectiveIds.length > 0){
      metaHTML += '<span>' + r.objectiveIds.length + ' objective' + (r.objectiveIds.length === 1 ? '' : 's') + '</span>';
    }

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(r.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(r.title) + '</span>' +
        '<span class="kf-risk-status-pill ' + normalizeRiskStatus(r.status) + '">' + escapeHTML(statusMeta.label) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    row.addEventListener('click', function(){ showRisksFormView(r.id); });
    listEl.appendChild(row);
  });

  renderRisksMatrix(allRisks);
}

/* The matrix always plots every risk in the project — unaffected by
   the list's search filter above — so it stays a stable at-a-glance
   overview rather than shrinking as the user types. */
function renderRisksMatrix(allRisks){
  var chartEl = document.getElementById('risksMatrixChart');
  var noDataEl = document.getElementById('risksMatrixNoData');
  var legendEl = document.getElementById('risksMatrixLegend');
  if(allRisks.length === 0){
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'No risks logged yet — add one above to plot it here.';
    return;
  }
  noDataEl.classList.add('hidden');
  chartEl.innerHTML = buildRiskMatrixSvg(allRisks, 560);
  legendEl.innerHTML =
    '<span class="kf-health-legend-item"><span class="kf-health-legend-swatch" style="background:#1b2a4a;border-radius:50%;width:8px;height:8px;"></span>Solid marker = open/in review risk</span>' +
    '<span class="kf-health-legend-item kf-risk-matrix-point-faded" style="opacity:0.55;"><span class="kf-health-legend-swatch" style="background:#1b2a4a;border-radius:50%;width:8px;height:8px;"></span>Faded marker = closed risk</span>';
}

export async function saveRiskFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('riskTitleInput').value.trim();
  if(!title){ toast('Please enter a risk title.'); return; }

  var status = document.getElementById('riskStatusSelect').value;
  var dateToClose = localDateValueToUTCISO(document.getElementById('riskCloseTargetInput').value);
  var dateClosed = localDateValueToUTCISO(document.getElementById('riskClosedDateInput').value);

  var data = {
    title: title,
    description: getRiskDescEditor().getMarkdown(),
    likelihood: document.getElementById('riskLikelihoodSelect').value,
    impact: document.getElementById('riskImpactSelect').value,
    mitigations: document.getElementById('riskMitigationsInput').value,
    ownerId: document.getElementById('riskOwnerSelect').value || null,
    taskId: document.getElementById('riskTaskSelect').value || null,
    documentIds: getCheckedRiskDocumentIds(),
    principleIds: getCheckedItemIdsFrom('riskPrinciplePicker'),
    objectiveIds: getCheckedItemIdsFrom('riskObjectivePicker'),
    status: status,
    dateToClose: dateToClose,
    dateClosed: dateClosed
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingRiskId;
      var body = Object.assign({}, data, {
        likelihood: Number(data.likelihood), impact: Number(data.impact),
        dateToClose: isoToServerDateOnly(data.dateToClose), dateClosed: isoToServerDateOnly(data.dateClosed)
      });
      if(editingId) await riskApi.update(project.serverProjectId, editingId, body);
      else await riskApi.create(project.serverProjectId, body);
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Risk updated.' : 'Risk created.');
      showRisksListView();
    } catch(e){
      toast('Could not save risk on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingRiskId){
    updateRisk(project, ui.editingRiskId, data);
    toast('Risk updated.');
  } else {
    addRisk(project, data);
    toast('Risk created.');
  }
  showRisksListView();
}

export function deleteRiskFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingRiskId) return;
  var risk = getRiskById(project, ui.editingRiskId);
  if(!risk) return;
  confirmDialog(
    'Delete ' + risk.key + '?',
    'This cannot be undone.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await riskApi.remove(project.serverProjectId, risk.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + risk.key + '.');
          showRisksListView();
        } catch(e){
          toast('Could not delete risk on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      deleteRisk(project, risk.id);
      toast('Deleted ' + risk.key + '.');
      showRisksListView();
    }
  );
}
