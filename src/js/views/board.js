"use strict";
import { state } from '../storage.js';
import { normalizeHeaderButtonVisibility, isTimeTrackingEnabled, saveDB } from '../storage.js';
import { PRIORITY_META, PRIORITY_ORDER, PRIORITY_COLORS, MOBILE_BREAKPOINT } from '../config.js';
import { iconSvg } from '../icons.js';
import { getTasksArray, getColumn, getMemberById, getTaskTypeById, isTaskBlocked, isTaskOverdue, getTaskOverrunStatus, getDescendants, buildChildrenMap, wouldCreateCycle, escapeHTML } from '../utils.js';
import { memberInitials, utcISOToLocalDisplayDate, utcISOToLocalDateValue, localDateValueToUTCISO, clampTaskScore, clampProgress, defaultStartDateValue, defaultEndDateValue, lightenHexColor, darkenHexColor } from '../date-utils.js';
import { getCurrentProject } from '../store.js';
import { ui } from '../ui.js';
import { getPriority, currentTheme } from '../ui.js';
import { reorderColumns, deleteColumn, moveTaskToColumn, updateTask, addTask, deleteTask } from '../mutations.js';
import { getReleaseById } from '../utils.js';
import { evaluateColumnMove, isWorkflowEnabled } from '../features/workflow-engine.js';
import { isGovernanceMapEnabled } from './governance-map.js';
import { isServerAuthoritative, isServerLoggedIn, moveTaskToColumnOnServer, refreshProjectFromServer, reorderColumnsOnServer, deleteColumnOnServer } from '../features/migration.js';
import { updateProjectSettingsApi, isOrgAdmin, isProjectAdmin, getOrgName, isApiReachable, pollApiReachability } from '../api.js';
import { renderPriorityFilterChips, renderTeamFilterChips, renderAssigneeFilterChips, renderTaskTypeFilterChips, renderStatusFilterChips, taskMatchesFilters, updateSearchClearButtonVisibility, clearBoardSearch, updateSearchHashtagIntellisense, closeSearchHashtagPanel, isSearchHashtagPanelOpen, acceptSearchHashtagOption, onSearchInputKeydown, updateArchivedSearchMatchesPanel } from './board-filters.js';
import { fitBoardForTaskModal, restoreBoardAfterTaskModal, refitBoardForOpenTaskModal } from './board-layout.js';

// Re-exported for the many modals that already do `import { escapeHTML } from '../views/board.js'`
// — the actual implementation now lives in utils.js (the shared, quote-escaping version) so it
// only needs to be correct in one place.
export { escapeHTML };

// ARCHITECTURE-REVIEW.md finding #4, option 1 (pure file split, zero behavior change — see
// CLAUDE.md for the two other approaches that were tried and reverted before this one): the filter-
// chip rendering (~350 lines) and the widescreen task-modal-docking layout logic used to live in
// this file directly; they're now board-filters.js/board-layout.js. Every external file that already
// imports from '../views/board.js' keeps working completely unchanged — this file re-exports
// everything they used to get from here directly, so no import path anywhere else in the codebase
// needed to change.
export {
  renderPriorityFilterChips,
  UNASSIGNED_FILTER_KEY,
  teamHasAnyMatchingTask,
  renderTeamFilterChips,
  toggleTeamFilterPanel,
  closeTeamFilterPanel,
  renderAssigneeFilterChips,
  toggleAssigneeFilterPanel,
  closeAssigneeFilterPanel,
  NO_TYPE_FILTER_KEY,
  renderTaskTypeFilterChips,
  toggleTaskTypeFilterPanel,
  closeTaskTypeFilterPanel,
  STATUS_FILTER_OPTIONS,
  renderStatusFilterChips,
  toggleStatusFilterPanel,
  closeStatusFilterPanel,
  taskMatchesFilters,
  updateSearchClearButtonVisibility,
  clearBoardSearch,
  updateSearchHashtagIntellisense,
  closeSearchHashtagPanel,
  isSearchHashtagPanelOpen,
  acceptSearchHashtagOption,
  onSearchInputKeydown,
  updateArchivedSearchMatchesPanel
} from './board-filters.js';
export { fitBoardForTaskModal, restoreBoardAfterTaskModal, refitBoardForOpenTaskModal } from './board-layout.js';

function iconHTML(name, size){ return '<span class="kf-icon">'+iconSvg(name,size)+'</span>'; }

var _toast = function(msg){ console.error(msg); };
var _confirmDialog = function(title, msg, cb){ if(window.confirm(title + '\n' + msg)) cb(); };
var _openTaskModal = function(){};
var _openColumnModal = function(){};
export function setBoardDeps(deps){
  if(deps.toast) _toast = deps.toast;
  if(deps.confirmDialog) _confirmDialog = deps.confirmDialog;
  if(deps.openTaskModal) _openTaskModal = deps.openTaskModal;
  if(deps.openColumnModal) _openColumnModal = deps.openColumnModal;
}

/* =========================================================
   RENDERING
   ========================================================= */
export var HEADER_MOVABLE_NAV_ITEMS = [
  {key: 'principles', id: 'principlesBtn', label: 'Principles'},
  {key: 'objectives', id: 'objectivesBtn', label: 'Objectives'},
  {key: 'documents', id: 'documentsBtn', label: 'Documents'},
  {key: 'risks', id: 'risksBtn', label: 'Risks'},
  {key: 'decisions', id: 'decisionsBtn', label: 'Decisions'},
  {key: 'teamsCommittees', id: 'teamsCommitteesBtn', label: 'Teams & Committees'}
];
/* Project Administrator gate, shared by applyHeaderButtonVisibility (App Settings/Workflow buttons)
   and renderColumn/renderBoard below (column add/edit/delete/reorder controls) — one place computing
   "can the CURRENT user manage this project's columns/settings/workflow/members", so the three
   call sites can never drift out of sync with each other. Local-only projects have no admin/auth
   concept at all (same exemption every other permission gate in this app already makes), so they're
   always manageable. */
export function canCurrentUserManageProject(){
  var project = getCurrentProject();
  return !isServerAuthoritative(project) || isProjectAdmin(project.serverProjectId);
}

export function applyHeaderButtonVisibility(){
  var project = getCurrentProject();
  var visibility = project ? normalizeHeaderButtonVisibility(project.headerButtonVisibility) : {documents:true, risks:true, decisions:true, health:true, principles:true, objectives:true, teamsCommittees:true, workflow:false, retrospective:false};
  document.getElementById('healthBtn').classList.toggle('hidden', !visibility.health);

  /* Project Administrator gate (see MembersController.cs's own doc comment for the four capabilities
     this role covers): App Settings, Workflow, and column add/edit/delete/reorder are all
     Project-Admin-only once a project is server-authoritative, same "unrestricted until there's
     actually an admin/auth concept" exemption for local-only projects as every other permission gate
     here. renderColumn()/renderBoard() below call canCurrentUserManageProject() directly for the
     column-header controls; the Team modal's member-management controls (modals/team.js) apply the
     same underlying isProjectAdmin() check where they're rendered. */
  var canManageProject = canCurrentUserManageProject();
  document.getElementById('appSettingsBtn').classList.toggle('hidden', !canManageProject);
  document.getElementById('addColumnTopBtn').classList.toggle('hidden', !canManageProject);

  /* Teams & Committees CRUD is OrgAdmin-only once a project is server-authoritative (matching
     TeamsCommitteesController's server-side [Authorize(Policy="OrgAdmin")]) — a non-admin member
     never sees the entry point rather than clicking through to a 403. Local-only projects have no
     admin/auth concept at all, so stay unrestricted. This is a permissions gate layered on top of
     the project's own on/off setting below (visibility.teamsCommittees), not a replacement for it —
     Org Chart, further down, shares that same setting flag but is read-only, so it's deliberately
     NOT gated the same way. */
  var isEffectivelyVisible = function(item){
    if(item.key === 'teamsCommittees' && isServerAuthoritative(project) && !isOrgAdmin()) return false;
    return !!visibility[item.key];
  };

  var enabledItems = HEADER_MOVABLE_NAV_ITEMS.filter(isEffectivelyVisible);
  var useMoreMenu = enabledItems.length >= 3;

  /* Desktop: either the 6 show individually (per their own App Settings
     state, as before), or — once 3 or more are enabled — they're all
     hidden and replaced by a single "More..." dropdown of text links
     for just the enabled ones. */
  document.getElementById('headerMoreWrap').classList.toggle('hidden', !useMoreMenu);
  HEADER_MOVABLE_NAV_ITEMS.forEach(function(item){
    var btn = document.getElementById(item.id);
    btn.classList.toggle('hidden', !isEffectivelyVisible(item));
    /* Desktop-only: once 3+ are enabled, the 6 are visually tucked
       into the "More..." dropdown via this dedicated class (not
       .hidden, which mobile also respects) — mobile CSS overrides it
       back to visible regardless, since the mobile menu always shows
       everything flat with no consolidation. */
    btn.classList.toggle('kf-header-consolidated', useMoreMenu);
  });
  var morePanel = document.getElementById('headerMorePanel');
  morePanel.innerHTML = useMoreMenu ? enabledItems.map(function(item){
    return '<a href="#" class="kf-header-more-link" data-nav-target="' + item.id + '">' + escapeHTML(item.label) + '</a>';
  }).join('') : '';

  /* Portfolio Dashboard is Org-Admin-only, and only meaningful once a project is actually
     server-authoritative — a local-only project has no admin/auth concept at all, same "for a
     server project" gating already used for teamsCommitteesBtn above. Unlike the movable-group
     buttons above, this isn't a per-project on/off App Setting — it's a permissions gate, so it's
     handled here alongside Org Chart/Workflow rather than folded into isEffectivelyVisible. */
  document.getElementById('portfolioDashboardBtn').classList.toggle('kf-vis-hidden', !(isServerAuthoritative(project) && isOrgAdmin()));

  // Portfolio Planner is the same Org-Admin-only, server-authoritative-project gate as Portfolio
  // Dashboard above — a pure permissions gate, not a per-project App Setting.
  document.getElementById('navPortfolioPlannerBtn').classList.toggle('kf-vis-hidden', !(isServerAuthoritative(project) && isOrgAdmin()));

  document.getElementById('orgChartBtn').classList.toggle('kf-vis-hidden', !visibility.teamsCommittees);
  document.getElementById('navOrgChartBtn').classList.toggle('kf-vis-hidden', !visibility.teamsCommittees);
  // Workflow editing is Project-Admin-only (canManageProject, above) — same entry-point-hidden
  // treatment as Portfolio Dashboard/Planner/Teams & Committees rather than a read-only view mode,
  // consistent with how every other admin-only feature in this app is gated.
  document.getElementById('workflowBtn').classList.toggle('kf-vis-hidden', !visibility.workflow || !canManageProject);
  document.getElementById('navWorkflowBtn').classList.toggle('kf-vis-hidden', !visibility.workflow || !canManageProject);
  /* Retrospectives has no in-header quick button (nav-only, unlike Workflow/Org Chart above), so this
     is the only visibility toggle it needs. */
  document.getElementById('navRetrospectiveBtn').classList.toggle('kf-vis-hidden', !visibility.retrospective);

  var govMapEnabled = isGovernanceMapEnabled(visibility);
  document.getElementById('governanceMapBtn').classList.toggle('kf-vis-hidden', !govMapEnabled);
  document.getElementById('navGovernanceMapBtn').classList.toggle('kf-vis-hidden', !govMapEnabled);

  /* Project Storage reports on the WHOLE local DB (every project sitting in this browser, not just
     the current one), so it's gated on SESSION login state rather than the current project's own
     server-authoritative status the way Portfolio Dashboard/Planner above are. A session that's
     never logged in at all is implicitly its own "Org Admin" for local data — there's no real
     multi-tenant org concept without a server login — so this only hides for a logged-in session
     that ISN'T actually an Org Admin, the same isServerLoggedIn()+isOrgAdmin() combination Project
     Templates/Todo Lists already use (see modals/todo.js's own doc comment). */
  var canViewProjectStorage = !isServerLoggedIn() || isOrgAdmin();
  document.getElementById('projectStorageBtn').classList.toggle('kf-vis-hidden', !canViewProjectStorage);
  document.getElementById('navProjectStorageBtn').classList.toggle('kf-vis-hidden', !canViewProjectStorage);

  /* API Endpoints (modals/api-endpoints.js) — Project Admin/Org Admin only (canCurrentUserManageProject
     already folds Org Admin in via isProjectAdmin()'s own bypass), AND only shown once this project
     actually has at least one saved query with ExposeViaApi=true — no point offering a management
     tool for zero endpoints. Must be recomputed here rather than only at modal-open time since
     ExposeViaApi can flip in the Advanced Query tab without this function otherwise re-running. */
  var hasExposedApiQueries = isServerAuthoritative(project) && (project.savedQueries || []).some(function(q){ return q.exposeViaApi; });
  var canViewApiEndpoints = canCurrentUserManageProject() && hasExposedApiQueries;
  document.getElementById('apiEndpointsBtn').classList.toggle('kf-vis-hidden', !canViewApiEndpoints);
  document.getElementById('navApiEndpointsBtn').classList.toggle('kf-vis-hidden', !canViewApiEndpoints);

  renderTeamFilterChips();
}

export function openAppSettingsOverlay(){
  var project = getCurrentProject();
  if(!project){ _toast('No project selected.'); return; }
  var visibility = normalizeHeaderButtonVisibility(project.headerButtonVisibility);
  document.getElementById('settingsShowDocumentsBtn').checked = visibility.documents;
  document.getElementById('settingsShowRisksBtn').checked = visibility.risks;
  document.getElementById('settingsShowDecisionsBtn').checked = visibility.decisions;
  document.getElementById('settingsShowHealthBtn').checked = visibility.health;
  document.getElementById('settingsShowPrinciplesBtn').checked = visibility.principles;
  document.getElementById('settingsShowObjectivesBtn').checked = visibility.objectives;
  document.getElementById('settingsShowTeamsCommitteesBtn').checked = visibility.teamsCommittees;
  document.getElementById('settingsShowWorkflowBtn').checked = visibility.workflow;
  document.getElementById('settingsShowTimeTrackingBtn').checked = visibility.timeTracking;
  document.getElementById('settingsShowChangeAuditingBtn').checked = visibility.changeAuditing;
  document.getElementById('settingsShowSubTasksBtn').checked = visibility.subTasks;
  document.getElementById('settingsShowRetrospectiveBtn').checked = visibility.retrospective;
  // SAML/SCIM configuration is an org-admin-only concern (same gating as the Account menu's own
  // "SSO & Provisioning" link) — shown here purely as a discoverability shortcut into that same
  // modal, not a per-project toggle of its own.
  document.getElementById('appSettingsEnterpriseCategory').classList.toggle('hidden', !isOrgAdmin());
  document.getElementById('appSettingsOverlay').classList.remove('hidden');
}
export function closeAppSettingsOverlay(){
  document.getElementById('appSettingsOverlay').classList.add('hidden');
}
export function isAppSettingsOverlayOpen(){
  return !document.getElementById('appSettingsOverlay').classList.contains('hidden');
}
export async function updateHeaderButtonVisibilitySetting(field, isVisible){
  var project = getCurrentProject();
  if(!project) return;
  var visibility = normalizeHeaderButtonVisibility(project.headerButtonVisibility);
  visibility[field] = isVisible;

  if(isServerAuthoritative(project)){
    try {
      await updateProjectSettingsApi(project.serverProjectId, visibility);
      await refreshProjectFromServer(project.id);
      applyHeaderButtonVisibility();
      renderBoard();
    } catch(e){
      _toast('Could not save settings on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  project.headerButtonVisibility = visibility;
  saveDB();
  applyHeaderButtonVisibility();
  renderBoard();
}

export function renderAll(){
  renderProjectSelect();
  renderToolbar();
  renderPriorityFilterChips();
  renderTeamFilterChips();
  renderAssigneeFilterChips();
  renderTaskTypeFilterChips();
  renderStatusFilterChips();
  applyHeaderButtonVisibility();
  renderBoard();
}

export function renderProjectSelect(){
  var sel = document.getElementById('projectSelect');
  sel.innerHTML = '';
  state.db.projectOrder.forEach(function(pid){
    var p = state.db.projects[pid];
    if(!p) return;
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + p.key + ')';
    if(pid === state.db.currentProjectId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// Captured once from the DOM the first time renderToolbar runs, rather than hardcoded here, so the
// header text (currently "Enkl Task") only has to be changed in index.html to stay in sync.
var _baseLogoText = null;

export function renderToolbar(){
  var p = getCurrentProject();
  var keyEl = document.getElementById('toolbarKey');
  var isServerLinked = !!(p && p.serverProjectId);
  var reachable = isApiReachable();
  keyEl.classList.toggle('kf-board-key-server', isServerLinked);
  // Connectivity glow only makes sense once this key already means "lives on the cloud" — a
  // local-only project has no server to lose contact with, so it never gets either class.
  keyEl.classList.toggle('kf-board-key-online', isServerLinked && reachable);
  keyEl.classList.toggle('kf-board-key-offline', isServerLinked && !reachable);
  keyEl.innerHTML = (isServerLinked ? iconSvg('cloud', 11) : '') + (p ? p.key : '—');
  document.getElementById('toolbarTitle').textContent = p ? p.name : 'No project';

  // Once a project is fully server-authoritative there's nothing left to migrate — re-running it
  // would just create a duplicate copy on the server (see the migrateToServerBtn handler's own
  // "Re-migrate" confirm-dialog warning in app.js, kept as a manual fallback for the narrow window
  // between an anonymous migration and this browser's next login/reconciliation swap).
  // Throttled fire-and-forget re-probe of /health (see api.js) — re-renders the toolbar itself if
  // reachability flips, so this stays eventually-consistent without polling on a timer. The same
  // probe result is what drives the key's online/offline glow above.
  pollApiReachability(renderToolbar);
  toggleHeaderActionButton('migrateToServerBtn', !isServerAuthoritative(p) && reachable);

  // Login/Logout are session-level, not tied to whichever project happens to be open — Login shows
  // whenever there's no active session, Logout once there is one.
  var loggedIn = isServerLoggedIn();
  toggleHeaderActionButton('serverLoginBtn', !loggedIn);
  toggleHeaderActionButton('serverLogoutBtn', loggedIn);
  // There's no password to change until there's a server session to change it on.
  toggleHeaderActionButton('changePasswordBtn', loggedIn);

  var logoTextEl = document.getElementById('kfLogoText');
  if(logoTextEl){
    if(_baseLogoText === null) _baseLogoText = logoTextEl.textContent;
    var orgName = loggedIn ? getOrgName() : null;
    logoTextEl.textContent = orgName ? (_baseLogoText + ' - ' + orgName) : _baseLogoText;
  }

  // Unlike Manage Users below, this has a real "target" button (myPreferencesBtn, in the
  // kf-drawer-action-group row) so toggleHeaderActionButton's dual-element toggle also reaches the
  // mobile drawer's flattened button list — a plain link-only toggle (as Manage Users uses) is
  // invisible there, since .kf-desktop-menu-wrap (the whole Account dropdown) is display:none on
  // mobile and the drawer only ever shows the raw buttons directly. Always shown now that My
  // Preferences also covers the board background picker (modals/my-preferences.js), not just the
  // opening-experience re-entry point it used to be gated on — that section of the modal still
  // hides itself internally when there's no stored opening-experience preference to revisit.
  toggleHeaderActionButton('myPreferencesBtn', true);

  // Manage Users has no corresponding hidden "target" button to reuse toggleHeaderActionButton's
  // dual-element lookup with — it's a plain link with its own click handler (see app.js) — so it's
  // just toggled directly here.

  var manageUsersLink = document.getElementById('manageUsersLink');
  if(manageUsersLink) manageUsersLink.classList.toggle('kf-vis-hidden', !isOrgAdmin());

  var ssoConfigLink = document.getElementById('ssoConfigLink');
  if(ssoConfigLink) ssoConfigLink.classList.toggle('kf-vis-hidden', !isOrgAdmin());

  // Unlike Manage Users, Manage Templates has real value signed-out too (local-only templates, no
  // Organisation concept to gate on) — only hidden in the one case where opening it would just show
  // an error toast: signed in as a non-admin (its rename/delete actions are OrgAdmin-only server-side).
  var manageTemplatesLink = document.getElementById('manageTemplatesLink');
  if(manageTemplatesLink) manageTemplatesLink.classList.toggle('kf-vis-hidden', isServerLoggedIn() && !isOrgAdmin());

  // The whole Account menu (Login/Logout/Change Password/Manage Users) is meaningless with no API
  // to talk to — hide the trigger itself rather than leaving an empty/broken-looking dropdown.
  var accountMenuWrap = document.getElementById('accountMenuWrap');
  if(accountMenuWrap) accountMenuWrap.classList.toggle('kf-vis-hidden', !isApiReachable());
}

/* Hides/shows one of the header's project-action buttons together with its corresponding link in the
   "Projects..." overflow menu (mobile/narrow-viewport view of the same actions). */
function toggleHeaderActionButton(id, visible){
  var btn = document.getElementById(id);
  if(btn) btn.classList.toggle('kf-vis-hidden', !visible);
  var menuLink = document.querySelector('[data-nav-target="' + id + '"]');
  if(menuLink) menuLink.classList.toggle('kf-vis-hidden', !visible);
}

function getArchivedTasks(project){
  return getTasksArray(project).filter(function(t){ return t.archived; });
}

function refreshArchivedCountBadge(){
  var badge = document.getElementById('archivedCountBadge');
  var navBadge = document.getElementById('navArchivedCountBadge');
  if(!badge) return;
  var project = getCurrentProject();
  var count = project ? getArchivedTasks(project).length : 0;
  if(count > 0){
    badge.textContent = count;
    badge.classList.remove('kf-vis-hidden');
    if(navBadge){
      navBadge.textContent = count;
      navBadge.classList.remove('kf-vis-hidden');
    }
  } else {
    badge.classList.add('kf-vis-hidden');
    if(navBadge) navBadge.classList.add('kf-vis-hidden');
  }
}

export function renderBoard(){
  refreshArchivedCountBadge();
  var board = document.getElementById('board');
  board.innerHTML = '';
  var project = getCurrentProject();
  if(!project){
    board.innerHTML = '<div class="kf-board-empty">No project selected.</div>';
    return;
  }
  if(project.columns.length === 0){
    var empty = document.createElement('div');
    empty.className = 'kf-board-empty';
    empty.innerHTML = iconHTML('inbox',40) + '<div>This board has no columns yet.</div>';
    board.appendChild(empty);
  } else {
    project.columns.forEach(function(col){
      board.appendChild(renderColumn(project, col));
    });
  }
  if(canCurrentUserManageProject()){
    var addColBtn = document.createElement('button');
    addColBtn.className = 'kf-add-column';
    addColBtn.innerHTML = iconHTML('plus',16) + '<span>Add column</span>';
    addColBtn.addEventListener('click', function(){ _openColumnModal(null); });
    board.appendChild(addColBtn);
  }
}

/* For columns marked "done", tasks are always displayed sorted by
   dateLastModified (oldest → newest) rather than their manual drag
   order — completing a task is what determines its place in a Done
   column, not where it happened to land when dropped. Tasks missing
   dateLastModified (defensive fallback for old/incomplete data) sort
   by key ascending instead, and are placed after every task that does
   have a date, since their true completion time is unknown.
   This is purely a display-time transform — col.order itself (the
   manual drag order) is left untouched, so nothing is lost if the
   column is later un-marked as "done". */
export function getColumnDisplayOrder(project, col){
  if(!col.done) return col.order;

  var dated = [];
  var undated = [];
  col.order.forEach(function(taskId){
    var t = project.tasks[taskId];
    if(!t || t.archived) return;
    if(t.dateLastModified) dated.push(t); else undated.push(t);
  });

  dated.sort(function(a, b){
    var ta = new Date(a.dateLastModified).getTime();
    var tb = new Date(b.dateLastModified).getTime();
    if(ta !== tb) return ta - tb;
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });
  undated.sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  return dated.concat(undated).map(function(t){ return t.id; });
}

export function renderColumn(project, col){
  var section = document.createElement('section');
  section.className = 'kf-column';
  section.setAttribute('data-column-id', col.id);
  if(col.color){
    section.style.setProperty('--kf-column-accent', col.color);
    // Dark theme blends toward black instead of white — a near-white tint (lightenHexColor's default)
    // would clash with the rest of the dark palette, so colored columns stay a subtle dark shade there.
    var tint = currentTheme() === 'dark' ? darkenHexColor(col.color) : lightenHexColor(col.color);
    if(tint) section.style.setProperty('--kf-column-tint', tint);
  }

  var activeTaskCount = col.order.filter(function(taskId){
    var t = project.tasks[taskId];
    return t && !t.archived;
  }).length;

  // A capped column (col.cap a positive integer, -1 == uncapped) shows "current of cap" instead of
  // just the raw count, so the badge doubles as a live at-a-glance WIP indicator — independent of
  // whether Workflow enforcement itself is toggled on (see evaluateColumnCap in workflow-engine.js,
  // which enforces the cap unconditionally too).
  var countBadgeText = (col.cap != null && col.cap !== -1) ? (activeTaskCount + ' of ' + col.cap) : String(activeTaskCount);

  // Column add/edit/delete/reorder are all Project-Admin-only once a project is server-authoritative
  // (see canCurrentUserManageProject's own doc comment) — a non-admin gets a read-only board: no
  // edit/delete icons, and the header isn't draggable at all (a plain boolean property, not a
  // wrapper element, so none of the display:contents drag-and-drop risk CLAUDE.md documents applies
  // to gating it this way).
  var canManage = canCurrentUserManageProject();

  var header = document.createElement('div');
  header.className = 'kf-column-header';
  header.draggable = canManage;
  header.innerHTML =
    iconHTML('grip',14) +
    '<span class="kf-column-name' + (col.done ? ' done' : '') + '">' + escapeHTML(col.name) + '</span>' +
    '<span class="kf-count-badge">' + escapeHTML(countBadgeText) + '</span>';

  if(canManage){
    var actions = document.createElement('div');
    actions.className = 'kf-column-actions';
    var editBtn = document.createElement('button');
    editBtn.className = 'kf-btn kf-btn-ghost';
    editBtn.title = 'Edit column';
    editBtn.innerHTML = iconHTML('edit',14);
    editBtn.addEventListener('click', function(e){ e.stopPropagation(); _openColumnModal(col.id); });
    var delBtn = document.createElement('button');
    delBtn.className = 'kf-btn kf-btn-ghost';
    delBtn.title = 'Delete column';
    delBtn.innerHTML = iconHTML('trash',14);
    delBtn.addEventListener('click', function(e){
      e.stopPropagation();
      _confirmDialog(
        'Delete column "' + col.name + '"?',
        col.order.length > 0
          ? 'Its ' + col.order.length + ' task(s) will be permanently deleted.'
          : 'This column has no tasks.',
        function(){
          if(isServerAuthoritative(project)){
            deleteColumnOnServer(project, col.id).then(renderBoard, function(err){
              _toast('Could not delete column on the server: ' + (err.message || 'unknown error'));
            });
            return;
          }
          deleteColumn(project, col.id);
          renderBoard();
        }
      );
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
  }

  header.addEventListener('dragstart', function(e){
    ui.draggedColumnId = col.id;
    e.dataTransfer.setData('application/x-kf-column', col.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  header.addEventListener('dragover', function(e){
    if(e.dataTransfer.types.indexOf('application/x-kf-column') === -1) return;
    e.preventDefault();
  });
  header.addEventListener('drop', function(e){
    if(e.dataTransfer.types.indexOf('application/x-kf-column') === -1) return;
    e.preventDefault();
    var draggedId = e.dataTransfer.getData('application/x-kf-column');
    if(draggedId && draggedId !== col.id){
      if(isServerAuthoritative(project)){
        reorderColumnsOnServer(project, draggedId, col.id).then(renderBoard, function(err){
          _toast('Could not reorder columns on the server: ' + (err.message || 'unknown error'));
        });
        return;
      }
      reorderColumns(project, draggedId, col.id);
      renderBoard();
    }
  });

  var wfAlert = document.createElement('div');
  wfAlert.className = 'kf-workflow-block-banner hidden';

  var tasksWrap = document.createElement('div');
  tasksWrap.className = 'kf-tasks';
  tasksWrap.setAttribute('data-column-id', col.id);

  var visibleCount = 0;
  getColumnDisplayOrder(project, col).forEach(function(taskId){
    var t = project.tasks[taskId];
    if(!t) return;
    if(t.archived) return;
    if(!taskMatchesFilters(t)) return;
    visibleCount++;
    tasksWrap.appendChild(renderCard(project, t));
  });
  /* Appended into tasksWrap itself (absolutely positioned, see CSS)
     rather than as a sibling before it — a sibling would push
     tasksWrap's own box down when shown, moving it out from under the
     cursor mid-drag, which triggers a spurious dragleave -> the
     banner hides -> tasksWrap snaps back up -> dragover fires again,
     an infinite flicker loop. Overlaying it inside tasksWrap instead
     never changes tasksWrap's box, so the drag target stays put. */
  tasksWrap.appendChild(wfAlert);

  function clearWorkflowDragFeedback(){
    section.classList.remove('kf-dragover', 'kf-dragover-allowed', 'kf-dragover-blocked');
    wfAlert.classList.add('hidden');
    wfAlert.textContent = '';
  }

  tasksWrap.addEventListener('dragover', function(e){
    if(e.dataTransfer.types.indexOf('application/x-kf-task') === -1) return;
    e.preventDefault();
    var draggedTask = ui.draggedTaskId ? project.tasks[ui.draggedTaskId] : null;
    if(draggedTask){
      var result = evaluateColumnMove(project, draggedTask, col.id);
      section.classList.remove('kf-dragover');
      /* A cap breach always gets the red block treatment regardless of the Workflow toggle (it's
         enforced independently — see evaluateColumnMove), but an ALLOWED move only earns the green
         "workflow-approved" indicator when Workflow enforcement is actually on; otherwise this is
         just a plain, unremarkable move and should look like one (the plain blue indicator). */
      if(result.allowed && !isWorkflowEnabled(project)){
        section.classList.remove('kf-dragover-allowed', 'kf-dragover-blocked');
        section.classList.add('kf-dragover');
        wfAlert.classList.add('hidden');
      } else {
        section.classList.toggle('kf-dragover-allowed', result.allowed);
        section.classList.toggle('kf-dragover-blocked', !result.allowed);
        wfAlert.textContent = result.allowed ? '' : result.message;
        wfAlert.classList.toggle('hidden', result.allowed);
      }
      e.dataTransfer.dropEffect = result.allowed ? 'move' : 'none';
    } else {
      section.classList.remove('kf-dragover-allowed', 'kf-dragover-blocked');
      section.classList.add('kf-dragover');
      wfAlert.classList.add('hidden');
    }
  });
  tasksWrap.addEventListener('dragleave', function(e){
    clearWorkflowDragFeedback();
  });
  tasksWrap.addEventListener('drop', function(e){
    if(e.dataTransfer.types.indexOf('application/x-kf-task') === -1) return;
    e.preventDefault();
    clearWorkflowDragFeedback();
    var taskId = e.dataTransfer.getData('application/x-kf-task');
    if(!taskId) return;
    var draggedTask = project.tasks[taskId];
    if(draggedTask){
      var result = evaluateColumnMove(project, draggedTask, col.id);
      if(!result.allowed){ _toast(result.message); return; }
    }

    // Private tasks aren't modeled server-side (see modals/task.js) — a private task in a
    // server-authoritative project only ever exists locally, so its moves stay local-only too.
    if(isServerAuthoritative(project) && !(draggedTask && draggedTask.isPrivate)){
      moveTaskToColumnOnServer(project, taskId, col.id).then(renderBoard, function(err){
        _toast('Could not move task on the server: ' + (err.message || 'unknown error'));
      });
      return;
    }

    var cards = Array.prototype.slice.call(tasksWrap.querySelectorAll('.kf-card'));
    var dropIndex = cards.length;
    for(var i=0;i<cards.length;i++){
      var rect = cards[i].getBoundingClientRect();
      if(e.clientY < rect.top + rect.height/2){ dropIndex = i; break; }
    }
    moveTaskToColumn(project, taskId, col.id, dropIndex);
    saveDB();
    renderBoard();
  });

  var addTaskBtn = document.createElement('button');
  addTaskBtn.className = 'kf-add-task-btn';
  addTaskBtn.innerHTML = iconHTML('plus',14) + '<span>Add task</span>';
  addTaskBtn.addEventListener('click', function(){ _openTaskModal(null, col.id); });

  section.appendChild(header);
  section.appendChild(tasksWrap);
  section.appendChild(addTaskBtn);
  return section;
}

export function renderCard(project, task){
  var card = document.createElement('div');
  card.className = 'kf-card';
  card.draggable = true;
  card.setAttribute('data-task-id', task.id);

  var prio = getPriority(task.priority);
  var blocked = isTaskBlocked(project, task);
  var overdue = isTaskOverdue(project, task);
  var depCount = (task.dependencies || []).length;
  var assignee = getMemberById(project, task.assigneeId);
  var timeTrackingOn = isTimeTrackingEnabled(project);
  var overrun = timeTrackingOn ? getTaskOverrunStatus(project, task) : null;
  if(overrun) card.classList.add(overrun.level === 'over' ? 'kf-card-over' : 'kf-card-atrisk');
  var taskType = getTaskTypeById(project, task.typeId);

  // Row 1: key (+ private lock + type icon) on the left, assignee avatar pinned right in a
  // fixed-size slot so its presence/absence never shifts the row's height.
  var topRowHTML = '<span class="kf-card-row-left"><span class="kf-card-key">' + escapeHTML(task.key) + '</span>';
  if(task.isPrivate){
    topRowHTML += '<span class="kf-private-chip" title="Private task">' + iconSvg('lock',12) + '</span>';
  }
  topRowHTML += '<span class="kf-card-type-slot">' +
      ((taskType && taskType.iconName) ? '<span class="kf-card-type-icon" title="' + escapeHTML(taskType.name) + '">' + iconSvg(taskType.iconName, 13) + '</span>' : '') +
    '</span></span><span class="kf-card-avatar-slot">' +
    (assignee ? '<span class="kf-avatar kf-avatar-sm" style="background:' + assignee.color + ';" title="Assigned to ' + escapeHTML(assignee.name) + '">' + escapeHTML(memberInitials(assignee.name)) + '</span>' : '') +
    '</span>';

  // Row 2 (title) is rendered separately below — a natural 1-or-2-line block, only as tall
  // as it needs to be, capped at 2 lines with ellipsis for anything longer.

  // Row 3: priority (always present) + blocked/overdue chips — the row wraps via CSS if it
  // ever gets crowded.
  var tagsRowHTML = '<span class="kf-priority-pill" style="color:' + prio.color + ';background:' + prio.bg + ';">' + iconSvg(prio.icon,12) + escapeHTML(prio.label) + '</span>';
  if(blocked){
    tagsRowHTML += '<span class="kf-blocked-chip" title="Blocked by unfinished dependencies">' + iconSvg('warning',12) + 'Blocked</span>';
  }
  if(overdue){
    tagsRowHTML += '<span class="kf-overdue-chip" title="End date was ' + escapeHTML(utcISOToLocalDisplayDate(task.endDate)) + '">' + iconSvg('clock',12) + 'Overdue</span>';
  }

  // Row 4: progress graph on the left, only rendered when the project has time tracking on —
  // a project-wide toggle, so every card in a given project reserves this row consistently —
  // and related/dependency count pinned bottom-right in its own reserved slot.
  var progressPartHTML = '';
  if(timeTrackingOn){
    var progress = clampProgress(task.progress);
    progressPartHTML = '<span class="kf-progress-chip" title="Progress: ' + progress + '%">' +
      '<span class="kf-progress-track"><span class="kf-progress-fill' + (progress === 100 ? ' kf-progress-fill-done' : '') + '" style="width:' + progress + '%;"></span></span>' +
      '<span class="kf-progress-label">' + progress + '%</span>' +
    '</span>';
  }
  // Always rendered (even at zero) so the count is visible at a glance; a zero count is
  // dimmed to 50% opacity rather than removed, so it still reads as "nothing here" without
  // the row shifting when a dependency is later added.
  var depPartHTML = '<span class="kf-card-dep-slot"><span class="kf-dep-chip' + (depCount === 0 ? ' kf-dep-chip-zero' : '') + '" title="' +
      (depCount > 0 ? 'Depends on ' + depCount + ' task(s)' : 'No dependencies') + '">' + iconSvg('link',12) + depCount + '</span></span>';

  card.innerHTML =
    '<div class="kf-card-row kf-card-row-top">' + topRowHTML + '</div>' +
    '<div class="kf-card-title">' + escapeHTML(task.title) + '</div>' +
    '<div class="kf-card-row kf-card-row-tags">' + tagsRowHTML + '</div>' +
    // The progress slot is flex:1 (CSS) so the track stretches to fill whatever width the
    // dep-count slot doesn't need, rather than sitting at a fixed width.
    '<div class="kf-card-row kf-card-row-progress"><span class="kf-card-progress-slot">' + progressPartHTML + '</span>' + depPartHTML + '</div>';

  card.addEventListener('click', function(){
    if(ui.dragWasMove){ ui.dragWasMove = false; return; }
    _openTaskModal(task.id, task.columnId);
  });
  card.addEventListener('dragstart', function(e){
    ui.draggedTaskId = task.id;
    ui.dragWasMove = false;
    card.classList.add('kf-dragging');
    e.dataTransfer.setData('application/x-kf-task', task.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', function(){
    card.classList.remove('kf-dragging');
    ui.dragWasMove = true;
    setTimeout(function(){ ui.dragWasMove = false; }, 50);
  });

  return card;
}
