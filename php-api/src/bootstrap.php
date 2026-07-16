<?php

declare(strict_types=1);

use Enkl\Api\Auth\CorrelationIdMiddleware;
use Enkl\Api\Auth\RequestLoggingMiddleware;
use Enkl\Api\Config\Config;
use Enkl\Api\Db\Database;
use Enkl\Api\Db\Migrator;
use Enkl\Api\Support\Log;
use Enkl\Api\Support\RequestContext;
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
    assertProductionSecretsAreSet();

    $app = AppFactory::create();
    $app->addBodyParsingMiddleware();

    // Security review finding M6: defense-in-depth in case this tier is ever reached directly
    // without nginx in front (which carries the fuller header set, including a CSP — see
    // web/nginx.conf's own comment, and Program.cs's equivalent for the .NET tier). Every response
    // here is JSON, never HTML/JS, so no CSP is needed at this layer.
    $app->add(function (\Psr\Http\Message\ServerRequestInterface $request, \Psr\Http\Server\RequestHandlerInterface $handler): \Psr\Http\Message\ResponseInterface {
        return $handler->handle($request)
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('X-Frame-Options', 'DENY')
            ->withHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    });

    // Security review (Low/Informational finding): no CORS configuration exists anywhere in this
    // codebase, .NET side included. Already safe by default — this tier is only ever reached through
    // nginx in the same origin as the frontend, so a cross-origin browser request is already blocked
    // by the browser's own same-origin policy with no Access-Control-Allow-Origin header present —
    // Slim (unlike ASP.NET Core) has no implicit CORS behavior to begin with, so there's nothing to
    // register here to make that explicit the way Program.cs's AddCors/UseCors call does; this
    // comment is the parity note. Would need explicit configuration if this API is ever consumed
    // from a different origin.

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

        Log::channel()->error('Unhandled exception', [
            'exceptionClass' => get_class($exception),
            'message' => $exception->getMessage(),
            'trace' => $exception->getTraceAsString(),
        ]);

        $response->getBody()->write(json_encode([
            'message' => 'An unexpected error occurred. Please try again.',
            'correlationId' => RequestContext::getCorrelationId(),
        ]));
        return $response->withHeader('Content-Type', 'application/json')->withStatus(500);
    });

    // ARCHITECTURE-REVIEW.md finding #5. Added LAST (after addErrorMiddleware above) so, per Slim's
    // LIFO middleware stack (last add() = outermost = runs first -- same convention documented on
    // JwtAuthMiddleware/SessionValidationMiddleware in routes.php), the runtime order is:
    // CorrelationIdMiddleware (outermost, sets the ID before anything else runs) -> RequestLogging
    // Middleware (sees the true final status, including ones the error middleware above produces) ->
    // the error middleware -> routes/JwtAuth/SessionValidation -> the route handler. This mirrors
    // Program.cs's correlation-middleware -> UseSerilogRequestLogging -> UseExceptionHandler ordering.
    $app->add(RequestLoggingMiddleware::class);
    $app->add(new CorrelationIdMiddleware());

    return $app;
}

/**
 * Defense-in-depth against the checked-in .env.example placeholders ever reaching a real
 * deployment — mirrors api/Enkl.Api/Program.cs's equivalent startup guard exactly. Config::get()
 * already silently falls back to '' for an unset JWT_SIGNING_KEY (see Config::get's own doc
 * comment), which would otherwise let firebase/php-jwt sign/verify tokens with an empty key.
 * Skipped entirely in APP_ENV=development, the same "zero-setup local run" exemption as the
 * .NET side's IsDevelopment() check.
 */
function assertProductionSecretsAreSet(): void
{
    if (Config::get('APP_ENV', 'production') === 'development') {
        return;
    }

    $signingKey = Config::get('JWT_SIGNING_KEY', '') ?? '';
    $placeholderSigningKey = 'change-me-to-a-random-32-plus-character-string';
    if ($signingKey === '' || $signingKey === $placeholderSigningKey || strlen($signingKey) < 32) {
        throw new \RuntimeException(
            'JWT_SIGNING_KEY is missing, is the checked-in .env.example placeholder, or is shorter ' .
            'than 32 characters. Set a real, random JWT_SIGNING_KEY before starting outside APP_ENV=development.'
        );
    }

    $dbPassword = Config::get('DB_PASSWORD', '') ?? '';
    if ($dbPassword === '' || $dbPassword === 'change-me') {
        throw new \RuntimeException(
            'DB_PASSWORD is missing or is the checked-in .env.example placeholder. Set a real ' .
            'DB_PASSWORD before starting outside APP_ENV=development.'
        );
    }
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
        Log::channel()->info('Applied migrations', ['migrations' => $applied]);
    }
}
