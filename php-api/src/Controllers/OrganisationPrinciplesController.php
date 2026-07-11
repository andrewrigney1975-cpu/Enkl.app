<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PrincipleService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/OrganisationPrinciplesController.cs. Any signed-in org member may
 * browse/copy the shared library (same trust level as TemplatesController's list/read) — sharing
 * itself is gated per-project via PrinciplesController::share (ProjectMember policy), not here. See
 * routes.php, which attaches RequireAuthMiddleware only, no OrgAdminMiddleware/ProjectMemberMiddleware.
 */
final class OrganisationPrinciplesController extends BaseController
{
    private function service(): PrincipleService
    {
        return new PrincipleService(Database::connection());
    }

    public function listWide(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->listOrganisationWide($this->callerOrgId($request)));
    }

    public function suggestions(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->getSuggestions($this->callerOrgId($request)));
    }

    public function copy(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->copy($this->callerOrgId($request), $args['principleId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
