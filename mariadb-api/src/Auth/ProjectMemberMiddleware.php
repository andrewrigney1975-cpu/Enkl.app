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
 * ARCHITECTURE-REVIEW.md finding 2.4 (.NET tier), ported here: reads the route's {projectId} and
 * checks it against a LIVE "ProjectMembers" row, not the JWT's baked-in "projects" claim — that claim
 * is minted once at login and never re-queried, so removing a user from a project used to have no
 * effect until their token expired/they logged in again (up to the full 8h JWT lifetime), a real
 * staleness window for a governance tool where offboarding access changes are sometimes urgent. This
 * mirrors the same "server-side re-validation, never trust the client's embedded claim" idiom the
 * cross-org-isolation pattern already establishes elsewhere in this codebase — the JWT is still
 * trusted for WHO the caller is (the "sub" claim, checked elsewhere), just not for what they're
 * currently a member of.
 *
 * This was previously a pure claim check (this file's own prior revision, and still how
 * `ProjectClaim.Role`/`.IsProjectAdmin` are minted for the frontend's own client-side "what to show"
 * decisions — see api.js's isProjectAdmin()) — fixed here to close the drift against the .NET tier's
 * already-live-checked ProjectMemberAuthorizationHandler.cs.
 *
 * An Org Admin also passes here even without a ProjectMembers row at all — a Project Admin is
 * inherently also a project member (IsProjectAdmin is a column ON the ProjectMembers row), so an Org
 * Admin who gets full Project Admin capabilities (see ProjectAdminMiddleware) needs this same bypass
 * or they'd never reach those admin-gated routes to begin with (columns/members are nested under this
 * ProjectMember-gated group in routes.php). Same live re-verification against the project's own
 * "OrganisationId" as ProjectAdminMiddleware — never just trusting the "orgAdmin" claim.
 */
final class ProjectMemberMiddleware implements MiddlewareInterface
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
            'SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid'
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
        $response->getBody()->write(json_encode(['message' => 'You are not a member of this project.']));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
