<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;
use Slim\Routing\RouteContext;

/**
 * Ported from Auth/ProjectMemberAuthorizationHandler.cs — reads the route's {projectId} and checks it
 * against the JWT's "projects" claim, decoded once per request. Membership is embedded in the token
 * rather than re-queried from the DB (same trade-off as the .NET version: a membership change only
 * takes effect on that user's next login, not live) — see Services/ProjectService's create-project
 * JWT-reissue handling for the one place this trade-off is worked around deliberately.
 */
final class ProjectMemberMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $claims = $request->getAttribute('jwtClaims');
        if ($claims === null) {
            return $this->forbidden();
        }

        $route = RouteContext::fromRequest($request)->getRoute();
        $projectId = $route?->getArgument('projectId');
        if ($projectId === null) {
            return $this->forbidden();
        }

        $memberships = JwtService::parseProjectsClaim($claims);
        foreach ($memberships as $m) {
            if (strcasecmp((string) $m['ProjectId'], $projectId) === 0) {
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
