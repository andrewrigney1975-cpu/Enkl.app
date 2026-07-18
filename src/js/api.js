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

/* Whether the caller is a Project Administrator on the given server project id (JwtTokenService.cs's
   "projects" claim, decoded client-side without signature verification — same "only ever used to
   decide what to SHOW, never what to ALLOW" trust model as isOrgAdmin() above; the server always
   re-checks a live ProjectMembers row via ProjectAdminAuthorizationHandler/ProjectAdminMiddleware,
   which independently re-verifies org membership for the Org-Admin case too — never trust this
   client-side check for anything but "what to show"). An Org Admin always gets Project Admin
   affordances on top of their org-only ones, so this returns true for any Org Admin outright without
   even looking at the "projects" claim — every server-authoritative project a signed-in Org Admin
   can reach in this UI already belongs to their own org.
   Returns false for a missing token, a missing/malformed "projects" claim, or a local-only project
   with no serverProjectId at all — callers gate local-only projects on isServerAuthoritative()
   instead, same as every other permission gate in this app (e.g. applyHeaderButtonVisibility's
   teamsCommittees check). */
export function isProjectAdmin(serverProjectId){
  var token = getToken();
  if(!token || !serverProjectId) return false;
  if(isOrgAdmin()) return true;
  var payload = decodeTokenPayload(token);
  if(!payload || !payload.projects) return false;
  try {
    var memberships = JSON.parse(payload.projects);
    var entry = memberships.find(function(m){ return m.ProjectId === serverProjectId; });
    return !!(entry && entry.IsProjectAdmin);
  } catch(e){
    return false;
  }
}

/* The logged-in user's Organisation display name (see JwtTokenService.cs's orgName claim), used to
   append " - <org name>" to the header logo once logged in. Null when logged out or the token predates
   this claim (an old token still cached in localStorage from before this was added). */
export function getOrgName(){
  var token = getToken();
  if(!token) return null;
  var payload = decodeTokenPayload(token);
  return (payload && payload.orgName) || null;
}

/* Whether the API tier behind /health is currently reachable — used to hide "Migrate to Server" (see
   views/board.js's renderToolbar) when there's no backend to migrate to, whichever tier (.NET or PHP,
   both expose the identical GET /health at their own root — see web/nginx.conf) happens to be
   deployed. Starts true (optimistic) so the menu item isn't hidden for the brief moment before the
   first probe completes. */
var _apiReachable = true;
var _lastApiProbeAt = 0;
var API_PROBE_INTERVAL_MS = 30000;

export function isApiReachable(){
  return _apiReachable;
}

/* Throttled, fire-and-forget: callers (renderToolbar can run very frequently, e.g. after every task
   edit) read the possibly-stale-by-up-to-API_PROBE_INTERVAL_MS cached value via isApiReachable()
   synchronously; this only actually re-probes /health at most once per interval, and invokes
   onChange() to let the caller re-render once a probe resolves with a different result than before. */
export function pollApiReachability(onChange){
  var now = Date.now();
  if(now - _lastApiProbeAt < API_PROBE_INTERVAL_MS) return;
  _lastApiProbeAt = now;

  var controller = new AbortController();
  var timeoutId = setTimeout(function(){ controller.abort(); }, 4000);
  try {
    fetch('/health', {cache: 'no-store', signal: controller.signal}).then(function(res){
      clearTimeout(timeoutId);
      applyReachability(res.ok);
    }, function(){
      clearTimeout(timeoutId);
      applyReachability(false);
    });
  } catch(e){
    // fetch() itself can throw synchronously in environments where it isn't defined at all
    // (rather than rejecting) — treat that the same as an unreachable API, not a render-breaking crash.
    clearTimeout(timeoutId);
    applyReachability(false);
  }

  function applyReachability(reachable){
    var changed = reachable !== _apiReachable;
    _apiReachable = reachable;
    if(changed && onChange) onChange();
  }
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

/* Fired when the server rejects a mutating request with the must_change_password code (see
   Program.cs's MustChangePassword-enforcement middleware) — lets app.js pop the Change Password
   modal right when an edit actually gets blocked, instead of just leaving the caller's generic
   error toast to explain a 403 the user has no other way to understand. */
var _onMustChangePassword = function(){};
export function setOnMustChangePassword(fn){ _onMustChangePassword = fn; }
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
    if(res.status === 403 && body && body.code === 'must_change_password') _onMustChangePassword();
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

/* Called as the login form's identifier field is filled in — see modals/login.js (or wherever the
   "Continue with SSO" affordance lives). Deliberately unauthenticated; the server only ever answers
   with whether SSO is available and which org, never anything about whether the identifier itself
   matched a real account (see AuthController.SsoLookup's own comment). */
export function ssoLookupApi(identifier){
  return apiFetch('/auth/sso-lookup?identifier=' + encodeURIComponent(identifier), {method: 'GET'});
}
/* Trades the single-use ?ssoCode= the SAML ACS redirect left in the URL for the real login
   response — see SsoExchangeCodeStore.cs for why the token never rides in that URL directly. */
export function ssoExchangeApi(code){
  return apiFetch('/auth/sso-exchange', {method: 'POST', body: JSON.stringify({code: code})});
}

/* Anonymous, unauthenticated real-user-monitoring beacon — see features/page-load-telemetry.js for
   what durationMs measures and why. Works identically whether or not this browser happens to have a
   token attached (TelemetryController never looks at it either way). */
export function reportPageLoadTimingApi(durationMs){
  return apiFetch('/telemetry/page-load', {method: 'POST', body: JSON.stringify({durationMs: durationMs})});
}

export function getMyOrganisationApi(){
  return apiFetch('/organisations/me', {method: 'GET'});
}
export function createOrgUserApi(username, displayName, password, emailAddress){
  return apiFetch('/organisations/me/users', {method: 'POST', body: JSON.stringify({username: username, displayName: displayName, password: password, emailAddress: emailAddress})});
}
export function setOrgUserAdminApi(userId, isOrgAdmin){
  return apiFetch('/organisations/me/users/' + userId + '/admin', {method: 'PUT', body: JSON.stringify({isOrgAdmin: isOrgAdmin})});
}
export function setOrgUserEmailApi(userId, emailAddress){
  return apiFetch('/organisations/me/users/' + userId + '/email', {method: 'PUT', body: JSON.stringify({emailAddress: emailAddress})});
}

export function getSsoConfigApi(){
  return apiFetch('/organisations/me/sso-config', {method: 'GET'});
}
export function updateSsoConfigApi(body){
  return apiFetch('/organisations/me/sso-config', {method: 'PUT', body: JSON.stringify(body)});
}
export function generateScimTokenApi(){
  return apiFetch('/organisations/me/sso-config/scim-token', {method: 'POST'});
}

export function getApiKeyApi(){
  return apiFetch('/organisations/me/api-key', {method: 'GET'});
}
export function generateApiKeyApi(){
  return apiFetch('/organisations/me/api-key', {method: 'POST'});
}
export function revokeApiKeyApi(){
  return apiFetch('/organisations/me/api-key', {method: 'DELETE'});
}

/* Read-only — SCIM/the IdP owns Org Team membership (see OrgTeam's own server-side doc comment).
   The only mutating action available here is applyOrgTeamToProjectApi below. */
export function getOrgTeamsApi(){
  return apiFetch('/organisations/me/org-teams', {method: 'GET'});
}
export function applyOrgTeamToProjectApi(projectId, orgTeamId){
  return apiFetch('/projects/' + projectId + '/teams-committees/from-org-team/' + orgTeamId, {method: 'POST'});
}

/* Project Templates are Organisation-owned, not per-project, so these don't fit makeEntityApi's
   /projects/{projectId}/{resource} shape below — bespoke functions, same as the organisations/me
   block above. Create/read need only a session (any signed-in org member); rename/delete are
   OrgAdmin-only server-side (see routes.php / TemplatesController.cs) — a non-admin calling them just
   gets a 403, surfaced via the usual ApiError. */
export function getTemplatesApi(){
  return apiFetch('/organisations/me/templates', {method: 'GET'});
}
export function getTemplateDetailApi(id){
  return apiFetch('/organisations/me/templates/' + id, {method: 'GET'});
}
export function createTemplateApi(body){
  return apiFetch('/organisations/me/templates', {method: 'POST', body: JSON.stringify(body)});
}
export function renameTemplateApi(id, name){
  return apiFetch('/organisations/me/templates/' + id, {method: 'PUT', body: JSON.stringify({name: name})});
}
export function deleteTemplateApi(id){
  return apiFetch('/organisations/me/templates/' + id, {method: 'DELETE'});
}

/* To-Do Lists are per-User, not per-project/per-org, so — like the two blocks above — these are
   bespoke functions rather than makeEntityApi. Every route just needs a valid session (same gating
   as /auth/change-password); the server derives "which user" entirely from the caller's own token. */
export function getTodoListsApi(){
  return apiFetch('/todo-lists', {method: 'GET'});
}
export function createTodoListApi(title){
  return apiFetch('/todo-lists', {method: 'POST', body: JSON.stringify({title: title})});
}
export function renameTodoListApi(id, title){
  return apiFetch('/todo-lists/' + id, {method: 'PUT', body: JSON.stringify({title: title})});
}
export function deleteTodoListApi(id){
  return apiFetch('/todo-lists/' + id, {method: 'DELETE'});
}
export function createTodoItemApi(listId, note, dueDate){
  return apiFetch('/todo-lists/' + listId + '/items', {method: 'POST', body: JSON.stringify({note: note, dueDate: dueDate})});
}
export function updateTodoItemApi(listId, itemId, note, completed, dueDate){
  return apiFetch('/todo-lists/' + listId + '/items/' + itemId, {method: 'PUT', body: JSON.stringify({note: note, completed: completed, dueDate: dueDate})});
}
export function deleteTodoItemApi(listId, itemId){
  return apiFetch('/todo-lists/' + listId + '/items/' + itemId, {method: 'DELETE'});
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
export function updateColumnApi(projectId, columnId, name, done, color, order, cap){
  return apiFetch('/projects/' + projectId + '/columns/' + columnId, {method: 'PUT', body: JSON.stringify({name: name, done: done, color: color, order: order, cap: cap})});
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
export var savedQueryApi = makeEntityApi('saved-queries');
// "Test API (GET)" button (modals/project-search.js) — runs the saved query through the same
// server-side PublicQueryExecutionService the real public endpoint uses, authenticated by the
// caller's own project-member session rather than an org API key (see SAVED-QUERY-API.md for why:
// the raw key isn't retrievable after generation, so there's no key for the frontend to send here).
export function testSavedQueryApi(projectId, queryId){
  return apiFetch('/projects/' + projectId + '/saved-queries/' + queryId + '/test', {method: 'GET'});
}
export var objectiveApi = makeEntityApi('objectives');
export var teamCommitteeApi = makeEntityApi('teams-committees');
export var decisionApi = makeEntityApi('decisions');
export var memberApi = makeEntityApi('members');

/* PUT /api/projects/{projectId}/members/{memberId}/admin, see MembersController.SetProjectAdmin —
   Project-Admin-gated server-side, same as every other memberApi method; "the project admin role can
   be assigned to users via the Team management tool" (modals/team.js). */
memberApi.setProjectAdmin = function(projectId, memberId, isProjectAdmin){
  return apiFetch('/projects/' + projectId + '/members/' + memberId + '/admin', {method: 'PUT', body: JSON.stringify({isProjectAdmin: isProjectAdmin})});
};

/* Project-scoped (not organisation-scoped, despite living next to the "Organisation Library" feature)
   — PUT /api/projects/{projectId}/principles/{id}/share, see PrinciplesController.Share. Bolted onto
   principleApi (rather than organisationPrincipleApi below) since every other method here already
   takes the same (projectId, principleId, body) shape makeEntityApi's own update() does. */
principleApi.share = function(projectId, principleId, body){
  return apiFetch('/projects/' + projectId + '/principles/' + principleId + '/share', {method: 'PUT', body: JSON.stringify(body)});
};

/* Retrospectives need more than makeEntityApi's create/update/remove trio (nested items, nested
   action items, and the item-promotion endpoint), so it's hand-written here rather than generated —
   same underlying apiFetch helper makeEntityApi itself is built on, just with the extra nested routes
   spelled out. See api/Enkl.Api/Controllers/RetrospectivesController.cs for the definitive route list. */
export var retrospectiveApi = {
  create: function(projectId, body){
    return apiFetch('/projects/' + projectId + '/retrospectives', {method: 'POST', body: JSON.stringify(body)});
  },
  update: function(projectId, id, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id, {method: 'PUT', body: JSON.stringify(body)});
  },
  remove: function(projectId, id){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id, {method: 'DELETE'});
  },
  createItem: function(projectId, id, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/items', {method: 'POST', body: JSON.stringify(body)});
  },
  updateItem: function(projectId, id, itemId, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/items/' + itemId, {method: 'PUT', body: JSON.stringify(body)});
  },
  removeItem: function(projectId, id, itemId){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/items/' + itemId, {method: 'DELETE'});
  },
  promoteItem: function(projectId, id, itemId, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/items/' + itemId + '/promote', {method: 'POST', body: JSON.stringify(body)});
  },
  createActionItem: function(projectId, id, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/action-items', {method: 'POST', body: JSON.stringify(body)});
  },
  updateActionItem: function(projectId, id, itemId, body){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/action-items/' + itemId, {method: 'PUT', body: JSON.stringify(body)});
  },
  removeActionItem: function(projectId, id, itemId){
    return apiFetch('/projects/' + projectId + '/retrospectives/' + id + '/action-items/' + itemId, {method: 'DELETE'});
  }
};

/* Organisation-owned, not per-project (like getTemplatesApi/getTodoListsApi above) — route base is
   /api/organisations/me/principles, see OrganisationPrinciplesController.cs. Sharing a principle INTO
   this library is project-scoped (principleApi.share above); everything here is about consuming the
   already-shared library from any project in the org. */
export var organisationPrincipleApi = {
  listWide: function(){
    return apiFetch('/organisations/me/principles', {method: 'GET'});
  },
  suggestions: function(){
    return apiFetch('/organisations/me/principles/suggestions', {method: 'GET'});
  },
  copy: function(principleId, body){
    return apiFetch('/organisations/me/principles/' + principleId + '/copy', {method: 'POST', body: JSON.stringify(body)});
  }
};

/* Backs the Org-Admin-only Portfolio Dashboard (modals/portfolio-dashboard.js) — route base
   /api/organisations/me/portfolio, see PortfolioController.cs/.php. Every one of these is
   OrgAdmin-gated server-side regardless of what this client sends; project ids here are only ever
   a request for data the server independently re-validates against the caller's own organisation. */
export var portfolioApi = {
  listProjects: function(){
    return apiFetch('/organisations/me/portfolio/projects', {method: 'GET'});
  },
  /* GET, not POST: this is a pure read (no side effects), and POST would trip the global
     MustChangePassword gate that blocks every mutating request — see PortfolioController.cs's
     GetAggregate for why that would wrongly lock a freshly-migrated Org Admin out of this dashboard.
     projectIds is joined into a single comma-separated query value rather than repeated/bracketed
     params — see PortfolioController.cs's GetActivity for why (ASP.NET Core and Slim/PHP parse
     array-shaped query strings differently, and this same call needs to work unchanged against
     either tier). */
  getAggregate: function(projectIds){
    return apiFetch('/organisations/me/portfolio/aggregate?projectIds=' + encodeURIComponent(projectIds.join(',')), {method: 'GET'});
  },
  /* start/end are 'YYYY-MM-DD' strings; projectIds is joined into a single comma-separated query
     value rather than repeated/bracketed params — see PortfolioController.cs's GetActivity for why
     (ASP.NET Core and Slim/PHP parse array-shaped query strings differently, and this same call
     needs to work unchanged against either tier). */
  getActivity: function(projectIds, start, end){
    var query = 'projectIds=' + encodeURIComponent(projectIds.join(',')) + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
    return apiFetch('/organisations/me/portfolio/activity?' + query, {method: 'GET'});
  },
  /* Backs the Timeline chart's click-to-edit modal and drag-to-schedule bars — a genuine mutation,
     unlike getAggregate/getActivity above, so PUT is correct here (not routed around
     MustChangePassword the way those two are). Deliberately its own endpoint rather than the
     ProjectMember-gated updateProjectApi in this same file — see PortfolioController.cs's
     UpdateProjectDates for why. start/end are 'YYYY-MM-DD' strings or null to clear a date. */
  updateProjectDates: function(projectId, start, end){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/dates', {method: 'PUT', body: JSON.stringify({startDate: start, endDate: end})});
  },
  /* Backs the Portfolio Planner's "Add Project" form — creates a placeholder project with
     isActive=false, no ProjectMember row, no token mint (see PortfolioService.CreateProjectAsync). */
  createProject: function(name, priority, categoryId, startDate, endDate, key){
    return apiFetch('/organisations/me/portfolio/projects', {method: 'POST', body: JSON.stringify({
      name: name, key: key || null, priority: priority || null, categoryId: categoryId || null,
      startDate: startDate || null, endDate: endDate || null
    })});
  },
  /* The only call that can ever flip IsActive — server re-validates dates are set before allowing
     isActive:true (see PortfolioService.UpdateProjectActiveAsync); a 400 means dates are missing. */
  updateProjectActive: function(projectId, isActive){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/active', {method: 'PUT', body: JSON.stringify({isActive: isActive})});
  },
  updateProjectCategory: function(projectId, categoryId){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/category', {method: 'PUT', body: JSON.stringify({categoryId: categoryId || null})});
  },
  listCategories: function(){
    return apiFetch('/organisations/me/portfolio/categories', {method: 'GET'});
  },
  createCategory: function(name){
    return apiFetch('/organisations/me/portfolio/categories', {method: 'POST', body: JSON.stringify({name: name})});
  },
  updateCategory: function(categoryId, name){
    return apiFetch('/organisations/me/portfolio/categories/' + categoryId, {method: 'PUT', body: JSON.stringify({name: name})});
  },
  deleteCategory: function(categoryId){
    return apiFetch('/organisations/me/portfolio/categories/' + categoryId, {method: 'DELETE'});
  },
  updateCategorySortOrder: function(categoryId, sortOrder){
    return apiFetch('/organisations/me/portfolio/categories/' + categoryId + '/sort-order', {method: 'PUT', body: JSON.stringify({sortOrder: sortOrder})});
  },
  /* Backs the Portfolio Planner's Resources overlay — placeholder role+person+% resourcing for a
     not-yet-real project. Role is free-text; listRoles() below only feeds the autocomplete, it's
     never enforced server-side. userId is optional — null/omitted means an unfilled role. */
  listResources: function(projectId){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/resources', {method: 'GET'});
  },
  addResource: function(projectId, role, userId, allocatedFraction){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/resources', {method: 'POST', body: JSON.stringify({role: role, userId: userId || null, allocatedFraction: allocatedFraction})});
  },
  updateResource: function(projectId, resourceId, role, userId, allocatedFraction){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/resources/' + resourceId, {method: 'PUT', body: JSON.stringify({role: role, userId: userId || null, allocatedFraction: allocatedFraction})});
  },
  removeResource: function(projectId, resourceId){
    return apiFetch('/organisations/me/portfolio/projects/' + projectId + '/resources/' + resourceId, {method: 'DELETE'});
  },
  /* The distinct, non-blank roles already in use across the org's real projects (ProjectMember.Role)
     — a suggestion list for the Resources overlay's role input, not an enforced vocabulary. */
  listRoles: function(){
    return apiFetch('/organisations/me/portfolio/roles', {method: 'GET'});
  },
  /* Backs the Portfolio Dashboard's Resourcing section — GET, and deliberately org-wide (no
     projectIds param at all), unlike every other call in this object — see
     PortfolioService.GetResourcingSummaryAsync's doc comment for why. */
  getResourcingSummary: function(){
    return apiFetch('/organisations/me/portfolio/resourcing', {method: 'GET'});
  }
};
