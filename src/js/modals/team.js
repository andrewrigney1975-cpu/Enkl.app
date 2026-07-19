"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { iconSvg } from '../icons.js';
import { escapeHTML, renderBoard, renderAssigneeFilterChips, canCurrentUserManageProject } from '../views/board.js';
import { memberInitials, clampAllocatedFraction } from '../date-utils.js';
import { addMember, renameMember, setMemberRole, setMemberAllocatedFraction, setMemberReportsTo, removeMember, getTeamsCommitteesForMember } from '../mutations.js';
import { getMemberById } from '../utils.js';
import { confirmDialog } from './confirm.js';
import { memberApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { isTimeTrackingEnabled } from '../storage.js';

/* Every PUT here sends the member's full current name/role/reportsToId/allocatedFraction together,
   even though the UI edits them via independent inline inputs — UpdateMemberRequest has no notion of
   "only this one field changed", same shape every other entity's server-authoritative update already
   uses (see modals/task-types.js's combined name+iconName PUT for the same reason). */
function buildServerMemberBody(m, overrides){
  return Object.assign({name: m.name, role: m.role || null, reportsToId: m.reportsToId || null, allocatedFraction: m.allocatedFraction != null ? m.allocatedFraction : null}, overrides || {});
}

/* ---- "Add a team member" combobox — filters the org's whole user roster (fetched once per modal
   open) as you type, tagging any candidate already on this project. Built on the exact same standard
   dropdown/combobox control as the board toolbar's "Search tasks..." box (board-filters.js's
   #searchHashtagPanel): a `.kf-search`-wrapped input with a `.kf-dropdown-filter-panel` sitting below
   it (pure CSS absolute positioning off the wrap's own `position:relative` — no JS-computed
   coordinates needed, unlike the chat mention dropdown's caret-tracking, since this is a single-line
   input with nothing to track), `.kf-dropdown-filter-row`/`.kf-dropdown-filter-name` per candidate,
   and the same "Matching tags" title-row convention (here: "Existing Team Members"). Only meaningful
   for a server-authoritative project — a local-only project has no User/org concept at all (see
   isServerAuthoritative gate below), so the combobox never activates there and the name input stays a
   plain free-text box exactly as before. */
var _orgCandidates = [];
var _addCombobox = null; // {options: [{userId, displayName, email, alreadyMember}], activeIndex} or null when closed

function loadOrgCandidatesForCombobox(project){
  if(!isServerAuthoritative(project)){ _orgCandidates = []; return; }
  memberApi.orgCandidates(project.serverProjectId).then(function(list){
    _orgCandidates = list || [];
  }).catch(function(){ _orgCandidates = []; });
}

function filterOrgCandidates(query){
  var q = query.trim().toLowerCase();
  if(!q) return [];
  var project = getCurrentProject();
  var existingUserIds = (project && project.members || []).map(function(m){ return m.userId; });
  return _orgCandidates
    .filter(function(u){ return u.displayName.toLowerCase().indexOf(q) !== -1; })
    .map(function(u){ return {userId: u.id, displayName: u.displayName, email: u.email, alreadyMember: existingUserIds.indexOf(u.id) !== -1}; })
    .slice(0, 8);
}

function renderAddMemberDropdown(){
  var dropdown = document.getElementById('newMemberNameDropdown');
  var input = document.getElementById('newMemberNameInput');
  if(!dropdown || !input) return;
  if(!_addCombobox || _addCombobox.options.length === 0){
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  // Same title styling as the search box's "Matching tags"/"Matching Archived Tasks" panels
  // (kf-search-archived-matches-title) for visual consistency across every dropdown built on this
  // standard control.
  dropdown.innerHTML = '<div class="kf-search-archived-matches-title">Existing Team Members</div>' +
    _addCombobox.options.map(function(opt, i){
      return '<div class="kf-dropdown-filter-row' + (i === _addCombobox.activeIndex ? ' active' : '') + '" role="option" data-index="' + i + '">' +
        '<span class="kf-dropdown-filter-name">' + escapeHTML(opt.displayName) + '</span>' +
        (opt.alreadyMember ? '<span class="kf-search-archived-badge">On team</span>' : '') +
        '</div>';
    }).join('');
  dropdown.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function closeAddMemberDropdown(){
  _addCombobox = null;
  renderAddMemberDropdown();
}

function selectAddMemberCandidate(index){
  if(!_addCombobox || !_addCombobox.options[index]) return;
  var opt = _addCombobox.options[index];
  document.getElementById('newMemberNameInput').value = opt.displayName;
  var emailInput = document.getElementById('newMemberEmailInput');
  if(emailInput) emailInput.value = opt.email || '';
  closeAddMemberDropdown();
}

export function wireAddMemberCombobox(){
  var input = document.getElementById('newMemberNameInput');
  var dropdown = document.getElementById('newMemberNameDropdown');
  input.addEventListener('input', function(){
    var options = filterOrgCandidates(input.value);
    _addCombobox = options.length > 0 ? {options: options, activeIndex: 0} : null;
    renderAddMemberDropdown();
  });
  input.addEventListener('keydown', function(e){
    if(_addCombobox){
      if(e.key === 'ArrowDown'){
        e.preventDefault();
        _addCombobox.activeIndex = (_addCombobox.activeIndex + 1) % _addCombobox.options.length;
        renderAddMemberDropdown();
        return;
      }
      if(e.key === 'ArrowUp'){
        e.preventDefault();
        _addCombobox.activeIndex = (_addCombobox.activeIndex - 1 + _addCombobox.options.length) % _addCombobox.options.length;
        renderAddMemberDropdown();
        return;
      }
      if(e.key === 'Tab'){
        selectAddMemberCandidate(_addCombobox.activeIndex);
        return;
      }
      if(e.key === 'Escape'){
        e.preventDefault();
        e.stopPropagation();
        closeAddMemberDropdown();
        return;
      }
      if(e.key === 'Enter'){
        e.preventDefault();
        selectAddMemberCandidate(_addCombobox.activeIndex);
        return;
      }
    }
    if(e.key === 'Enter'){ e.preventDefault(); addMemberFromModal(); }
  });
  // A short delay so a mousedown on a dropdown option below still registers before blur closes it —
  // same convention the chat mention dropdown uses.
  input.addEventListener('blur', function(){ setTimeout(closeAddMemberDropdown, 150); });
  dropdown.addEventListener('mousedown', function(e){
    var option = e.target.closest('[data-index]');
    if(!option) return;
    e.preventDefault();
    selectAddMemberCandidate(parseInt(option.getAttribute('data-index'), 10));
    input.focus();
  });
}

export function openTeamModal(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  renderMemberList();
  document.getElementById('newMemberNameInput').value = '';
  closeAddMemberDropdown();
  loadOrgCandidatesForCombobox(project);
  var emailInput = document.getElementById('newMemberEmailInput');
  emailInput.value = '';
  // Only a server-authoritative project's "add" silently creates a real User account behind the
  // scenes (see MemberService.CreateAsync) — that's the only case an email is required or even
  // shown; a local-only project's members are plain objects with no account concept.
  emailInput.classList.toggle('hidden', !isServerAuthoritative(project));
  // "Manage team members" is a Project Administrator capability once a project is server-authoritative
  // — a plain member still opens this modal to SEE the team (and, further down, gets read-only rows
  // instead of the add-member form below), just can't add/edit/remove anyone.
  document.getElementById('addMemberField').classList.toggle('hidden', !canCurrentUserManageProject());
  document.getElementById('teamOverlay').classList.remove('hidden');
  document.getElementById('newMemberNameInput').focus();
}
export function closeTeamModal(){
  closeAddMemberDropdown();
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
  var timeTrackingOn = isTimeTrackingEnabled(project);
  // "Manage team members" is a Project Administrator capability once server-authoritative — a plain
  // member sees the same list read-only (disabled inputs, no remove button, no admin toggle) rather
  // than the row being hidden outright, so they can still see who's on the project and who's an admin.
  var canManage = canCurrentUserManageProject();
  var disabledAttr = canManage ? '' : ' disabled';
  project.members.forEach(function(m){
    var row = document.createElement('div');
    row.className = 'kf-member-row';
    row.setAttribute('data-member-id', m.id);
    row.innerHTML =
      '<span class="kf-avatar kf-avatar-md" style="background:' + m.color + ';">' + escapeHTML(memberInitials(m.name)) + '</span>' +
      '<input type="text" class="kf-member-name-input" value="' + escapeHTML(m.name) + '" maxlength="60" aria-label="Member name"' + disabledAttr + '>' +
      '<input type="text" class="kf-member-role-input" value="' + escapeHTML(m.role || '') + '" maxlength="60" list="memberRoleOptions" placeholder="Role" aria-label="Member role"' + disabledAttr + '>' +
      (timeTrackingOn
        ? '<input type="number" class="kf-member-allocated-fraction-input" min="0" max="100" step="1" value="' + (m.allocatedFraction != null ? m.allocatedFraction : '') + '" placeholder="%" title="Allocated fraction" aria-label="' + escapeHTML(m.name) + ' allocated fraction"' + disabledAttr + '>'
        : '') +
      (isServerAuthoritative(project)
        ? '<label class="kf-member-admin-toggle" title="Project Administrator: can manage columns, app settings, workflow, and team members">' +
            '<input type="checkbox" class="kf-member-admin-checkbox"' + (m.isProjectAdmin ? ' checked' : '') + disabledAttr + ' aria-label="' + escapeHTML(m.name) + ' is Project Administrator">Admin</label>'
        : '') +
      (canManage ? '<button class="kf-btn kf-btn-ghost" data-action="remove-member" title="Remove from project">' + iconSvg('trash',14) + '</button>' : '');
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
    var allocatedFractionInput = row.querySelector('.kf-member-allocated-fraction-input');
    if(allocatedFractionInput){
      allocatedFractionInput.addEventListener('change', async function(){
        var clamped = clampAllocatedFraction(allocatedFractionInput.value);
        if(isServerAuthoritative(project)){
          try {
            await memberApi.update(project.serverProjectId, m.id, buildServerMemberBody(m, {allocatedFraction: clamped}));
            await refreshProjectFromServer(project.id);
            renderMemberList();
          } catch(e){
            toast('Could not update allocated fraction on the server: ' + (e.message || 'unknown error'));
          }
          return;
        }
        setMemberAllocatedFraction(project, m.id, clamped);
        renderMemberList();
      });
    }
    var removeBtn = row.querySelector('[data-action="remove-member"]');
    if(removeBtn){
      removeBtn.addEventListener('click', function(){
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
    }
    // "The project admin role can be assigned to users via the Team management tool" — server-only
    // (no local-project equivalent, see the isServerAuthoritative check the checkbox's own markup
    // above is gated on) and Project-Admin-gated (MemberService.SetProjectAdminAsync's last-admin
    // guard rejects demoting the only remaining admin — surfaced as a toast, same error-handling
    // shape as every other server action in this row).
    var adminCheckbox = row.querySelector('.kf-member-admin-checkbox');
    if(adminCheckbox){
      adminCheckbox.addEventListener('change', async function(){
        var nextValue = adminCheckbox.checked;
        try {
          await memberApi.setProjectAdmin(project.serverProjectId, m.id, nextValue);
          await refreshProjectFromServer(project.id);
          renderMemberList();
        } catch(e){
          adminCheckbox.checked = !nextValue;
          toast('Could not update Project Administrator status: ' + (e.message || 'unknown error'));
        }
      });
    }
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
      '<select id="reportsTo-' + m.id + '" class="kf-member-reportsto-select" aria-label="' + escapeHTML(m.name) + ' reports to"' + disabledAttr + '>' + optionsHTML + '</select>';
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
      closeAddMemberDropdown();
      loadOrgCandidatesForCombobox(project);
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
  closeAddMemberDropdown();
  renderMemberList();
  renderAssigneeFilterChips();
  input.focus();
}
