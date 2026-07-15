"use strict";
import { state, saveDB, uid, makeColumn, clampColumnCap, defaultTaskTypes, normalizeHeaderButtonVisibility, createDefaultProject, createProjectFromTemplate, isChangeAuditingEnabled, isSubTasksEnabled } from './storage.js';
import { getTasksArray, getTaskTypeById, getColumn, getMemberById, getReleaseById, getDocumentById, getRiskById, getDecisionById, getPrincipleById, getObjectiveById, getTeamCommitteeById, getRetrospectiveById, getRetrospectiveItemById, getRetrospectiveActionItemById, isValidTaskTypeIconName, TASK_TYPE_ICON_LIBRARY, escapeHTML } from './utils.js';
import { evaluateColumnMove, getWorkflowConditionField, WORKFLOW_CONDITION_OPERATORS, WORKFLOW_DEFAULT_CONDITION, computeReflowedLayout } from './features/workflow-engine.js';
import { clampTaskScore, clampProgress, clampEffortHours, clampAllocatedFraction, localDateValueToUTCISO, defaultStartDateValue, defaultEndDateValue, memberColorForIndex } from './date-utils.js';
import { PRIORITY_META, RISK_STATUS_META, DECISION_TYPE_META, DECISION_STATUS_META, TEAM_COMMITTEE_TYPES } from './config.js';
import { iconSvg } from './icons.js';

var _toast = function(msg){ console.error(msg); };
export function setMutationsToast(fn){ _toast = fn; }

export function addProject(name, key, startDate, endDate, templateId, description){
  var template = templateId ? state.db.templates.filter(function(t){ return t.id === templateId; })[0] : null;
  var p = template ? createProjectFromTemplate(name, key, template) : createDefaultProject(name, key);
  p.startDate = startDate || null;
  p.endDate = endDate || null;
  p.description = (description || '').trim().slice(0, 4000);
  state.db.projects[p.id] = p;
  state.db.projectOrder.push(p.id);
  state.db.currentProjectId = p.id;
  saveDB();
}
export function renameProject(projectId, name, key, startDate, endDate, description){
  var p = state.db.projects[projectId];
  if(!p) return;
  p.name = name;
  p.key = (key || p.key).toUpperCase().slice(0,6);
  p.startDate = startDate || null;
  p.endDate = endDate || null;
  p.description = (description || '').trim().slice(0, 4000);
  p.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteProject(projectId){
  delete state.db.projects[projectId];
  state.db.projectOrder = state.db.projectOrder.filter(function(id){ return id !== projectId; });
  if(state.db.currentProjectId === projectId){
    state.db.currentProjectId = state.db.projectOrder[0] || null;
  }
  if(!state.db.currentProjectId){
    var p = createDefaultProject('My Project', 'PROJ');
    state.db.projects[p.id] = p;
    state.db.projectOrder.push(p.id);
    state.db.currentProjectId = p.id;
  }
  saveDB();
}

/* ---- Team members (scoped per project) ---- */
export function addMember(project, name){
  var trimmed = (name || '').trim().slice(0, 60);
  if(!trimmed) return null;
  // A local-only member is never backed by a real account (see modals/team.js's comment
  // contrasting this with the server-authoritative "add", which creates a User), so email is
  // always null here — nothing to enter, nothing to validate. It's only ever populated by a
  // refresh from the server (see features/migration.js's buildLocalProjectFromServerDetail) once
  // this project is migrated and an Org Admin has set one on the underlying account.
  var member = {id: uid('member'), name: trimmed, email: null, color: memberColorForIndex(project.members.length), role: null, reportsToId: null, allocatedFraction: null};
  project.members.push(member);
  saveDB();
  return member;
}
export function renameMember(project, memberId, name){
  var member = getMemberById(project, memberId);
  if(!member) return;
  var trimmed = (name || '').trim().slice(0, 60);
  if(!trimmed) return;
  member.name = trimmed;
  saveDB();
}
export function setMemberRole(project, memberId, role){
  var member = getMemberById(project, memberId);
  if(!member) return;
  var trimmed = (role || '').trim();
  member.role = trimmed ? registerRole(project, trimmed) : null;
  saveDB();
}
export function setMemberAllocatedFraction(project, memberId, value){
  var member = getMemberById(project, memberId);
  if(!member) return;
  member.allocatedFraction = clampAllocatedFraction(value);
  saveDB();
}
export function setMemberReportsTo(project, memberId, reportsToId){
  var member = getMemberById(project, memberId);
  if(!member) return;
  if(!reportsToId || reportsToId === memberId || !getMemberById(project, reportsToId)){
    member.reportsToId = null;
  } else {
    member.reportsToId = reportsToId;
  }
  saveDB();
}
export function removeMember(project, memberId){
  var member = getMemberById(project, memberId);
  if(!member) return 0;
  project.members = project.members.filter(function(m){ return m.id !== memberId; });
  var unassignedCount = 0;
  getTasksArray(project).forEach(function(t){
    if(t.assigneeId === memberId){ t.assigneeId = null; unassignedCount++; }
  });
  (project.documents || []).forEach(function(d){
    if(d.ownerId === memberId) d.ownerId = null;
  });
  (project.risks || []).forEach(function(r){
    if(r.ownerId === memberId) r.ownerId = null;
  });
  (project.decisions || []).forEach(function(d){
    if(d.ownerId === memberId) d.ownerId = null;
  });
  removeMemberFromAllTeamsCommittees(project, memberId);
  project.members.forEach(function(m){
    if(m.reportsToId === memberId) m.reportsToId = null;
  });
  saveDB();
  return unassignedCount;
}

/* =========================================================
   TASK TYPES
   A per-project, user-managed set of task types (e.g. Feature, Bug).
   A Task may have at most one type; the default for a task is none.
   ========================================================= */
/* Library of selectable icons for Task Types — shown in the icon
   picker in the order listed here. A type's icon is only ever what
   the user explicitly assigns (default: none); there is no automatic
   fallback icon, so an unassigned type shows nothing on a task. */
export var TASK_TYPE_ICON_LIBRARY_LOCAL = [
  {name: 'sparkle', label: 'Feature'},
  {name: 'bug', label: 'Bug'},
  {name: 'ty_investigate', label: 'Investigate'},
  {name: 'ty_document', label: 'Document'},
  {name: 'ty_analyse', label: 'Analyse'},
  {name: 'ty_procure', label: 'Procure'},
  {name: 'ty_audit', label: 'Audit'},
  {name: 'ty_report', label: 'Report'},
  {name: 'ty_communicate', label: 'Communicate'},
  {name: 'ty_design', label: 'Design'},
  {name: 'ty_develop', label: 'Develop'},
  {name: 'ty_test', label: 'Test'},
  {name: 'ty_review', label: 'Review'},
  {name: 'ty_plan', label: 'Plan'},
  {name: 'ty_research', label: 'Research'},
  {name: 'ty_train', label: 'Train'},
  {name: 'ty_support', label: 'Support'},
  {name: 'ty_deploy', label: 'Deploy'},
  {name: 'ty_migrate', label: 'Migrate'},
  {name: 'ty_configure', label: 'Configure'},
  {name: 'ty_monitor', label: 'Monitor'},
  {name: 'ty_approve', label: 'Approve'},
  {name: 'ty_negotiate', label: 'Negotiate'},
  {name: 'ty_schedule', label: 'Schedule'},
  {name: 'ty_maintain', label: 'Maintain'},
  {name: 'ty_coordinate', label: 'Coordinate'}
];
export function getTaskTypeIconLabel(iconName){
  var entry = TASK_TYPE_ICON_LIBRARY.filter(function(i){ return i.name === iconName; })[0];
  return entry ? entry.label : '';
}
export function setTaskTypeIcon(project, typeId, iconName){
  var type = getTaskTypeById(project, typeId);
  if(!type) return;
  type.iconName = (iconName && isValidTaskTypeIconName(iconName)) ? iconName : null;
  saveDB();
}
export function buildTaskTypeIconGridHTML(selectedIconName){
  return TASK_TYPE_ICON_LIBRARY.map(function(icon){
    var selected = icon.name === selectedIconName;
    return '<button type="button" class="kf-tasktype-icon-option' + (selected ? ' selected' : '') + '" data-icon-name="' + icon.name + '" title="' + escapeHTML(icon.label) + '">' + iconSvg(icon.name, 18) + '</button>';
  }).join('');
}
export function closeAllTaskTypeIconPanels(){
  document.querySelectorAll('.kf-tasktype-icon-panel').forEach(function(panel){
    panel.classList.add('hidden');
  });
}
/* The panel is position:fixed (so it floats above the scrollable type
   list instead of being clipped by it), so its coordinates have to be
   computed relative to the viewport each time it opens — it doesn't
   automatically follow its trigger the way an absolutely-positioned
   popover nested inside it would. */
export function positionTaskTypeIconPanel(triggerBtn, panel){
  var rect = triggerBtn.getBoundingClientRect();
  var panelWidth = 220;
  var left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
  panel.style.left = left + 'px';
  var panelHeight = panel.getBoundingClientRect().height || 260;
  var spaceBelow = window.innerHeight - rect.bottom;
  if(spaceBelow < panelHeight + 8 && rect.top > panelHeight + 8){
    panel.style.top = Math.max(8, rect.top - panelHeight - 4) + 'px';
  } else {
    panel.style.top = (rect.bottom + 4) + 'px';
  }
}
export function addTaskType(project, name){
  var trimmed = (name || '').trim().slice(0, 40);
  if(!trimmed) return null;
  var type = {id: uid('type'), name: trimmed, iconName: null};
  project.taskTypes.push(type);
  saveDB();
  return type;
}
export function renameTaskType(project, typeId, name){
  var type = getTaskTypeById(project, typeId);
  if(!type) return;
  var trimmed = (name || '').trim().slice(0, 40);
  if(!trimmed) return;
  type.name = trimmed;
  saveDB();
}
export function removeTaskType(project, typeId){
  var type = getTaskTypeById(project, typeId);
  if(!type) return 0;
  project.taskTypes = project.taskTypes.filter(function(tt){ return tt.id !== typeId; });
  var unassignedCount = 0;
  getTasksArray(project).forEach(function(t){
    if(t.typeId === typeId){ t.typeId = null; unassignedCount++; }
  });
  saveDB();
  return unassignedCount;
}

/* ---- Project Templates (local/offline fallback — signed-in users' templates live server-side, see
   features/migration.js createTemplateOnServer/fetchTemplatesFromServer) ---- */
export function addTemplate(name, snapshot){
  var trimmed = (name || '').trim().slice(0, 200);
  if(!trimmed) return null;
  var now = new Date().toISOString();
  var template = {
    id: uid('tmpl'), name: trimmed,
    columns: snapshot.columns, taskTypes: snapshot.taskTypes, workflow: snapshot.workflow, settings: snapshot.settings,
    dateCreated: now, dateLastModified: now
  };
  state.db.templates.push(template);
  saveDB();
  return template;
}
export function renameTemplate(templateId, name){
  var template = state.db.templates.filter(function(t){ return t.id === templateId; })[0];
  if(!template) return;
  var trimmed = (name || '').trim().slice(0, 200);
  if(!trimmed) return;
  template.name = trimmed;
  template.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteTemplate(templateId){
  state.db.templates = state.db.templates.filter(function(t){ return t.id !== templateId; });
  saveDB();
}

/* ---- To-Do Lists (local/offline fallback — signed-in users' lists live server-side, see
   features/migration.js's fetchTodoListsFromServer/createTodoListOnServer/etc.). The app's first
   per-USER (not per-project) resource — state.db.todoLists sits at the top level of state.db, a
   sibling of `templates`/`projects`, not nested inside any one project. ---- */
export function addTodoList(title){
  var trimmed = (title || '').trim().slice(0, 200);
  if(!trimmed) return null;
  var now = new Date().toISOString();
  var list = {id: uid('todo'), title: trimmed, items: [], dateCreated: now, dateLastModified: now};
  state.db.todoLists.push(list);
  saveDB();
  return list;
}
export function renameTodoList(listId, title){
  var list = state.db.todoLists.filter(function(l){ return l.id === listId; })[0];
  if(!list) return;
  var trimmed = (title || '').trim().slice(0, 200);
  if(!trimmed) return;
  list.title = trimmed;
  list.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteTodoList(listId){
  state.db.todoLists = state.db.todoLists.filter(function(l){ return l.id !== listId; });
  saveDB();
}
export function addTodoItem(listId, note, dueDate){
  var list = state.db.todoLists.filter(function(l){ return l.id === listId; })[0];
  if(!list) return null;
  var now = new Date().toISOString();
  var item = {id: uid('titem'), note: note || '', completed: false, dueDate: dueDate || null, dateCreated: now, dateLastModified: now};
  list.items.push(item);
  list.dateLastModified = now;
  saveDB();
  return item;
}
export function updateTodoItem(listId, itemId, note, completed, dueDate){
  var list = state.db.todoLists.filter(function(l){ return l.id === listId; })[0];
  if(!list) return;
  var item = list.items.filter(function(i){ return i.id === itemId; })[0];
  if(!item) return;
  item.note = note || '';
  item.completed = !!completed;
  item.dueDate = dueDate || null;
  item.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteTodoItem(listId, itemId){
  var list = state.db.todoLists.filter(function(l){ return l.id === listId; })[0];
  if(!list) return;
  list.items = list.items.filter(function(i){ return i.id !== itemId; });
  saveDB();
}

/* =========================================================
   RELEASES
   A Project can have many Releases; a Task can belong to at most one.
   ========================================================= */
export var RELEASE_STATUS_ORDER = ['pending', 'in_progress', 'deployed'];
export var RELEASE_STATUS_META = {
  pending: {label: 'Pending'},
  in_progress: {label: 'In Progress'},
  deployed: {label: 'Deployed'}
};
export function normalizeReleaseStatus(value){
  return RELEASE_STATUS_META.hasOwnProperty(value) ? value : 'pending';
}
export function getReleaseStatusMeta(value){
  return RELEASE_STATUS_META[normalizeReleaseStatus(value)];
}
export function addRelease(project, data){
  var now = new Date().toISOString();
  var name = (data.name || '').trim().slice(0, 80) || 'Untitled release';
  var release = {
    id: uid('release'),
    name: name,
    status: normalizeReleaseStatus(data.status),
    ownerId: data.ownerId || null,
    startDate: data.startDate || null,
    endDate: data.endDate || null,
    dateCreated: now,
    dateLastModified: now
  };
  project.releases.push(release);
  saveDB();
  return release;
}
export function updateRelease(project, releaseId, data){
  var release = getReleaseById(project, releaseId);
  if(!release) return;
  var name = (data.name || '').trim().slice(0, 80);
  release.name = name || release.name;
  release.status = normalizeReleaseStatus(data.status);
  release.ownerId = data.ownerId || null;
  release.startDate = data.startDate || null;
  release.endDate = data.endDate || null;
  release.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteRelease(project, releaseId){
  var release = getReleaseById(project, releaseId);
  if(!release) return 0;
  project.releases = project.releases.filter(function(r){ return r.id !== releaseId; });
  var unassignedCount = 0;
  getTasksArray(project).forEach(function(t){
    if(t.releaseId === releaseId){ t.releaseId = null; unassignedCount++; }
  });
  saveDB();
  return unassignedCount;
}

/* =========================================================
   DOCUMENTS
   A per-project register of reference documents — each with an
   autogenerated key (<PROJECT>-DOC-NNN), an external URL, an owner
   drawn from Team Members, and an optional link to a single Task.
   ========================================================= */
export function nextDocKey(project){
  var n = project.docCounter++;
  return project.key + '-DOC-' + String(n).padStart(3, '0');
}
export function normalizeDocumentationUrl(value){
  var trimmed = (value || '').trim();
  if(!trimmed) return null;
  // Only a bare host/path (no scheme) gets https:// prepended, same as before — mailto: is
  // detected separately since it has no "//" authority part to match the first regex.
  var hasSchemeAndAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  var isMailto = /^mailto:/i.test(trimmed);
  var candidate = (hasSchemeAndAuthority || isMailto) ? trimmed : 'https://' + trimmed;
  var parsed;
  try {
    parsed = new URL(candidate);
  } catch(e){
    return null;
  }
  // Explicit allowlist — closes the javascript:/data:/vbscript: URL-scheme bypass (security review
  // finding H3): those values used to pass through unmodified into href=/window.open() call sites
  // (modals/documents.js, modals/principles.js, modals/task.js) and execute on click.
  if(['http:', 'https:', 'mailto:'].indexOf(parsed.protocol) === -1) return null;
  return candidate.slice(0, 500);
}
export function addDocument(project, data){
  var now = new Date().toISOString();
  var doc = {
    id: uid('doc'),
    key: nextDocKey(project),
    title: (data.title || '').trim().slice(0, 120) || 'Untitled document',
    url: normalizeDocumentationUrl(data.url),
    description: (data.description || '').trim().slice(0, 1000),
    ownerId: data.ownerId || null,
    taskId: data.taskId || null,
    relatedDocumentIds: Array.isArray(data.relatedDocumentIds) ? data.relatedDocumentIds.slice() : [],
    dateCreated: now,
    dateLastModified: now
  };
  project.documents.push(doc);
  saveDB();
  return doc;
}
export function updateDocument(project, docId, data){
  var doc = getDocumentById(project, docId);
  if(!doc) return;
  var title = (data.title || '').trim().slice(0, 120);
  doc.title = title || doc.title;
  doc.url = normalizeDocumentationUrl(data.url);
  doc.description = (data.description || '').trim().slice(0, 1000);
  doc.ownerId = data.ownerId || null;
  doc.taskId = data.taskId || null;
  /* A document can never relate to itself — filtered defensively here
     too, not just in the UI, in case data ever arrives some other way
     (e.g. a future import path). */
  doc.relatedDocumentIds = Array.isArray(data.relatedDocumentIds)
    ? data.relatedDocumentIds.filter(function(id){ return id !== docId; })
    : [];
  doc.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteDocument(project, docId){
  var doc = getDocumentById(project, docId);
  if(!doc) return 0;
  project.documents = project.documents.filter(function(d){ return d.id !== docId; });
  var unlinkedCount = 0;
  (project.risks || []).forEach(function(r){
    if(r.documentIds && r.documentIds.indexOf(docId) !== -1){
      r.documentIds = r.documentIds.filter(function(id){ return id !== docId; });
      unlinkedCount++;
    }
  });
  (project.decisions || []).forEach(function(d){
    if(d.documentIds && d.documentIds.indexOf(docId) !== -1){
      d.documentIds = d.documentIds.filter(function(id){ return id !== docId; });
      unlinkedCount++;
    }
  });
  project.documents.forEach(function(d){
    if(d.relatedDocumentIds && d.relatedDocumentIds.indexOf(docId) !== -1){
      d.relatedDocumentIds = d.relatedDocumentIds.filter(function(id){ return id !== docId; });
      unlinkedCount++;
    }
  });
  saveDB();
  return unlinkedCount;
}

/* =========================================================
   RISKS
   A per-project risk register following a standard 5x5 risk matrix:
   likelihood (1-5) x impact (1-5), each independently rated. A Risk
   may link to a single Task and to zero or more Documents.
   ========================================================= */
export function clampRiskScoreValue(v){
  var n = Math.round(Number(v));
  if(!isFinite(n)) return 1;
  return Math.max(1, Math.min(5, n));
}
export function normalizeRiskStatus(value){
  return RISK_STATUS_META.hasOwnProperty(value) ? value : 'new';
}
export function getRiskStatusMeta(value){
  return RISK_STATUS_META[normalizeRiskStatus(value)];
}
export function riskScore(risk){
  return clampRiskScoreValue(risk.likelihood) * clampRiskScoreValue(risk.impact);
}
/* Standard 5x5 matrix banding: 1-4 Low, 5-9 Medium, 10-15 High, 16-25 Critical. */
export function riskScoreBand(score){
  if(score >= 16) return 'critical';
  if(score >= 10) return 'high';
  if(score >= 5) return 'medium';
  return 'low';
}
export function nextRiskKey(project){
  var n = project.riskCounter++;
  return project.key + '-RISK-' + String(n).padStart(3, '0');
}
export function addRisk(project, data){
  var now = new Date().toISOString();
  var risk = {
    id: uid('risk'),
    key: nextRiskKey(project),
    title: (data.title || '').trim().slice(0, 120) || 'Untitled risk',
    description: (data.description || '').trim().slice(0, 4000),
    likelihood: clampRiskScoreValue(data.likelihood),
    impact: clampRiskScoreValue(data.impact),
    mitigations: (data.mitigations || '').trim().slice(0, 2000),
    ownerId: data.ownerId || null,
    taskId: data.taskId || null,
    documentIds: Array.isArray(data.documentIds) ? data.documentIds.slice() : [],
    principleIds: Array.isArray(data.principleIds) ? data.principleIds.slice() : [],
    objectiveIds: Array.isArray(data.objectiveIds) ? data.objectiveIds.slice() : [],
    status: normalizeRiskStatus(data.status),
    dateToClose: data.dateToClose || null,
    dateClosed: data.dateClosed || null,
    dateCreated: now,
    dateLastModified: now
  };
  project.risks.push(risk);
  saveDB();
  return risk;
}
export function updateRisk(project, riskId, data){
  var risk = getRiskById(project, riskId);
  if(!risk) return;
  var title = (data.title || '').trim().slice(0, 120);
  risk.title = title || risk.title;
  risk.description = (data.description || '').trim().slice(0, 4000);
  risk.likelihood = clampRiskScoreValue(data.likelihood);
  risk.impact = clampRiskScoreValue(data.impact);
  risk.mitigations = (data.mitigations || '').trim().slice(0, 2000);
  risk.ownerId = data.ownerId || null;
  risk.taskId = data.taskId || null;
  risk.documentIds = Array.isArray(data.documentIds) ? data.documentIds.slice() : [];
  risk.principleIds = Array.isArray(data.principleIds) ? data.principleIds.slice() : [];
  risk.objectiveIds = Array.isArray(data.objectiveIds) ? data.objectiveIds.slice() : [];
  risk.status = normalizeRiskStatus(data.status);
  risk.dateToClose = data.dateToClose || null;
  risk.dateClosed = data.dateClosed || null;
  risk.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteRisk(project, riskId){
  var risk = getRiskById(project, riskId);
  if(!risk) return false;
  project.risks = project.risks.filter(function(r){ return r.id !== riskId; });
  (project.decisions || []).forEach(function(d){
    if(d.riskIds && d.riskIds.indexOf(riskId) !== -1){
      d.riskIds = d.riskIds.filter(function(id){ return id !== riskId; });
    }
  });
  saveDB();
  return true;
}

/* =========================================================
   DECISIONS
   A per-project decision log — each with an autogenerated key
   (<PROJECT>-DEC-NNN), exactly one type, an owner drawn from Team
   Members, an optional link to a single Task, and zero or more
   linked Documents.
   ========================================================= */
export function normalizeDecisionType(value){
  return DECISION_TYPE_META.hasOwnProperty(value) ? value : 'strategy';
}
export function normalizeDecisionStatus(value){
  return DECISION_STATUS_META.hasOwnProperty(value) ? value : 'open';
}
export function getDecisionStatusMeta(value){
  return DECISION_STATUS_META[normalizeDecisionStatus(value)];
}
export function getDecisionTypeMeta(value){
  return DECISION_TYPE_META[normalizeDecisionType(value)];
}
/* Generic "free-text combobox backed by a per-project vocabulary"
   helper — matching is case-insensitive so e.g. "Developer" and
   "developer" reuse the same entry rather than creating a near-
   duplicate, but the casing of whichever value was entered FIRST is
   what's kept/reused. Used by both the Decision Approver field and
   Team Member Role. */
export function registerVocabularyValue(list, name, maxLen){
  var trimmed = (name || '').trim().slice(0, maxLen || 80);
  if(!trimmed) return null;
  var existing = list.filter(function(v){ return v.toLowerCase() === trimmed.toLowerCase(); })[0];
  if(existing) return existing;
  list.push(trimmed);
  return trimmed;
}
export function registerApprover(project, name){
  if(!Array.isArray(project.approvers)) project.approvers = [];
  return registerVocabularyValue(project.approvers, name, 80);
}
export function registerRole(project, name){
  if(!Array.isArray(project.roles)) project.roles = [];
  return registerVocabularyValue(project.roles, name, 60);
}
export function nextDecisionKey(project){
  var n = project.decCounter++;
  return project.key + '-DEC-' + String(n).padStart(3, '0');
}
export function addDecision(project, data){
  var now = new Date().toISOString();
  var decision = {
    id: uid('dec'),
    key: nextDecisionKey(project),
    title: (data.title || '').trim().slice(0, 120) || 'Untitled decision',
    description: (data.description || '').trim().slice(0, 4000),
    type: normalizeDecisionType(data.type),
    status: normalizeDecisionStatus(data.status),
    outcome: (data.outcome || '').trim().slice(0, 2000),
    ownerId: data.ownerId || null,
    approver: registerApprover(project, data.approver),
    taskId: data.taskId || null,
    documentIds: Array.isArray(data.documentIds) ? data.documentIds.slice() : [],
    riskIds: Array.isArray(data.riskIds) ? data.riskIds.slice() : [],
    principleIds: Array.isArray(data.principleIds) ? data.principleIds.slice() : [],
    objectiveIds: Array.isArray(data.objectiveIds) ? data.objectiveIds.slice() : [],
    dateCreated: now,
    dateLastModified: now
  };
  project.decisions.push(decision);
  saveDB();
  return decision;
}
export function updateDecision(project, decisionId, data){
  var decision = getDecisionById(project, decisionId);
  if(!decision) return;
  var title = (data.title || '').trim().slice(0, 120);
  decision.title = title || decision.title;
  decision.description = (data.description || '').trim().slice(0, 4000);
  decision.type = normalizeDecisionType(data.type);
  decision.status = normalizeDecisionStatus(data.status);
  decision.outcome = (data.outcome || '').trim().slice(0, 2000);
  decision.ownerId = data.ownerId || null;
  decision.approver = registerApprover(project, data.approver);
  decision.taskId = data.taskId || null;
  decision.documentIds = Array.isArray(data.documentIds) ? data.documentIds.slice() : [];
  decision.riskIds = Array.isArray(data.riskIds) ? data.riskIds.slice() : [];
  decision.principleIds = Array.isArray(data.principleIds) ? data.principleIds.slice() : [];
  decision.objectiveIds = Array.isArray(data.objectiveIds) ? data.objectiveIds.slice() : [];
  decision.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteDecision(project, decisionId){
  var decision = getDecisionById(project, decisionId);
  if(!decision) return false;
  project.decisions = project.decisions.filter(function(d){ return d.id !== decisionId; });
  saveDB();
  return true;
}

/* =========================================================
   PRINCIPLES
   A per-project register of guiding principles — each with an
   autogenerated key (<PROJECT>-PRIN-NNN), a description, and a link
   to an external document. Risks may associate with zero or more.
   ========================================================= */
export function nextPrincipleKey(project){
  var n = project.prinCounter++;
  return project.key + '-PRIN-' + String(n).padStart(3, '0');
}
export function addPrinciple(project, data){
  var now = new Date().toISOString();
  var principle = {
    id: uid('prin'),
    key: nextPrincipleKey(project),
    title: (data.title || '').trim().slice(0, 120) || 'Untitled principle',
    description: (data.description || '').trim().slice(0, 4000),
    documentUrl: normalizeDocumentationUrl(data.documentUrl),
    /* Organisation Library sharing is a server-only concept (see modals/principles.js's Share
       checkbox, only ever shown for a server-authoritative project) — always false for a freshly
       created local-only principle. */
    isOrganisationWide: false,
    dateCreated: now,
    dateLastModified: now
  };
  project.principles.push(principle);
  saveDB();
  return principle;
}
export function updatePrinciple(project, principleId, data){
  var principle = getPrincipleById(project, principleId);
  if(!principle) return;
  var title = (data.title || '').trim().slice(0, 120);
  principle.title = title || principle.title;
  principle.description = (data.description || '').trim().slice(0, 4000);
  principle.documentUrl = normalizeDocumentationUrl(data.documentUrl);
  principle.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deletePrinciple(project, principleId){
  var principle = getPrincipleById(project, principleId);
  if(!principle) return 0;
  project.principles = project.principles.filter(function(p){ return p.id !== principleId; });
  var unlinkedCount = 0;
  (project.objectives || []).forEach(function(o){
    if(o.principleIds && o.principleIds.indexOf(principleId) !== -1){
      o.principleIds = o.principleIds.filter(function(id){ return id !== principleId; });
      unlinkedCount++;
    }
  });
  (project.risks || []).forEach(function(r){
    if(r.principleIds && r.principleIds.indexOf(principleId) !== -1){
      r.principleIds = r.principleIds.filter(function(id){ return id !== principleId; });
      unlinkedCount++;
    }
  });
  (project.decisions || []).forEach(function(d){
    if(d.principleIds && d.principleIds.indexOf(principleId) !== -1){
      d.principleIds = d.principleIds.filter(function(id){ return id !== principleId; });
      unlinkedCount++;
    }
  });
  saveDB();
  return unlinkedCount;
}

/* =========================================================
   OBJECTIVES
   A per-project register of objectives — each with an autogenerated
   key (<PROJECT>-OBJ-NNN) and zero or more Principles it's "Bound by".
   Risks may associate with zero or more Objectives.
   ========================================================= */
export function nextObjectiveKey(project){
  var n = project.objCounter++;
  return project.key + '-OBJ-' + String(n).padStart(3, '0');
}
export function addObjective(project, data){
  var now = new Date().toISOString();
  var objective = {
    id: uid('obj'),
    key: nextObjectiveKey(project),
    title: (data.title || '').trim().slice(0, 120) || 'Untitled objective',
    description: (data.description || '').trim().slice(0, 4000),
    principleIds: Array.isArray(data.principleIds) ? data.principleIds.slice() : [],
    dateCreated: now,
    dateLastModified: now
  };
  project.objectives.push(objective);
  saveDB();
  return objective;
}
export function updateObjective(project, objectiveId, data){
  var objective = getObjectiveById(project, objectiveId);
  if(!objective) return;
  var title = (data.title || '').trim().slice(0, 120);
  objective.title = title || objective.title;
  objective.description = (data.description || '').trim().slice(0, 4000);
  objective.principleIds = Array.isArray(data.principleIds) ? data.principleIds.slice() : [];
  objective.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteObjective(project, objectiveId){
  var objective = getObjectiveById(project, objectiveId);
  if(!objective) return 0;
  project.objectives = project.objectives.filter(function(o){ return o.id !== objectiveId; });
  var unlinkedCount = 0;
  (project.risks || []).forEach(function(r){
    if(r.objectiveIds && r.objectiveIds.indexOf(objectiveId) !== -1){
      r.objectiveIds = r.objectiveIds.filter(function(id){ return id !== objectiveId; });
      unlinkedCount++;
    }
  });
  (project.decisions || []).forEach(function(d){
    if(d.objectiveIds && d.objectiveIds.indexOf(objectiveId) !== -1){
      d.objectiveIds = d.objectiveIds.filter(function(id){ return id !== objectiveId; });
      unlinkedCount++;
    }
  });
  saveDB();
  return unlinkedCount;
}

/* =========================================================
   RETROSPECTIVES
   A per-project register of retrospective sessions — each with an
   autogenerated key (<PROJECT>-RETRO-NNN), an optional link to a
   Release, a free-text Team/Background, a RetroDate, a Participants
   list (project member ids), a fixed 3-column board (start/stop/keep)
   of free-text items, and an Action Items checklist. Local-only
   (non-server-authoritative) shape mirrors the server's RetrospectiveDto
   exactly — items/actionItems live as sub-arrays on the retrospective
   itself — so the same render code in modals/retrospectives.js works
   whether this project is local or server-backed. ========================================================= */
export function nextRetroKey(project){
  var n = project.retroCounter++;
  return project.key + '-RETRO-' + String(n).padStart(3, '0');
}
export function addRetrospective(project, data){
  var now = new Date().toISOString();
  var retro = {
    id: uid('retro'),
    key: nextRetroKey(project),
    releaseId: data.releaseId || null,
    team: (data.team || '').trim().slice(0, 120) || null,
    background: (data.background || '').trim().slice(0, 2000) || null,
    retroDate: data.retroDate || null,
    lastTimerDurationSeconds: (typeof data.lastTimerDurationSeconds === 'number' && isFinite(data.lastTimerDurationSeconds)) ? data.lastTimerDurationSeconds : null,
    participantIds: Array.isArray(data.participantIds) ? data.participantIds.slice() : [],
    items: [],
    actionItems: [],
    dateCreated: now,
    dateLastModified: now
  };
  project.retrospectives.push(retro);
  saveDB();
  return retro;
}
export function updateRetrospective(project, retrospectiveId, data){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return;
  retro.releaseId = data.releaseId || null;
  retro.team = (data.team || '').trim().slice(0, 120) || null;
  retro.background = (data.background || '').trim().slice(0, 2000) || null;
  retro.retroDate = data.retroDate || null;
  if(typeof data.lastTimerDurationSeconds === 'number' && isFinite(data.lastTimerDurationSeconds)){
    retro.lastTimerDurationSeconds = data.lastTimerDurationSeconds;
  }
  retro.participantIds = Array.isArray(data.participantIds) ? data.participantIds.slice() : [];
  retro.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteRetrospective(project, retrospectiveId){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return false;
  project.retrospectives = project.retrospectives.filter(function(r){ return r.id !== retrospectiveId; });
  saveDB();
  return true;
}

export function normalizeRetroColumn(value){
  return (value === 'stop' || value === 'keep') ? value : 'start';
}

export function addRetrospectiveItem(project, retrospectiveId, data){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return null;
  var column = normalizeRetroColumn(data.column);
  var sortOrder = retro.items.filter(function(it){ return it.column === column; }).length;
  var item = {
    id: uid('retroitem'),
    column: column,
    text: (data.text || '').trim().slice(0, 1000),
    sortOrder: sortOrder,
    promotedPrincipleId: null
  };
  retro.items.push(item);
  retro.dateLastModified = new Date().toISOString();
  saveDB();
  return item;
}
export function updateRetrospectiveItem(project, retrospectiveId, itemId, data){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return;
  var item = getRetrospectiveItemById(retro, itemId);
  if(!item) return;
  item.column = normalizeRetroColumn(data.column);
  item.text = (data.text || '').trim().slice(0, 1000);
  if(typeof data.sortOrder === 'number' && isFinite(data.sortOrder)) item.sortOrder = data.sortOrder;
  retro.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteRetrospectiveItem(project, retrospectiveId, itemId){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return false;
  var before = retro.items.length;
  retro.items = retro.items.filter(function(it){ return it.id !== itemId; });
  if(retro.items.length === before) return false;
  retro.dateLastModified = new Date().toISOString();
  saveDB();
  return true;
}

export function addRetrospectiveActionItem(project, retrospectiveId, data){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return null;
  var actionItem = {
    id: uid('retroaction'),
    text: (data.text || '').trim().slice(0, 500),
    assigneeId: data.assigneeId || null,
    completed: false,
    sortOrder: retro.actionItems.length
  };
  retro.actionItems.push(actionItem);
  retro.dateLastModified = new Date().toISOString();
  saveDB();
  return actionItem;
}
export function updateRetrospectiveActionItem(project, retrospectiveId, itemId, data){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return;
  var actionItem = getRetrospectiveActionItemById(retro, itemId);
  if(!actionItem) return;
  actionItem.text = (data.text || '').trim().slice(0, 500);
  actionItem.assigneeId = data.assigneeId || null;
  actionItem.completed = !!data.completed;
  if(typeof data.sortOrder === 'number' && isFinite(data.sortOrder)) actionItem.sortOrder = data.sortOrder;
  retro.dateLastModified = new Date().toISOString();
  saveDB();
}
export function deleteRetrospectiveActionItem(project, retrospectiveId, itemId){
  var retro = getRetrospectiveById(project, retrospectiveId);
  if(!retro) return false;
  var before = retro.actionItems.length;
  retro.actionItems = retro.actionItems.filter(function(ai){ return ai.id !== itemId; });
  if(retro.actionItems.length === before) return false;
  retro.dateLastModified = new Date().toISOString();
  saveDB();
  return true;
}

/* =========================================================
   TEAMS & COMMITTEES
   A hierarchical org structure: each node is either a Team or a
   Committee, has 0 or 1 parent, and 0+ Team Members. Membership is
   stored in EXACTLY ONE place (memberIds on the team/committee) —
   there is no separate, editable copy on the Team Member, so the two
   views can never drift out of sync. The Team modal can only ever
   show membership read-only; the team/committee's own form is the
   single source of truth for editing it.
   ========================================================= */
export function normalizeTeamCommitteeType(value){
  return value === 'committee' ? 'committee' : 'team';
}
export function nextTeamCommitteeKey(project, type){
  var n = project.tcCounter++;
  var prefix = normalizeTeamCommitteeType(type) === 'committee' ? 'COMM' : 'TEAM';
  return project.key + '-' + prefix + '-' + String(n).padStart(3, '0');
}
/* True if `candidateAncestorId` is anywhere in `id`'s ancestor chain
   (or IS `id` itself) — used to reject a parent assignment that would
   create a cycle. */
export function isTeamCommitteeAncestor(project, id, candidateAncestorId){
  var current = getTeamCommitteeById(project, candidateAncestorId);
  var guard = 0;
  while(current && guard < 1000){
    if(current.id === id) return true;
    current = current.parentId ? getTeamCommitteeById(project, current.parentId) : null;
    guard++;
  }
  return false;
}
export function getTeamCommitteeChildren(project, parentId){
  return (project.teamsCommittees || []).filter(function(tc){ return (tc.parentId || null) === (parentId || null); });
}
export function addTeamCommittee(project, data){
  var now = new Date().toISOString();
  var type = normalizeTeamCommitteeType(data.type);
  var parentId = data.parentId && getTeamCommitteeById(project, data.parentId) ? data.parentId : null;
  var tc = {
    id: uid('tc'),
    key: nextTeamCommitteeKey(project, type),
    name: (data.name || '').trim().slice(0, 120) || 'Untitled team',
    description: (data.description || '').trim().slice(0, 4000),
    type: type,
    parentId: parentId,
    memberIds: Array.isArray(data.memberIds) ? data.memberIds.slice() : [],
    dateCreated: now,
    dateLastModified: now
  };
  project.teamsCommittees.push(tc);
  saveDB();
  return tc;
}
export function updateTeamCommittee(project, id, data){
  var tc = getTeamCommitteeById(project, id);
  if(!tc) return {ok: false, reason: 'not-found'};
  var name = (data.name || '').trim().slice(0, 120);
  var proposedParentId = data.parentId || null;
  if(proposedParentId){
    if(proposedParentId === id || !getTeamCommitteeById(project, proposedParentId)){
      proposedParentId = null;
    } else if(isTeamCommitteeAncestor(project, id, proposedParentId)){
      return {ok: false, reason: 'cycle'};
    }
  }
  tc.name = name || tc.name;
  tc.description = (data.description || '').trim().slice(0, 4000);
  tc.type = normalizeTeamCommitteeType(data.type);
  tc.parentId = proposedParentId;
  tc.memberIds = Array.isArray(data.memberIds) ? data.memberIds.slice() : [];
  tc.dateLastModified = new Date().toISOString();
  saveDB();
  return {ok: true};
}
export function deleteTeamCommittee(project, id){
  var tc = getTeamCommitteeById(project, id);
  if(!tc) return {orphanedCount: 0};
  var orphanedCount = 0;
  (project.teamsCommittees || []).forEach(function(child){
    if(child.parentId === id){ child.parentId = null; orphanedCount++; }
  });
  project.teamsCommittees = project.teamsCommittees.filter(function(t){ return t.id !== id; });
  saveDB();
  return {orphanedCount: orphanedCount};
}
export function removeMemberFromAllTeamsCommittees(project, memberId){
  var removedCount = 0;
  (project.teamsCommittees || []).forEach(function(tc){
    if(tc.memberIds && tc.memberIds.indexOf(memberId) !== -1){
      tc.memberIds = tc.memberIds.filter(function(mid){ return mid !== memberId; });
      removedCount++;
    }
  });
  return removedCount;
}
/* Read-only: which teams/committees a given member currently belongs
   to, for display on their own row in the Team modal. */
export function getTeamsCommitteesForMember(project, memberId){
  return (project.teamsCommittees || [])
    .filter(function(tc){ return tc.memberIds && tc.memberIds.indexOf(memberId) !== -1; })
    .sort(function(a, b){ return a.name.localeCompare(b.name); });
}
/* Builds the full tree, hierarchical-then-alphabetical at every
   level (roots sorted alphabetically, each node's children sorted
   alphabetically under it), as a flat list of {node, depth} entries
   in display order — convenient for rendering without recursion in
   the UI layer. */
export function buildTeamCommitteeTree(project){
  var all = project.teamsCommittees || [];
  var byParent = {};
  all.forEach(function(tc){
    var key = tc.parentId || '__root__';
    if(!byParent[key]) byParent[key] = [];
    byParent[key].push(tc);
  });
  Object.keys(byParent).forEach(function(key){
    byParent[key].sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });
  });
  var flat = [];
  function walk(parentKey, depth){
    (byParent[parentKey] || []).forEach(function(tc){
      flat.push({node: tc, depth: depth});
      walk(tc.id, depth + 1);
    });
  }
  walk('__root__', 0);
  return flat;
}

/* =========================================================
   COLUMNS
   ========================================================= */
export function addColumn(project, name, done, color){
  var col = makeColumn(name, done, color);
  project.columns.push(col);
  saveDB();
  return col;
}
export function updateColumn(project, columnId, name, done, color){
  var col = getColumn(project, columnId);
  if(!col) return;
  col.name = name;
  col.done = !!done;
  col.color = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  saveDB();
}
export function setColumnCap(project, columnId, cap){
  var col = getColumn(project, columnId);
  if(!col) return;
  col.cap = clampColumnCap(cap);
  saveDB();
}
export function deleteColumn(project, columnId){
  if(project.columns.length <= 1){
    _toast("A board needs at least one column.");
    return false;
  }
  var col = getColumn(project, columnId);
  if(!col) return false;
  /* Cascades to every task in the column (deleteTask handles its own cleanup — dependencies,
     sub-task orphaning, document/risk/decision unlinking) rather than reassigning them elsewhere,
     matching the server's ColumnService.DeleteAsync. col.order is copied first since deleteTask
     mutates every column's order array (including this one) as it goes. */
  col.order.slice().forEach(function(taskId){ deleteTask(project, taskId); });
  project.columns = project.columns.filter(function(c){ return c.id !== columnId; });
  if(project.workflow){
    delete project.workflow.nodes[columnId];
    project.workflow.edges = project.workflow.edges.filter(function(e){
      return e.fromColumnId !== columnId && e.toColumnId !== columnId;
    });
  }
  saveDB();
  return true;
}

/* =========================================================
   WORKFLOW (state machine editor)
   ========================================================= */
export function setWorkflowNodePosition(project, columnId, x, y){
  if(!project.workflow) return;
  var node = project.workflow.nodes[columnId];
  if(!node) return;
  node.x = x;
  node.y = y;
  saveDB();
}
export function reflowWorkflowLayout(project){
  if(!project.workflow) return;
  var positions = computeReflowedLayout(project);
  Object.keys(positions).forEach(function(colId){ project.workflow.nodes[colId] = positions[colId]; });
  saveDB();
}
function normalizeWorkflowEdgeType(type){
  return (type === 'disallowed' || type === 'conditional') ? type : 'allowed';
}
/* Defends against a condition referencing a field/operator that isn't
   (or is no longer) part of the shared vocabulary in workflow-engine.js
   — falls back to the default condition / first valid operator for the
   field rather than persisting something evaluateCondition can't trust. */
function normalizeWorkflowCondition(condition){
  var field = getWorkflowConditionField(condition && condition.field);
  if(!field) return Object.assign({}, WORKFLOW_DEFAULT_CONDITION);
  var operators = WORKFLOW_CONDITION_OPERATORS[field.valueKind];
  var opDef = operators.filter(function(o){ return o.key === (condition && condition.operator); })[0] || operators[0];
  var value = null;
  if(opDef.needsValue){
    if(field.valueKind === 'number'){
      value = Number(condition.value);
      if(!isFinite(value)) value = 0;
    } else {
      value = String(condition.value == null ? '' : condition.value).slice(0, 80);
    }
  }
  return {field: field.key, operator: opDef.key, value: value};
}
export function buildWorkflowEdgeFields(type, message, condition){
  var normalizedType = normalizeWorkflowEdgeType(type);
  return {
    type: normalizedType,
    message: (normalizedType === 'disallowed' || normalizedType === 'conditional') ? ((message || '').trim().slice(0, 300) || null) : null,
    condition: normalizedType === 'conditional' ? normalizeWorkflowCondition(condition || WORKFLOW_DEFAULT_CONDITION) : null
  };
}
export function addWorkflowEdge(project, fromColumnId, toColumnId, type, message, condition){
  if(!project.workflow || fromColumnId === toColumnId) return null;
  var fields = buildWorkflowEdgeFields(type, message, condition);
  var existing = project.workflow.edges.filter(function(e){
    return e.fromColumnId === fromColumnId && e.toColumnId === toColumnId;
  })[0];
  if(existing){
    existing.type = fields.type;
    existing.message = fields.message;
    existing.condition = fields.condition;
    saveDB();
    return existing;
  }
  var edge = Object.assign({id: uid('wfedge'), fromColumnId: fromColumnId, toColumnId: toColumnId}, fields);
  project.workflow.edges.push(edge);
  saveDB();
  return edge;
}
export function updateWorkflowEdge(project, edgeId, type, message, condition){
  if(!project.workflow) return;
  var edge = project.workflow.edges.filter(function(e){ return e.id === edgeId; })[0];
  if(!edge) return;
  var fields = buildWorkflowEdgeFields(type, message, condition);
  edge.type = fields.type;
  edge.message = fields.message;
  edge.condition = fields.condition;
  saveDB();
}
export function deleteWorkflowEdge(project, edgeId){
  if(!project.workflow) return;
  project.workflow.edges = project.workflow.edges.filter(function(e){ return e.id !== edgeId; });
  saveDB();
}
export function reorderColumns(project, draggedId, targetId){
  var fromIdx = project.columns.findIndex(function(c){ return c.id === draggedId; });
  var toIdx = project.columns.findIndex(function(c){ return c.id === targetId; });
  if(fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  var col = project.columns.splice(fromIdx,1)[0];
  project.columns.splice(toIdx,0,col);
  saveDB();
}

/* =========================================================
   CHANGE AUDITING
   Opt-in per project (see isChangeAuditingEnabled). Only edits to an
   *existing* task are recorded — addTask() never calls into this, so
   a task's own creation never shows up as a "change". Entries are
   newest-first (unshift) so the Task modal can render them directly
   without re-sorting.
   ========================================================= */
var AUDIT_FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  priority: 'Priority',
  columnId: 'Column',
  assigneeId: 'Assignee',
  releaseId: 'Release',
  typeId: 'Type',
  documentationUrl: 'Documentation',
  startDate: 'Start date',
  endDate: 'End date',
  businessValue: 'Business Value',
  taskCost: 'Task Cost',
  progress: 'Progress',
  estimatedEffort: 'Estimated effort',
  actualEffort: 'Actual effort',
  archived: 'Archived',
  isPrivate: 'Private',
  dependencies: 'Depends on',
  parentTaskId: 'Parent Task'
};
export function getAuditFieldLabel(field){
  return AUDIT_FIELD_LABELS[field] || field;
}

/* Every field diffed by updateTask's generic before/after comparison,
   EXCEPT columnId — that one only ever changes via moveTaskToColumn
   (called both from here and from drag-and-drop / bulk edit), so it
   records its own single audit entry there instead of being diffed
   twice. */
var AUDIT_DIFFED_FIELDS = Object.keys(AUDIT_FIELD_LABELS).filter(function(f){ return f !== 'columnId'; });

function auditValuesEqual(a, b){
  if(Array.isArray(a) || Array.isArray(b)){
    var aa = (Array.isArray(a) ? a.slice() : []).sort();
    var bb = (Array.isArray(b) ? b.slice() : []).sort();
    return JSON.stringify(aa) === JSON.stringify(bb);
  }
  var na = a === undefined ? null : a;
  var nb = b === undefined ? null : b;
  return na === nb;
}

/* An audit entry's oldValue/newValue must always end up a plain string (or null) — every DTO that
   ever carries one, on both the .NET and PHP tiers (server-recorded edits already go through this
   exact same string/null-only convention via TaskService.cs's FormatAuditValue), types it as a bare
   string. Several AUDIT_DIFFED_FIELDS are NOT strings before this point though (businessValue/
   taskCost/progress/estimatedEffort/actualEffort are numbers, archived/isPrivate are booleans,
   dependencies is an array) — storing/exporting one of those raw caused a real bug: migrating a
   project whose audit history included one of these fields failed with a 400 (JSON number/boolean/
   array couldn't bind to ImportAuditLogEntryDto's string OldValue/NewValue). Mirrors FormatAuditValue's
   own array convention (comma-joined, "[]" for empty) for consistency with server-recorded entries. */
export function formatAuditValue(value){
  if(value === undefined || value === null) return null;
  if(Array.isArray(value)) return value.length === 0 ? '[]' : value.join(',');
  return String(value);
}

/* Appends one audit entry for a single field change. Safe to call
   unconditionally — it's a no-op whenever auditing is off for this
   project, so call sites never need their own gating check. */
export function pushTaskAuditEntry(project, task, field, oldValue, newValue){
  if(!isChangeAuditingEnabled(project)) return;
  if(!Array.isArray(task.auditLog)) task.auditLog = [];
  task.auditLog.unshift({
    timestamp: new Date().toISOString(),
    field: field,
    oldValue: formatAuditValue(oldValue),
    newValue: formatAuditValue(newValue)
  });
}

/* Mirrors the exact clamp/fallback each field goes through when
   written (see updateTask/addTask below) so a "before" value pulled
   from a legacy/pre-migration task — where a numeric field can be
   genuinely `undefined` rather than its normalized default — compares
   equal to a freshly-written, already-normalized "after" value instead
   of showing a phantom change on the very first edit of an old task. */
function normalizeAuditFieldValue(field, value){
  switch(field){
    case 'description': return value || '';
    case 'priority': return value || 'medium';
    case 'assigneeId': case 'releaseId': case 'typeId': case 'startDate': case 'endDate':
      return value || null;
    case 'documentationUrl': return normalizeDocumentationUrl(value);
    case 'businessValue': case 'taskCost': return clampTaskScore(value);
    case 'progress': return clampProgress(value);
    case 'estimatedEffort': case 'actualEffort': return clampEffortHours(value);
    case 'archived': case 'isPrivate': return !!value;
    case 'dependencies': return Array.isArray(value) ? value : [];
    case 'parentTaskId': return value || null;
    default: return value;
  }
}

/* Generic before/after diff for a full task edit (the Task modal's
   Save path). Description is skipped entirely whenever privacy is (or
   was) in play — for a private task its plaintext never touches the
   `description` field at all (see saveTaskFromModal), but diffing it
   unconditionally would still record the plaintext at the exact
   moment a task *becomes* private, defeating the point of privacy. */
function recordTaskFieldChanges(project, task, before, after){
  if(!isChangeAuditingEnabled(project)) return;
  var skipDescription = !!before.isPrivate || !!after.isPrivate;
  AUDIT_DIFFED_FIELDS.forEach(function(field){
    if(field === 'description' && skipDescription) return;
    var oldVal = normalizeAuditFieldValue(field, before[field]);
    var newVal = normalizeAuditFieldValue(field, after[field]);
    if(auditValuesEqual(oldVal, newVal)) return;
    pushTaskAuditEntry(project, task, field, oldVal, newVal);
  });
}

/* =========================================================
   TASKS
   ========================================================= */
export function addTask(project, data){
  var col = getColumn(project, data.columnId) || project.columns[0];
  var n = project.taskCounter++;
  var now = new Date().toISOString();
  var t = {
    id: uid('task'),
    key: project.key + '-' + n,
    title: data.title,
    description: data.description || '',
    priority: data.priority || 'medium',
    columnId: col.id,
    dependencies: data.dependencies || [],
    assigneeId: data.assigneeId || null,
    releaseId: data.releaseId || null,
    typeId: data.typeId || null,
    documentationUrl: normalizeDocumentationUrl(data.documentationUrl),
    /* Defensive fallback only — the task modal already prefills these
       defaults (today / +14 days) before the user ever saves, so this
       just protects any other call path from ending up with no dates. */
    startDate: data.startDate || localDateValueToUTCISO(defaultStartDateValue()),
    endDate: data.endDate || localDateValueToUTCISO(defaultEndDateValue()),
    businessValue: clampTaskScore(data.businessValue),
    taskCost: clampTaskScore(data.taskCost),
    progress: clampProgress(data.progress),
    estimatedEffort: clampEffortHours(data.estimatedEffort),
    actualEffort: clampEffortHours(data.actualEffort),
    archived: !!data.archived,
    isPrivate: !!data.isPrivate,
    privateSalt: data.privateSalt || null,
    privateVerifier: data.privateVerifier || null,
    encryptedDescription: data.encryptedDescription || null,
    encryptionIv: data.encryptionIv || null,
    dateCreated: now,
    dateLastModified: now,
    /* A task can be created directly into a Done column (e.g. logging
       already-finished work) — that counts as "transitioning to Done"
       same as dragging it there would, so it gets a completion date
       immediately rather than staying null until some later edit. */
    dateDone: col.done ? now : null,
    auditLog: [],
    parentTaskId: data.parentTaskId || null
  };
  project.tasks[t.id] = t;
  col.order.push(t.id);
  saveDB();
  return t.id;
}

/* Returns null on success, or {allowed:false, message} if a workflow-
   disallowed column change was rejected — the caller (saveTaskFromModal)
   surfaces that message instead of "Task updated." In normal use this
   is unreachable, since the Edit Task modal's Column dropdown is
   already filtered to reachable columns (see getReachableColumnIds) —
   this is a belt-and-suspenders guard for the second moveTaskToColumn
   call site, not a primary UX surface. */
export function updateTask(project, taskId, data){
  var t = project.tasks[taskId];
  if(!t) return null;
  var before = Object.assign({}, t);
  t.title = data.title;
  t.description = data.description || '';
  t.priority = data.priority || 'medium';
  t.dependencies = data.dependencies || [];
  t.assigneeId = data.assigneeId || null;
  t.releaseId = data.releaseId || null;
  t.typeId = data.typeId || null;
  t.documentationUrl = normalizeDocumentationUrl(data.documentationUrl);
  t.startDate = data.startDate || null;
  t.endDate = data.endDate || null;
  t.businessValue = clampTaskScore(data.businessValue);
  t.taskCost = clampTaskScore(data.taskCost);
  t.progress = clampProgress(data.progress);
  t.estimatedEffort = clampEffortHours(data.estimatedEffort);
  t.actualEffort = clampEffortHours(data.actualEffort);
  t.archived = !!data.archived;
  t.isPrivate = !!data.isPrivate;
  t.privateSalt = data.privateSalt || null;
  t.privateVerifier = data.privateVerifier || null;
  t.encryptedDescription = data.encryptedDescription || null;
  t.encryptionIv = data.encryptionIv || null;
  t.parentTaskId = data.parentTaskId || null;
  t.dateLastModified = new Date().toISOString();
  var blocked = null;
  if(data.columnId && data.columnId !== t.columnId){
    var result = evaluateColumnMove(project, t, data.columnId);
    if(result.allowed) moveTaskToColumn(project, taskId, data.columnId, -1);
    else blocked = result;
  }
  recordTaskFieldChanges(project, t, before, t);
  saveDB();
  return blocked;
}

export function deleteTask(project, taskId){
  delete project.tasks[taskId];
  project.columns.forEach(function(c){ c.order = c.order.filter(function(id){ return id !== taskId; }); });
  getTasksArray(project).forEach(function(t){
    if(t.dependencies && t.dependencies.indexOf(taskId) !== -1){
      t.dependencies = t.dependencies.filter(function(id){ return id !== taskId; });
    }
    /* Its sub-tasks aren't deleted along with it — they're orphaned
       back up to top-level, same as how a deleted release/column
       leaves its former members intact rather than cascading. */
    if(t.parentTaskId === taskId) t.parentTaskId = null;
  });
  (project.documents || []).forEach(function(d){
    if(d.taskId === taskId) d.taskId = null;
  });
  (project.risks || []).forEach(function(r){
    if(r.taskId === taskId) r.taskId = null;
  });
  (project.decisions || []).forEach(function(d){
    if(d.taskId === taskId) d.taskId = null;
  });
  saveDB();
}

/* Sets task `taskId`'s set of sub-tasks (children) to exactly
   `subtaskIds` — the inverse edit of the Parent Task picker, but
   applied to *other* tasks. There's no separate "children" list
   stored anywhere (see the SUB-TASKS block in utils.js), so this is
   the only place that ever needs to reconcile it: any task currently
   parented here that's no longer in the list gets un-parented, and
   any newly-listed task gets parented here. Self-contained (checks
   the feature flag and calls saveDB() itself) since it's invoked
   directly from the Task modal's save flow, a separate step from
   updateTask(). */
export function setTaskSubtasks(project, taskId, subtaskIds){
  if(!isSubTasksEnabled(project)) return;
  var desired = new Set(subtaskIds || []);
  var now = new Date().toISOString();
  var touched = false;
  getTasksArray(project).forEach(function(t){
    if(t.id === taskId) return;
    var shouldBeChild = desired.has(t.id);
    var isChild = t.parentTaskId === taskId;
    if(shouldBeChild && !isChild){
      pushTaskAuditEntry(project, t, 'parentTaskId', t.parentTaskId, taskId);
      t.parentTaskId = taskId;
      t.dateLastModified = now;
      touched = true;
    } else if(!shouldBeChild && isChild){
      pushTaskAuditEntry(project, t, 'parentTaskId', t.parentTaskId, null);
      t.parentTaskId = null;
      t.dateLastModified = now;
      touched = true;
    }
  });
  if(touched) saveDB();
}

export function reactivateTasks(project, taskIds){
  var count = 0;
  taskIds.forEach(function(taskId){
    var t = project.tasks[taskId];
    if(!t || !t.archived) return;
    t.archived = false;
    t.dateLastModified = new Date().toISOString();
    count++;
  });
  if(count > 0) saveDB();
  return count;
}

export function moveTaskToColumn(project, taskId, targetColumnId, index){
  var t = project.tasks[taskId];
  if(!t) return;
  var oldColumnId = t.columnId;
  var wasDone = !!(getColumn(project, oldColumnId) || {}).done;
  project.columns.forEach(function(c){ c.order = c.order.filter(function(id){ return id !== taskId; }); });
  var target = getColumn(project, targetColumnId);
  if(!target) return;
  if(index === -1 || index == null || index > target.order.length){
    target.order.push(taskId);
  } else {
    target.order.splice(index, 0, taskId);
  }
  t.columnId = target.id;
  if(oldColumnId !== target.id) pushTaskAuditEntry(project, t, 'columnId', oldColumnId, target.id);
  var now = new Date().toISOString();
  /* dateDone marks the most recent time this task actually became
     Done — set the instant it transitions in, cleared if it's ever
     reopened, so a stale completion date from a previous pass through
     Done never lingers on a task that's active again. Moving between
     two different Done columns doesn't touch it either way. */
  if(target.done && !wasDone) t.dateDone = now;
  else if(!target.done && wasDone) t.dateDone = null;
  t.dateLastModified = now;
}

/* =========================================================
   5x5 RISK MATRIX
   Likelihood (rows, 1=Rare to 5=Almost Certain, bottom to top) x
   Impact (columns, 1=Insignificant to 5=Severe, left to right).
   Band assignment is a direct lookup table rather than a pure
   likelihood*impact formula, matching how real-world 5x5 matrices are
   typically defined (the same numeric product can land in a different
   band depending on whether likelihood or impact drove it).
   ========================================================= */
export var RISK_MATRIX_BAND_TABLE = {
  1: {1: 'verylow', 2: 'verylow', 3: 'low',     4: 'medium',   5: 'medium'},
  2: {1: 'verylow', 2: 'low',     3: 'medium',  4: 'medium',   5: 'high'},
  3: {1: 'low',     2: 'medium',  3: 'medium',  4: 'high',     5: 'veryhigh'},
  4: {1: 'medium',  2: 'medium',  3: 'high',    4: 'veryhigh', 5: 'extreme'},
  5: {1: 'medium',  2: 'high',    3: 'veryhigh', 4: 'extreme', 5: 'extreme'}
};
export var RISK_MATRIX_BAND_COLORS = {
  verylow: '#4caf50', low: '#8bc34a', medium: '#fdd835',
  high: '#fb8c00', veryhigh: '#f4511e', extreme: '#c62828'
};
export var RISK_MATRIX_BAND_LABELS = {
  verylow: 'Very low', low: 'Low', medium: 'Medium',
  high: 'High', veryhigh: 'Very high', extreme: 'Extreme'
};
export var RISK_MATRIX_IMPACT_COL_LABELS = {1: 'Insignificant', 2: 'Minor', 3: 'Significant', 4: 'Major', 5: 'Severe'};
export var RISK_MATRIX_LIKELIHOOD_ROW_LABELS = {1: 'Rare', 2: 'Unlikely', 3: 'Moderate', 4: 'Likely', 5: 'Almost Certain'};
export function getRiskMatrixCellBand(likelihood, impact){
  var l = clampRiskScoreValue(likelihood), i = clampRiskScoreValue(impact);
  return (RISK_MATRIX_BAND_TABLE[l] && RISK_MATRIX_BAND_TABLE[l][i]) || 'medium';
}
export function getRiskMatrixCellColor(likelihood, impact){
  return RISK_MATRIX_BAND_COLORS[getRiskMatrixCellBand(likelihood, impact)];
}

/* Risks sharing the same (likelihood, impact) cell are arranged in a
   small grid within that cell so they stay individually visible
   rather than rendering as a single overlapping marker. */
export var RISK_MATRIX_CELL_ASPECT = 1.7778;

export function computeRiskMatrixPoints(risks, marginLeft, marginTop, cellWidth, cellHeight){
  var cellGroups = {};
  risks.forEach(function(r){
    var l = clampRiskScoreValue(r.likelihood), i = clampRiskScoreValue(r.impact);
    var key = l + '-' + i;
    if(!cellGroups[key]) cellGroups[key] = [];
    cellGroups[key].push(r);
  });
  var points = [];
  Object.keys(cellGroups).forEach(function(key){
    var group = cellGroups[key];
    var parts = key.split('-');
    var l = parseInt(parts[0], 10), i = parseInt(parts[1], 10);
    var baseX = marginLeft + (i - 1) * cellWidth + cellWidth / 2;
    var baseY = marginTop + (5 - l) * cellHeight + cellHeight / 2;
    var perRow = Math.ceil(Math.sqrt(group.length));
    var totalRows = Math.ceil(group.length / perRow);
    var spacingX = Math.min(28, (cellWidth * 0.6) / Math.max(perRow, 1));
    var spacingY = Math.min(20, (cellHeight * 0.6) / Math.max(perRow, 1));
    group.forEach(function(r, idx){
      var row = Math.floor(idx / perRow);
      var col = idx % perRow;
      var offsetX = (col - (perRow - 1) / 2) * spacingX;
      var offsetY = (row - (totalRows - 1) / 2) * spacingY;
      points.push({risk: r, x: baseX + offsetX, y: baseY + offsetY});
    });
  });
  return points;
}

/* options.colorForRisk(risk) -> hex color string, optional — when provided, overrides the default
   solid marker fill (#1b2a4a) per-point. Used by the Portfolio Dashboard's risk matrix to color
   each risk by its source project (with its own legend, built by the caller — this function only
   ever draws the matrix itself, same as before). Omitted entirely, this is 100% unchanged from the
   single-project Health Dashboard / standalone Risks view's existing 2-arg calls. */
export function buildRiskMatrixSvg(risks, height, options){
  options = options || {};
  var colorForRisk = options.colorForRisk || function(){ return '#1b2a4a'; };
  height = height || 560;
  var marginLeft = 100, marginRight = 30, marginTop = 26, marginBottom = 70;
  var plotHeight = height - marginTop - marginBottom;
  var cellHeight = plotHeight / 5;
  var cellWidth = cellHeight * RISK_MATRIX_CELL_ASPECT;
  var plotWidth = cellWidth * 5;
  var width = marginLeft + marginRight + plotWidth;

  var cellsHTML = '';
  for(var l = 1; l <= 5; l++){
    for(var i = 1; i <= 5; i++){
      var x = marginLeft + (i - 1) * cellWidth;
      var y = marginTop + (5 - l) * cellHeight;
      var color = getRiskMatrixCellColor(l, i);
      var score = l * i;
      cellsHTML += '<rect x="' + x + '" y="' + y + '" width="' + cellWidth + '" height="' + cellHeight + '" fill="' + color + '" stroke="#fff" stroke-width="1.5" opacity="0.85"></rect>' +
        '<text x="' + (x + cellWidth - 6) + '" y="' + (y + cellHeight - 8) + '" font-size="11" font-weight="700" text-anchor="end" fill="rgba(0,0,0,0.55)">' + score + '</text>';
    }
  }

  var rowLabelsHTML = '';
  for(l = 1; l <= 5; l++){
    var ly = marginTop + (5 - l) * cellHeight + cellHeight / 2;
    rowLabelsHTML += '<text x="' + (marginLeft - 10) + '" y="' + (ly + 4) + '" font-size="11" font-weight="600" text-anchor="end" fill="var(--kf-text)">' + l + ' ' + RISK_MATRIX_LIKELIHOOD_ROW_LABELS[l] + '</text>';
  }
  var colLabelsHTML = '';
  for(i = 1; i <= 5; i++){
    var lx = marginLeft + (i - 1) * cellWidth + cellWidth / 2;
    colLabelsHTML += '<text x="' + lx + '" y="' + (marginTop + plotHeight + 18) + '" font-size="11" font-weight="600" text-anchor="middle" fill="var(--kf-text)">' + i + ' ' + RISK_MATRIX_IMPACT_COL_LABELS[i] + '</text>';
  }

  var axisTitlesHTML =
    '<text x="' + (marginLeft + plotWidth / 2) + '" y="' + (marginTop + plotHeight + 40) + '" font-size="13" font-weight="700" text-anchor="middle" fill="var(--kf-text-secondary)">Impact</text>' +
    '<text x="22" y="' + (marginTop + plotHeight / 2) + '" font-size="13" font-weight="700" text-anchor="middle" transform="rotate(-90, 22, ' + (marginTop + plotHeight / 2) + ')" fill="var(--kf-text-secondary)">Likelihood</text>';

  var points = computeRiskMatrixPoints(risks, marginLeft, marginTop, cellWidth, cellHeight);
  var pointsHTML = points.map(function(p){
    var r = p.risk;
    var isClosed = normalizeRiskStatus(r.status) === 'closed';
    var labelOffset = 10;
    return '<g class="kf-risk-matrix-point' + (isClosed ? ' kf-risk-matrix-point-faded' : '') + '">' +
      '<title>' + escapeHTML(r.key) + ' — ' + escapeHTML(r.title) + (isClosed ? ' [Closed]' : '') + '</title>' +
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="6" fill="' + colorForRisk(r) + '" stroke="#fff" stroke-width="1.5"></circle>' +
      '<text x="' + (p.x + labelOffset) + '" y="' + (p.y + 4) + '" font-size="10" font-weight="700" fill="var(--kf-text)" style="paint-order:stroke;stroke:var(--kf-surface);stroke-width:3px;">' + escapeHTML(r.key) + '</text>' +
    '</g>';
  }).join('');

  return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" class="kf-risk-matrix-svg">' +
    cellsHTML + rowLabelsHTML + colLabelsHTML + axisTitlesHTML + pointsHTML +
  '</svg>';
}
