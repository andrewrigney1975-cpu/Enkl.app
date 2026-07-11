<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PrincipleService;
use Enkl\Api\Services\RetrospectiveService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/RetrospectivesController.cs. */
final class RetrospectivesController extends BaseController
{
    private function service(): RetrospectiveService
    {
        $db = Database::connection();
        return new RetrospectiveService($db, new PrincipleService($db));
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

    public function createItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->createItem($args['projectId'], $args['id'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function updateItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->updateItem($args['projectId'], $args['id'], $args['itemId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function deleteItem(Request $request, Response $response, array $args): Response
    {
        return $this->service()->deleteItem($args['projectId'], $args['id'], $args['itemId']) ? $this->noContent($response) : $this->notFound($response);
    }

    public function promoteItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->promoteItem($args['projectId'], $args['id'], $args['itemId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function createActionItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->createActionItem($args['projectId'], $args['id'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function updateActionItem(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->updateActionItem($args['projectId'], $args['id'], $args['itemId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function deleteActionItem(Request $request, Response $response, array $args): Response
    {
        return $this->service()->deleteActionItem($args['projectId'], $args['id'], $args['itemId']) ? $this->noContent($response) : $this->notFound($response);
    }
}
