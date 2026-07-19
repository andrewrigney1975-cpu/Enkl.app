<?php

declare(strict_types=1);

use Slim\App;

/**
 * Phase 1/scaffolding note: minimal placeholder — just the health check, so this tier is runnable
 * and its migrations/DB connectivity testable via `php -S ... -t public` before Phase 2 ports every
 * Controller and expands this file to the full route table (mirroring php-api/src/routes.php's own
 * shape, which has no Postgres-specific logic to change at all beyond the routes it registers).
 */
function registerRoutes(App $app): void
{
    $app->get('/health', function ($request, $response) {
        $response->getBody()->write(json_encode(['status' => 'ok']));
        return $response->withHeader('Content-Type', 'application/json');
    });
}
