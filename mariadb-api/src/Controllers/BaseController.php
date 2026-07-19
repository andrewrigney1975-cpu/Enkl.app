<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Validation\ApiValidationException;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response;

abstract class BaseController
{
    protected function callerUserId(ServerRequestInterface $request): string
    {
        $claims = $request->getAttribute('jwtClaims');
        if ($claims === null || !isset($claims->sub)) {
            throw new ApiValidationException('Missing authentication.');
        }
        return (string) $claims->sub;
    }

    protected function callerOrgId(ServerRequestInterface $request): string
    {
        $claims = $request->getAttribute('jwtClaims');
        if ($claims === null || !isset($claims->orgId)) {
            throw new ApiValidationException('Missing authentication.');
        }
        return (string) $claims->orgId;
    }

    protected function callerDisplayName(ServerRequestInterface $request): ?string
    {
        $claims = $request->getAttribute('jwtClaims');
        return $claims->displayName ?? null;
    }

    /** @param mixed $data */
    protected function json(ResponseInterface $response, mixed $data, int $status = 200): ResponseInterface
    {
        $response->getBody()->write(json_encode($data, JSON_UNESCAPED_SLASHES));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }

    protected function noContent(ResponseInterface $response): ResponseInterface
    {
        return $response->withStatus(204);
    }

    protected function notFound(ResponseInterface $response): ResponseInterface
    {
        return $this->json($response, ['message' => 'Not found.'], 404);
    }

    /** Decodes the JSON request body into an assoc array, defaulting missing/absent keys to null via the caller. */
    protected function body(ServerRequestInterface $request): array
    {
        $raw = (string) $request->getBody();
        if ($raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }
}
