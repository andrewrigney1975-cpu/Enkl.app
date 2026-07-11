"use strict";

import { api } from '../api.js';
import { hydrateIcons } from '../icons.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';
import { openContractModal } from '../modals.js';

export async function renderContracts(root){
  root.innerHTML = '<div class="kf-view"><p style="color:var(--kf-text-faint);">Loading…</p></div>';
  var orgs = await api.get('/organisations');
  var allContracts = [];
  await Promise.all(orgs.map(async function(o){
    var detail = await api.get('/organisations/' + o.id);
    detail.contracts.forEach(function(c){ allContracts.push(Object.assign({}, c, { orgId: o.id, orgName: o.name })); });
  }));

  function draw(){
    var rows = allContracts.map(function(c){
      return '<tr>' +
        '<td>' + escapeHtml(c.orgName) + '</td>' +
        '<td>' + escapeHtml(c.name) + '</td>' +
        '<td><span class="kf-pill kf-pill-' + c.status + '">' + escapeHtml(c.status) + '</span></td>' +
        '<td>' + formatDate(c.start_date) + ' – ' + formatDate(c.end_date) + '</td>' +
        '<td>' + formatMoney(c.contract_value_cents, 'USD') + ' / ' + escapeHtml(c.billing_frequency) + '</td>' +
        '<td class="kf-table-actions"><button class="kf-btn kf-btn-secondary kf-edit-contract-btn" data-id="' + c.id + '"><span class="kf-icon" data-icon="edit" data-size="13"></span>Edit</button></td>' +
        '</tr>';
    }).join('');

    root.innerHTML =
      '<div class="kf-view">' +
        '<div class="kf-view-header"><h1 class="kf-view-title">Contracts</h1><div class="kf-header-spacer"></div>' +
          '<button class="kf-btn kf-btn-primary" id="newContractBtn"><span class="kf-icon" data-icon="plus" data-size="13"></span>New contract</button>' +
        '</div>' +
        '<div class="kf-panel">' +
          (rows
            ? '<table class="kf-table"><thead><tr><th>Organisation</th><th>Contract</th><th>Status</th><th>Term</th><th>Value</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="kf-table-empty">No contracts yet.</div>') +
        '</div>' +
      '</div>';

    hydrateIcons(root);

    async function reload(){
      allContracts = [];
      await Promise.all(orgs.map(async function(o){
        var detail = await api.get('/organisations/' + o.id);
        detail.contracts.forEach(function(c){ allContracts.push(Object.assign({}, c, { orgId: o.id, orgName: o.name })); });
      }));
      draw();
    }

    document.getElementById('newContractBtn').addEventListener('click', function(){
      openContractModal(orgs, null, reload);
    });

    root.querySelectorAll('.kf-edit-contract-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var contract = allContracts.find(function(c){ return c.id === btn.getAttribute('data-id'); });
        openContractModal(orgs, contract, reload);
      });
    });
  }

  draw();
}
