<?php

declare(strict_types=1);

use Enkl\Api\Config\Config;
use Enkl\Api\Db\Database;
use Enkl\Api\Db\Migrator;
use Slim\Factory\AppFactory;

/**
 * Builds and returns the configured Slim App — shared by public/index.php (the real HTTP entry
 * point) and any CLI tooling (migrate.php) that needs the same DB/config wiring without booting a
 * web server. Ported from php-api/src/bootstrap.php.
 *
 * Phase 1/scaffolding note: this is deliberately a MINIMAL version for now — just enough to run
 * migrations and serve a health check — since the security headers/error-handling/correlation-id/
 * request-logging middleware this function will gain in Phase 2 all depend on Auth/Support/
 * Validation classes that haven't been ported into this tier yet. Phase 2 replaces this function's
 * body with the full php-api-equivalent shape (which has no Postgres-specific logic to change at
 * all) once those classes exist.
 */
function buildApp(): \Slim\App
{
    $app = AppFactory::create();
    $app->addBodyParsingMiddleware();

    if (Config::getBool('RUN_MIGRATIONS_ON_STARTUP', true)) {
        runMigrationsWithLogging();
    }

    require_once __DIR__ . '/routes.php';
    registerRoutes($app);

    $app->addErrorMiddleware(
        Config::get('APP_ENV', 'production') === 'development',
        true,
        true
    );

    return $app;
}

function runMigrationsWithLogging(): void
{
    $migrator = new Migrator(Database::connection(), __DIR__ . '/Db/migrations');
    $applied = $migrator->run();
    if ($applied !== []) {
        error_log('Applied migrations: ' . implode(', ', $applied));
    }
}
