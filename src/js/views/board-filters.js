"use strict";
import { PRIORITY_ORDER } from '../config.js';
import { iconSvg } from '../icons.js';
import { escapeHTML, getMemberById, getTaskTypeById, getTeamCommitteeById, getTasksArray, isTaskBlocked, isTaskOverdue } from '../utils.js';
import { getCurrentProject } from '../store.js';
import { ui, getPriority } from '../ui.js';
import { getTeamsCommitteesForMember } from '../mutations.js';
import { normalizeHeaderButtonVisibility } from '../storage.js';
import { renderBoard } from './board.js';
import { getProjectHashtags, filterHashtags, HASHTAG_NAME_RE } from '../features/hashtags.js';

/* =========================================================
   BOARD FILTERS — the priority/team/assignee/task-type filter-chip dropdowns, extracted from
   board.js (ARCHITECTURE-REVIEW.md finding #4, option 1: pure file split, zero behavior change —
   see CLAUDE.md for the two other approaches that were tried and reverted before this one). This is
   the ~350-line chunk the architecture review specifically called out.

   Circular import note: this file calls renderBoard() (every chip toggle ends by re-rendering the
   board with the new filter applied) and board.js calls back into this file's renderers (renderAll,
   applyHeaderButtonVisibility, renderColumn's taskMatchesFilters check) — safe in ES modules because
   every cross-file call here happens inside a function body at runtime, never at module-evaluation
   time; this circularity already existed conceptually inside the single original file, this just
   makes it an explicit module edge instead of an implicit same-file call.
   ========================================================= */

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

/* Status filter — same dropdown-checkbox styling as Assignee/Type, but a fixed two-option
   list (Blocked/Overdue, computed live off each task rather than a stored field) instead of
   one derived from project data, so unlike the other filters it's never hidden even when
   nothing currently matches. */
export var STATUS_FILTER_OPTIONS = [
  {key: 'blocked', label: 'Blocked', icon: 'warning', colorVar: '--kf-blocked-fg'},
  {key: 'overdue', label: 'Overdue', icon: 'clock', colorVar: '--kf-overdue-fg'}
];

export function renderStatusFilterChips(){
  var wrap = document.getElementById('statusFilterWrap');
  var panel = document.getElementById('statusFilterPanel');
  var label = document.getElementById('statusFilterLabel');
  if(!wrap) return;

  var n = ui.activeStatuses.size;
  if(n === 0){
    label.textContent = 'Status';
  } else if(n === 1){
    var onlyKey = ui.activeStatuses.values().next().value;
    var onlyOpt = STATUS_FILTER_OPTIONS.filter(function(o){ return o.key === onlyKey; })[0];
    label.textContent = onlyOpt ? onlyOpt.label : 'Status';
  } else {
    label.textContent = n + ' statuses';
  }
  wrap.classList.toggle('active', n > 0);

  panel.innerHTML = '';
  STATUS_FILTER_OPTIONS.forEach(function(opt){
    var row = document.createElement('label');
    row.className = 'kf-dropdown-filter-row';
    var checked = ui.activeStatuses.has(opt.key);
    row.innerHTML =
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '>' +
      '<span class="kf-dropdown-filter-status-icon" style="color:var(' + opt.colorVar + ');">' + iconSvg(opt.icon, 13) + '</span>' +
      '<span class="kf-dropdown-filter-name">' + escapeHTML(opt.label) + '</span>';
    row.querySelector('input').addEventListener('change', function(e){
      if(e.target.checked) ui.activeStatuses.add(opt.key);
      else ui.activeStatuses.delete(opt.key);
      renderStatusFilterChips();
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
      ui.activeStatuses.clear();
      renderStatusFilterChips();
      renderBoard();
    });
    panel.appendChild(clearBtn);
  }
}

export function toggleStatusFilterPanel(){
  var panel = document.getElementById('statusFilterPanel');
  panel.classList.toggle('hidden');
}
export function closeStatusFilterPanel(){
  document.getElementById('statusFilterPanel').classList.add('hidden');
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
  if(ui.activeStatuses.size > 0){
    // OR semantics across selected statuses (matching Blocked AND Overdue both selected shows
    // a task that's either one, not only tasks that are both), same as every other multi-
    // select filter chip in this toolbar.
    var statusProject = getCurrentProject();
    var matchesAnyStatus =
      (ui.activeStatuses.has('blocked') && isTaskBlocked(statusProject, task)) ||
      (ui.activeStatuses.has('overdue') && isTaskOverdue(statusProject, task));
    if(!matchesAnyStatus) return false;
  }
  if(ui.searchTerm){
    var term = ui.searchTerm.toLowerCase();
    var hay = (task.key + ' ' + task.title + ' ' + (task.description||'')).toLowerCase();
    if(hay.indexOf(term) === -1) return false;
  }
  return true;
}

/* =========================================================
   BOARD SEARCH — the toolbar's "Search tasks..." box: a clear ("x") button once there's a value to
   clear, and a "#" hashtag intellisense dropdown (features/hashtags.js) offering the project's
   existing tags when the search term starts with one. This is purely an input-composition
   convenience, not a new filtering mode — taskMatchesFilters above already does a plain substring
   match against each task's raw description text, and a hashtag is just "#name" text sitting inside
   that description (see hashtags.js's own doc comment), so typing/accepting "#urgent" as the whole
   search term already finds the right tasks with zero changes to the matching logic itself.
   ========================================================= */

var searchHashtagState = null; // {options, activeIndex} - non-null only while the dropdown is open.

export function updateSearchClearButtonVisibility(){
  var input = document.getElementById('searchInput');
  var btn = document.getElementById('searchClearBtn');
  if(!input || !btn) return;
  btn.classList.toggle('kf-vis-hidden', input.value.length === 0);
}

export function clearBoardSearch(){
  var input = document.getElementById('searchInput');
  input.value = '';
  ui.searchTerm = '';
  updateSearchClearButtonVisibility();
  closeSearchHashtagPanel();
  renderBoard();
  input.focus();
}

function renderSearchHashtagPanel(){
  var panel = document.getElementById('searchHashtagPanel');
  panel.innerHTML = searchHashtagState.options.map(function(tag, i){
    return '<div class="kf-dropdown-filter-row' + (i === searchHashtagState.activeIndex ? ' active' : '') + '" data-index="' + i + '">' +
      '<span class="kf-dropdown-filter-name">#' + escapeHTML(tag) + '</span></div>';
  }).join('');
}

/* Only ever triggers when the WHOLE search term starts with "#" (per the ask - "if a user starts a
   search with a hash"), not merely contains one anywhere - a search for "release #urgent" is left as
   plain substring search, unaffected. No "create new" option here unlike the rich-text editor's own
   hashtag intellisense (features/hashtags.js's other consumer) - a search box has nothing to create,
   only existing tags are ever useful to suggest. */
export function updateSearchHashtagIntellisense(){
  var input = document.getElementById('searchInput');
  var panel = document.getElementById('searchHashtagPanel');
  if(!input || !panel) return;
  var value = input.value;
  if(value.charAt(0) !== '#'){ closeSearchHashtagPanel(); return; }

  var prefix = value.slice(1);
  if(prefix && !HASHTAG_NAME_RE.test(prefix)){ closeSearchHashtagPanel(); return; }

  var matches = filterHashtags(getProjectHashtags(getCurrentProject()), prefix);
  if(matches.length === 0){ closeSearchHashtagPanel(); return; }

  searchHashtagState = {options: matches, activeIndex: 0};
  renderSearchHashtagPanel();
  panel.classList.remove('hidden');
}

export function closeSearchHashtagPanel(){
  searchHashtagState = null;
  var panel = document.getElementById('searchHashtagPanel');
  if(panel) panel.classList.add('hidden');
}

export function isSearchHashtagPanelOpen(){
  var panel = document.getElementById('searchHashtagPanel');
  return !!(panel && !panel.classList.contains('hidden'));
}

export function acceptSearchHashtagOption(index){
  if(!searchHashtagState || !searchHashtagState.options[index]) return;
  var input = document.getElementById('searchInput');
  input.value = '#' + searchHashtagState.options[index];
  ui.searchTerm = input.value.trim();
  closeSearchHashtagPanel();
  updateSearchClearButtonVisibility();
  renderBoard();
  input.focus();
}

/* Tab selects the highlighted tag (per the ask), matching the SQL Intellisense convention (§17) this
   whole "Tab accepts, arrows navigate, Escape cancels" shape is drawn from - unlike the rich-text
   editor's own hashtag autocomplete, Space is deliberately NOT an accept key here: a search box is
   plausibly followed by more typed text, so Space needs to stay an ordinary character. */
export function onSearchInputKeydown(e){
  if(!searchHashtagState) return;
  if(e.key === 'ArrowDown'){
    e.preventDefault();
    searchHashtagState.activeIndex = (searchHashtagState.activeIndex + 1) % searchHashtagState.options.length;
    renderSearchHashtagPanel();
  } else if(e.key === 'ArrowUp'){
    e.preventDefault();
    searchHashtagState.activeIndex = (searchHashtagState.activeIndex - 1 + searchHashtagState.options.length) % searchHashtagState.options.length;
    renderSearchHashtagPanel();
  } else if(e.key === 'Tab'){
    e.preventDefault();
    acceptSearchHashtagOption(searchHashtagState.activeIndex);
  } else if(e.key === 'Escape'){
    e.preventDefault();
    e.stopPropagation();
    closeSearchHashtagPanel();
  }
}
