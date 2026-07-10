<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/** Rejects the request with 401 unless JwtAuthMiddleware (run first) found a valid token. */
final class RequireAuthMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if ($request->getAttribute('jwtClaims') === null) {
            $response = new Response(401);
            $response->getBody()->write(json_encode(['message' => 'Unauthorized.']));
            return $response->withHeader('Content-Type', 'application/json');
        }

        return $handler->handle($request);
    }
}
