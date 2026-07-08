"use strict";
import { APP_VERSION } from '../config.js';
import { state, saveDB, normalizeHeaderButtonVisibility } from '../storage.js';
import { getTasksArray, getMemberById, getReleaseById, getTaskTypeById, buildChildrenMap, columnNameById } from '../utils.js';
import { clampTaskScore, clampProgress, clampEffortHours } from '../date-utils.js';

var _toast = function(msg){ console.error(msg); };
export function setExportToast(fn){ _toast = fn; }

export function buildHierarchy(project){
  var tasks = getTasksArray(project);
  var taskMap = {};
  tasks.forEach(function(t){ taskMap[t.id] = t; });
  var childrenMap = buildChildrenMap(project);

  var roots = tasks.filter(function(t){
    if(!t.dependencies || t.dependencies.length === 0) return true;
    return t.dependencies.every(function(d){ return !taskMap[d]; });
  });

  function build(taskId, ancestry){
    var t = taskMap[taskId];
    var assignee = getMemberById(project, t.assigneeId);
    var release = getReleaseById(project, t.releaseId);
    var taskType = getTaskTypeById(project, t.typeId);
    var node = {
      id: t.id,
      key: t.key,
      title: t.title,
      description: t.description,
      priority: t.priority,
      column: columnNameById(project, t.columnId),
      assigneeId: assignee ? assignee.id : null,
      assignee: assignee ? assignee.name : null,
      releaseId: release ? release.id : null,
      release: release ? release.name : null,
      typeId: taskType ? taskType.id : null,
      type: taskType ? taskType.name : null,
      documentationUrl: t.documentationUrl || null,
      dateCreated: t.dateCreated || null,
      dateLastModified: t.dateLastModified || null,
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      businessValue: clampTaskScore(t.businessValue),
      taskCost: clampTaskScore(t.taskCost),
      progress: clampProgress(t.progress),
      estimatedEffort: clampEffortHours(t.estimatedEffort),
      actualEffort: clampEffortHours(t.actualEffort),
      archived: !!t.archived,
      isPrivate: !!t.isPrivate,
      privateSalt: t.privateSalt || null,
      privateVerifier: t.privateVerifier || null,
      encryptedDescription: t.encryptedDescription || null,
      encryptionIv: t.encryptionIv || null,
      dependsOn: (t.dependencies||[]).map(function(d){ return taskMap[d] ? taskMap[d].key : d; }),
      auditLog: (t.auditLog || []).map(function(e){
        return {timestamp: e.timestamp, field: e.field, oldValue: e.oldValue, newValue: e.newValue};
      }),
      /* The Sub-Tasks feature's parent link, keyed the same way
         dependsOn is above (by task key, not id — ids get regenerated
         on import) — unrelated to this function's own `subtasks` field
         below, which is the dependency-DAG hierarchy this whole export
         shape is built around, not a Sub-Tasks relationship. */
      parentKey: (t.parentTaskId && taskMap[t.parentTaskId]) ? taskMap[t.parentTaskId].key : null,
      subtasks: []
    };
    if(ancestry.has(taskId)){
      node.note = 'Circular reference detected — subtasks omitted to avoid infinite recursion.';
      return node;
    }
    var nextAncestry = new Set(ancestry);
    nextAncestry.add(taskId);
    var kids = childrenMap[taskId] || [];
    node.subtasks = kids.map(function(kid){ return build(kid, nextAncestry); });
    return node;
  }

  return roots.map(function(r){ return build(r.id, new Set()); });
}

export function exportProjectJSON(project){
  var exportedAt = new Date().toISOString();
  project.dateLastExported = exportedAt;
  saveDB();

  var hierarchy = buildHierarchy(project);
  var doc = {
    project: {
      name: project.name,
      key: project.key,
      startDate: project.startDate || null,
      endDate: project.endDate || null,
      dateCreated: project.dateCreated || null,
      dateLastModified: project.dateLastModified || null,
      dateLastExported: exportedAt
    },
    exportedAt: exportedAt,
    appVersion: APP_VERSION,
    totalTasks: Object.keys(project.tasks).length,
    members: (project.members || []).map(function(m){ return {id: m.id, name: m.name, color: m.color, role: m.role || null, reportsToId: m.reportsToId || null}; }),
    releases: (project.releases || []).map(function(r){
      var owner = getMemberById(project, r.ownerId);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        ownerId: owner ? owner.id : null,
        ownerName: owner ? owner.name : null,
        startDate: r.startDate || null,
        endDate: r.endDate || null,
        dateCreated: r.dateCreated || null,
        dateLastModified: r.dateLastModified || null
      };
    }),
    columns: project.columns.map(function(c, idx){ return {id: c.id, name: c.name, done: c.done, color: c.color || null, order: idx}; }),
    taskTypes: (project.taskTypes || []).map(function(tt){ return {id: tt.id, name: tt.name, iconName: tt.iconName || null}; }),
    documents: (project.documents || []).map(function(d){
      var owner = getMemberById(project, d.ownerId);
      return {
        id: d.id,
        key: d.key,
        title: d.title,
        url: d.url || null,
        description: d.description || '',
        ownerId: owner ? owner.id : null,
        ownerName: owner ? owner.name : null,
        taskId: d.taskId || null,
        relatedDocumentIds: d.relatedDocumentIds || [],
        dateCreated: d.dateCreated || null,
        dateLastModified: d.dateLastModified || null
      };
    }),
    risks: (project.risks || []).map(function(r){
      var owner = getMemberById(project, r.ownerId);
      return {
        id: r.id,
        key: r.key,
        title: r.title,
        description: r.description || '',
        likelihood: r.likelihood,
        impact: r.impact,
        mitigations: r.mitigations || '',
        ownerId: owner ? owner.id : null,
        ownerName: owner ? owner.name : null,
        taskId: r.taskId || null,
        documentIds: r.documentIds || [],
        principleIds: r.principleIds || [],
        objectiveIds: r.objectiveIds || [],
        status: r.status,
        dateToClose: r.dateToClose || null,
        dateClosed: r.dateClosed || null,
        dateCreated: r.dateCreated || null,
        dateLastModified: r.dateLastModified || null
      };
    }),
    principles: (project.principles || []).map(function(prin){
      return {
        id: prin.id,
        key: prin.key,
        title: prin.title,
        description: prin.description || '',
        documentUrl: prin.documentUrl || null,
        dateCreated: prin.dateCreated || null,
        dateLastModified: prin.dateLastModified || null
      };
    }),
    objectives: (project.objectives || []).map(function(o){
      return {
        id: o.id,
        key: o.key,
        title: o.title,
        description: o.description || '',
        principleIds: o.principleIds || [],
        dateCreated: o.dateCreated || null,
        dateLastModified: o.dateLastModified || null
      };
    }),
    teamsCommittees: (project.teamsCommittees || []).map(function(tc){
      return {
        id: tc.id,
        key: tc.key,
        name: tc.name,
        description: tc.description || '',
        type: tc.type,
        parentId: tc.parentId || null,
        memberIds: tc.memberIds || [],
        dateCreated: tc.dateCreated || null,
        dateLastModified: tc.dateLastModified || null
      };
    }),
    decisions: (project.decisions || []).map(function(dec){
      var owner = getMemberById(project, dec.ownerId);
      return {
        id: dec.id,
        key: dec.key,
        title: dec.title,
        description: dec.description || '',
        type: dec.type,
        status: dec.status,
        outcome: dec.outcome || '',
        ownerId: owner ? owner.id : null,
        ownerName: owner ? owner.name : null,
        approver: dec.approver || null,
        taskId: dec.taskId || null,
        documentIds: dec.documentIds || [],
        riskIds: dec.riskIds || [],
        principleIds: dec.principleIds || [],
        objectiveIds: dec.objectiveIds || [],
        dateCreated: dec.dateCreated || null,
        dateLastModified: dec.dateLastModified || null
      };
    }),
    approvers: (project.approvers || []).slice(),
    roles: (project.roles || []).slice(),
    headerButtonVisibility: normalizeHeaderButtonVisibility(project.headerButtonVisibility),
    /* Only present once the Workflow editor has been opened at least
       once (see ensureProjectWorkflow in features/workflow-engine.js —
       project.workflow is created lazily). Omitting it entirely for a
       project that's never materialized one lets import.js tell "never
       customized" apart from "customized down to zero nodes/edges",
       so the same lazy default-topology seeding still kicks in on
       first open after import. */
    workflow: project.workflow ? {nodes: project.workflow.nodes, edges: project.workflow.edges} : null,
    hierarchy: hierarchy
  };
  var blob = new Blob([JSON.stringify(doc, null, 2)], {type:'application/json'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var stamp = exportedAt.slice(0,10);
  a.href = url;
  a.download = project.key + '-export-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  _toast('Exported ' + doc.totalTasks + ' tasks and ' + doc.members.length + ' team member(s) to ' + a.download);
}
