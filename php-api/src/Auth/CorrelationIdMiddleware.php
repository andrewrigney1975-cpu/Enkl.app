<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Enkl\Api\Support\RequestContext;
use Enkl\Api\Support\Uuid;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * ARCHITECTURE-REVIEW.md finding #5, PHP-tier twin of Program.cs's correlation-ID middleware.
 * web/nginx.conf sets X-Correlation-Id to its own $request_id on every proxied request, so this just
 * reads that through; the Uuid::v4() fallback only fires if this API is ever hit directly, bypassing
 * nginx. Stashed via RequestContext (not a request attribute) so Log::channel() can stamp it onto
 * every log line without every call site threading the PSR-7 request through.
 *
 * Registered LAST in bootstrap.php's buildApp() (after addErrorMiddleware) so it's the OUTERMOST
 * middleware (Slim's stack is LIFO, same ordering convention as JwtAuthMiddleware/
 * SessionValidationMiddleware in routes.php) -- the ID must be established before the error
 * middleware runs, so an unhandled exception's log line still carries it.
 */
final class CorrelationIdMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $incoming = $request->getHeaderLine('X-Correlation-Id');
        $correlationId = $incoming !== '' ? $incoming : Uuid::v4();

        RequestContext::setCorrelationId($correlationId);

        return $handler->handle($request)->withHeader('X-Correlation-Id', $correlationId);
    }
}
