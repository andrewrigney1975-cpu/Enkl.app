"use strict";

import { api } from './api.js';
import { fromCents, toCents, escapeHtml } from './format.js';

function showError(el, message){
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError(el){
  el.classList.add('hidden');
  el.textContent = '';
}

export function openLicenseModal(org, onSaved){
  var overlay = document.getElementById('licenseOverlay');
  var title = document.getElementById('licenseModalTitle');
  var seatCost = document.getElementById('licenseSeatCostInput');
  var currency = document.getElementById('licenseCurrencyInput');
  var discount = document.getElementById('licenseDiscountInput');
  var effectiveFrom = document.getElementById('licenseEffectiveFromInput');
  var notes = document.getElementById('licenseNotesInput');
  var error = document.getElementById('licenseError');
  var saveBtn = document.getElementById('licenseSaveBtn');
  var cancelBtn = document.getElementById('licenseCancelBtn');
  var closeBtn = document.getElementById('licenseModalClose');

  title.textContent = 'License — ' + org.name;
  seatCost.value = org.seat_cost_cents != null ? fromCents(org.seat_cost_cents) : '';
  currency.value = org.currency || 'USD';
  discount.value = org.discount_percent != null ? org.discount_percent : '';
  effectiveFrom.value = org.effective_from ? String(org.effective_from).slice(0, 10) : '';
  notes.value = org.notes || '';
  hideError(error);
  overlay.classList.remove('hidden');

  function close(){
    overlay.classList.add('hidden');
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
  }

  cancelBtn.onclick = close;
  closeBtn.onclick = close;
  saveBtn.onclick = async function(){
    try{
      hideError(error);
      await api.put('/organisations/' + org.id + '/license', {
        seatCostCents: toCents(seatCost.value || 0),
        currency: currency.value,
        discountPercent: Number(discount.value || 0),
        effectiveFrom: effectiveFrom.value || null,
        notes: notes.value || null
      });
      close();
      onSaved();
    }catch(e){
      showError(error, e.message);
    }
  };
}

export function openContractModal(orgs, contract, onSaved){
  var overlay = document.getElementById('contractOverlay');
  var title = document.getElementById('contractModalTitle');
  var orgField = document.getElementById('contractOrgField');
  var orgSelect = document.getElementById('contractOrgSelect');
  var name = document.getElementById('contractNameInput');
  var status = document.getElementById('contractStatusSelect');
  var billing = document.getElementById('contractBillingSelect');
  var startDate = document.getElementById('contractStartDateInput');
  var endDate = document.getElementById('contractEndDateInput');
  var value = document.getElementById('contractValueInput');
  var notes = document.getElementById('contractNotesInput');
  var error = document.getElementById('contractError');
  var saveBtn = document.getElementById('contractSaveBtn');
  var cancelBtn = document.getElementById('contractCancelBtn');
  var closeBtn = document.getElementById('contractModalClose');
  var deleteBtn = document.getElementById('contractDeleteBtn');

  var isEdit = !!(contract && contract.id);
  title.textContent = isEdit ? 'Edit contract' : 'New contract';

  if(isEdit){
    orgField.classList.add('hidden');
  } else {
    orgField.classList.remove('hidden');
    orgSelect.innerHTML = orgs.map(function(o){ return '<option value="' + o.id + '">' + escapeHtml(o.name) + '</option>'; }).join('');
    if(contract && contract.orgId) orgSelect.value = contract.orgId;
  }

  name.value = contract ? (contract.name || '') : '';
  status.value = contract ? (contract.status || 'draft') : 'draft';
  billing.value = contract ? (contract.billing_frequency || 'annual') : 'annual';
  startDate.value = contract && contract.start_date ? String(contract.start_date).slice(0, 10) : '';
  endDate.value = contract && contract.end_date ? String(contract.end_date).slice(0, 10) : '';
  value.value = contract && contract.contract_value_cents != null ? fromCents(contract.contract_value_cents) : '';
  notes.value = contract ? (contract.notes || '') : '';
  hideError(error);
  deleteBtn.classList.toggle('hidden', !isEdit);
  overlay.classList.remove('hidden');

  function close(){
    overlay.classList.add('hidden');
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
    deleteBtn.onclick = null;
  }

  cancelBtn.onclick = close;
  closeBtn.onclick = close;

  saveBtn.onclick = async function(){
    var payload = {
      name: name.value,
      status: status.value,
      billingFrequency: billing.value,
      startDate: startDate.value || null,
      endDate: endDate.value || null,
      contractValueCents: toCents(value.value || 0),
      notes: notes.value || null
    };
    try{
      hideError(error);
      if(isEdit){
        await api.put('/contracts/' + contract.id, payload);
      } else {
        await api.post('/organisations/' + orgSelect.value + '/contracts', payload);
      }
      close();
      onSaved();
    }catch(e){
      showError(error, e.message);
    }
  };

  deleteBtn.onclick = async function(){
    if(!confirm('Delete this contract? This cannot be undone.')) return;
    try{
      await api.delete('/contracts/' + contract.id);
      close();
      onSaved();
    }catch(e){
      showError(error, e.message);
    }
  };
}

/* "YYYY-MM-DDTHH:mm" (local, datetime-local input) <-> ISO — same round-trip the main Enkl App's own
   date-utils.js does (localDateTimeValueToISO/isoToLocalDateTimeValue), reimplemented here rather than
   imported since this portal never imports from src/js/ (see vendor-portal/CLAUDE.md). */
function localDateTimeValueToISO(value){
  if(!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function isoToLocalDateTimeValue(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  function pad2(n){ return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* First multi-select control in this app (see root vendor-portal/CLAUDE.md's plan note) — a plain
   scrollable checkbox list rather than a fancy dropdown, matching this portal's existing
   no-framework, keep-it-simple style. Disabled (and visually dimmed via the "platform-wide" toggle's
   own CSS) whenever the Platform-wide radio is selected, since a platform-wide notice targets every
   organisation and has no org list of its own. */
export function openAnnouncementModal(orgs, announcement, onSaved){
  var overlay = document.getElementById('announcementOverlay');
  var title = document.getElementById('announcementModalTitle');
  var titleInput = document.getElementById('announcementTitleInput');
  var bodyInput = document.getElementById('announcementBodyInput');
  var kindAnnouncementRadio = document.getElementById('announcementKindAnnouncement');
  var kindDisruptionRadio = document.getElementById('announcementKindDisruption');
  var scopeOrgsRadio = document.getElementById('announcementScopeOrgs');
  var scopePlatformRadio = document.getElementById('announcementScopePlatform');
  var orgListEl = document.getElementById('announcementOrgList');
  var startInput = document.getElementById('announcementStartInput');
  var endInput = document.getElementById('announcementEndInput');
  var error = document.getElementById('announcementError');
  var saveBtn = document.getElementById('announcementSaveBtn');
  var cancelBtn = document.getElementById('announcementCancelBtn');
  var closeBtn = document.getElementById('announcementModalClose');
  var deleteBtn = document.getElementById('announcementDeleteBtn');

  var isEdit = !!(announcement && announcement.id);
  title.textContent = isEdit ? 'Edit announcement' : 'New announcement';

  var selectedOrgIds = isEdit && Array.isArray(announcement.org_ids) ? announcement.org_ids.slice() : [];
  orgListEl.innerHTML = orgs.map(function(o){
    var checked = selectedOrgIds.indexOf(o.id) !== -1 ? ' checked' : '';
    return '<label class="kf-org-checkbox-row"><input type="checkbox" value="' + o.id + '"' + checked + '> ' + escapeHtml(o.name) + '</label>';
  }).join('');

  function applyScopeToOrgList(){
    var platformWide = scopePlatformRadio.checked;
    orgListEl.classList.toggle('kf-org-list-disabled', platformWide);
    orgListEl.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.disabled = platformWide; });
  }

  titleInput.value = isEdit ? announcement.title : '';
  bodyInput.value = isEdit ? (announcement.body || '') : '';
  kindDisruptionRadio.checked = isEdit && announcement.kind === 'disruption';
  kindAnnouncementRadio.checked = !kindDisruptionRadio.checked;
  scopePlatformRadio.checked = isEdit && announcement.scope === 'platform';
  scopeOrgsRadio.checked = !scopePlatformRadio.checked;
  startInput.value = isEdit ? isoToLocalDateTimeValue(announcement.start_at) : '';
  endInput.value = isEdit ? isoToLocalDateTimeValue(announcement.end_at) : '';
  applyScopeToOrgList();
  hideError(error);
  deleteBtn.classList.toggle('hidden', !isEdit);
  overlay.classList.remove('hidden');

  scopeOrgsRadio.onchange = applyScopeToOrgList;
  scopePlatformRadio.onchange = applyScopeToOrgList;

  function close(){
    overlay.classList.add('hidden');
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
    deleteBtn.onclick = null;
    scopeOrgsRadio.onchange = null;
    scopePlatformRadio.onchange = null;
  }

  cancelBtn.onclick = close;
  closeBtn.onclick = close;

  saveBtn.onclick = async function(){
    var scope = scopePlatformRadio.checked ? 'platform' : 'orgs';
    var orgIds = scope === 'orgs'
      ? Array.from(orgListEl.querySelectorAll('input[type=checkbox]:checked')).map(function(cb){ return cb.value; })
      : [];
    var payload = {
      title: titleInput.value,
      body: bodyInput.value,
      kind: kindDisruptionRadio.checked ? 'disruption' : 'announcement',
      scope: scope,
      orgIds: orgIds,
      startAt: localDateTimeValueToISO(startInput.value),
      endAt: endInput.value ? localDateTimeValueToISO(endInput.value) : null
    };
    try{
      hideError(error);
      if(isEdit){
        await api.put('/announcements/' + announcement.id, payload);
      } else {
        await api.post('/announcements', payload);
      }
      close();
      onSaved();
    }catch(e){
      showError(error, e.message);
    }
  };

  deleteBtn.onclick = async function(){
    if(!confirm('Delete this announcement? This cannot be undone.')) return;
    try{
      await api.delete('/announcements/' + announcement.id);
      close();
      onSaved();
    }catch(e){
      showError(error, e.message);
    }
  };
}
