<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Auth\ApiKeyAuthMiddleware;
use Enkl\Api\Services\PublicQueryExecutionService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/PublicQueryController.cs. The app's first public/3rd-party-facing API
 * surface — see that file's own note on the deliberate /api/public/v1/ namespace/versioning and the
 * [AllowAnonymous]-equivalent reasoning (auth here is ApiKeyAuthMiddleware, not a user JWT — this
 * route is registered in routes.php WITHOUT JwtAuthMiddleware's usual RequireAuthMiddleware pairing).
 */
final class PublicQueryController extends BaseController
{
    public function getResults(Request $request, Response $response): Response
    {
        $query = $request->getAttribute(ApiKeyAuthMiddleware::SAVED_QUERY_ATTRIBUTE);
        $result = (new PublicQueryExecutionService())->execute($query['ProjectId'], $query['Sql']);
        return $this->json($response, $result);
    }
}
