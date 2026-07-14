"use strict";
import { state } from '../storage.js';
import { normalizeHeaderButtonVisibility, isTimeTrackingEnabled, saveDB, getOpeningExperience } from '../storage.js';
import { PRIORITY_META, PRIORITY_ORDER, PRIORITY_COLORS, MOBILE_BREAKPOINT } from '../config.js';
import { iconSvg } from '../icons.js';
import { getTasksArray, getColumn, getMemberById, getTaskTypeById, getTeamCommitteeById, isTaskBlocked, isTaskOverdue, getTaskOverrunStatus, getDescendants, buildChildrenMap, wouldCreateCycle, escapeHTML } from '../utils.js';
import { memberInitials, utcISOToLocalDisplayDate, utcISOToLocalDateValue, localDateValueToUTCISO, clampTaskScore, clampProgress, defaultStartDateValue, defaultEndDateValue, lightenHexColor, darkenHexColor } from '../date-utils.js';
import { getCurrentProject } from '../store.js';
import { ui } from '../ui.js';
import { getPriority, currentTheme } from '../ui.js';
import { getTeamsCommitteesForMember } from '../mutations.js';
import { reorderColumns, deleteColumn, moveTaskToColumn, updateTask, addTask, deleteTask } from '../mutations.js';
import { getReleaseById } from '../utils.js';
import { evaluateColumnMove, isWorkflowEnabled } from '../features/workflow-engine.js';
import { isGovernanceMapEnabled } from './governance-map.js';
import { isServerAuthoritative, isServerLoggedIn, moveTaskToColumnOnServer, refreshProjectFromServer, reorderColumnsOnServer, deleteColumnOnServer } from '../features/migration.js';
import { updateProjectSettingsApi, isOrgAdmin, getOrgName, isApiReachable, pollApiReachability } from '../api.js';

// Re-exported for the many modals that already do `import { escapeHTML } from '../views/board.js'`
// — the actual implementation now lives in utils.js (the shared, quote-escaping version) so it
// only needs to be correct in one place.
export { escapeHTML };
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
export function applyHeaderButtonVisibility(){
  var project = getCurrentProject();
  var visibility = project ? normalizeHeaderButtonVisibility(project.headerButtonVisibility) : {documents:true, risks:true, decisions:true, health:true, principles:true, objectives:true, teamsCommittees:true, workflow:false, retrospective:false};
  document.getElementById('healthBtn').classList.toggle('hidden', !visibility.health);

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
  document.getElementById('workflowBtn').classList.toggle('kf-vis-hidden', !visibility.workflow);
  document.getElementById('navWorkflowBtn').classList.toggle('kf-vis-hidden', !visibility.workflow);
  /* Retrospectives has no in-header quick button (nav-only, unlike Workflow/Org Chart above), so this
     is the only visibility toggle it needs. */
  document.getElementById('navRetrospectiveBtn').classList.toggle('kf-vis-hidden', !visibility.retrospective);

  var govMapEnabled = isGovernanceMapEnabled(visibility);
  document.getElementById('governanceMapBtn').classList.toggle('kf-vis-hidden', !govMapEnabled);
  document.getElementById('navGovernanceMapBtn').classList.toggle('kf-vis-hidden', !govMapEnabled);

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
  // mobile and the drawer only ever shows the raw buttons directly. Only meaningful for an
  // anonymous/local session that actually has a stored opening-experience preference to revisit (see
  // modals/opening-experience.js) — signed-in users always land on the Board regardless, and a
  // browser that never got the first-run picker (desktop, or dismissed without answering) has
  // nothing to "change" here yet.
  toggleHeaderActionButton('myPreferencesBtn', !loggedIn && !!getOpeningExperience());

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

export function renderPriorityFilterChips(){
  var wrap = document.getElementById('priorityFilterChips');
  wrap.innerHTML = '';
  PRIORITY_ORDER.forEach(function(key){
    var conf = getPriority(key);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'kf-chip-filter' + (ui.activePriorities.has(key) ? ' active' : '');
    chip.setAttribute('data-priority', key);
    chip.innerHTML = '<span class="kf-dot" style="background:' + conf.accent + '"></span>' + conf.label;
    chip.addEventListener('click', function(){
      if(ui.activePriorities.has(key)) ui.activePriorities.delete(key);
      else ui.activePriorities.add(key);
      renderPriorityFilterChips();
      renderBoard();
    });
    wrap.appendChild(chip);
  });
}

export var UNASSIGNED_FILTER_KEY = '__unassigned__';

/* The Team filter only ever lists type==='team' entries (never
   committees, per spec) and is entirely hidden — not just empty —
   whenever Teams & Committees is disabled in App Settings, or when
   the project genuinely has zero teams. A team with no tasks
   currently assigned to any of its members (via the Task -> Member
   -> Team relationship) is still shown, but greyed out, rather than
   omitted, so the picker's options don't shift unpredictably as
   tasks get reassigned. */
export function teamHasAnyMatchingTask(project, teamId){
  var tasks = getTasksArray(project);
  for(var i = 0; i < tasks.length; i++){
    var t = tasks[i];
    if(t.archived || !t.assigneeId) continue;
    var memberTeamIds = getTeamsCommitteesForMember(project, t.assigneeId).map(function(tc){ return tc.id; });
    if(memberTeamIds.indexOf(teamId) !== -1) return true;
  }
  return false;
}
export function renderTeamFilterChips(){
  var wrap = document.getElementById('teamFilterWrap');
  var btn = document.getElementById('teamFilterBtn');
  var panel = document.getElementById('teamFilterPanel');
  var label = document.getElementById('teamFilterLabel');
  if(!wrap) return;

  var project = getCurrentProject();
  var visibility = project ? normalizeHeaderButtonVisibility(project.headerButtonVisibility) : {teamsCommittees: false};
  var teams = (project && visibility.teamsCommittees)
    ? (project.teamsCommittees || []).filter(function(tc){ return tc.type === 'team'; }).sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); })
    : [];

  if(!visibility.teamsCommittees || teams.length === 0){
    wrap.classList.add('kf-vis-hidden');
    panel.classList.add('hidden');
    ui.activeTeams.clear();
    return;
  }
  wrap.classList.remove('kf-vis-hidden');

  var n = ui.activeTeams.size;
  if(n === 0){
    label.textContent = 'Team';
  } else if(n === 1){
    var onlyTeam = getTeamCommitteeById(project, ui.activeTeams.values().next().value);
    label.textContent = onlyTeam ? onlyTeam.name : 'Team';
  } else {
    label.textContent = n + ' teams';
  }
  wrap.classList.toggle('active', n > 0);

  panel.innerHTML = '';
  teams.forEach(function(tc){
    var hasTasks = teamHasAnyMatchingTask(project, tc.id);
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row' + (hasTasks ? '' : ' kf-team-filter-empty');
    var checked = ui.activeTeams.has(tc.id);
    row.title = hasTasks ? '' : 'No tasks currently assigned to this team\'s members';
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(tc.name) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.activeTeams.add(tc.id);
      else ui.activeTeams.delete(tc.id);
      renderTeamFilterChips();
      renderBoard();
    });
    panel.appendChild(row);
  });

  if(n > 0){
    var divider = document.createElement('div');
    divider.className = 'kf-dropdown-filter-divider';
    panel.appendChild(divider);
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'kf-dropdown-filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', function(){
      ui.activeTeams.clear();
      renderTeamFilterChips();
      renderBoard();
    });
    panel.appendChild(clearBtn);
  }
}
export function toggleTeamFilterPanel(){
  var panel = document.getElementById('teamFilterPanel');
  panel.classList.toggle('hidden');
}
export function closeTeamFilterPanel(){
  document.getElementById('teamFilterPanel').classList.add('hidden');
}

export function renderAssigneeFilterChips(){
  var wrap = document.getElementById('assigneeFilterWrap');
  var btn = document.getElementById('assigneeFilterBtn');
  var panel = document.getElementById('assigneeFilterPanel');
  var label = document.getElementById('assigneeFilterLabel');
  if(!wrap) return;

  var project = getCurrentProject();
  var members = (project && project.members) || [];

  if(members.length === 0){
    wrap.classList.add('kf-vis-hidden');
    panel.classList.add('hidden');
    return;
  }
  wrap.classList.remove('kf-vis-hidden');

  /* Button label reflects the current selection */
  var n = ui.activeAssignees.size;
  if(n === 0){
    label.textContent = 'Assignee';
  } else if(n === 1){
    var onlyKey = ui.activeAssignees.values().next().value;
    if(onlyKey === UNASSIGNED_FILTER_KEY){
      label.textContent = 'Unassigned';
    } else {
      var onlyMember = getMemberById(project, onlyKey);
      label.textContent = onlyMember ? onlyMember.name : 'Assignee';
    }
  } else {
    label.textContent = n + ' assignees';
  }
  wrap.classList.toggle('active', n > 0);

  /* Rebuild the panel's option list (cheap — only happens on project
     switch, member add/remove, or panel open) */
  panel.innerHTML = '';

  members.forEach(function(m){
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row';
    var checked = ui.activeAssignees.has(m.id);
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dot" style="background:' + m.color + '"></span>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(m.name) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.activeAssignees.add(m.id);
      else ui.activeAssignees.delete(m.id);
      renderAssigneeFilterChips();
      renderBoard();
    });
    panel.appendChild(row);
  });

  var unassignedRow = document.createElement('label');
  unassignedRow.className = 'kf-dropdown-filter-row';
  var unassignedChecked = ui.activeAssignees.has(UNASSIGNED_FILTER_KEY);
  unassignedRow.innerHTML =
    '<input type="checkbox" ' + (unassignedChecked ? 'checked' : '') + '>' +
    '<span class="kf-dot" style="background:#c1c7d0"></span>' +
    '<span class="kf-dropdown-filter-name">Unassigned</span>';
  unassignedRow.querySelector('input').addEventListener('change', function(e){
    if(e.target.checked) ui.activeAssignees.add(UNASSIGNED_FILTER_KEY);
    else ui.activeAssignees.delete(UNASSIGNED_FILTER_KEY);
    renderAssigneeFilterChips();
    renderBoard();
  });
  panel.appendChild(unassignedRow);

  if(n > 0){
    var divider = document.createElement('div');
    divider.className = 'kf-dropdown-filter-divider';
    panel.appendChild(divider);
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'kf-dropdown-filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', function(){
      ui.activeAssignees.clear();
      renderAssigneeFilterChips();
      renderBoard();
    });
    panel.appendChild(clearBtn);
  }
}

export function toggleAssigneeFilterPanel(){
  var panel = document.getElementById('assigneeFilterPanel');
  panel.classList.toggle('hidden');
}
export function closeAssigneeFilterPanel(){
  document.getElementById('assigneeFilterPanel').classList.add('hidden');
}

export var NO_TYPE_FILTER_KEY = '__no_type__';

export function renderTaskTypeFilterChips(){
  var wrap = document.getElementById('taskTypeFilterWrap');
  var btn = document.getElementById('taskTypeFilterBtn');
  var panel = document.getElementById('taskTypeFilterPanel');
  var label = document.getElementById('taskTypeFilterLabel');
  if(!wrap) return;

  var project = getCurrentProject();
  var types = (project && project.taskTypes) || [];

  if(types.length === 0){
    wrap.classList.add('kf-vis-hidden');
    panel.classList.add('hidden');
    return;
  }
  wrap.classList.remove('kf-vis-hidden');

  /* Button label reflects the current selection */
  var n = ui.activeTaskTypes.size;
  if(n === 0){
    label.textContent = 'Type';
  } else if(n === 1){
    var onlyKey = ui.activeTaskTypes.values().next().value;
    if(onlyKey === NO_TYPE_FILTER_KEY){
      label.textContent = 'No type';
    } else {
      var onlyType = getTaskTypeById(project, onlyKey);
      label.textContent = onlyType ? onlyType.name : 'Type';
    }
  } else {
    label.textContent = n + ' types';
  }
  wrap.classList.toggle('active', n > 0);

  /* Rebuild the panel's option list (cheap — only happens on project
     switch, type add/rename/remove, or panel open) */
  panel.innerHTML = '';

  types.forEach(function(tt){
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row';
    var checked = ui.activeTaskTypes.has(tt.id);
    var typeIconHTML = tt.iconName
      ? '<span class="kf-tasklist-type-icon">' + iconSvg(tt.iconName, 13) + '</span>'
      : '<span class="kf-dot" style="background:#c1c7d0"></span>';
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      typeIconHTML +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(tt.name) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.activeTaskTypes.add(tt.id);
      else ui.activeTaskTypes.delete(tt.id);
      renderTaskTypeFilterChips();
      renderBoard();
    });
    panel.appendChild(row);
  });

  var noTypeRow = document.createElement('label');
  noTypeRow.className = 'kf-dropdown-filter-row';
  var noTypeChecked = ui.activeTaskTypes.has(NO_TYPE_FILTER_KEY);
  noTypeRow.innerHTML =
    '<input type="checkbox" ' + (noTypeChecked ? 'checked' : '') + '>' +
    '<span class="kf-dot" style="background:#c1c7d0"></span>' +
    '<span class="kf-dropdown-filter-name">No type</span>';
  noTypeRow.querySelector('input').addEventListener('change', function(e){
    if(e.target.checked) ui.activeTaskTypes.add(NO_TYPE_FILTER_KEY);
    else ui.activeTaskTypes.delete(NO_TYPE_FILTER_KEY);
    renderTaskTypeFilterChips();
    renderBoard();
  });
  panel.appendChild(noTypeRow);

  if(n > 0){
    var divider = document.createElement('div');
    divider.className = 'kf-dropdown-filter-divider';
    panel.appendChild(divider);
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'kf-dropdown-filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', function(){
      ui.activeTaskTypes.clear();
      renderTaskTypeFilterChips();
      renderBoard();
    });
    panel.appendChild(clearBtn);
  }
}

export function toggleTaskTypeFilterPanel(){
  var panel = document.getElementById('taskTypeFilterPanel');
  panel.classList.toggle('hidden');
}
export function closeTaskTypeFilterPanel(){
  document.getElementById('taskTypeFilterPanel').classList.add('hidden');
}

export function taskMatchesFilters(task){
  if(ui.activePriorities.size > 0 && !ui.activePriorities.has(task.priority)) return false;
  if(ui.activeTeams.size > 0){
    /* ui.activeTeams only ever contains type==='team' ids (the picker
       never offers committees), so no extra type check is needed here
       even though a member can belong to committees too. */
    var project = getCurrentProject();
    var memberTeamIds = task.assigneeId ? getTeamsCommitteesForMember(project, task.assigneeId).map(function(tc){ return tc.id; }) : [];
    var matchesAnySelectedTeam = memberTeamIds.some(function(tcId){ return ui.activeTeams.has(tcId); });
    if(!matchesAnySelectedTeam) return false;
  }
  if(ui.activeAssignees.size > 0){
    var assigneeKey = task.assigneeId || UNASSIGNED_FILTER_KEY;
    if(!ui.activeAssignees.has(assigneeKey)) return false;
  }
  if(ui.activeTaskTypes.size > 0){
    var typeKey = task.typeId || NO_TYPE_FILTER_KEY;
    if(!ui.activeTaskTypes.has(typeKey)) return false;
  }
  if(ui.searchTerm){
    var term = ui.searchTerm.toLowerCase();
    var hay = (task.key + ' ' + task.title + ' ' + (task.description||'')).toLowerCase();
    if(hay.indexOf(term) === -1) return false;
  }
  return true;
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
  var addColBtn = document.createElement('button');
  addColBtn.className = 'kf-add-column';
  addColBtn.innerHTML = iconHTML('plus',16) + '<span>Add column</span>';
  addColBtn.addEventListener('click', function(){ _openColumnModal(null); });
  board.appendChild(addColBtn);
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

var WIDESCREEN_TASK_DOCK_QUERY = '(min-width: 2560px)';

/* Below the 2560px breakpoint the Task modal is a centered, backdropped overlay sitting ON TOP of
   the board (see styles.css) — the board underneath needs no changes at all. At 2560px+ it instead
   docks flush to the right as a full-height panel that shares the screen with the board (see that
   media query's comment). Everything above the modal needs to narrow in lockstep for this to read
   as a reveal rather than a broken layout: the header (a full-width sibling of the side
   nav/board, not a descendant of either) and .kf-main-content (the flex column holding BOTH toolbar
   rows and .kf-board-wrap — narrowing board-wrap alone left the toolbars stranded at their old full
   width, floating over/past the docked modal). Both are narrowed to end flush at the modal's own
   left edge — an instant resize, not animated.
   (This used to also scroll the board to center the task's own column, but that turned out to be
   an annoying surprise in practice — reopening a task shouldn't yank the board's scroll position —
   so it was removed; only the width narrowing remains.) */
export function fitBoardForTaskModal(){
  if(!window.matchMedia || !window.matchMedia(WIDESCREEN_TASK_DOCK_QUERY).matches) return;
  var header = document.querySelector('.kf-header');
  var mainContent = document.querySelector('.kf-main-content');
  var modalEl = document.querySelector('#taskOverlay .kf-modal');
  if(!header || !mainContent || !modalEl) return;

  var headerRect = header.getBoundingClientRect();
  var mainContentRect = mainContent.getBoundingClientRect();
  var modalRect = modalEl.getBoundingClientRect();

  // Each narrowed to its OWN available space up to the modal's left edge — the header starts at the
  // true left edge of the page, while .kf-main-content starts after the side nav, so they need
  // different target widths to end up flush with each other above/beside the same docked panel.
  var headerWidth = Math.max(200, Math.round(modalRect.left - headerRect.left));
  var mainContentWidth = Math.max(200, Math.round(modalRect.left - mainContentRect.left));
  header.style.width = headerWidth + 'px';
  mainContent.style.flexGrow = '0';
  mainContent.style.flexShrink = '0';
  mainContent.style.flexBasis = mainContentWidth + 'px';
}

function clearBoardInlineSizing(){
  var header = document.querySelector('.kf-header');
  var mainContent = document.querySelector('.kf-main-content');
  if(header) header.style.width = '';
  if(mainContent){
    mainContent.style.flexGrow = '';
    mainContent.style.flexShrink = '';
    mainContent.style.flexBasis = '';
  }
}

/* Undoes fitBoardForTaskModal's inline sizing once the Task modal closes, handing the board back to
   its normal CSS-driven flex:1 width. Harmless no-op if the modal never actually docked (below the
   breakpoint, or fitBoardForTaskModal was never called this session). */
export function restoreBoardAfterTaskModal(){
  clearBoardInlineSizing();
}

/* Called from app.js's window resize handler so dragging the browser across the 2560px threshold —
   or just resizing while already past it — keeps the board correctly narrowed/widened without
   requiring the Task modal to be closed and reopened. A no-op whenever the modal isn't currently
   open. */
export function refitBoardForOpenTaskModal(){
  var overlay = document.getElementById('taskOverlay');
  if(!overlay || overlay.classList.contains('hidden')) return;
  if(!window.matchMedia || !window.matchMedia(WIDESCREEN_TASK_DOCK_QUERY).matches){
    clearBoardInlineSizing();
    return;
  }
  fitBoardForTaskModal();
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

  var header = document.createElement('div');
  header.className = 'kf-column-header';
  header.draggable = true;
  header.innerHTML =
    iconHTML('grip',14) +
    '<span class="kf-column-name' + (col.done ? ' done' : '') + '">' + escapeHTML(col.name) + '</span>' +
    '<span class="kf-count-badge">' + activeTaskCount + '</span>';

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
  var overrun = isTimeTrackingEnabled(project) ? getTaskOverrunStatus(project, task) : null;
  if(overrun) card.classList.add(overrun.level === 'over' ? 'kf-card-over' : 'kf-card-atrisk');

  var metaHTML = '<span class="kf-card-key">' + escapeHTML(task.key) + '</span>';
  if(task.isPrivate){
    metaHTML += '<span class="kf-private-chip" title="Private task">' + iconSvg('lock',12) + '</span>';
  }
  var taskType = getTaskTypeById(project, task.typeId);
  if(taskType && taskType.iconName){
    metaHTML += '<span class="kf-card-type-icon" title="' + escapeHTML(taskType.name) + '">' + iconSvg(taskType.iconName, 13) + '</span>';
  }
  metaHTML += '<span class="kf-priority-pill" style="color:' + prio.color + ';background:' + prio.bg + ';">' + iconSvg(prio.icon,12) + escapeHTML(prio.label) + '</span>';
  if(depCount > 0){
    metaHTML += '<span class="kf-dep-chip" title="Depends on ' + depCount + ' task(s)">' + iconSvg('link',12) + depCount + '</span>';
  }
  if(blocked){
    metaHTML += '<span class="kf-blocked-chip" title="Blocked by unfinished dependencies">' + iconSvg('warning',12) + 'Blocked</span>';
  }
  if(overdue){
    metaHTML += '<span class="kf-overdue-chip" title="End date was ' + escapeHTML(utcISOToLocalDisplayDate(task.endDate)) + '">' + iconSvg('clock',12) + 'Overdue</span>';
  }
  if(isTimeTrackingEnabled(project)){
    var progress = clampProgress(task.progress);
    metaHTML += '<span class="kf-progress-chip" title="Progress: ' + progress + '%">' +
      '<span class="kf-progress-track"><span class="kf-progress-fill" style="width:' + progress + '%;"></span></span>' +
      '<span class="kf-progress-label">' + progress + '%</span>' +
    '</span>';
  }
  if(assignee){
    metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + assignee.color + ';" title="Assigned to ' + escapeHTML(assignee.name) + '">' + escapeHTML(memberInitials(assignee.name)) + '</span>';
  }

  card.innerHTML =
    '<div class="kf-card-title">' + escapeHTML(task.title) + '</div>' +
    '<div class="kf-card-meta">' + metaHTML + '</div>';

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
