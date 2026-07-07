"use strict";
import { state } from '../storage.js';
import { getTasksArray } from '../utils.js';

/* Hashbang deep links look like "#!/DEMO-1" — the classic SPA-routing
   pattern of prefixing the fragment with "!" so it reads as a real
   route rather than an in-page anchor. */
var TASK_HASH_PREFIX = '#!/';

export function parseTaskKeyFromHash(){
  var hash = window.location.hash || '';
  if(hash.indexOf(TASK_HASH_PREFIX) !== 0) return null;
  var key = decodeURIComponent(hash.slice(TASK_HASH_PREFIX.length)).trim();
  return key || null;
}

/* Task keys are only guaranteed unique within their own project — two
   projects can legally share a key (no uniqueness check exists on
   project.key) — so every project has to be searched. The current
   project is checked first so an ambiguous key never yanks the user
   into a different project than the one they're already looking at. */
export function findTaskByKey(key){
  if(!state.db) return null;
  var wanted = key.toUpperCase();
  var currentProject = state.db.projects[state.db.currentProjectId];
  var hit = currentProject ? findTaskByKeyInProject(currentProject, wanted) : null;
  if(hit) return {project: currentProject, task: hit};

  for(var i=0; i<state.db.projectOrder.length; i++){
    var project = state.db.projects[state.db.projectOrder[i]];
    if(!project || project === currentProject) continue;
    var match = findTaskByKeyInProject(project, wanted);
    if(match) return {project: project, task: match};
  }
  return null;
}

function findTaskByKeyInProject(project, upperCaseKey){
  var tasks = getTasksArray(project);
  for(var i=0; i<tasks.length; i++){
    if(tasks[i].key.toUpperCase() === upperCaseKey) return tasks[i];
  }
  return null;
}

/* Uses replaceState (not location.hash =) so opening/closing tasks
   doesn't spam browser history with one entry per click, and so it
   never fires our own 'hashchange' listener back at us. */
export function setTaskHash(key){
  var target = TASK_HASH_PREFIX + encodeURIComponent(key);
  if(window.location.hash === target) return;
  history.replaceState(null, '', target);
}

export function clearTaskHash(){
  if(!window.location.hash) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
