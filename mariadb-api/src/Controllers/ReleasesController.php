<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ReleaseService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/ReleasesController.cs. */
final class ReleasesController extends BaseController
{
    private function service(): ReleaseService
    {
        return new ReleaseService(Database::connection());
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $args['id'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['projectId'], $args['id']) ? $this->noContent($response) : $this->notFound($response);
    }

    // ReleaseNotes is the Release Notes Packager's own admin-only field — gated by
    // ProjectAdminMiddleware on its own route sub-group in routes.php (which already means
    // "Project Admin OR Org Admin"), never writable via the generic update() action above.
    public function updateNotes(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $result = $this->service()->updateNotes($args['projectId'], $args['id'], $body['releaseNotes'] ?? null);
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
