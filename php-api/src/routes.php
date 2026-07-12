<?php

declare(strict_types=1);

use Enkl\Api\Auth\JwtAuthMiddleware;
use Enkl\Api\Auth\OrgAdminMiddleware;
use Enkl\Api\Auth\ProjectMemberMiddleware;
use Enkl\Api\Auth\RateLimitMiddleware;
use Enkl\Api\Auth\RequireAuthMiddleware;
use Enkl\Api\Auth\ScimAuthMiddleware;
use Enkl\Api\Auth\SessionValidationMiddleware;
use Enkl\Api\Controllers\AuthController;
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
use Enkl\Api\Controllers\PortfolioController;
use Enkl\Api\Controllers\PrinciplesController;
use Enkl\Api\Controllers\ProjectsController;
use Enkl\Api\Controllers\ReleasesController;
use Enkl\Api\Controllers\RetrospectivesController;
use Enkl\Api\Controllers\RisksController;
use Enkl\Api\Controllers\SamlController;
use Enkl\Api\Controllers\ScimGroupsController;
use Enkl\Api\Controllers\ScimUsersController;
use Enkl\Api\Controllers\TasksController;
use Enkl\Api\Controllers\TaskTypesController;
use Enkl\Api\Controllers\TeamsCommitteesController;
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
    $app->post('/api/auth/login', [AuthController::class, 'login'])->add(RateLimitMiddleware::class);
    // sso-lookup/sso-exchange are anonymous like login itself — see AuthController.php's own notes
    // on each (minimal-disclosure org discovery; single-use SAML exchange-code redemption).
    $app->get('/api/auth/sso-lookup', [AuthController::class, 'ssoLookup'])->add(RateLimitMiddleware::class);
    $app->post('/api/auth/sso-exchange', [AuthController::class, 'ssoExchange'])->add(RateLimitMiddleware::class);
    $app->post('/api/auth/change-password', [AuthController::class, 'changePassword'])
        ->add(RequireAuthMiddleware::class)->add(RateLimitMiddleware::class);

    // ---- Migration (deliberately anonymous — bootstrapping, see MigrationController.cs's own note;
    // rate-limited — H1 — since it was also a plausible unauthenticated resource-exhaustion target) ----
    $app->post('/api/migration/projects', [MigrationController::class, 'migrate'])->add(RateLimitMiddleware::class);

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
        $group->post('/users', [OrganisationsController::class, 'createUser']);
        $group->get('/org-teams', [OrganisationsController::class, 'getOrgTeams']);
        $group->get('/sso-config', [OrganisationSsoConfigController::class, 'get']);
        $group->put('/sso-config', [OrganisationSsoConfigController::class, 'update']);
        $group->post('/sso-config/scim-token', [OrganisationSsoConfigController::class, 'generateScimToken']);
    })->add(OrgAdminMiddleware::class)->add(RequireAuthMiddleware::class);

    // ---- Portfolio Dashboard (OrgAdmin only, deliberately NO ProjectMemberMiddleware — an admin
    // reviewing their organisation's portfolio may not personally belong to every project in it; see
    // PortfolioService.php's own doc comment for the cross-org isolation guarantee this relies on) ----
    $app->group('/api/organisations/me/portfolio', function ($group) {
        $group->get('/projects', [PortfolioController::class, 'listProjects']);
        $group->get('/aggregate', [PortfolioController::class, 'getAggregate']);
        $group->get('/activity', [PortfolioController::class, 'getActivity']);
        $group->put('/projects/{projectId}/dates', [PortfolioController::class, 'updateProjectDates']);
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

    $app->group('/api/projects/{projectId}', function ($group) {
        $group->get('', [ProjectsController::class, 'detail']);
        $group->put('', [ProjectsController::class, 'update']);
        $group->delete('', [ProjectsController::class, 'delete']);
        $group->put('/settings', [ProjectsController::class, 'updateSettings']);
        $group->put('/workflow', [ProjectsController::class, 'updateWorkflow']);

        registerEntityRoutes($group, '/columns', ColumnsController::class, 'columnId');
        registerEntityRoutes($group, '/tasks', TasksController::class, 'taskId');
        registerEntityRoutes($group, '/members', MembersController::class, 'memberId');
        registerEntityRoutes($group, '/releases', ReleasesController::class, 'id');
        registerEntityRoutes($group, '/task-types', TaskTypesController::class, 'id');
        registerEntityRoutes($group, '/principles', PrinciplesController::class, 'id');
        $group->put('/principles/{id}/share', [PrinciplesController::class, 'share']);
        registerEntityRoutes($group, '/documents', DocumentsController::class, 'id');
        registerEntityRoutes($group, '/risks', RisksController::class, 'id');
        registerEntityRoutes($group, '/objectives', ObjectivesController::class, 'id');
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
