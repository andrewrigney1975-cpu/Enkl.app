"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg } from '../icons.js';
import { memberInitials, utcISOToLocalDisplayDate } from '../date-utils.js';
import { getTeamCommitteeById, getMemberById } from '../utils.js';
import { TEAM_COMMITTEE_TYPES } from '../config.js';
import { addTeamCommittee, updateTeamCommittee, deleteTeamCommittee, buildTeamCommitteeTree, getTeamCommitteeChildren, isTeamCommitteeAncestor } from '../mutations.js';
import { renderMemberPickerInto, getCheckedItemIdsFrom } from './pickers.js';
import { confirmDialog } from './confirm.js';

export function openTeamsCommitteesOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.tcSearchTerm = '';
  document.getElementById('teamsCommitteesSearchInput').value = '';
  ui.tcCollapsedIds = new Set();
  showTeamsCommitteesListView();
  document.getElementById('teamsCommitteesOverlay').classList.remove('hidden');
}
export function closeTeamsCommitteesOverlay(){
  document.getElementById('teamsCommitteesOverlay').classList.add('hidden');
}
export function isTeamsCommitteesOverlayOpen(){
  return !document.getElementById('teamsCommitteesOverlay').classList.contains('hidden');
}

export function showTeamsCommitteesListView(){
  ui.editingTeamCommitteeId = null;
  document.getElementById('teamsCommitteesModalTitle').textContent = 'Teams & Committees';
  document.getElementById('teamsCommitteesListView').classList.remove('hidden');
  document.getElementById('teamsCommitteesFormView').classList.add('hidden');
  document.getElementById('teamsCommitteesListFooter').classList.remove('hidden');
  document.getElementById('teamsCommitteesFormFooter').classList.add('hidden');
  renderTeamsCommitteesList();
}

export function renderTeamsCommitteesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('teamsCommitteesList');
  listEl.innerHTML = '';
  if(!project) return;

  var all = project.teamsCommittees || [];
  if(all.length === 0){
    listEl.innerHTML = '<div class="kf-tc-empty">No teams or committees yet. Add one above to start mapping your org structure.</div>';
    return;
  }

  var flat = buildTeamCommitteeTree(project);
  var term = ui.tcSearchTerm.trim().toLowerCase();

  var visibleIds = null;
  if(term){
    visibleIds = {};
    flat.forEach(function(entry){
      var hay = (entry.node.name + ' ' + (entry.node.description || '')).toLowerCase();
      if(hay.indexOf(term) === -1) return;
      var current = entry.node;
      visibleIds[current.id] = true;
      while(current.parentId){
        visibleIds[current.parentId] = true;
        current = getTeamCommitteeById(project, current.parentId);
      }
    });
    if(Object.keys(visibleIds).length === 0){
      listEl.innerHTML = '<div class="kf-tc-empty">No teams or committees match “' + escapeHTML(ui.tcSearchTerm.trim()) + '”.</div>';
      return;
    }
  }

  var html = '';
  flat.forEach(function(entry){
    var node = entry.node, depth = entry.depth;
    if(visibleIds && !visibleIds[node.id]) return;

    if(!term){
      var current = node, hiddenByCollapse = false;
      while(current.parentId){
        var parent = getTeamCommitteeById(project, current.parentId);
        if(parent && ui.tcCollapsedIds.has(parent.id)){ hiddenByCollapse = true; break; }
        current = parent;
      }
      if(hiddenByCollapse) return;
    }

    var hasChildren = getTeamCommitteeChildren(project, node.id).length > 0;
    var isExpanded = term ? true : !ui.tcCollapsedIds.has(node.id);
    var members = (node.memberIds || []).map(function(id){ return getMemberById(project, id); }).filter(Boolean)
      .sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });

    var toggleHTML = hasChildren
      ? '<button class="kf-tc-toggle-btn" data-tc-toggle-id="' + node.id + '" aria-label="' + (isExpanded ? 'Collapse' : 'Expand') + '">' + iconSvg(isExpanded ? 'chevronDown' : 'chevronRight', 14) + '</button>'
      : '<span class="kf-tc-toggle-spacer"></span>';

    html += '<div class="kf-tc-node-row" data-tc-id="' + node.id + '" style="padding-left:' + (8 + depth * 20) + 'px;">' +
      toggleHTML +
      '<span class="kf-decision-type-pill">' + escapeHTML(TEAM_COMMITTEE_TYPES[node.type]) + '</span>' +
      '<span class="kf-tc-name">' + escapeHTML(node.name) + '</span>' +
      '<span class="kf-tc-member-count">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span>' +
    '</div>';

    if(isExpanded && members.length > 0){
      html += '<div class="kf-tc-member-list" style="padding-left:' + (8 + (depth + 1) * 20 + 18) + 'px;">' +
        members.map(function(m){
          return '<div class="kf-tc-member-item"><span class="kf-avatar kf-avatar-sm" style="background:' + m.color + ';">' + escapeHTML(memberInitials(m.name)) + '</span>' + escapeHTML(m.name) + (m.role ? ' <span class="kf-health-top-member-role">' + escapeHTML(m.role) + '</span>' : '') + '</div>';
        }).join('') +
      '</div>';
    }
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('[data-tc-toggle-id]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var id = btn.getAttribute('data-tc-toggle-id');
      if(ui.tcCollapsedIds.has(id)) ui.tcCollapsedIds.delete(id); else ui.tcCollapsedIds.add(id);
      renderTeamsCommitteesList();
    });
  });
  listEl.querySelectorAll('.kf-tc-node-row').forEach(function(row){
    row.addEventListener('click', function(){ showTeamCommitteeFormView(row.getAttribute('data-tc-id')); });
  });
}

function populateTcParentSelect(project, excludeId){
  var select = document.getElementById('tcParentSelect');
  select.innerHTML = '<option value="">No parent (top level)</option>';
  var flat = buildTeamCommitteeTree(project);
  flat.forEach(function(entry){
    if(entry.node.id === excludeId) return;
    if(excludeId && isTeamCommitteeAncestor(project, excludeId, entry.node.id)) return;
    var opt = document.createElement('option');
    opt.value = entry.node.id;
    opt.textContent = '  '.repeat(entry.depth) + entry.node.name;
    select.appendChild(opt);
  });
}

export function showTeamCommitteeFormView(id){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingTeamCommitteeId = id || null;
  var tc = id ? getTeamCommitteeById(project, id) : null;

  document.getElementById('teamsCommitteesModalTitle').textContent = tc ? 'Edit Team / Committee' : 'New Team / Committee';
  document.getElementById('teamsCommitteesListView').classList.add('hidden');
  document.getElementById('teamsCommitteesFormView').classList.remove('hidden');
  document.getElementById('teamsCommitteesListFooter').classList.add('hidden');
  document.getElementById('teamsCommitteesFormFooter').classList.remove('hidden');
  document.getElementById('deleteTeamCommitteeBtn').classList.toggle('hidden', !tc);

  document.getElementById('tcNameInput').value = tc ? tc.name : '';
  document.getElementById('tcDescriptionInput').value = tc ? tc.description : '';
  document.getElementById('tcTypeSelect').value = tc ? tc.type : 'team';
  populateTcParentSelect(project, tc ? tc.id : null);
  document.getElementById('tcParentSelect').value = tc && tc.parentId ? tc.parentId : '';
  renderMemberPickerInto('tcMemberPicker', project.members || [], tc ? tc.memberIds : []);

  var metaEl = document.getElementById('tcMetaDates');
  if(tc){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(tc.dateCreated) +
      (tc.dateLastModified && tc.dateLastModified !== tc.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(tc.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('tcNameInput').focus();
}

export function saveTeamCommitteeFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var name = document.getElementById('tcNameInput').value.trim();
  if(!name){ toast('Please enter a name.'); return; }

  var data = {
    name: name,
    description: document.getElementById('tcDescriptionInput').value,
    type: document.getElementById('tcTypeSelect').value,
    parentId: document.getElementById('tcParentSelect').value || null,
    memberIds: getCheckedItemIdsFrom('tcMemberPicker')
  };

  if(ui.editingTeamCommitteeId){
    var result = updateTeamCommittee(project, ui.editingTeamCommitteeId, data);
    if(!result.ok){
      toast('Could not set that parent — it would create a circular hierarchy.');
      return;
    }
    toast('Saved.');
  } else {
    addTeamCommittee(project, data);
    toast('Created.');
  }
  showTeamsCommitteesListView();
}

export function deleteTeamCommitteeFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingTeamCommitteeId) return;
  var tc = getTeamCommitteeById(project, ui.editingTeamCommitteeId);
  if(!tc) return;
  confirmDialog(
    'Delete ' + tc.name + '?',
    'Any child teams/committees will be promoted to top level rather than deleted.',
    function(){
      var result = deleteTeamCommittee(project, tc.id);
      toast('Deleted ' + tc.name + (result.orphanedCount > 0 ? ' — ' + result.orphanedCount + ' child team(s) moved to top level.' : '.'));
      showTeamsCommitteesListView();
    }
  );
}
