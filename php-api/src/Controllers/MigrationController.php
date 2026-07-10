<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\MigrationService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/MigrationController.cs. Anonymous deliberately — see routes.php: this is
 * the only mutating endpoint outside JwtAuthMiddleware's enforcement, because the very first
 * migration creates the first Organisation and User accounts, so there's no one to authenticate as
 * yet.
 */
final class MigrationController extends BaseController
{
    public function migrate(Request $request, Response $response): Response
    {
        $service = new MigrationService(Database::connection());
        $result = $service->migrate($this->body($request));
        return $this->json($response, $result);
    }
}
