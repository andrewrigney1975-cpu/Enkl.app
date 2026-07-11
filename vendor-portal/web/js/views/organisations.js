"use strict";

import { api } from '../api.js';
import { hydrateIcons } from '../icons.js';
import { formatDate, escapeHtml } from '../format.js';

export async function renderOrganisations(root){
  root.innerHTML = '<div class="kf-view"><p style="color:var(--kf-text-faint);">Loading…</p></div>';
  var orgs = await api.get('/organisations');

  var rows = orgs.map(function(o){
    return '<tr>' +
      '<td>' + escapeHtml(o.name) + '</td>' +
      '<td>' + o.active_user_count + ' active / ' + o.total_user_count + ' total</td>' +
      '<td>' + o.active_contract_count + '</td>' +
      '<td>' + formatDate(o.created_at) + '</td>' +
      '</tr>';
  }).join('');

  root.innerHTML =
    '<div class="kf-view">' +
      '<div class="kf-view-header"><h1 class="kf-view-title">Organisations</h1></div>' +
      '<div class="kf-panel">' +
        (rows
          ? '<table class="kf-table"><thead><tr><th>Name</th><th>Users</th><th>Active contracts</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="kf-table-empty">No organisations found.</div>') +
      '</div>' +
    '</div>';

  hydrateIcons(root);
}
