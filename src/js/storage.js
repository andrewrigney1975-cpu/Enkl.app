"use strict";

import { STORAGE_KEY, TEAM_COMMITTEE_TYPES, RISK_STATUS_META, DECISION_TYPE_META, DECISION_STATUS_META } from './config.js';
import { clampTaskScore, localDateValueToUTCISO, localDateValueFromDate, defaultStartDateValue, defaultEndDateValue, memberColorForIndex } from './date-utils.js';
import { getTasksArray, getTeamCommitteeById, getColumn, isValidTaskTypeIconName, isValidRiskScoreValue } from './utils.js';
import { toast } from './ui.js';

/* =========================================================
   SHARED MUTABLE STATE
   All modules that access the database import this object and
   use state.db — they all share the same reference, so when
   loadDB() does state.db = ..., every module sees the change.
   ========================================================= */
export var state = { db: null };

/* =========================================================
   STORAGE
   ========================================================= */
export function uid(prefix){
  return (prefix||'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

/* Most browsers cap a single origin's localStorage around 5MB — JS string .length counts UTF-16
   code units, ~2 bytes each, so this is a size-in-bytes approximation, not exact, but close enough
   to warn well before the real ceiling. Warned only once per page load (storageQuotaWarningShown),
   not on every single save past the threshold — otherwise a user who keeps working past the warning
   would get spammed with an identical toast on every mutation. Exported so modals/project-storage.js
   can reuse the exact same threshold/estimate rather than a second, driftable copy of these numbers. */
export var STORAGE_QUOTA_WARNING_BYTES = 4 * 1024 * 1024;
export var STORAGE_QUOTA_ESTIMATE_BYTES = 5 * 1024 * 1024;
var storageQuotaWarningShown = false;

/* Same UTF-16-code-units-times-2 approximation saveDB() uses for the whole DB, exposed for
   per-project sizing (modals/project-storage.js) where there's no already-serialized string to
   reuse. */
export function estimateByteSize(value){
  return JSON.stringify(value).length * 2;
}

/* Returns true/false so a caller COULD react to a failed save, though nothing currently does — the
   real fix here is that a failure is no longer silent: previously this only logged to the console
   (see CLAUDE.md's note on this), so a user whose local storage was full would see their in-memory
   state update normally (correct-looking UI) while nothing was actually persisted, with zero
   indication anything was wrong until their next reload silently reverted them. */
export function saveDB(){
  var serialized;
  try {
    serialized = JSON.stringify(state.db);
  } catch(e){
    console.error('Enkl: failed to serialize DB for saving', e);
    toast('Could not save your changes — local data is in an unexpected state. Please reload the page.');
    return false;
  }

  try{
    localStorage.setItem(STORAGE_KEY, serialized);
  }catch(e){
    console.error('Enkl: failed to save to localStorage', e);
    var isQuotaError = !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
    if(isQuotaError){
      toast('Local storage is full — this change was NOT saved. Free up space (e.g. delete an old local-only project) or move large projects to a server account.');
    } else {
      toast('Could not save your changes locally' + (e && e.message ? ': ' + e.message : '.'));
    }
    return false;
  }

  if(!storageQuotaWarningShown && serialized.length * 2 >= STORAGE_QUOTA_WARNING_BYTES){
    storageQuotaWarningShown = true;
    var approxMb = Math.round(serialized.length * 2 / (1024 * 1024) * 10) / 10;
    toast('Local storage is getting full (~' + approxMb + 'MB used) — you may soon be unable to save further changes.');
  }
  return true;
}

/* Portfolio Dashboard's selected-project-ids, remembered between runs of the same browser only (per
   user's explicit choice — no server-side persistence). Deliberately its own localStorage key, not
   folded into state.db: it's a per-Org-Admin UI preference, not project data, and must survive
   independently of which local project happens to be open. Defensive against corrupted/garbled data
   the same way normalizeHeaderButtonVisibility is — anything that isn't an array of non-empty
   strings collapses to "nothing selected" rather than an error, and is never treated as
   authoritative: it only pre-checks checkboxes, since the actual data returned always comes from
   whatever the server independently validates against the caller's own organisation (see
   PortfolioService.cs's own doc comment). */
export var PORTFOLIO_SELECTED_PROJECTS_STORAGE_KEY = 'kanbanflow_portfolio_selected_projects';

export function getPortfolioSelectedProjectIds(){
  var raw;
  try{
    raw = localStorage.getItem(PORTFOLIO_SELECTED_PROJECTS_STORAGE_KEY);
  }catch(e){
    return [];
  }
  if(!raw) return [];
  try{
    var parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    return parsed.filter(function(id){ return typeof id === 'string' && id.length > 0; });
  }catch(e){
    return [];
  }
}

export function setPortfolioSelectedProjectIds(ids){
  var clean = (Array.isArray(ids) ? ids : []).filter(function(id){ return typeof id === 'string' && id.length > 0; });
  try{
    localStorage.setItem(PORTFOLIO_SELECTED_PROJECTS_STORAGE_KEY, JSON.stringify(clean));
  }catch(e){
    console.error('Enkl: failed to save Portfolio Dashboard selection to localStorage', e);
  }
}

/* First-run device-type + opening-experience preference (see modals/opening-experience.js and
   app.js's init()) — both localStorage-only, per-browser, and never treated as authoritative for
   anything beyond which local view opens first; signed-in users skip this whole feature entirely and
   always land on the Board. Deliberately two separate keys rather than one: device type is recorded
   permanently on first-ever use (mobile or desktop) and never rechecked again, while opening
   experience is only ever set by an explicit choice in the picker (and stays unset — implicitly
   "Board" — if that picker is dismissed without an answer). */
export var DEVICE_TYPE_STORAGE_KEY = 'kanbanflow_device_type';
export var OPENING_EXPERIENCE_STORAGE_KEY = 'kanbanflow_opening_experience';

export function getDeviceType(){
  var raw;
  try{
    raw = localStorage.getItem(DEVICE_TYPE_STORAGE_KEY);
  }catch(e){
    return null;
  }
  return (raw === 'mobile' || raw === 'desktop') ? raw : null;
}

export function setDeviceType(type){
  if(type !== 'mobile' && type !== 'desktop') return;
  try{
    localStorage.setItem(DEVICE_TYPE_STORAGE_KEY, type);
  }catch(e){
    console.error('Enkl: failed to save device type to localStorage', e);
  }
}

export function getOpeningExperience(){
  var raw;
  try{
    raw = localStorage.getItem(OPENING_EXPERIENCE_STORAGE_KEY);
  }catch(e){
    return null;
  }
  return (raw === 'todo' || raw === 'board') ? raw : null;
}

export function setOpeningExperience(value){
  if(value !== 'todo' && value !== 'board') return;
  try{
    localStorage.setItem(OPENING_EXPERIENCE_STORAGE_KEY, value);
  }catch(e){
    console.error('Enkl: failed to save opening experience to localStorage', e);
  }
}

/* Board background preference — per-browser only (My Preferences modal), same "never
   authoritative, just a local nicety" tier as device type/opening experience above. Shape:
   {type: 'color', color: '#rrggbb'}
   {type: 'gradient', gradientStart: '#rrggbb', gradientEnd: '#rrggbb', gradientDirection: 'horizontal'|'vertical'}
   {type: 'image', imageData: 'data:image/...;base64,...', faded: bool, display: 'fill'|'stretch'|'tile'}
   `type` is the only field that's ever trusted on read — a corrupted/half-written value (e.g. an
   'image' entry with no imageData, from a previous version or manual tampering) collapses to "no
   background" rather than rendering a broken CSS url(). Unrecognized/missing sub-fields (a bad
   `display` or `gradientDirection`) fall back to a sane default rather than propagating garbage
   into a CSS value. */
export var BOARD_BACKGROUND_STORAGE_KEY = 'kanbanflow_board_background';
export var BOARD_BACKGROUND_IMAGE_DISPLAYS = ['fill', 'stretch', 'tile'];

export function getBoardBackground(){
  var raw;
  try{
    raw = localStorage.getItem(BOARD_BACKGROUND_STORAGE_KEY);
  }catch(e){
    return null;
  }
  if(!raw) return null;
  var pref;
  try{
    pref = JSON.parse(raw);
  }catch(e){
    return null;
  }
  if(!pref || typeof pref !== 'object') return null;
  if(pref.type === 'color' && typeof pref.color === 'string') return {type: 'color', color: pref.color};
  if(pref.type === 'gradient' && typeof pref.gradientStart === 'string' && typeof pref.gradientEnd === 'string'){
    return {
      type: 'gradient',
      gradientStart: pref.gradientStart,
      gradientEnd: pref.gradientEnd,
      gradientDirection: pref.gradientDirection === 'horizontal' ? 'horizontal' : 'vertical'
    };
  }
  if(pref.type === 'image' && typeof pref.imageData === 'string' && pref.imageData) {
    return {
      type: 'image',
      imageData: pref.imageData,
      faded: !!pref.faded,
      display: BOARD_BACKGROUND_IMAGE_DISPLAYS.indexOf(pref.display) !== -1 ? pref.display : 'fill'
    };
  }
  return null;
}

export function setBoardBackground(pref){
  try{
    localStorage.setItem(BOARD_BACKGROUND_STORAGE_KEY, JSON.stringify(pref));
  }catch(e){
    console.error('Enkl: failed to save board background to localStorage', e);
    return false;
  }
  return true;
}

/* Explicit removeItem (not setBoardBackground({type:'none'})) so the base64 image payload is
   actually dropped from localStorage rather than just becoming unreachable — the whole point of
   "clearing" an uploaded image is to recover that space. */
export function clearBoardBackground(){
  try{
    localStorage.removeItem(BOARD_BACKGROUND_STORAGE_KEY);
  }catch(e){
    console.error('Enkl: failed to clear board background from localStorage', e);
  }
}

/* App header colour preference — same per-browser-only tier as board background above. A single
   "#rrggbb" string, not a JSON object, since there's only one field; stored/read raw rather than
   JSON-wrapped for that reason. */
export var HEADER_COLOR_STORAGE_KEY = 'kanbanflow_header_color';

export function getHeaderColor(){
  var raw;
  try{
    raw = localStorage.getItem(HEADER_COLOR_STORAGE_KEY);
  }catch(e){
    return null;
  }
  return (raw && /^#[0-9a-f]{6}$/i.test(raw)) ? raw : null;
}

export function setHeaderColor(hex){
  if(!/^#[0-9a-f]{6}$/i.test(hex || '')) return false;
  try{
    localStorage.setItem(HEADER_COLOR_STORAGE_KEY, hex);
  }catch(e){
    console.error('Enkl: failed to save header colour to localStorage', e);
    return false;
  }
  return true;
}

export function clearHeaderColor(){
  try{
    localStorage.removeItem(HEADER_COLOR_STORAGE_KEY);
  }catch(e){
    console.error('Enkl: failed to clear header colour from localStorage', e);
  }
}

export function loadDB(){
  var raw;
  try{
    raw = localStorage.getItem(STORAGE_KEY);
  }catch(e){
    console.error('Enkl: failed to read localStorage', e);
  }
  if(raw){
    try{
      state.db = JSON.parse(raw);
      if(state.db && state.db.projects && state.db.projectOrder){
        migrateDB();
        return;
      }
    }catch(e){
      console.error('Enkl: corrupted data, resetting', e);
    }
  }
  state.db = createSeedDB();
  saveDB();
}

/* Backfills fields added after a user's data was first saved, so boards
   created before the team-members feature don't break. */
export function migrateDB(){
  var changed = false;
  var epoch = new Date(0).toISOString();
  if(!Array.isArray(state.db.templates)){ state.db.templates = []; changed = true; }
  if(!Array.isArray(state.db.todoLists)){ state.db.todoLists = []; changed = true; }
  Object.keys(state.db.projects).forEach(function(pid){
    var p = state.db.projects[pid];
    if(!Array.isArray(p.members)){ p.members = []; changed = true; }
    if(!Array.isArray(p.releases)){ p.releases = []; changed = true; }
    if(!Array.isArray(p.taskTypes)){ p.taskTypes = defaultTaskTypes(); changed = true; }
    if(!Array.isArray(p.documents)){ p.documents = []; changed = true; }
    if(typeof p.docCounter !== 'number'){ p.docCounter = 1; changed = true; }
    if(!Array.isArray(p.risks)){ p.risks = []; changed = true; }
    if(typeof p.riskCounter !== 'number'){ p.riskCounter = 1; changed = true; }
    if(!Array.isArray(p.savedQueries)){ p.savedQueries = []; changed = true; }
    if(!Array.isArray(p.decisions)){ p.decisions = []; changed = true; }
    if(typeof p.decCounter !== 'number'){ p.decCounter = 1; changed = true; }
    if(!Array.isArray(p.principles)){ p.principles = []; changed = true; }
    if(typeof p.prinCounter !== 'number'){ p.prinCounter = 1; changed = true; }
    if(!Array.isArray(p.objectives)){ p.objectives = []; changed = true; }
    if(typeof p.objCounter !== 'number'){ p.objCounter = 1; changed = true; }
    if(!Array.isArray(p.teamsCommittees)){ p.teamsCommittees = []; changed = true; }
    if(typeof p.tcCounter !== 'number'){ p.tcCounter = 1; changed = true; }
    if(!Array.isArray(p.retrospectives)){ p.retrospectives = []; changed = true; }
    if(typeof p.retroCounter !== 'number'){ p.retroCounter = 1; changed = true; }
    if(!Array.isArray(p.approvers)){ p.approvers = []; changed = true; }
    if(!Array.isArray(p.roles)){ p.roles = []; changed = true; }
    p.members.forEach(function(m){
      if(m.role === undefined){ m.role = null; changed = true; }
      else if(m.role !== null && typeof m.role !== 'string'){ m.role = null; changed = true; }
      if(m.reportsToId === undefined){ m.reportsToId = null; changed = true; }
      else if(m.reportsToId !== null && typeof m.reportsToId !== 'string'){ m.reportsToId = null; changed = true; }
      if(m.email === undefined){ m.email = null; changed = true; }
      else if(m.email !== null && typeof m.email !== 'string'){ m.email = null; changed = true; }
    });
    if(!p.headerButtonVisibility || typeof p.headerButtonVisibility !== 'object' ||
       typeof p.headerButtonVisibility.documents !== 'boolean' ||
       typeof p.headerButtonVisibility.risks !== 'boolean' ||
       typeof p.headerButtonVisibility.decisions !== 'boolean'){
      p.headerButtonVisibility = normalizeHeaderButtonVisibility(p.headerButtonVisibility);
      changed = true;
    }
    if(!p.dateCreated){ p.dateCreated = epoch; changed = true; }
    if(!p.dateLastModified){ p.dateLastModified = epoch; changed = true; }
    if(!p.dateLastExported){ p.dateLastExported = null; changed = true; }
    if(p.startDate === undefined){ p.startDate = null; changed = true; }
    if(p.endDate === undefined){ p.endDate = null; changed = true; }
    if(p.description === undefined){ p.description = ''; changed = true; }
    var validReleaseIds = {};
    p.releases.forEach(function(r){ validReleaseIds[r.id] = true; });
    var validTaskTypeIds = {};
    p.taskTypes.forEach(function(tt){
      validTaskTypeIds[tt.id] = true;
      if(tt.iconName === undefined){ tt.iconName = null; changed = true; }
      else if(tt.iconName && !isValidTaskTypeIconName(tt.iconName)){ tt.iconName = null; changed = true; }
    });
    getTasksArray(p).forEach(function(t){
      if(t.assigneeId === undefined){ t.assigneeId = null; changed = true; }
      if(t.releaseId === undefined){ t.releaseId = null; changed = true; }
      else if(t.releaseId && !validReleaseIds[t.releaseId]){ t.releaseId = null; changed = true; }
      if(t.typeId === undefined){ t.typeId = null; changed = true; }
      else if(t.typeId && !validTaskTypeIds[t.typeId]){ t.typeId = null; changed = true; }
      if(t.documentationUrl === undefined){ t.documentationUrl = null; changed = true; }
      if(!t.dateCreated){ t.dateCreated = t.createdAt || epoch; changed = true; }
      if(t.dateLastModified === undefined){ t.dateLastModified = t.updatedAt || null; changed = true; }
      if(t.startDate === undefined){ t.startDate = null; changed = true; }
      if(t.endDate === undefined){ t.endDate = null; changed = true; }
      if(t.businessValue === undefined){ t.businessValue = 1; changed = true; }
      if(t.taskCost === undefined){ t.taskCost = 1; changed = true; }
      if(t.progress === undefined){ t.progress = 0; changed = true; }
      if(t.estimatedEffort === undefined){ t.estimatedEffort = 0; changed = true; }
      if(t.actualEffort === undefined){ t.actualEffort = 0; changed = true; }
      if(t.archived === undefined){ t.archived = false; changed = true; }
      if(t.isPrivate === undefined){ t.isPrivate = false; changed = true; }
      if(t.privateSalt === undefined){ t.privateSalt = null; changed = true; }
      if(t.privateVerifier === undefined){ t.privateVerifier = null; changed = true; }
      if(t.encryptedDescription === undefined){ t.encryptedDescription = null; changed = true; }
      if(t.encryptionIv === undefined){ t.encryptionIv = null; changed = true; }
      if(!Array.isArray(t.auditLog)){ t.auditLog = []; changed = true; }
      if(!Array.isArray(t.comments)){ t.comments = []; changed = true; }
      if(t.parentTaskId === undefined){ t.parentTaskId = null; changed = true; }
      else if(t.parentTaskId && (t.parentTaskId === t.id || !p.tasks[t.parentTaskId])){ t.parentTaskId = null; changed = true; }
      /* One-time backfill: a task already sitting in a Done column
         when this field was introduced has its best-available
         completion signal — dateLastModified — copied over, since
         there's no better historical record of when it actually
         finished. Every transition into Done from here on sets this
         properly (see moveTaskToColumn in mutations.js). */
      if(t.dateDone === undefined){
        var doneCol = getColumn(p, t.columnId);
        t.dateDone = (doneCol && doneCol.done) ? t.dateLastModified : null;
        changed = true;
      }
    });

    p.columns.forEach(function(c){
      if(c.color === undefined){ c.color = null; changed = true; }
    });

    var validMemberIds = {};
    p.members.forEach(function(m){ validMemberIds[m.id] = true; });
    p.members.forEach(function(m){
      if(m.reportsToId && (m.reportsToId === m.id || !validMemberIds[m.reportsToId])){
        m.reportsToId = null; changed = true;
      }
    });
    var validTaskIds = {};
    getTasksArray(p).forEach(function(t){ validTaskIds[t.id] = true; });
    var validDocIds = {};
    p.documents.forEach(function(d){ validDocIds[d.id] = true; });

    var validTcIds = {};
    p.teamsCommittees.forEach(function(tc){ validTcIds[tc.id] = true; });
    p.teamsCommittees.forEach(function(tc){
      if(!TEAM_COMMITTEE_TYPES.hasOwnProperty(tc.type)){ tc.type = 'team'; changed = true; }
      if(tc.description === undefined){ tc.description = ''; changed = true; }
      if(tc.parentId === undefined){ tc.parentId = null; changed = true; }
      else if(tc.parentId && (!validTcIds[tc.parentId] || tc.parentId === tc.id)){ tc.parentId = null; changed = true; }
      if(!Array.isArray(tc.memberIds)){ tc.memberIds = []; changed = true; }
      else {
        var filteredTcMemberIds = tc.memberIds.filter(function(mid){ return validMemberIds[mid]; });
        if(filteredTcMemberIds.length !== tc.memberIds.length){ tc.memberIds = filteredTcMemberIds; changed = true; }
      }
      if(!tc.dateCreated){ tc.dateCreated = epoch; changed = true; }
      if(!tc.dateLastModified){ tc.dateLastModified = tc.dateCreated || epoch; changed = true; }
    });
    /* Break any cycle that might have survived from a corrupted or
       hand-edited file — walk each node's ancestor chain and sever
       the link the moment a node reappears in its own chain. */
    p.teamsCommittees.forEach(function(tc){
      var seen = {}; seen[tc.id] = true;
      var current = tc.parentId ? getTeamCommitteeById(p, tc.parentId) : null;
      while(current){
        if(seen[current.id]){ tc.parentId = null; changed = true; break; }
        seen[current.id] = true;
        current = current.parentId ? getTeamCommitteeById(p, current.parentId) : null;
      }
    });

    p.documents.forEach(function(d){
      if(d.ownerId === undefined){ d.ownerId = null; changed = true; }
      else if(d.ownerId && !validMemberIds[d.ownerId]){ d.ownerId = null; changed = true; }
      if(d.taskId === undefined){ d.taskId = null; changed = true; }
      else if(d.taskId && !validTaskIds[d.taskId]){ d.taskId = null; changed = true; }
      if(d.url === undefined){ d.url = null; changed = true; }
      if(d.description === undefined){ d.description = ''; changed = true; }
      if(!Array.isArray(d.relatedDocumentIds)){ d.relatedDocumentIds = []; changed = true; }
      else {
        var filteredRelatedIds = d.relatedDocumentIds.filter(function(id){ return id !== d.id && validDocIds[id]; });
        if(filteredRelatedIds.length !== d.relatedDocumentIds.length){ d.relatedDocumentIds = filteredRelatedIds; changed = true; }
      }
      if(!d.dateCreated){ d.dateCreated = epoch; changed = true; }
      if(!d.dateLastModified){ d.dateLastModified = d.dateCreated || epoch; changed = true; }
    });

    p.principles.forEach(function(prin){
      if(prin.documentUrl === undefined){ prin.documentUrl = null; changed = true; }
      if(prin.description === undefined){ prin.description = ''; changed = true; }
      /* Server-only concept (Organisation Library sharing) — a local-only principle is simply never
         shared, same "opt-in, missing = off" treatment as every App Setting flag above. */
      if(typeof prin.isOrganisationWide !== 'boolean'){ prin.isOrganisationWide = false; changed = true; }
      if(!prin.dateCreated){ prin.dateCreated = epoch; changed = true; }
      if(!prin.dateLastModified){ prin.dateLastModified = prin.dateCreated || epoch; changed = true; }
    });

    var validPrincipleIds = {};
    p.principles.forEach(function(prin){ validPrincipleIds[prin.id] = true; });

    p.objectives.forEach(function(o){
      if(!Array.isArray(o.principleIds)){ o.principleIds = []; changed = true; }
      else {
        var filteredObjPrinIds = o.principleIds.filter(function(id){ return validPrincipleIds[id]; });
        if(filteredObjPrinIds.length !== o.principleIds.length){ o.principleIds = filteredObjPrinIds; changed = true; }
      }
      if(o.description === undefined){ o.description = ''; changed = true; }
      if(!o.dateCreated){ o.dateCreated = epoch; changed = true; }
      if(!o.dateLastModified){ o.dateLastModified = o.dateCreated || epoch; changed = true; }
    });

    var validObjectiveIds = {};
    p.objectives.forEach(function(o){ validObjectiveIds[o.id] = true; });

    p.risks.forEach(function(r){
      if(r.ownerId === undefined){ r.ownerId = null; changed = true; }
      else if(r.ownerId && !validMemberIds[r.ownerId]){ r.ownerId = null; changed = true; }
      if(r.taskId === undefined){ r.taskId = null; changed = true; }
      else if(r.taskId && !validTaskIds[r.taskId]){ r.taskId = null; changed = true; }
      if(!Array.isArray(r.documentIds)){ r.documentIds = []; changed = true; }
      else {
        var filteredDocIds = r.documentIds.filter(function(id){ return validDocIds[id]; });
        if(filteredDocIds.length !== r.documentIds.length){ r.documentIds = filteredDocIds; changed = true; }
      }
      if(!Array.isArray(r.principleIds)){ r.principleIds = []; changed = true; }
      else {
        var filteredRiskPrinIds = r.principleIds.filter(function(id){ return validPrincipleIds[id]; });
        if(filteredRiskPrinIds.length !== r.principleIds.length){ r.principleIds = filteredRiskPrinIds; changed = true; }
      }
      if(!Array.isArray(r.objectiveIds)){ r.objectiveIds = []; changed = true; }
      else {
        var filteredRiskObjIds = r.objectiveIds.filter(function(id){ return validObjectiveIds[id]; });
        if(filteredRiskObjIds.length !== r.objectiveIds.length){ r.objectiveIds = filteredRiskObjIds; changed = true; }
      }
      if(!RISK_STATUS_META.hasOwnProperty(r.status)){ r.status = 'new'; changed = true; }
      if(r.dateToClose === undefined){ r.dateToClose = null; changed = true; }
      if(r.dateClosed === undefined){ r.dateClosed = null; changed = true; }
      if(!isValidRiskScoreValue(r.likelihood)){ r.likelihood = 1; changed = true; }
      if(!isValidRiskScoreValue(r.impact)){ r.impact = 1; changed = true; }
      if(r.mitigations === undefined){ r.mitigations = ''; changed = true; }
      if(!r.dateCreated){ r.dateCreated = epoch; changed = true; }
      if(!r.dateLastModified){ r.dateLastModified = r.dateCreated || epoch; changed = true; }
    });

    var validRiskIds = {};
    p.risks.forEach(function(r){ validRiskIds[r.id] = true; });

    p.decisions.forEach(function(dec){
      if(dec.ownerId === undefined){ dec.ownerId = null; changed = true; }
      else if(dec.ownerId && !validMemberIds[dec.ownerId]){ dec.ownerId = null; changed = true; }
      if(dec.taskId === undefined){ dec.taskId = null; changed = true; }
      else if(dec.taskId && !validTaskIds[dec.taskId]){ dec.taskId = null; changed = true; }
      if(!Array.isArray(dec.documentIds)){ dec.documentIds = []; changed = true; }
      else {
        var filteredDecDocIds = dec.documentIds.filter(function(id){ return validDocIds[id]; });
        if(filteredDecDocIds.length !== dec.documentIds.length){ dec.documentIds = filteredDecDocIds; changed = true; }
      }
      if(!Array.isArray(dec.riskIds)){ dec.riskIds = []; changed = true; }
      else {
        var filteredDecRiskIds = dec.riskIds.filter(function(id){ return validRiskIds[id]; });
        if(filteredDecRiskIds.length !== dec.riskIds.length){ dec.riskIds = filteredDecRiskIds; changed = true; }
      }
      if(!Array.isArray(dec.principleIds)){ dec.principleIds = []; changed = true; }
      else {
        var filteredDecPrinIds = dec.principleIds.filter(function(id){ return validPrincipleIds[id]; });
        if(filteredDecPrinIds.length !== dec.principleIds.length){ dec.principleIds = filteredDecPrinIds; changed = true; }
      }
      if(!Array.isArray(dec.objectiveIds)){ dec.objectiveIds = []; changed = true; }
      else {
        var filteredDecObjIds = dec.objectiveIds.filter(function(id){ return validObjectiveIds[id]; });
        if(filteredDecObjIds.length !== dec.objectiveIds.length){ dec.objectiveIds = filteredDecObjIds; changed = true; }
      }
      if(!DECISION_TYPE_META.hasOwnProperty(dec.type)){ dec.type = 'strategy'; changed = true; }
      if(!DECISION_STATUS_META.hasOwnProperty(dec.status)){ dec.status = 'open'; changed = true; }
      if(dec.description === undefined){ dec.description = ''; changed = true; }
      if(dec.outcome === undefined){ dec.outcome = ''; changed = true; }
      if(dec.approver === undefined){ dec.approver = null; changed = true; }
      if(!dec.dateCreated){ dec.dateCreated = epoch; changed = true; }
      if(!dec.dateLastModified){ dec.dateLastModified = dec.dateCreated || epoch; changed = true; }
    });

    p.retrospectives.forEach(function(retro){
      if(retro.releaseId === undefined){ retro.releaseId = null; changed = true; }
      else if(retro.releaseId && !validReleaseIds[retro.releaseId]){ retro.releaseId = null; changed = true; }
      if(retro.team === undefined){ retro.team = null; changed = true; }
      if(retro.background === undefined){ retro.background = null; changed = true; }
      if(retro.retroDate === undefined){ retro.retroDate = null; changed = true; }
      if(retro.lastTimerDurationSeconds === undefined){ retro.lastTimerDurationSeconds = null; changed = true; }
      else if(retro.lastTimerDurationSeconds !== null && (typeof retro.lastTimerDurationSeconds !== 'number' || !isFinite(retro.lastTimerDurationSeconds) || retro.lastTimerDurationSeconds < 0)){
        retro.lastTimerDurationSeconds = null; changed = true;
      }
      if(!Array.isArray(retro.participantIds)){ retro.participantIds = []; changed = true; }
      else {
        var filteredParticipantIds = retro.participantIds.filter(function(id){ return validMemberIds[id]; });
        if(filteredParticipantIds.length !== retro.participantIds.length){ retro.participantIds = filteredParticipantIds; changed = true; }
      }
      if(!Array.isArray(retro.items)){ retro.items = []; changed = true; }
      else {
        retro.items.forEach(function(it){
          if(it.column !== 'start' && it.column !== 'stop' && it.column !== 'keep'){ it.column = 'start'; changed = true; }
          if(typeof it.text !== 'string'){ it.text = ''; changed = true; }
          if(typeof it.sortOrder !== 'number' || !isFinite(it.sortOrder)){ it.sortOrder = 0; changed = true; }
          if(it.promotedPrincipleId === undefined){ it.promotedPrincipleId = null; changed = true; }
          else if(it.promotedPrincipleId && !validPrincipleIds[it.promotedPrincipleId]){ it.promotedPrincipleId = null; changed = true; }
        });
      }
      if(!Array.isArray(retro.actionItems)){ retro.actionItems = []; changed = true; }
      else {
        retro.actionItems.forEach(function(ai){
          if(typeof ai.text !== 'string'){ ai.text = ''; changed = true; }
          if(ai.assigneeId === undefined){ ai.assigneeId = null; changed = true; }
          else if(ai.assigneeId && !validMemberIds[ai.assigneeId]){ ai.assigneeId = null; changed = true; }
          if(typeof ai.completed !== 'boolean'){ ai.completed = false; changed = true; }
          if(typeof ai.sortOrder !== 'number' || !isFinite(ai.sortOrder)){ ai.sortOrder = 0; changed = true; }
        });
      }
      if(!retro.dateCreated){ retro.dateCreated = epoch; changed = true; }
      if(!retro.dateLastModified){ retro.dateLastModified = retro.dateCreated || epoch; changed = true; }
    });

    /* project.workflow is only ever created lazily (see
       ensureProjectWorkflow in features/workflow-engine.js) — a
       project that has never opened the Workflow editor has no
       `workflow` key at all, which must stay that way here so first-
       materialization can still be detected there. This block only
       sanitizes shape and drops stale column references for projects
       that already have one. */
    if(p.workflow !== undefined){
      if(!p.workflow || typeof p.workflow !== 'object'){
        p.workflow = {nodes: {}, edges: []};
        changed = true;
      } else {
        if(!p.workflow.nodes || typeof p.workflow.nodes !== 'object'){ p.workflow.nodes = {}; changed = true; }
        if(!Array.isArray(p.workflow.edges)){ p.workflow.edges = []; changed = true; }
        var validColumnIds = {};
        p.columns.forEach(function(c){ validColumnIds[c.id] = true; });
        Object.keys(p.workflow.nodes).forEach(function(colId){
          if(!validColumnIds[colId]){ delete p.workflow.nodes[colId]; changed = true; }
        });
        var filteredWfEdges = p.workflow.edges.filter(function(e){
          return e && validColumnIds[e.fromColumnId] && validColumnIds[e.toColumnId];
        });
        if(filteredWfEdges.length !== p.workflow.edges.length){ p.workflow.edges = filteredWfEdges; changed = true; }
        p.workflow.edges.forEach(function(e){
          if(e.type !== 'allowed' && e.type !== 'disallowed' && e.type !== 'conditional'){ e.type = 'allowed'; changed = true; }
          if(e.message !== null && typeof e.message !== 'string'){ e.message = null; changed = true; }
          if(!e.id){ e.id = uid('wfedge'); changed = true; }
          /* Structural check only (not against the live field/operator
             vocabulary in workflow-engine.js, to avoid storage.js
             depending on it) — a condition referencing a since-removed
             field just evaluates as if the field were unset, it never
             crashes, and any edit through the popover UI re-normalizes
             it against the current vocabulary anyway. */
          if(e.type === 'conditional'){
            if(!e.condition || typeof e.condition !== 'object' || typeof e.condition.field !== 'string' || typeof e.condition.operator !== 'string'){
              e.condition = {field: 'assigneeId', operator: 'is_set', value: null};
              changed = true;
            }
          } else if(e.condition !== null && e.condition !== undefined){
            e.condition = null;
            changed = true;
          }
        });
      }
    }
  });
  if(changed) saveDB();
}

/* -1 means uncapped (the default); anything blank/non-numeric/≤0 other than an explicit -1
   normalizes back to -1 rather than being rejected outright, and any real cap is floored at 1 —
   there's no such thing as a column that can hold zero tasks. */
export function clampColumnCap(value){
  if(value === -1 || value === '-1') return -1;
  var n = Math.round(Number(value));
  if(!isFinite(n) || n < 1) return -1;
  return n;
}

export function makeColumn(name, done, color, cap){
  var validColor = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  return {id: uid('col'), name: name, done: !!done, order: [], color: validColor, cap: clampColumnCap(cap)};
}

export function defaultTaskTypes(){
  return [
    {id: uid('type'), name: 'Feature', iconName: null},
    {id: uid('type'), name: 'Bug', iconName: null}
  ];
}

/* App Settings: which header buttons (Documents/Risks/Decisions) are
   shown for this project. Defensive against partial/garbled data —
   any missing or non-boolean field defaults to visible (true), so a
   corrupted setting never silently hides a button the user never
   chose to hide. */
export function normalizeHeaderButtonVisibility(value){
  var v = (value && typeof value === 'object') ? value : {};
  return {
    documents: v.documents !== false,
    risks: v.risks !== false,
    decisions: v.decisions !== false,
    health: v.health !== false,
    principles: v.principles !== false,
    objectives: v.objectives !== false,
    teamsCommittees: v.teamsCommittees !== false,
    /* Opt-in, unlike every field above: turning this on newly
       restricts drag-and-drop / Edit Task column choices, so a
       corrupted or missing value must never silently start enforcing
       transitions the user never configured. */
    workflow: v.workflow === true,
    timeTracking: v.timeTracking !== false,
    /* Opt-in, like workflow: turning this on starts growing every
       task's stored data on every edit, so a corrupted or missing
       value must never silently start recording history the user
       never asked for. */
    changeAuditing: v.changeAuditing === true,
    subTasks: v.subTasks !== false,
    /* Opt-in, like workflow/changeAuditing: the whole Retrospective feature (board, action items,
       Promote to Principle, Organisation Library) stays invisible until a project deliberately turns
       it on, so a corrupted or missing value must never silently start showing a feature the user
       never asked for. */
    retrospective: v.retrospective === true
  };
}

export function isTimeTrackingEnabled(project){
  if(!project) return false;
  return normalizeHeaderButtonVisibility(project.headerButtonVisibility).timeTracking === true;
}

export function isRetrospectiveEnabled(project){
  if(!project) return false;
  return normalizeHeaderButtonVisibility(project.headerButtonVisibility).retrospective === true;
}

export function isChangeAuditingEnabled(project){
  if(!project) return false;
  return normalizeHeaderButtonVisibility(project.headerButtonVisibility).changeAuditing === true;
}

export function isSubTasksEnabled(project){
  if(!project) return false;
  return normalizeHeaderButtonVisibility(project.headerButtonVisibility).subTasks === true;
}

export function createDefaultProject(name, key){
  var now = new Date().toISOString();
  return {
    id: uid('proj'),
    name: name,
    key: (key || 'PROJ').toUpperCase().slice(0,6),
    taskCounter: 1,
    columns: [makeColumn('To Do', false), makeColumn('In Progress', false), makeColumn('Done', true)],
    tasks: {},
    members: [],
    releases: [],
    taskTypes: defaultTaskTypes(),
    documents: [],
    docCounter: 1,
    risks: [],
    riskCounter: 1,
    savedQueries: [],
    decisions: [],
    decCounter: 1,
    principles: [],
    prinCounter: 1,
    objectives: [],
    objCounter: 1,
    teamsCommittees: [],
    tcCounter: 1,
    retrospectives: [],
    retroCounter: 1,
    approvers: [],
    roles: [],
    headerButtonVisibility: {documents: true, risks: true, decisions: true},
    startDate: null,
    endDate: null,
    description: '',
    dateCreated: now,
    dateLastModified: now,
    dateLastExported: null
  };
}

export function createSeedDB(){
  var p = createDefaultProject('Sample Project', 'SMPL');
  var weekBefore = new Date();
  weekBefore.setDate(weekBefore.getDate() - 7);
  var weekAfter = new Date();
  weekAfter.setDate(weekAfter.getDate() + 7);
  p.startDate = localDateValueToUTCISO(localDateValueFromDate(weekBefore));
  p.endDate = localDateValueToUTCISO(localDateValueFromDate(weekAfter));
  var c1 = makeColumn('Backlog', false);
  var c2 = makeColumn('To Do', false);
  var c3 = makeColumn('In Progress', false);
  var c4 = makeColumn('Done', true);
  p.columns = [c1, c2, c3, c4];

  var john = {id: uid('member'), name: 'John Brown', color: memberColorForIndex(0), role: 'Project Manager'};
  var jan = {id: uid('member'), name: 'Jan Smith', color: memberColorForIndex(1), role: 'Developer'};
  p.members = [john, jan];
  p.roles = ['Project Manager', 'Developer'];

  function addSeedTask(col, title, desc, priority, deps, assigneeId, businessValue, taskCost){
    var n = p.taskCounter++;
    var now = new Date().toISOString();
    var t = {
      id: uid('task'),
      key: p.key + '-' + n,
      title: title,
      description: desc,
      priority: priority,
      columnId: col.id,
      dependencies: deps || [],
      assigneeId: assigneeId || null,
      startDate: localDateValueToUTCISO(defaultStartDateValue()),
      endDate: localDateValueToUTCISO(defaultEndDateValue()),
      businessValue: clampTaskScore(businessValue),
      taskCost: clampTaskScore(taskCost),
      archived: false,
      releaseId: null,
      typeId: null,
      documentationUrl: null,
      isPrivate: false,
      privateSalt: null,
      privateVerifier: null,
      encryptedDescription: null,
      encryptionIv: null,
      dateCreated: now,
      dateLastModified: now
    };
    p.tasks[t.id] = t;
    col.order.push(t.id);
    return t.id;
  }

  var t1 = addSeedTask(c1, 'Look at Project and App Settings', 'There are lots of options available to extend the app to make it more structured and specific to your needs. Open up Project Settings to see what elese it can do for you.', 'low', [], null, 200, 80);
  var t2 = addSeedTask(c2, 'Configure project modules, columns and details', 'Define how projects, columns and tasks are structured. Replace these default Tasks with real activities', 'high', [t1], john.id, 800, 150);
  var t3 = addSeedTask(c2, 'Draft project objectives', 'Set the goals of this project. Gives you milestones and targets to reach. The extended Objectives module really helps formalise these goals.', 'medium', [t2], jan.id, 500, 200);
  var t4 = addSeedTask(c3, 'Set up Team members for this project', 'Assign people and roles to the project.', 'critical', [t2, t3], john.id, 900, 400);
  addSeedTask(c4, 'Create project board', 'Document setup and usage instructions.', 'trivial', [], null, 100, 30);

  return {
    projects: makeMap(p),
    projectOrder: [p.id],
    currentProjectId: p.id,
    templates: [],
    todoLists: []
  };
}

/* Snapshot of the pieces a Project Template covers — Columns (name/done/color/order), TaskTypes
   (name/iconName), Workflow, and App Settings — deliberately excluding tasks, members, releases, and
   every governance entity. Shared by both the local "Save as Template" path (mutations.js addTemplate)
   and the server path (features/migration.js createTemplateOnServer), whose request body this shape
   matches exactly (see CreateTemplateRequest, api/Enkl.Api/Dtos/TemplateDtos.cs). `order` is the
   column's array index rather than a stored field, since a local project's own column position is
   implicit in project.columns' array order (unlike the server's explicit Column.Order column) — this
   still round-trips correctly since createProjectFromTemplate below sorts by it either way. Workflow
   is deep-cloned so a later edit to the live project's workflow (many small mutations per drag, see
   views/workflow-editor.js) can never reach back into an already-saved template. */
export function buildTemplateSnapshotFromProject(project){
  return {
    columns: project.columns.map(function(c, i){ return {id: c.id, name: c.name, done: !!c.done, color: c.color || null, order: i, cap: c.cap != null ? c.cap : -1}; }),
    taskTypes: project.taskTypes.map(function(tt){ return {name: tt.name, iconName: tt.iconName || null}; }),
    workflow: project.workflow ? JSON.parse(JSON.stringify(project.workflow)) : null,
    settings: normalizeHeaderButtonVisibility(project.headerButtonVisibility)
  };
}

/* Builds a brand new project seeded from a template's columns/taskTypes/workflow/settings instead of
   createDefaultProject's hardcoded 3-column/2-type blank slate. Column ids are always freshly minted
   here (a new project can never reuse another project's column ids), so the template's Workflow —
   captured against the SOURCE project's column ids — is rewritten through the resulting old->new id
   map before being attached, dropping anything that fails to map (mirrors migrateDB's own defensive
   pruning of stale workflow column references above). Mirrors ProjectService.CreateAsync's template
   branch (api/Enkl.Api/Services/ProjectService.cs) so a template behaves the same locally as it does
   once migrated to the server. */
export function createProjectFromTemplate(name, key, template){
  var project = createDefaultProject(name, key);

  var idMap = {};
  var sortedColumns = (template.columns || []).slice().sort(function(a, b){ return a.order - b.order; });
  project.columns = sortedColumns.map(function(c){
    var newId = uid('col');
    idMap[c.id] = newId;
    var validColor = typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : null;
    return {id: newId, name: c.name, done: !!c.done, color: validColor, order: [], cap: clampColumnCap(c.cap)};
  });

  project.taskTypes = (template.taskTypes || []).map(function(tt){
    return {id: uid('type'), name: tt.name, iconName: (tt.iconName && isValidTaskTypeIconName(tt.iconName)) ? tt.iconName : null};
  });

  project.headerButtonVisibility = normalizeHeaderButtonVisibility(template.settings);

  if(template.workflow && template.workflow.nodes){
    var newNodes = {};
    Object.keys(template.workflow.nodes).forEach(function(oldId){
      if(idMap[oldId]) newNodes[idMap[oldId]] = template.workflow.nodes[oldId];
    });
    var newEdges = (template.workflow.edges || []).filter(function(e){
      return e && idMap[e.fromColumnId] && idMap[e.toColumnId];
    }).map(function(e){
      return Object.assign({}, e, {fromColumnId: idMap[e.fromColumnId], toColumnId: idMap[e.toColumnId]});
    });
    project.workflow = {nodes: newNodes, edges: newEdges};
  }

  return project;
}

export function makeMap(project){
  var m = {};
  m[project.id] = project;
  return m;
}
