<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ScimGroupService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/ScimGroupsController.cs. SCIM 2.0 Groups endpoint for one Organisation
 * — same ScimAuthMiddleware bearer-token gating as ScimUsersController; see that controller's own
 * comment for the rationale. */
final class ScimGroupsController extends BaseController
{
    private function service(): ScimGroupService
    {
        return new ScimGroupService(Database::connection());
    }

    public function list(Request $request, Response $response, array $args): Response
    {
        $query = $request->getQueryParams();
        $filter = $query['filter'] ?? null;
        $startIndex = isset($query['startIndex']) ? (int) $query['startIndex'] : 1;
        $count = isset($query['count']) ? (int) $query['count'] : 100;
        return $this->json($response, $this->service()->list($args['orgId'], $filter, $startIndex, $count));
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->get($args['orgId'], $args['id']);
        return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['orgId'], $this->body($request));
        return $this->json($response, $result, 201);
    }

    public function replace(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->replace($args['orgId'], $args['id'], $this->body($request));
        return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
    }

    public function patch(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->patch($args['orgId'], $args['id'], $this->body($request));
        return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['orgId'], $args['id']) ? $this->noContent($response) : $this->scimNotFound($response);
    }

    private function scimNotFound(Response $response): Response
    {
        return $this->json($response, [
            'schemas' => ['urn:ietf:params:scim:api:messages:2.0:Error'],
            'status' => '404',
            'detail' => 'Group not found.',
        ], 404);
    }
}
