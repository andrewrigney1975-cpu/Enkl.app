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
 * Ported from Auth/ApiKeyAuthFilter.cs. Gates PublicQueryController behind a static,
 * per-Organisation bearer token — same shape as ScimAuthMiddleware (not a user JWT, applied INSTEAD
 * OF JwtAuthMiddleware/RequireAuthMiddleware for this route).
 *
 * Every failure mode here — savedQueryId doesn't exist, the query exists but ExposeViaApi=false,
 * the key is missing/wrong/disabled, or the key belongs to a different org than the query's project
 * — returns the IDENTICAL 404, per this codebase's standing no-enumeration-oracle rule.
 *
 * On success, the resolved SavedQuery row is attached to the request as an attribute so
 * PublicQueryController doesn't need a second lookup.
 */
final class ApiKeyAuthMiddleware implements MiddlewareInterface
{
    public const SAVED_QUERY_ATTRIBUTE = 'publicQuery.savedQuery';

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $savedQueryId = RouteContext::fromRequest($request)->getRoute()?->getArgument('savedQueryId');
        if ($savedQueryId === null) {
            return $this->notFound();
        }

        $authHeader = $request->getHeaderLine('Authorization');
        if (stripos($authHeader, 'bearer ') !== 0) {
            return $this->notFound();
        }
        $apiKey = trim(substr($authHeader, 7));
        if ($apiKey === '') {
            return $this->notFound();
        }

        $db = Database::connection();
        $stmt = $db->prepare(
            'SELECT q.*, p."OrganisationId" AS "OrganisationId" FROM "SavedQueries" q ' .
            'JOIN "Projects" p ON p."Id" = q."ProjectId" WHERE q."Id" = :id'
        );
        $stmt->execute(['id' => $savedQueryId]);
        $query = $stmt->fetch();

        if ($query === false || !(bool) $query['ExposeViaApi']) {
            return $this->notFound();
        }

        $organisationId = $query['OrganisationId'];
        $keyStmt = $db->prepare('SELECT * FROM "OrganisationApiKeys" WHERE "OrganisationId" = :id');
        $keyStmt->execute(['id' => $organisationId]);
        $orgKey = $keyStmt->fetch();

        if ($orgKey === false || !(bool) $orgKey['Enabled'] || empty($orgKey['KeyHash']) ||
            !PasswordHasher::verify($apiKey, $orgKey['KeyHash'])) {
            return $this->notFound();
        }

        // Lightweight usage audit trail, same convention/rationale as ScimTokenLastUsedAt.
        $db->prepare('UPDATE "OrganisationApiKeys" SET "LastUsedAt" = now() WHERE "OrganisationId" = :id')
            ->execute(['id' => $organisationId]);

        return $handler->handle($request->withAttribute(self::SAVED_QUERY_ATTRIBUTE, $query));
    }

    private function notFound(): ResponseInterface
    {
        $response = new Response(404);
        $response->getBody()->write(json_encode(['message' => 'Not found.']));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
