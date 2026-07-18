<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TaskCommentService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/TaskCommentsController.cs. */
final class TaskCommentsController extends BaseController
{
    private function service(): TaskCommentService
    {
        return new TaskCommentService(Database::connection());
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['projectId'], $args['taskId'], $this->callerUserId($request), $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $args['taskId'], $args['commentId'], $this->callerUserId($request), $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $claims = $request->getAttribute('jwtClaims');
        $callerClaimsOrgAdmin = ($claims->orgAdmin ?? null) === 'true';
        $callerOrgId = isset($claims->orgId) ? (string) $claims->orgId : null;

        $deleted = $this->service()->delete(
            $args['projectId'], $args['taskId'], $args['commentId'],
            $this->callerUserId($request), $callerClaimsOrgAdmin, $callerOrgId
        );
        return $deleted ? $this->noContent($response) : $this->notFound($response);
    }
}
