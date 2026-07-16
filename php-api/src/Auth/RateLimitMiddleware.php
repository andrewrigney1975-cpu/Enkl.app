<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Enkl\Api\Db\Database;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Ported from Program.cs's named rate-limiting policies (security review finding H1) — same
 * per-client-IP sliding-window shape, but DB-backed rather than in-memory: a PHP-FPM worker holds no
 * state between requests (same reasoning as 007_add_exchange_codes.sql's own note), so an in-memory
 * counter would only ever see the requests one worker happened to handle.
 *
 * `RateLimitHits` has no separate "policy" column, just PartitionKey — so the policy name is folded
 * into the partition key itself (see clientIp()'s caller below) to keep policies from sharing a
 * counter just because they happen to come from the same IP, mirroring how .NET's named
 * RateLimitPartition policies never share state with each other even for the same partition key.
 *
 * Default (no constructor args) reproduces the original "auth" policy exactly (10/min) for every
 * existing bare `RateLimitMiddleware::class` call site in routes.php — pass an already-constructed
 * instance (e.g. `new RateLimitMiddleware('telemetry', 30)`) for a route needing a different policy.
 */
final class RateLimitMiddleware implements MiddlewareInterface
{
    private const WINDOW_SECONDS = 60;

    public function __construct(
        private readonly string $policyName = 'auth',
        private readonly int $permitLimit = 10
    ) {
    }

    // ARCHITECTURE-REVIEW.md finding 3.2 (second half): a full-table prune on every single
    // rate-limited request is wasted write amplification on a hot path — 1-in-20 is frequent enough
    // that RateLimitHits never grows unbounded between prunes (every partition gets checked at least
    // every ~20 requests across the WHOLE table, not per-partition), while cutting prune-DELETE volume
    // ~95%. The DELETE itself needs no lock — it's a pure timestamp filter with no check-then-act
    // race, unlike the count-then-insert below.
    private const PRUNE_PROBABILITY_DENOMINATOR = 20;

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $partitionKey = $this->policyName . ':' . $this->clientIp($request);
        $db = Database::connection();

        if (random_int(1, self::PRUNE_PROBABILITY_DENOMINATOR) === 1) {
            $db->prepare('DELETE FROM "RateLimitHits" WHERE "OccurredAt" < now() - make_interval(secs => :window)')
                ->execute(['window' => self::WINDOW_SECONDS]);
        }

        // ARCHITECTURE-REVIEW.md finding 3.2 (first half, the real bug): the previous count-then-insert
        // was two separate round trips with no lock between them — two concurrent requests from the
        // same partition key could both read count < limit before either's INSERT was visible to the
        // other, letting the effective limit be exceeded under exactly the multi-worker PHP-FPM
        // concurrency this table exists to handle. pg_advisory_xact_lock(hashtext(:key)) serializes
        // the count+insert for THIS partition key only (auto-released at commit/rollback, no explicit
        // unlock call needed) — a different partition key (different IP/policy) never contends with
        // this one, so normal traffic sees no added latency, only concurrent requests from the same
        // abusive client do (which is exactly the case this lock needs to slow down).
        $db->beginTransaction();
        try {
            $db->prepare('SELECT pg_advisory_xact_lock(hashtext(:key))')->execute(['key' => $partitionKey]);

            $countStmt = $db->prepare(
                'SELECT COUNT(*) FROM "RateLimitHits" WHERE "PartitionKey" = :key AND "OccurredAt" > now() - make_interval(secs => :window)'
            );
            $countStmt->execute(['key' => $partitionKey, 'window' => self::WINDOW_SECONDS]);
            $count = (int) $countStmt->fetchColumn();

            if ($count >= $this->permitLimit) {
                $db->rollBack();
                $response = new Response(429);
                $response->getBody()->write(json_encode(['message' => 'Too many attempts. Please wait a moment and try again.']));
                return $response->withHeader('Content-Type', 'application/json');
            }

            $db->prepare('INSERT INTO "RateLimitHits" ("PartitionKey") VALUES (:key)')->execute(['key' => $partitionKey]);
            $db->commit();
        } catch (\Throwable $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $e;
        }

        return $handler->handle($request);
    }

    /**
     * Prefers X-Forwarded-For's first (original client) entry — this tier is only ever reached
     * through the same nginx as the .NET tier (web/nginx.conf), which now forwards it (see that
     * file's own H4 note) — falling back to the raw connection address if the header is absent
     * (e.g. a direct request during local development).
     */
    private function clientIp(ServerRequestInterface $request): string
    {
        $forwardedFor = $request->getHeaderLine('X-Forwarded-For');
        if ($forwardedFor !== '') {
            return trim(explode(',', $forwardedFor)[0]);
        }
        $server = $request->getServerParams();
        return (string) ($server['REMOTE_ADDR'] ?? 'unknown');
    }
}
