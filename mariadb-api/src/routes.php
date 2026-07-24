<?php

declare(strict_types=1);

use Enkl\Api\Auth\ApiKeyAuthMiddleware;
use Enkl\Api\Auth\JwtAuthMiddleware;
use Enkl\Api\Auth\OrgAdminMiddleware;
use Enkl\Api\Auth\ProjectAdminMiddleware;
use Enkl\Api\Auth\ProjectMemberMiddleware;
use Enkl\Api\Auth\RateLimitMiddleware;
use Enkl\Api\Auth\RequireAuthMiddleware;
use Enkl\Api\Auth\ScimAuthMiddleware;
use Enkl\Api\Auth\SessionValidationMiddleware;
use Enkl\Api\Controllers\AiAssistantController;
use Enkl\Api\Controllers\AnnouncementsController;
use Enkl\Api\Controllers\AuthController;
use Enkl\Api\Controllers\ChatController;
use Enkl\Api\Controllers\ColumnsController;
use Enkl\Api\Controllers\DecisionsController;
use Enkl\Api\Controllers\DocumentsController;
use Enkl\Api\Controllers\EventsController;
use Enkl\Api\Controllers\MembersController;
use Enkl\Api\Controllers\MigrationController;
use Enkl\Api\Controllers\ObjectivesController;
use Enkl\Api\Controllers\OrganisationPrinciplesController;
use Enkl\Api\Controllers\OrganisationSsoConfigController;
use Enkl\Api\Controllers\OrganisationsController;
use Enkl\Api\Controllers\OrganisationAnnouncementsController;
use Enkl\Api\Controllers\OrganisationApiKeyController;
use Enkl\Api\Controllers\PortfolioController;
use Enkl\Api\Controllers\PrinciplesController;
use Enkl\Api\Controllers\ProjectsController;
use Enkl\Api\Controllers\ProjectStrategyController;
use Enkl\Api\Controllers\PublicQueryController;
use Enkl\Api\Controllers\ReleasesController;
use Enkl\Api\Controllers\RetrospectivesController;
use Enkl\Api\Controllers\RisksController;
use Enkl\Api\Controllers\SavedQueriesController;
use Enkl\Api\Controllers\SamlController;
use Enkl\Api\Controllers\ScimGroupsController;
use Enkl\Api\Controllers\ScimUsersController;
use Enkl\Api\Controllers\StrategyController;
use Enkl\Api\Controllers\TaskCommentsController;
use Enkl\Api\Controllers\TasksController;
use Enkl\Api\Controllers\TaskTypesController;
use Enkl\Api\Controllers\TeamsCommitteesController;
use Enkl\Api\Controllers\TelemetryController;
use Enkl\Api\Controllers\TemplatesController;
use Enkl\Api\Controllers\ToDoController;
use Slim\App;

/**
 * Route table — deliberately mirrors api/Enkl.Api/Controllers/*.cs's [Route]/[Http*] attributes one
 * for one, same paths/methods/status codes, so src/js/api.js needs zero changes to talk to this tier
 * instead of the .NET one. JwtAuthMiddleware runs on every route (cheap: only populates a request
 * attribute if a valid Bearer token is present, never rejects on its own) — RequireAuthMiddleware and
 * ProjectMemberMiddleware/OrgAdminMiddleware are added per-group/per-route to actually enforce it,
 * matching which .NET controllers/actions carry [Authorize] vs [AllowAnonymous] vs
 * [Authorize(Policy = "ProjectMember")]/[Authorize(Policy = "OrgAdmin")].
 */
function registerRoutes(App $app): void
{
    // SessionValidationMiddleware is added BEFORE JwtAuthMiddleware so it runs AFTER it — Slim's
    // middleware stack is LIFO, so the last ->add() call here (JwtAuthMiddleware) is outermost and
    // runs first, populating the jwtClaims attribute this middleware reads.
    $app->add(SessionValidationMiddleware::class);
    $app->add(JwtAuthMiddleware::class);

    $app->get('/health', function ($request, $response) {
        $response->getBody()->write(json_encode(['status' => 'ok']));
        return $response->withHeader('Content-Type', 'application/json');
    });

    // ---- Auth (all rate-limited — security review finding H1 — mirroring exactly which .NET
    // actions carry [EnableRateLimiting("auth")], see Program.cs's "auth" policy) ----
    // Contract-parity harness finding (contract-tests/, 2026-07-16): bare `RateLimitMiddleware::class`
    // is BROKEN for any middleware whose constructor has a required-in-effect typed first parameter.
    // Slim's container-less CallableResolver::resolveSlimNotation() always calls
    // `new $class($this->container)` for a plain class-string (see vendor/slim/slim/Slim/
    // CallableResolver.php) — with no DI container configured anywhere in this app, that's
    // `new RateLimitMiddleware(null)`, which crashes against `string $policyName = 'auth'` (null
    // isn't assignable to a non-nullable string param, so the default never kicks in). Every route
    // below 500'd on every request until this was caught. Always pass a constructed instance instead
    // — `new RateLimitMiddleware()` for the default "auth" policy, exactly like the telemetry route
    // below already does for its own named policy.
    $app->post('/api/auth/login', [AuthController::class, 'login'])->add(new RateLimitMiddleware());
    // sso-lookup/sso-exchange are anonymous like login itself — see AuthController.php's own notes
    // on each (minimal-disclosure org discovery; single-use SAML exchange-code redemption).
    $app->get('/api/auth/sso-lookup', [AuthController::class, 'ssoLookup'])->add(new RateLimitMiddleware());
    $app->post('/api/auth/sso-exchange', [AuthController::class, 'ssoExchange'])->add(new RateLimitMiddleware());
    $app->post('/api/auth/change-password', [AuthController::class, 'changePassword'])
        ->add(RequireAuthMiddleware::class)->add(new RateLimitMiddleware());

    // ---- Migration (deliberately anonymous — bootstrapping, see MigrationController.cs's own note;
    // rate-limited — H1 — since it was also a plausible unauthenticated resource-exhaustion target) ----
    $app->post('/api/migration/projects', [MigrationController::class, 'migrate'])->add(new RateLimitMiddleware());

    // ---- Telemetry (deliberately anonymous — a fire-and-forget RUM beacon from every page load,
    // signed in or not; its own "telemetry" rate-limit policy, more generous than "auth"'s
    // brute-force-tuned limit — see RateLimitMiddleware.php's own note) ----
    $app->post('/api/telemetry/page-load', [TelemetryController::class, 'reportPageLoad'])
        ->add(new RateLimitMiddleware('telemetry', 30));

    // ---- SAML SSO (deliberately anonymous — nothing here can be gated behind a JWT, since the
    // whole point is to ISSUE one; see SamlController.php's own note) ----
    $app->group('/api/saml/{orgId}', function ($group) {
        $group->get('/metadata', [SamlController::class, 'metadata']);
        $group->get('/login', [SamlController::class, 'login']);
        $group->post('/acs', [SamlController::class, 'acs']);
    });

    // ---- SCIM 2.0 provisioning — gated by ScimAuthMiddleware's per-org static bearer token
    // INSTEAD OF RequireAuthMiddleware/OrgAdminMiddleware (there's no user JWT in a SCIM request at
    // all); see ScimAuthMiddleware.php's own note. ----
    $app->group('/api/scim/v2/{orgId}/Users', function ($group) {
        $group->get('', [ScimUsersController::class, 'list']);
        $group->get('/{id}', [ScimUsersController::class, 'get']);
        $group->post('', [ScimUsersController::class, 'create']);
        $group->put('/{id}', [ScimUsersController::class, 'replace']);
        $group->patch('/{id}', [ScimUsersController::class, 'patch']);
        $group->delete('/{id}', [ScimUsersController::class, 'delete']);
    })->add(ScimAuthMiddleware::class);
    $app->group('/api/scim/v2/{orgId}/Groups', function ($group) {
        $group->get('', [ScimGroupsController::class, 'list']);
        $group->get('/{id}', [ScimGroupsController::class, 'get']);
        $group->post('', [ScimGroupsController::class, 'create']);
        $group->put('/{id}', [ScimGroupsController::class, 'replace']);
        $group->patch('/{id}', [ScimGroupsController::class, 'patch']);
        $group->delete('/{id}', [ScimGroupsController::class, 'delete']);
    })->add(ScimAuthMiddleware::class);

    // ---- Organisations (OrgAdmin only) ----
    $app->group('/api/organisations/me', function ($group) {
        $group->get('', [OrganisationsController::class, 'getMyOrganisation']);
        $group->put('/users/{userId}/admin', [OrganisationsController::class, 'setUserAdmin']);
        $group->put('/users/{userId}/email', [OrganisationsController::class, 'setUserEmail']);
        $group->put('/users/{userId}/password', [OrganisationsController::class, 'resetUserPassword']);
        $group->post('/users/{userId}/deactivate', [OrganisationsController::class, 'deactivateUser']);
        $group->post('/users', [OrganisationsController::class, 'createUser']);
        $group->get('/org-teams', [OrganisationsController::class, 'getOrgTeams']);
        $group->put('/default-password', [OrganisationsController::class, 'setDefaultNewUserPassword']);
        $group->get('/sso-config', [OrganisationSsoConfigController::class, 'get']);
        $group->put('/sso-config', [OrganisationSsoConfigController::class, 'update']);
        $group->post('/sso-config/scim-token', [OrganisationSsoConfigController::class, 'generateScimToken']);
        $group->get('/api-key', [OrganisationApiKeyController::class, 'get']);
        $group->post('/api-key', [OrganisationApiKeyController::class, 'generate']);
        $group->delete('/api-key', [OrganisationApiKeyController::class, 'revoke']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Chat (org-wide, any authenticated org user — deliberately NO ProjectMemberMiddleware, since
    // colleagues chat across the whole org, not within one project's membership) ----
    $app->group('/api/chat', function ($group) {
        $group->get('/org-users', [ChatController::class, 'getOrgRoster']);
        $group->get('/channels', [ChatController::class, 'listChannels']);
        $group->post('/channels', [ChatController::class, 'createChannel']);
        $group->post('/channels/{channelId}/members', [ChatController::class, 'addMember']);
        $group->delete('/channels/{channelId}/members/{userId}', [ChatController::class, 'removeMember']);
        $group->put('/channels/{channelId}/mute', [ChatController::class, 'setMuted']);
        $group->get('/search', [ChatController::class, 'search']);
        $group->get('/channels/{channelId}/messages', [ChatController::class, 'getMessages']);
        $group->post('/channels/{channelId}/messages', [ChatController::class, 'postMessage']);
        $group->put('/channels/{channelId}/messages/{messageId}', [ChatController::class, 'updateMessage']);
        $group->delete('/channels/{channelId}/messages/{messageId}', [ChatController::class, 'deleteMessage']);
        $group->post('/channels/{channelId}/messages/{messageId}/reactions', [ChatController::class, 'toggleReaction']);
        // Manual replacement for a scheduled 180-day purge — see ChatService::truncateOldMessages's own
        // doc comment — nested in its own sub-group (same "extra check on just these routes" shape as
        // teams-committees above) so only this one route requires OrgAdmin, not the whole /api/chat group.
        $group->group('', function ($adminGroup) {
            $adminGroup->post('/truncate', [ChatController::class, 'truncate']);
        })->add(OrgAdminMiddleware::class);
    })->add(RequireAuthMiddleware::class);

    // ---- Announcements: any authenticated user reads what's currently active/relevant to them and
    // acknowledges ones they've seen (no OrgAdmin/ProjectMemberMiddleware) — see
    // OrganisationAnnouncementsController's own group below for the Org-Admin-only CRUD surface. ----
    $app->group('/api/announcements', function ($group) {
        $group->get('/active', [AnnouncementsController::class, 'getActive']);
        $group->post('/{announcementId}/acknowledge', [AnnouncementsController::class, 'acknowledge']);
    })->add(RequireAuthMiddleware::class);

    // ---- Announcements management (OrgAdmin only, own org's Scope="org" rows) ----
    $app->group('/api/organisations/me/announcements', function ($group) {
        $group->get('', [OrganisationAnnouncementsController::class, 'list']);
        $group->post('', [OrganisationAnnouncementsController::class, 'create']);
        $group->put('/{announcementId}', [OrganisationAnnouncementsController::class, 'update']);
        $group->delete('/{announcementId}', [OrganisationAnnouncementsController::class, 'delete']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Public Query API (the app's first public/3rd-party-facing surface — deliberately
    // namespaced/versioned apart from the internal "api/..." routes, see PublicQueryController.php's
    // own note) — gated by ApiKeyAuthMiddleware's per-org static API key INSTEAD OF
    // JwtAuthMiddleware/RequireAuthMiddleware, same shape as the SCIM group above. Rate-limited by
    // the presented API key (hashed), not IP — see RateLimitMiddleware.php's own note on why. ----
    $app->get('/api/public/v1/queries/{savedQueryId}/results', [PublicQueryController::class, 'getResults'])
        ->add(ApiKeyAuthMiddleware::class)
        ->add(new RateLimitMiddleware('publicQuery', 60, function ($request) {
            $authHeader = $request->getHeaderLine('Authorization');
            $token = stripos($authHeader, 'bearer ') === 0 ? trim(substr($authHeader, 7)) : '';
            return $token !== '' ? hash('sha256', $token) : 'unknown';
        }));

    // ---- Portfolio Dashboard (OrgAdmin only, deliberately NO ProjectMemberMiddleware — an admin
    // reviewing their organisation's portfolio may not personally belong to every project in it; see
    // PortfolioService.php's own doc comment for the cross-org isolation guarantee this relies on) ----
    $app->group('/api/organisations/me/portfolio', function ($group) {
        $group->get('/projects', [PortfolioController::class, 'listProjects']);
        $group->post('/projects', [PortfolioController::class, 'createProject']);
        $group->get('/aggregate', [PortfolioController::class, 'getAggregate']);
        $group->get('/activity', [PortfolioController::class, 'getActivity']);
        $group->put('/projects/{projectId}/dates', [PortfolioController::class, 'updateProjectDates']);
        $group->put('/projects/{projectId}/active', [PortfolioController::class, 'updateProjectActive']);
        $group->put('/projects/{projectId}/category', [PortfolioController::class, 'updateProjectCategory']);
        $group->get('/categories', [PortfolioController::class, 'listCategories']);
        $group->post('/categories', [PortfolioController::class, 'createCategory']);
        $group->put('/categories/{categoryId}', [PortfolioController::class, 'updateCategory']);
        $group->delete('/categories/{categoryId}', [PortfolioController::class, 'deleteCategory']);
        $group->put('/categories/{categoryId}/sort-order', [PortfolioController::class, 'updateCategorySortOrder']);
        $group->get('/projects/{projectId}/resources', [PortfolioController::class, 'listResources']);
        $group->get('/projects/{projectId}/members', [PortfolioController::class, 'listRealMembers']);
        $group->post('/projects/{projectId}/resources', [PortfolioController::class, 'addResource']);
        $group->put('/projects/{projectId}/resources/{resourceId}', [PortfolioController::class, 'updateResource']);
        $group->delete('/projects/{projectId}/resources/{resourceId}', [PortfolioController::class, 'removeResource']);
        $group->get('/roles', [PortfolioController::class, 'listRoles']);
        $group->get('/resourcing', [PortfolioController::class, 'getResourcingSummary']);
        // Fulfilment-upsert lives here, not under /strategy below — logically nested under Portfolio
        // Planner's own route namespace (the only place this is ever written from), matching
        // StrategyController.cs's [HttpPut("~/api/organisations/me/portfolio/...")] absolute-route
        // override for the same endpoint.
        $group->put('/projects/{projectId}/strategy-fulfilment/{pillarId}', [StrategyController::class, 'upsertFulfilment']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Enterprise Strategy Management (OrgAdmin-only management; read-only ProjectMember surface
    // is under /api/projects/{projectId}/strategy below instead) ----
    $app->group('/api/organisations/me/strategy', function ($group) {
        $group->get('', [StrategyController::class, 'list']);
        $group->get('/active', [StrategyController::class, 'getActive']);
        $group->post('', [StrategyController::class, 'create']);
        $group->put('/{strategyId}', [StrategyController::class, 'update']);
        $group->put('/{strategyId}/activate', [StrategyController::class, 'activate']);
        $group->delete('/{strategyId}', [StrategyController::class, 'delete']);
        $group->get('/{strategyId}/tree', [StrategyController::class, 'getTree']);
        $group->post('/{strategyId}/pillars', [StrategyController::class, 'createPillar']);
        $group->put('/pillars/{pillarId}', [StrategyController::class, 'updatePillar']);
        $group->delete('/pillars/{pillarId}', [StrategyController::class, 'deletePillar']);
        $group->post('/pillars/{pillarId}/enablers', [StrategyController::class, 'createEnabler']);
        $group->put('/enablers/{enablerId}', [StrategyController::class, 'updateEnabler']);
        $group->delete('/enablers/{enablerId}', [StrategyController::class, 'deleteEnabler']);
        $group->post('/pillars/{pillarId}/metrics', [StrategyController::class, 'createMetricOnPillar']);
        $group->post('/enablers/{enablerId}/metrics', [StrategyController::class, 'createMetricOnEnabler']);
        $group->put('/metrics/{metricId}', [StrategyController::class, 'updateMetric']);
        $group->delete('/metrics/{metricId}', [StrategyController::class, 'deleteMetric']);
        $group->post('/metrics/{metricId}/entries', [StrategyController::class, 'recordMetricEntry']);
        $group->get('/metrics/{metricId}/entries', [StrategyController::class, 'getMetricHistory']);
        $group->get('/fulfilment-matrix', [StrategyController::class, 'getFulfilmentMatrix']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Project Templates (Organisation-owned) — list/detail/create need only auth (any signed-in
    // member may save/use a template, same trust level as creating a column or task type today);
    // rename/delete need OrgAdmin, same bar as Organisations' user-management routes above ----
    $app->group('/api/organisations/me/templates', function ($group) {
        $group->get('', [TemplatesController::class, 'list']);
        $group->get('/{id}', [TemplatesController::class, 'detail']);
        $group->post('', [TemplatesController::class, 'create']);
    })->add(RequireAuthMiddleware::class);
    $app->group('/api/organisations/me/templates', function ($group) {
        $group->put('/{id}', [TemplatesController::class, 'rename']);
        $group->delete('/{id}', [TemplatesController::class, 'delete']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Organisation Principle library (browse/copy the shared library) — any signed-in org
    // member, same trust level as the templates list/read above; sharing itself is gated
    // per-project via PUT /api/projects/{projectId}/principles/{id}/share (ProjectMember policy). ----
    $app->group('/api/organisations/me/principles', function ($group) {
        $group->get('', [OrganisationPrinciplesController::class, 'listWide']);
        $group->get('/suggestions', [OrganisationPrinciplesController::class, 'suggestions']);
        $group->post('/{principleId}/copy', [OrganisationPrinciplesController::class, 'copy']);
    })->add(RequireAuthMiddleware::class);

    // ---- To-Do Lists (per-User, not per-Project/per-Organisation — same "just needs to be signed in
    // as yourself" gating as /api/auth/change-password above, no ProjectMemberMiddleware/OrgAdminMiddleware) ----
    $app->group('/api/todo-lists', function ($group) {
        $group->get('', [ToDoController::class, 'list']);
        $group->post('', [ToDoController::class, 'create']);
        $group->put('/{listId}', [ToDoController::class, 'rename']);
        $group->delete('/{listId}', [ToDoController::class, 'delete']);
        $group->post('/{listId}/items', [ToDoController::class, 'createItem']);
        $group->put('/{listId}/items/{itemId}', [ToDoController::class, 'updateItem']);
        $group->delete('/{listId}/items/{itemId}', [ToDoController::class, 'deleteItem']);
    })->add(RequireAuthMiddleware::class);

    // ---- Projects (list/detail/create need only auth; everything under {projectId} needs membership) ----
    $app->get('/api/projects', [ProjectsController::class, 'listMine'])->add(RequireAuthMiddleware::class);
    $app->post('/api/projects', [ProjectsController::class, 'create'])->add(RequireAuthMiddleware::class);
    // Pre-creation key-uniqueness check for the "New Project" flow — sits outside the {projectId}
    // group (there's no project yet), same reasoning as create() just above.
    $app->get('/api/projects/key-availability', [ProjectsController::class, 'checkKeyAvailabilityForCreation'])->add(RequireAuthMiddleware::class);

    $app->group('/api/projects/{projectId}', function ($group) {
        $group->get('', [ProjectsController::class, 'detail']);
        $group->put('', [ProjectsController::class, 'update']);
        $group->delete('', [ProjectsController::class, 'delete']);
        // Changing a project's key is Org-Admin-only — well above ordinary ProjectMember editing
        // (the plain PUT '' above) — see ProjectService::changeKey's own doc comment for why. Nested
        // in its own sub-group, same "extra check on just these routes" shape as teams-committees below.
        $group->group('', function ($keyGroup) {
            $keyGroup->get('/key-availability', [ProjectsController::class, 'checkKeyAvailability']);
            $keyGroup->put('/key', [ProjectsController::class, 'changeKey']);
        })->add(OrgAdminMiddleware::class);
        // Project Administrator capabilities ("change app settings", "manage workflow") — see
        // Auth/ProjectAdminMiddleware.php's own doc comment.
        $group->put('/settings', [ProjectsController::class, 'updateSettings'])->add(ProjectAdminMiddleware::class);
        $group->put('/workflow', [ProjectsController::class, 'updateWorkflow'])->add(ProjectAdminMiddleware::class);

        // Columns and Members are entirely mutation-only controllers (both are read via GET
        // /api/projects/{id}'s own project-detail response, not through these) — nested in their own
        // sub-groups (same "extra check on just these routes" shape as teams-committees below) so
        // every action in both requires the Project Administrator role, not just plain membership.
        $group->group('', function ($adminGroup) {
            registerEntityRoutes($adminGroup, '/columns', ColumnsController::class, 'columnId');
            $adminGroup->get('/members/org-candidates', [MembersController::class, 'orgCandidates']);
            registerEntityRoutes($adminGroup, '/members', MembersController::class, 'memberId');
            $adminGroup->put('/members/{memberId}/admin', [MembersController::class, 'setProjectAdmin']);
        })->add(ProjectAdminMiddleware::class);

        registerEntityRoutes($group, '/tasks', TasksController::class, 'taskId');
        // v4 Phase 1 AI Assistant — a single chat endpoint, ProjectMember-gated same as every other
        // route in this group. Rate-limited per-caller (hashed bearer token) since each request can
        // fan out to several Claude API calls internally (AiAssistantService's own tool-use loop) —
        // a real per-request cost multiplier the rest of this API doesn't have.
        $group->post('/ai-assistant/chat', [AiAssistantController::class, 'chat'])
            ->add(new RateLimitMiddleware('ai-assistant', 15, function ($request) {
                $authHeader = $request->getHeaderLine('Authorization');
                $token = stripos($authHeader, 'bearer ') === 0 ? trim(substr($authHeader, 7)) : '';
                return $token !== '' ? hash('sha256', $token) : 'unknown';
            }));
        // Unrated - a plain read, polled periodically by the frontend to decide bubble visibility.
        $group->get('/ai-assistant/availability', [AiAssistantController::class, 'availability']);
        // Comments are nested under a specific task (not a flat per-project entity, so they don't fit
        // registerEntityRoutes' single-{idParam} shape) — POST/PUT/DELETE mirror
        // TaskCommentsController.cs's route exactly.
        $group->post('/tasks/{taskId}/comments', [TaskCommentsController::class, 'create']);
        $group->put('/tasks/{taskId}/comments/{commentId}', [TaskCommentsController::class, 'update']);
        $group->delete('/tasks/{taskId}/comments/{commentId}', [TaskCommentsController::class, 'delete']);
        registerEntityRoutes($group, '/releases', ReleasesController::class, 'id');
        // ReleaseNotes (Release Notes Packager) is Project-Admin-only — see
        // ReleasesController.php's own note; every other release field stays plain-ProjectMember via
        // registerEntityRoutes above.
        $group->put('/releases/{id}/notes', [ReleasesController::class, 'updateNotes'])->add(ProjectAdminMiddleware::class);
        registerEntityRoutes($group, '/task-types', TaskTypesController::class, 'id');
        registerEntityRoutes($group, '/principles', PrinciplesController::class, 'id');
        $group->put('/principles/{id}/share', [PrinciplesController::class, 'share']);
        registerEntityRoutes($group, '/documents', DocumentsController::class, 'id');
        registerEntityRoutes($group, '/risks', RisksController::class, 'id');
        registerEntityRoutes($group, '/objectives', ObjectivesController::class, 'id');
        // SavedQuery now supports Update (Advanced Query tab's "Update Query" button, overwriting the
        // loaded saved query's SQL in place rather than only ever creating a new one) — the standard
        // POST/PUT/DELETE trio, same as every other simple project-scoped entity.
        registerEntityRoutes($group, '/saved-queries', SavedQueriesController::class, 'id');
        // "Test API (GET)" button — see SavedQueriesController::test's own doc comment.
        $group->get('/saved-queries/{id}/test', [SavedQueriesController::class, 'test']);
        // Team/committee CRUD (including applying a synced Org Team's membership onto one) is
        // OrgAdmin-only — per product decision, a project member without that flag should neither
        // see nor be able to use the Teams & Committees feature to change membership. Nested in its
        // own sub-group (rather than adding OrgAdminMiddleware to the outer {projectId} group,
        // which every other entity route also shares) so only these routes get the extra check —
        // see TeamsCommitteesController.cs's matching [Authorize(Policy = "OrgAdmin")] and
        // board.js's applyHeaderButtonVisibility for the frontend button-visibility gate.
        $group->group('/teams-committees', function ($teamsCommitteesGroup) {
            registerEntityRoutes($teamsCommitteesGroup, '', TeamsCommitteesController::class, 'id');
            $teamsCommitteesGroup->post('/from-org-team/{orgTeamId}', [TeamsCommitteesController::class, 'applyOrgTeam']);
        })->add(OrgAdminMiddleware::class);
        registerEntityRoutes($group, '/decisions', DecisionsController::class, 'id');
        registerEntityRoutes($group, '/retrospectives', RetrospectivesController::class, 'id');
        $group->post('/retrospectives/{id}/items', [RetrospectivesController::class, 'createItem']);
        $group->put('/retrospectives/{id}/items/{itemId}', [RetrospectivesController::class, 'updateItem']);
        $group->delete('/retrospectives/{id}/items/{itemId}', [RetrospectivesController::class, 'deleteItem']);
        $group->post('/retrospectives/{id}/items/{itemId}/promote', [RetrospectivesController::class, 'promoteItem']);
        $group->post('/retrospectives/{id}/action-items', [RetrospectivesController::class, 'createActionItem']);
        $group->put('/retrospectives/{id}/action-items/{itemId}', [RetrospectivesController::class, 'updateActionItem']);
        $group->delete('/retrospectives/{id}/action-items/{itemId}', [RetrospectivesController::class, 'deleteActionItem']);
        // Read-only Strategy surface for regular project members — see ProjectStrategyController.cs's
        // matching [Authorize(Policy = "ProjectMember")] controller. No CRUD lives here; every write
        // goes through StrategyController (OrgAdmin) or the Portfolio Planner fulfilment-upsert route.
        $group->get('/strategy/tree', [ProjectStrategyController::class, 'getTree']);
        $group->get('/strategy/metrics/{metricId}/entries', [ProjectStrategyController::class, 'getMetricHistory']);
        $group->get('/strategy/fulfilment', [ProjectStrategyController::class, 'getFulfilment']);
    })->add(ProjectMemberMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Realtime (SSE) — one stream per user, covers every project they're a member of; see
    // EventsController.cs's own note on why this isn't under the {projectId} group ----
    $app->get('/api/events/stream', [EventsController::class, 'stream'])->add(RequireAuthMiddleware::class);
}

/** Registers the standard POST/PUT/DELETE trio every simple per-project entity uses. */
function registerEntityRoutes($group, string $prefix, string $controllerClass, string $idParam): void
{
    $group->post($prefix, [$controllerClass, 'create']);
    $group->put($prefix . '/{' . $idParam . '}', [$controllerClass, 'update']);
    $group->delete($prefix . '/{' . $idParam . '}', [$controllerClass, 'delete']);
}
