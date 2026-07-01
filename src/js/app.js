"use strict";

/* ---- Core ---- */
import { state, loadDB, saveDB } from './storage.js';
import { getCurrentProject } from './store.js';
import { ui, toast, resetFilters, renderThemeToggleIcon, toggleTheme, relocateViewButtonsForViewport, toggleSideNav, toggleMobileDrawer, closeMobileDrawer, isMobileDrawerOpen } from './ui.js';
import { hydrateIcons } from './icons.js';
import { clampTaskScore, utcISOToLocalDisplayDate } from './date-utils.js';
import { getTasksArray, isTaskOverdue, isTaskUnscored } from './utils.js';

/* ---- Mutations ---- */
import { deleteProject, closeAllTaskTypeIconPanels, setMutationsToast } from './mutations.js';

/* ---- Views ---- */
import { renderAll, renderBoard, setBoardDeps, closeTeamFilterPanel, closeAssigneeFilterPanel, closeTaskTypeFilterPanel, toggleTeamFilterPanel, toggleAssigneeFilterPanel, toggleTaskTypeFilterPanel, openAppSettingsOverlay, closeAppSettingsOverlay, isAppSettingsOverlayOpen, updateHeaderButtonVisibilitySetting } from './views/board.js';
import { setTaskListDeps, openTaskListOverlay, closeTaskListOverlay, isTaskListOpen, renderTaskListBody, collapseAllTaskListGroups, expandAllTaskListGroups, exportTaskListAsCsv } from './views/task-list.js';
import { setDepMapDeps, depMapState, lastDepLayout, openDepMapOverlay, closeDepMapOverlay, isDepMapOpen, toggleDepMapShowArchived, setDepMapZoom, resetDepMapZoom, zoomDepMapAtPoint } from './views/dependency-map.js';
import { setOrgChartDeps, orgChartState, lastOrgChartLayout, openOrgChartOverlay, closeOrgChartOverlay, isOrgChartOpen, toggleOrgChartFilter, setOrgChartZoom, resetOrgChartZoom, zoomOrgChartAtPoint, openOrgChartMemberPopover, closeOrgChartMemberPopover, isOrgChartMemberPopoverOpen } from './views/org-chart.js';
import { setTimelineDeps, openTimelineOverlay, closeTimelineOverlay, isTimelineOverlayOpen, toggleTimelineShowArchived, renderTimeline } from './views/timeline.js';
import { setCostBenefitDeps, cbZoomState, openCostBenefitOverlay, closeCostBenefitOverlay, isCostBenefitOverlayOpen, toggleCostBenefitShowArchived, setCbZoom, resetCbZoom, zoomCbAtPoint } from './views/cost-benefit.js';

/* ---- Features ---- */
import { exportProjectJSON } from './features/export.js';
import { importProjectFromFile, pendingImport, closeImportConflictModal, overwriteProjectFromResult, finaliseImport, uniqueProjectKey } from './features/import.js';
import { setBulkEditDeps, openBulkEditOverlay, closeBulkEditOverlay, isBulkEditOverlayOpen, saveBulkEditChanges } from './features/bulk-edit.js';
import { getArchivedTasks, openArchivedTasksOverlay, closeArchivedTasksOverlay, isArchivedTasksOverlayOpen, renderArchivedTasksList, reactivateSelectedArchivedTasks } from './features/archived-tasks.js';
import { closeAllExportAsPanels, toggleExportAsPanel, exportSvgElementAsSvgFile, exportSvgElementAsPng } from './features/svg-export.js';

/* ---- Modals ---- */
import { confirmDialog, closeConfirmDialog, getPendingConfirmAction } from './modals/confirm.js';
import { openTaskModal, closeTaskModal, saveTaskFromModal, deleteTaskFromModal, updatePriorityIcon, updateDocUrlOpenButtonVisibility, openDocUrlInNewTab, renderDependencyPicker } from './modals/task.js';
import { openColumnModal, closeColumnModal, saveColumnFromModal, deleteColumnFromModal } from './modals/column.js';
import { openProjectModal, closeProjectModal, saveProjectFromModal } from './modals/project.js';
import { openTeamModal, closeTeamModal, addMemberFromModal } from './modals/team.js';
import { openTaskTypesModal, closeTaskTypesModal, addTaskTypeFromModal } from './modals/task-types.js';
import { openReleasesOverlay, closeReleasesOverlay, isReleasesOverlayOpen, showReleasesFormView, showReleasesListView, saveReleaseFromModal, deleteReleaseFromModal } from './modals/releases.js';
import { openDocumentsOverlay, closeDocumentsOverlay, isDocumentsOverlayOpen, showDocumentsFormView, showDocumentsListView, renderDocumentsList, saveDocumentFromModal, deleteDocumentFromModal, updateDocUrlOpenButtonVisibilityFor, openUrlInputInNewTab } from './modals/documents.js';
import { scheduleDocumentSuggestions } from './features/document-suggestions.js';
import { openRisksOverlay, closeRisksOverlay, isRisksOverlayOpen, showRisksFormView, showRisksListView, renderRisksList, saveRiskFromModal, deleteRiskFromModal, updateRiskScorePreview } from './modals/risks.js';
import { openHealthOverlay, closeHealthOverlay, isHealthOverlayOpen, cancelHealthGaugeAnimation } from './modals/health.js';
import { openDecisionsOverlay, closeDecisionsOverlay, isDecisionsOverlayOpen, showDecisionsFormView, showDecisionsListView, renderDecisionsList, saveDecisionFromModal, deleteDecisionFromModal } from './modals/decisions.js';
import { openPrinciplesOverlay, closePrinciplesOverlay, isPrinciplesOverlayOpen, showPrinciplesFormView, showPrinciplesListView, renderPrinciplesList, savePrincipleFromModal, deletePrincipleFromModal } from './modals/principles.js';
import { openObjectivesOverlay, closeObjectivesOverlay, isObjectivesOverlayOpen, showObjectivesFormView, showObjectivesListView, renderObjectivesList, saveObjectiveFromModal, deleteObjectiveFromModal } from './modals/objectives.js';
import { openTeamsCommitteesOverlay, closeTeamsCommitteesOverlay, isTeamsCommitteesOverlayOpen, showTeamCommitteeFormView, showTeamsCommitteesListView, renderTeamsCommitteesList, saveTeamCommitteeFromModal, deleteTeamCommitteeFromModal } from './modals/teams-committees.js';
import { openProjectSearchOverlay, closeProjectSearchOverlay, isProjectSearchOverlayOpen, handleProjectSearchInput, handleProjectSearchResultClick } from './modals/project-search.js';

/* ---- Dependency injection (break circular import chains) ---- */
setBoardDeps({ toast, confirmDialog, openTaskModal, openColumnModal });
setTaskListDeps({ toast, openTaskModal });
setDepMapDeps({ toast, openTaskModal });
setOrgChartDeps({ toast });
setTimelineDeps({ toast, openTaskModal });
setCostBenefitDeps({ toast, openTaskModal });
setBulkEditDeps({ confirmDialog, exportProjectJSON });
setMutationsToast(toast);

/* =========================================================
   BACKUP REMINDER
   ========================================================= */
var BACKUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
var backupQueue = [];

function checkOverdueAlert(){
  var project = getCurrentProject();
  if(!project){ checkDefaultScoreAlert(); return; }

  var overdueTasks = getTasksArray(project).filter(function(t){ return isTaskOverdue(project, t); });
  if(overdueTasks.length === 0){ checkDefaultScoreAlert(); return; }

  overdueTasks.sort(function(a, b){ return new Date(a.endDate).getTime() - new Date(b.endDate).getTime(); });

  var msg = '“' + project.name + '” has ' + overdueTasks.length + ' task' +
            (overdueTasks.length === 1 ? '' : 's') + ' with an end date in the past.';
  document.getElementById('overdueAlertMessage').textContent = msg;

  var listEl = document.getElementById('overdueAlertList');
  listEl.innerHTML = '';
  var maxShown = 6;
  overdueTasks.slice(0, maxShown).forEach(function(t){
    var row = document.createElement('div');
    row.className = 'kf-overdue-alert-row';
    var d = document.createElement('div');
    d.innerHTML =
      '<span class="kf-dep-key"></span>' +
      '<span class="kf-overdue-alert-title"></span>' +
      '<span class="kf-overdue-alert-date"></span>';
    d.querySelector('.kf-dep-key').textContent = t.key;
    d.querySelector('.kf-overdue-alert-title').textContent = t.title;
    d.querySelector('.kf-overdue-alert-date').textContent = utcISOToLocalDisplayDate(t.endDate);
    row.appendChild(d.querySelector('.kf-dep-key'));
    row.appendChild(d.querySelector('.kf-overdue-alert-title'));
    row.appendChild(d.querySelector('.kf-overdue-alert-date'));
    listEl.appendChild(row);
  });
  if(overdueTasks.length > maxShown){
    var more = document.createElement('div');
    more.className = 'kf-overdue-alert-more';
    more.textContent = '+ ' + (overdueTasks.length - maxShown) + ' more';
    listEl.appendChild(more);
  }

  document.getElementById('overdueAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('overdueAlertOverlay'));
}

function closeOverdueAlert(){
  document.getElementById('overdueAlertOverlay').classList.add('hidden');
  checkDefaultScoreAlert();
}

function checkDefaultScoreAlert(){
  var project = getCurrentProject();
  if(!project){ checkBackupReminders(); return; }

  var unscoredTasks = getTasksArray(project).filter(function(t){
    return !t.archived && isTaskUnscored(t);
  });
  if(unscoredTasks.length === 0){ checkBackupReminders(); return; }

  unscoredTasks.sort(function(a, b){ return a.key.localeCompare(b.key, undefined, {numeric: true}); });

  var msg = project.name + ' has ' + unscoredTasks.length + ' task' +
            (unscoredTasks.length === 1 ? '' : 's') + ' that ' + (unscoredTasks.length === 1 ? 'has not' : 'have not') + ' been scored — ' +
            'Business Value and Task Cost are still at the default of 1.';
  document.getElementById('defaultScoreAlertMessage').textContent = msg;

  var listEl = document.getElementById('defaultScoreAlertList');
  listEl.innerHTML = '';
  var maxShown = 6;
  unscoredTasks.slice(0, maxShown).forEach(function(t){
    var row = document.createElement('div');
    row.className = 'kf-defaultscore-alert-row';
    var keyEl = document.createElement('span');
    keyEl.className = 'kf-dep-key';
    keyEl.textContent = t.key;
    var titleEl = document.createElement('span');
    titleEl.className = 'kf-defaultscore-alert-title';
    titleEl.textContent = t.title;
    var scoreEl = document.createElement('span');
    scoreEl.className = 'kf-defaultscore-alert-scores';
    scoreEl.textContent = 'BV ' + clampTaskScore(t.businessValue) + ' · Cost ' + clampTaskScore(t.taskCost);
    row.appendChild(keyEl);
    row.appendChild(titleEl);
    row.appendChild(scoreEl);
    listEl.appendChild(row);
  });
  if(unscoredTasks.length > maxShown){
    var more = document.createElement('div');
    more.className = 'kf-defaultscore-alert-more';
    more.textContent = '+ ' + (unscoredTasks.length - maxShown) + ' more';
    listEl.appendChild(more);
  }

  document.getElementById('defaultScoreAlertOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('defaultScoreAlertOverlay'));
}

function closeDefaultScoreAlert(){
  document.getElementById('defaultScoreAlertOverlay').classList.add('hidden');
  checkBackupReminders();
}

function checkBackupReminders(){
  var db = state.db;
  var now = Date.now();
  db.projectOrder.forEach(function(pid){
    var p = db.projects[pid];
    if(!p) return;
    var referenceDate = p.dateLastExported || p.dateCreated || null;
    if(!referenceDate) return;
    var age = now - new Date(referenceDate).getTime();
    if(age > BACKUP_THRESHOLD_MS){
      backupQueue.push(pid);
    }
  });
  advanceBackupQueue();
}

function advanceBackupQueue(){
  if(backupQueue.length === 0) return;
  var db = state.db;
  var pid = backupQueue[0];
  var project = db.projects[pid];
  if(!project){ backupQueue.shift(); advanceBackupQueue(); return; }

  var refDate = project.dateLastExported || project.dateCreated;
  var daysSince = Math.floor((Date.now() - new Date(refDate).getTime()) / (24 * 60 * 60 * 1000));
  var action = project.dateLastExported ? 'last backed up' : 'created';
  var msg =
    '“' + project.name + '” (' + project.key + ') was ' + action + ' ' + daysSince +
    ' day' + (daysSince === 1 ? '' : 's') + ' ago and has no recent backup. ' +
    'Would you like to export a backup now?';

  document.getElementById('backupReminderMessage').textContent = msg;
  document.getElementById('backupReminderOverlay').classList.remove('hidden');
  hydrateIcons(document.getElementById('backupReminderOverlay'));
}

function closeBackupReminderModal(){
  document.getElementById('backupReminderOverlay').classList.add('hidden');
}

function dismissBackupReminder(){
  backupQueue.shift();
  closeBackupReminderModal();
  if(backupQueue.length > 0){
    setTimeout(advanceBackupQueue, 300);
  }
}

function runBackupForReminder(){
  var db = state.db;
  var pid = backupQueue[0];
  var project = pid ? db.projects[pid] : null;
  closeBackupReminderModal();
  backupQueue.shift();
  if(project){
    exportProjectJSON(project);
  }
  if(backupQueue.length > 0){
    setTimeout(advanceBackupQueue, 400);
  }
}

/* =========================================================
   EVENT WIRING
   ========================================================= */
function wireEvents(){
  hydrateIcons(document);
  document.getElementById('kfLogoIcon').innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="0" y="0" width="24" height="24" fill="#0c66e4"/>' +
      '<rect x="5" y="6" width="4" height="12" rx="1" fill="#fff"/>' +
      '<rect x="10.5" y="6" width="4" height="7" rx="1" fill="#fff" opacity=".85"/>' +
      '<rect x="16" y="6" width="4" height="10" rx="1" fill="#fff" opacity=".7"/>' +
    '</svg>';
  renderThemeToggleIcon();

  document.getElementById('sideNavToggle').addEventListener('click', toggleSideNav);
  document.getElementById('navTaskListBtn').addEventListener('click', openTaskListOverlay);
  document.getElementById('navTimelineBtn').addEventListener('click', openTimelineOverlay);
  document.getElementById('navDepMapBtn').addEventListener('click', openDepMapOverlay);
  document.getElementById('navCostBenefitBtn').addEventListener('click', openCostBenefitOverlay);
  document.getElementById('navOrgChartBtn').addEventListener('click', openOrgChartOverlay);
  document.getElementById('navBulkEditBtn').addEventListener('click', openBulkEditOverlay);
  document.getElementById('navArchivedBtn').addEventListener('click', openArchivedTasksOverlay);
  document.getElementById('navTaskTypesBtn').addEventListener('click', openTaskTypesModal);
  document.getElementById('navReleasesBtn').addEventListener('click', openReleasesOverlay);

  document.getElementById('projectSelect').addEventListener('change', function(e){
    state.db.currentProjectId = e.target.value;
    saveDB();
    resetFilters();
    renderAll();
  });
  document.getElementById('newProjectBtn').addEventListener('click', function(){ openProjectModal('new'); });
  document.getElementById('importProjectBtn').addEventListener('click', function(){
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', function(e){
    var file = e.target.files && e.target.files[0];
    importProjectFromFile(file);
    e.target.value = '';
  });
  document.getElementById('importConflictClose').addEventListener('click', closeImportConflictModal);
  document.getElementById('importConflictCancelBtn').addEventListener('click', closeImportConflictModal);
  document.getElementById('importConflictOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'importConflictOverlay') closeImportConflictModal();
  });
  document.getElementById('importConflictOverwriteBtn').addEventListener('click', function(){
    if(!pendingImport) return;
    var r = pendingImport.result;
    var existingId = pendingImport.conflictId;
    closeImportConflictModal();
    r.project.id = existingId;
    overwriteProjectFromResult(existingId, r);
    finaliseImport(r, true);
  });
  document.getElementById('importConflictCopyBtn').addEventListener('click', function(){
    if(!pendingImport) return;
    var r = pendingImport.result;
    closeImportConflictModal();
    r.project.key = uniqueProjectKey(r.project.key);
    finaliseImport(r, false);
  });
  document.getElementById('editProjectBtn').addEventListener('click', function(){
    if(!getCurrentProject()){ toast('No project to edit.'); return; }
    openProjectModal('edit');
  });
  document.getElementById('manageTeamBtn').addEventListener('click', openTeamModal);
  document.getElementById('teamModalClose').addEventListener('click', closeTeamModal);
  document.getElementById('teamDoneBtn').addEventListener('click', closeTeamModal);
  document.getElementById('addMemberBtn').addEventListener('click', addMemberFromModal);
  document.getElementById('newMemberNameInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); addMemberFromModal(); }
  });
  document.getElementById('teamOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'teamOverlay') closeTeamModal();
  });
  document.getElementById('taskTypesBtn').addEventListener('click', openTaskTypesModal);
  document.getElementById('taskTypesModalClose').addEventListener('click', closeTaskTypesModal);
  document.getElementById('taskTypesDoneBtn').addEventListener('click', closeTaskTypesModal);
  document.getElementById('addTaskTypeBtn').addEventListener('click', addTaskTypeFromModal);
  document.getElementById('newTaskTypeNameInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); addTaskTypeFromModal(); }
  });
  document.getElementById('taskTypesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'taskTypesOverlay') closeTaskTypesModal();
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.kf-tasktype-icon-wrap')) closeAllTaskTypeIconPanels();
  });
  document.getElementById('taskTypeList').addEventListener('scroll', closeAllTaskTypeIconPanels);
  document.addEventListener('click', function(e){
    if(!e.target.closest('.kf-export-as-wrap')) closeAllExportAsPanels();
  });
  document.getElementById('releasesBtn').addEventListener('click', openReleasesOverlay);
  document.getElementById('releasesModalClose').addEventListener('click', closeReleasesOverlay);
  document.getElementById('releasesDoneBtn').addEventListener('click', closeReleasesOverlay);
  document.getElementById('releasesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'releasesOverlay') closeReleasesOverlay();
  });
  document.getElementById('addReleaseBtn').addEventListener('click', function(){ showReleasesFormView(null); });
  document.getElementById('releaseFormCancelBtn').addEventListener('click', showReleasesListView);
  document.getElementById('releaseFormSaveBtn').addEventListener('click', saveReleaseFromModal);
  document.getElementById('deleteReleaseBtn').addEventListener('click', deleteReleaseFromModal);

  document.getElementById('documentsBtn').addEventListener('click', openDocumentsOverlay);
  document.getElementById('documentsModalClose').addEventListener('click', closeDocumentsOverlay);
  document.getElementById('documentsDoneBtn').addEventListener('click', closeDocumentsOverlay);
  document.getElementById('documentsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'documentsOverlay') closeDocumentsOverlay();
  });
  document.getElementById('addDocumentBtn').addEventListener('click', function(){ showDocumentsFormView(null); });
  document.getElementById('documentsSearchInput').addEventListener('input', function(e){
    ui.documentsSearchTerm = e.target.value;
    renderDocumentsList();
  });
  document.getElementById('documentFormCancelBtn').addEventListener('click', showDocumentsListView);
  document.getElementById('documentFormSaveBtn').addEventListener('click', saveDocumentFromModal);
  document.getElementById('deleteDocumentBtn').addEventListener('click', deleteDocumentFromModal);
  document.getElementById('documentUrlInput').addEventListener('input', function(){
    updateDocUrlOpenButtonVisibilityFor('documentUrlInput', 'documentUrlOpenBtn');
  });
  document.getElementById('documentUrlOpenBtn').addEventListener('click', function(){ openUrlInputInNewTab('documentUrlInput'); });
  document.getElementById('documentTitleInput').addEventListener('input', function(){
    scheduleDocumentSuggestions(getCurrentProject(), ui.editingDocumentId);
  });
  document.getElementById('documentDescriptionInput').addEventListener('input', function(){
    scheduleDocumentSuggestions(getCurrentProject(), ui.editingDocumentId);
  });
  document.getElementById('documentsMapExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('documentsMapExportAsPanel');
  });
  document.querySelectorAll('#documentsMapExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-document-map';
      var svgEl = document.querySelector('#documentsMapChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('documentsMapChart').addEventListener('click', function(e){
    var node = e.target.closest('.kf-docmap-node');
    if(!node) return;
    showDocumentsFormView(node.getAttribute('data-document-id'));
  });

  document.getElementById('risksBtn').addEventListener('click', openRisksOverlay);
  document.getElementById('risksModalClose').addEventListener('click', closeRisksOverlay);
  document.getElementById('risksDoneBtn').addEventListener('click', closeRisksOverlay);
  document.getElementById('risksOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'risksOverlay') closeRisksOverlay();
  });
  document.getElementById('addRiskBtn').addEventListener('click', function(){ showRisksFormView(null); });
  document.getElementById('risksSearchInput').addEventListener('input', function(e){
    ui.risksSearchTerm = e.target.value;
    renderRisksList();
  });
  document.getElementById('riskFormCancelBtn').addEventListener('click', showRisksListView);
  document.getElementById('riskFormSaveBtn').addEventListener('click', saveRiskFromModal);
  document.getElementById('deleteRiskBtn').addEventListener('click', deleteRiskFromModal);
  document.getElementById('riskLikelihoodSelect').addEventListener('change', updateRiskScorePreview);
  document.getElementById('riskImpactSelect').addEventListener('change', updateRiskScorePreview);

  document.getElementById('decisionsBtn').addEventListener('click', openDecisionsOverlay);
  document.getElementById('healthBtn').addEventListener('click', openHealthOverlay);
  document.getElementById('healthClose').addEventListener('click', closeHealthOverlay);
  document.getElementById('healthOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'healthOverlay'){ cancelHealthGaugeAnimation(); closeHealthOverlay(); }
  });
  document.getElementById('decisionsModalClose').addEventListener('click', closeDecisionsOverlay);
  document.getElementById('decisionsDoneBtn').addEventListener('click', closeDecisionsOverlay);
  document.getElementById('decisionsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'decisionsOverlay') closeDecisionsOverlay();
  });
  document.getElementById('addDecisionBtn').addEventListener('click', function(){ showDecisionsFormView(null); });
  document.getElementById('decisionsSearchInput').addEventListener('input', function(e){
    ui.decisionsSearchTerm = e.target.value;
    renderDecisionsList();
  });
  document.getElementById('decisionFormCancelBtn').addEventListener('click', showDecisionsListView);
  document.getElementById('decisionFormSaveBtn').addEventListener('click', saveDecisionFromModal);
  document.getElementById('deleteDecisionBtn').addEventListener('click', deleteDecisionFromModal);

  document.getElementById('principlesBtn').addEventListener('click', openPrinciplesOverlay);
  document.getElementById('principlesModalClose').addEventListener('click', closePrinciplesOverlay);
  document.getElementById('principlesDoneBtn').addEventListener('click', closePrinciplesOverlay);
  document.getElementById('principlesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'principlesOverlay') closePrinciplesOverlay();
  });
  document.getElementById('addPrincipleBtn').addEventListener('click', function(){ showPrinciplesFormView(null); });
  document.getElementById('principlesSearchInput').addEventListener('input', function(e){
    ui.principlesSearchTerm = e.target.value;
    renderPrinciplesList();
  });
  document.getElementById('principleFormCancelBtn').addEventListener('click', showPrinciplesListView);
  document.getElementById('principleFormSaveBtn').addEventListener('click', savePrincipleFromModal);
  document.getElementById('deletePrincipleBtn').addEventListener('click', deletePrincipleFromModal);
  document.getElementById('principleDocUrlInput').addEventListener('input', function(){
    updateDocUrlOpenButtonVisibilityFor('principleDocUrlInput', 'principleDocUrlOpenBtn');
  });
  document.getElementById('principleDocUrlOpenBtn').addEventListener('click', function(){ openUrlInputInNewTab('principleDocUrlInput'); });

  document.getElementById('objectivesBtn').addEventListener('click', openObjectivesOverlay);
  document.getElementById('objectivesModalClose').addEventListener('click', closeObjectivesOverlay);
  document.getElementById('objectivesDoneBtn').addEventListener('click', closeObjectivesOverlay);
  document.getElementById('objectivesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'objectivesOverlay') closeObjectivesOverlay();
  });
  document.getElementById('addObjectiveBtn').addEventListener('click', function(){ showObjectivesFormView(null); });
  document.getElementById('objectivesSearchInput').addEventListener('input', function(e){
    ui.objectivesSearchTerm = e.target.value;
    renderObjectivesList();
  });
  document.getElementById('objectiveFormCancelBtn').addEventListener('click', showObjectivesListView);
  document.getElementById('objectiveFormSaveBtn').addEventListener('click', saveObjectiveFromModal);
  document.getElementById('deleteObjectiveBtn').addEventListener('click', deleteObjectiveFromModal);

  document.getElementById('teamsCommitteesBtn').addEventListener('click', openTeamsCommitteesOverlay);

  document.getElementById('headerMoreBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('headerMorePanel');
  });
  document.getElementById('headerMorePanel').addEventListener('click', function(e){
    var link = e.target.closest('[data-nav-target]');
    if(!link) return;
    e.preventDefault();
    closeAllExportAsPanels();
    var target = document.getElementById(link.getAttribute('data-nav-target'));
    if(target) target.click();
  });
  document.getElementById('projectsMenuBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('projectsMenuPanel');
  });
  document.getElementById('projectsMenuPanel').addEventListener('click', function(e){
    var link = e.target.closest('[data-nav-target]');
    if(!link) return;
    e.preventDefault();
    closeAllExportAsPanels();
    var target = document.getElementById(link.getAttribute('data-nav-target'));
    if(target) target.click();
  });
  document.getElementById('teamsCommitteesModalClose').addEventListener('click', closeTeamsCommitteesOverlay);
  document.getElementById('teamsCommitteesDoneBtn').addEventListener('click', closeTeamsCommitteesOverlay);
  document.getElementById('teamsCommitteesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'teamsCommitteesOverlay') closeTeamsCommitteesOverlay();
  });
  document.getElementById('addTeamCommitteeBtn').addEventListener('click', function(){ showTeamCommitteeFormView(null); });
  document.getElementById('teamsCommitteesSearchInput').addEventListener('input', function(e){
    ui.tcSearchTerm = e.target.value;
    renderTeamsCommitteesList();
  });
  document.getElementById('tcExpandAllLink').addEventListener('click', function(e){
    e.preventDefault();
    ui.tcCollapsedIds = new Set();
    renderTeamsCommitteesList();
  });
  document.getElementById('tcCollapseAllLink').addEventListener('click', function(e){
    e.preventDefault();
    var project = getCurrentProject();
    if(project) ui.tcCollapsedIds = new Set((project.teamsCommittees || []).map(function(tc){ return tc.id; }));
    renderTeamsCommitteesList();
  });
  document.getElementById('tcFormCancelBtn').addEventListener('click', showTeamsCommitteesListView);
  document.getElementById('tcFormSaveBtn').addEventListener('click', saveTeamCommitteeFromModal);
  document.getElementById('deleteTeamCommitteeBtn').addEventListener('click', deleteTeamCommitteeFromModal);

  document.getElementById('projectSearchBtn').addEventListener('click', openProjectSearchOverlay);
  document.getElementById('projectSearchClose').addEventListener('click', closeProjectSearchOverlay);
  document.getElementById('projectSearchDoneBtn').addEventListener('click', closeProjectSearchOverlay);
  document.getElementById('projectSearchOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'projectSearchOverlay') closeProjectSearchOverlay();
  });
  document.getElementById('projectSearchInput').addEventListener('input', function(e){
    handleProjectSearchInput(e.target.value);
  });
  document.getElementById('projectSearchResults').addEventListener('click', handleProjectSearchResultClick);

  document.getElementById('deleteProjectBtn').addEventListener('click', function(){
    var p = getCurrentProject();
    if(!p) return;
    confirmDialog(
      'Delete project "' + p.name + '"?',
      'This permanently deletes the project and all of its columns and tasks (' + Object.keys(p.tasks).length + ' task(s)). This cannot be undone.',
      function(){
        deleteProject(p.id);
        resetFilters();
        renderAll();
        toast('Project deleted.');
      }
    );
  });

  document.getElementById('addColumnTopBtn').addEventListener('click', function(){ openColumnModal(null); });
  document.getElementById('taskListBtn').addEventListener('click', openTaskListOverlay);
  document.getElementById('taskListClose').addEventListener('click', closeTaskListOverlay);
  document.getElementById('taskListOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'taskListOverlay') closeTaskListOverlay();
  });
  document.getElementById('taskListSearchInput').addEventListener('input', function(e){
    ui.taskListSearch = e.target.value;
    renderTaskListBody();
  });
  document.getElementById('taskListCollapseAllBtn').addEventListener('click', collapseAllTaskListGroups);
  document.getElementById('taskListExpandAllBtn').addEventListener('click', expandAllTaskListGroups);
  document.getElementById('taskListExportCsvBtn').addEventListener('click', exportTaskListAsCsv);

  document.getElementById('bulkEditBtn').addEventListener('click', openBulkEditOverlay);
  document.getElementById('bulkEditClose').addEventListener('click', closeBulkEditOverlay);
  document.getElementById('bulkEditCancelBtn').addEventListener('click', closeBulkEditOverlay);
  document.getElementById('bulkEditOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'bulkEditOverlay') closeBulkEditOverlay();
  });
  document.getElementById('bulkEditSaveBtn').addEventListener('click', saveBulkEditChanges);

  document.getElementById('archivedTasksBtn').addEventListener('click', openArchivedTasksOverlay);
  document.getElementById('archivedTasksClose').addEventListener('click', closeArchivedTasksOverlay);
  document.getElementById('archivedTasksDoneBtn').addEventListener('click', closeArchivedTasksOverlay);
  document.getElementById('archivedTasksOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'archivedTasksOverlay') closeArchivedTasksOverlay();
  });
  document.getElementById('archivedSelectAllCheckbox').addEventListener('change', function(e){
    var project = getCurrentProject();
    if(!project) return;
    if(e.target.checked){
      ui.archivedSelected = new Set(getArchivedTasks(project).map(function(t){ return t.id; }));
    } else {
      ui.archivedSelected = new Set();
    }
    renderArchivedTasksList();
  });
  document.getElementById('reactivateSelectedBtn').addEventListener('click', reactivateSelectedArchivedTasks);

  document.getElementById('depMapBtn').addEventListener('click', openDepMapOverlay);
  document.getElementById('depMapClose').addEventListener('click', closeDepMapOverlay);
  document.getElementById('depMapArchiveToggle').addEventListener('click', toggleDepMapShowArchived);
  document.getElementById('depMapZoomInBtn').addEventListener('click', function(){ setDepMapZoom(0.1); });
  document.getElementById('depMapZoomOutBtn').addEventListener('click', function(){ setDepMapZoom(-0.1); });
  document.getElementById('depMapResetBtn').addEventListener('click', resetDepMapZoom);
  document.getElementById('depMapExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('depMapExportAsPanel');
  });
  document.querySelectorAll('#depMapExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-dependency-map';
      var svgEl = document.querySelector('#depMapInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('depMapOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'depMapOverlay') closeDepMapOverlay();
  });
  document.getElementById('depMapInner').addEventListener('click', function(e){
    if(depMapState.panMoved) return;
    var node = e.target.closest('.kf-depnode');
    if(!node) return;
    var taskId = node.getAttribute('data-task-id');
    var project = getCurrentProject();
    var task = project && project.tasks[taskId];
    if(!task) return;
    closeDepMapOverlay();
    openTaskModal(taskId, task.columnId);
  });

  document.getElementById('orgChartBtn').addEventListener('click', openOrgChartOverlay);
  document.getElementById('orgChartClose').addEventListener('click', closeOrgChartOverlay);
  document.getElementById('orgChartFilterToggle').addEventListener('click', toggleOrgChartFilter);
  document.getElementById('orgChartZoomInBtn').addEventListener('click', function(){ setOrgChartZoom(0.1); });
  document.getElementById('orgChartZoomOutBtn').addEventListener('click', function(){ setOrgChartZoom(-0.1); });
  document.getElementById('orgChartResetBtn').addEventListener('click', resetOrgChartZoom);
  document.getElementById('orgChartExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('orgChartExportAsPanel');
  });
  document.querySelectorAll('#orgChartExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-org-chart';
      var svgEl = document.querySelector('#orgChartInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('orgChartOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'orgChartOverlay') closeOrgChartOverlay();
  });
  document.getElementById('orgChartInner').addEventListener('click', function(e){
    if(orgChartState.panMoved) return;
    var node = e.target.closest('.kf-orgnode');
    if(!node){ closeOrgChartMemberPopover(); return; }
    var tcId = node.getAttribute('data-tc-id');
    openOrgChartMemberPopover(tcId, node.getBoundingClientRect());
  });
  document.addEventListener('click', function(e){
    if(isOrgChartMemberPopoverOpen() && !e.target.closest('#orgChartMemberPopover') && !e.target.closest('.kf-orgnode')) closeOrgChartMemberPopover();
  });

  document.getElementById('timelineBtn').addEventListener('click', openTimelineOverlay);
  document.getElementById('timelineClose').addEventListener('click', closeTimelineOverlay);
  document.getElementById('timelineOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'timelineOverlay') closeTimelineOverlay();
  });
  document.getElementById('timelineArchiveToggle').addEventListener('click', toggleTimelineShowArchived);
  document.getElementById('timelineScaleSelect').addEventListener('change', function(e){
    ui.timelineScale = e.target.value;
    renderTimeline();
  });
  document.getElementById('timelineInner').addEventListener('click', function(e){
    var row = e.target.closest('.kf-timeline-row');
    if(!row) return;
    var taskId = row.getAttribute('data-task-id');
    var project = getCurrentProject();
    var task = project && project.tasks[taskId];
    if(!task) return;
    closeTimelineOverlay();
    openTaskModal(taskId, task.columnId);
  });

  document.getElementById('costBenefitBtn').addEventListener('click', openCostBenefitOverlay);
  document.getElementById('costBenefitClose').addEventListener('click', closeCostBenefitOverlay);
  document.getElementById('costBenefitArchiveToggle').addEventListener('click', toggleCostBenefitShowArchived);
  document.getElementById('costBenefitZoomInBtn').addEventListener('click', function(){ setCbZoom(0.1); });
  document.getElementById('costBenefitZoomOutBtn').addEventListener('click', function(){ setCbZoom(-0.1); });
  document.getElementById('costBenefitResetBtn').addEventListener('click', resetCbZoom);
  document.getElementById('costBenefitExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('costBenefitExportAsPanel');
  });
  document.querySelectorAll('#costBenefitExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-cost-benefit-chart';
      var svgEl = document.querySelector('#costBenefitInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('healthRiskMatrixExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('healthRiskMatrixExportAsPanel');
  });
  document.querySelectorAll('#healthRiskMatrixExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-project-risks-matrix';
      var svgEl = document.querySelector('#healthRiskMatrixChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('risksMatrixExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('risksMatrixExportAsPanel');
  });
  document.querySelectorAll('#risksMatrixExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-risk-matrix';
      var svgEl = document.querySelector('#risksMatrixChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('costBenefitOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'costBenefitOverlay') closeCostBenefitOverlay();
  });
  document.getElementById('costBenefitInner').addEventListener('click', function(e){
    if(cbZoomState.panMoved) return;
    var point = e.target.closest('.kf-cb-point');
    if(!point) return;
    var taskId = point.getAttribute('data-task-id');
    var project = getCurrentProject();
    var task = project && project.tasks[taskId];
    if(!task) return;
    closeCostBenefitOverlay();
    openTaskModal(taskId, task.columnId);
  });

  var costBenefitScrollEl = document.getElementById('costBenefitScroll');
  costBenefitScrollEl.addEventListener('wheel', function(e){
    e.preventDefault();
    zoomCbAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  costBenefitScrollEl.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    cbZoomState.panActive = true;
    cbZoomState.panMoved = false;
    cbZoomState.panStartX = e.clientX;
    cbZoomState.panStartY = e.clientY;
    cbZoomState.panStartScrollLeft = costBenefitScrollEl.scrollLeft;
    cbZoomState.panStartScrollTop = costBenefitScrollEl.scrollTop;
    costBenefitScrollEl.classList.add('kf-costbenefit-panning');
  });
  document.addEventListener('mousemove', function(e){
    if(!cbZoomState.panActive) return;
    var cbDx = e.clientX - cbZoomState.panStartX;
    var cbDy = e.clientY - cbZoomState.panStartY;
    if(Math.abs(cbDx) > 3 || Math.abs(cbDy) > 3) cbZoomState.panMoved = true;
    if(cbZoomState.panMoved){
      costBenefitScrollEl.scrollLeft = cbZoomState.panStartScrollLeft - cbDx;
      costBenefitScrollEl.scrollTop = cbZoomState.panStartScrollTop - cbDy;
    }
  });
  document.addEventListener('mouseup', function(){
    if(cbZoomState.panActive){
      cbZoomState.panActive = false;
      costBenefitScrollEl.classList.remove('kf-costbenefit-panning');
    }
  });

  var depMapScrollEl = document.getElementById('depMapScroll');
  depMapScrollEl.addEventListener('wheel', function(e){
    if(!lastDepLayout) return;
    e.preventDefault();
    zoomDepMapAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  depMapScrollEl.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    depMapState.panActive = true;
    depMapState.panMoved = false;
    depMapState.panStartX = e.clientX;
    depMapState.panStartY = e.clientY;
    depMapState.panStartScrollLeft = depMapScrollEl.scrollLeft;
    depMapState.panStartScrollTop = depMapScrollEl.scrollTop;
    depMapScrollEl.classList.add('kf-depmap-panning');
  });
  document.addEventListener('mousemove', function(e){
    if(!depMapState.panActive) return;
    var dx = e.clientX - depMapState.panStartX;
    var dy = e.clientY - depMapState.panStartY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) depMapState.panMoved = true;
    if(depMapState.panMoved){
      depMapScrollEl.scrollLeft = depMapState.panStartScrollLeft - dx;
      depMapScrollEl.scrollTop = depMapState.panStartScrollTop - dy;
    }
  });
  document.addEventListener('mouseup', function(){
    if(depMapState.panActive){
      depMapState.panActive = false;
      depMapScrollEl.classList.remove('kf-depmap-panning');
    }
  });

  var orgChartScrollEl = document.getElementById('orgChartScroll');
  orgChartScrollEl.addEventListener('wheel', function(e){
    if(!lastOrgChartLayout) return;
    e.preventDefault();
    zoomOrgChartAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  orgChartScrollEl.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    orgChartState.panActive = true;
    orgChartState.panMoved = false;
    orgChartState.panStartX = e.clientX;
    orgChartState.panStartY = e.clientY;
    orgChartState.panStartScrollLeft = orgChartScrollEl.scrollLeft;
    orgChartState.panStartScrollTop = orgChartScrollEl.scrollTop;
    orgChartScrollEl.classList.add('kf-depmap-panning');
  });
  document.addEventListener('mousemove', function(e){
    if(!orgChartState.panActive) return;
    var dx = e.clientX - orgChartState.panStartX;
    var dy = e.clientY - orgChartState.panStartY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) orgChartState.panMoved = true;
    if(orgChartState.panMoved){
      orgChartScrollEl.scrollLeft = orgChartState.panStartScrollLeft - dx;
      orgChartScrollEl.scrollTop = orgChartState.panStartScrollTop - dy;
    }
  });
  document.addEventListener('mouseup', function(){
    if(orgChartState.panActive){
      orgChartState.panActive = false;
      orgChartScrollEl.classList.remove('kf-depmap-panning');
    }
  });

  document.getElementById('exportBtn').addEventListener('click', function(){
    var p = getCurrentProject();
    if(!p){ toast('No project to export.'); return; }
    if(Object.keys(p.tasks).length === 0){ toast('This project has no tasks to export.'); return; }
    exportProjectJSON(p);
  });

  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('appSettingsBtn').addEventListener('click', openAppSettingsOverlay);
  document.getElementById('appSettingsClose').addEventListener('click', closeAppSettingsOverlay);
  document.getElementById('appSettingsDoneBtn').addEventListener('click', closeAppSettingsOverlay);
  document.getElementById('appSettingsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'appSettingsOverlay') closeAppSettingsOverlay();
  });
  document.getElementById('settingsShowDocumentsBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('documents', e.target.checked);
  });
  document.getElementById('settingsShowRisksBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('risks', e.target.checked);
  });
  document.getElementById('settingsShowDecisionsBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('decisions', e.target.checked);
  });
  document.getElementById('settingsShowHealthBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('health', e.target.checked);
  });
  document.getElementById('settingsShowPrinciplesBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('principles', e.target.checked);
  });
  document.getElementById('settingsShowObjectivesBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('objectives', e.target.checked);
  });
  document.getElementById('settingsShowTeamsCommitteesBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('teamsCommittees', e.target.checked);
  });

  document.getElementById('mobileMenuBtn').addEventListener('click', toggleMobileDrawer);
  document.getElementById('drawerCloseBtn').addEventListener('click', closeMobileDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeMobileDrawer);
  document.getElementById('headerControls').addEventListener('click', function(e){
    if(e.target.closest('button')) closeMobileDrawer();
  });
  document.getElementById('projectSelect').addEventListener('change', closeMobileDrawer);
  relocateViewButtonsForViewport();
  window.addEventListener('resize', function(){
    relocateViewButtonsForViewport();
    if(window.innerWidth > 1024) closeMobileDrawer();
  });

  document.getElementById('searchInput').addEventListener('input', function(e){
    ui.searchTerm = e.target.value.trim();
    renderBoard();
  });

  document.getElementById('teamFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleTeamFilterPanel();
  });
  document.getElementById('assigneeFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleAssigneeFilterPanel();
  });
  document.getElementById('taskTypeFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleTaskTypeFilterPanel();
  });
  document.addEventListener('click', function(e){
    var teamWrap = document.getElementById('teamFilterWrap');
    if(teamWrap && !teamWrap.contains(e.target)) closeTeamFilterPanel();
    var wrap = document.getElementById('assigneeFilterWrap');
    if(wrap && !wrap.contains(e.target)) closeAssigneeFilterPanel();
    var typeWrap = document.getElementById('taskTypeFilterWrap');
    if(typeWrap && !typeWrap.contains(e.target)) closeTaskTypeFilterPanel();
  });

  document.getElementById('taskModalClose').addEventListener('click', closeTaskModal);
  document.getElementById('taskCancelBtn').addEventListener('click', closeTaskModal);
  document.getElementById('taskSaveBtn').addEventListener('click', saveTaskFromModal);
  document.getElementById('taskDeleteBtn').addEventListener('click', deleteTaskFromModal);
  document.getElementById('taskPrioritySelect').addEventListener('change', updatePriorityIcon);
  document.getElementById('taskDocUrlInput').addEventListener('input', updateDocUrlOpenButtonVisibility);
  document.getElementById('taskDocUrlOpenBtn').addEventListener('click', openDocUrlInNewTab);
  document.getElementById('depSearchInput').addEventListener('input', function(e){
    ui.depSearchTerm = e.target.value.trim();
    renderDependencyPicker();
  });
  document.getElementById('taskOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'taskOverlay') closeTaskModal();
  });

  document.getElementById('columnModalClose').addEventListener('click', closeColumnModal);
  document.getElementById('columnCancelBtn').addEventListener('click', closeColumnModal);
  document.getElementById('columnSaveBtn').addEventListener('click', saveColumnFromModal);
  document.getElementById('columnDeleteBtn').addEventListener('click', deleteColumnFromModal);
  document.getElementById('columnOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'columnOverlay') closeColumnModal();
  });

  document.getElementById('projectModalClose').addEventListener('click', closeProjectModal);
  document.getElementById('projectCancelBtn').addEventListener('click', closeProjectModal);
  document.getElementById('projectSaveBtn').addEventListener('click', saveProjectFromModal);
  document.getElementById('projectOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'projectOverlay') closeProjectModal();
  });

  document.getElementById('confirmModalClose').addEventListener('click', closeConfirmDialog);
  document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirmDialog);
  document.getElementById('confirmOkBtn').addEventListener('click', function(){
    var action = getPendingConfirmAction();
    closeConfirmDialog();
    if(action) action();
  });
  document.getElementById('confirmOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'confirmOverlay') closeConfirmDialog();
  });

  document.getElementById('overdueAlertClose').addEventListener('click', closeOverdueAlert);
  document.getElementById('overdueAlertOkBtn').addEventListener('click', closeOverdueAlert);
  document.getElementById('overdueAlertOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'overdueAlertOverlay') closeOverdueAlert();
  });

  document.getElementById('defaultScoreAlertClose').addEventListener('click', closeDefaultScoreAlert);
  document.getElementById('defaultScoreAlertOkBtn').addEventListener('click', closeDefaultScoreAlert);
  document.getElementById('defaultScoreAlertOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'defaultScoreAlertOverlay') closeDefaultScoreAlert();
  });

  document.getElementById('backupReminderClose').addEventListener('click', dismissBackupReminder);
  document.getElementById('backupNowBtn').addEventListener('click', runBackupForReminder);
  document.getElementById('backupLaterBtn').addEventListener('click', dismissBackupReminder);
  document.getElementById('backupReminderOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'backupReminderOverlay') dismissBackupReminder();
  });

  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    if(!document.getElementById('taskOverlay').classList.contains('hidden')) closeTaskModal();
    else if(!document.getElementById('columnOverlay').classList.contains('hidden')) closeColumnModal();
    else if(!document.getElementById('projectOverlay').classList.contains('hidden')) closeProjectModal();
    else if(!document.getElementById('teamOverlay').classList.contains('hidden')) closeTeamModal();
    else if(document.querySelector('.kf-tasktype-icon-panel:not(.hidden)')) closeAllTaskTypeIconPanels();
    else if(document.querySelector('.kf-export-as-panel:not(.hidden)')) closeAllExportAsPanels();
    else if(!document.getElementById('taskTypesOverlay').classList.contains('hidden')) closeTaskTypesModal();
    else if(isReleasesOverlayOpen()) closeReleasesOverlay();
    else if(isDocumentsOverlayOpen()) closeDocumentsOverlay();
    else if(isRisksOverlayOpen()) closeRisksOverlay();
    else if(isDecisionsOverlayOpen()) closeDecisionsOverlay();
    else if(isPrinciplesOverlayOpen()) closePrinciplesOverlay();
    else if(isObjectivesOverlayOpen()) closeObjectivesOverlay();
    else if(isProjectSearchOverlayOpen()) closeProjectSearchOverlay();
    else if(isTeamsCommitteesOverlayOpen()) closeTeamsCommitteesOverlay();
    else if(isHealthOverlayOpen()){ cancelHealthGaugeAnimation(); closeHealthOverlay(); }
    else if(isAppSettingsOverlayOpen()) closeAppSettingsOverlay();
    else if(!document.getElementById('confirmOverlay').classList.contains('hidden')) closeConfirmDialog();
    else if(!document.getElementById('importConflictOverlay').classList.contains('hidden')) closeImportConflictModal();
    else if(!document.getElementById('overdueAlertOverlay').classList.contains('hidden')) closeOverdueAlert();
    else if(!document.getElementById('defaultScoreAlertOverlay').classList.contains('hidden')) closeDefaultScoreAlert();
    else if(!document.getElementById('backupReminderOverlay').classList.contains('hidden')) dismissBackupReminder();
    else if(isDepMapOpen()) closeDepMapOverlay();
    else if(isOrgChartMemberPopoverOpen()) closeOrgChartMemberPopover();
    else if(isOrgChartOpen()) closeOrgChartOverlay();
    else if(isTimelineOverlayOpen()) closeTimelineOverlay();
    else if(isCostBenefitOverlayOpen()) closeCostBenefitOverlay();
    else if(isTaskListOpen()) closeTaskListOverlay();
    else if(isBulkEditOverlayOpen()) closeBulkEditOverlay();
    else if(isArchivedTasksOverlayOpen()) closeArchivedTasksOverlay();
    else if(!document.getElementById('teamFilterPanel').classList.contains('hidden')) closeTeamFilterPanel();
    else if(!document.getElementById('assigneeFilterPanel').classList.contains('hidden')) closeAssigneeFilterPanel();
    else if(!document.getElementById('taskTypeFilterPanel').classList.contains('hidden')) closeTaskTypeFilterPanel();
    else if(isMobileDrawerOpen()) closeMobileDrawer();
  });
}

/* =========================================================
   INIT
   ========================================================= */
function init(){
  loadDB();
  wireEvents();
  renderAll();
  checkOverdueAlert();
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
