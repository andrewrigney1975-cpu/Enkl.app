<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\MigrationService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/MigrationController.cs. Anonymous deliberately — see routes.php: this is
 * the only mutating endpoint outside RequireAuthMiddleware's enforcement, because the very first
 * migration creates the first Organisation and User accounts, so there's no one to authenticate as
 * yet. JwtAuthMiddleware still runs on every route though (see routes.php), so if a valid Bearer
 * token IS present its orgId claim is passed through — mirrors MigrationController.cs exactly, so a
 * signed-in user migrating an additional local project always lands in their own Organisation. See
 * MigrationService::resolveOrganisation for why an anonymous caller can no longer target an existing
 * org by name (security review finding C3: that was an unauthenticated cross-tenant
 * account-injection vector).
 */
final class MigrationController extends BaseController
{
    public function migrate(Request $request, Response $response): Response
    {
        $claims = $request->getAttribute('jwtClaims');
        $callerOrgId = ($claims !== null && isset($claims->orgId)) ? (string) $claims->orgId : null;

        $service = new MigrationService(Database::connection());
        $result = $service->migrate($this->body($request), $callerOrgId);
        return $this->json($response, $result);
    }
}
