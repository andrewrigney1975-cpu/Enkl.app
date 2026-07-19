<?php

declare(strict_types=1);

namespace Enkl\Api\Realtime;

use PDO;

/**
 * Publishes task-change/chat events into the "Events" outbox table (see
 * src/Db/migrations/009_events_outbox.sql) — the MariaDB replacement for Postgres LISTEN/NOTIFY,
 * which has no equivalent primitive at all on this engine (not a syntax difference). Each web worker
 * process is stateless and short-lived, so there is no in-process registry of open connections to
 * write into directly, same reasoning as php-api's own Postgres-NOTIFY-based Broadcaster; the
 * difference here is purely in HOW the event reaches an open stream: every
 * Controllers/EventsController.php stream polls this table on a short interval instead of blocking on
 * a `LISTEN` socket, filtering rows for itself by the same memberUserIds/excludeClientSessionId
 * embedded in each payload. Still strictly better than the .NET tier's in-process singleton for
 * horizontal scaling: it works correctly across any number of PHP workers/hosts, since MariaDB itself
 * is the shared backplane, exactly like the Postgres tiers' own NOTIFY-based version.
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

        $this->insertEvent('task_changed', $payload);
    }

    /**
     * @param string[] $channelMemberUserIds
     * @param string[] $mentionedUserIds
     */
    public function broadcastChatMessage(
        array $channelMemberUserIds,
        string $channelId,
        string $messageId,
        string $text,
        string $changeType,
        ?string $authorUserId,
        string $authorName,
        string $dateCreated,
        bool $isDeleted,
        array $mentionedUserIds,
        ?string $excludeClientSessionId
    ): void {
        $payload = json_encode([
            'memberUserIds' => $channelMemberUserIds,
            'excludeClientSessionId' => $excludeClientSessionId,
            'event' => [
                'channelId' => $channelId, 'messageId' => $messageId, 'text' => $text,
                'changeType' => $changeType, 'authorUserId' => $authorUserId, 'authorName' => $authorName,
                'dateCreated' => $dateCreated, 'isDeleted' => $isDeleted, 'mentionedUserIds' => $mentionedUserIds,
            ],
        ]);

        $this->insertEvent('chat_message', $payload);
    }

    /**
     * @param string[] $channelMemberUserIds
     * @param array<int, array{emoji: string, count: int, reactedByMe: bool, userNames: string[]}> $reactions
     */
    public function broadcastChatReaction(
        array $channelMemberUserIds,
        string $channelId,
        string $messageId,
        array $reactions,
        ?string $excludeClientSessionId
    ): void {
        $payload = json_encode([
            'memberUserIds' => $channelMemberUserIds,
            'excludeClientSessionId' => $excludeClientSessionId,
            'event' => ['channelId' => $channelId, 'messageId' => $messageId, 'reactions' => $reactions],
        ]);

        $this->insertEvent('chat_reaction', $payload);
    }

    private function insertEvent(string $channel, string|false $payload): void
    {
        $stmt = $this->db->prepare('INSERT INTO "Events" ("Channel", "Payload") VALUES (:channel, :payload)');
        $stmt->execute(['channel' => $channel, 'payload' => $payload]);

        // Opportunistic prune (same 1-in-20 probability RateLimitMiddleware already uses for
        // "RateLimitHits") — every open SSE stream only ever reads forward from its own last-seen Id,
        // so nothing still reads an Events row once every currently-open stream has moved past it;
        // a full day's grace window is generously more than any realistic connection lifetime.
        if (random_int(1, 20) === 1) {
            $this->db->exec('DELETE FROM "Events" WHERE "CreatedAt" < NOW() - INTERVAL 1 DAY');
        }
    }
}
