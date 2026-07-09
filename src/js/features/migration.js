"use strict";
import { state, saveDB } from '../storage.js';
import { buildExportDoc } from './export.js';
import { migrateProjectApi, loginApi, changePasswordApi, getProjectsApi, getProjectDetailApi, taskApi, setToken, isLoggedIn } from '../api.js';

var _toast = function(msg){ console.error(msg); };
export function setMigrationToast(fn){ _toast = fn; }

/* Posts the same document shape exportProjectJSON() writes to a file (features/export.js), plus an
   organisationName the API's MigrationImportRequest requires (it finds-or-creates the Organisation
   by that name — see MigrationService.ResolveOrganisationAsync), to the API's one-time migration
   endpoint.

   Migration itself is deliberately anonymous (bootstrapping — see MigrationController), so if this
   browser isn't ALSO logged in yet, there's no token to read the server's canonical copy back with.
   In that case we just flag the existing local project as migrated (project.serverProjectId) and
   leave everything else local-only for now; logging in afterward runs the exact same
   pullServerProjectsIntoLocal() swap below and finishes the job. If this browser is already logged
   in, we do the full swap immediately: the local project is replaced in place by the server's
   canonical copy, keyed under the new server id — from that point on the project's local id IS its
   server id, so no separate id-mapping bookkeeping is needed anywhere else (see modals/column.js,
   which only treats a project as server-authoritative once project.id === project.serverProjectId). */
export async function migrateProjectToServer(project, organisationName){
  var doc = buildExportDoc(project, new Date().toISOString());
  var payload = Object.assign({organisationName: organisationName}, doc);
  try {
    var result = await migrateProjectApi(payload);
    project.serverProjectId = result.projectId;

    if(isLoggedIn()){
      var oldLocalId = project.id;
      var detail = await getProjectDetailApi(result.projectId);
      state.db.projects[detail.id] = buildLocalProjectFromServerDetail(detail, project);

      var idx = state.db.projectOrder.indexOf(oldLocalId);
      if(idx !== -1) state.db.projectOrder[idx] = detail.id;
      else if(state.db.projectOrder.indexOf(detail.id) === -1) state.db.projectOrder.push(detail.id);
      if(oldLocalId !== detail.id) delete state.db.projects[oldLocalId];
      if(state.db.currentProjectId === oldLocalId) state.db.currentProjectId = detail.id;
    }
    saveDB();

    var message =
      'Migrated to server: ' + result.usersCreated + ' user account(s) created, ' +
      result.usersMatched + ' matched to existing accounts. Default password: enklUserPassword.';
    if(result.warnings && result.warnings.length){
      message += ' ' + result.warnings.join(' ');
      console.warn('Migration warnings:', result.warnings);
    }
    _toast(message);
    return result;
  } catch(e){
    _toast('Migration failed: ' + (e.message || 'unknown error'));
    throw e;
  }
}

export async function loginToServer(username, password){
  try {
    var result = await loginApi(username, password);
    setToken(result.token);
    _toast('Logged in as ' + result.user.displayName + '.');
    return result;
  } catch(e){
    _toast(e.message || 'Login failed.');
    throw e;
  }
}

export function isServerLoggedIn(){
  return isLoggedIn();
}

export async function changePasswordOnServer(currentPassword, newPassword){
  try {
    await changePasswordApi(currentPassword, newPassword);
    _toast('Password changed.');
  } catch(e){
    _toast(e.message || 'Could not change password.');
    throw e;
  }
}

/* Pulls every project the logged-in user is a member of on the server into local state, so a
   project migrated from one browser becomes visible (via the Projects dropdown) in any other
   browser the same account logs into from — this is what was missing before: migrating only ever
   updated the browser that clicked the button. Existing local-only fields the server doesn't model
   yet (headerButtonVisibility, workflow, approvers/roles, the various *Counter fields used when
   creating new Documents/Risks/etc. locally) are preserved from this browser's prior copy if one
   exists, since the server has no opinion on them. */
export async function pullServerProjectsIntoLocal(){
  if(!isLoggedIn()) return 0;
  try {
    var summaries = await getProjectsApi();
    for(var i=0;i<summaries.length;i++){
      var detail = await getProjectDetailApi(summaries[i].id);

      // A project migrated from this exact browser while it wasn't logged in yet (the common case —
      // migration is deliberately anonymous, see migrateProjectToServer above) still sits under its
      // OLD local id: serverProjectId got set at migration time, but id !== serverProjectId, so
      // isServerAuthoritative stays false and every mutation silently stays local-only forever unless
      // that stale entry gets retired here, the same way migrateProjectToServer already does when
      // it's called while already logged in. Without this, logging in afterward just adds a SECOND,
      // disconnected, actually-authoritative copy under the server id — while whatever's still
      // selected in state.db.currentProjectId (almost always the original stale one) keeps eating
      // edits that never leave this browser.
      var staleLocalId = Object.keys(state.db.projects).filter(function(pid){
        return pid !== detail.id && state.db.projects[pid].serverProjectId === detail.id;
      })[0];

      var existing = state.db.projects[detail.id] || (staleLocalId ? state.db.projects[staleLocalId] : undefined);
      state.db.projects[detail.id] = buildLocalProjectFromServerDetail(detail, existing);

      var idx = staleLocalId ? state.db.projectOrder.indexOf(staleLocalId) : -1;
      if(idx !== -1) state.db.projectOrder[idx] = detail.id;
      else if(state.db.projectOrder.indexOf(detail.id) === -1) state.db.projectOrder.push(detail.id);

      if(staleLocalId && staleLocalId !== detail.id){
        delete state.db.projects[staleLocalId];
        if(state.db.currentProjectId === staleLocalId) state.db.currentProjectId = detail.id;
      }
    }
    saveDB();
    return summaries.length;
  } catch(e){
    console.error('Failed to pull server projects:', e);
    return 0;
  }
}

/* True once a project has been migrated AND this browser has synced the server's canonical copy
   (both project.serverProjectId is set AND project.id === project.serverProjectId — see
   migrateProjectToServer/pullServerProjectsIntoLocal above). Only checking serverProjectId isn't
   enough: a project can be migrated by a browser that isn't logged in yet, in which case
   serverProjectId gets set but the local ids are still pre-migration local ids, so they wouldn't be
   valid server ids to send back in an API call until a login-triggered pull swaps everything over. */
export function isServerAuthoritative(project){
  return !!(project && project.serverProjectId && project.id === project.serverProjectId);
}

/* Shared by every entity modal (task, release, document, risk, ...): calls the given API mutation,
   then re-pulls the whole project from the server so this browser's view — and every other
   collaborator's — stays consistent, and returns the refreshed project. Callers still handle their
   own try/catch (for a mutation-specific error message), closing their modal, and re-rendering. */
export async function syncEntityChange(project, apiCall){
  await apiCall();
  return refreshProjectFromServer(project.id);
}

/* Builds an UpdateTaskRequest body from a local task object (all its current field values), with
   any of those fields overridden — the shared shape every "change one thing about an existing
   task and keep everything else the same" server sync uses (move between columns, reactivate from
   archive, sub-task reconciliation in modals/task.js). */
function taskToServerBody(t, overrides){
  return Object.assign({
    title: t.title, description: t.description, priority: t.priority,
    columnId: t.columnId, assigneeId: t.assigneeId || null,
    releaseId: t.releaseId || null, typeId: t.typeId || null,
    parentTaskId: t.parentTaskId || null, dependsOnTaskIds: t.dependencies || [],
    documentationUrl: t.documentationUrl || null,
    startDate: t.startDate ? t.startDate.slice(0, 10) : null, endDate: t.endDate ? t.endDate.slice(0, 10) : null,
    businessValue: t.businessValue, taskCost: t.taskCost, progress: t.progress,
    estimatedEffort: t.estimatedEffort, actualEffort: t.actualEffort, archived: t.archived
  }, overrides || {});
}

/* Shared by drag-and-drop (views/board.js) and bulk-edit's column change (features/bulk-edit.js):
   moves a task to a different column on the server, preserving its other current fields. Only the
   column changes server-side — there's no intra-column ordering field in the server model yet (only
   Column.Order, the column's own position among columns), so a drop position within the column is a
   local-only detail that doesn't survive a refresh for a server-authoritative project. */
export async function moveTaskToColumnOnServer(project, taskId, targetColumnId){
  var t = project.tasks[taskId];
  if(!t) return;
  await taskApi.update(project.serverProjectId, taskId, taskToServerBody(t, {columnId: targetColumnId}));
  return refreshProjectFromServer(project.id);
}

/* Used by the Archived Tasks panel's bulk "Reactivate" action — flips archived to false for each
   selected task, one update per task (no bulk endpoint yet), then a single refresh at the end. */
export async function setTasksArchivedOnServer(project, taskIds, archived){
  for(var i = 0; i < taskIds.length; i++){
    var t = project.tasks[taskIds[i]];
    if(!t || t.isPrivate) continue; // private tasks never exist server-side — see modals/task.js
    await taskApi.update(project.serverProjectId, taskIds[i], taskToServerBody(t, {archived: archived}));
  }
  return refreshProjectFromServer(project.id);
}

var BULK_EDIT_FIELD_TO_TASK_FIELD = {
  columnId: 'columnId', releaseId: 'releaseId', priority: 'priority', typeId: 'typeId',
  assigneeId: 'assigneeId', startDate: 'startDate', endDate: 'endDate',
  businessValue: 'businessValue', taskCost: 'taskCost', progress: 'progress'
};

/* Used by the Bulk Edit overlay (features/bulk-edit.js) — `edits` is ui.bulkEdits, a map of
   taskId -> {field: newValue} for only the fields the user actually changed on that row. Applies
   each touched task as one UpdateTaskRequest (its other fields come from this browser's current
   local copy), then a single refresh at the end, same batching shape as setTasksArchivedOnServer
   above. Returns how many tasks were actually sent to the server. */
export async function applyBulkEditsOnServer(project, edits){
  var taskIds = Object.keys(edits);
  var changedCount = 0;
  for(var i = 0; i < taskIds.length; i++){
    var taskId = taskIds[i];
    var t = project.tasks[taskId];
    if(!t || t.isPrivate) continue; // private tasks never exist server-side — see modals/task.js
    var rowEdits = edits[taskId];
    var overrides = {};
    Object.keys(BULK_EDIT_FIELD_TO_TASK_FIELD).forEach(function(field){
      if(!rowEdits.hasOwnProperty(field)) return;
      var value = rowEdits[field];
      if(field === 'startDate' || field === 'endDate') value = value ? value.slice(0, 10) : null;
      overrides[field] = value;
    });
    if(Object.keys(overrides).length === 0) continue;
    await taskApi.update(project.serverProjectId, taskId, taskToServerBody(t, overrides));
    changedCount++;
  }
  if(changedCount > 0) await refreshProjectFromServer(project.id);
  return changedCount;
}

/* Re-fetches one project's full detail from the server and replaces the local copy in place — used
   after any server-authoritative mutation so this browser's view never drifts from what the server
   (and therefore every other collaborator) actually has. */
export async function refreshProjectFromServer(localProjectId){
  var detail = await getProjectDetailApi(localProjectId);
  var existing = state.db.projects[localProjectId];
  state.db.projects[localProjectId] = buildLocalProjectFromServerDetail(detail, existing);
  saveDB();
  return state.db.projects[localProjectId];
}

/* Used by openWorkflowOverlay (views/workflow-editor.js) to start each editing session from the
   server's current workflow — unlike refreshProjectFromServer above, this deliberately bypasses
   buildLocalProjectFromServerDetail's "local wins" merge for the workflow field (see the comment on
   that field), since here we WANT the server's copy to win: the caller only invokes this when this
   browser has no unsaved local workflow draft to protect (see workflowEditorState.dirty). */
export async function pullWorkflowFromServer(project){
  var detail = await getProjectDetailApi(project.serverProjectId);
  project.workflow = detail.workflow || project.workflow || null;
  saveDB();
  return project.workflow;
}

function maxTaskCounterFrom(tasks){
  var max = 0;
  (tasks || []).forEach(function(t){
    var dash = t.key.lastIndexOf('-');
    if(dash < 0) return;
    var n = parseInt(t.key.slice(dash + 1), 10);
    if(!isNaN(n) && n >= max) max = n;
  });
  return max + 1;
}

/* Converts a ProjectDetailDto (the API's GET /api/projects/{id} response shape) into the app's
   local runtime project shape (see createDefaultProject in storage.js). `existingLocal`, when
   present, supplies fields the server doesn't model so a re-pull doesn't wipe them out. */
function buildLocalProjectFromServerDetail(detail, existingLocal){
  var now = new Date().toISOString();
  var preserved = existingLocal || {};

  var columnsById = {};
  var columns = detail.columns.slice().sort(function(a, b){ return a.order - b.order; }).map(function(c){
    var col = {id: c.id, name: c.name, done: c.done, color: c.color || null, order: []};
    columnsById[c.id] = col;
    return col;
  });

  var tasks = {};
  detail.tasks.forEach(function(t){
    tasks[t.id] = {
      id: t.id, key: t.key, title: t.title, description: t.description || '',
      priority: t.priority, columnId: t.columnId,
      dependencies: t.dependsOnTaskIds || [],
      assigneeId: t.assigneeId || null,
      releaseId: t.releaseId || null,
      typeId: t.typeId || null,
      parentTaskId: t.parentTaskId || null,
      documentationUrl: t.documentationUrl || null,
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      businessValue: t.businessValue,
      taskCost: t.taskCost,
      progress: t.progress,
      estimatedEffort: t.estimatedEffort,
      actualEffort: t.actualEffort,
      archived: !!t.archived,
      /* Not modeled server-side yet — a private task's encrypted content does not currently survive
         migration or cross-browser sync. Flagged as a known gap, not silently dropped. */
      isPrivate: false, privateSalt: null, privateVerifier: null, encryptedDescription: null, encryptionIv: null,
      dateCreated: t.dateCreated, dateLastModified: t.dateLastModified, dateDone: t.dateDone || null,
      auditLog: (t.auditLog || []).map(function(a){
        return {timestamp: a.timestamp, field: a.field, oldValue: a.oldValue, newValue: a.newValue, changedBy: a.changedBy || null};
      })
    };
    if(columnsById[t.columnId]) columnsById[t.columnId].order.push(t.id);
  });

  var members = detail.members.map(function(m){
    return {id: m.id, name: m.displayName, color: m.color, role: m.role || null, reportsToId: m.reportsToId || null};
  });
  var releases = (detail.releases || []).map(function(r){
    return {id: r.id, name: r.name, status: r.status, ownerId: r.ownerId || null, startDate: r.startDate || null, endDate: r.endDate || null, dateCreated: now, dateLastModified: now};
  });
  var taskTypes = (detail.taskTypes || []).map(function(t){
    return {id: t.id, name: t.name, iconName: t.iconName || null};
  });
  var principles = (detail.principles || []).map(function(p){
    return {id: p.id, key: p.key, title: p.title, description: p.description || '', documentUrl: p.documentUrl || null, dateCreated: now, dateLastModified: now};
  });
  var documents = (detail.documents || []).map(function(d){
    return {id: d.id, key: d.key, title: d.title, url: d.url || null, description: d.description || '', ownerId: d.ownerId || null, taskId: d.taskId || null, relatedDocumentIds: d.relatedDocumentIds || [], dateCreated: now, dateLastModified: now};
  });
  var risks = (detail.risks || []).map(function(r){
    return {id: r.id, key: r.key, title: r.title, description: r.description || '', likelihood: r.likelihood, impact: r.impact, mitigations: r.mitigations || '', ownerId: r.ownerId || null, taskId: r.taskId || null, documentIds: r.documentIds || [], principleIds: r.principleIds || [], objectiveIds: r.objectiveIds || [], status: r.status, dateToClose: r.dateToClose || null, dateClosed: r.dateClosed || null, dateCreated: now, dateLastModified: now};
  });
  var objectives = (detail.objectives || []).map(function(o){
    return {id: o.id, key: o.key, title: o.title, description: o.description || '', principleIds: o.principleIds || [], dateCreated: now, dateLastModified: now};
  });
  var teamsCommittees = (detail.teamsCommittees || []).map(function(tc){
    return {id: tc.id, key: tc.key, name: tc.name, description: tc.description || '', type: tc.type, parentId: tc.parentId || null, memberIds: tc.memberIds || [], dateCreated: now, dateLastModified: now};
  });
  var decisions = (detail.decisions || []).map(function(dec){
    return {id: dec.id, key: dec.key, title: dec.title, description: dec.description || '', type: dec.type, status: dec.status, outcome: dec.outcome || '', ownerId: dec.ownerId || null, approver: dec.approver || null, taskId: dec.taskId || null, documentIds: dec.documentIds || [], riskIds: dec.riskIds || [], principleIds: dec.principleIds || [], objectiveIds: dec.objectiveIds || [], dateCreated: now, dateLastModified: now};
  });

  return {
    id: detail.id,
    serverProjectId: detail.id,
    name: detail.name,
    key: detail.key,
    taskCounter: preserved.taskCounter || maxTaskCounterFrom(detail.tasks),
    columns: columns,
    tasks: tasks,
    members: members,
    releases: releases,
    taskTypes: taskTypes,
    documents: documents,
    docCounter: preserved.docCounter || 1,
    risks: risks,
    riskCounter: preserved.riskCounter || 1,
    decisions: decisions,
    decCounter: preserved.decCounter || 1,
    principles: principles,
    prinCounter: preserved.prinCounter || 1,
    objectives: objectives,
    objCounter: preserved.objCounter || 1,
    teamsCommittees: teamsCommittees,
    tcCounter: preserved.tcCounter || 1,
    approvers: preserved.approvers || [],
    roles: preserved.roles || [],
    /* Server-authoritative once a project is migrated (see isServerAuthoritative below) — the
       server's copy wins over whatever this browser had cached, same as every other field here,
       so a setting changed from a different browser/collaborator shows up on refresh. */
    headerButtonVisibility: detail.headerButtonVisibility || preserved.headerButtonVisibility || {documents: true, risks: true, decisions: true},
    /* Unlike every other field here, local wins over the server's copy — the Workflow editor edits
       project.workflow directly (many mutations per drag) and only pushes to the server on an
       explicit "Save Workflow" click (views/workflow-editor.js), so a refresh triggered by some
       unrelated entity save (e.g. editing a task while the Workflow overlay sits open with unsaved
       changes) must never silently clobber a draft this browser hasn't pushed yet. Server is only
       consulted as a fallback — e.g. this browser's very first load after another browser saved one. */
    workflow: preserved.workflow || detail.workflow || null,
    startDate: preserved.startDate || null,
    endDate: preserved.endDate || null,
    dateCreated: preserved.dateCreated || now,
    dateLastModified: now,
    dateLastExported: preserved.dateLastExported || null
  };
}
