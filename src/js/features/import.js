"use strict";
import { state, saveDB, uid, makeColumn, defaultTaskTypes, normalizeHeaderButtonVisibility } from '../storage.js';
import { PRIORITY_META } from '../config.js';
import { clampTaskScore, clampProgress, clampEffortHours, clampAllocatedFraction, memberColorForIndex, isValidISODateString } from '../date-utils.js';
import { getColumn, isValidTaskTypeIconName, escapeHTML } from '../utils.js';
import { normalizeReleaseStatus, normalizeRiskStatus, normalizeDecisionType, normalizeDecisionStatus, normalizeTeamCommitteeType, nextDocKey, nextRiskKey, nextDecisionKey, nextPrincipleKey, nextObjectiveKey, nextTeamCommitteeKey, normalizeDocumentationUrl, registerRole, registerApprover, clampRiskScoreValue, buildWorkflowEdgeFields, formatAuditValue } from '../mutations.js';

var _toast = function(msg){ console.error(msg); };
export function setImportToast(fn){ _toast = fn; }
var _renderAll = function(){ };
export function setImportRenderAll(fn){ _renderAll = fn; }
var _resetFilters = function(){ };
export function setImportResetFilters(fn){ _resetFilters = fn; }
var _checkSessionAlerts = function(){ };
export function setImportSessionAlertsCheck(fn){ _checkSessionAlerts = fn; }

/* =========================================================
   IMPORT (reads the same hierarchical schema exportProjectJSON
   produces and rebuilds an equivalent project from scratch)
   ========================================================= */

/* Walk the hierarchy tree and collapse it back into a flat map of
   unique tasks keyed by their *original* export id. Multi-dependency
   tasks appear more than once in the tree (once under each parent),
   so duplicates are merged rather than recreated. */
export function flattenImportedHierarchy(nodes, out){
  if(!Array.isArray(nodes)) return;
  nodes.forEach(function(n){
    if(!n || typeof n !== 'object' || !n.id) return;
    var dependsOnKeys = Array.isArray(n.dependsOn) ? n.dependsOn.filter(function(k){ return typeof k === 'string'; }) : [];
    if(out[n.id]){
      dependsOnKeys.forEach(function(k){
        if(out[n.id].dependsOnKeys.indexOf(k) === -1) out[n.id].dependsOnKeys.push(k);
      });
    } else {
      out[n.id] = {
        originalId: n.id,
        key: typeof n.key === 'string' ? n.key : null,
        title: (typeof n.title === 'string' && n.title.trim()) ? n.title.trim().slice(0,120) : 'Untitled task',
        description: typeof n.description === 'string' ? n.description.slice(0,4000) : '',
        priority: PRIORITY_META.hasOwnProperty(n.priority) ? n.priority : 'medium',
        columnName: (typeof n.column === 'string' && n.column.trim()) ? n.column.trim().slice(0,40) : 'To Do',
        assigneeIdRaw: typeof n.assigneeId === 'string' ? n.assigneeId : null,
        assigneeName: (typeof n.assignee === 'string' && n.assignee.trim()) ? n.assignee.trim() : null,
        releaseIdRaw: typeof n.releaseId === 'string' ? n.releaseId : null,
        releaseName: (typeof n.release === 'string' && n.release.trim()) ? n.release.trim() : null,
        typeIdRaw: typeof n.typeId === 'string' ? n.typeId : null,
        typeName: (typeof n.type === 'string' && n.type.trim()) ? n.type.trim() : null,
        documentationUrl: typeof n.documentationUrl === 'string' ? n.documentationUrl.trim().slice(0,500) : null,
        dateCreated: typeof n.dateCreated === 'string' ? n.dateCreated : null,
        dateLastModified: typeof n.dateLastModified === 'string' ? n.dateLastModified : null,
        dateDone: isValidISODateString(n.dateDone) ? n.dateDone : null,
        startDate: isValidISODateString(n.startDate) ? n.startDate : null,
        endDate: isValidISODateString(n.endDate) ? n.endDate : null,
        businessValue: n.businessValue,
        taskCost: n.taskCost,
        progress: n.progress,
        estimatedEffort: n.estimatedEffort,
        actualEffort: n.actualEffort,
        archived: n.archived === true,
        isPrivate: n.isPrivate === true,
        privateSalt: typeof n.privateSalt === 'string' ? n.privateSalt.slice(0,64) : null,
        privateVerifier: typeof n.privateVerifier === 'string' ? n.privateVerifier.slice(0,64) : null,
        encryptedDescription: typeof n.encryptedDescription === 'string' ? n.encryptedDescription.slice(0,6000) : null,
        encryptionIv: typeof n.encryptionIv === 'string' ? n.encryptionIv.slice(0,32) : null,
        dependsOnKeys: dependsOnKeys,
        /* Historical entries reference ids from the *source* project —
           once tasks/members/etc. are re-created with fresh ids below,
           an old id an entry points at (e.g. a past assigneeId or a
           dependencies list) simply won't resolve to anything in this
           project anymore. Rendering already falls back to an em dash
           for an unresolvable id, so this is a graceful, non-crashing
           loss of a little historical detail rather than a hard error. */
        auditLog: Array.isArray(n.auditLog) ? n.auditLog.filter(function(e){
          return e && typeof e === 'object' && typeof e.timestamp === 'string' && typeof e.field === 'string';
        }).slice(0, 2000).map(function(e){
          return {
            timestamp: e.timestamp,
            field: e.field.slice(0, 60),
            /* Coerced to string/null (not trusted as-is) — an imported JSON file is untrusted input,
               and a raw number/boolean/array here would otherwise re-surface the exact 400 this fixed
               on the migrate-to-server path once this project is later migrated (ImportAuditLogEntryDto
               is string-only). See mutations.js's formatAuditValue for the shared convention. */
            oldValue: formatAuditValue(e.oldValue),
            newValue: formatAuditValue(e.newValue)
          };
        }) : [],
        /* Parent is referenced by key (like dependsOn above), resolved
           to an original id below once every node's key is known, then
           remapped a second time to the freshly-generated task id once
           tasks are actually created (see idMap in
           buildProjectFromExportDoc). */
        parentKey: typeof n.parentKey === 'string' ? n.parentKey : null
      };
    }
    if(Array.isArray(n.subtasks) && n.subtasks.length){
      flattenImportedHierarchy(n.subtasks, out);
    }
  });
}

/* DFS-based cycle removal. Mutates each entry's `dependencies` array
   in place, dropping any edge that would close a cycle. Returns the
   number of edges removed, so the caller can warn the user. Defends
   against hand-edited or corrupted import files; the app itself never
   produces cyclic data. */
export function sanitizeAcyclicGraph(byOriginalId){
  var WHITE = 0, GRAY = 1, BLACK = 2;
  var color = {};
  Object.keys(byOriginalId).forEach(function(id){ color[id] = WHITE; });
  var removed = 0;

  function visit(id){
    color[id] = GRAY;
    var node = byOriginalId[id];
    var kept = [];
    node.dependencies.forEach(function(depId){
      if(!byOriginalId[depId]) return;
      if(color[depId] === GRAY){
        removed++;
        return;
      }
      if(color[depId] === WHITE) visit(depId);
      kept.push(depId);
    });
    node.dependencies = kept;
    color[id] = BLACK;
  }
  Object.keys(byOriginalId).forEach(function(id){ if(color[id] === WHITE) visit(id); });
  return removed;
}

/* Same defensive purpose as sanitizeAcyclicGraph, but for the single-
   parent chain (`parentOriginalId`) rather than the multi-dependency
   DAG — walks each node's chain up to the root, and nulls out the one
   edge that would close a loop back on itself. Breaking any single
   edge in a cycle resolves it for every node on that cycle, so a
   single pass over all nodes is enough regardless of iteration order. */
export function sanitizeAcyclicParents(byOriginalId){
  var removed = 0;
  Object.keys(byOriginalId).forEach(function(id){
    var node = byOriginalId[id];
    if(!node.parentOriginalId) return;
    var seen = new Set([id]);
    var cur = node.parentOriginalId;
    var guard = 0;
    while(cur && guard < 10000){
      if(seen.has(cur)){ node.parentOriginalId = null; removed++; return; }
      seen.add(cur);
      var parentNode = byOriginalId[cur];
      cur = parentNode ? parentNode.parentOriginalId : null;
      guard++;
    }
  });
  return removed;
}

export function uniqueProjectKey(desired){
  var key = (desired || 'IMP').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6) || 'IMP';
  var existing = Object.keys(state.db.projects).map(function(id){ return state.db.projects[id].key; });
  if(existing.indexOf(key) === -1) return key;
  var n = 2;
  while(existing.indexOf((key + n).slice(0,6)) !== -1) n++;
  return (key + n).slice(0,6);
}

/* Parses + validates a raw export document and returns a ready-to-insert
   project object, or throws an Error with a user-facing message. */
export function buildProjectFromExportDoc(doc){
  if(!doc || typeof doc !== 'object'){
    throw new Error('That file is not valid JSON.');
  }
  if(!Array.isArray(doc.hierarchy)){
    throw new Error('That file doesn\'t look like an Enkl export — it\'s missing the "hierarchy" list.');
  }

  var flat = {};
  flattenImportedHierarchy(doc.hierarchy, flat);

  var keyToOriginalId = {};
  Object.keys(flat).forEach(function(id){
    if(flat[id].key) keyToOriginalId[flat[id].key] = id;
  });

  var unresolvedDeps = 0;
  Object.keys(flat).forEach(function(id){
    var node = flat[id];
    node.dependencies = node.dependsOnKeys.map(function(k){
      var resolved = keyToOriginalId[k] || (flat[k] ? k : null);
      if(!resolved) unresolvedDeps++;
      return resolved;
    }).filter(Boolean);
  });

  var cyclesRemoved = sanitizeAcyclicGraph(flat);

  var unresolvedParents = 0;
  Object.keys(flat).forEach(function(id){
    var node = flat[id];
    if(!node.parentKey){ node.parentOriginalId = null; return; }
    var resolved = keyToOriginalId[node.parentKey] || (flat[node.parentKey] ? node.parentKey : null);
    if(!resolved) unresolvedParents++;
    node.parentOriginalId = resolved;
  });
  var parentCyclesRemoved = sanitizeAcyclicParents(flat);

  var columns = null;
  /* Old export id -> newly-generated column id, for remapping
     project.workflow's column references below (each import gets
     fresh column ids, same as every other entity type here). Only
     populated for columns sourced from doc.columns itself — the
     name-only fallback path below has no ids to carry over, so any
     workflow data just won't have anything to remap onto in that
     case (an export from before columns carried ids, or a
     hand-edited file). */
  var columnOldIdToNewId = {};
  if(Array.isArray(doc.columns) && doc.columns.length > 0){
    var validCols = doc.columns
      .map(function(c, idx){
        if(!c || typeof c !== 'object') return null;
        var name = (typeof c.name === 'string' && c.name.trim()) ? c.name.trim().slice(0,40) : null;
        if(!name) return null;
        var order = (typeof c.order === 'number' && isFinite(c.order)) ? c.order : idx;
        var cap = (typeof c.cap === 'number' && isFinite(c.cap)) ? c.cap : -1;
        return {oldId: (typeof c.id === 'string' && c.id) ? c.id : null, name: name, done: !!c.done, order: order, cap: cap};
      })
      .filter(Boolean)
      .sort(function(a, b){ return a.order - b.order; });

    var seenColNames = {};
    validCols = validCols.filter(function(c){
      if(seenColNames[c.name]) return false;
      seenColNames[c.name] = true;
      return true;
    });

    if(validCols.length > 0){
      columns = validCols.map(function(c){
        var newCol = makeColumn(c.name, c.done, c.color, c.cap);
        if(c.oldId) columnOldIdToNewId[c.oldId] = newCol.id;
        return newCol;
      });
    }
  }

  if(!columns){
    /* Fallback for older exports (or hand-edited files) that don't carry a
       top-level `columns` list: derive column order from the first-seen
       order of column names referenced on tasks. Note this can't recover
       empty columns, since no task references them. */
    var columnOrder = [];
    var columnSeen = {};
    Object.keys(flat).forEach(function(id){
      var name = flat[id].columnName;
      if(!columnSeen[name]){ columnSeen[name] = true; columnOrder.push(name); }
    });
    if(columnOrder.length === 0) columnOrder = ['To Do', 'In Progress', 'Done'];
    columns = columnOrder.map(function(name){
      return makeColumn(name, /^done$/i.test(name));
    });
  }

  var columnIdByName = {};
  columns.forEach(function(c){ columnIdByName[c.name] = c.id; });
  /* Safety net: if a task references a column name absent from the
     authoritative list (corrupted/hand-edited file), create it rather
     than silently dropping the task. */
  Object.keys(flat).forEach(function(id){
    var name = flat[id].columnName;
    if(!columnIdByName.hasOwnProperty(name)){
      var extraCol = makeColumn(name, /^done$/i.test(name));
      columns.push(extraCol);
      columnIdByName[name] = extraCol.id;
    }
  });

  var rawName = (doc.project && typeof doc.project.name === 'string' && doc.project.name.trim()) ? doc.project.name.trim().slice(0,60) : 'Imported Project';
  var rawKey = (doc.project && typeof doc.project.key === 'string') ? doc.project.key : rawName;
  var importedAt = new Date().toISOString();
  var project = {
    id: uid('proj'),
    name: rawName,
    key: uniqueProjectKey(rawKey),
    taskCounter: 1,
    columns: columns,
    tasks: {},
    members: [],
    releases: [],
    taskTypes: [],
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
    retrospectives: [],
    retroCounter: 1,
    approvers: [],
    roles: Array.isArray(doc.roles) ? doc.roles.filter(function(r){ return typeof r === 'string' && r.trim(); }).map(function(r){ return r.trim().slice(0,60); }) : [],
    headerButtonVisibility: normalizeHeaderButtonVisibility(doc.headerButtonVisibility),
    startDate: (doc.project && isValidISODateString(doc.project.startDate)) ? doc.project.startDate : null,
    endDate: (doc.project && isValidISODateString(doc.project.endDate)) ? doc.project.endDate : null,
    dateCreated: (doc.project && typeof doc.project.dateCreated === 'string') ? doc.project.dateCreated : importedAt,
    dateLastModified: (doc.project && typeof doc.project.dateLastModified === 'string') ? doc.project.dateLastModified : importedAt,
    dateLastExported: (doc.project && typeof doc.project.dateLastExported === 'string') ? doc.project.dateLastExported : null
  };

  /* project.workflow is only set here when something in doc.workflow
     actually survives remapping — an absent doc.workflow (older export,
     or a project that never opened the editor) leaves project.workflow
     unset entirely, and a doc.workflow whose every node/edge referenced
     a column id that failed to remap does too, so ensureProjectWorkflow
     still treats this as "never materialized" and seeds the normal
     left-to-right default layout the first time the editor is opened,
     rather than persisting a broken, permanently edge-less workflow. */
  var unresolvedWorkflowNodes = 0, unresolvedWorkflowEdges = 0;
  if(doc.workflow && typeof doc.workflow === 'object'){
    var importedWfNodes = {};
    if(doc.workflow.nodes && typeof doc.workflow.nodes === 'object'){
      Object.keys(doc.workflow.nodes).forEach(function(oldColId){
        var newColId = columnOldIdToNewId[oldColId];
        if(!newColId){ unresolvedWorkflowNodes++; return; }
        var pos = doc.workflow.nodes[oldColId];
        importedWfNodes[newColId] = {
          x: (pos && typeof pos.x === 'number' && isFinite(pos.x)) ? pos.x : 0,
          y: (pos && typeof pos.y === 'number' && isFinite(pos.y)) ? pos.y : 0
        };
      });
    }
    var importedWfEdges = [];
    if(Array.isArray(doc.workflow.edges)){
      doc.workflow.edges.forEach(function(e){
        if(!e || typeof e !== 'object') return;
        var fromColumnId = columnOldIdToNewId[e.fromColumnId];
        var toColumnId = columnOldIdToNewId[e.toColumnId];
        if(!fromColumnId || !toColumnId || fromColumnId === toColumnId){ unresolvedWorkflowEdges++; return; }
        var fields = buildWorkflowEdgeFields(e.type, e.message, e.condition);
        importedWfEdges.push(Object.assign({id: uid('wfedge'), fromColumnId: fromColumnId, toColumnId: toColumnId}, fields));
      });
    }
    if(Object.keys(importedWfNodes).length > 0 || importedWfEdges.length > 0){
      project.workflow = {nodes: importedWfNodes, edges: importedWfEdges};
    }
  }

  var memberOldIdToNewId = {};
  var memberNameToNewId = {};
  var unresolvedMemberReportsTo = 0;
  var membersNeedingReportsToResolution = [];
  if(Array.isArray(doc.members)){
    doc.members.forEach(function(m){
      if(!m || typeof m !== 'object') return;
      var name = (typeof m.name === 'string' && m.name.trim()) ? m.name.trim().slice(0,60) : null;
      if(!name) return;
      var color = (typeof m.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(m.color)) ? m.color : memberColorForIndex(project.members.length);
      var role = (typeof m.role === 'string' && m.role.trim()) ? registerRole(project, m.role) : null;
      var email = (typeof m.email === 'string' && m.email.trim()) ? m.email.trim().slice(0,320) : null;
      var allocatedFraction = clampAllocatedFraction(m.allocatedFraction);
      var newMember = {id: uid('member'), name: name, email: email, color: color, role: role, allocatedFraction: allocatedFraction, reportsToId: null};
      project.members.push(newMember);
      if(typeof m.id === 'string') memberOldIdToNewId[m.id] = newMember.id;
      if(!memberNameToNewId.hasOwnProperty(name)) memberNameToNewId[name] = newMember.id;
      if(m.reportsToId) membersNeedingReportsToResolution.push({newMember: newMember, oldReportsToId: m.reportsToId});
    });
  }
  membersNeedingReportsToResolution.forEach(function(entry){
    if(memberOldIdToNewId.hasOwnProperty(entry.oldReportsToId) && memberOldIdToNewId[entry.oldReportsToId] !== entry.newMember.id){
      entry.newMember.reportsToId = memberOldIdToNewId[entry.oldReportsToId];
    } else {
      unresolvedMemberReportsTo++;
    }
  });

  var releaseOldIdToNewId = {};
  var releaseNameToNewId = {};
  if(Array.isArray(doc.releases)){
    doc.releases.forEach(function(r){
      if(!r || typeof r !== 'object') return;
      var name = (typeof r.name === 'string' && r.name.trim()) ? r.name.trim().slice(0,80) : null;
      if(!name) return;
      var ownerId = null;
      if(typeof r.ownerId === 'string' && memberOldIdToNewId.hasOwnProperty(r.ownerId)){
        ownerId = memberOldIdToNewId[r.ownerId];
      } else if(typeof r.ownerName === 'string' && memberNameToNewId.hasOwnProperty(r.ownerName.trim())){
        ownerId = memberNameToNewId[r.ownerName.trim()];
      }
      var newRelease = {
        id: uid('release'),
        name: name,
        status: normalizeReleaseStatus(r.status),
        ownerId: ownerId,
        startDate: isValidISODateString(r.startDate) ? r.startDate : null,
        endDate: isValidISODateString(r.endDate) ? r.endDate : null,
        dateCreated: typeof r.dateCreated === 'string' ? r.dateCreated : importedAt,
        dateLastModified: typeof r.dateLastModified === 'string' ? r.dateLastModified : importedAt
      };
      project.releases.push(newRelease);
      if(typeof r.id === 'string') releaseOldIdToNewId[r.id] = newRelease.id;
      if(!releaseNameToNewId.hasOwnProperty(name)) releaseNameToNewId[name] = newRelease.id;
    });
  }

  var idMap = {};
  var now = new Date().toISOString();
  var unresolvedAssignees = 0;
  var unresolvedReleases = 0;
  var unresolvedTaskTypes = 0;

  var taskTypeOldIdToNewId = {};
  var taskTypeNameToNewId = {};
  if(Array.isArray(doc.taskTypes)){
    doc.taskTypes.forEach(function(tt){
      if(!tt || typeof tt !== 'object') return;
      var name = (typeof tt.name === 'string' && tt.name.trim()) ? tt.name.trim().slice(0,40) : null;
      if(!name) return;
      var newType = {
        id: uid('type'), name: name,
        iconName: (typeof tt.iconName === 'string' && isValidTaskTypeIconName(tt.iconName)) ? tt.iconName : null
      };
      project.taskTypes.push(newType);
      if(typeof tt.id === 'string') taskTypeOldIdToNewId[tt.id] = newType.id;
      if(!taskTypeNameToNewId.hasOwnProperty(name)) taskTypeNameToNewId[name] = newType.id;
    });
  } else {
    /* The taskTypes field is entirely absent — this export predates the
       feature, rather than having deliberately captured zero types — so
       seed the same defaults a brand-new project would get. An export
       that DOES include the field, even as an empty array, is respected
       exactly as exported. */
    project.taskTypes = defaultTaskTypes();
  }

  Object.keys(flat).forEach(function(originalId){
    var t = flat[originalId];
    var n = project.taskCounter++;
    var newId = uid('task');
    var col = getColumn(project, columnIdByName[t.columnName]) || project.columns[0];
    var assigneeId = null;
    if(t.assigneeIdRaw && memberOldIdToNewId.hasOwnProperty(t.assigneeIdRaw)){
      assigneeId = memberOldIdToNewId[t.assigneeIdRaw];
    } else if(t.assigneeName && memberNameToNewId.hasOwnProperty(t.assigneeName)){
      assigneeId = memberNameToNewId[t.assigneeName];
    } else if(t.assigneeIdRaw || t.assigneeName){
      unresolvedAssignees++;
    }
    var releaseId = null;
    if(t.releaseIdRaw && releaseOldIdToNewId.hasOwnProperty(t.releaseIdRaw)){
      releaseId = releaseOldIdToNewId[t.releaseIdRaw];
    } else if(t.releaseName && releaseNameToNewId.hasOwnProperty(t.releaseName)){
      releaseId = releaseNameToNewId[t.releaseName];
    } else if(t.releaseIdRaw || t.releaseName){
      unresolvedReleases++;
    }
    var typeId = null;
    if(t.typeIdRaw && taskTypeOldIdToNewId.hasOwnProperty(t.typeIdRaw)){
      typeId = taskTypeOldIdToNewId[t.typeIdRaw];
    } else if(t.typeName && taskTypeNameToNewId.hasOwnProperty(t.typeName)){
      typeId = taskTypeNameToNewId[t.typeName];
    } else if(t.typeIdRaw || t.typeName){
      unresolvedTaskTypes++;
    }
    var task = {
      id: newId,
      key: project.key + '-' + n,
      title: t.title,
      description: t.description,
      priority: t.priority,
      columnId: col.id,
      dependencies: [],
      assigneeId: assigneeId,
      releaseId: releaseId,
      typeId: typeId,
      documentationUrl: normalizeDocumentationUrl(t.documentationUrl),
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      businessValue: clampTaskScore(t.businessValue),
      taskCost: clampTaskScore(t.taskCost),
      progress: clampProgress(t.progress),
      estimatedEffort: clampEffortHours(t.estimatedEffort),
      actualEffort: clampEffortHours(t.actualEffort),
      archived: !!t.archived,
      isPrivate: t.isPrivate,
      privateSalt: t.privateSalt,
      privateVerifier: t.privateVerifier,
      encryptedDescription: t.encryptedDescription,
      encryptionIv: t.encryptionIv,
      dateCreated: t.dateCreated || importedAt,
      dateLastModified: t.dateLastModified || importedAt,
      /* Only trusted if the task's resolved column actually is Done —
         guards against a hand-edited file claiming a completion date
         for a task that isn't (or is no longer) in a Done column. */
      dateDone: (col.done && t.dateDone) ? t.dateDone : null,
      auditLog: Array.isArray(t.auditLog) ? t.auditLog : [],
      parentTaskId: null
    };
    project.tasks[newId] = task;
    col.order.push(newId);
    idMap[originalId] = newId;
  });

  Object.keys(flat).forEach(function(originalId){
    var newId = idMap[originalId];
    project.tasks[newId].dependencies = flat[originalId].dependencies
      .map(function(depOriginalId){ return idMap[depOriginalId]; })
      .filter(Boolean);
    var parentOriginalId = flat[originalId].parentOriginalId;
    project.tasks[newId].parentTaskId = parentOriginalId ? (idMap[parentOriginalId] || null) : null;
  });

  var docOldIdToNewId = {};
  var unresolvedDocOwners = 0, unresolvedDocTasks = 0, unresolvedDocRelated = 0;
  var docsNeedingRelatedResolution = [];
  if(Array.isArray(doc.documents)){
    doc.documents.forEach(function(d){
      if(!d || typeof d !== 'object') return;
      var title = (typeof d.title === 'string' && d.title.trim()) ? d.title.trim().slice(0,120) : null;
      if(!title) return;
      var ownerId = null;
      if(typeof d.ownerId === 'string' && memberOldIdToNewId.hasOwnProperty(d.ownerId)){
        ownerId = memberOldIdToNewId[d.ownerId];
      } else if(typeof d.ownerName === 'string' && memberNameToNewId.hasOwnProperty(d.ownerName.trim())){
        ownerId = memberNameToNewId[d.ownerName.trim()];
      } else if(d.ownerId || d.ownerName){
        unresolvedDocOwners++;
      }
      var taskId = null;
      if(d.taskId && idMap.hasOwnProperty(d.taskId)){
        taskId = idMap[d.taskId];
      } else if(d.taskId){
        unresolvedDocTasks++;
      }
      var newDoc = {
        id: uid('doc'),
        key: nextDocKey(project),
        title: title,
        url: normalizeDocumentationUrl(d.url),
        description: (typeof d.description === 'string') ? d.description.trim().slice(0,1000) : '',
        ownerId: ownerId,
        taskId: taskId,
        relatedDocumentIds: [],
        dateCreated: typeof d.dateCreated === 'string' ? d.dateCreated : importedAt,
        dateLastModified: typeof d.dateLastModified === 'string' ? d.dateLastModified : importedAt
      };
      project.documents.push(newDoc);
      if(typeof d.id === 'string') docOldIdToNewId[d.id] = newDoc.id;
      /* A document may relate to another document that hasn't been
         created yet at this point in the loop, so the relatedDocumentIds
         themselves are resolved in a second pass below, once every
         document in this import has a known new id. */
      if(Array.isArray(d.relatedDocumentIds) && d.relatedDocumentIds.length > 0){
        docsNeedingRelatedResolution.push({newDoc: newDoc, oldRelatedIds: d.relatedDocumentIds});
      }
    });
  }
  docsNeedingRelatedResolution.forEach(function(entry){
    entry.oldRelatedIds.forEach(function(oldRelatedId){
      if(docOldIdToNewId.hasOwnProperty(oldRelatedId) && docOldIdToNewId[oldRelatedId] !== entry.newDoc.id){
        entry.newDoc.relatedDocumentIds.push(docOldIdToNewId[oldRelatedId]);
      } else {
        unresolvedDocRelated++;
      }
    });
  });

  var tcOldIdToNewId = {};
  var unresolvedTcParents = 0, unresolvedTcMembers = 0;
  var tcsNeedingParentResolution = [];
  if(Array.isArray(doc.teamsCommittees)){
    doc.teamsCommittees.forEach(function(tc){
      if(!tc || typeof tc !== 'object') return;
      var name = (typeof tc.name === 'string' && tc.name.trim()) ? tc.name.trim().slice(0,120) : null;
      if(!name) return;
      var memberIds = [];
      if(Array.isArray(tc.memberIds)){
        tc.memberIds.forEach(function(oldMemberId){
          if(memberOldIdToNewId.hasOwnProperty(oldMemberId)) memberIds.push(memberOldIdToNewId[oldMemberId]);
          else unresolvedTcMembers++;
        });
      }
      var newTc = {
        id: uid('tc'),
        key: nextTeamCommitteeKey(project, tc.type),
        name: name,
        description: (typeof tc.description === 'string') ? tc.description.trim().slice(0,4000) : '',
        type: normalizeTeamCommitteeType(tc.type),
        parentId: null,
        memberIds: memberIds,
        dateCreated: typeof tc.dateCreated === 'string' ? tc.dateCreated : importedAt,
        dateLastModified: typeof tc.dateLastModified === 'string' ? tc.dateLastModified : importedAt
      };
      project.teamsCommittees.push(newTc);
      if(typeof tc.id === 'string') tcOldIdToNewId[tc.id] = newTc.id;
      if(tc.parentId) tcsNeedingParentResolution.push({newTc: newTc, oldParentId: tc.parentId});
    });
  }
  tcsNeedingParentResolution.forEach(function(entry){
    if(tcOldIdToNewId.hasOwnProperty(entry.oldParentId) && tcOldIdToNewId[entry.oldParentId] !== entry.newTc.id){
      entry.newTc.parentId = tcOldIdToNewId[entry.oldParentId];
    } else {
      unresolvedTcParents++;
    }
  });

  var prinOldIdToNewId = {};
  if(Array.isArray(doc.principles)){
    doc.principles.forEach(function(prin){
      if(!prin || typeof prin !== 'object') return;
      var title = (typeof prin.title === 'string' && prin.title.trim()) ? prin.title.trim().slice(0,120) : null;
      if(!title) return;
      var newPrinciple = {
        id: uid('prin'),
        key: nextPrincipleKey(project),
        title: title,
        description: (typeof prin.description === 'string') ? prin.description.trim().slice(0,4000) : '',
        documentUrl: normalizeDocumentationUrl(prin.documentUrl),
        /* Re-imported as false regardless of the source value — sharing is re-established explicitly
           per-project once server-authoritative again, same reasoning as every other server-only flag
           reset on import (see e.g. workflow's own comment above). */
        isOrganisationWide: false,
        dateCreated: typeof prin.dateCreated === 'string' ? prin.dateCreated : importedAt,
        dateLastModified: typeof prin.dateLastModified === 'string' ? prin.dateLastModified : importedAt
      };
      project.principles.push(newPrinciple);
      if(typeof prin.id === 'string') prinOldIdToNewId[prin.id] = newPrinciple.id;
    });
  }

  var unresolvedObjectivePrinciples = 0;
  var objOldIdToNewId = {};
  if(Array.isArray(doc.objectives)){
    doc.objectives.forEach(function(o){
      if(!o || typeof o !== 'object') return;
      var title = (typeof o.title === 'string' && o.title.trim()) ? o.title.trim().slice(0,120) : null;
      if(!title) return;
      var principleIds = [];
      if(Array.isArray(o.principleIds)){
        o.principleIds.forEach(function(oldPrinId){
          if(prinOldIdToNewId.hasOwnProperty(oldPrinId)) principleIds.push(prinOldIdToNewId[oldPrinId]);
          else unresolvedObjectivePrinciples++;
        });
      }
      var newObjective = {
        id: uid('obj'),
        key: nextObjectiveKey(project),
        title: title,
        description: (typeof o.description === 'string') ? o.description.trim().slice(0,4000) : '',
        principleIds: principleIds,
        dateCreated: typeof o.dateCreated === 'string' ? o.dateCreated : importedAt,
        dateLastModified: typeof o.dateLastModified === 'string' ? o.dateLastModified : importedAt
      };
      project.objectives.push(newObjective);
      if(typeof o.id === 'string') objOldIdToNewId[o.id] = newObjective.id;
    });
  }

  var unresolvedRiskOwners = 0, unresolvedRiskTasks = 0, unresolvedRiskDocs = 0, unresolvedRiskPrinciples = 0, unresolvedRiskObjectives = 0;
  var riskOldIdToNewId = {};
  if(Array.isArray(doc.risks)){
    doc.risks.forEach(function(r){
      if(!r || typeof r !== 'object') return;
      var title = (typeof r.title === 'string' && r.title.trim()) ? r.title.trim().slice(0,120) : null;
      if(!title) return;
      var ownerId = null;
      if(typeof r.ownerId === 'string' && memberOldIdToNewId.hasOwnProperty(r.ownerId)){
        ownerId = memberOldIdToNewId[r.ownerId];
      } else if(typeof r.ownerName === 'string' && memberNameToNewId.hasOwnProperty(r.ownerName.trim())){
        ownerId = memberNameToNewId[r.ownerName.trim()];
      } else if(r.ownerId || r.ownerName){
        unresolvedRiskOwners++;
      }
      var taskId = null;
      if(r.taskId && idMap.hasOwnProperty(r.taskId)){
        taskId = idMap[r.taskId];
      } else if(r.taskId){
        unresolvedRiskTasks++;
      }
      var documentIds = [];
      if(Array.isArray(r.documentIds)){
        r.documentIds.forEach(function(oldDocId){
          if(docOldIdToNewId.hasOwnProperty(oldDocId)) documentIds.push(docOldIdToNewId[oldDocId]);
          else unresolvedRiskDocs++;
        });
      }
      var riskPrincipleIds = [];
      if(Array.isArray(r.principleIds)){
        r.principleIds.forEach(function(oldPrinId){
          if(prinOldIdToNewId.hasOwnProperty(oldPrinId)) riskPrincipleIds.push(prinOldIdToNewId[oldPrinId]);
          else unresolvedRiskPrinciples++;
        });
      }
      var riskObjectiveIds = [];
      if(Array.isArray(r.objectiveIds)){
        r.objectiveIds.forEach(function(oldObjId){
          if(objOldIdToNewId.hasOwnProperty(oldObjId)) riskObjectiveIds.push(objOldIdToNewId[oldObjId]);
          else unresolvedRiskObjectives++;
        });
      }
      var newRisk = {
        id: uid('risk'),
        key: nextRiskKey(project),
        title: title,
        description: (typeof r.description === 'string') ? r.description.trim().slice(0,4000) : '',
        likelihood: clampRiskScoreValue(r.likelihood),
        impact: clampRiskScoreValue(r.impact),
        mitigations: (typeof r.mitigations === 'string') ? r.mitigations.trim().slice(0,2000) : '',
        ownerId: ownerId,
        taskId: taskId,
        documentIds: documentIds,
        principleIds: riskPrincipleIds,
        objectiveIds: riskObjectiveIds,
        status: normalizeRiskStatus(r.status),
        dateToClose: isValidISODateString(r.dateToClose) ? r.dateToClose : null,
        dateClosed: isValidISODateString(r.dateClosed) ? r.dateClosed : null,
        dateCreated: typeof r.dateCreated === 'string' ? r.dateCreated : importedAt,
        dateLastModified: typeof r.dateLastModified === 'string' ? r.dateLastModified : importedAt
      };
      project.risks.push(newRisk);
      if(typeof r.id === 'string') riskOldIdToNewId[r.id] = newRisk.id;
    });
  }

  var unresolvedRetroReleases = 0, unresolvedRetroParticipants = 0, unresolvedRetroAssignees = 0, unresolvedRetroPromotions = 0;
  if(Array.isArray(doc.retrospectives)){
    doc.retrospectives.forEach(function(r){
      if(!r || typeof r !== 'object') return;
      var releaseId = null;
      if(typeof r.releaseId === 'string' && releaseOldIdToNewId.hasOwnProperty(r.releaseId)){
        releaseId = releaseOldIdToNewId[r.releaseId];
      } else if(typeof r.releaseName === 'string' && releaseNameToNewId.hasOwnProperty(r.releaseName)){
        releaseId = releaseNameToNewId[r.releaseName];
      } else if(r.releaseId || r.releaseName){
        unresolvedRetroReleases++;
      }

      var participantIds = [];
      if(Array.isArray(r.participantIds)){
        r.participantIds.forEach(function(pid){
          if(typeof pid === 'string' && memberOldIdToNewId.hasOwnProperty(pid)) participantIds.push(memberOldIdToNewId[pid]);
        });
      }
      if(Array.isArray(r.participantNames)){
        r.participantNames.forEach(function(name){
          if(typeof name !== 'string') return;
          if(memberNameToNewId.hasOwnProperty(name)){
            var resolvedId = memberNameToNewId[name];
            if(participantIds.indexOf(resolvedId) === -1) participantIds.push(resolvedId);
          } else {
            unresolvedRetroParticipants++;
          }
        });
      }

      var items = Array.isArray(r.items) ? r.items.map(function(it, idx){
        if(!it || typeof it !== 'object') return null;
        var promotedPrincipleId = null;
        if(typeof it.promotedPrincipleId === 'string' && prinOldIdToNewId.hasOwnProperty(it.promotedPrincipleId)){
          promotedPrincipleId = prinOldIdToNewId[it.promotedPrincipleId];
        } else if(it.promotedPrincipleId || it.promotedPrincipleKey){
          unresolvedRetroPromotions++;
        }
        return {
          id: uid('retroitem'),
          column: (it.column === 'stop' || it.column === 'keep') ? it.column : 'start',
          text: (typeof it.text === 'string') ? it.text.trim().slice(0, 1000) : '',
          sortOrder: (typeof it.sortOrder === 'number' && isFinite(it.sortOrder)) ? it.sortOrder : idx,
          promotedPrincipleId: promotedPrincipleId
        };
      }).filter(Boolean) : [];

      var actionItems = Array.isArray(r.actionItems) ? r.actionItems.map(function(ai, idx){
        if(!ai || typeof ai !== 'object') return null;
        var assigneeId = null;
        if(typeof ai.assigneeId === 'string' && memberOldIdToNewId.hasOwnProperty(ai.assigneeId)){
          assigneeId = memberOldIdToNewId[ai.assigneeId];
        } else if(typeof ai.assigneeName === 'string' && memberNameToNewId.hasOwnProperty(ai.assigneeName)){
          assigneeId = memberNameToNewId[ai.assigneeName];
        } else if(ai.assigneeId || ai.assigneeName){
          unresolvedRetroAssignees++;
        }
        return {
          id: uid('retroaction'),
          text: (typeof ai.text === 'string') ? ai.text.trim().slice(0, 500) : '',
          assigneeId: assigneeId,
          completed: ai.completed === true,
          sortOrder: (typeof ai.sortOrder === 'number' && isFinite(ai.sortOrder)) ? ai.sortOrder : idx
        };
      }).filter(Boolean) : [];

      var retroN = project.retroCounter++;
      project.retrospectives.push({
        id: uid('retro'),
        key: project.key + '-RETRO-' + String(retroN).padStart(3, '0'),
        releaseId: releaseId,
        team: (typeof r.team === 'string' && r.team.trim()) ? r.team.trim().slice(0, 120) : null,
        background: (typeof r.background === 'string' && r.background.trim()) ? r.background.trim().slice(0, 2000) : null,
        retroDate: isValidISODateString(r.retroDate) ? r.retroDate : null,
        lastTimerDurationSeconds: (typeof r.lastTimerDurationSeconds === 'number' && isFinite(r.lastTimerDurationSeconds) && r.lastTimerDurationSeconds >= 0) ? r.lastTimerDurationSeconds : null,
        participantIds: participantIds,
        items: items,
        actionItems: actionItems,
        dateCreated: typeof r.dateCreated === 'string' ? r.dateCreated : importedAt,
        dateLastModified: typeof r.dateLastModified === 'string' ? r.dateLastModified : importedAt
      });
    });
  }

  var unresolvedDecisionOwners = 0, unresolvedDecisionTasks = 0, unresolvedDecisionDocs = 0, unresolvedDecisionRisks = 0, unresolvedDecisionPrinciples = 0, unresolvedDecisionObjectives = 0;
  if(Array.isArray(doc.approvers)){
    doc.approvers.forEach(function(name){
      if(typeof name === 'string') registerApprover(project, name);
    });
  }
  if(Array.isArray(doc.decisions)){
    doc.decisions.forEach(function(dec){
      if(!dec || typeof dec !== 'object') return;
      var title = (typeof dec.title === 'string' && dec.title.trim()) ? dec.title.trim().slice(0,120) : null;
      if(!title) return;
      var ownerId = null;
      if(typeof dec.ownerId === 'string' && memberOldIdToNewId.hasOwnProperty(dec.ownerId)){
        ownerId = memberOldIdToNewId[dec.ownerId];
      } else if(typeof dec.ownerName === 'string' && memberNameToNewId.hasOwnProperty(dec.ownerName.trim())){
        ownerId = memberNameToNewId[dec.ownerName.trim()];
      } else if(dec.ownerId || dec.ownerName){
        unresolvedDecisionOwners++;
      }
      var taskId = null;
      if(dec.taskId && idMap.hasOwnProperty(dec.taskId)){
        taskId = idMap[dec.taskId];
      } else if(dec.taskId){
        unresolvedDecisionTasks++;
      }
      var documentIds = [];
      if(Array.isArray(dec.documentIds)){
        dec.documentIds.forEach(function(oldDocId){
          if(docOldIdToNewId.hasOwnProperty(oldDocId)) documentIds.push(docOldIdToNewId[oldDocId]);
          else unresolvedDecisionDocs++;
        });
      }
      var riskIds = [];
      if(Array.isArray(dec.riskIds)){
        dec.riskIds.forEach(function(oldRiskId){
          if(riskOldIdToNewId.hasOwnProperty(oldRiskId)) riskIds.push(riskOldIdToNewId[oldRiskId]);
          else unresolvedDecisionRisks++;
        });
      }
      var decPrincipleIds = [];
      if(Array.isArray(dec.principleIds)){
        dec.principleIds.forEach(function(oldPrinId){
          if(prinOldIdToNewId.hasOwnProperty(oldPrinId)) decPrincipleIds.push(prinOldIdToNewId[oldPrinId]);
          else unresolvedDecisionPrinciples++;
        });
      }
      var decObjectiveIds = [];
      if(Array.isArray(dec.objectiveIds)){
        dec.objectiveIds.forEach(function(oldObjId){
          if(objOldIdToNewId.hasOwnProperty(oldObjId)) decObjectiveIds.push(objOldIdToNewId[oldObjId]);
          else unresolvedDecisionObjectives++;
        });
      }
      var newDecision = {
        id: uid('dec'),
        key: nextDecisionKey(project),
        title: title,
        description: (typeof dec.description === 'string') ? dec.description.trim().slice(0,4000) : '',
        type: normalizeDecisionType(dec.type),
        status: normalizeDecisionStatus(dec.status),
        outcome: (typeof dec.outcome === 'string') ? dec.outcome.trim().slice(0,2000) : '',
        ownerId: ownerId,
        approver: (typeof dec.approver === 'string' && dec.approver.trim()) ? registerApprover(project, dec.approver) : null,
        taskId: taskId,
        documentIds: documentIds,
        riskIds: riskIds,
        principleIds: decPrincipleIds,
        objectiveIds: decObjectiveIds,
        dateCreated: typeof dec.dateCreated === 'string' ? dec.dateCreated : importedAt,
        dateLastModified: typeof dec.dateLastModified === 'string' ? dec.dateLastModified : importedAt
      };
      project.decisions.push(newDecision);
    });
  }

  return {
    project: project,
    taskCount: Object.keys(project.tasks).length,
    columnCount: project.columns.length,
    memberCount: project.members.length,
    unresolvedWorkflowNodes: unresolvedWorkflowNodes,
    unresolvedWorkflowEdges: unresolvedWorkflowEdges,
    unresolvedDeps: unresolvedDeps,
    unresolvedAssignees: unresolvedAssignees,
    unresolvedReleases: unresolvedReleases,
    unresolvedTaskTypes: unresolvedTaskTypes,
    unresolvedDocOwners: unresolvedDocOwners,
    unresolvedDocTasks: unresolvedDocTasks,
    unresolvedDocRelated: unresolvedDocRelated,
    unresolvedTcParents: unresolvedTcParents,
    unresolvedTcMembers: unresolvedTcMembers,
    unresolvedMemberReportsTo: unresolvedMemberReportsTo,
    unresolvedRiskOwners: unresolvedRiskOwners,
    unresolvedRiskTasks: unresolvedRiskTasks,
    unresolvedRiskDocs: unresolvedRiskDocs,
    unresolvedRiskPrinciples: unresolvedRiskPrinciples,
    unresolvedRiskObjectives: unresolvedRiskObjectives,
    unresolvedObjectivePrinciples: unresolvedObjectivePrinciples,
    unresolvedDecisionOwners: unresolvedDecisionOwners,
    unresolvedDecisionTasks: unresolvedDecisionTasks,
    unresolvedDecisionDocs: unresolvedDecisionDocs,
    unresolvedDecisionRisks: unresolvedDecisionRisks,
    unresolvedDecisionPrinciples: unresolvedDecisionPrinciples,
    unresolvedDecisionObjectives: unresolvedDecisionObjectives,
    unresolvedRetroReleases: unresolvedRetroReleases,
    unresolvedRetroParticipants: unresolvedRetroParticipants,
    unresolvedRetroAssignees: unresolvedRetroAssignees,
    unresolvedRetroPromotions: unresolvedRetroPromotions,
    cyclesRemoved: cyclesRemoved,
    unresolvedParents: unresolvedParents,
    parentCyclesRemoved: parentCyclesRemoved
  };
}

/* Find an existing project that matches by key (preferred) or by name.
   Returns the matched project or null. */
export function findConflictingProject(name, key){
  for(var i = 0; i < state.db.projectOrder.length; i++){
    var p = state.db.projects[state.db.projectOrder[i]];
    if(!p) continue;
    if(key && p.key === key.toUpperCase()) return p;
  }
  for(var j = 0; j < state.db.projectOrder.length; j++){
    var p2 = state.db.projects[state.db.projectOrder[j]];
    if(!p2) continue;
    if(name && p2.name.trim().toLowerCase() === name.trim().toLowerCase()) return p2;
  }
  return null;
}

/* Apply an import result over an existing project in-place, preserving
   its id and position in the project order, but replacing everything else. */
export function overwriteProjectFromResult(existingId, result){
  var fresh = result.project;
  var existing = state.db.projects[existingId];
  if(!existing) return;
  /* Keep the existing project's own id and key so board-wide references
     (e.g. task keys like DEMO-1) stay consistent for the user. Task keys
     were generated during import using a freshly-deduplicated key (since
     conflict detection happens after the import doc is built), so they
     must be re-prefixed here to match the project's real key — otherwise
     tasks end up keyed like "DEMO2-1" inside a project whose key is
     "DEMO". The numeric suffix is preserved as-is. */
  fresh.id  = existingId;
  fresh.key = existing.key;
  Object.keys(fresh.tasks).forEach(function(taskId){
    var t = fresh.tasks[taskId];
    var match = /-(\d+)$/.exec(t.key || '');
    var suffix = match ? match[1] : String(Object.keys(fresh.tasks).indexOf(taskId) + 1);
    t.key = fresh.key + '-' + suffix;
  });
  (fresh.documents || []).forEach(function(d, idx){
    var match = /-(\d+)$/.exec(d.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    d.key = fresh.key + '-DOC-' + suffix;
  });
  (fresh.risks || []).forEach(function(r, idx){
    var match = /-(\d+)$/.exec(r.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    r.key = fresh.key + '-RISK-' + suffix;
  });
  (fresh.decisions || []).forEach(function(d, idx){
    var match = /-(\d+)$/.exec(d.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    d.key = fresh.key + '-DEC-' + suffix;
  });
  (fresh.principles || []).forEach(function(prin, idx){
    var match = /-(\d+)$/.exec(prin.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    prin.key = fresh.key + '-PRIN-' + suffix;
  });
  (fresh.objectives || []).forEach(function(o, idx){
    var match = /-(\d+)$/.exec(o.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    o.key = fresh.key + '-OBJ-' + suffix;
  });
  (fresh.teamsCommittees || []).forEach(function(tc, idx){
    var match = /-(\d+)$/.exec(tc.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    var prefix = tc.type === 'committee' ? 'COMM' : 'TEAM';
    tc.key = fresh.key + '-' + prefix + '-' + suffix;
  });
  (fresh.retrospectives || []).forEach(function(r, idx){
    var match = /-(\d+)$/.exec(r.key || '');
    var suffix = match ? match[1] : String(idx + 1).padStart(3, '0');
    r.key = fresh.key + '-RETRO-' + suffix;
  });
  state.db.projects[existingId] = fresh;
  state.db.currentProjectId = existingId;
  saveDB();
}

/* Pending state held between the file-read callback and the user's
   conflict-resolution choice. */
export var pendingImport = null;

export function importProjectFromFile(file){
  if(!file) return;
  var reader = new FileReader();
  reader.onerror = function(){ _toast('Could not read that file.'); };
  reader.onload = function(){
    var parsed;
    try{
      parsed = JSON.parse(reader.result);
    }catch(e){
      _toast('That file isn\'t valid JSON.');
      return;
    }

    var result;
    try{
      result = buildProjectFromExportDoc(parsed);
    }catch(e){
      _toast(e.message || 'Could not import that file.');
      return;
    }

    var conflict = findConflictingProject(result.project.name, result.project.key);
    if(conflict){
      pendingImport = {result: result, conflictId: conflict.id};
      var msg = 'A project named “' + escapeHTML(conflict.name) + '” (' + conflict.key + ') already exists on this board. ' +
                'Would you like to overwrite it with the imported data, or keep both as separate projects?';
      document.getElementById('importConflictMessage').innerHTML = msg;
      document.getElementById('importConflictOverlay').classList.remove('hidden');
      return;
    }

    finaliseImport(result, false);
  };
  reader.readAsText(file);
}

export function finaliseImport(result, wasOverwrite){
  state.db.projects[result.project.id] = result.project;
  if(!wasOverwrite) state.db.projectOrder.push(result.project.id);
  state.db.currentProjectId = result.project.id;
  saveDB();
  _resetFilters();
  _renderAll();
  _checkSessionAlerts();

  var msg = (wasOverwrite ? 'Updated' : 'Imported') + ' “' + result.project.name + '” — ' +
            result.taskCount + ' task(s) across ' + result.columnCount + ' column(s)';
  msg += result.memberCount > 0 ? ' and ' + result.memberCount + ' team member(s).' : '.';
  if(result.cyclesRemoved > 0) msg += ' Removed ' + result.cyclesRemoved + ' circular dependency link(s).';
  if(result.unresolvedDeps > 0) msg += ' Skipped ' + result.unresolvedDeps + ' dependency reference(s) that could not be matched.';
  if(result.parentCyclesRemoved > 0) msg += ' Removed ' + result.parentCyclesRemoved + ' circular parent/sub-task link(s).';
  if(result.unresolvedParents > 0) msg += ' Skipped ' + result.unresolvedParents + ' parent task reference(s) that could not be matched.';
  if(result.unresolvedAssignees > 0) msg += ' Skipped ' + result.unresolvedAssignees + ' assignee reference(s) that could not be matched.';
  if(result.unresolvedReleases > 0) msg += ' Skipped ' + result.unresolvedReleases + ' release reference(s) that could not be matched.';
  if(result.unresolvedTaskTypes > 0) msg += ' Skipped ' + result.unresolvedTaskTypes + ' task type reference(s) that could not be matched.';
  var unresolvedDocLinks = (result.unresolvedDocOwners || 0) + (result.unresolvedDocTasks || 0) + (result.unresolvedDocRelated || 0) + (result.unresolvedRiskOwners || 0) + (result.unresolvedRiskTasks || 0) + (result.unresolvedRiskDocs || 0) +
    (result.unresolvedDecisionOwners || 0) + (result.unresolvedDecisionTasks || 0) + (result.unresolvedDecisionDocs || 0) + (result.unresolvedDecisionRisks || 0) +
    (result.unresolvedRiskPrinciples || 0) + (result.unresolvedRiskObjectives || 0) + (result.unresolvedObjectivePrinciples || 0) +
    (result.unresolvedDecisionPrinciples || 0) + (result.unresolvedDecisionObjectives || 0) +
    (result.unresolvedTcParents || 0) + (result.unresolvedTcMembers || 0) + (result.unresolvedMemberReportsTo || 0) +
    (result.unresolvedWorkflowNodes || 0) + (result.unresolvedWorkflowEdges || 0) +
    (result.unresolvedRetroReleases || 0) + (result.unresolvedRetroParticipants || 0) + (result.unresolvedRetroAssignees || 0) + (result.unresolvedRetroPromotions || 0);
  if(unresolvedDocLinks > 0) msg += ' Skipped ' + unresolvedDocLinks + ' document/risk/decision/principle/objective/team/workflow reference(s) that could not be matched.';
  _toast(msg);
}

export function closeImportConflictModal(){
  document.getElementById('importConflictOverlay').classList.add('hidden');
  pendingImport = null;
}
