<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PortfolioService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/PortfolioController.cs. Backs the Org-Admin-only Portfolio Dashboard —
 * gated by OrgAdminMiddleware ONLY (no ProjectMemberMiddleware — see routes.php), since an admin
 * reviewing their organisation's portfolio may not personally belong to every project in it. See
 * PortfolioService's own doc comment for the cross-org isolation guarantee every action here relies
 * on.
 */
final class PortfolioController extends BaseController
{
    private function service(): PortfolioService
    {
        return new PortfolioService(Database::connection());
    }

    public function listProjects(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->listProjects($this->callerOrgId($request)));
    }

    // A genuine mutation (creates a row), so this stays POST — unlike listProjects/getAggregate/
    // getActivity above, there's no read-with-side-effects tension here to work around.
    public function createProject(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        return $this->json($response, $this->service()->createProject($this->callerOrgId($request), $body));
    }

    // GET (not POST) even though this returns a computed, possibly-large payload: it's a pure read
    // with no side effects, and POST here would have tripped SessionValidationMiddleware's global
    // MustChangePassword gate, which blocks every mutating (POST/PUT/PATCH/DELETE) request — wrongly
    // barring a freshly-migrated Org Admin (MustChangePassword defaults true) from ever opening the
    // Portfolio Dashboard until they changed their password, even though nothing here mutates
    // anything. See PortfolioController.cs's matching GetAggregate for the .NET side of this same fix.
    public function getAggregate(Request $request, Response $response): Response
    {
        $projectIds = $this->parseProjectIds($request);
        return $this->json($response, $this->service()->getAggregate($this->callerOrgId($request), $projectIds));
    }

    public function getActivity(Request $request, Response $response): Response
    {
        $query = $request->getQueryParams();
        $projectIds = $this->parseProjectIds($request);
        $start = (string) ($query['start'] ?? '');
        $end = (string) ($query['end'] ?? '');
        return $this->json($response, $this->service()->getActivity($this->callerOrgId($request), $projectIds, $start, $end));
    }

    // A genuine mutation (unlike getAggregate/getActivity above), so this deliberately stays PUT —
    // it's meant to trip SessionValidationMiddleware's global MustChangePassword gate like any other
    // write, unlike the two GET actions above which were specifically routed around it.
    public function updateProjectDates(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $updated = $this->service()->updateProjectDates(
            $this->callerOrgId($request), $args['projectId'],
            $body['startDate'] ?? null, $body['endDate'] ?? null
        );
        return $updated ? $this->noContent($response) : $this->notFound($response);
    }

    public function updateProjectActive(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $result = $this->service()->updateProjectActive($this->callerOrgId($request), $args['projectId'], (bool) ($body['isActive'] ?? false));
        return match ($result) {
            'not_found' => $this->notFound($response),
            'missing_dates' => $this->json($response, ['message' => 'A project must have both a start and end date before it can be activated.'], 400),
            default => $this->noContent($response),
        };
    }

    public function updateProjectCategory(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $updated = $this->service()->updateProjectCategory($this->callerOrgId($request), $args['projectId'], $body['categoryId'] ?? null);
        return $updated ? $this->noContent($response) : $this->notFound($response);
    }

    public function listCategories(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->listCategories($this->callerOrgId($request)));
    }

    public function createCategory(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        return $this->json($response, $this->service()->createCategory($this->callerOrgId($request), (string) ($body['name'] ?? '')));
    }

    public function updateCategory(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $updated = $this->service()->updateCategory($this->callerOrgId($request), $args['categoryId'], (string) ($body['name'] ?? ''));
        return $updated !== null ? $this->json($response, $updated) : $this->notFound($response);
    }

    public function deleteCategory(Request $request, Response $response, array $args): Response
    {
        $deleted = $this->service()->deleteCategory($this->callerOrgId($request), $args['categoryId']);
        return $deleted ? $this->noContent($response) : $this->notFound($response);
    }

    public function updateCategorySortOrder(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $updated = $this->service()->updateCategorySortOrder($this->callerOrgId($request), $args['categoryId'], (int) ($body['sortOrder'] ?? 0));
        return $updated ? $this->noContent($response) : $this->notFound($response);
    }

    public function listResources(Request $request, Response $response, array $args): Response
    {
        $resources = $this->service()->listResources($this->callerOrgId($request), $args['projectId']);
        return $resources !== null ? $this->json($response, $resources) : $this->notFound($response);
    }

    public function addResource(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $resource = $this->service()->addResource($this->callerOrgId($request), $args['projectId'], $body);
        return $resource !== null ? $this->json($response, $resource) : $this->notFound($response);
    }

    public function updateResource(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $resource = $this->service()->updateResource($this->callerOrgId($request), $args['projectId'], $args['resourceId'], $body);
        return $resource !== null ? $this->json($response, $resource) : $this->notFound($response);
    }

    public function removeResource(Request $request, Response $response, array $args): Response
    {
        $removed = $this->service()->removeResource($this->callerOrgId($request), $args['projectId'], $args['resourceId']);
        return $removed ? $this->noContent($response) : $this->notFound($response);
    }

    public function listRoles(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->listDistinctRoles($this->callerOrgId($request)));
    }

    // GET, not POST — a pure read with no side effects, same MustChangePassword-gate-avoidance
    // reasoning as getAggregate/getActivity above. Deliberately takes no project ids at all — see
    // PortfolioService::getResourcingSummary's doc comment for why this is org-wide.
    public function getResourcingSummary(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->getResourcingSummary($this->callerOrgId($request)));
    }

    // A single comma-joined string, not a repeated/bracketed array query param — see
    // PortfolioController.cs's matching GetActivity for why (ASP.NET Core and Slim/PHP parse
    // array-shaped query strings differently, and the frontend talks to either tier unchanged).
    private function parseProjectIds(Request $request): array
    {
        $query = $request->getQueryParams();
        return array_values(array_filter(array_map('trim', explode(',', (string) ($query['projectIds'] ?? '')))));
    }
}
