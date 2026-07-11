"use strict";

import { api } from '../api.js';
import { hydrateIcons } from '../icons.js';
import { formatMoney, escapeHtml } from '../format.js';
import { openLicenseModal } from '../modals.js';

export async function renderLicenses(root){
  root.innerHTML = '<div class="kf-view"><p style="color:var(--kf-text-faint);">Loading…</p></div>';
  var orgs = await api.get('/organisations');

  function draw(){
    var rows = orgs.map(function(o){
      var hasLicense = o.seat_cost_cents != null;
      return '<tr>' +
        '<td>' + escapeHtml(o.name) + '</td>' +
        '<td>' + (hasLicense ? formatMoney(o.seat_cost_cents, o.currency) + ' / seat' : '—') + '</td>' +
        '<td>' + (hasLicense ? o.discount_percent + '%' : '—') + '</td>' +
        '<td>' + o.active_user_count + '</td>' +
        '<td class="kf-table-actions"><button class="kf-btn kf-btn-secondary kf-edit-license-btn" data-org-id="' + o.id + '"><span class="kf-icon" data-icon="edit" data-size="13"></span>' + (hasLicense ? 'Edit' : 'Set license') + '</button></td>' +
        '</tr>';
    }).join('');

    root.innerHTML =
      '<div class="kf-view">' +
        '<div class="kf-view-header"><h1 class="kf-view-title">Licenses</h1></div>' +
        '<div class="kf-panel">' +
          (rows
            ? '<table class="kf-table"><thead><tr><th>Organisation</th><th>Seat cost</th><th>Discount</th><th>Active users</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="kf-table-empty">No organisations found.</div>') +
        '</div>' +
      '</div>';

    hydrateIcons(root);

    root.querySelectorAll('.kf-edit-license-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var org = orgs.find(function(o){ return o.id === btn.getAttribute('data-org-id'); });
        openLicenseModal(org, async function(){
          orgs = await api.get('/organisations');
          draw();
        });
      });
    });
  }

  draw();
}
