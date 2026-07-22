"use strict";
import { toast } from '../ui.js';
import { escapeHTML } from '../views/board.js';
import { announcementApi, isOrgAdmin } from '../api.js';
import { localDateTimeValueToISO, isoToLocalDateTimeValue, utcISOToLocalDisplayDateTime } from '../date-utils.js';
import { confirmDialog } from './confirm.js';
import { refreshAnnouncementData } from '../features/announcements.js';

/* Org-Admin-only management of this org's own Announcements/Disruption Notices — mirrors
   modals/organisation.js's own shape (a small self-contained modal, list + create/edit form) rather
   than a new pattern. Vendor-authored rows (Scope='orgs'/'platform') never appear in this list —
   AnnouncementService::listForOrg only ever returns Scope='org' rows for the caller's own
   organisation, see root CLAUDE.md's Announcements plan for why. */

export function openAnnouncementsAdminModal(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can manage announcements.'); return; }
  resetAnnouncementForm();
  renderAnnouncementsAdminList();
  document.getElementById('announcementsAdminOverlay').classList.remove('hidden');
}

export function closeAnnouncementsAdminModal(){
  document.getElementById('announcementsAdminOverlay').classList.add('hidden');
}

function resetAnnouncementForm(){
  document.getElementById('announcementAdminEditingId').value = '';
  document.getElementById('announcementAdminTitleInput').value = '';
  document.getElementById('announcementAdminBodyInput').value = '';
  document.getElementById('announcementAdminStartInput').value = '';
  document.getElementById('announcementAdminEndInput').value = '';
  document.querySelector('input[name="announcementAdminKind"][value="announcement"]').checked = true;
  document.getElementById('announcementAdminCancelEditBtn').classList.add('hidden');
  document.getElementById('announcementAdminSaveBtn').innerHTML = '<span class="kf-icon" data-icon="plus" data-size="14"></span>Save';
}

export function renderAnnouncementsAdminList(){
  var listEl = document.getElementById('announcementsAdminList');
  listEl.innerHTML = '<div class="kf-member-empty">Loading…</div>';
  announcementApi.listForOrg().then(function(items){
    if(items.length === 0){
      listEl.innerHTML = '<div class="kf-member-empty">No announcements yet.</div>';
      return;
    }
    listEl.innerHTML = '';
    items.forEach(function(a){
      var row = document.createElement('div');
      row.className = 'kf-member-row';
      row.innerHTML =
        '<div class="kf-orguser-row-name">' +
          '<div class="kf-orguser-display-name">' + escapeHTML(a.title) +
            (a.kind === 'disruption' ? ' <span class="kf-orguser-inactive-badge">Disruption</span>' : '') +
          '</div>' +
          '<div class="kf-orguser-username">' + utcISOToLocalDisplayDateTime(a.startAt) +
            (a.endAt ? ' – ' + utcISOToLocalDisplayDateTime(a.endAt) : ' (no end date)') +
          '</div>' +
        '</div>' +
        '<button class="kf-btn kf-btn-ghost" data-action="edit">Edit</button>' +
        '<button class="kf-btn kf-btn-ghost kf-orguser-deactivate-btn" data-action="delete">Delete</button>';
      row.querySelector('[data-action="edit"]').addEventListener('click', function(){ startEditAnnouncement(a); });
      row.querySelector('[data-action="delete"]').addEventListener('click', function(){
        confirmDialog('Delete "' + a.title + '"?', 'This cannot be undone.', function(){
          announcementApi.remove(a.id).then(function(){
            renderAnnouncementsAdminList();
            refreshAnnouncementData();
          }, function(e){
            toast('Could not delete announcement: ' + (e.message || 'unknown error'));
          });
        });
      });
      listEl.appendChild(row);
    });
  }, function(e){
    listEl.innerHTML = '<div class="kf-member-empty">Could not load announcements.</div>';
    toast('Could not load announcements: ' + (e.message || 'unknown error'));
  });
}

function startEditAnnouncement(a){
  document.getElementById('announcementAdminEditingId').value = a.id;
  document.getElementById('announcementAdminTitleInput').value = a.title;
  document.getElementById('announcementAdminBodyInput').value = a.body;
  document.getElementById('announcementAdminStartInput').value = isoToLocalDateTimeValue(a.startAt);
  document.getElementById('announcementAdminEndInput').value = isoToLocalDateTimeValue(a.endAt);
  document.querySelector('input[name="announcementAdminKind"][value="' + a.kind + '"]').checked = true;
  document.getElementById('announcementAdminCancelEditBtn').classList.remove('hidden');
  document.getElementById('announcementAdminSaveBtn').innerHTML = 'Save changes';
}

export function cancelAnnouncementEdit(){
  resetAnnouncementForm();
}

export function saveAnnouncementFromModal(){
  var editingId = document.getElementById('announcementAdminEditingId').value;
  var title = document.getElementById('announcementAdminTitleInput').value.trim();
  var body = document.getElementById('announcementAdminBodyInput').value.trim();
  var kind = document.querySelector('input[name="announcementAdminKind"]:checked').value;
  var startValue = document.getElementById('announcementAdminStartInput').value;
  var endValue = document.getElementById('announcementAdminEndInput').value;

  if(!title){ toast('Please enter a title.'); return; }
  if(!startValue){ toast('Please choose a start date/time.'); return; }

  var payload = {
    title: title, body: body, kind: kind,
    startAt: localDateTimeValueToISO(startValue),
    endAt: endValue ? localDateTimeValueToISO(endValue) : null
  };

  var request = editingId ? announcementApi.update(editingId, payload) : announcementApi.create(payload);
  request.then(function(){
    toast(editingId ? 'Announcement updated.' : 'Announcement created.');
    resetAnnouncementForm();
    renderAnnouncementsAdminList();
    refreshAnnouncementData();
  }, function(e){
    toast('Could not save announcement: ' + (e.message || 'unknown error'));
  });
}
