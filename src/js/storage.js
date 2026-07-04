"use strict";

import { STORAGE_KEY, TEAM_COMMITTEE_TYPES, RISK_STATUS_META, DECISION_TYPE_META, DECISION_STATUS_META } from './config.js';
import { clampTaskScore, localDateValueToUTCISO, localDateValueFromDate, defaultStartDateValue, defaultEndDateValue, memberColorForIndex } from './date-utils.js';
import { getTasksArray, getTeamCommitteeById, getColumn, isValidTaskTypeIconName, isValidRiskScoreValue } from './utils.js';

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

export function saveDB(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
  }catch(e){
    console.error('Enkl: failed to save to localStorage', e);
    // Callers may show a toast to the user
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
  Object.keys(state.db.projects).forEach(function(pid){
    var p = state.db.projects[pid];
    if(!Array.isArray(p.members)){ p.members = []; changed = true; }
    if(!Array.isArray(p.releases)){ p.releases = []; changed = true; }
    if(!Array.isArray(p.taskTypes)){ p.taskTypes = defaultTaskTypes(); changed = true; }
    if(!Array.isArray(p.documents)){ p.documents = []; changed = true; }
    if(typeof p.docCounter !== 'number'){ p.docCounter = 1; changed = true; }
    if(!Array.isArray(p.risks)){ p.risks = []; changed = true; }
    if(typeof p.riskCounter !== 'number'){ p.riskCounter = 1; changed = true; }
    if(!Array.isArray(p.decisions)){ p.decisions = []; changed = true; }
    if(typeof p.decCounter !== 'number'){ p.decCounter = 1; changed = true; }
    if(!Array.isArray(p.principles)){ p.principles = []; changed = true; }
    if(typeof p.prinCounter !== 'number'){ p.prinCounter = 1; changed = true; }
    if(!Array.isArray(p.objectives)){ p.objectives = []; changed = true; }
    if(typeof p.objCounter !== 'number'){ p.objCounter = 1; changed = true; }
    if(!Array.isArray(p.teamsCommittees)){ p.teamsCommittees = []; changed = true; }
    if(typeof p.tcCounter !== 'number'){ p.tcCounter = 1; changed = true; }
    if(!Array.isArray(p.approvers)){ p.approvers = []; changed = true; }
    if(!Array.isArray(p.roles)){ p.roles = []; changed = true; }
    p.members.forEach(function(m){
      if(m.role === undefined){ m.role = null; changed = true; }
      else if(m.role !== null && typeof m.role !== 'string'){ m.role = null; changed = true; }
      if(m.reportsToId === undefined){ m.reportsToId = null; changed = true; }
      else if(m.reportsToId !== null && typeof m.reportsToId !== 'string'){ m.reportsToId = null; changed = true; }
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
      if(t.archived === undefined){ t.archived = false; changed = true; }
      if(t.isPrivate === undefined){ t.isPrivate = false; changed = true; }
      if(t.privateSalt === undefined){ t.privateSalt = null; changed = true; }
      if(t.privateVerifier === undefined){ t.privateVerifier = null; changed = true; }
      if(t.encryptedDescription === undefined){ t.encryptedDescription = null; changed = true; }
      if(t.encryptionIv === undefined){ t.encryptionIv = null; changed = true; }
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

export function makeColumn(name, done){
  return {id: uid('col'), name: name, done: !!done, order: []};
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
    workflow: v.workflow === true
  };
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
    decisions: [],
    decCounter: 1,
    principles: [],
    prinCounter: 1,
    objectives: [],
    objCounter: 1,
    teamsCommittees: [],
    tcCounter: 1,
    approvers: [],
    roles: [],
    headerButtonVisibility: {documents: true, risks: true, decisions: true},
    startDate: null,
    endDate: null,
    dateCreated: now,
    dateLastModified: now,
    dateLastExported: null
  };
}

export function createSeedDB(){
  var p = createDefaultProject('Demo Project', 'DEMO');
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

  var riley = {id: uid('member'), name: 'Riley Chen', color: memberColorForIndex(0), role: 'Project Manager'};
  var sam = {id: uid('member'), name: 'Sam Okafor', color: memberColorForIndex(1), role: 'Developer'};
  p.members = [riley, sam];
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

  var t1 = addSeedTask(c1, 'Research competitor boards', 'Look at Trello, Asana and Jira for layout ideas.', 'low', [], null, 200, 80);
  var t2 = addSeedTask(c2, 'Design data schema', 'Define how projects, columns and tasks are structured.', 'high', [t1], riley.id, 800, 150);
  var t3 = addSeedTask(c2, 'Set up local storage layer', 'Persist app state to the browser between sessions.', 'medium', [t2], sam.id, 500, 200);
  var t4 = addSeedTask(c3, 'Build drag-and-drop board UI', 'Columns, cards, and reordering via native HTML5 drag and drop.', 'critical', [t2, t3], riley.id, 900, 400);
  addSeedTask(c4, 'Write project README', 'Document setup and usage instructions.', 'trivial', [], null, 100, 30);

  return {
    projects: makeMap(p),
    projectOrder: [p.id],
    currentProjectId: p.id
  };
}

export function makeMap(project){
  var m = {};
  m[project.id] = project;
  return m;
}
