"use strict";

import { api } from '../api.js';
import { hydrateIcons } from '../icons.js';
import { formatDateTime, escapeHtml } from '../format.js';
import { openAnnouncementModal } from '../modals.js';

export async function renderAnnouncements(root){
  root.innerHTML = '<div class="kf-view"><p style="color:var(--kf-text-faint);">Loading…</p></div>';
  var orgs = await api.get('/organisations');
  var items = await api.get('/announcements');

  function draw(){
    var rows = items.map(function(a){
      var target = a.scope === 'platform' ? 'Platform-wide' : escapeHtml(a.org_names || '—');
      return '<tr>' +
        '<td>' + escapeHtml(a.title) + '</td>' +
        '<td><span class="kf-pill kf-pill-' + (a.kind === 'disruption' ? 'cancelled' : 'active') + '">' + escapeHtml(a.kind === 'disruption' ? 'Disruption' : 'Announcement') + '</span></td>' +
        '<td>' + target + '</td>' +
        '<td>' + formatDateTime(a.start_at) + (a.end_at ? ' – ' + formatDateTime(a.end_at) : ' (no end date)') + '</td>' +
        '<td class="kf-table-actions">' +
          '<button class="kf-btn kf-btn-secondary kf-edit-announcement-btn" data-id="' + a.id + '"><span class="kf-icon" data-icon="edit" data-size="13"></span>Edit</button>' +
          '<button class="kf-btn kf-btn-secondary kf-delete-announcement-btn" data-id="' + a.id + '"><span class="kf-icon" data-icon="trash" data-size="13"></span>Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    root.innerHTML =
      '<div class="kf-view">' +
        '<div class="kf-view-header"><h1 class="kf-view-title">Announcements</h1><div class="kf-header-spacer"></div>' +
          '<button class="kf-btn kf-btn-primary" id="newAnnouncementBtn"><span class="kf-icon" data-icon="plus" data-size="13"></span>New announcement</button>' +
        '</div>' +
        '<div class="kf-panel">' +
          (rows
            ? '<table class="kf-table"><thead><tr><th>Title</th><th>Kind</th><th>Target</th><th>Window</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="kf-table-empty">No vendor announcements yet.</div>') +
        '</div>' +
      '</div>';

    hydrateIcons(root);

    async function reload(){
      items = await api.get('/announcements');
      draw();
    }

    document.getElementById('newAnnouncementBtn').addEventListener('click', function(){
      openAnnouncementModal(orgs, null, reload);
    });

    root.querySelectorAll('.kf-edit-announcement-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var item = items.find(function(a){ return a.id === btn.getAttribute('data-id'); });
        openAnnouncementModal(orgs, item, reload);
      });
    });

    root.querySelectorAll('.kf-delete-announcement-btn').forEach(function(btn){
      btn.addEventListener('click', async function(){
        if(!confirm('Delete this announcement? This cannot be undone.')) return;
        await api.delete('/announcements/' + btn.getAttribute('data-id'));
        reload();
      });
    });
  }

  draw();
}
