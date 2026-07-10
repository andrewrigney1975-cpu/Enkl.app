<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/** Ported from the "OrgAdmin" policy in Program.cs — requires the JWT's orgAdmin claim === "true". */
final class OrgAdminMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $claims = $request->getAttribute('jwtClaims');
        if ($claims === null || ($claims->orgAdmin ?? null) !== 'true') {
            $response = new Response(403);
            $response->getBody()->write(json_encode(['message' => 'Organisation admin access required.']));
            return $response->withHeader('Content-Type', 'application/json');
        }

        return $handler->handle($request);
    }
}
