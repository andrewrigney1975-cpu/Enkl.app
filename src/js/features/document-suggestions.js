"use strict";
import { htmlToMarkdown } from '../rich-text/markdown.js';

/* =========================================================
   RELATED-DOCUMENT SUGGESTIONS
   Runs project.documents through keyword-worker.js (a plain,
   dependency-free Web Worker — see src/js/workers/keyword-worker.js)
   to pre-check likely related documents in the "Related
   document(s)" picker while a title/description is being written.

   The worker has no fetchable file to load from — this app builds
   to a single self-contained HTML file (see build.js) — so its
   source is embedded at build time as inert text in a
   <script type="javascript/worker" id="keywordWorkerSource"> tag
   and turned into a real classic Worker here via a Blob URL, which
   works under both http(s):// and file:// origins.
   ========================================================= */

var DOC_SUGGESTIONS_DEBOUNCE_MS = 500;
var DOC_SUGGESTIONS_DEBUG = false;

var worker = null;
var workerBlobUrl = null;
var debounceTimeoutId = null;
var rejectedIds = new Set();
var changeListenerBound = false;

function ensurePickerChangeListener(){
  if(changeListenerBound) return;
  var wrap = document.getElementById('documentRelatedPicker');
  if(!wrap) return;
  wrap.addEventListener('change', function(e){
    var cb = e.target.closest('input[data-doc-id]');
    if(!cb || cb.checked) return;
    /* Programmatic pre-checks never fire `change` — only a genuine
       user click does — so this only ever records an explicit,
       user-driven uncheck. */
    rejectedIds.add(cb.getAttribute('data-doc-id'));
  });
  changeListenerBound = true;
}

function getKeywordWorker(){
  if(worker) return worker;
  if(typeof Worker === 'undefined') return null;
  var sourceEl = document.getElementById('keywordWorkerSource');
  if(!sourceEl) return null;
  var blob = new Blob([sourceEl.textContent], {type: 'application/javascript'});
  workerBlobUrl = URL.createObjectURL(blob);
  worker = new Worker(workerBlobUrl);
  worker.onerror = function(){ /* non-critical assist feature — fail silently */ };
  return worker;
}

export function disposeDocumentSuggestionWorker(){
  if(debounceTimeoutId){ clearTimeout(debounceTimeoutId); debounceTimeoutId = null; }
  if(worker){ worker.terminate(); worker = null; }
  if(workerBlobUrl){ URL.revokeObjectURL(workerBlobUrl); workerBlobUrl = null; }
  rejectedIds = new Set();
}

function applySuggestions(project, rankedDocuments){
  var keyToId = {};
  (project.documents || []).forEach(function(d){ keyToId[d.key] = d.id; });

  rankedDocuments.forEach(function(suggestion){
    var docId = keyToId[suggestion.id];
    if(!docId || rejectedIds.has(docId)) return;
    var cb = document.querySelector('#documentRelatedPicker input[data-doc-id="' + docId + '"]');
    if(cb && !cb.checked) cb.checked = true;
  });
}

export function scheduleDocumentSuggestions(project, excludeDocId){
  if(!project) return;
  ensurePickerChangeListener();
  if(debounceTimeoutId) clearTimeout(debounceTimeoutId);
  debounceTimeoutId = setTimeout(function(){
    debounceTimeoutId = null;
    var title = (document.getElementById('documentTitleInput').value || '').trim();
    var description = htmlToMarkdown(document.getElementById('documentDescEditor')).trim();
    if(!title || !description) return;

    var kw = getKeywordWorker();
    if(!kw) return;

    var comparisonDocs = (project.documents || [])
      .filter(function(d){ return d.id !== excludeDocId; })
      .map(function(d){ return {id: d.key, title: d.title, description: d.description}; });

    var request = {sourceDoc: {title: title, description: description}, comparisonDocs: comparisonDocs};

    kw.onmessage = function(e){
      if(DOC_SUGGESTIONS_DEBUG) console.log('[document-suggestions] response payload:', e.data);
      applySuggestions(project, (e.data && e.data.rankedDocuments) || []);
    };
    if(DOC_SUGGESTIONS_DEBUG) console.log('[document-suggestions] calling keyword-worker with request payload:', request);
    kw.postMessage(request);
  }, DOC_SUGGESTIONS_DEBOUNCE_MS);
}
