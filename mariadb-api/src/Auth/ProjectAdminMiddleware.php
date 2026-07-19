<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Enkl\Api\Db\Database;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;
use Slim\Routing\RouteContext;

/**
 * Ported from Auth/ProjectAdminAuthorizationHandler.cs. Gates the Project Administrator role: adding/
 * editing/deleting columns, changing a project's App Settings, managing its Workflow, and managing
 * its team members (including who else is a Project Admin). Reads the route's {projectId} and checks
 * a LIVE "ProjectMembers" row for "IsProjectAdmin" = true — same live-check idiom
 * ProjectMemberMiddleware uses (ARCHITECTURE-REVIEW.md finding 2.4), not the JWT's "projects" claim
 * (which does carry an isProjectAdmin flag per entry, but only for the frontend's own client-side
 * "what to show" decisions, api.js's isProjectAdmin()) — a promotion/demotion takes effect on the
 * very next request rather than waiting for the next login/token refresh.
 *
 * An Org Admin also passes here even without a ProjectMembers row at all — Org Admins get every
 * Project Admin capability across their whole org's projects. The "orgAdmin" claim alone is never
 * trusted for this (same no-trust-the-client's-id-list rule as the Portfolio cross-org-isolation
 * pattern, CLAUDE.md §4): the project's own "OrganisationId" is re-queried live and compared against
 * the caller's "orgId" claim, so an Org Admin from a different org can't reach a project outside
 * their org this way.
 */
final class ProjectAdminMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $claims = $request->getAttribute('jwtClaims');
        if ($claims === null || !isset($claims->sub)) {
            return $this->forbidden();
        }

        $route = RouteContext::fromRequest($request)->getRoute();
        $projectId = $route?->getArgument('projectId');
        if ($projectId === null) {
            return $this->forbidden();
        }

        $stmt = Database::connection()->prepare(
            'SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid AND "IsProjectAdmin" = true'
        );
        $stmt->execute(['pid' => $projectId, 'uid' => (string) $claims->sub]);

        if ($stmt->fetch() !== false) {
            return $handler->handle($request);
        }

        if (($claims->orgAdmin ?? null) === 'true' && isset($claims->orgId)) {
            $orgStmt = Database::connection()->prepare(
                'SELECT 1 FROM "Projects" WHERE "Id" = :pid AND "OrganisationId" = :orgId'
            );
            $orgStmt->execute(['pid' => $projectId, 'orgId' => (string) $claims->orgId]);
            if ($orgStmt->fetch() !== false) {
                return $handler->handle($request);
            }
        }

        return $this->forbidden();
    }

    private function forbidden(): ResponseInterface
    {
        $response = new Response(403);
        $response->getBody()->write(json_encode(['message' => 'Project Administrator access required.']));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
