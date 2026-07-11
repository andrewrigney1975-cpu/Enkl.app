"use strict";

import { clampProgress, clampEffortHours, utcISOToLocalDisplayDate } from './date-utils.js';

/* Pure project-scoped helpers — these take a `project` object as a
   parameter and never access the db state directly. */

export function getTasksArray(project){
  return Object.keys(project.tasks).map(function(k){ return project.tasks[k]; });
}

export function getColumn(project, columnId){
  for(var i=0;i<project.columns.length;i++){ if(project.columns[i].id === columnId) return project.columns[i]; }
  return null;
}

export function columnNameById(project, columnId){
  var c = getColumn(project, columnId);
  return c ? c.name : '(unknown column)';
}

/* Build a map: taskId -> [ids of tasks that depend on it] */
export function buildChildrenMap(project){
  var map = {};
  getTasksArray(project).forEach(function(t){
    (t.dependencies||[]).forEach(function(depId){
      if(!map[depId]) map[depId] = [];
      map[depId].push(t.id);
    });
  });
  return map;
}

/* All tasks that (transitively) depend on taskId -- i.e. descendants */
export function getDescendants(project, taskId){
  var childrenMap = buildChildrenMap(project);
  var visited = new Set();
  var stack = (childrenMap[taskId] || []).slice();
  while(stack.length){
    var id = stack.pop();
    if(visited.has(id)) continue;
    visited.add(id);
    (childrenMap[id]||[]).forEach(function(c){ stack.push(c); });
  }
  return visited;
}

/* Defensive cycle check across the whole graph after hypothetically
   setting task `taskId` dependencies to `newDeps` */
export function wouldCreateCycle(project, taskId, newDeps){
  var depsOverride = {};
  depsOverride[taskId] = newDeps;
  function depsOf(id){
    return depsOverride.hasOwnProperty(id) ? depsOverride[id] : (project.tasks[id] ? project.tasks[id].dependencies||[] : []);
  }
  var visiting = new Set();
  var visited = new Set();
  function dfs(id){
    if(visiting.has(id)) return true;
    if(visited.has(id)) return false;
    visiting.add(id);
    var deps = depsOf(id);
    for(var i=0;i<deps.length;i++){
      if(dfs(deps[i])) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return dfs(taskId);
}

/* =========================================================
   SUB-TASKS
   A separate, single-parent hierarchy from `dependencies` (which is a
   general multi-parent DAG expressing "must finish first"). Each task
   has at most one parentTaskId; "sub-tasks" are simply every task
   whose parentTaskId points back to it — there's no separate stored
   list of children, so the two views (a task's own Parent Task, and
   its Sub-Tasks picker) can never drift out of sync with each other.
   ========================================================= */
export function getSubtasksOf(project, taskId){
  return getTasksArray(project).filter(function(t){ return t.parentTaskId === taskId; });
}

/* All tasks transitively parented under taskId (its full sub-tree) */
export function getSubtaskDescendantIds(project, taskId){
  var visited = new Set();
  var stack = getSubtasksOf(project, taskId).map(function(t){ return t.id; });
  while(stack.length){
    var id = stack.pop();
    if(visited.has(id)) continue;
    visited.add(id);
    getSubtasksOf(project, id).forEach(function(t){ stack.push(t.id); });
  }
  return visited;
}

/* Every id from startParentId up to the root of the parent chain
   (inclusive of startParentId itself). Guards against a corrupted/
   cyclic chain hanging the walk. */
export function getTaskAncestorIds(project, startParentId){
  var ids = new Set();
  var cur = startParentId;
  var guard = 0;
  while(cur && !ids.has(cur) && guard < 10000){
    ids.add(cur);
    var t = project.tasks[cur];
    cur = t ? t.parentTaskId : null;
    guard++;
  }
  return ids;
}

/* Would setting task `taskId`'s parent to `newParentId` create a
   cycle? True if they're the same task, or if newParentId is already
   (transitively) parented under taskId. */
export function wouldCreateParentCycle(project, taskId, newParentId){
  if(!newParentId) return false;
  if(newParentId === taskId) return true;
  return getSubtaskDescendantIds(project, taskId).has(newParentId);
}

export function isTaskBlocked(project, task){
  if(!task.dependencies || task.dependencies.length === 0) return false;
  return task.dependencies.some(function(depId){
    var dep = project.tasks[depId];
    if(!dep) return false;
    var col = getColumn(project, dep.columnId);
    return !(col && col.done);
  });
}

/* A task is overdue if it has an end date in the past and hasn't
   already been completed — once a task's own column is marked "done",
   a past end date is no longer something actionable to warn about. */
export function isTaskOverdue(project, task){
  if(!task.endDate) return false;
  var end = new Date(task.endDate);
  if(isNaN(end.getTime())) return false;
  if(end.getTime() >= Date.now()) return false;
  var col = getColumn(project, task.columnId);
  return !(col && col.done);
}

/* Per-task overrun prediction — a distinct concept from the project-
   level burndown projection in features/health.js. Compares progress
   against actual effort logged (is it on pace to blow the estimate?)
   and against elapsed schedule (is it on pace to miss the end date?).
   Callers must check isTimeTrackingEnabled(project) themselves before
   calling this — it isn't checked in here to avoid a circular import
   (storage.js, home of that flag, already imports from this module).

   Returns:
     null                                            — no concern
     {level: 'over',   reasons: [{type, message}]}    — already over
     {level: 'atRisk', reasons: [{type, message}]}    — predicted to run over

   A task already 'over' never also reports 'atRisk' reasons — once
   it's actually blown the budget/date, the prediction is moot. */
export function getTaskOverrunStatus(project, task){
  if(task.archived) return null;
  var col = getColumn(project, task.columnId);
  if(col && col.done) return null;

  var progress = clampProgress(task.progress);
  var overReasons = [];
  var atRiskReasons = [];

  var estimatedEffort = clampEffortHours(task.estimatedEffort);
  var actualEffort = clampEffortHours(task.actualEffort);
  if(estimatedEffort > 0){
    if(actualEffort > estimatedEffort){
      overReasons.push({type: 'effort', message: 'Logged ' + actualEffort + 'h vs ' + estimatedEffort + 'h estimated'});
    } else if(progress > 0 && progress < 100){
      var projectedEffort = actualEffort * (100 / progress);
      if(projectedEffort > estimatedEffort){
        atRiskReasons.push({type: 'effort', message: 'Projected ' + Math.round(projectedEffort * 10) / 10 + 'h vs ' + estimatedEffort + 'h estimated'});
      }
    }
  }

  var start = task.startDate ? new Date(task.startDate) : null;
  var end = task.endDate ? new Date(task.endDate) : null;
  var validRange = start && end && !isNaN(start.getTime()) && !isNaN(end.getTime()) && end.getTime() > start.getTime();
  if(validRange){
    if(isTaskOverdue(project, task)){
      overReasons.push({type: 'date', message: 'Overdue since ' + utcISOToLocalDisplayDate(task.endDate)});
    } else if(progress > 0 && progress < 100){
      var now = Date.now();
      if(now > start.getTime()){
        var elapsed = now - start.getTime();
        var projectedFinish = start.getTime() + elapsed * (100 / progress);
        if(projectedFinish > end.getTime()){
          atRiskReasons.push({type: 'date', message: 'On pace to finish ' + utcISOToLocalDisplayDate(new Date(projectedFinish).toISOString()) + ', due ' + utcISOToLocalDisplayDate(task.endDate)});
        }
      }
    }
  }

  if(overReasons.length > 0) return {level: 'over', reasons: overReasons};
  if(atRiskReasons.length > 0) return {level: 'atRisk', reasons: atRiskReasons};
  return null;
}

export function getMemberById(project, memberId){
  if(!memberId || !project || !project.members) return null;
  for(var i=0;i<project.members.length;i++){
    if(project.members[i].id === memberId) return project.members[i];
  }
  return null;
}

export function getMemberByName(project, name){
  if(!name || !project || !project.members) return null;
  var lower = name.toLowerCase();
  for(var i=0;i<project.members.length;i++){
    if(project.members[i].name.toLowerCase() === lower) return project.members[i];
  }
  return null;
}

export function getMemberColor(project, memberId){
  var m = getMemberById(project, memberId);
  return m ? m.color : '#8993a4';
}

export function getReleaseById(project, releaseId){
  if(!project || !releaseId) return null;
  return (project.releases || []).filter(function(r){ return r.id === releaseId; })[0] || null;
}

export function getTaskById(project, taskId){
  if(!project || !taskId) return null;
  return project.tasks[taskId] || null;
}

export function getTaskTypeById(project, typeId){
  if(!project || !typeId) return null;
  return (project.taskTypes || []).filter(function(tt){ return tt.id === typeId; })[0] || null;
}

export function getTeamCommitteeById(project, id){
  if(!project || !id) return null;
  return (project.teamsCommittees || []).filter(function(tc){ return tc.id === id; })[0] || null;
}

export function getDocumentById(project, docId){
  if(!project || !docId) return null;
  return (project.documents || []).filter(function(d){ return d.id === docId; })[0] || null;
}

export function getRiskById(project, riskId){
  if(!project || !riskId) return null;
  return (project.risks || []).filter(function(r){ return r.id === riskId; })[0] || null;
}

export function getDecisionById(project, decisionId){
  if(!project || !decisionId) return null;
  return (project.decisions || []).filter(function(d){ return d.id === decisionId; })[0] || null;
}

export function getPrincipleById(project, principleId){
  if(!project || !principleId) return null;
  return (project.principles || []).filter(function(p){ return p.id === principleId; })[0] || null;
}

export function getObjectiveById(project, objectiveId){
  if(!project || !objectiveId) return null;
  return (project.objectives || []).filter(function(o){ return o.id === objectiveId; })[0] || null;
}

export function getRetrospectiveById(project, retrospectiveId){
  if(!project || !retrospectiveId) return null;
  return (project.retrospectives || []).filter(function(r){ return r.id === retrospectiveId; })[0] || null;
}

export function getRetrospectiveItemById(retrospective, itemId){
  if(!retrospective || !itemId) return null;
  return (retrospective.items || []).filter(function(it){ return it.id === itemId; })[0] || null;
}

export function getRetrospectiveActionItemById(retrospective, itemId){
  if(!retrospective || !itemId) return null;
  return (retrospective.actionItems || []).filter(function(ai){ return ai.id === itemId; })[0] || null;
}

export function assigneeDisplayName(project, assigneeId){
  var m = getMemberById(project, assigneeId);
  return m ? m.name : 'Unassigned';
}

/* Library of selectable icons for Task Types */
export var TASK_TYPE_ICON_LIBRARY = [
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

export function isValidTaskTypeIconName(name){
  return TASK_TYPE_ICON_LIBRARY.some(function(i){ return i.name === name; });
}

export function isValidRiskScoreValue(v){
  return typeof v === 'number' && isFinite(v) && v >= 1 && v <= 5;
}

export function sortRisks(risks){
  return (risks || []).slice().sort(function(a, b){
    var scoreA = (a.likelihood || 1) * (a.impact || 1);
    var scoreB = (b.likelihood || 1) * (b.impact || 1);
    if(scoreB !== scoreA) return scoreB - scoreA;
    return (a.title || '').localeCompare(b.title || '');
  });
}

/* A task is "unscored" if both businessValue and taskCost are at the
   default minimum (1). Used by health computeTasksHealth. */
export function isTaskUnscored(task){
  return task.businessValue <= 1 && task.taskCost <= 1;
}
