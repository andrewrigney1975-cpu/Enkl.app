"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg } from '../icons.js';
import { utcISOToLocalDisplayDate } from '../date-utils.js';
import { getPrincipleById } from '../utils.js';
import { addPrinciple, updatePrinciple, deletePrinciple } from '../mutations.js';
import { updateDocUrlOpenButtonVisibilityFor, openUrlInputInNewTab } from './documents.js';
import { confirmDialog } from './confirm.js';
import { principleApi, organisationPrincipleApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { createRichTextEditor } from '../rich-text/editor.js';
import { getProjectHashtags } from '../features/hashtags.js';

// Lazily created on first showPrinciplesFormView() call and reused for the whole app session — same
// pattern as modals/task.js's taskDescEditor.
var principleDescEditor = null;
function getPrincipleDescEditor(){
  if(!principleDescEditor){
    principleDescEditor = createRichTextEditor(document.getElementById('principleDescEditor'), document.getElementById('principleDescToolbar'), { maxLength: 4000, getHashtags: function(){ return getProjectHashtags(getCurrentProject()); } });
  }
  return principleDescEditor;
}

export function openPrinciplesOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.principlesSearchTerm = '';
  document.getElementById('principlesSearchInput').value = '';
  ui.principlesActiveTab = 'mine';
  showPrinciplesListView();
  document.getElementById('principlesOverlay').classList.remove('hidden');
}
export function closePrinciplesOverlay(){
  document.getElementById('principlesOverlay').classList.add('hidden');
}
export function isPrinciplesOverlayOpen(){
  return !document.getElementById('principlesOverlay').classList.contains('hidden');
}

export function showPrinciplesListView(){
  ui.editingPrincipleId = null;
  document.getElementById('principlesModalTitle').textContent = 'Principles';
  document.getElementById('principlesListView').classList.remove('hidden');
  document.getElementById('principlesFormView').classList.add('hidden');
  document.getElementById('principlesListFooter').classList.remove('hidden');
  document.getElementById('principlesFormFooter').classList.add('hidden');
  renderPrinciplesTabStrip();
}

/* principleId: edit an existing principle (null = new). prefillTitle: only used for a brand-new
   principle (ignored if principleId is set) — lets the Organisation Library's "Create Principle from
   this" suggestion button and the future promote-from-retrospective flow seed the Title field without
   a bespoke second form. */
export function showPrinciplesFormView(principleId, prefillTitle){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingPrincipleId = principleId || null;
  var principle = principleId ? getPrincipleById(project, principleId) : null;

  document.getElementById('principlesModalTitle').textContent = principle ? 'Edit Principle' : 'New Principle';
  document.getElementById('principlesListView').classList.add('hidden');
  document.getElementById('principlesFormView').classList.remove('hidden');
  document.getElementById('principlesListFooter').classList.add('hidden');
  document.getElementById('principlesFormFooter').classList.remove('hidden');
  document.getElementById('deletePrincipleBtn').classList.toggle('hidden', !principle);

  document.getElementById('principleTitleInput').value = principle ? principle.title : (prefillTitle || '');
  getPrincipleDescEditor().setMarkdown(principle ? principle.description : '');
  document.getElementById('principleDocUrlInput').value = principle && principle.documentUrl ? principle.documentUrl : '';
  updateDocUrlOpenButtonVisibilityFor('principleDocUrlInput', 'principleDocUrlOpenBtn');

  /* "Share to organisation" only makes sense for a principle that already exists (the server route is
     PUT .../principles/{id}/share) on a server-authoritative project — hidden entirely otherwise, same
     "omit rather than disable" treatment as the Retrospective board's Promote button. */
  var shareWrap = document.getElementById('principleShareFieldWrap');
  var canShare = !!principle && isServerAuthoritative(project);
  shareWrap.classList.toggle('hidden', !canShare);
  document.getElementById('principleShareCheckbox').checked = !!(principle && principle.isOrganisationWide);

  var metaEl = document.getElementById('principleMetaDates');
  if(principle){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(principle.dateCreated) +
      (principle.dateLastModified && principle.dateLastModified !== principle.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(principle.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('principleTitleInput').focus();
}

export async function updatePrincipleShareFromModal(isOrganisationWide){
  var project = getCurrentProject();
  if(!project || !ui.editingPrincipleId || !isServerAuthoritative(project)) return;
  try {
    await principleApi.share(project.serverProjectId, ui.editingPrincipleId, {isOrganisationWide: isOrganisationWide});
    await refreshProjectFromServer(project.id);
    toast(isOrganisationWide ? 'Shared to the Organisation Library.' : 'Removed from the Organisation Library.');
  } catch(e){
    toast('Could not update sharing on the server: ' + (e.message || 'unknown error'));
    document.getElementById('principleShareCheckbox').checked = !isOrganisationWide;
  }
}

/* =========================================================
   ORGANISATION LIBRARY
   A second tab in the same list view — principles any project in the
   organisation has shared (organisationPrincipleApi.listWide) plus
   auto-suggested recurring themes distilled from retrospectives across
   the org (organisationPrincipleApi.suggestions). Both the tab itself
   and everything in it only make sense once a project is server-
   authoritative (an org concept doesn't exist for a local-only board),
   so the tab button is omitted entirely otherwise — same treatment as
   every other server-only affordance in this app.
   ========================================================= */
var _dismissedSuggestionPhrases = new Set();

export function renderPrinciplesTabStrip(){
  var project = getCurrentProject();
  var canSeeLibrary = isServerAuthoritative(project);
  var tabStrip = document.getElementById('principlesTabStrip');
  tabStrip.classList.toggle('hidden', !canSeeLibrary);
  if(!canSeeLibrary) ui.principlesActiveTab = 'mine';

  document.getElementById('principlesTabMineBtn').classList.toggle('active', ui.principlesActiveTab === 'mine');
  document.getElementById('principlesTabLibraryBtn').classList.toggle('active', ui.principlesActiveTab === 'library');
  document.getElementById('principlesMinePanel').classList.toggle('hidden', ui.principlesActiveTab !== 'mine');
  document.getElementById('principlesLibraryPanel').classList.toggle('hidden', ui.principlesActiveTab !== 'library');

  if(ui.principlesActiveTab === 'library') renderPrinciplesLibraryList();
  else renderPrinciplesList();
}

export function switchPrinciplesTab(tab){
  ui.principlesActiveTab = (tab === 'library') ? 'library' : 'mine';
  renderPrinciplesTabStrip();
}

export async function renderPrinciplesLibraryList(){
  var project = getCurrentProject();
  var suggestionsEl = document.getElementById('principlesSuggestionsList');
  var libraryEl = document.getElementById('principlesLibraryList');
  if(!project || !isServerAuthoritative(project)) return;

  suggestionsEl.innerHTML = '<div class="kf-releases-empty">Loading suggestions…</div>';
  libraryEl.innerHTML = '<div class="kf-releases-empty">Loading organisation library…</div>';

  try {
    var suggestions = await organisationPrincipleApi.suggestions();
    renderPrincipleSuggestions(suggestions || []);
  } catch(e){
    suggestionsEl.innerHTML = '<div class="kf-releases-empty">Could not load suggestions.</div>';
  }

  try {
    var wide = await organisationPrincipleApi.listWide();
    renderOrganisationLibraryRows(wide || []);
  } catch(e){
    libraryEl.innerHTML = '<div class="kf-releases-empty">Could not load the organisation library.</div>';
  }
}

function renderPrincipleSuggestions(suggestions){
  var suggestionsEl = document.getElementById('principlesSuggestionsList');
  var visible = suggestions.filter(function(s){ return !_dismissedSuggestionPhrases.has(s.phrase); });
  suggestionsEl.innerHTML = '';
  if(visible.length === 0){
    suggestionsEl.innerHTML = '<div class="kf-releases-empty">No recurring themes suggested yet — these build up as more retrospectives are run across the organisation.</div>';
    return;
  }
  visible.forEach(function(s){
    var row = document.createElement('div');
    row.className = 'kf-release-row';

    var snippetsHTML = (s.sampleSnippets || []).slice(0, 3).map(function(sn){
      return '<div class="kf-principle-suggestion-snippet">"' + escapeHTML(sn.text) + '" — ' + escapeHTML(sn.projectName) + '</div>';
    }).join('');

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-release-name">' + escapeHTML(s.phrase) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' +
        '<span>' + s.occurrenceCount + ' mention(s)</span>' +
        '<span>' + s.retrospectiveCount + ' retrospective(s)</span>' +
      '</div>' +
      (snippetsHTML ? '<div class="kf-principle-suggestion-snippets">' + snippetsHTML + '</div>' : '');

    var actions = document.createElement('div');
    actions.className = 'kf-principle-suggestion-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'kf-btn kf-btn-secondary';
    createBtn.textContent = 'Create Principle from this';
    createBtn.addEventListener('click', function(){ showPrinciplesFormView(null, s.phrase); });
    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'kf-btn kf-btn-ghost';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.title = 'Dismiss (this session only)';
    dismissBtn.addEventListener('click', function(){
      _dismissedSuggestionPhrases.add(s.phrase);
      renderPrincipleSuggestions(suggestions);
    });
    actions.appendChild(createBtn);
    actions.appendChild(dismissBtn);
    row.appendChild(actions);

    suggestionsEl.appendChild(row);
  });
}

function renderOrganisationLibraryRows(wide){
  var project = getCurrentProject();
  var libraryEl = document.getElementById('principlesLibraryList');
  libraryEl.innerHTML = '';
  if(wide.length === 0){
    libraryEl.innerHTML = '<div class="kf-releases-empty">No principles have been shared to the organisation yet.</div>';
    return;
  }
  wide.forEach(function(p){
    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(p.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(p.title) + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta"><span>From ' + escapeHTML(p.projectName) + '</span></div>';

    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'kf-btn kf-btn-secondary';
    copyBtn.textContent = 'Copy into this project';
    copyBtn.addEventListener('click', function(){ copyOrganisationPrincipleIntoProject(p.id); });
    row.appendChild(copyBtn);

    libraryEl.appendChild(row);
  });
}

async function copyOrganisationPrincipleIntoProject(principleId){
  var project = getCurrentProject();
  if(!project || !isServerAuthoritative(project)) return;
  try {
    await organisationPrincipleApi.copy(principleId, {targetProjectId: project.serverProjectId});
    await refreshProjectFromServer(project.id);
    toast('Copied into ' + project.name + '.');
  } catch(e){
    toast('Could not copy that principle: ' + (e.message || 'unknown error'));
  }
}

export function renderPrinciplesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('principlesList');
  listEl.innerHTML = '';
  if(!project) return;

  var allPrinciples = (project.principles || []).slice().sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allPrinciples.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No principles yet. Add one above to start guiding this project.</div>';
    return;
  }

  var term = ui.principlesSearchTerm.trim().toLowerCase();
  var principles = term ? allPrinciples.filter(function(p){
    var hay = [p.key, p.title, p.description].join(' ').toLowerCase();
    return hay.indexOf(term) !== -1;
  }) : allPrinciples;

  if(principles.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No principles match “' + escapeHTML(ui.principlesSearchTerm.trim()) + '”.</div>';
    return;
  }

  principles.forEach(function(p){
    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-principle-id', p.id);

    var metaHTML = '<span>Added ' + escapeHTML(utcISOToLocalDisplayDate(p.dateCreated)) + '</span>';

    var urlLinkHTML = p.documentUrl
      ? '<a class="kf-doc-row-link" href="' + escapeHTML(p.documentUrl) + '" target="_blank" rel="noopener noreferrer" title="Open ' + escapeHTML(p.documentUrl) + ' in a new tab" aria-label="Open document link in a new tab">' + iconSvg('externalLink', 14) + '</a>'
      : '';

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(p.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(p.title) + '</span>' +
        urlLinkHTML +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    var urlLinkEl = row.querySelector('.kf-doc-row-link');
    if(urlLinkEl) urlLinkEl.addEventListener('click', function(e){ e.stopPropagation(); });
    row.addEventListener('click', function(){ showPrinciplesFormView(p.id); });
    listEl.appendChild(row);
  });
}

export async function savePrincipleFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('principleTitleInput').value.trim();
  if(!title){ toast('Please enter a principle title.'); return; }

  var data = {
    title: title,
    description: getPrincipleDescEditor().getMarkdown(),
    documentUrl: document.getElementById('principleDocUrlInput').value
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingPrincipleId;
      if(editingId) await principleApi.update(project.serverProjectId, editingId, data);
      else await principleApi.create(project.serverProjectId, data);
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Principle updated.' : 'Principle created.');
      showPrinciplesListView();
    } catch(e){
      toast('Could not save principle on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingPrincipleId){
    updatePrinciple(project, ui.editingPrincipleId, data);
    toast('Principle updated.');
  } else {
    addPrinciple(project, data);
    toast('Principle created.');
  }
  showPrinciplesListView();
}

export function deletePrincipleFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingPrincipleId) return;
  var principle = getPrincipleById(project, ui.editingPrincipleId);
  if(!principle) return;
  confirmDialog(
    'Delete ' + principle.key + '?',
    'Any objectives, risks, or decisions linking to this principle will have the link removed.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await principleApi.remove(project.serverProjectId, principle.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + principle.key + '.');
          showPrinciplesListView();
        } catch(e){
          toast('Could not delete principle on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      var unlinked = deletePrinciple(project, principle.id);
      toast('Deleted ' + principle.key + (unlinked > 0 ? ' — removed ' + unlinked + ' link(s) from objectives/risks/decisions.' : '.'));
      showPrinciplesListView();
    }
  );
}
