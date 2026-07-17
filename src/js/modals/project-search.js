"use strict";
import { getCurrentProject } from '../store.js';
import { escapeHTML, canCurrentUserManageProject } from '../views/board.js';
import { hydrateIcons } from '../icons.js';
import { TEAM_COMMITTEE_TYPES } from '../config.js';
import { toast } from '../ui.js';
import { PROJECT_SEARCH_MIN_CHARS, buildProjectSearchGroups, buildSearchSnippetHTML } from '../features/project-search.js';
import { executeQuery, QueryError } from '../features/query-engine.js';
import { buildSchemaErdSvg } from '../features/schema-erd.js';
import { csvEscapeValue } from '../views/task-list.js';
import { openTaskModal } from './task.js';
import { openTeamModal } from './team.js';
import { openPrinciplesOverlay, showPrinciplesFormView } from './principles.js';
import { openObjectivesOverlay, showObjectivesFormView } from './objectives.js';
import { openDocumentsOverlay, showDocumentsFormView } from './documents.js';
import { openRisksOverlay, showRisksFormView } from './risks.js';
import { openDecisionsOverlay, showDecisionsFormView } from './decisions.js';
import { openTeamsCommitteesOverlay, showTeamCommitteeFormView } from './teams-committees.js';

var projectSearchDebounceId = null;
var lastQueryResult = null;

var PROJECT_SEARCH_GROUP_ICONS = {
  tasks: 'board', members: 'team', principles: 'compass', objectives: 'target',
  documents: 'ty_document', risks: 'warning', decisions: 'ty_approve',
  teamsCommittees: 'orgChart'
};

export function openProjectSearchOverlay(){
  var project = getCurrentProject();
  if(!project) return;
  document.getElementById('projectSearchInput').value = '';
  renderProjectSearchResults('');
  // Advanced Query tab is Project-Admin/Org-Admin-only — canCurrentUserManageProject() already
  // means "Project Admin OR Org Admin" (isProjectAdmin() short-circuits true for Org Admins
  // internally), same gate every other admin-only entry point in this app uses. Re-evaluated on
  // every open since admin status can change between opens.
  document.getElementById('projectSearchTabQueryBtn').classList.toggle('kf-vis-hidden', !canCurrentUserManageProject());
  showProjectSearchSimpleView();
  document.getElementById('projectSearchOverlay').classList.remove('hidden');
  document.getElementById('projectSearchInput').focus();
}

export function closeProjectSearchOverlay(){
  clearTimeout(projectSearchDebounceId);
  document.getElementById('projectSearchOverlay').classList.add('hidden');
}

export function isProjectSearchOverlayOpen(){
  return !document.getElementById('projectSearchOverlay').classList.contains('hidden');
}

export function getProjectSearchDebounceId(){ return projectSearchDebounceId; }
export function setProjectSearchDebounceId(id){ projectSearchDebounceId = id; }

function renderProjectSearchResults(rawTerm){
  var project = getCurrentProject();
  var resultsEl = document.getElementById('projectSearchResults');
  if(!project){ resultsEl.innerHTML = ''; return; }

  var term = rawTerm.trim();
  if(term.length < PROJECT_SEARCH_MIN_CHARS){
    resultsEl.innerHTML = '<div class="kf-search-empty">Type at least ' + PROJECT_SEARCH_MIN_CHARS + ' characters to search.</div>';
    return;
  }

  var groups = buildProjectSearchGroups(project, term).filter(function(g){ return g.results.length > 0; });
  if(groups.length === 0){
    resultsEl.innerHTML = '<div class="kf-search-empty">No results for "' + escapeHTML(term) + '".</div>';
    return;
  }

  resultsEl.innerHTML = groups.map(function(g){
    var rowsHTML = g.results.map(function(r){
      if(g.type === 'teamsCommittees'){
        var typePill = '<span class="kf-decision-type-pill">' + escapeHTML(TEAM_COMMITTEE_TYPES[r.tcType] || r.tcType) + '</span>';
        var parentLine = r.parentName ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">Parent:</span> ' + escapeHTML(r.parentName) + '</div>' : '';
        var membersLine = r.members.length > 0
          ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">Members:</span> ' + r.members.map(function(m){ return escapeHTML(m.name); }).join(', ') + '</div>'
          : '<div class="kf-search-result-snippet" style="color:var(--kf-text-faint);">No members</div>';
        var descSnippet = (r.match.label && r.match.label !== null)
          ? '<div class="kf-search-result-snippet"><span class="kf-search-result-field-label">' + escapeHTML(r.match.label) + ':</span> ' + buildSearchSnippetHTML(r.match.value, term) + '</div>'
          : '';
        return '<div class="kf-search-result-row" data-result-type="teamsCommittees" data-result-id="' + r.id + '">' +
          '<div class="kf-search-result-top">' +
            '<a class="kf-search-result-link" data-result-type="teamsCommittees" data-result-id="' + r.id + '">' + escapeHTML(r.title) + '</a>' +
            typePill +
          '</div>' +
          parentLine + membersLine + descSnippet +
        '</div>';
      }
      var fieldLabelHTML = r.match.label ? '<span class="kf-search-result-field-label">' + escapeHTML(r.match.label) + ':</span> ' : '';
      var snippetHTML = buildSearchSnippetHTML(r.match.value, term);
      return '<div class="kf-search-result-row" data-result-type="' + g.type + '" data-result-id="' + r.id + '">' +
        '<div class="kf-search-result-top">' +
          '<a class="kf-search-result-link" data-result-type="' + g.type + '" data-result-id="' + r.id + '">' + escapeHTML(r.title) + '</a>' +
          (r.archived ? '<span class="kf-search-archived-badge">Archived</span>' : '') +
        '</div>' +
        '<div class="kf-search-result-snippet">' + fieldLabelHTML + snippetHTML + '</div>' +
      '</div>';
    }).join('');
    var moreNote = g.total > g.results.length ? '<div class="kf-search-more-note">+' + (g.total - g.results.length) + ' more in ' + escapeHTML(g.label) + '</div>' : '';
    return '<div class="kf-search-group">' +
      '<h3 class="kf-search-group-title"><span class="kf-icon" data-icon="' + PROJECT_SEARCH_GROUP_ICONS[g.type] + '" data-size="13"></span>' + escapeHTML(g.label) + ' (' + g.total + ')</h3>' +
      rowsHTML + moreNote +
    '</div>';
  }).join('');
  hydrateIcons(resultsEl);
}

export function handleProjectSearchInput(value){
  clearTimeout(projectSearchDebounceId);
  projectSearchDebounceId = setTimeout(function(){ renderProjectSearchResults(value); }, 200);
}

export function handleProjectSearchResultClick(e){
  var link = e.target.closest('.kf-search-result-link, .kf-search-result-row');
  if(!link) return;
  e.preventDefault();
  var type = link.getAttribute('data-result-type');
  var id = link.getAttribute('data-result-id');
  if(!type || !id) return;

  var project = getCurrentProject();
  if(!project) return;
  closeProjectSearchOverlay();
  if(type === 'tasks'){
    var task = project.tasks[id];
    if(task) openTaskModal(id, task.columnId);
  } else if(type === 'members'){
    openTeamModal();
  } else if(type === 'principles'){
    openPrinciplesOverlay();
    showPrinciplesFormView(id);
  } else if(type === 'objectives'){
    openObjectivesOverlay();
    showObjectivesFormView(id);
  } else if(type === 'documents'){
    openDocumentsOverlay();
    showDocumentsFormView(id);
  } else if(type === 'risks'){
    openRisksOverlay();
    showRisksFormView(id);
  } else if(type === 'decisions'){
    openDecisionsOverlay();
    showDecisionsFormView(id);
  } else if(type === 'teamsCommittees'){
    openTeamsCommitteesOverlay();
    showTeamCommitteeFormView(id);
  }
}

/* =========================================================
   ADVANCED QUERY (Project-Admin/Org-Admin only)
   Two-view toggle modeled on modals/releases.js's showReleasesListView()/showReleasesFormView()
   pattern (title/footer swap, .hidden class toggle) — not a new tab-widget component.
   ========================================================= */

export function showProjectSearchSimpleView(){
  document.getElementById('projectSearchTabSearchBtn').classList.add('active');
  document.getElementById('projectSearchTabQueryBtn').classList.remove('active');
  document.getElementById('projectSearchSimpleView').classList.remove('hidden');
  document.getElementById('projectSearchQueryView').classList.add('hidden');
  document.getElementById('projectSearchSimpleFooter').classList.remove('hidden');
  document.getElementById('projectSearchQueryFooter').classList.add('hidden');
}

export function showProjectSearchQueryView(){
  // Defense in depth, matching project-storage.js's openProjectStorageModal() — not just relying on
  // the tab button being hidden — in case this is ever invoked directly while ungated.
  if(!canCurrentUserManageProject()){
    toast('Only a Project Administrator or Org Admin can run advanced queries.');
    return;
  }
  document.getElementById('projectSearchTabSearchBtn').classList.remove('active');
  document.getElementById('projectSearchTabQueryBtn').classList.add('active');
  document.getElementById('projectSearchSimpleView').classList.add('hidden');
  document.getElementById('projectSearchQueryView').classList.remove('hidden');
  document.getElementById('projectSearchSimpleFooter').classList.add('hidden');
  document.getElementById('projectSearchQueryFooter').classList.remove('hidden');
  document.getElementById('projectQuerySql').focus();
}

export function toggleProjectQuerySchemaPanel(){
  var panel = document.getElementById('projectQuerySchemaPanel');
  var willShow = panel.classList.contains('hidden');
  // Regenerated fresh every time the panel opens, straight from query-engine.js's own
  // TABLE_SCHEMAS/TABLE_RELATIONSHIPS — never a stale cached diagram.
  if(willShow) panel.innerHTML = buildSchemaErdSvg();
  panel.classList.toggle('hidden', !willShow);
}

function renderQueryResultsTable(result){
  var wrap = document.getElementById('projectQueryResultsWrap');
  var rowCountEl = document.getElementById('projectQueryRowCount');
  if(result.rows.length === 0){
    wrap.innerHTML = '<div class="kf-search-empty">Query ran successfully — 0 rows returned.</div>';
    rowCountEl.textContent = '';
    return;
  }
  rowCountEl.textContent = result.rows.length + (result.rows.length === 1 ? ' row' : ' rows');
  var theadHTML = '<thead><tr>' + result.columns.map(function(c){ return '<th>' + escapeHTML(c) + '</th>'; }).join('') + '</tr></thead>';
  var tbodyHTML = '<tbody>' + result.rows.map(function(row){
    return '<tr>' + result.columns.map(function(c){
      var v = row[c];
      return '<td>' + escapeHTML(v == null ? '' : String(v)) + '</td>';
    }).join('') + '</tr>';
  }).join('') + '</tbody>';
  wrap.innerHTML = '<table class="kf-query-results-table">' + theadHTML + tbodyHTML + '</table>';
}

export function runProjectQuery(){
  var project = getCurrentProject();
  var sql = document.getElementById('projectQuerySql').value;
  var errorEl = document.getElementById('projectQueryError');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  try {
    lastQueryResult = executeQuery(project, sql);
    renderQueryResultsTable(lastQueryResult);
  } catch(e){
    lastQueryResult = null;
    document.getElementById('projectQueryResultsWrap').innerHTML = '';
    document.getElementById('projectQueryRowCount').textContent = '';
    errorEl.textContent = e instanceof QueryError ? e.message : ('Unexpected error: ' + (e && e.message ? e.message : e));
    errorEl.classList.remove('hidden');
  }
}

// Same Blob + <a download> technique as views/task-list.js's exportTaskListAsCsv() /
// features/svg-export.js's PNG export — each keeps its own tiny copy of this rather than sharing one,
// matching this codebase's existing convention.
function downloadBlob(blob, filename){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportProjectQueryResultsAsCsv(){
  if(!lastQueryResult || lastQueryResult.rows.length === 0){
    toast('Run a query with results first.');
    return;
  }
  var project = getCurrentProject();
  var lines = [lastQueryResult.columns.map(csvEscapeValue).join(',')];
  lastQueryResult.rows.forEach(function(row){
    lines.push(lastQueryResult.columns.map(function(c){ return csvEscapeValue(row[c]); }).join(','));
  });
  var blob = new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  var filename = (project ? project.key : 'query') + '-query-' + new Date().toISOString().slice(0,10) + '.csv';
  downloadBlob(blob, filename);
  toast('Exported ' + filename);
}

export function printProjectQueryResults(){
  window.print();
}
