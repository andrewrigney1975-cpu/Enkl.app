"use strict";

/* ---- Core ---- */
import { state, loadDB, saveDB, getOpeningExperience } from './storage.js';
import { getCurrentProject } from './store.js';
import { ui, toast, resetFilters, renderThemeToggleIcon, toggleTheme, setThemeDeps, relocateViewButtonsForViewport, toggleSideNav, toggleMobileDrawer, closeMobileDrawer, isMobileDrawerOpen } from './ui.js';
import { hydrateIcons } from './icons.js';
import { setOnAuthExpired, setOnMustChangePassword, clearToken, ssoLookupApi } from './api.js';
import { reportPageLoadTiming } from './features/page-load-telemetry.js';

/* ---- Mutations ---- */
import { deleteProject, closeAllTaskTypeIconPanels, setMutationsToast } from './mutations.js';

/* ---- Views ---- */
import { renderAll, renderBoard, renderToolbar, setBoardDeps, closeTeamFilterPanel, closeAssigneeFilterPanel, closeTaskTypeFilterPanel, closeStatusFilterPanel, toggleTeamFilterPanel, toggleAssigneeFilterPanel, toggleTaskTypeFilterPanel, toggleStatusFilterPanel, openAppSettingsOverlay, closeAppSettingsOverlay, isAppSettingsOverlayOpen, updateHeaderButtonVisibilitySetting, renderPriorityFilterChips, refitBoardForOpenTaskModal } from './views/board.js';
import { setTaskListDeps, openTaskListOverlay, closeTaskListOverlay, isTaskListOpen, renderTaskListBody, collapseAllTaskListGroups, expandAllTaskListGroups, exportTaskListAsCsv } from './views/task-list.js';
import { setDepMapDeps, depMapState, lastDepLayout, openDepMapOverlay, closeDepMapOverlay, isDepMapOpen, renderDependencyMap, toggleDepMapShowArchived, toggleDepMapColumnFilterPanel, closeDepMapColumnFilterPanel, setDepMapZoom, resetDepMapZoom, zoomDepMapAtPoint } from './views/dependency-map.js';
import { setOrgChartDeps, orgChartState, lastOrgChartLayout, openOrgChartOverlay, closeOrgChartOverlay, isOrgChartOpen, toggleOrgChartFilter, setOrgChartZoom, resetOrgChartZoom, zoomOrgChartAtPoint, openOrgChartMemberPopover, closeOrgChartMemberPopover, isOrgChartMemberPopoverOpen } from './views/org-chart.js';
import { setGovMapDeps, govMapState, lastGovMapLayout, openGovMapOverlay, closeGovMapOverlay, isGovMapOpen, toggleGovMapShowRelationships, setGovMapZoom, resetGovMapZoom, zoomGovMapAtPoint } from './views/governance-map.js';
import { setWorkflowEditorDeps, workflowEditorState, lastWorkflowLayout, openWorkflowOverlay, closeWorkflowOverlay, isWorkflowOverlayOpen, setWorkflowMode, setWorkflowZoom, resetWorkflowZoom, zoomWorkflowAtPoint, handleWorkflowScrollMouseDown, handleWorkflowPointerMove, handleWorkflowPointerUp, handleWorkflowInnerClick, handleWorkflowReflow, updateWorkflowEdgePopoverMessageVisibility, refreshWorkflowEdgeConditionControls, handleWorkflowEdgeConditionFieldChange, saveWorkflowEdgePopover, deleteWorkflowEdgeFromPopover, closeWorkflowEdgePopover, isWorkflowEdgePopoverOpen, saveWorkflowToServer, saveWorkflowColumnCapPopover, closeWorkflowColumnCapPopover, isWorkflowColumnCapPopoverOpen } from './views/workflow-editor.js';
import { setTimelineDeps, openTimelineOverlay, closeTimelineOverlay, isTimelineOverlayOpen, toggleTimelineShowArchived, renderTimeline } from './views/timeline.js';
import { setCostBenefitDeps, cbZoomState, openCostBenefitOverlay, closeCostBenefitOverlay, isCostBenefitOverlayOpen, toggleCostBenefitShowArchived, toggleCbColumnFilterPanel, closeCbColumnFilterPanel, setCbZoom, resetCbZoom, zoomCbAtPoint } from './views/cost-benefit.js';

/* ---- Features ---- */
import { parseTaskKeyFromHash, findTaskByKey, clearTaskHash } from './features/hash-router.js';
import { exportProjectJSON, setExportToast } from './features/export.js';
import { migrateProjectToServer, loginToServer, completeSsoLogin, changePasswordOnServer, isServerLoggedIn, isServerAuthoritative, pullServerProjectsIntoLocal, deleteProjectOnServer, setMigrationToast } from './features/migration.js';
import { connectEventStream, disconnectEventStream } from './features/live-updates.js';
import { importProjectFromFile, pendingImport, closeImportConflictModal, overwriteProjectFromResult, finaliseImport, uniqueProjectKey, setImportSessionAlertsCheck, setImportToast, setImportRenderAll, setImportResetFilters } from './features/import.js';
import { checkProjectAlerts, closeOverdueAlert, closeOverrunAlert, closeDefaultScoreAlert, closeBackupReminderModal, dismissBackupReminder, runBackupForReminder } from './features/session-alerts.js';
import { setBulkEditDeps, openBulkEditOverlay, closeBulkEditOverlay, isBulkEditOverlayOpen, saveBulkEditChanges } from './features/bulk-edit.js';
import { getArchivedTasks, openArchivedTasksOverlay, closeArchivedTasksOverlay, isArchivedTasksOverlayOpen, renderArchivedTasksList, reactivateSelectedArchivedTasks } from './features/archived-tasks.js';
import { closeAllExportAsPanels, toggleExportAsPanel, exportSvgElementAsSvgFile, exportSvgElementAsPng } from './features/svg-export.js';

/* ---- Modals ---- */
import { confirmDialog, closeConfirmDialog, getPendingConfirmAction, getPendingCancelAction } from './modals/confirm.js';
import { openTaskModal, closeTaskModal, saveTaskFromModal, deleteTaskFromModal, updatePriorityIcon, updateDocUrlOpenButtonVisibility, openDocUrlInNewTab, renderDependencyPicker, toggleAuditTrail, onParentTaskSelectChange, renderSubtaskPicker } from './modals/task.js';
import { closeSetPrivateKeyModal, confirmSetPrivateKeyFromModal } from './modals/private-key-set.js';
import { closeUnlockPrivateTaskModal, confirmUnlockFromModal, continueWithoutKeyFromModal } from './modals/private-key-unlock.js';
import { openColumnModal, closeColumnModal, saveColumnFromModal, deleteColumnFromModal } from './modals/column.js';
import { openProjectModal, closeProjectModal, saveProjectFromModal } from './modals/project.js';
import { openTeamModal, closeTeamModal, addMemberFromModal } from './modals/team.js';
import { openOrgUsersModal, closeOrgUsersModal, createOrgUserFromModal } from './modals/organisation.js';
import { openSsoConfigModal, closeSsoConfigModal, saveSsoConfigFromModal, generateScimTokenFromModal, generateApiKeyFromModal, revokeApiKeyFromModal } from './modals/sso.js';
import { openSaveAsTemplateModal, closeSaveAsTemplateModal, saveAsTemplateFromModal, openTemplatesModal, closeTemplatesModal } from './modals/templates.js';
import { openTodoOverlay, closeTodoOverlay, isTodoOverlayOpen, addTodoListFromModal } from './modals/todo.js';
import { openTaskTypesModal, closeTaskTypesModal, addTaskTypeFromModal } from './modals/task-types.js';
import { openReleasesOverlay, closeReleasesOverlay, isReleasesOverlayOpen, showReleasesFormView, showReleasesListView, saveReleaseFromModal, deleteReleaseFromModal } from './modals/releases.js';
import { openRetrospectivesOverlay, closeRetrospectivesOverlay, isRetrospectivesOverlayOpen, showRetrospectivesFormView, showRetrospectivesListView, saveRetrospectiveFromModal, deleteRetrospectiveFromModal, toggleRetroHowItWorks, cancelRetroPromoteFromModal, saveRetroPromoteFromModal, addRetroActionItemFromInputs } from './modals/retrospectives.js';
import { openDocumentsOverlay, closeDocumentsOverlay, isDocumentsOverlayOpen, showDocumentsFormView, showDocumentsListView, renderDocumentsList, saveDocumentFromModal, deleteDocumentFromModal, updateDocUrlOpenButtonVisibilityFor, openUrlInputInNewTab } from './modals/documents.js';
import { scheduleDocumentSuggestions } from './features/document-suggestions.js';
import { openRisksOverlay, closeRisksOverlay, isRisksOverlayOpen, showRisksFormView, showRisksListView, renderRisksList, saveRiskFromModal, deleteRiskFromModal, updateRiskScorePreview } from './modals/risks.js';
import { openHealthOverlay, closeHealthOverlay, isHealthOverlayOpen, cancelHealthGaugeAnimation } from './modals/health.js';
import { openPortfolioDashboardOverlay, closePortfolioDashboardOverlay, isPortfolioDashboardOverlayOpen, onPortfolioProjectSelectionChanged, onPortfolioTimelineControlsChanged, onPortfolioActivityControlsChanged, toggleProjectFilterPanel, closeProjectFilterPanel, isProjectFilterPanelOpen, onPortfolioProjectSearchInput, onPortfolioTimelineBarPointerDown, closePortfolioProjectDatesModal, isPortfolioProjectDatesModalOpen, clearPortfolioProjectDatesInModal, savePortfolioProjectDatesFromModal } from './modals/portfolio-dashboard.js';
import { openPortfolioPlannerOverlay, closePortfolioPlannerOverlay, isPortfolioPlannerOverlayOpen, onPortfolioPlannerNewCategoryFromInput, onPortfolioPlannerGroupsClick, onPortfolioPlannerGroupsChange, onPortfolioPlannerControlsChanged, onPortfolioPlannerFitToProjectsClick, onPortfolioPlannerBarPointerDown, onPortfolioPlannerBarDblClick, closePortfolioPlannerAddProjectModal, isPortfolioPlannerAddProjectModalOpen, savePortfolioPlannerAddProjectFromModal, closePortfolioPlannerProjectDatesModal, isPortfolioPlannerProjectDatesModalOpen, clearPortfolioPlannerProjectDatesInModal, savePortfolioPlannerProjectDatesFromModal, expandAllPortfolioPlannerCategories, collapseAllPortfolioPlannerCategories, closePortfolioPlannerResourcesModal, isPortfolioPlannerResourcesModalOpen, addPortfolioPlannerResourceFromModal, onPortfolioPlannerResourcesListClick, onPortfolioPlannerResourcesListChange, togglePortfolioPlannerCategoryFilterPanel, closePortfolioPlannerCategoryFilterPanel } from './modals/portfolio-planner.js';
import { openDecisionsOverlay, closeDecisionsOverlay, isDecisionsOverlayOpen, showDecisionsFormView, showDecisionsListView, renderDecisionsList, saveDecisionFromModal, deleteDecisionFromModal } from './modals/decisions.js';
import { openPrinciplesOverlay, closePrinciplesOverlay, isPrinciplesOverlayOpen, showPrinciplesFormView, showPrinciplesListView, renderPrinciplesList, savePrincipleFromModal, deletePrincipleFromModal, switchPrinciplesTab, updatePrincipleShareFromModal } from './modals/principles.js';
import { openObjectivesOverlay, closeObjectivesOverlay, isObjectivesOverlayOpen, showObjectivesFormView, showObjectivesListView, renderObjectivesList, saveObjectiveFromModal, deleteObjectiveFromModal } from './modals/objectives.js';
import { openTeamsCommitteesOverlay, closeTeamsCommitteesOverlay, isTeamsCommitteesOverlayOpen, showTeamCommitteeFormView, showTeamsCommitteesListView, renderTeamsCommitteesList, saveTeamCommitteeFromModal, deleteTeamCommitteeFromModal } from './modals/teams-committees.js';
import { openReportOverlay, closeReportOverlay, isReportOverlayOpen, printReport, openProjectManagementReportOverlay } from './features/reports.js';
import { openProjectSearchOverlay, closeProjectSearchOverlay, isProjectSearchOverlayOpen, handleProjectSearchInput, handleProjectSearchResultClick, showProjectSearchSimpleView, showProjectSearchQueryView, toggleProjectQuerySchemaPanel, toggleProjectQuerySavedPanel, handleProjectQuerySavedListClick, handleProjectQuerySaveOrUpdateClick, handleProjectQueryNewClick, hideProjectQuerySaveRow, confirmSaveProjectQuery, showProjectQueryResultsTableView, showProjectQueryResultsJsonView, runProjectQuery, formatProjectQuerySql, exportProjectQueryResultsAsCsv, copyProjectQueryResultsAsJson, copyProjectQueryApiUrl, testProjectQueryApi, exportProjectQueryResultsAsJson, printProjectQueryResults, erdZoomState, setProjectQueryErdZoom, resetProjectQueryErdZoom, zoomProjectQueryErdAtPoint, updateProjectQueryIntellisense, repositionProjectQueryIntellisense, hideProjectQueryIntellisense, isProjectQueryIntellisenseOpen, moveProjectQueryIntellisenseActive, acceptProjectQueryIntellisenseSuggestion, handleProjectQueryIntellisenseClick } from './modals/project-search.js';
import { openAboutModal, closeAboutModal, isAboutModalOpen } from './modals/about.js';
import { openProjectStorageModal, closeProjectStorageModal, isProjectStorageModalOpen } from './modals/project-storage.js';
import { openApiEndpointsModal, closeApiEndpointsModal, handleApiEndpointsListClick } from './modals/api-endpoints.js';
import { openUfoModal, closeUfoModal, isUfoModalOpen } from './modals/ufo.js';
import { openOpeningExperienceModal, closeOpeningExperienceModal, isOpeningExperienceModalOpen, chooseOpeningExperience, recordDeviceTypeAndMaybeShowPicker } from './modals/opening-experience.js';
import { randomise } from './features/randomise.js';

/* ---- Dependency injection (break circular import chains) ---- */
setBoardDeps({ toast, confirmDialog, openTaskModal, openColumnModal });
setTaskListDeps({ toast, openTaskModal });
setDepMapDeps({ toast, openTaskModal });
setOrgChartDeps({ toast });
setGovMapDeps({ toast });
setWorkflowEditorDeps({ toast, confirmDialog });
setTimelineDeps({ toast, openTaskModal });
setCostBenefitDeps({ toast, openTaskModal });
setBulkEditDeps({ confirmDialog, exportProjectJSON });
// Wires toggleTheme's post-flip re-render (ui.js) — without this, switching theme only updates the
// data-theme attribute/toggle icon; every already-rendered view (board columns, dependency map,
// priority filter chips, the task modal's priority icon) keeps showing colors computed for the OLD
// theme until something else happens to trigger its own re-render (e.g. a hard refresh).
setThemeDeps({ renderBoard, renderDependencyMap, isDepMapOpen, updatePriorityIcon, renderPriorityFilterChips });
setMutationsToast(toast);
setMigrationToast(toast);
setExportToast(toast);
setImportToast(toast);
setImportRenderAll(renderAll);
setImportResetFilters(resetFilters);
setImportSessionAlertsCheck(checkProjectAlerts);

/* ---- Console-exposed debug helpers ---- */
window.go_ufo = openUfoModal;
window.randomise = randomise;

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
  document.getElementById('navGovernanceMapBtn').addEventListener('click', openGovMapOverlay);
  document.getElementById('navBulkEditBtn').addEventListener('click', openBulkEditOverlay);
  document.getElementById('navTodoBtn').addEventListener('click', openTodoOverlay);
  document.getElementById('navArchivedBtn').addEventListener('click', openArchivedTasksOverlay);
  document.getElementById('navTaskTypesBtn').addEventListener('click', openTaskTypesModal);
  document.getElementById('navReleasesBtn').addEventListener('click', openReleasesOverlay);
  document.getElementById('navProjectStorageBtn').addEventListener('click', openProjectStorageModal);
  document.getElementById('navRetrospectiveBtn').addEventListener('click', openRetrospectivesOverlay);

  document.getElementById('projectSelect').addEventListener('change', function(e){
    state.db.currentProjectId = e.target.value;
    saveDB();
    resetFilters();
    renderAll();
    checkProjectAlerts();
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
  document.getElementById('projectStorageBtn').addEventListener('click', openProjectStorageModal);
  document.getElementById('projectStorageModalClose').addEventListener('click', closeProjectStorageModal);
  document.getElementById('projectStorageDoneBtn').addEventListener('click', closeProjectStorageModal);
  document.getElementById('projectStorageOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'projectStorageOverlay') closeProjectStorageModal();
  });
  document.getElementById('apiEndpointsBtn').addEventListener('click', openApiEndpointsModal);
  document.getElementById('navApiEndpointsBtn').addEventListener('click', openApiEndpointsModal);
  document.getElementById('apiEndpointsModalClose').addEventListener('click', closeApiEndpointsModal);
  document.getElementById('apiEndpointsDoneBtn').addEventListener('click', closeApiEndpointsModal);
  document.getElementById('apiEndpointsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'apiEndpointsOverlay') closeApiEndpointsModal();
  });
  document.getElementById('apiEndpointsList').addEventListener('click', handleApiEndpointsListClick);
  document.getElementById('addReleaseBtn').addEventListener('click', function(){ showReleasesFormView(null); });
  document.getElementById('releaseFormCancelBtn').addEventListener('click', showReleasesListView);
  document.getElementById('releaseFormSaveBtn').addEventListener('click', saveReleaseFromModal);
  document.getElementById('deleteReleaseBtn').addEventListener('click', deleteReleaseFromModal);

  document.getElementById('retrospectivesModalClose').addEventListener('click', closeRetrospectivesOverlay);
  document.getElementById('retrospectivesDoneBtn').addEventListener('click', closeRetrospectivesOverlay);
  document.getElementById('retrospectivesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'retrospectivesOverlay') closeRetrospectivesOverlay();
  });
  document.getElementById('addRetrospectiveBtn').addEventListener('click', function(){ showRetrospectivesFormView(null); });
  document.getElementById('retrospectiveFormCancelBtn').addEventListener('click', showRetrospectivesListView);
  document.getElementById('retrospectiveFormSaveBtn').addEventListener('click', saveRetrospectiveFromModal);
  document.getElementById('deleteRetrospectiveBtn').addEventListener('click', deleteRetrospectiveFromModal);
  document.getElementById('retroHowItWorksToggleBtn').addEventListener('click', toggleRetroHowItWorks);
  document.getElementById('retroAddActionItemBtn').addEventListener('click', addRetroActionItemFromInputs);
  document.getElementById('retroNewActionItemText').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); addRetroActionItemFromInputs(); }
  });
  document.getElementById('retroPromoteCancelBtn').addEventListener('click', cancelRetroPromoteFromModal);
  document.getElementById('retroPromoteSaveBtn').addEventListener('click', saveRetroPromoteFromModal);

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
  document.getElementById('documentDescEditor').addEventListener('input', function(){
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
  document.getElementById('risksReportBtn').addEventListener('click', function(){ openReportOverlay('risks'); });
  document.getElementById('risksDoneBtn').addEventListener('click', closeRisksOverlay);
  document.getElementById('risksOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'risksOverlay') closeRisksOverlay();
  });
  document.getElementById('addRiskBtn').addEventListener('click', function(){ showRisksFormView(null); });
  document.getElementById('risksSearchInput').addEventListener('input', function(e){
    ui.risksSearchTerm = e.target.value;
    renderRisksList();
  });
  document.getElementById('risksSeverityFilter').addEventListener('change', function(e){
    ui.risksSeverityFilter = e.target.value;
    renderRisksList();
  });
  document.getElementById('risksStatusFilter').addEventListener('change', function(e){
    ui.risksStatusFilter = e.target.value;
    renderRisksList();
  });
  document.getElementById('riskFormCancelBtn').addEventListener('click', showRisksListView);
  document.getElementById('riskFormSaveBtn').addEventListener('click', saveRiskFromModal);
  document.getElementById('deleteRiskBtn').addEventListener('click', deleteRiskFromModal);
  document.getElementById('riskLikelihoodSelect').addEventListener('change', updateRiskScorePreview);
  document.getElementById('riskImpactSelect').addEventListener('change', updateRiskScorePreview);

  document.getElementById('decisionsBtn').addEventListener('click', openDecisionsOverlay);
  document.getElementById('portfolioDashboardBtn').addEventListener('click', openPortfolioDashboardOverlay);
  document.getElementById('portfolioDashboardClose').addEventListener('click', closePortfolioDashboardOverlay);
  document.getElementById('portfolioDashboardOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioDashboardOverlay') closePortfolioDashboardOverlay();
  });
  document.getElementById('portfolioProjectPicker').addEventListener('change', onPortfolioProjectSelectionChanged);
  document.getElementById('portfolioProjectFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleProjectFilterPanel();
  });
  document.getElementById('portfolioProjectSearchInput').addEventListener('input', onPortfolioProjectSearchInput);
  document.getElementById('portfolioTimelineScaleSelect').addEventListener('change', onPortfolioTimelineControlsChanged);
  document.getElementById('portfolioTimelineStartInput').addEventListener('change', onPortfolioTimelineControlsChanged);
  document.getElementById('portfolioTimelineEndInput').addEventListener('change', onPortfolioTimelineControlsChanged);
  document.getElementById('portfolioTimelineChart').addEventListener('mousedown', onPortfolioTimelineBarPointerDown);
  document.getElementById('portfolioProjectDatesClose').addEventListener('click', closePortfolioProjectDatesModal);
  document.getElementById('portfolioProjectDatesCancelBtn').addEventListener('click', closePortfolioProjectDatesModal);
  document.getElementById('portfolioProjectDatesClearBtn').addEventListener('click', clearPortfolioProjectDatesInModal);
  document.getElementById('portfolioProjectDatesSaveBtn').addEventListener('click', savePortfolioProjectDatesFromModal);
  document.getElementById('portfolioProjectDatesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioProjectDatesOverlay') closePortfolioProjectDatesModal();
  });
  document.getElementById('portfolioActivityScaleSelect').addEventListener('change', onPortfolioActivityControlsChanged);
  document.getElementById('portfolioActivityStartInput').addEventListener('change', onPortfolioActivityControlsChanged);
  document.getElementById('portfolioActivityEndInput').addEventListener('change', onPortfolioActivityControlsChanged);

  document.getElementById('navPortfolioPlannerBtn').addEventListener('click', openPortfolioPlannerOverlay);
  document.getElementById('portfolioPlannerClose').addEventListener('click', closePortfolioPlannerOverlay);
  document.getElementById('portfolioPlannerOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioPlannerOverlay') closePortfolioPlannerOverlay();
  });
  document.getElementById('portfolioPlannerNewCategoryBtn').addEventListener('click', onPortfolioPlannerNewCategoryFromInput);
  document.getElementById('portfolioPlannerExpandAllLink').addEventListener('click', function(e){
    e.preventDefault();
    expandAllPortfolioPlannerCategories();
  });
  document.getElementById('portfolioPlannerCollapseAllLink').addEventListener('click', function(e){
    e.preventDefault();
    collapseAllPortfolioPlannerCategories();
  });
  document.getElementById('portfolioPlannerGroups').addEventListener('click', onPortfolioPlannerGroupsClick);
  document.getElementById('portfolioPlannerGroups').addEventListener('change', onPortfolioPlannerGroupsChange);
  document.getElementById('portfolioPlannerScaleSelect').addEventListener('change', onPortfolioPlannerControlsChanged);
  document.getElementById('portfolioPlannerStartInput').addEventListener('change', onPortfolioPlannerControlsChanged);
  document.getElementById('portfolioPlannerEndInput').addEventListener('change', onPortfolioPlannerControlsChanged);
  document.getElementById('portfolioPlannerFitToProjectsBtn').addEventListener('click', onPortfolioPlannerFitToProjectsClick);
  document.getElementById('portfolioPlannerChart').addEventListener('mousedown', onPortfolioPlannerBarPointerDown);
  document.getElementById('portfolioPlannerChart').addEventListener('dblclick', onPortfolioPlannerBarDblClick);
  document.getElementById('portfolioPlannerExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('portfolioPlannerExportAsPanel');
  });
  document.querySelectorAll('#portfolioPlannerExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var svgEl = document.querySelector('#portfolioPlannerChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, 'portfolio-planner-timeline');
      else exportSvgElementAsPng(svgEl, 'portfolio-planner-timeline', 4);
    });
  });
  document.getElementById('portfolioPlannerAddProjectClose').addEventListener('click', closePortfolioPlannerAddProjectModal);
  document.getElementById('portfolioPlannerAddProjectCancelBtn').addEventListener('click', closePortfolioPlannerAddProjectModal);
  document.getElementById('portfolioPlannerAddProjectSaveBtn').addEventListener('click', savePortfolioPlannerAddProjectFromModal);
  document.getElementById('portfolioPlannerAddProjectOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioPlannerAddProjectOverlay') closePortfolioPlannerAddProjectModal();
  });
  document.getElementById('portfolioPlannerProjectDatesClose').addEventListener('click', closePortfolioPlannerProjectDatesModal);
  document.getElementById('portfolioPlannerProjectDatesCancelBtn').addEventListener('click', closePortfolioPlannerProjectDatesModal);
  document.getElementById('portfolioPlannerProjectDatesClearBtn').addEventListener('click', clearPortfolioPlannerProjectDatesInModal);
  document.getElementById('portfolioPlannerProjectDatesSaveBtn').addEventListener('click', savePortfolioPlannerProjectDatesFromModal);
  document.getElementById('portfolioPlannerProjectDatesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioPlannerProjectDatesOverlay') closePortfolioPlannerProjectDatesModal();
  });
  document.getElementById('portfolioPlannerResourcesClose').addEventListener('click', closePortfolioPlannerResourcesModal);
  document.getElementById('portfolioPlannerResourcesDoneBtn').addEventListener('click', closePortfolioPlannerResourcesModal);
  document.getElementById('portfolioPlannerResourcesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'portfolioPlannerResourcesOverlay') closePortfolioPlannerResourcesModal();
  });
  document.getElementById('portfolioPlannerResourceAddBtn').addEventListener('click', addPortfolioPlannerResourceFromModal);
  document.getElementById('portfolioPlannerResourcesList').addEventListener('click', onPortfolioPlannerResourcesListClick);
  document.getElementById('portfolioPlannerResourcesList').addEventListener('change', onPortfolioPlannerResourcesListChange);
  document.getElementById('healthBtn').addEventListener('click', openHealthOverlay);
  document.getElementById('healthClose').addEventListener('click', closeHealthOverlay);
  document.getElementById('healthOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'healthOverlay'){ cancelHealthGaugeAnimation(); closeHealthOverlay(); }
  });
  document.getElementById('decisionsModalClose').addEventListener('click', closeDecisionsOverlay);
  document.getElementById('decisionsReportBtn').addEventListener('click', function(){ openReportOverlay('decisions'); });
  document.getElementById('decisionsDoneBtn').addEventListener('click', closeDecisionsOverlay);
  document.getElementById('decisionsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'decisionsOverlay') closeDecisionsOverlay();
  });
  document.getElementById('addDecisionBtn').addEventListener('click', function(){ showDecisionsFormView(null); });
  document.getElementById('decisionsSearchInput').addEventListener('input', function(e){
    ui.decisionsSearchTerm = e.target.value;
    renderDecisionsList();
  });
  document.getElementById('decisionsTypeFilter').addEventListener('change', function(e){
    ui.decisionsTypeFilter = e.target.value;
    renderDecisionsList();
  });
  document.getElementById('decisionsStatusFilter').addEventListener('change', function(e){
    ui.decisionsStatusFilter = e.target.value;
    renderDecisionsList();
  });
  document.getElementById('decisionFormCancelBtn').addEventListener('click', showDecisionsListView);
  document.getElementById('decisionFormSaveBtn').addEventListener('click', saveDecisionFromModal);
  document.getElementById('deleteDecisionBtn').addEventListener('click', deleteDecisionFromModal);

  document.getElementById('principlesBtn').addEventListener('click', openPrinciplesOverlay);
  document.getElementById('principlesModalClose').addEventListener('click', closePrinciplesOverlay);
  document.getElementById('principlesReportBtn').addEventListener('click', function(){ openReportOverlay('principles'); });
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
  document.getElementById('principlesTabMineBtn').addEventListener('click', function(){ switchPrinciplesTab('mine'); });
  document.getElementById('principlesTabLibraryBtn').addEventListener('click', function(){ switchPrinciplesTab('library'); });
  document.getElementById('principleShareCheckbox').addEventListener('change', function(e){
    updatePrincipleShareFromModal(e.target.checked);
  });

  document.getElementById('objectivesBtn').addEventListener('click', openObjectivesOverlay);
  document.getElementById('objectivesModalClose').addEventListener('click', closeObjectivesOverlay);
  document.getElementById('objectivesReportBtn').addEventListener('click', function(){ openReportOverlay('objectives'); });

  document.getElementById('reportClose').addEventListener('click', closeReportOverlay);
  document.getElementById('reportPrintBtn').addEventListener('click', printReport);
  document.getElementById('reportOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'reportOverlay') closeReportOverlay();
  });
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
  document.getElementById('accountMenuBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('accountMenuPanel');
  });
  document.getElementById('accountMenuPanel').addEventListener('click', function(e){
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
  document.getElementById('projectSearchTabSearchBtn').addEventListener('click', showProjectSearchSimpleView);
  document.getElementById('projectSearchTabQueryBtn').addEventListener('click', showProjectSearchQueryView);
  document.getElementById('projectSearchQueryDoneBtn').addEventListener('click', closeProjectSearchOverlay);
  document.getElementById('projectQueryRunBtn').addEventListener('click', runProjectQuery);
  document.getElementById('projectQueryNewBtn').addEventListener('click', handleProjectQueryNewClick);
  document.getElementById('projectQueryFormatBtn').addEventListener('click', formatProjectQuerySql);
  document.getElementById('projectQuerySchemaToggleBtn').addEventListener('click', toggleProjectQuerySchemaPanel);
  document.getElementById('projectQuerySavedToggleBtn').addEventListener('click', toggleProjectQuerySavedPanel);
  document.getElementById('projectQuerySavedList').addEventListener('click', handleProjectQuerySavedListClick);
  document.getElementById('projectQuerySaveBtn').addEventListener('click', handleProjectQuerySaveOrUpdateClick);
  document.getElementById('projectQuerySaveCancelBtn').addEventListener('click', hideProjectQuerySaveRow);
  document.getElementById('projectQuerySaveConfirmBtn').addEventListener('click', confirmSaveProjectQuery);
  document.getElementById('projectQueryApiUrlCopyBtn').addEventListener('click', copyProjectQueryApiUrl);
  document.getElementById('projectQueryApiTestBtn').addEventListener('click', testProjectQueryApi);
  document.getElementById('projectQueryViewTableBtn').addEventListener('click', showProjectQueryResultsTableView);
  document.getElementById('projectQueryViewJsonBtn').addEventListener('click', showProjectQueryResultsJsonView);
  document.getElementById('projectQueryExportCsvBtn').addEventListener('click', exportProjectQueryResultsAsCsv);
  document.getElementById('projectQueryCopyJsonBtn').addEventListener('click', copyProjectQueryResultsAsJson);
  document.getElementById('projectQueryExportJsonBtn').addEventListener('click', exportProjectQueryResultsAsJson);
  document.getElementById('projectQueryPrintBtn').addEventListener('click', printProjectQueryResults);

  // SQL intellisense (features/sql-intellisense.js) — recompute on every keystroke/click/selection
  // change, keyboard-drive the dropdown while it's open, and keep it tracking the caret on scroll.
  var projectQuerySqlEl = document.getElementById('projectQuerySql');
  projectQuerySqlEl.addEventListener('input', updateProjectQueryIntellisense);
  projectQuerySqlEl.addEventListener('click', updateProjectQueryIntellisense);
  projectQuerySqlEl.addEventListener('scroll', repositionProjectQueryIntellisense);
  projectQuerySqlEl.addEventListener('blur', hideProjectQueryIntellisense);
  projectQuerySqlEl.addEventListener('keydown', function(e){
    if(!isProjectQueryIntellisenseOpen()) return;
    if(e.key === 'Tab'){
      e.preventDefault();
      acceptProjectQueryIntellisenseSuggestion();
    } else if(e.key === 'ArrowDown'){
      e.preventDefault();
      moveProjectQueryIntellisenseActive(1);
    } else if(e.key === 'ArrowUp'){
      e.preventDefault();
      moveProjectQueryIntellisenseActive(-1);
    } else if(e.key === 'Escape'){
      e.preventDefault();
      e.stopPropagation();
      hideProjectQueryIntellisense();
    }
  });
  // mousedown (not click) so this fires before the textarea's own blur closes the dropdown first.
  document.getElementById('projectQueryIntellisenseDropdown').addEventListener('mousedown', function(e){
    e.preventDefault();
    handleProjectQueryIntellisenseClick(e);
  });

  document.getElementById('projectQueryErdZoomInBtn').addEventListener('click', function(){ setProjectQueryErdZoom(0.1); });
  document.getElementById('projectQueryErdZoomOutBtn').addEventListener('click', function(){ setProjectQueryErdZoom(-0.1); });
  document.getElementById('projectQueryErdResetBtn').addEventListener('click', resetProjectQueryErdZoom);
  document.getElementById('projectQueryErdExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('projectQueryErdExportAsPanel');
  });
  document.querySelectorAll('#projectQueryErdExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-schema-erd';
      var svgEl = document.querySelector('#projectQuerySchemaErdInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  var projectQueryErdScrollEl = document.getElementById('projectQueryErdScroll');
  projectQueryErdScrollEl.addEventListener('wheel', function(e){
    e.preventDefault();
    zoomProjectQueryErdAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  projectQueryErdScrollEl.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    erdZoomState.panActive = true;
    erdZoomState.panMoved = false;
    erdZoomState.panStartX = e.clientX;
    erdZoomState.panStartY = e.clientY;
    erdZoomState.panStartScrollLeft = projectQueryErdScrollEl.scrollLeft;
    erdZoomState.panStartScrollTop = projectQueryErdScrollEl.scrollTop;
    projectQueryErdScrollEl.classList.add('kf-depmap-panning');
  });
  document.addEventListener('mousemove', function(e){
    if(!erdZoomState.panActive) return;
    var dx = e.clientX - erdZoomState.panStartX;
    var dy = e.clientY - erdZoomState.panStartY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) erdZoomState.panMoved = true;
    if(erdZoomState.panMoved){
      projectQueryErdScrollEl.scrollLeft = erdZoomState.panStartScrollLeft - dx;
      projectQueryErdScrollEl.scrollTop = erdZoomState.panStartScrollTop - dy;
    }
  });
  document.addEventListener('mouseup', function(){
    if(erdZoomState.panActive){
      erdZoomState.panActive = false;
      projectQueryErdScrollEl.classList.remove('kf-depmap-panning');
    }
  });

  document.getElementById('deleteProjectBtn').addEventListener('click', function(){
    var p = getCurrentProject();
    if(!p) return;
    confirmDialog(
      'Delete project "' + p.name + '"?',
      'This permanently deletes the project and all of its columns and tasks (' + Object.keys(p.tasks).length + ' task(s)). This cannot be undone.',
      async function(){
        if(isServerAuthoritative(p)){
          try {
            await deleteProjectOnServer(p);
            resetFilters();
            renderAll();
            checkProjectAlerts();
            toast('Project deleted.');
          } catch(e){
            toast('Could not delete project on the server: ' + (e.message || 'unknown error'));
          }
          return;
        }
        deleteProject(p.id);
        resetFilters();
        renderAll();
        checkProjectAlerts();
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

  document.getElementById('todoBtn').addEventListener('click', openTodoOverlay);
  document.getElementById('todoClose').addEventListener('click', closeTodoOverlay);
  document.getElementById('todoOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'todoOverlay') closeTodoOverlay();
  });
  document.getElementById('todoAddListBtn').addEventListener('click', addTodoListFromModal);

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
  document.getElementById('depMapColumnFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleDepMapColumnFilterPanel();
  });
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

  document.getElementById('governanceMapBtn').addEventListener('click', openGovMapOverlay);
  document.getElementById('govMapClose').addEventListener('click', closeGovMapOverlay);
  document.getElementById('govMapRelationshipsToggle').addEventListener('click', toggleGovMapShowRelationships);
  document.getElementById('govMapZoomInBtn').addEventListener('click', function(){ setGovMapZoom(0.1); });
  document.getElementById('govMapZoomOutBtn').addEventListener('click', function(){ setGovMapZoom(-0.1); });
  document.getElementById('govMapResetBtn').addEventListener('click', resetGovMapZoom);
  document.getElementById('govMapExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('govMapExportAsPanel');
  });
  document.querySelectorAll('#govMapExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-governance-map';
      var svgEl = document.querySelector('#govMapInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('govMapOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'govMapOverlay') closeGovMapOverlay();
  });
  document.getElementById('govMapInner').addEventListener('click', function(e){
    if(govMapState.panMoved) return;
    var node = e.target.closest('.kf-govmap-hub') || e.target.closest('.kf-govmap-leaf');
    if(!node) return;
    var type = node.getAttribute('data-type');
    var id = node.getAttribute('data-id');
    closeGovMapOverlay();
    if(type === 'principles'){ openPrinciplesOverlay(); if(id) showPrinciplesFormView(id); }
    else if(type === 'objectives'){ openObjectivesOverlay(); if(id) showObjectivesFormView(id); }
    else if(type === 'documents'){ openDocumentsOverlay(); if(id) showDocumentsFormView(id); }
    else if(type === 'risks'){ openRisksOverlay(); if(id) showRisksFormView(id); }
    else if(type === 'decisions'){ openDecisionsOverlay(); if(id) showDecisionsFormView(id); }
  });

  document.getElementById('workflowBtn').addEventListener('click', openWorkflowOverlay);
  document.getElementById('navWorkflowBtn').addEventListener('click', openWorkflowOverlay);
  document.getElementById('workflowClose').addEventListener('click', closeWorkflowOverlay);
  document.getElementById('workflowModeSelectBtn').addEventListener('click', function(){ setWorkflowMode('select'); });
  document.getElementById('workflowModeAllowedBtn').addEventListener('click', function(){ setWorkflowMode('allowed'); });
  document.getElementById('workflowModeDisallowedBtn').addEventListener('click', function(){ setWorkflowMode('disallowed'); });
  document.getElementById('workflowModeConditionalBtn').addEventListener('click', function(){ setWorkflowMode('conditional'); });
  document.getElementById('workflowZoomInBtn').addEventListener('click', function(){ setWorkflowZoom(0.1); });
  document.getElementById('workflowZoomOutBtn').addEventListener('click', function(){ setWorkflowZoom(-0.1); });
  document.getElementById('workflowResetBtn').addEventListener('click', resetWorkflowZoom);
  document.getElementById('workflowReflowBtn').addEventListener('click', handleWorkflowReflow);
  document.getElementById('workflowSaveBtn').addEventListener('click', saveWorkflowToServer);
  document.getElementById('workflowExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('workflowExportAsPanel');
  });
  document.querySelectorAll('#workflowExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var project = getCurrentProject();
      var filenameBase = (project ? project.key : 'export') + '-workflow';
      var svgEl = document.querySelector('#workflowInner svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, filenameBase);
      else exportSvgElementAsPng(svgEl, filenameBase, 4);
    });
  });
  document.getElementById('workflowOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'workflowOverlay') closeWorkflowOverlay();
  });
  document.getElementById('workflowInner').addEventListener('click', handleWorkflowInnerClick);
  document.getElementById('workflowEdgeTypeSelect').addEventListener('change', function(){
    updateWorkflowEdgePopoverMessageVisibility();
    refreshWorkflowEdgeConditionControls();
  });
  document.getElementById('workflowEdgeConditionFieldSelect').addEventListener('change', handleWorkflowEdgeConditionFieldChange);
  document.getElementById('workflowEdgeSaveBtn').addEventListener('click', saveWorkflowEdgePopover);
  document.getElementById('workflowEdgeDeleteBtn').addEventListener('click', deleteWorkflowEdgeFromPopover);
  document.getElementById('workflowEdgeCancelBtn').addEventListener('click', closeWorkflowEdgePopover);
  document.getElementById('workflowColumnCapSaveBtn').addEventListener('click', saveWorkflowColumnCapPopover);
  document.getElementById('workflowColumnCapCancelBtn').addEventListener('click', closeWorkflowColumnCapPopover);
  document.addEventListener('click', function(e){
    if(isWorkflowEdgePopoverOpen() && !e.target.closest('#workflowEdgePopover') && !e.target.closest('.kf-wfedge-hit')) closeWorkflowEdgePopover();
    if(isWorkflowColumnCapPopoverOpen() && !e.target.closest('#workflowColumnCapPopover') && !e.target.closest('.kf-wfnode')) closeWorkflowColumnCapPopover();
  });

  var workflowScrollEl = document.getElementById('workflowScroll');
  workflowScrollEl.addEventListener('wheel', function(e){
    if(!lastWorkflowLayout) return;
    e.preventDefault();
    zoomWorkflowAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  workflowScrollEl.addEventListener('mousedown', handleWorkflowScrollMouseDown);
  document.addEventListener('mousemove', handleWorkflowPointerMove);
  document.addEventListener('mouseup', handleWorkflowPointerUp);

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
  document.getElementById('costBenefitColumnFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleCbColumnFilterPanel();
  });
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
  document.getElementById('portfolioRiskMatrixExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('portfolioRiskMatrixExportAsPanel');
  });
  document.querySelectorAll('#portfolioRiskMatrixExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var svgEl = document.querySelector('#portfolioRiskMatrixChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, 'portfolio-risk-matrix');
      else exportSvgElementAsPng(svgEl, 'portfolio-risk-matrix', 4);
    });
  });
  document.getElementById('portfolioTimelineExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('portfolioTimelineExportAsPanel');
  });
  document.querySelectorAll('#portfolioTimelineExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var svgEl = document.querySelector('#portfolioTimelineChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, 'portfolio-timeline');
      else exportSvgElementAsPng(svgEl, 'portfolio-timeline', 4);
    });
  });
  document.getElementById('portfolioActivityExportAsBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleExportAsPanel('portfolioActivityExportAsPanel');
  });
  document.querySelectorAll('#portfolioActivityExportAsPanel .kf-export-as-option').forEach(function(btn){
    btn.addEventListener('click', function(){
      closeAllExportAsPanels();
      var svgEl = document.querySelector('#portfolioActivityChart svg');
      if(!svgEl){ toast('Nothing to export.'); return; }
      if(btn.getAttribute('data-export-type') === 'svg') exportSvgElementAsSvgFile(svgEl, 'portfolio-activity');
      else exportSvgElementAsPng(svgEl, 'portfolio-activity', 4);
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

  var govMapScrollEl = document.getElementById('govMapScroll');
  govMapScrollEl.addEventListener('wheel', function(e){
    if(!lastGovMapLayout) return;
    e.preventDefault();
    zoomGovMapAtPoint(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, {passive: false});
  govMapScrollEl.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    govMapState.panActive = true;
    govMapState.panMoved = false;
    govMapState.panStartX = e.clientX;
    govMapState.panStartY = e.clientY;
    govMapState.panStartScrollLeft = govMapScrollEl.scrollLeft;
    govMapState.panStartScrollTop = govMapScrollEl.scrollTop;
    govMapScrollEl.classList.add('kf-govmap-panning');
  });
  document.addEventListener('mousemove', function(e){
    if(!govMapState.panActive) return;
    var dx = e.clientX - govMapState.panStartX;
    var dy = e.clientY - govMapState.panStartY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) govMapState.panMoved = true;
    if(govMapState.panMoved){
      govMapScrollEl.scrollLeft = govMapState.panStartScrollLeft - dx;
      govMapScrollEl.scrollTop = govMapState.panStartScrollTop - dy;
    }
  });
  document.addEventListener('mouseup', function(){
    if(govMapState.panActive){
      govMapState.panActive = false;
      govMapScrollEl.classList.remove('kf-govmap-panning');
    }
  });

  document.getElementById('exportBtn').addEventListener('click', function(){
    var p = getCurrentProject();
    if(!p){ toast('No project to export.'); return; }
    if(Object.keys(p.tasks).length === 0){ toast('This project has no tasks to export.'); return; }
    exportProjectJSON(p);
  });

  document.getElementById('projectMgmtReportBtn').addEventListener('click', function(){
    if(!getCurrentProject()){ toast('No project selected.'); return; }
    openProjectManagementReportOverlay();
  });

  document.getElementById('migrateToServerBtn').addEventListener('click', function(){
    var p = getCurrentProject();
    if(!p){ toast('No project to migrate.'); return; }
    var lastOrgName = '';
    try { lastOrgName = localStorage.getItem('kanbanflow_last_org_name') || ''; } catch(e){ /* storage unavailable */ }
    var organisationName = window.prompt('Organisation name (existing name reuses it, a new name creates it):', lastOrgName);
    if(!organisationName || !organisationName.trim()){ return; }
    organisationName = organisationName.trim();
    try { localStorage.setItem('kanbanflow_last_org_name', organisationName); } catch(e){ /* storage unavailable */ }
    confirmDialog(
      p.serverProjectId ? 'Re-migrate "' + p.name + '" to "' + organisationName + '"?' : 'Migrate "' + p.name + '" to "' + organisationName + '"?',
      p.serverProjectId
        ? 'This project was already migrated. Migrating again creates a second copy on the server.'
        : 'This creates the project (and any new team member accounts) under Organisation "' + organisationName + '". Existing accounts in that Organisation are matched by name.',
      function(){ migrateProjectToServer(p, organisationName).then(renderAll, function(){ /* toast already shown by migrateProjectToServer */ }); }
    );
  });

  function openServerLoginModal(){
    document.getElementById('serverLoginOverlay').classList.remove('hidden');
    document.getElementById('serverLoginSsoBtn').classList.add('hidden');
    _ssoLookupOrgId = null;
    document.getElementById('serverLoginUsernameInput').focus();
  }
  document.getElementById('serverLoginBtn').addEventListener('click', openServerLoginModal);
  // Fires when any API call comes back 401 on a request that had a token attached — i.e. the
  // session itself expired or was revoked, not just a bad-credentials login attempt (see api.js's
  // apiFetch). Surfacing the login modal immediately means the user can just re-enter their
  // password right there, rather than having to notice a toast and go hunt for the Login button.
  setOnAuthExpired(openServerLoginModal);
  // Fires when the server blocks a mutating request because User.MustChangePassword is still set
  // (see Program.cs's enforcement middleware) — pop the modal right then so the user understands
  // why their edit didn't save, instead of just a generic error toast.
  setOnMustChangePassword(function(){ openChangePasswordModal(''); });
  function closeServerLoginModal(){ document.getElementById('serverLoginOverlay').classList.add('hidden'); }
  document.getElementById('serverLoginClose').addEventListener('click', closeServerLoginModal);
  document.getElementById('serverLoginCancelBtn').addEventListener('click', closeServerLoginModal);
  document.getElementById('serverLoginOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'serverLoginOverlay') closeServerLoginModal();
  });

  // Debounced org discovery as the identifier field is typed — see api.js's ssoLookupApi for why
  // this is safe to call unauthenticated (it never reveals whether the identifier itself matched a
  // real account, only whether SSO is available). Password login stays available underneath
  // regardless of the result — SSO coexists by default (OrganisationSsoConfig.RequireSso is what
  // actually enforces SSO-only, server-side, if an OrgAdmin turns it on).
  var _ssoLookupOrgId = null;
  var _ssoLookupTimer = null;
  document.getElementById('serverLoginUsernameInput').addEventListener('input', function(){
    var identifier = this.value.trim();
    var ssoBtn = document.getElementById('serverLoginSsoBtn');
    clearTimeout(_ssoLookupTimer);
    if(!identifier){ ssoBtn.classList.add('hidden'); _ssoLookupOrgId = null; return; }
    _ssoLookupTimer = setTimeout(function(){
      ssoLookupApi(identifier).then(function(result){
        _ssoLookupOrgId = result.ssoAvailable ? result.organisationId : null;
        ssoBtn.classList.toggle('hidden', !result.ssoAvailable);
      }, function(){ /* lookup failure just leaves the SSO button hidden — password login still works */ });
    }, 400);
  });
  document.getElementById('serverLoginSsoBtn').addEventListener('click', function(){
    if(!_ssoLookupOrgId) return;
    window.location.href = '/api/saml/' + _ssoLookupOrgId + '/login';
  });
  document.getElementById('serverLoginSubmitBtn').addEventListener('click', function(){
    var username = document.getElementById('serverLoginUsernameInput').value.trim();
    var password = document.getElementById('serverLoginPasswordInput').value;
    if(!username || !password){ toast('Please enter a username and password.'); return; }
    loginToServer(username, password).then(function(result){
      document.getElementById('serverLoginPasswordInput').value = '';
      closeServerLoginModal();
      connectEventStream();
      pullServerProjectsIntoLocal().then(function(count){
        renderAll();
        if(count > 0) toast('Loaded ' + count + ' project(s) from the server.');
        if(result.user.mustChangePassword) openChangePasswordModal(password);
      });
    }, function(){ /* toast already shown by loginToServer */ });
  });

  document.getElementById('serverLogoutBtn').addEventListener('click', function(){
    clearToken();
    disconnectEventStream();
    // Server-authoritative projects stay exactly as they are — still flagged server-authoritative,
    // still showing their last-synced data — they just can't push/pull further changes until logged
    // back in (any attempt will 401 and re-open the login modal via setOnAuthExpired above).
    renderAll();
    toast('Logged out.');
  });

  document.getElementById('changePasswordBtn').addEventListener('click', function(){
    if(!isServerLoggedIn()){ toast('Log in to the server first.'); return; }
    openChangePasswordModal('');
  });
  function openChangePasswordModal(prefilledCurrentPassword){
    document.getElementById('changePasswordIntro').classList.toggle('kf-vis-hidden', !prefilledCurrentPassword);
    document.getElementById('changePasswordCurrentInput').value = prefilledCurrentPassword || '';
    document.getElementById('changePasswordNewInput').value = '';
    document.getElementById('changePasswordConfirmInput').value = '';
    document.getElementById('changePasswordOverlay').classList.remove('hidden');
    (prefilledCurrentPassword ? document.getElementById('changePasswordNewInput') : document.getElementById('changePasswordCurrentInput')).focus();
  }
  function closeChangePasswordModal(){
    document.getElementById('changePasswordOverlay').classList.add('hidden');
    document.getElementById('changePasswordCurrentInput').value = '';
  }
  document.getElementById('changePasswordClose').addEventListener('click', closeChangePasswordModal);
  document.getElementById('changePasswordSkipBtn').addEventListener('click', closeChangePasswordModal);
  document.getElementById('changePasswordOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'changePasswordOverlay') closeChangePasswordModal();
  });
  document.getElementById('changePasswordSaveBtn').addEventListener('click', function(){
    var currentPassword = document.getElementById('changePasswordCurrentInput').value;
    var newPassword = document.getElementById('changePasswordNewInput').value;
    var confirmPassword = document.getElementById('changePasswordConfirmInput').value;
    if(!currentPassword){ toast('Please enter your current password.'); return; }
    if(!newPassword || newPassword.length < 8){ toast('New password must be at least 8 characters.'); return; }
    if(newPassword !== confirmPassword){ toast('Passwords do not match.'); return; }
    changePasswordOnServer(currentPassword, newPassword).then(function(){
      closeChangePasswordModal();
    }, function(){ /* toast already shown by changePasswordOnServer */ });
  });

  document.getElementById('myPreferencesBtn').addEventListener('click', openOpeningExperienceModal);

  document.getElementById('manageUsersLink').addEventListener('click', function(e){
    e.preventDefault();
    openOrgUsersModal();
  });
  document.getElementById('orgUsersClose').addEventListener('click', closeOrgUsersModal);
  document.getElementById('orgUsersDoneBtn').addEventListener('click', closeOrgUsersModal);
  document.getElementById('orgUsersOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'orgUsersOverlay') closeOrgUsersModal();
  });

  document.getElementById('ssoConfigLink').addEventListener('click', function(e){
    e.preventDefault();
    openSsoConfigModal();
  });
  document.getElementById('ssoConfigClose').addEventListener('click', closeSsoConfigModal);
  document.getElementById('ssoConfigDoneBtn').addEventListener('click', closeSsoConfigModal);
  document.getElementById('ssoConfigOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'ssoConfigOverlay') closeSsoConfigModal();
  });
  document.getElementById('ssoConfigSaveBtn').addEventListener('click', saveSsoConfigFromModal);
  document.getElementById('ssoGenerateScimTokenBtn').addEventListener('click', generateScimTokenFromModal);
  document.getElementById('ssoGenerateApiKeyBtn').addEventListener('click', generateApiKeyFromModal);
  document.getElementById('ssoRevokeApiKeyBtn').addEventListener('click', revokeApiKeyFromModal);

  document.getElementById('saveAsTemplateLink').addEventListener('click', function(e){
    e.preventDefault();
    openSaveAsTemplateModal();
  });
  document.getElementById('saveAsTemplateModalClose').addEventListener('click', closeSaveAsTemplateModal);
  document.getElementById('saveAsTemplateCancelBtn').addEventListener('click', closeSaveAsTemplateModal);
  document.getElementById('saveAsTemplateSaveBtn').addEventListener('click', saveAsTemplateFromModal);
  document.getElementById('saveAsTemplateOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'saveAsTemplateOverlay') closeSaveAsTemplateModal();
  });
  document.getElementById('saveAsTemplateNameInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); saveAsTemplateFromModal(); }
  });

  document.getElementById('manageTemplatesLink').addEventListener('click', function(e){
    e.preventDefault();
    openTemplatesModal();
  });
  document.getElementById('templatesModalClose').addEventListener('click', closeTemplatesModal);
  document.getElementById('templatesDoneBtn').addEventListener('click', closeTemplatesModal);
  document.getElementById('templatesOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'templatesOverlay') closeTemplatesModal();
  });
  document.getElementById('createOrgUserBtn').addEventListener('click', createOrgUserFromModal);
  document.getElementById('newOrgUserPasswordInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); createOrgUserFromModal(); }
  });

  document.getElementById('refreshBtn').addEventListener('click', function(){ window.location.reload(); });
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('appSettingsBtn').addEventListener('click', openAppSettingsOverlay);
  document.getElementById('appSettingsClose').addEventListener('click', closeAppSettingsOverlay);
  document.getElementById('appSettingsDoneBtn').addEventListener('click', closeAppSettingsOverlay);
  document.getElementById('appSettingsOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'appSettingsOverlay') closeAppSettingsOverlay();
  });
  document.getElementById('appSettingsSsoConfigBtn').addEventListener('click', function(){
    closeAppSettingsOverlay();
    openSsoConfigModal();
  });
  document.getElementById('aboutBtn').addEventListener('click', openAboutModal);
  document.getElementById('aboutModalClose').addEventListener('click', closeAboutModal);
  document.getElementById('aboutOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'aboutOverlay') closeAboutModal();
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
  document.getElementById('settingsShowWorkflowBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('workflow', e.target.checked);
  });
  document.getElementById('settingsShowTimeTrackingBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('timeTracking', e.target.checked);
  });
  document.getElementById('settingsShowChangeAuditingBtn').addEventListener('change', function(e){
    var checkbox = e.target;
    if(!checkbox.checked){
      updateHeaderButtonVisibilitySetting('changeAuditing', false);
      return;
    }
    /* The warning is about local storage growth — the audit log is stored in the server's own
       database for a cloud project, not this browser's localStorage, so the concern doesn't apply
       there and the confirmation is skipped entirely. */
    if(isServerAuthoritative(getCurrentProject())){
      updateHeaderButtonVisibilitySetting('changeAuditing', true);
      return;
    }
    /* Revert immediately — the browser already ticked the box on
       click — and only actually turn it on (re-checking it) once the
       user confirms, since this is the one App Setting whose "on"
       state keeps growing every task's stored data on every edit. */
    checkbox.checked = false;
    confirmDialog(
      'Enable Change Auditing?',
      'Every field change made to a task will be recorded — when, what changed, and its old and new value. Over time this can significantly increase the size of your project’s data file.',
      function(){
        checkbox.checked = true;
        updateHeaderButtonVisibilitySetting('changeAuditing', true);
      }
    );
  });
  document.getElementById('settingsShowSubTasksBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('subTasks', e.target.checked);
  });
  document.getElementById('settingsShowRetrospectiveBtn').addEventListener('change', function(e){
    updateHeaderButtonVisibilitySetting('retrospective', e.target.checked);
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
    refitBoardForOpenTaskModal();
  });
  window.addEventListener('hashchange', openTaskFromHashIfPresent);

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
  document.getElementById('statusFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    toggleStatusFilterPanel();
  });
  document.getElementById('portfolioPlannerCategoryFilterBtn').addEventListener('click', function(e){
    e.stopPropagation();
    togglePortfolioPlannerCategoryFilterPanel();
  });
  document.addEventListener('click', function(e){
    var teamWrap = document.getElementById('teamFilterWrap');
    if(teamWrap && !teamWrap.contains(e.target)) closeTeamFilterPanel();
    var wrap = document.getElementById('assigneeFilterWrap');
    if(wrap && !wrap.contains(e.target)) closeAssigneeFilterPanel();
    var typeWrap = document.getElementById('taskTypeFilterWrap');
    if(typeWrap && !typeWrap.contains(e.target)) closeTaskTypeFilterPanel();
    var statusWrap = document.getElementById('statusFilterWrap');
    if(statusWrap && !statusWrap.contains(e.target)) closeStatusFilterPanel();
    var depMapColWrap = document.getElementById('depMapColumnFilterWrap');
    if(depMapColWrap && !depMapColWrap.contains(e.target)) closeDepMapColumnFilterPanel();
    var cbColWrap = document.getElementById('costBenefitColumnFilterWrap');
    if(cbColWrap && !cbColWrap.contains(e.target)) closeCbColumnFilterPanel();
    var portfolioProjectWrap = document.getElementById('portfolioProjectFilterWrap');
    if(portfolioProjectWrap && !portfolioProjectWrap.contains(e.target)) closeProjectFilterPanel();
    var portfolioPlannerCategoryWrap = document.getElementById('portfolioPlannerCategoryFilterWrap');
    if(portfolioPlannerCategoryWrap && !portfolioPlannerCategoryWrap.contains(e.target)) closePortfolioPlannerCategoryFilterPanel();
  });

  document.getElementById('taskModalClose').addEventListener('click', closeTaskModal);
  document.getElementById('taskCancelBtn').addEventListener('click', closeTaskModal);
  document.getElementById('taskSaveBtn').addEventListener('click', saveTaskFromModal);
  document.getElementById('taskDeleteBtn').addEventListener('click', deleteTaskFromModal);
  document.getElementById('taskPrioritySelect').addEventListener('change', updatePriorityIcon);
  document.getElementById('taskProgressInput').addEventListener('input', function(e){
    document.getElementById('taskProgressValueLabel').textContent = e.target.value + '%';
  });
  document.getElementById('taskDocUrlInput').addEventListener('input', updateDocUrlOpenButtonVisibility);
  document.getElementById('taskDocUrlOpenBtn').addEventListener('click', openDocUrlInNewTab);
  document.getElementById('taskAuditToggleBtn').addEventListener('click', toggleAuditTrail);
  document.getElementById('depSearchInput').addEventListener('input', function(e){
    ui.depSearchTerm = e.target.value.trim();
    renderDependencyPicker();
  });
  document.getElementById('taskParentTaskSelect').addEventListener('change', onParentTaskSelectChange);
  document.getElementById('subtaskSearchInput').addEventListener('input', function(e){
    ui.subtaskSearchTerm = e.target.value.trim();
    renderSubtaskPicker(getCurrentProject());
  });
  document.getElementById('taskOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'taskOverlay') closeTaskModal();
  });

  document.getElementById('setPrivateKeyModalClose').addEventListener('click', closeSetPrivateKeyModal);
  document.getElementById('setPrivateKeyCancelBtn').addEventListener('click', closeSetPrivateKeyModal);
  document.getElementById('setPrivateKeyConfirmBtn').addEventListener('click', confirmSetPrivateKeyFromModal);
  document.getElementById('setPrivateKeyOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'setPrivateKeyOverlay') closeSetPrivateKeyModal();
  });

  document.getElementById('unlockPrivateTaskModalClose').addEventListener('click', closeUnlockPrivateTaskModal);
  document.getElementById('unlockPrivateTaskCancelBtn').addEventListener('click', closeUnlockPrivateTaskModal);
  document.getElementById('unlockPrivateTaskConfirmBtn').addEventListener('click', confirmUnlockFromModal);
  document.getElementById('unlockPrivateTaskContinueBtn').addEventListener('click', continueWithoutKeyFromModal);
  document.getElementById('unlockPrivateTaskOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'unlockPrivateTaskOverlay') closeUnlockPrivateTaskModal();
  });

  document.getElementById('columnModalClose').addEventListener('click', closeColumnModal);
  document.getElementById('columnCancelBtn').addEventListener('click', closeColumnModal);
  document.getElementById('columnSaveBtn').addEventListener('click', saveColumnFromModal);
  document.getElementById('columnDeleteBtn').addEventListener('click', deleteColumnFromModal);
  document.getElementById('columnColorEnabledCheckbox').addEventListener('change', function(e){
    document.getElementById('columnColorInput').disabled = !e.target.checked;
  });
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
  document.getElementById('confirmCancelBtn').addEventListener('click', function(){
    var cancelAction = getPendingCancelAction();
    closeConfirmDialog();
    if(cancelAction) cancelAction();
  });
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

  document.getElementById('overrunAlertClose').addEventListener('click', closeOverrunAlert);
  document.getElementById('overrunAlertOkBtn').addEventListener('click', closeOverrunAlert);
  document.getElementById('overrunAlertOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'overrunAlertOverlay') closeOverrunAlert();
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

  document.getElementById('ufoClose').addEventListener('click', closeUfoModal);
  document.getElementById('ufoOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'ufoOverlay') closeUfoModal();
  });

  document.getElementById('openingExperienceTodoBtn').addEventListener('click', function(){
    chooseOpeningExperience('todo');
    renderToolbar(); // reveals "My Preferences" immediately if this was the first-ever answer
    openTodoOverlay();
  });
  document.getElementById('openingExperienceBoardBtn').addEventListener('click', function(){
    chooseOpeningExperience('board');
    renderToolbar(); // reveals "My Preferences" immediately if this was the first-ever answer
  });
  document.getElementById('openingExperienceClose').addEventListener('click', closeOpeningExperienceModal);
  document.getElementById('openingExperienceOverlay').addEventListener('mousedown', function(e){
    if(e.target.id === 'openingExperienceOverlay') closeOpeningExperienceModal();
  });

  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    // Second line of defense alongside the textarea's own keydown handler (which stopPropagation's
    // when it handles Escape itself) — closes just the intellisense dropdown, not the whole Project
    // Search modal, in case this ever fires first.
    if(isProjectQueryIntellisenseOpen()) hideProjectQueryIntellisense();
    else if(!document.getElementById('unlockPrivateTaskOverlay').classList.contains('hidden')) closeUnlockPrivateTaskModal();
    else if(!document.getElementById('setPrivateKeyOverlay').classList.contains('hidden')) closeSetPrivateKeyModal();
    else if(!document.getElementById('taskOverlay').classList.contains('hidden')) closeTaskModal();
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
    else if(isReportOverlayOpen()) closeReportOverlay();
    else if(isPrinciplesOverlayOpen()) closePrinciplesOverlay();
    else if(isObjectivesOverlayOpen()) closeObjectivesOverlay();
    else if(isProjectSearchOverlayOpen()) closeProjectSearchOverlay();
    else if(isTeamsCommitteesOverlayOpen()) closeTeamsCommitteesOverlay();
    else if(isPortfolioProjectDatesModalOpen()) closePortfolioProjectDatesModal();
    else if(isPortfolioDashboardOverlayOpen()) closePortfolioDashboardOverlay();
    else if(isPortfolioPlannerProjectDatesModalOpen()) closePortfolioPlannerProjectDatesModal();
    else if(isPortfolioPlannerAddProjectModalOpen()) closePortfolioPlannerAddProjectModal();
    else if(isPortfolioPlannerResourcesModalOpen()) closePortfolioPlannerResourcesModal();
    else if(isPortfolioPlannerOverlayOpen()) closePortfolioPlannerOverlay();
    else if(isHealthOverlayOpen()){ cancelHealthGaugeAnimation(); closeHealthOverlay(); }
    else if(isAppSettingsOverlayOpen()) closeAppSettingsOverlay();
    else if(isAboutModalOpen()) closeAboutModal();
    else if(isProjectStorageModalOpen()) closeProjectStorageModal();
    else if(!document.getElementById('apiEndpointsOverlay').classList.contains('hidden')) closeApiEndpointsModal();
    else if(!document.getElementById('confirmOverlay').classList.contains('hidden')) closeConfirmDialog();
    else if(!document.getElementById('importConflictOverlay').classList.contains('hidden')) closeImportConflictModal();
    else if(!document.getElementById('overdueAlertOverlay').classList.contains('hidden')) closeOverdueAlert();
    else if(!document.getElementById('overrunAlertOverlay').classList.contains('hidden')) closeOverrunAlert();
    else if(!document.getElementById('defaultScoreAlertOverlay').classList.contains('hidden')) closeDefaultScoreAlert();
    else if(!document.getElementById('backupReminderOverlay').classList.contains('hidden')) dismissBackupReminder();
    else if(!document.getElementById('depMapColumnFilterPanel').classList.contains('hidden')) closeDepMapColumnFilterPanel();
    else if(!document.getElementById('costBenefitColumnFilterPanel').classList.contains('hidden')) closeCbColumnFilterPanel();
    else if(isDepMapOpen()) closeDepMapOverlay();
    else if(isOrgChartMemberPopoverOpen()) closeOrgChartMemberPopover();
    else if(isOrgChartOpen()) closeOrgChartOverlay();
    else if(isGovMapOpen()) closeGovMapOverlay();
    else if(isWorkflowEdgePopoverOpen()) closeWorkflowEdgePopover();
    else if(isWorkflowColumnCapPopoverOpen()) closeWorkflowColumnCapPopover();
    else if(isWorkflowOverlayOpen()) closeWorkflowOverlay();
    else if(isTimelineOverlayOpen()) closeTimelineOverlay();
    else if(isCostBenefitOverlayOpen()) closeCostBenefitOverlay();
    else if(isTaskListOpen()) closeTaskListOverlay();
    else if(isBulkEditOverlayOpen()) closeBulkEditOverlay();
    else if(isTodoOverlayOpen()) closeTodoOverlay();
    else if(isArchivedTasksOverlayOpen()) closeArchivedTasksOverlay();
    else if(!document.getElementById('teamFilterPanel').classList.contains('hidden')) closeTeamFilterPanel();
    else if(!document.getElementById('assigneeFilterPanel').classList.contains('hidden')) closeAssigneeFilterPanel();
    else if(!document.getElementById('taskTypeFilterPanel').classList.contains('hidden')) closeTaskTypeFilterPanel();
    else if(!document.getElementById('statusFilterPanel').classList.contains('hidden')) closeStatusFilterPanel();
    else if(isProjectFilterPanelOpen()) closeProjectFilterPanel();
    else if(!document.getElementById('portfolioPlannerCategoryFilterPanel').classList.contains('hidden')) closePortfolioPlannerCategoryFilterPanel();
    else if(isMobileDrawerOpen()) closeMobileDrawer();
    else if(isUfoModalOpen()) closeUfoModal();
    else if(isOpeningExperienceModalOpen()) closeOpeningExperienceModal();
  });
}

/* =========================================================
   HASHBANG TASK ROUTING
   A URL like "#!/DEMO-1" deep-links straight to that task: switching
   to its project first if it isn't already the active one, then
   opening it through the same openTaskModal() path a board-card click
   would use. ========================================================= */
function openTaskFromHashIfPresent(){
  var key = parseTaskKeyFromHash();
  if(!key) return;
  var found = findTaskByKey(key);
  if(!found){
    toast('No task found for "' + key + '".');
    clearTaskHash();
    return;
  }
  if(found.project.id !== state.db.currentProjectId){
    state.db.currentProjectId = found.project.id;
    saveDB();
    resetFilters();
    renderAll();
  }
  openTaskModal(found.task.id, found.task.columnId);
}

/* Handles the ?ssoCode=/?ssoError= this page was reloaded with after a round trip through the
   IdP and SamlController's ACS action (see SamlService.SuccessRedirectUrl/ErrorRedirectUrl on the
   server). Either way the query param is stripped via history.replaceState once handled, so a
   page refresh afterward doesn't try to redeem an already-used code or re-show a stale error. */
function handleSsoCallbackIfPresent(){
  var params = new URLSearchParams(window.location.search);
  var code = params.get('ssoCode');
  var error = params.get('ssoError');
  if(!code && !error) return;

  params.delete('ssoCode');
  params.delete('ssoError');
  var newSearch = params.toString();
  var newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
  window.history.replaceState({}, '', newUrl);

  if(error){ toast(error); return; }

  completeSsoLogin(code).then(function(){
    connectEventStream();
    pullServerProjectsIntoLocal().then(function(count){
      renderAll();
      if(count > 0) toast('Loaded ' + count + ' project(s) from the server.');
    });
  }, function(){ /* toast already shown by completeSsoLogin */ });
}

/* Signed-in users always land on the Board (per product decision — this whole feature, including
   recording device type, is skipped for them). For an anonymous/local session: the very first time
   the app ever runs in this browser, record mobile-vs-desktop and — mobile only — show the Opening
   Experience picker instead of deciding anything here; on every later run, honor whatever was
   actually chosen (or stay on the Board if the picker was dismissed without an answer / this browser
   was first used on desktop, since board is the normal default anyway). */
function applyOpeningExperience(){
  if(isServerLoggedIn()) return;
  var pickerShown = recordDeviceTypeAndMaybeShowPicker();
  if(pickerShown) return;
  if(getOpeningExperience() === 'todo') openTodoOverlay();
}

/* =========================================================
   INIT
   ========================================================= */
function init(){
  loadDB();
  wireEvents();
  renderAll();
  checkProjectAlerts();
  openTaskFromHashIfPresent();
  handleSsoCallbackIfPresent();
  applyOpeningExperience();
  reportPageLoadTiming(); // last step of init() — see page-load-telemetry.js for why here specifically

  // Reconciles a still-logged-in returning browser the same way the interactive login flow does
  // (see the serverLoginSubmitBtn handler above) — previously this only ran right after an
  // interactive login, so a browser that stayed logged in across a reload never retired a stale
  // pre-login-swap local copy of a project it had migrated anonymously, and kept silently editing
  // that dead-end copy forever. See pullServerProjectsIntoLocal's comment in features/migration.js.
  if(isServerLoggedIn()){
    connectEventStream();
    pullServerProjectsIntoLocal().then(function(count){
      if(count > 0) renderAll();
    });
  }
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
