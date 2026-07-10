<?php

declare(strict_types=1);

namespace Enkl\Api\Realtime;

use PDO;

/**
 * Publishes task-change events via Postgres LISTEN/NOTIFY on channel "task_changed" — the PHP-FPM
 * equivalent of the .NET tier's in-memory SseBroadcaster. Each web worker process is stateless and
 * short-lived, so there is no in-process registry of open connections to write into directly; instead
 * every mutation NOTIFYs Postgres, and every open SSE stream (Controllers/EventsController.php) runs
 * its own dedicated long-lived connection with `LISTEN task_changed` and filters incoming payloads for
 * itself (by memberUserIds/excludeClientSessionId, both embedded in the payload). This is strictly
 * better than the .NET singleton for horizontal scaling: it works correctly across any number of
 * php-fpm workers/hosts, since Postgres itself is the shared backplane.
 */
final class Broadcaster
{
    public function __construct(private readonly PDO $db)
    {
    }

    /**
     * @param string[] $memberUserIds
     */
    public function broadcastTaskChanged(
        array $memberUserIds,
        string $projectId,
        string $taskId,
        string $taskKey,
        string $title,
        string $changeType,
        string $changedByUserId,
        string $changedByDisplayName,
        ?string $excludeClientSessionId
    ): void {
        $payload = json_encode([
            'memberUserIds' => $memberUserIds,
            'excludeClientSessionId' => $excludeClientSessionId,
            'event' => [
                'projectId' => $projectId, 'taskId' => $taskId, 'taskKey' => $taskKey, 'title' => $title,
                'changeType' => $changeType, 'changedByUserId' => $changedByUserId,
                'changedByDisplayName' => $changedByDisplayName,
            ],
        ]);

        // pg_notify's payload is capped at 8000 bytes by Postgres itself, comfortably above anything a
        // single task-changed event can produce (title is capped well below that at the DB layer).
        $stmt = $this->db->prepare('SELECT pg_notify(:channel, :payload)');
        $stmt->execute(['channel' => 'task_changed', 'payload' => $payload]);
    }
}
