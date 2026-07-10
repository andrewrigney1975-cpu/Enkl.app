<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Realtime\Broadcaster;
use Enkl\Api\Services\TaskService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/TasksController.cs. */
final class TasksController extends BaseController
{
    private function service(): TaskService
    {
        return new TaskService(Database::connection());
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['projectId'], $this->body($request));
        if ($result === null) {
            return $this->json($response, ['message' => 'Invalid column.'], 400);
        }
        $this->broadcast($request, $args['projectId'], $result['id'], $result['key'], $result['title'], 'created');
        return $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update(
            $args['projectId'],
            $args['taskId'],
            $this->body($request),
            $this->callerDisplayName($request)
        );
        if ($result === null) {
            return $this->notFound($response);
        }
        $this->broadcast($request, $args['projectId'], $result['id'], $result['key'], $result['title'], 'updated');
        return $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $service = $this->service();
        // Grab the key/title before deleting so the "X was deleted" toast can still name it.
        $deleted = $service->getTaskSummary($args['projectId'], $args['taskId']);
        if (!$service->delete($args['projectId'], $args['taskId'])) {
            return $this->notFound($response);
        }
        if ($deleted !== null) {
            $this->broadcast($request, $args['projectId'], $deleted['taskId'], $deleted['key'], $deleted['title'], 'deleted');
        }
        return $this->noContent($response);
    }

    /** Best-effort — a notification failure must never fail the mutation itself. */
    private function broadcast(Request $request, string $projectId, string $taskId, string $taskKey, string $title, string $changeType): void
    {
        try {
            $service = $this->service();
            $memberUserIds = $service->getProjectMemberUserIds($projectId);
            $claims = $request->getAttribute('jwtClaims');
            $userId = (string) ($claims->sub ?? '');
            $displayName = $claims->displayName ?? 'Someone';
            $clientSessionId = $request->getHeaderLine('X-Client-Session-Id') ?: null;

            (new Broadcaster(Database::connection()))->broadcastTaskChanged(
                $memberUserIds, $projectId, $taskId, $taskKey, $title, $changeType, $userId, $displayName, $clientSessionId
            );
        } catch (\Throwable) {
            // Notification is best-effort — the mutation already succeeded and its response is already
            // being returned to the caller regardless.
        }
    }
}
