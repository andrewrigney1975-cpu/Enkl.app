"use strict";

import { api } from '../api.js';
import { hydrateIcons } from '../icons.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';

export async function renderDashboard(root){
  root.innerHTML = '<div class="kf-view"><p style="color:var(--kf-text-faint);">Loading…</p></div>';
  var data = await api.get('/dashboard');

  var tiles = [
    { label: 'Organisations', value: data.org_count },
    { label: 'Active Users', value: data.active_user_count },
    { label: 'Active Contracts', value: data.active_contract_count },
    { label: 'Annualized Contract Value', value: formatMoney(data.annualized_contract_value_cents, 'USD') }
  ];

  var rows = (data.recentContracts || []).map(function(c){
    return '<tr>' +
      '<td>' + escapeHtml(c.org_name) + '</td>' +
      '<td>' + escapeHtml(c.name) + '</td>' +
      '<td><span class="kf-pill kf-pill-' + c.status + '">' + escapeHtml(c.status) + '</span></td>' +
      '<td>' + formatDate(c.start_date) + ' – ' + formatDate(c.end_date) + '</td>' +
      '<td>' + formatMoney(c.contract_value_cents, 'USD') + ' / ' + escapeHtml(c.billing_frequency) + '</td>' +
      '</tr>';
  }).join('');

  root.innerHTML =
    '<div class="kf-view">' +
      '<div class="kf-view-header"><h1 class="kf-view-title">Dashboard</h1></div>' +
      '<div class="kf-stat-grid">' +
        tiles.map(function(t){
          return '<div class="kf-stat-tile"><div class="kf-stat-tile-label">' + escapeHtml(t.label) + '</div><div class="kf-stat-tile-value">' + escapeHtml(t.value) + '</div></div>';
        }).join('') +
      '</div>' +
      '<div class="kf-panel">' +
        '<div class="kf-panel-header">Recently updated contracts</div>' +
        (rows
          ? '<table class="kf-table"><thead><tr><th>Organisation</th><th>Contract</th><th>Status</th><th>Term</th><th>Value</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="kf-table-empty">No contracts yet.</div>') +
      '</div>' +
    '</div>';

  hydrateIcons(root);
}
