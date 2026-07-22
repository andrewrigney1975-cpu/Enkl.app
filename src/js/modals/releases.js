"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML, renderBoard } from '../views/board.js';
import { memberInitials, utcISOToLocalDateValue, localDateValueToUTCISO, utcISOToLocalDisplayDate, isoToServerDateOnly } from '../date-utils.js';
import { getMemberById, getTasksArray, getReleaseById } from '../utils.js';
import { addRelease, updateRelease, deleteRelease, normalizeReleaseStatus, getReleaseStatusMeta, computeReleaseNotesMarkdown } from '../mutations.js';
import { confirmDialog } from './confirm.js';
import { releaseApi, isProjectAdmin, isOrgAdmin } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';

// Lazily created on first showReleasesFormView() call and reused for the whole app session — same
// pattern as modals/decisions.js's getDecisionDescEditor().
var releaseNotesEditor = null;
function getReleaseNotesEditor(){
  if(!releaseNotesEditor){
    releaseNotesEditor = createRichTextEditor(document.getElementById('releaseNotesEditor'), document.getElementById('releaseNotesToolbar'), { maxLength: 20000 });
  }
  return releaseNotesEditor;
}

// Release Notes Packager (extends this feature): only meaningful for an existing, already-saved,
// server-authoritative release — a brand-new unsaved release has no id yet to filter tasks by, and
// local-only projects have no Project Admin/Org Admin concept at all (root CLAUDE.md §5).
function canManageReleaseNotes(project, release){
  return !!release && isServerAuthoritative(project) && (isProjectAdmin(project.serverProjectId) || isOrgAdmin());
}

/* The live, possibly-unsaved editor draft — used by the Print button so "Generate, then Print"
   previews what's actually in the editor right now, not whatever was last persisted (a Generate
   followed immediately by Print, before ever clicking Save, would otherwise show stale/empty
   content). Returns null when the section isn't currently visible (print button isn't reachable
   then anyway). */
export function getCurrentReleaseNotesDraft(){
  if(document.getElementById('releaseNotesSection').classList.contains('hidden')) return null;
  return getReleaseNotesEditor().getMarkdown();
}

export function openReleasesOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  showReleasesListView();
  document.getElementById('releasesOverlay').classList.remove('hidden');
}
export function closeReleasesOverlay(){
  document.getElementById('releasesOverlay').classList.add('hidden');
}
export function isReleasesOverlayOpen(){
  return !document.getElementById('releasesOverlay').classList.contains('hidden');
}

export function showReleasesListView(){
  ui.editingReleaseId = null;
  document.getElementById('releasesModalTitle').textContent = 'Releases';
  document.getElementById('releasesListView').classList.remove('hidden');
  document.getElementById('releasesFormView').classList.add('hidden');
  document.getElementById('releasesListFooter').classList.remove('hidden');
  document.getElementById('releasesFormFooter').classList.add('hidden');
  renderReleasesList();
}

export function showReleasesFormView(releaseId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingReleaseId = releaseId || null;
  var release = releaseId ? getReleaseById(project, releaseId) : null;

  document.getElementById('releasesModalTitle').textContent = release ? 'Edit Release' : 'New Release';
  document.getElementById('releasesListView').classList.add('hidden');
  document.getElementById('releasesFormView').classList.remove('hidden');
  document.getElementById('releasesListFooter').classList.add('hidden');
  document.getElementById('releasesFormFooter').classList.remove('hidden');
  document.getElementById('deleteReleaseBtn').classList.toggle('hidden', !release);

  document.getElementById('releaseNameInput').value = release ? release.name : '';
  document.getElementById('releaseStatusSelect').value = release ? normalizeReleaseStatus(release.status) : 'pending';
  populateReleaseOwnerSelect(project, release ? release.ownerId : null);
  document.getElementById('releaseStartDateInput').value = release ? utcISOToLocalDateValue(release.startDate) : '';
  document.getElementById('releaseEndDateInput').value = release ? utcISOToLocalDateValue(release.endDate) : '';

  var showNotes = canManageReleaseNotes(project, release);
  document.getElementById('releaseNotesSection').classList.toggle('hidden', !showNotes);
  if(showNotes) getReleaseNotesEditor().setMarkdown(release.releaseNotes || '');

  document.getElementById('releaseNameInput').focus();
}

/* Drafts Release Notes from every Task (active or archived) tied to the release currently being
   edited — confirms before overwriting any existing hand-edited text (cheap safety net, since this
   is a destructive regenerate, not a merge). */
export function generateReleaseNotesFromModal(){
  var project = getCurrentProject();
  var release = project && ui.editingReleaseId ? getReleaseById(project, ui.editingReleaseId) : null;
  if(!project || !release) return;

  function regenerate(){
    getReleaseNotesEditor().setMarkdown(computeReleaseNotesMarkdown(project, release));
  }

  if(getReleaseNotesEditor().getMarkdown().trim()){
    confirmDialog(
      'Replace existing Release Notes?',
      'This will overwrite the current text with a fresh draft generated from this release’s tasks. Your existing edits will be lost.',
      regenerate
    );
  } else {
    regenerate();
  }
}

function populateReleaseOwnerSelect(project, currentOwnerId){
  var sel = document.getElementById('releaseOwnerSelect');
  sel.innerHTML = '<option value="">Unassigned</option>';
  (project.members || []).forEach(function(m){
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
  sel.value = currentOwnerId || '';
}

function renderReleasesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('releasesList');
  listEl.innerHTML = '';
  if(!project) return;

  var releases = (project.releases || []).slice().sort(function(a, b){
    return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
  });

  if(releases.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No releases yet. Create one above to start grouping tasks by release.</div>';
    return;
  }

  releases.forEach(function(r){
    var owner = getMemberById(project, r.ownerId);
    var statusMeta = getReleaseStatusMeta(r.status);
    var taskCount = getTasksArray(project).filter(function(t){ return t.releaseId === r.id; }).length;

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-release-id', r.id);

    var dateRangeText = '';
    if(r.startDate || r.endDate){
      dateRangeText = (r.startDate ? utcISOToLocalDisplayDate(r.startDate) : '—') + ' – ' + (r.endDate ? utcISOToLocalDisplayDate(r.endDate) : '—');
    }

    var metaHTML = '';
    if(owner){
      metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + owner.color + ';">' + escapeHTML(memberInitials(owner.name)) + '</span><span>' + escapeHTML(owner.name) + '</span>';
    } else {
      metaHTML += '<span>Unassigned</span>';
    }
    if(dateRangeText) metaHTML += '<span>' + escapeHTML(dateRangeText) + '</span>';
    metaHTML += '<span class="kf-release-task-count">' + taskCount + ' task' + (taskCount === 1 ? '' : 's') + '</span>';

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-release-name">' + escapeHTML(r.name) + '</span>' +
        '<span class="kf-release-status-pill ' + normalizeReleaseStatus(r.status) + '">' + escapeHTML(statusMeta.label) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    row.addEventListener('click', function(){ showReleasesFormView(r.id); });
    listEl.appendChild(row);
  });
}

export async function saveReleaseFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var name = document.getElementById('releaseNameInput').value.trim();
  if(!name){ toast('Please enter a release name.'); return; }

  var startISO = localDateValueToUTCISO(document.getElementById('releaseStartDateInput').value);
  var endISO = localDateValueToUTCISO(document.getElementById('releaseEndDateInput').value);
  if(startISO && endISO && new Date(endISO).getTime() < new Date(startISO).getTime()){
    toast('End date cannot be before the start date.');
    return;
  }

  var data = {
    name: name,
    status: document.getElementById('releaseStatusSelect').value,
    ownerId: document.getElementById('releaseOwnerSelect').value || null,
    startDate: startISO,
    endDate: endISO
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingReleaseId;
      var body = {name: data.name, status: data.status, ownerId: data.ownerId, startDate: isoToServerDateOnly(data.startDate), endDate: isoToServerDateOnly(data.endDate)};
      if(editingId) await releaseApi.update(project.serverProjectId, editingId, body);
      else await releaseApi.create(project.serverProjectId, body);
      // ReleaseNotes is a separate, Project-Admin/Org-Admin-gated write path (see releaseApi.updateNotes's
      // own note) — fired right after the main save so the user only ever perceives one Save action,
      // but only reachable here for an EXISTING release whose notes section was actually shown.
      if(editingId && !document.getElementById('releaseNotesSection').classList.contains('hidden')){
        await releaseApi.updateNotes(project.serverProjectId, editingId, getReleaseNotesEditor().getMarkdown());
      }
      await refreshProjectFromServer(project.id);
      renderBoard();
      toast(editingId ? 'Release updated.' : 'Release created.');
      showReleasesListView();
    } catch(e){
      toast('Could not save release on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingReleaseId){
    updateRelease(project, ui.editingReleaseId, data);
    toast('Release updated.');
  } else {
    addRelease(project, data);
    toast('Release created.');
  }
  renderBoard();
  showReleasesListView();
}

export function deleteReleaseFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingReleaseId) return;
  var release = getReleaseById(project, ui.editingReleaseId);
  if(!release) return;
  confirmDialog(
    'Delete ' + release.name + '?',
    'Any tasks currently assigned to this release will be unassigned.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await releaseApi.remove(project.serverProjectId, release.id);
          await refreshProjectFromServer(project.id);
          renderBoard();
          toast('Deleted ' + release.name + '.');
          showReleasesListView();
        } catch(e){
          toast('Could not delete release on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      var unassigned = deleteRelease(project, release.id);
      renderBoard();
      toast('Deleted ' + release.name + (unassigned > 0 ? ' — unassigned from ' + unassigned + ' task(s).' : '.'));
      showReleasesListView();
    }
  );
}
