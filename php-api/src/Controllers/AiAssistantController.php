<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\AiAssistantService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/AiAssistantController.cs. ProjectMemberMiddleware is applied on the route
 * group in routes.php (same shape as TasksController), not here. */
final class AiAssistantController extends BaseController
{
    private function service(): AiAssistantService
    {
        return new AiAssistantService(Database::connection());
    }

    public function chat(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->chat($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
