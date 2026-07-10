<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ProjectService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/ProjectsController.cs. */
final class ProjectsController extends BaseController
{
    private function service(): ProjectService
    {
        return new ProjectService(Database::connection());
    }

    public function listMine(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->getProjectsForUser($this->callerUserId($request)));
    }

    public function detail(Request $request, Response $response, array $args): Response
    {
        $detail = $this->service()->getProjectDetail($args['projectId']);
        return $detail === null ? $this->notFound($response) : $this->json($response, $detail);
    }

    // No ProjectMember membership required — the project doesn't exist yet, so there's nothing for
    // that policy to check against. Any authenticated user may create a project under their own
    // Organisation (see routes.php: this route sits outside the {projectId} group).
    public function create(Request $request, Response $response): Response
    {
        $result = $this->service()->create($this->callerUserId($request), $this->body($request));
        return $result === null ? $this->json($response, ['message' => 'Unauthorized.'], 401) : $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['projectId']) ? $this->noContent($response) : $this->notFound($response);
    }

    public function updateSettings(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->updateSettings($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function updateWorkflow(Request $request, Response $response, array $args): Response
    {
        $raw = (string) $request->getBody();
        $workflow = $raw === '' ? null : json_decode($raw, true);
        $result = $this->service()->updateWorkflow($args['projectId'], $workflow);
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
