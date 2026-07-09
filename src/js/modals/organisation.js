"use strict";
import { toast } from '../ui.js';
import { escapeHTML, renderBoard, renderAssigneeFilterChips } from '../views/board.js';
import { getMyOrganisationApi, createOrgUserApi, setOrgUserAdminApi, isOrgAdmin, memberApi } from '../api.js';
import { getCurrentProject } from '../store.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';

/* Org-level user administration — distinct from modals/team.js's "Add team member", which creates a
   User account implicitly (as a side effect of project membership) with a fixed default password.
   Here an OrgAdmin explicitly creates an account with a username and a password they choose, and the
   new user must change it on first login (User.MustChangePassword, set true server-side same as
   every other account-creation path). This manages the whole Organisation's user list
   (OrganisationsController), gated server-side by the OrgAdmin policy — but a User with no
   ProjectMember row anywhere wouldn't show up in any project's Team list, which defeats the point of
   creating them, so createOrgUserFromModal below also adds them to the currently open project (if
   it's server-authoritative) right after. */

export function openOrgUsersModal(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can manage users.'); return; }
  document.getElementById('newOrgUserUsernameInput').value = '';
  document.getElementById('newOrgUserDisplayNameInput').value = '';
  document.getElementById('newOrgUserPasswordInput').value = '';
  renderOrgUsersList();
  document.getElementById('orgUsersOverlay').classList.remove('hidden');
  document.getElementById('newOrgUserUsernameInput').focus();
}
export function closeOrgUsersModal(){
  document.getElementById('orgUsersOverlay').classList.add('hidden');
}

export function renderOrgUsersList(){
  var listEl = document.getElementById('orgUsersList');
  listEl.innerHTML = '<div class="kf-member-empty">Loading…</div>';
  getMyOrganisationApi().then(function(org){
    if(!org.users || org.users.length === 0){
      listEl.innerHTML = '<div class="kf-member-empty">No users yet.</div>';
      return;
    }
    listEl.innerHTML = '';
    org.users.slice().sort(function(a, b){ return a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'}); }).forEach(function(u){
      var row = document.createElement('div');
      row.className = 'kf-member-row kf-orguser-row';
      row.innerHTML =
        '<div class="kf-orguser-row-name">' +
          '<div class="kf-orguser-display-name">' + escapeHTML(u.displayName) + '</div>' +
          '<div class="kf-orguser-username">@' + escapeHTML(u.username) + '</div>' +
        '</div>' +
        '<label class="kf-orguser-admin-toggle">' +
          '<input type="checkbox"' + (u.isOrgAdmin ? ' checked' : '') + '>Admin' +
        '</label>';
      var adminCheckbox = row.querySelector('input[type=checkbox]');
      adminCheckbox.addEventListener('change', function(){
        var nextValue = adminCheckbox.checked;
        setOrgUserAdminApi(u.id, nextValue).catch(function(e){
          adminCheckbox.checked = !nextValue;
          toast('Could not update admin status: ' + (e.message || 'unknown error'));
        });
      });
      listEl.appendChild(row);
    });
  }, function(e){
    listEl.innerHTML = '<div class="kf-member-empty">Could not load users.</div>';
    toast('Could not load organisation users: ' + (e.message || 'unknown error'));
  });
}

export function createOrgUserFromModal(){
  var usernameInput = document.getElementById('newOrgUserUsernameInput');
  var displayNameInput = document.getElementById('newOrgUserDisplayNameInput');
  var passwordInput = document.getElementById('newOrgUserPasswordInput');

  var username = usernameInput.value.trim();
  var displayName = displayNameInput.value.trim();
  var password = passwordInput.value;

  if(!username){ toast('Please enter a username.'); return; }
  if(!displayName){ toast('Please enter a display name.'); return; }
  if(!password || password.length < 8){ toast('Password must be at least 8 characters.'); return; }

  createOrgUserApi(username, displayName, password).then(function(){
    usernameInput.value = '';
    displayNameInput.value = '';
    passwordInput.value = '';
    renderOrgUsersList();

    var project = getCurrentProject();
    if(!isServerAuthoritative(project)){
      toast('User "' + displayName + '" created. They must change this password on first login.');
      return;
    }

    // Search by username, not displayName — MemberService.CreateAsync dedups by normalizing
    // whatever name it's given and matching it against the User's NormalizedUsername (itself derived
    // from Username, not DisplayName). Searching by displayName here would only coincidentally match
    // when the two happen to normalize the same way, and silently create a SECOND duplicate account
    // for this same person otherwise.
    memberApi.create(project.serverProjectId, {name: username}).then(function(){
      return refreshProjectFromServer(project.id);
    }).then(function(){
      renderBoard();
      renderAssigneeFilterChips();
      toast('User "' + displayName + '" created and added to "' + project.name + '". They must change this password on first login.');
    }, function(e){
      toast('User "' + displayName + '" created, but could not add them to "' + project.name + '": ' + (e.message || 'unknown error'));
    });
  }, function(e){
    toast('Could not create user: ' + (e.message || 'unknown error'));
  });
}
