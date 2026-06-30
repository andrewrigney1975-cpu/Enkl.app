"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg } from '../icons.js';
import { memberInitials, utcISOToLocalDateValue, utcISOToLocalDisplayDate } from '../date-utils.js';
import { getMemberById, getTasksArray, getDocumentById } from '../utils.js';
import { addDocument, updateDocument, deleteDocument, normalizeDocumentationUrl } from '../mutations.js';
import { renderDocumentPickerInto, getCheckedDocumentIdsFrom } from './pickers.js';
import { confirmDialog } from './confirm.js';

export function updateDocUrlOpenButtonVisibilityFor(inputId, btnId){
  var hasValue = document.getElementById(inputId).value.trim().length > 0;
  document.getElementById(btnId).classList.toggle('hidden', !hasValue);
}
export function openUrlInputInNewTab(inputId){
  var url = normalizeDocumentationUrl(document.getElementById(inputId).value);
  if(!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function populateOwnerSelect(selectEl, project, currentOwnerId){
  selectEl.innerHTML = '<option value="">Unassigned</option>';
  (project.members || []).forEach(function(m){
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentOwnerId || '';
}
export function populateTaskSelect(selectEl, project, currentTaskId){
  selectEl.innerHTML = '<option value="">No task linked</option>';
  getTasksArray(project).filter(function(t){ return !t.archived; }).forEach(function(t){
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.key + ' — ' + t.title;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentTaskId || '';
}

export function openDocumentsOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  ui.documentsSearchTerm = '';
  document.getElementById('documentsSearchInput').value = '';
  showDocumentsListView();
  document.getElementById('documentsOverlay').classList.remove('hidden');
}
export function closeDocumentsOverlay(){
  document.getElementById('documentsOverlay').classList.add('hidden');
}
export function isDocumentsOverlayOpen(){
  return !document.getElementById('documentsOverlay').classList.contains('hidden');
}

export function showDocumentsListView(){
  ui.editingDocumentId = null;
  document.getElementById('documentsModalTitle').textContent = 'Documents';
  document.getElementById('documentsListView').classList.remove('hidden');
  document.getElementById('documentsFormView').classList.add('hidden');
  document.getElementById('documentsListFooter').classList.remove('hidden');
  document.getElementById('documentsFormFooter').classList.add('hidden');
  renderDocumentsList();
}

export function showDocumentsFormView(docId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingDocumentId = docId || null;
  var doc = docId ? getDocumentById(project, docId) : null;

  document.getElementById('documentsModalTitle').textContent = doc ? 'Edit Document' : 'New Document';
  document.getElementById('documentsListView').classList.add('hidden');
  document.getElementById('documentsFormView').classList.remove('hidden');
  document.getElementById('documentsListFooter').classList.add('hidden');
  document.getElementById('documentsFormFooter').classList.remove('hidden');
  document.getElementById('deleteDocumentBtn').classList.toggle('hidden', !doc);

  document.getElementById('documentTitleInput').value = doc ? doc.title : '';
  document.getElementById('documentUrlInput').value = doc && doc.url ? doc.url : '';
  updateDocUrlOpenButtonVisibilityFor('documentUrlInput', 'documentUrlOpenBtn');
  document.getElementById('documentDescriptionInput').value = doc ? doc.description : '';
  populateOwnerSelect(document.getElementById('documentOwnerSelect'), project, doc ? doc.ownerId : null);
  populateTaskSelect(document.getElementById('documentTaskSelect'), project, doc ? doc.taskId : null);
  renderDocumentPickerInto('documentRelatedPicker', project, doc ? doc.relatedDocumentIds : [], docId || null);

  var metaEl = document.getElementById('documentMetaDates');
  if(doc){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(doc.dateCreated) +
      (doc.dateLastModified && doc.dateLastModified !== doc.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(doc.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }
  document.getElementById('documentTitleInput').focus();
}

export function renderDocumentsList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('documentsList');
  listEl.innerHTML = '';
  if(!project) return;

  var allDocs = (project.documents || []).slice().sort(function(a, b){
    return a.key.localeCompare(b.key, undefined, {numeric: true});
  });

  if(allDocs.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No documents yet. Add one above to start building this project\'s document register.</div>';
    return;
  }

  var term = ui.documentsSearchTerm.trim().toLowerCase();
  var docs = term ? allDocs.filter(function(d){
    var owner = getMemberById(project, d.ownerId);
    var hay = [d.key, d.title, d.description, owner ? owner.name : ''].join(' ').toLowerCase();
    return hay.indexOf(term) !== -1;
  }) : allDocs;

  if(docs.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No documents match “' + escapeHTML(ui.documentsSearchTerm.trim()) + '”.</div>';
    return;
  }

  docs.forEach(function(d){
    var owner = getMemberById(project, d.ownerId);
    var linkedTask = d.taskId ? project.tasks[d.taskId] : null;

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-document-id', d.id);

    var metaHTML = '';
    if(owner){
      metaHTML += '<span class="kf-avatar kf-avatar-sm" style="background:' + owner.color + ';">' + escapeHTML(memberInitials(owner.name)) + '</span><span>' + escapeHTML(owner.name) + '</span>';
    } else {
      metaHTML += '<span>Unassigned</span>';
    }
    metaHTML += '<span>Added ' + escapeHTML(utcISOToLocalDisplayDate(d.dateCreated)) + '</span>';
    if(linkedTask) metaHTML += '<span>' + escapeHTML(linkedTask.key) + '</span>';
    if(d.relatedDocumentIds && d.relatedDocumentIds.length > 0){
      metaHTML += '<span>' + d.relatedDocumentIds.length + ' related</span>';
    }

    var urlLinkHTML = d.url
      ? '<a class="kf-doc-row-link" href="' + escapeHTML(d.url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + escapeHTML(d.url) + ' in a new tab" aria-label="Open document link in a new tab">' + iconSvg('externalLink', 14) + '</a>'
      : '';

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(d.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(d.title) + '</span>' +
        urlLinkHTML +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    var urlLinkEl = row.querySelector('.kf-doc-row-link');
    if(urlLinkEl){
      urlLinkEl.addEventListener('click', function(e){ e.stopPropagation(); });
    }
    row.addEventListener('click', function(){ showDocumentsFormView(d.id); });
    listEl.appendChild(row);
  });
}

export function saveDocumentFromModal(){
  var project = getCurrentProject();
  if(!project) return;
  var title = document.getElementById('documentTitleInput').value.trim();
  if(!title){ toast('Please enter a document title.'); return; }

  var data = {
    title: title,
    url: document.getElementById('documentUrlInput').value,
    description: document.getElementById('documentDescriptionInput').value,
    ownerId: document.getElementById('documentOwnerSelect').value || null,
    taskId: document.getElementById('documentTaskSelect').value || null,
    relatedDocumentIds: getCheckedDocumentIdsFrom('documentRelatedPicker')
  };

  if(ui.editingDocumentId){
    updateDocument(project, ui.editingDocumentId, data);
    toast('Document updated.');
  } else {
    addDocument(project, data);
    toast('Document created.');
  }
  showDocumentsListView();
}

export function deleteDocumentFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingDocumentId) return;
  var doc = getDocumentById(project, ui.editingDocumentId);
  if(!doc) return;
  confirmDialog(
    'Delete ' + doc.key + '?',
    'Any risks or decisions linking to this document will have the link removed.',
    function(){
      var unlinked = deleteDocument(project, doc.id);
      toast('Deleted ' + doc.key + (unlinked > 0 ? ' — removed ' + unlinked + ' link(s) from risks/decisions.' : '.'));
      showDocumentsListView();
    }
  );
}
