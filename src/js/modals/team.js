"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { iconSvg } from '../icons.js';
import { escapeHTML, renderBoard, renderAssigneeFilterChips } from '../views/board.js';
import { memberInitials } from '../date-utils.js';
import { addMember, renameMember, setMemberRole, setMemberReportsTo, removeMember, getTeamsCommitteesForMember } from '../mutations.js';
import { getMemberById } from '../utils.js';
import { confirmDialog } from './confirm.js';
import { memberApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';

/* Every PUT here sends the member's full current name/role/reportsToId together, even though the UI
   edits them via three independent inline inputs — UpdateMemberRequest has no notion of "only this
   one field changed", same shape every other entity's server-authoritative update already uses (see
   modals/task-types.js's combined name+iconName PUT for the same reason). */
function buildServerMemberBody(m, overrides){
  return Object.assign({name: m.name, role: m.role || null, reportsToId: m.reportsToId || null}, overrides || {});
}

export function openTeamModal(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  renderMemberList();
  document.getElementById('newMemberNameInput').value = '';
  var emailInput = document.getElementById('newMemberEmailInput');
  emailInput.value = '';
  // Only a server-authoritative project's "add" silently creates a real User account behind the
  // scenes (see MemberService.CreateAsync) — that's the only case an email is required or even
  // shown; a local-only project's members are plain objects with no account concept.
  emailInput.classList.toggle('hidden', !isServerAuthoritative(project));
  document.getElementById('teamOverlay').classList.remove('hidden');
  document.getElementById('newMemberNameInput').focus();
}
export function closeTeamModal(){
  document.getElementById('teamOverlay').classList.add('hidden');
}

export function populateVocabularyDatalist(datalistId, values){
  var list = document.getElementById(datalistId);
  list.innerHTML = '';
  (values || []).slice().sort(function(a, b){ return a.localeCompare(b, undefined, {sensitivity:'base'}); }).forEach(function(name){
    var opt = document.createElement('option');
    opt.value = name;
    list.appendChild(opt);
  });
}

export function populateRoleOptions(project){
  populateVocabularyDatalist('memberRoleOptions', project.roles);
}

export function renderMemberList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('memberList');
  listEl.innerHTML = '';
  if(!project || !project.members || project.members.length === 0){
    listEl.innerHTML = '<div class="kf-member-empty">No team members yet. Add one above.</div>';
    return;
  }
  populateRoleOptions(project);
  project.members.forEach(function(m){
    var row = document.createElement('div');
    row.className = 'kf-member-row';
    row.setAttribute('data-member-id', m.id);
    row.innerHTML =
      '<span class="kf-avatar kf-avatar-md" style="background:' + m.color + ';">' + escapeHTML(memberInitials(m.name)) + '</span>' +
      '<input type="text" class="kf-member-name-input" value="' + escapeHTML(m.name) + '" maxlength="60" aria-label="Member name">' +
      '<input type="text" class="kf-member-role-input" value="' + escapeHTML(m.role || '') + '" maxlength="60" list="memberRoleOptions" placeholder="Role" aria-label="Member role">' +
      '<button class="kf-btn kf-btn-ghost" data-action="remove-member" title="Remove from project">' + iconSvg('trash',14) + '</button>';
    var nameInput = row.querySelector('.kf-member-name-input');
    nameInput.addEventListener('change', async function(){
      if(isServerAuthoritative(project)){
        try {
          await memberApi.update(project.serverProjectId, m.id, buildServerMemberBody(m, {name: nameInput.value}));
          await refreshProjectFromServer(project.id);
          renderMemberList();
          renderBoard();
        } catch(e){
          toast('Could not rename team member on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      renameMember(project, m.id, nameInput.value);
      renderMemberList();
      renderBoard();
    });
    var roleInput = row.querySelector('.kf-member-role-input');
    roleInput.addEventListener('change', async function(){
      if(isServerAuthoritative(project)){
        try {
          await memberApi.update(project.serverProjectId, m.id, buildServerMemberBody(m, {role: roleInput.value}));
          await refreshProjectFromServer(project.id);
          renderMemberList();
        } catch(e){
          toast('Could not update role on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      setMemberRole(project, m.id, roleInput.value);
      renderMemberList();
    });
    row.querySelector('[data-action="remove-member"]').addEventListener('click', function(){
      confirmDialog(
        'Remove ' + m.name + '?',
        'They will be unassigned from any tickets currently assigned to them.',
        async function(){
          if(isServerAuthoritative(project)){
            try {
              await memberApi.remove(project.serverProjectId, m.id);
              await refreshProjectFromServer(project.id);
              renderMemberList();
              renderBoard();
              renderAssigneeFilterChips();
              toast('Removed ' + m.name + '.');
            } catch(e){
              toast('Could not remove team member on the server: ' + (e.message || 'unknown error'));
            }
            return;
          }
          var unassigned = removeMember(project, m.id);
          renderMemberList();
          renderBoard();
          renderAssigneeFilterChips();
          toast('Removed ' + m.name + (unassigned > 0 ? ' — unassigned from ' + unassigned + ' task(s).' : '.'));
        }
      );
    });
    listEl.appendChild(row);

    var reportsToRow = document.createElement('div');
    reportsToRow.className = 'kf-member-reportsto-row';
    var otherMembers = project.members.filter(function(other){ return other.id !== m.id; })
      .sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
    var optionsHTML = '<option value="">No one</option>' + otherMembers.map(function(other){
      return '<option value="' + other.id + '"' + (m.reportsToId === other.id ? ' selected' : '') + '>' + escapeHTML(other.name) + '</option>';
    }).join('');
    reportsToRow.innerHTML =
      '<label for="reportsTo-' + m.id + '">Reports to</label>' +
      '<select id="reportsTo-' + m.id + '" class="kf-member-reportsto-select" aria-label="' + escapeHTML(m.name) + ' reports to">' + optionsHTML + '</select>';
    var reportsToSelect = reportsToRow.querySelector('select');
    reportsToSelect.addEventListener('change', async function(){
      if(isServerAuthoritative(project)){
        try {
          await memberApi.update(project.serverProjectId, m.id, buildServerMemberBody(m, {reportsToId: reportsToSelect.value || null}));
          await refreshProjectFromServer(project.id);
          renderMemberList();
        } catch(e){
          toast('Could not update reports-to on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      setMemberReportsTo(project, m.id, reportsToSelect.value || null);
      renderMemberList();
    });
    listEl.appendChild(reportsToRow);

    var memberTeams = getTeamsCommitteesForMember(project, m.id);
    if(memberTeams.length > 0){
      var teamsLine = document.createElement('div');
      teamsLine.className = 'kf-member-teams-line';
      teamsLine.textContent = 'Member of: ' + memberTeams.map(function(tc){ return tc.name; }).join(', ');
      listEl.appendChild(teamsLine);
    }
  });
}

export async function addMemberFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var input = document.getElementById('newMemberNameInput');
  var name = input.value.trim();
  if(!name){ toast('Please enter a name.'); return; }

  if(isServerAuthoritative(project)){
    var emailInput = document.getElementById('newMemberEmailInput');
    var email = emailInput.value.trim();
    // A server-authoritative "add" silently creates a real User account (see
    // MemberService.CreateAsync) unless the name matches one already in this Organisation, so an
    // email is required here the same way it is on the explicit "Manage Users" form — this client
    // can't tell ahead of time whether it'll match or create, so it always asks.
    if(!email){ toast('Please enter an email address.'); return; }
    try {
      await memberApi.create(project.serverProjectId, {name: name, email: email});
      await refreshProjectFromServer(project.id);
      input.value = '';
      emailInput.value = '';
      renderMemberList();
      renderAssigneeFilterChips();
      input.focus();
    } catch(e){
      toast('Could not add team member on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  addMember(project, name);
  input.value = '';
  renderMemberList();
  renderAssigneeFilterChips();
  input.focus();
}
