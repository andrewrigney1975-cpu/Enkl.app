"use strict";
import { PRIORITY_ORDER } from '../config.js';
import { iconSvg } from '../icons.js';
import { escapeHTML, getMemberById, getTaskTypeById, getTeamCommitteeById, getTasksArray } from '../utils.js';
import { getCurrentProject } from '../store.js';
import { ui, getPriority } from '../ui.js';
import { getTeamsCommitteesForMember } from '../mutations.js';
import { normalizeHeaderButtonVisibility } from '../storage.js';
import { renderBoard } from './board.js';

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
