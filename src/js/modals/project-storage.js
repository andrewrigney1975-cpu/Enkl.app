"use strict";
import { state, STORAGE_QUOTA_WARNING_BYTES, STORAGE_QUOTA_ESTIMATE_BYTES, estimateByteSize } from '../storage.js';
import { escapeHTML } from '../views/board.js';
import { isServerAuthoritative, isServerLoggedIn } from '../features/migration.js';
import { isOrgAdmin } from '../api.js';
import { toast } from '../ui.js';

/* =========================================================
   PROJECT STORAGE
   Read-only informational modal (modeled on modals/about.js) showing how much of the browser's
   localStorage quota the local DB is using, broken down per project so the user can tell which
   one(s) are worth exporting/archiving/deleting — the proactive counterpart to saveDB()'s own
   reactive "getting full"/"quota exceeded" toasts (storage.js), reusing the exact same threshold
   constants so the two never drift apart.
   ========================================================= */

function formatBytes(bytes){
  if(bytes >= 1024 * 1024) return (Math.round(bytes / (1024 * 1024) * 10) / 10) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function renderProjectStorageModal(){
  var totalBytes = estimateByteSize(state.db);
  var ids = (state.db && state.db.projectOrder) || [];
  var rows = ids.map(function(id){ return state.db.projects[id]; }).filter(Boolean)
    .map(function(p){ return {project: p, bytes: estimateByteSize(p)}; })
    .sort(function(a, b){ return b.bytes - a.bytes; }); // largest first — directly actionable

  document.getElementById('projectStorageTotal').textContent =
    formatBytes(totalBytes) + ' of ~' + formatBytes(STORAGE_QUOTA_ESTIMATE_BYTES) + ' estimated browser limit';
  document.getElementById('projectStorageTotalBar').style.width =
    Math.min(100, totalBytes / STORAGE_QUOTA_ESTIMATE_BYTES * 100) + '%';

  var warningEl = document.getElementById('projectStorageWarning');
  var isNearingLimit = totalBytes >= STORAGE_QUOTA_WARNING_BYTES;
  warningEl.classList.toggle('hidden', !isNearingLimit);
  if(isNearingLimit){
    // Same message saveDB()'s own toast shows, plus the actionable advice this screen specifically enables.
    warningEl.textContent = 'Local storage is getting full — you may soon be unable to save further changes. ' +
      'Export, archive, or delete your largest project(s) below, or move valuable local-only projects to a server account so they’re not solely dependent on browser storage.';
  }

  var listEl = document.getElementById('projectStorageList');
  if(rows.length === 0){
    listEl.innerHTML = '<div class="kf-about-projects-empty">No projects yet.</div>';
    return;
  }
  listEl.innerHTML = rows.map(function(r){
    var pct = totalBytes > 0 ? (r.bytes / totalBytes * 100) : 0;
    return (
      '<div class="kf-storage-project-row">' +
        '<span class="kf-about-project-key">' + escapeHTML(r.project.key) + '</span>' +
        '<span class="kf-about-project-name">' + escapeHTML(r.project.name) + '</span>' +
        '<span class="kf-storage-project-badge">' + (isServerAuthoritative(r.project) ? 'Server-linked' : 'Local') + '</span>' +
        '<span class="kf-storage-project-track"><span class="kf-storage-project-fill" style="width:' + pct + '%;"></span></span>' +
        '<span class="kf-storage-project-size">' + formatBytes(r.bytes) + '</span>' +
      '</div>'
    );
  }).join('');
}

/* A session that's never logged in at all is implicitly its own "Org Admin" for local data — there's
   no real multi-tenant org concept without a server login — so this only blocks a logged-in session
   that isn't actually an Org Admin. Mirrors board.js's applyHeaderButtonVisibility() gate on the
   entry-point buttons; checked again here (not just relying on the button being hidden) the same way
   openPortfolioDashboardOverlay() defends its own open function. */
export function openProjectStorageModal(){
  if(isServerLoggedIn() && !isOrgAdmin()){
    toast('Only an organisation admin can open Project Storage.');
    return;
  }
  renderProjectStorageModal();
  document.getElementById('projectStorageOverlay').classList.remove('hidden');
}
export function closeProjectStorageModal(){
  document.getElementById('projectStorageOverlay').classList.add('hidden');
}
export function isProjectStorageModalOpen(){
  return !document.getElementById('projectStorageOverlay').classList.contains('hidden');
}
