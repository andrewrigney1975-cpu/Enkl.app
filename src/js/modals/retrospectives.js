"use strict";
import { ui, toast } from '../ui.js';
import { getCurrentProject } from '../store.js';
import { escapeHTML } from '../views/board.js';
import { iconSvg } from '../icons.js';
import { utcISOToLocalDateValue, localDateValueToUTCISO, utcISOToLocalDisplayDate, isoToServerDateOnly } from '../date-utils.js';
import { getReleaseById, getRetrospectiveById, getRetrospectiveItemById, memberLabel } from '../utils.js';
import { isRetrospectiveEnabled } from '../storage.js';
import {
  addRetrospective, updateRetrospective, deleteRetrospective,
  addRetrospectiveItem, deleteRetrospectiveItem,
  addRetrospectiveActionItem, updateRetrospectiveActionItem, deleteRetrospectiveActionItem
} from '../mutations.js';
import { renderMemberPickerInto, getCheckedItemIdsFrom } from './pickers.js';
import { confirmDialog } from './confirm.js';
import { retrospectiveApi } from '../api.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';
import { mountCountdownTimer } from '../features/countdown-timer.js';

/* The 3 fixed board columns — not user-configurable, unlike the main Kanban board's columns (see
   views/board.js) — a Retrospective's shape is always Start/Stop/Keep. Board items in the "start" and
   "keep" columns are eligible for "Promote to Principle"; "stop" items aren't (there's nothing worth
   distilling into a guiding Principle out of something the team wants to stop doing). */
var RETRO_COLUMNS = [
  {key: 'start', label: 'Start doing'},
  {key: 'stop', label: 'Stop doing'},
  {key: 'keep', label: 'Keep doing'}
];
var PROMOTABLE_COLUMNS = {start: true, keep: true};

/* Static instructional content for the "How this works" collapsible panel — hardcoded here (not
   per-instance data), rendered once the first time the panel is shown. */
var HOW_IT_WORKS_HTML =
  '<ol class="kf-retro-howto-list">' +
    '<li><strong>Set up the Retro.</strong> Get the team together regularly — ' +
      'at a release, quarterly or something that works for everyone in the project.</li>' +
    '<li><strong>Clearly define the why.</strong> Before the Retro, fill in the information so ' +
      'everyone understands why you\'re doing this, and ' +
      'call out what\'s going to happen (the process).</li>' +
    '<li><strong>Use the timer.</strong> These things can take on a life of their own. ' +
      'Opinions, constructive criticism and suggested improvements are needed for this to work - use the timer to keep it meaningful ' +
      'and on-track.</li>' +
  '</ol>';

var _retroTimer = null;
function ensureRetroTimerMounted(){
  if(_retroTimer) return _retroTimer;
  _retroTimer = mountCountdownTimer({
    display: 'retroTimerDisplay',
    startBtn: 'retroTimerStartBtn',
    resetBtn: 'retroTimerResetBtn',
    presetWrap: 'retroTimerPresetWrap',
    customInput: 'retroTimerCustomInput',
    setCustomBtn: 'retroTimerSetCustomBtn'
  });
  return _retroTimer;
}

export function openRetrospectivesOverlay(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }
  if(!isRetrospectiveEnabled(project)){
    toast('The Retrospective module is turned off for this project — enable it from Project Settings first.');
    return;
  }
  showRetrospectivesListView();
  document.getElementById('retrospectivesOverlay').classList.remove('hidden');
}
export function closeRetrospectivesOverlay(){
  document.getElementById('retrospectivesOverlay').classList.add('hidden');
}
export function isRetrospectivesOverlayOpen(){
  return !document.getElementById('retrospectivesOverlay').classList.contains('hidden');
}

function setRetrospectivesView(view){
  document.getElementById('retrospectivesListView').classList.toggle('hidden', view !== 'list');
  document.getElementById('retrospectivesFormView').classList.toggle('hidden', view !== 'form');
  document.getElementById('retrospectivesPromoteView').classList.toggle('hidden', view !== 'promote');
  document.getElementById('retrospectivesListFooter').classList.toggle('hidden', view !== 'list');
  document.getElementById('retrospectivesFormFooter').classList.toggle('hidden', view !== 'form');
  document.getElementById('retrospectivesPromoteFooter').classList.toggle('hidden', view !== 'promote');
}

export function showRetrospectivesListView(){
  ui.editingRetrospectiveId = null;
  ui.retroPromotingItemId = null;
  document.getElementById('retrospectivesModalTitle').textContent = 'Retrospectives';
  setRetrospectivesView('list');
  renderRetrospectivesList();
}

export function showRetrospectivesFormView(retrospectiveId){
  var project = getCurrentProject();
  if(!project) return;
  ui.editingRetrospectiveId = retrospectiveId || null;
  ui.retroPromotingItemId = null;
  var retro = retrospectiveId ? getRetrospectiveById(project, retrospectiveId) : null;

  document.getElementById('retrospectivesModalTitle').textContent = retro ? ('Edit Retrospective — ' + retro.key) : 'New Retrospective';
  setRetrospectivesView('form');
  document.getElementById('deleteRetrospectiveBtn').classList.toggle('hidden', !retro);

  document.getElementById('retroTeamInput').value = (retro && retro.team) ? retro.team : '';
  document.getElementById('retroBackgroundInput').value = (retro && retro.background) ? retro.background : '';
  document.getElementById('retroDateInput').value = retro ? utcISOToLocalDateValue(retro.retroDate) : '';

  var hasReleases = (project.releases || []).length > 0;
  document.getElementById('retroReleaseFieldWrap').classList.toggle('hidden', !hasReleases);
  if(hasReleases) populateRetroReleaseSelect(project, retro ? retro.releaseId : null);

  renderMemberPickerInto('retroParticipantsPicker', project.members, retro ? retro.participantIds : []);

  var howToPanel = document.getElementById('retroHowItWorksPanel');
  if(!howToPanel.innerHTML) howToPanel.innerHTML = HOW_IT_WORKS_HTML;
  howToPanel.classList.add('hidden');
  document.getElementById('retroHowItWorksToggleBtn').setAttribute('aria-expanded', 'false');

  var timer = ensureRetroTimerMounted();
  timer.setDefaultDurationSeconds(retro && retro.lastTimerDurationSeconds ? retro.lastTimerDurationSeconds : 300);

  var metaEl = document.getElementById('retroMetaDates');
  if(retro){
    metaEl.textContent = 'Added ' + utcISOToLocalDisplayDate(retro.dateCreated) +
      (retro.dateLastModified && retro.dateLastModified !== retro.dateCreated ? ' · Last changed ' + utcISOToLocalDisplayDate(retro.dateLastModified) : '');
    metaEl.style.display = '';
  } else {
    metaEl.textContent = '';
    metaEl.style.display = 'none';
  }

  renderRetroBoard();
  renderRetroActionItems();
  document.getElementById('retroTeamInput').focus();
}

export function toggleRetroHowItWorks(){
  var panel = document.getElementById('retroHowItWorksPanel');
  var btn = document.getElementById('retroHowItWorksToggleBtn');
  var isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !isHidden);
  btn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
}

function populateRetroReleaseSelect(project, currentReleaseId){
  var sel = document.getElementById('retroReleaseSelect');
  sel.innerHTML = '';
  var noReleaseOpt = document.createElement('option');
  noReleaseOpt.value = '';
  noReleaseOpt.textContent = 'No release';
  sel.appendChild(noReleaseOpt);
  (project.releases || []).slice().sort(function(a, b){
    return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
  }).forEach(function(r){
    var opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if(currentReleaseId === r.id) opt.selected = true;
    sel.appendChild(opt);
  });
  if(!currentReleaseId) noReleaseOpt.selected = true;
}

export function renderRetrospectivesList(){
  var project = getCurrentProject();
  var listEl = document.getElementById('retrospectivesList');
  listEl.innerHTML = '';
  if(!project) return;

  var retros = (project.retrospectives || []).slice().sort(function(a, b){
    return b.key.localeCompare(a.key, undefined, {numeric: true});
  });

  if(retros.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No retrospectives yet. Create one above to start reflecting as a team.</div>';
    return;
  }

  retros.forEach(function(r){
    var release = getReleaseById(project, r.releaseId);
    var openActionCount = (r.actionItems || []).filter(function(ai){ return !ai.completed; }).length;

    var row = document.createElement('div');
    row.className = 'kf-release-row';
    row.setAttribute('data-retrospective-id', r.id);

    var metaHTML = '';
    if(r.retroDate) metaHTML += '<span>' + escapeHTML(utcISOToLocalDisplayDate(r.retroDate)) + '</span>';
    if(release) metaHTML += '<span>' + escapeHTML(release.name) + '</span>';
    metaHTML += '<span>' + (r.participantIds || []).length + ' participant(s)</span>';
    if(openActionCount > 0) metaHTML += '<span>' + openActionCount + ' open action item(s)</span>';

    row.innerHTML =
      '<div class="kf-release-row-top">' +
        '<span class="kf-dep-key">' + escapeHTML(r.key) + '</span>' +
        '<span class="kf-release-name">' + escapeHTML(r.team || 'Untitled retrospective') + '</span>' +
      '</div>' +
      '<div class="kf-release-row-meta">' + metaHTML + '</div>';

    row.addEventListener('click', function(){ showRetrospectivesFormView(r.id); });
    listEl.appendChild(row);
  });
}

export async function saveRetrospectiveFromModal(){
  var project = getCurrentProject();
  if(!project) return;

  var team = document.getElementById('retroTeamInput').value;
  var background = document.getElementById('retroBackgroundInput').value;
  var retroDateISO = localDateValueToUTCISO(document.getElementById('retroDateInput').value);
  var releaseFieldVisible = !document.getElementById('retroReleaseFieldWrap').classList.contains('hidden');
  var releaseId = releaseFieldVisible ? (document.getElementById('retroReleaseSelect').value || null) : null;
  var participantIds = getCheckedItemIdsFrom('retroParticipantsPicker');
  var lastTimerDurationSeconds = _retroTimer ? _retroTimer.getLastDurationSeconds() : null;

  var data = {
    releaseId: releaseId, team: team, background: background, retroDate: retroDateISO,
    participantIds: participantIds, lastTimerDurationSeconds: lastTimerDurationSeconds
  };

  if(isServerAuthoritative(project)){
    try {
      var editingId = ui.editingRetrospectiveId;
      var body = {
        releaseId: data.releaseId, team: (team || '').trim() || null, background: (background || '').trim() || null,
        retroDate: isoToServerDateOnly(data.retroDate), participantIds: data.participantIds
      };
      if(editingId){
        body.lastTimerDurationSeconds = data.lastTimerDurationSeconds;
        await retrospectiveApi.update(project.serverProjectId, editingId, body);
      } else {
        await retrospectiveApi.create(project.serverProjectId, body);
      }
      await refreshProjectFromServer(project.id);
      toast(editingId ? 'Retrospective updated.' : 'Retrospective created.');
      showRetrospectivesListView();
    } catch(e){
      toast('Could not save retrospective on the server: ' + (e.message || 'unknown error'));
    }
    return;
  }

  if(ui.editingRetrospectiveId){
    updateRetrospective(project, ui.editingRetrospectiveId, data);
    toast('Retrospective updated.');
  } else {
    addRetrospective(project, data);
    toast('Retrospective created.');
  }
  showRetrospectivesListView();
}

export function deleteRetrospectiveFromModal(){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  var retro = getRetrospectiveById(project, ui.editingRetrospectiveId);
  if(!retro) return;
  confirmDialog(
    'Delete ' + retro.key + '?',
    'Its board items and action items will be permanently deleted.',
    async function(){
      if(isServerAuthoritative(project)){
        try {
          await retrospectiveApi.remove(project.serverProjectId, retro.id);
          await refreshProjectFromServer(project.id);
          toast('Deleted ' + retro.key + '.');
          showRetrospectivesListView();
        } catch(e){
          toast('Could not delete retrospective on the server: ' + (e.message || 'unknown error'));
        }
        return;
      }
      deleteRetrospective(project, retro.id);
      toast('Deleted ' + retro.key + '.');
      showRetrospectivesListView();
    }
  );
}

/* =========================================================
   BOARD (Start doing / Stop doing / Keep doing)
   Rebuilt from scratch on every render (same pattern as views/board.js's
   renderColumn/renderCard) — each row wires its own delete/promote
   handlers inline rather than relying on static ids, since there can be
   any number of rows across the 3 fixed columns.
   ========================================================= */
export function renderRetroBoard(){
  var project = getCurrentProject();
  var wrap = document.getElementById('retroBoardColumns');
  wrap.innerHTML = '';
  var retro = (project && ui.editingRetrospectiveId) ? getRetrospectiveById(project, ui.editingRetrospectiveId) : null;

  document.getElementById('retroBoardUnsavedNote').classList.toggle('hidden', !!retro);
  var canPromote = isServerAuthoritative(project);
  document.getElementById('retroLocalOnlyNote').classList.toggle('hidden', !retro || canPromote);
  if(!retro) return;

  RETRO_COLUMNS.forEach(function(colDef){
    var col = document.createElement('div');
    col.className = 'kf-retro-column';

    var items = retro.items.filter(function(it){ return it.column === colDef.key; })
      .slice().sort(function(a, b){ return (a.sortOrder||0) - (b.sortOrder||0); });

    var header = document.createElement('div');
    header.className = 'kf-retro-column-header';
    header.innerHTML = '<span>' + escapeHTML(colDef.label) + '</span><span class="kf-count-badge">' + items.length + '</span>';
    col.appendChild(header);

    var list = document.createElement('div');
    list.className = 'kf-retro-column-list';
    items.forEach(function(item){
      var row = document.createElement('div');
      row.className = 'kf-retro-item-row';

      var textSpan = document.createElement('span');
      textSpan.className = 'kf-retro-item-text';
      textSpan.textContent = item.text;
      row.appendChild(textSpan);

      var actions = document.createElement('div');
      actions.className = 'kf-retro-item-actions';

      if(PROMOTABLE_COLUMNS[colDef.key] && canPromote){
        if(item.promotedPrincipleId){
          var promotedTag = document.createElement('span');
          promotedTag.className = 'kf-retro-promoted-tag';
          promotedTag.title = 'Promoted to a Principle';
          promotedTag.innerHTML = iconSvg('compass', 13);
          actions.appendChild(promotedTag);
        } else {
          var promoteBtn = document.createElement('button');
          promoteBtn.type = 'button';
          promoteBtn.className = 'kf-btn kf-btn-ghost';
          promoteBtn.title = 'Promote to Principle';
          promoteBtn.setAttribute('aria-label', 'Promote to Principle');
          promoteBtn.innerHTML = iconSvg('compass', 14);
          promoteBtn.addEventListener('click', function(){ showRetroPromoteView(item.id); });
          actions.appendChild(promoteBtn);
        }
      }

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'kf-btn kf-btn-ghost';
      delBtn.title = 'Delete item';
      delBtn.setAttribute('aria-label', 'Delete item');
      delBtn.innerHTML = iconSvg('trash', 14);
      delBtn.addEventListener('click', function(){ deleteRetroItem(item.id); });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
    col.appendChild(list);

    var addRow = document.createElement('div');
    addRow.className = 'kf-retro-add-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1000;
    input.placeholder = 'Add an item...';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'kf-btn kf-btn-secondary';
    addBtn.innerHTML = iconSvg('plus', 14);
    addBtn.title = 'Add item';
    function submitAdd(){
      var text = input.value.trim();
      if(!text) return;
      addRetroItem(colDef.key, text);
      input.value = '';
    }
    addBtn.addEventListener('click', submitAdd);
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); submitAdd(); } });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    col.appendChild(addRow);

    wrap.appendChild(col);
  });
}

async function addRetroItem(column, text){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  if(isServerAuthoritative(project)){
    try {
      await retrospectiveApi.createItem(project.serverProjectId, ui.editingRetrospectiveId, {column: column, text: text});
      await refreshProjectFromServer(project.id);
    } catch(e){
      toast('Could not add item on the server: ' + (e.message || 'unknown error'));
      return;
    }
  } else {
    addRetrospectiveItem(project, ui.editingRetrospectiveId, {column: column, text: text});
  }
  renderRetroBoard();
}

async function deleteRetroItem(itemId){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  if(isServerAuthoritative(project)){
    try {
      await retrospectiveApi.removeItem(project.serverProjectId, ui.editingRetrospectiveId, itemId);
      await refreshProjectFromServer(project.id);
    } catch(e){
      toast('Could not delete item on the server: ' + (e.message || 'unknown error'));
      return;
    }
  } else {
    deleteRetrospectiveItem(project, ui.editingRetrospectiveId, itemId);
  }
  renderRetroBoard();
}

/* =========================================================
   PROMOTE TO PRINCIPLE
   A lightweight equivalent of modals/principles.js's own create form,
   scoped to this overlay (rather than opening the Principles modal on
   top of this one) — pre-filled per the feature spec, but always
   editable before saving. Only ever reachable when isServerAuthoritative
   (the board hides the Promote button entirely otherwise), but every
   handler still checks defensively.
   ========================================================= */
function showRetroPromoteView(itemId){
  var project = getCurrentProject();
  var retro = getRetrospectiveById(project, ui.editingRetrospectiveId);
  var item = retro ? getRetrospectiveItemById(retro, itemId) : null;
  if(!item) return;
  ui.retroPromotingItemId = itemId;
  document.getElementById('retroPromoteTitleInput').value = item.text.slice(0, 120);
  document.getElementById('retroPromoteDescriptionInput').value =
    'Distilled from ' + retro.key + ' — ' + (retro.team || (retro.retroDate ? utcISOToLocalDisplayDate(retro.retroDate) : ''));
  setRetrospectivesView('promote');
  document.getElementById('retroPromoteTitleInput').focus();
}

export function cancelRetroPromoteFromModal(){
  ui.retroPromotingItemId = null;
  setRetrospectivesView('form');
}

export async function saveRetroPromoteFromModal(){
  var project = getCurrentProject();
  var itemId = ui.retroPromotingItemId;
  if(!project || !ui.editingRetrospectiveId || !itemId) return;
  var title = document.getElementById('retroPromoteTitleInput').value.trim();
  if(!title){ toast('Please enter a principle title.'); return; }
  var description = document.getElementById('retroPromoteDescriptionInput').value;

  if(!isServerAuthoritative(project)){
    toast('Promoting to a Principle requires a server-connected project.');
    return;
  }
  try {
    await retrospectiveApi.promoteItem(project.serverProjectId, ui.editingRetrospectiveId, itemId, {title: title, description: description || null});
    await refreshProjectFromServer(project.id);
    toast('Promoted to Principle.');
    ui.retroPromotingItemId = null;
    setRetrospectivesView('form');
    renderRetroBoard();
  } catch(e){
    toast('Could not promote item on the server: ' + (e.message || 'unknown error'));
  }
}

/* =========================================================
   ACTION ITEMS
   ========================================================= */
function populateRetroActionAssigneeSelect(sel, project, currentAssigneeId){
  sel.innerHTML = '';
  var unassignedOpt = document.createElement('option');
  unassignedOpt.value = '';
  unassignedOpt.textContent = 'Unassigned';
  sel.appendChild(unassignedOpt);
  (project.members || []).forEach(function(m){
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = memberLabel(m);
    if(currentAssigneeId === m.id) opt.selected = true;
    sel.appendChild(opt);
  });
  if(!currentAssigneeId) unassignedOpt.selected = true;
}

export function renderRetroActionItems(){
  var project = getCurrentProject();
  var listEl = document.getElementById('retroActionItemsList');
  listEl.innerHTML = '';
  var retro = (project && ui.editingRetrospectiveId) ? getRetrospectiveById(project, ui.editingRetrospectiveId) : null;

  document.getElementById('retroActionItemsUnsavedNote').classList.toggle('hidden', !!retro);
  document.getElementById('retroActionItemsAddRow').classList.toggle('hidden', !retro);
  if(!retro) return;

  var items = retro.actionItems.slice().sort(function(a, b){ return (a.sortOrder||0) - (b.sortOrder||0); });
  if(items.length === 0){
    listEl.innerHTML = '<div class="kf-releases-empty">No action items yet.</div>';
  }

  items.forEach(function(ai){
    var row = document.createElement('div');
    row.className = 'kf-retro-action-row';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.title = 'Completed';
    checkbox.checked = !!ai.completed;
    checkbox.addEventListener('change', function(){
      updateRetroActionItem(ai.id, {text: ai.text, assigneeId: ai.assigneeId, completed: checkbox.checked, sortOrder: ai.sortOrder});
    });

    var textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.maxLength = 500;
    textInput.className = 'kf-retro-action-text';
    textInput.value = ai.text;
    textInput.placeholder = 'Action item...';
    textInput.addEventListener('change', function(){
      updateRetroActionItem(ai.id, {text: textInput.value, assigneeId: ai.assigneeId, completed: ai.completed, sortOrder: ai.sortOrder});
    });

    var assigneeSelect = document.createElement('select');
    assigneeSelect.className = 'kf-retro-action-assignee';
    populateRetroActionAssigneeSelect(assigneeSelect, project, ai.assigneeId);
    assigneeSelect.addEventListener('change', function(){
      updateRetroActionItem(ai.id, {text: ai.text, assigneeId: assigneeSelect.value || null, completed: ai.completed, sortOrder: ai.sortOrder});
    });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'kf-btn kf-btn-ghost';
    delBtn.title = 'Delete action item';
    delBtn.setAttribute('aria-label', 'Delete action item');
    delBtn.innerHTML = iconSvg('trash', 14);
    delBtn.addEventListener('click', function(){ deleteRetroActionItem(ai.id); });

    row.appendChild(checkbox);
    row.appendChild(textInput);
    row.appendChild(assigneeSelect);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

export function addRetroActionItemFromInputs(){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  var textEl = document.getElementById('retroNewActionItemText');
  var assigneeEl = document.getElementById('retroNewActionItemAssignee');
  var text = textEl.value.trim();
  if(!text) return;
  var assigneeId = assigneeEl.value || null;

  (async function(){
    if(isServerAuthoritative(project)){
      try {
        await retrospectiveApi.createActionItem(project.serverProjectId, ui.editingRetrospectiveId, {text: text, assigneeId: assigneeId});
        await refreshProjectFromServer(project.id);
      } catch(e){
        toast('Could not add action item on the server: ' + (e.message || 'unknown error'));
        return;
      }
    } else {
      addRetrospectiveActionItem(project, ui.editingRetrospectiveId, {text: text, assigneeId: assigneeId});
    }
    textEl.value = '';
    renderRetroActionItems();
  })();
}

async function updateRetroActionItem(itemId, data){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  if(isServerAuthoritative(project)){
    try {
      await retrospectiveApi.updateActionItem(project.serverProjectId, ui.editingRetrospectiveId, itemId, data);
      await refreshProjectFromServer(project.id);
    } catch(e){
      toast('Could not update action item on the server: ' + (e.message || 'unknown error'));
      return;
    }
  } else {
    updateRetrospectiveActionItem(project, ui.editingRetrospectiveId, itemId, data);
  }
  renderRetroActionItems();
}

async function deleteRetroActionItem(itemId){
  var project = getCurrentProject();
  if(!project || !ui.editingRetrospectiveId) return;
  if(isServerAuthoritative(project)){
    try {
      await retrospectiveApi.removeActionItem(project.serverProjectId, ui.editingRetrospectiveId, itemId);
      await refreshProjectFromServer(project.id);
    } catch(e){
      toast('Could not delete action item on the server: ' + (e.message || 'unknown error'));
      return;
    }
  } else {
    deleteRetrospectiveActionItem(project, ui.editingRetrospectiveId, itemId);
  }
  renderRetroActionItems();
}
