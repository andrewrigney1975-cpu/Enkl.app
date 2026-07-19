<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * One long-lived Server-Sent Events stream per browser tab, covering every project the caller is a
 * member of — the PHP-FPM equivalent of Controllers/EventsController.cs. Authenticated the same way
 * as every other endpoint (bearer JWT); deliberately NOT the native EventSource API client-side,
 * since EventSource can't send an Authorization header — src/js/features/live-updates.js drives this
 * via fetch + ReadableStream instead, and needs zero changes to talk to this tier vs the other two.
 *
 * MariaDB has no LISTEN/NOTIFY equivalent at all, so unlike the Postgres tiers' own NOTIFY-driven
 * push, this stream POLLS the "Events" outbox table (src/Db/migrations/009_events_outbox.sql) every
 * POLL_SECONDS — see Realtime/Broadcaster.php for the publish side. A dedicated PDO connection
 * (Database::newConnection(), never the shared per-request singleton) is still used, same as the
 * Postgres tiers, since this stream lives far longer than an ordinary request.
 */
final class EventsController extends BaseController
{
    // Every SAPI (built-in dev server, php-fpm, etc.) only learns a client has disconnected when it
    // actually attempts to write to the connection and the write fails — connection_aborted() doesn't
    // update on its own just by the passage of time. So this interval does double duty: it's both the
    // heartbeat cadence (keeps the connection from looking idle to nginx/any intermediary — comment
    // frames are ignored by EventSource-style parsers, including live-updates.js's own) AND the upper
    // bound on how long a dead connection stays registered as "open" after the client is actually gone.
    private const HEARTBEAT_SECONDS = 15;

    // How often this stream polls the Events outbox for new rows — short enough that live updates
    // (a teammate's task edit, a new chat message) still feel close to instant, per this tier's own
    // design decision to accept a small steady per-connection query instead of MariaDB's total lack
    // of a LISTEN/NOTIFY-equivalent push primitive.
    private const POLL_SECONDS = 2;

    public function stream(Request $request, Response $response, array $args): Response
    {
        $claims = $request->getAttribute('jwtClaims');
        $userId = (string) ($claims->sub ?? '');
        $clientSessionId = $request->getHeaderLine('X-Client-Session-Id') ?: null;

        // Slim buffers the Response object's body until the framework's own emitter runs; a
        // long-lived stream must instead write directly to the PHP output buffer and flush after
        // every frame, so output buffering is torn down here and headers are sent immediately —
        // mirrors EventsController.cs's DisableBuffering() call.
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('X-Accel-Buffering: no');
        flush();

        set_time_limit(0);
        ignore_user_abort(false);

        $db = Database::newConnection();
        // Start from whatever the current max Id already is — this stream should only ever see
        // events published AFTER it opened, same "future events only" semantics LISTEN/NOTIFY gives
        // the Postgres tiers for free.
        $lastSeenId = (int) ($db->query('SELECT COALESCE(MAX("Id"), 0) FROM "Events"')->fetchColumn() ?: 0);
        $lastHeartbeat = time();
        $this->markPresent($userId);

        try {
            while (!connection_aborted()) {
                $stmt = $db->prepare('SELECT "Id", "Channel", "Payload" FROM "Events" WHERE "Id" > :lastSeenId ORDER BY "Id" LIMIT 100');
                $stmt->execute(['lastSeenId' => $lastSeenId]);
                $found = false;
                while (($row = $stmt->fetch()) !== false) {
                    $found = true;
                    $lastSeenId = (int) $row['Id'];
                    $this->emitIfRelevant($row['Channel'], $row['Payload'], $userId, $clientSessionId);
                }

                if ($found) {
                    if (@flush() === false || connection_aborted()) {
                        break;
                    }
                }

                if (time() - $lastHeartbeat >= self::HEARTBEAT_SECONDS) {
                    echo ": ping\n\n";
                    if (@flush() === false || connection_aborted()) {
                        break;
                    }
                    $lastHeartbeat = time();
                    // Refreshed every heartbeat, not just on connect — a long-lived stream must keep
                    // proving it's still alive so PresenceRepository's "online" window (grace period
                    // just past one missed beat) doesn't go stale while the connection is actually fine.
                    $this->markPresent($userId);
                }

                sleep(self::POLL_SECONDS);
            }
        } finally {
            $this->markAbsent($userId);
        }

        return $response;
    }

    private function emitIfRelevant(string $channel, string $rawPayload, string $userId, ?string $clientSessionId): void
    {
        $payload = json_decode($rawPayload, true);
        if (!is_array($payload)) {
            return;
        }
        if (!in_array($userId, $payload['memberUserIds'] ?? [], true)) {
            return;
        }
        // The tab that made the change already knows (it just did it) — excluded here; that user's
        // OTHER tabs/browsers still get notified, which is the actual gap this feature closes.
        if ($clientSessionId !== null && ($payload['excludeClientSessionId'] ?? null) === $clientSessionId) {
            return;
        }

        // The channel name IS the SSE event name for every channel this stream polls for — kept a
        // 1:1 mapping deliberately so adding a future channel never needs a branch here, just another
        // value written to "Events"."Channel" by Broadcaster.php.
        echo 'event: ' . str_replace('_', '-', $channel) . "\n";
        echo 'data: ' . json_encode($payload['event']) . "\n\n";
        @flush();
    }

    // Best-effort — a presence hiccup must never break the SSE stream itself. See migration
    // 007_collaboration.sql's own comment on SsePresence for why this table exists at all (the
    // PHP-FPM equivalent of the .NET tier's in-memory connection registry).
    private function markPresent(string $userId): void
    {
        try {
            $stmt = Database::connection()->prepare(
                'INSERT INTO "SsePresence" ("UserId", "LastSeenAt") VALUES (:uid, now())
                 ON DUPLICATE KEY UPDATE "LastSeenAt" = now()'
            );
            $stmt->execute(['uid' => $userId]);
        } catch (\Throwable) {
        }
    }

    private function markAbsent(string $userId): void
    {
        try {
            Database::connection()->prepare('DELETE FROM "SsePresence" WHERE "UserId" = :uid')->execute(['uid' => $userId]);
        } catch (\Throwable) {
        }
    }
}
