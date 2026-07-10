<?php

declare(strict_types=1);

use Enkl\Api\Config\Config;
use Enkl\Api\Db\Database;
use Enkl\Api\Db\Migrator;
use Enkl\Api\Validation\ApiValidationException;
use Slim\Factory\AppFactory;
use Slim\Psr7\Response;

/**
 * Builds and returns the configured Slim App — shared by public/index.php (the real HTTP entry
 * point) and any CLI tooling (migrate.php) that needs the same DB/config wiring without booting a
 * web server.
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

    // Global exception -> JSON envelope, mirroring Program.cs's UseExceptionHandler exactly:
    // ApiValidationException -> 400 with its message shown as-is (expected input rejection, not a
    // bug); a DB constraint violation -> 409; anything else -> 500 with a generic message that never
    // leaks internals.
    $errorMiddleware = $app->addErrorMiddleware(
        Config::get('APP_ENV', 'production') === 'development',
        true,
        true
    );
    $errorMiddleware->setDefaultErrorHandler(function (
        \Psr\Http\Message\ServerRequestInterface $request,
        \Throwable $exception,
        bool $displayErrorDetails
    ) use ($app): \Psr\Http\Message\ResponseInterface {
        $response = new Response();

        if ($exception instanceof ApiValidationException) {
            $response->getBody()->write(json_encode(['message' => $exception->getMessage()]));
            return $response->withHeader('Content-Type', 'application/json')->withStatus(400);
        }

        if ($exception instanceof PDOException && isConstraintViolation($exception)) {
            $response->getBody()->write(json_encode(['message' => 'This change conflicts with existing data.']));
            return $response->withHeader('Content-Type', 'application/json')->withStatus(409);
        }

        error_log('[Enkl PHP API] Unhandled exception: ' . $exception->getMessage() . "\n" . $exception->getTraceAsString());

        $response->getBody()->write(json_encode(['message' => 'An unexpected error occurred. Please try again.']));
        return $response->withHeader('Content-Type', 'application/json')->withStatus(500);
    });

    return $app;
}

function isConstraintViolation(PDOException $e): bool
{
    // SQLSTATE class 23 = integrity constraint violation (unique, FK, not-null, check).
    return str_starts_with((string) $e->getCode(), '23');
}

function runMigrationsWithLogging(): void
{
    $migrator = new Migrator(Database::connection(), __DIR__ . '/Db/migrations');
    $applied = $migrator->run();
    if ($applied !== []) {
        error_log('[Enkl PHP API] Applied migrations: ' . implode(', ', $applied));
    }
}
