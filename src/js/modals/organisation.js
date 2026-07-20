"use strict";
import { toast } from '../ui.js';
import { escapeHTML, renderBoard, renderAssigneeFilterChips } from '../views/board.js';
import { getMyOrganisationApi, createOrgUserApi, setOrgUserAdminApi, setOrgUserEmailApi, setOrgDefaultPasswordApi, deactivateOrgUserApi, isOrgAdmin, getCurrentUserId, memberApi } from '../api.js';
import { getCurrentProject } from '../store.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { confirmDialog } from './confirm.js';

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
  document.getElementById('newOrgUserEmailInput').value = '';
  document.getElementById('newOrgUserPasswordInput').value = '';
  document.getElementById('orgDefaultPasswordInput').value = '';
  renderOrgUsersList();
  document.getElementById('orgUsersOverlay').classList.remove('hidden');
  document.getElementById('newOrgUserUsernameInput').focus();
}
export function closeOrgUsersModal(){
  document.getElementById('orgUsersOverlay').classList.add('hidden');
}

// Simple format guard mirroring EmailAddressNormalizer.IsValidFormat server-side — not full RFC
// 5322, just enough to catch obviously-wrong input before a round trip to the server.
var SIMPLE_EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function renderOrgUsersList(){
  var listEl = document.getElementById('orgUsersList');
  listEl.innerHTML = '<div class="kf-member-empty">Loading…</div>';
  var statusEl = document.getElementById('orgDefaultPasswordStatus');
  statusEl.textContent = 'Loading…';
  getMyOrganisationApi().then(function(org){
    statusEl.textContent = org.hasCustomDefaultPassword
      ? 'A custom default password is currently set for this organisation.'
      : 'Using the system default password — no custom one has been set for this organisation.';
    if(!org.users || org.users.length === 0){
      listEl.innerHTML = '<div class="kf-member-empty">No users yet.</div>';
      return;
    }
    listEl.innerHTML = '';
    var callerId = getCurrentUserId();
    org.users.slice().sort(function(a, b){ return a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'}); }).forEach(function(u){
      var isInactive = u.isActive === false;
      var row = document.createElement('div');
      row.className = 'kf-member-row kf-orguser-row' + (isInactive ? ' kf-orguser-row-inactive' : '');
      row.innerHTML =
        '<div class="kf-orguser-row-name">' +
          '<div class="kf-orguser-display-name">' + escapeHTML(u.displayName) +
            (isInactive ? ' <span class="kf-orguser-inactive-badge">(Inactive)</span>' : '') +
          '</div>' +
          '<div class="kf-orguser-username">@' + escapeHTML(u.username) + '</div>' +
        '</div>' +
        (u.emailAddress
          ? '<div class="kf-orguser-email">' + escapeHTML(u.emailAddress) + '</div>'
          : '<div class="kf-orguser-email kf-orguser-email-missing">' +
              '<span class="kf-orguser-email-warning" title="No email on file — required for SAML sign-in.">No email</span>' +
              '<input type="email" class="kf-orguser-email-backfill-input" maxlength="320" placeholder="Add email address">' +
              '<button class="kf-btn kf-btn-ghost" data-action="save-email">Save</button>' +
            '</div>') +
        '<label class="kf-orguser-admin-toggle">' +
          '<input type="checkbox"' + (u.isOrgAdmin ? ' checked' : '') + (isInactive ? ' disabled' : '') + '>Admin' +
        '</label>' +
        (isInactive || u.id === callerId
          ? ''
          : '<button class="kf-btn kf-btn-ghost kf-orguser-deactivate-btn" data-action="deactivate" title="Deactivate this user — they will be signed out and can no longer log in">Deactivate</button>');
      var adminCheckbox = row.querySelector('input[type=checkbox]');
      adminCheckbox.addEventListener('change', function(){
        var nextValue = adminCheckbox.checked;
        setOrgUserAdminApi(u.id, nextValue).catch(function(e){
          adminCheckbox.checked = !nextValue;
          toast('Could not update admin status: ' + (e.message || 'unknown error'));
        });
      });
      var saveEmailBtn = row.querySelector('[data-action="save-email"]');
      if(saveEmailBtn){
        saveEmailBtn.addEventListener('click', function(){
          var emailInput = row.querySelector('.kf-orguser-email-backfill-input');
          var email = emailInput.value.trim();
          if(!email || !SIMPLE_EMAIL_SHAPE.test(email)){ toast('Please enter a valid email address.'); return; }
          setOrgUserEmailApi(u.id, email).then(function(){
            renderOrgUsersList();
          }, function(e){
            toast('Could not save email address: ' + (e.message || 'unknown error'));
          });
        });
      }
      var deactivateBtn = row.querySelector('[data-action="deactivate"]');
      if(deactivateBtn){
        deactivateBtn.addEventListener('click', function(){
          confirmDialog(
            'Deactivate ' + u.displayName + '?',
            'They will be signed out immediately and can no longer log in. Any tasks assigned to them, ' +
            'or governance items they own, will keep showing their name marked "(Inactive)" — you can ' +
            'reassign those manually afterwards. This cannot be undone from this screen.',
            function(){
              deactivateOrgUserApi(u.id).then(function(){
                toast('"' + u.displayName + '" has been deactivated.');
                renderOrgUsersList();
              }, function(e){
                toast('Could not deactivate user: ' + (e.message || 'unknown error'));
              });
            }
          );
        });
      }
      listEl.appendChild(row);
    });
  }, function(e){
    listEl.innerHTML = '<div class="kf-member-empty">Could not load users.</div>';
    statusEl.textContent = '';
    toast('Could not load organisation users: ' + (e.message || 'unknown error'));
  });
}

export function saveOrgDefaultPasswordFromModal(){
  var passwordInput = document.getElementById('orgDefaultPasswordInput');
  var password = passwordInput.value;
  if(!password || password.length < 8){ toast('Password must be at least 8 characters.'); return; }

  setOrgDefaultPasswordApi(password).then(function(){
    passwordInput.value = '';
    toast('Default password updated. It applies to accounts created from now on.');
    renderOrgUsersList();
  }, function(e){
    toast('Could not update default password: ' + (e.message || 'unknown error'));
  });
}

export function createOrgUserFromModal(){
  var usernameInput = document.getElementById('newOrgUserUsernameInput');
  var displayNameInput = document.getElementById('newOrgUserDisplayNameInput');
  var emailInput = document.getElementById('newOrgUserEmailInput');
  var passwordInput = document.getElementById('newOrgUserPasswordInput');

  var username = usernameInput.value.trim();
  var displayName = displayNameInput.value.trim();
  var email = emailInput.value.trim();
  var password = passwordInput.value;

  if(!username){ toast('Please enter a username.'); return; }
  if(!displayName){ toast('Please enter a display name.'); return; }
  if(!email || !SIMPLE_EMAIL_SHAPE.test(email)){ toast('Please enter a valid email address.'); return; }
  if(!password || password.length < 8){ toast('Password must be at least 8 characters.'); return; }

  createOrgUserApi(username, displayName, password, email).then(function(){
    usernameInput.value = '';
    displayNameInput.value = '';
    emailInput.value = '';
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
