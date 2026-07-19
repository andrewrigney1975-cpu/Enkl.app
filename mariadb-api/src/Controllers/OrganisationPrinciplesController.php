<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PrincipleService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/OrganisationPrinciplesController.cs. Any signed-in org member may browse
 * the shared library (same trust level as TemplatesController's list/read) — sharing itself is
 * gated per-project via PrinciplesController::share (ProjectMember policy), not here. Copy is
 * different: it WRITES a new Principle into a specific project, so unlike the read-only endpoints
 * above, it also requires the caller to actually be a member of the target project (security review
 * finding M9) — this route isn't under a {projectId} route segment (targetProjectId lives in the
 * request body instead), so ProjectMemberMiddleware's usual route-based check can't apply here; a
 * live DB check (ARCHITECTURE-REVIEW.md finding 2.4 — see ProjectMemberMiddleware's own doc comment
 * for why a live check replaced the stale JWT "projects" claim) is done manually below instead, same
 * reasoning, just without a route-based middleware to hook into. See routes.php, which attaches
 * RequireAuthMiddleware only, no OrgAdminMiddleware/ProjectMemberMiddleware.
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
        $body = $this->body($request);
        $targetProjectId = (string) ($body['targetProjectId'] ?? '');

        $claims = $request->getAttribute('jwtClaims');
        $isMember = false;
        if ($targetProjectId !== '' && $claims !== null && isset($claims->sub)) {
            $stmt = Database::connection()->prepare(
                'SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid'
            );
            $stmt->execute(['pid' => $targetProjectId, 'uid' => (string) $claims->sub]);
            $isMember = $stmt->fetch() !== false;
        }
        if (!$isMember) {
            return $this->json($response, ['message' => 'You are not a member of this project.'], 403);
        }

        $result = $this->service()->copy($this->callerOrgId($request), $args['principleId'], $body);
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
