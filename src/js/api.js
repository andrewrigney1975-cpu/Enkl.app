"use strict";

/* Thin fetch wrapper for the .NET API, reverse-proxied at /api/* by nginx (see docker-compose.yml).
   This is the first slice of the frontend rewire described in the migration plan — column CRUD is
   wired through here as the representative flow; most mutations still go through the local
   mutations.js/storage.js path until a project has been migrated to the server (see project.serverProjectId). */

var TOKEN_STORAGE_KEY = 'kanbanflow_server_jwt';

/* One random id per browser tab (not per user — the same user can have several tabs open), sent on
   every request as X-Client-Session-Id and echoed back into the SSE stream's own connection (see
   features/live-updates.js). The server uses it to skip notifying the exact tab that made a change —
   that tab already knows, having just done it — while still notifying every OTHER tab/browser, which
   is the actual point of the feature (see EventsController/SseBroadcaster on the API side).
   crypto.randomUUID() needs a secure context (HTTPS or localhost); this app is often reached over
   plain HTTP on a LAN dev box, so it falls back to a Math.random-based id there instead of throwing. */
var CLIENT_SESSION_ID = (function(){
  try {
    if(window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch(e){ /* fall through to fallback below */ }
  return 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
})();
export function getClientSessionId(){ return CLIENT_SESSION_ID; }

export function getToken(){
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch(e){ return null; }
}
export function setToken(token){
  try { localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch(e){ /* storage unavailable */ }
}
export function clearToken(){
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch(e){ /* storage unavailable */ }
}
export function isLoggedIn(){
  return !!getToken();
}

/* JWTs aren't encrypted, just signed — the payload is plain base64url JSON, safe to read client-side
   without validating the signature (the server re-validates on every request regardless; this is only
   ever used to decide what to SHOW, e.g. hiding the "Manage Users" link from non-admins, never to
   decide what to ALLOW). Returns null for a missing/malformed token rather than throwing, since a
   stale or corrupted token should just make the UI treat this browser as not-admin. */
function decodeTokenPayload(token){
  try {
    var base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var json = decodeURIComponent(atob(base64).split('').map(function(c){
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(json);
  } catch(e){
    return null;
  }
}

export function isOrgAdmin(){
  var token = getToken();
  if(!token) return false;
  var payload = decodeTokenPayload(token);
  return !!(payload && payload.orgAdmin === 'true');
}

export class ApiError extends Error {
  constructor(status, body){
    super((body && body.message) || ('Request failed with status ' + status));
    this.status = status;
    this.body = body;
  }
}

var _onAuthExpired = function(){};
export function setOnAuthExpired(fn){ _onAuthExpired = fn; }
/* Exported so a caller with its own reason to know the session is dead — currently just
   features/live-updates.js, whose long-lived SSE stream can be the first thing to notice an expired
   token during an otherwise idle session — can trigger the same "please log in again" handling
   apiFetch's own 401 detection below does, without duplicating that handling. */
export function notifyAuthExpired(){ _onAuthExpired(); }

async function apiFetch(path, options){
  var token = getToken();
  var headers = Object.assign(
    {'Content-Type': 'application/json', 'X-Client-Session-Id': CLIENT_SESSION_ID},
    token ? {'Authorization': 'Bearer ' + token} : {},
    (options && options.headers) || {}
  );
  var res = await fetch('/api' + path, Object.assign({}, options, {headers: headers}));
  if(res.status === 401 && token){
    // Only an *authenticated* request coming back 401 means the session itself expired/was
    // revoked. A 401 with no token attached (e.g. the login call on bad credentials) is a
    // plain auth failure, not a session expiry — let it fall through to the generic handler
    // below so the caller sees the API's actual message ("Invalid username or password.").
    clearToken();
    notifyAuthExpired();
    throw new ApiError(401, {message: 'Session expired. Please log in again.'});
  }
  if(!res.ok){
    var body = null;
    try { body = await res.json(); } catch(e){ /* no JSON body */ }
    throw new ApiError(res.status, body);
  }
  return res.status === 204 ? null : res.json();
}

export function loginApi(username, password){
  return apiFetch('/auth/login', {method: 'POST', body: JSON.stringify({username: username, password: password})});
}

export function changePasswordApi(currentPassword, newPassword){
  return apiFetch('/auth/change-password', {method: 'POST', body: JSON.stringify({currentPassword: currentPassword, newPassword: newPassword})});
}

export function getMyOrganisationApi(){
  return apiFetch('/organisations/me', {method: 'GET'});
}
export function createOrgUserApi(username, displayName, password){
  return apiFetch('/organisations/me/users', {method: 'POST', body: JSON.stringify({username: username, displayName: displayName, password: password})});
}
export function setOrgUserAdminApi(userId, isOrgAdmin){
  return apiFetch('/organisations/me/users/' + userId + '/admin', {method: 'PUT', body: JSON.stringify({isOrgAdmin: isOrgAdmin})});
}

export function getProjectsApi(){
  return apiFetch('/projects', {method: 'GET'});
}

export function getProjectDetailApi(projectId){
  return apiFetch('/projects/' + projectId, {method: 'GET'});
}

export function createProjectApi(body){
  return apiFetch('/projects', {method: 'POST', body: JSON.stringify(body)});
}
export function updateProjectApi(projectId, body){
  return apiFetch('/projects/' + projectId, {method: 'PUT', body: JSON.stringify(body)});
}
export function deleteProjectApi(projectId){
  return apiFetch('/projects/' + projectId, {method: 'DELETE'});
}

export function addColumnApi(projectId, name, done, color){
  return apiFetch('/projects/' + projectId + '/columns', {method: 'POST', body: JSON.stringify({name: name, done: done, color: color})});
}
export function updateColumnApi(projectId, columnId, name, done, color, order){
  return apiFetch('/projects/' + projectId + '/columns/' + columnId, {method: 'PUT', body: JSON.stringify({name: name, done: done, color: color, order: order})});
}
export function deleteColumnApi(projectId, columnId){
  return apiFetch('/projects/' + projectId + '/columns/' + columnId, {method: 'DELETE'});
}

export function migrateProjectApi(exportDoc){
  return apiFetch('/migration/projects', {method: 'POST', body: JSON.stringify(exportDoc)});
}

export function updateProjectSettingsApi(projectId, headerButtonVisibility){
  return apiFetch('/projects/' + projectId + '/settings', {method: 'PUT', body: JSON.stringify(headerButtonVisibility)});
}

export function updateProjectWorkflowApi(projectId, workflow){
  return apiFetch('/projects/' + projectId + '/workflow', {method: 'PUT', body: JSON.stringify(workflow)});
}

/* Every other entity's CRUD follows the exact same REST shape as columns above
   (POST/PUT/DELETE /projects/{projectId}/{resource}[/{id}]), so it's generated once here instead
   of repeating the same three functions nine more times. */
function makeEntityApi(resource){
  return {
    create: function(projectId, body){
      return apiFetch('/projects/' + projectId + '/' + resource, {method: 'POST', body: JSON.stringify(body)});
    },
    update: function(projectId, id, body){
      return apiFetch('/projects/' + projectId + '/' + resource + '/' + id, {method: 'PUT', body: JSON.stringify(body)});
    },
    remove: function(projectId, id){
      return apiFetch('/projects/' + projectId + '/' + resource + '/' + id, {method: 'DELETE'});
    }
  };
}

export var taskApi = makeEntityApi('tasks');
export var releaseApi = makeEntityApi('releases');
export var taskTypeApi = makeEntityApi('task-types');
export var principleApi = makeEntityApi('principles');
export var documentApi = makeEntityApi('documents');
export var riskApi = makeEntityApi('risks');
export var objectiveApi = makeEntityApi('objectives');
export var teamCommitteeApi = makeEntityApi('teams-committees');
export var decisionApi = makeEntityApi('decisions');
export var memberApi = makeEntityApi('members');
