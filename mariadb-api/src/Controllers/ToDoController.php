<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ToDoService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/ToDoController.cs. Per-User resource, not per-Project/per-Organisation —
 * routes.php only attaches RequireAuthMiddleware here, no ProjectMemberMiddleware/OrgAdminMiddleware.
 */
final class ToDoController extends BaseController
{
    private function service(): ToDoService
    {
        return new ToDoService(Database::connection());
    }

    public function list(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->list($this->callerUserId($request)));
    }

    public function create(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->createList($this->callerUserId($request), $this->body($request)));
    }

    public function rename(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->renameList($this->callerUserId($request), $args['listId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->deleteList($this->callerUserId($request), $args['listId']) ? $this->noContent($response) : $this->notFound($response);
    }

    public function createItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->createItem($this->callerUserId($request), $args['listId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function updateItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->updateItem($this->callerUserId($request), $args['listId'], $args['itemId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function deleteItem(Request $request, Response $response, array $args): Response
    {
        return $this->service()->deleteItem($this->callerUserId($request), $args['listId'], $args['itemId']) ? $this->noContent($response) : $this->notFound($response);
    }
}
