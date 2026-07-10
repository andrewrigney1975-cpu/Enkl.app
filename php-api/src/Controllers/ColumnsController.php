<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ColumnService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/ColumnsController.cs. */
final class ColumnsController extends BaseController
{
    private function service(): ColumnService
    {
        return new ColumnService(Database::connection());
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        return $this->json($response, $this->service()->create($args['projectId'], $this->body($request)));
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $args['columnId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['projectId'], $args['columnId']) ? $this->noContent($response) : $this->notFound($response);
    }
}
