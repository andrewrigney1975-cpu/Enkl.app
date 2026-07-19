<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Equivalent of ASP.NET's app.UseAuthentication() + [Authorize] — validates the Bearer token (if
 * present) and stashes the decoded claims as a request attribute ("jwtClaims") for downstream
 * middleware/controllers to read. Unlike ASP.NET's model, Slim has no built-in claims-principal
 * concept, so every controller that needs "who is the caller" reads Request::getAttribute('jwtClaims')
 * directly (see Controllers/*Controller.php's callerUserId()/callerOrgId() helpers).
 *
 * Routes that need auth at all wrap this with RequireAuthMiddleware (401 if no valid token); routes
 * that are genuinely public (health check, login, the anonymous migration bootstrap) skip both.
 */
final class JwtAuthMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $header = $request->getHeaderLine('Authorization');
        if (str_starts_with($header, 'Bearer ')) {
            $token = substr($header, 7);
            $claims = JwtService::tryDecode($token);
            if ($claims !== null) {
                $request = $request->withAttribute('jwtClaims', $claims);
            }
        }

        return $handler->handle($request);
    }
}
