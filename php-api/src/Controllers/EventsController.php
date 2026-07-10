<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Config\Config;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * One long-lived Server-Sent Events stream per browser tab, covering every project the caller is a
 * member of — the PHP-FPM equivalent of Controllers/EventsController.cs. Authenticated the same way
 * as every other endpoint (bearer JWT); deliberately NOT the native EventSource API client-side,
 * since EventSource can't send an Authorization header — src/js/features/live-updates.js drives this
 * via fetch + ReadableStream instead, and needs zero changes to talk to this tier vs the .NET one.
 *
 * Unlike the .NET side's in-memory SseBroadcaster (a single-process registry), every mutation here
 * publishes via Postgres NOTIFY (see Realtime/Broadcaster.php) and every open stream runs its own
 * dedicated `LISTEN task_changed` connection, filtering incoming payloads for itself by the
 * memberUserIds/excludeClientSessionId embedded in each notification. This needs the raw ext-pgsql
 * driver (pg_connect/pg_get_notify) rather than PDO, since PDO_PGSQL doesn't expose an async
 * notification wait primitive — ext-pgsql is a standard companion to pdo_pgsql on any PHP install
 * capable of running this tier at all.
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

        $conn = @pg_connect(Config::pgConnectionString());
        if ($conn === false) {
            return $response->withStatus(503);
        }

        pg_query($conn, 'LISTEN task_changed');
        $socket = pg_socket($conn);
        $lastHeartbeat = time();

        try {
            while (!connection_aborted()) {
                $read = [$socket];
                $write = $except = [];
                $changed = @stream_select($read, $write, $except, self::HEARTBEAT_SECONDS);

                if ($changed > 0) {
                    pg_consume_input($conn);
                    while (($notify = pg_get_notify($conn, PGSQL_ASSOC)) !== false) {
                        $this->emitIfRelevant($notify, $userId, $clientSessionId);
                    }
                }

                if (time() - $lastHeartbeat >= self::HEARTBEAT_SECONDS) {
                    echo ": ping\n\n";
                    if (@flush() === false || connection_aborted()) {
                        break;
                    }
                    $lastHeartbeat = time();
                }
            }
        } finally {
            pg_close($conn);
        }

        return $response;
    }

    private function emitIfRelevant(array $notify, string $userId, ?string $clientSessionId): void
    {
        $payload = json_decode($notify['payload'] ?? '', true);
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

        echo "event: task-changed\n";
        echo 'data: ' . json_encode($payload['event']) . "\n\n";
        @flush();
    }
}
