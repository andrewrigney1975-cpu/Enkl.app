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

    // A single comma-joined string, not a repeated/bracketed array query param — see
    // PortfolioController.cs's matching GetActivity for why (ASP.NET Core and Slim/PHP parse
    // array-shaped query strings differently, and the frontend talks to either tier unchanged).
    private function parseProjectIds(Request $request): array
    {
        $query = $request->getQueryParams();
        return array_values(array_filter(array_map('trim', explode(',', (string) ($query['projectIds'] ?? '')))));
    }
}
