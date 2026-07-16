<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Enkl\Api\Support\Log;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * ARCHITECTURE-REVIEW.md finding #5, PHP-tier twin of Program.cs's UseSerilogRequestLogging() call --
 * one structured line per request (method/path/status/duration), via Log::channel() so it's stamped
 * with the correlation ID set by CorrelationIdMiddleware, which runs further out and so has already
 * set it by the time this runs.
 *
 * Registered in bootstrap.php's buildApp() between addErrorMiddleware() and CorrelationIdMiddleware,
 * so at runtime it sits between them too (Slim's stack is LIFO): it observes the response AFTER
 * error-middleware processing, so a 500/409 the error handler produces is what actually gets logged,
 * not whatever status was set before an exception was thrown.
 */
final class RequestLoggingMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $startedAt = microtime(true);
        $response = $handler->handle($request);
        $durationMs = (int) round((microtime(true) - $startedAt) * 1000);

        Log::channel()->info('request completed', [
            'method' => $request->getMethod(),
            'path' => $request->getUri()->getPath(),
            'status' => $response->getStatusCode(),
            'durationMs' => $durationMs,
        ]);

        return $response;
    }
}
