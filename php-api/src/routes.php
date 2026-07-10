<?php

declare(strict_types=1);

use Enkl\Api\Auth\JwtAuthMiddleware;
use Enkl\Api\Auth\OrgAdminMiddleware;
use Enkl\Api\Auth\ProjectMemberMiddleware;
use Enkl\Api\Auth\RequireAuthMiddleware;
use Enkl\Api\Controllers\AuthController;
use Enkl\Api\Controllers\ColumnsController;
use Enkl\Api\Controllers\DecisionsController;
use Enkl\Api\Controllers\DocumentsController;
use Enkl\Api\Controllers\EventsController;
use Enkl\Api\Controllers\MembersController;
use Enkl\Api\Controllers\MigrationController;
use Enkl\Api\Controllers\ObjectivesController;
use Enkl\Api\Controllers\OrganisationsController;
use Enkl\Api\Controllers\PrinciplesController;
use Enkl\Api\Controllers\ProjectsController;
use Enkl\Api\Controllers\ReleasesController;
use Enkl\Api\Controllers\RisksController;
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
    $app->add(JwtAuthMiddleware::class);

    $app->get('/health', function ($request, $response) {
        $response->getBody()->write(json_encode(['status' => 'ok']));
        return $response->withHeader('Content-Type', 'application/json');
    });

    // ---- Auth ----
    $app->post('/api/auth/login', [AuthController::class, 'login']);
    $app->post('/api/auth/change-password', [AuthController::class, 'changePassword'])
        ->add(RequireAuthMiddleware::class);

    // ---- Migration (deliberately anonymous — bootstrapping, see MigrationController.cs's own note) ----
    $app->post('/api/migration/projects', [MigrationController::class, 'migrate']);

    // ---- Organisations (OrgAdmin only) ----
    $app->group('/api/organisations/me', function ($group) {
        $group->get('', [OrganisationsController::class, 'getMyOrganisation']);
        $group->put('/users/{userId}/admin', [OrganisationsController::class, 'setUserAdmin']);
        $group->put('/users/{userId}/email', [OrganisationsController::class, 'setUserEmail']);
        $group->post('/users', [OrganisationsController::class, 'createUser']);
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
        registerEntityRoutes($group, '/documents', DocumentsController::class, 'id');
        registerEntityRoutes($group, '/risks', RisksController::class, 'id');
        registerEntityRoutes($group, '/objectives', ObjectivesController::class, 'id');
        registerEntityRoutes($group, '/teams-committees', TeamsCommitteesController::class, 'id');
        registerEntityRoutes($group, '/decisions', DecisionsController::class, 'id');
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
