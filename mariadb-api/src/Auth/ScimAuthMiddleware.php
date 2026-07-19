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
 * Ported from Auth/ScimAuthFilter.cs. Gates every SCIM action behind a static, per-Organisation
 * bearer token — not a user JWT, so this is applied in routes.php INSTEAD OF
 * JwtAuthMiddleware/RequireAuthMiddleware for the SCIM route group, not alongside them. No existing
 * ApiKey/service-account pattern exists elsewhere in this codebase to extend (confirmed during the
 * .NET build of this same feature). Every response here uses the SCIM error envelope, not the
 * app's usual {message} shape, since these responses are read by SCIM clients, not this app's UI.
 * Route args aren't available yet at the middleware layer (only inside a controller action's
 * $args) — RouteContext::fromRequest() is the same idiom ProjectMemberMiddleware.php already uses
 * to read {projectId} this early.
 */
final class ScimAuthMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $orgId = RouteContext::fromRequest($request)->getRoute()?->getArgument('orgId');
        if ($orgId === null) {
            return $this->scimError(404, 'Organisation not found.');
        }

        $authHeader = $request->getHeaderLine('Authorization');
        if (stripos($authHeader, 'bearer ') !== 0) {
            return $this->scimError(401, 'Missing bearer token.');
        }
        $token = trim(substr($authHeader, 7));
        if ($token === '') {
            return $this->scimError(401, 'Missing bearer token.');
        }

        $stmt = Database::connection()->prepare(
            'SELECT "ScimEnabled", "ScimBearerTokenHash" FROM "OrganisationSsoConfigs" WHERE "OrganisationId" = :id'
        );
        $stmt->execute(['id' => $orgId]);
        $cfg = $stmt->fetch();

        if ($cfg === false || !(bool) $cfg['ScimEnabled'] || empty($cfg['ScimBearerTokenHash']) ||
            !PasswordHasher::verify($token, $cfg['ScimBearerTokenHash'])) {
            return $this->scimError(401, 'Invalid bearer token.');
        }

        // Security review (Low/Informational finding): usage audit trail for a rotate-only token —
        // see 012_add_scim_token_last_used_at.sql's own note.
        Database::connection()
            ->prepare('UPDATE "OrganisationSsoConfigs" SET "ScimTokenLastUsedAt" = now() WHERE "OrganisationId" = :id')
            ->execute(['id' => $orgId]);

        return $handler->handle($request);
    }

    private function scimError(int $status, string $detail): ResponseInterface
    {
        $response = new Response($status);
        $response->getBody()->write(json_encode([
            'schemas' => ['urn:ietf:params:scim:api:messages:2.0:Error'],
            'status' => (string) $status,
            'detail' => $detail,
        ]));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
