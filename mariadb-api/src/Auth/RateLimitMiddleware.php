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
 *
 * $identityResolver (optional 3rd constructor arg): by default the partition identity is the
 * caller's IP (clientIp()) — PublicQueryController needs partitioning by the presented API key
 * instead (a 3rd-party caller may be server-side/NAT'd and share an IP with unrelated traffic), so
 * it passes a closure that reads the raw bearer token off the request. Runs before
 * ApiKeyAuthMiddleware (this middleware sits outside it in the route group, so it evaluates first),
 * so it partitions on whatever bearer value was presented regardless of whether it later turns out
 * to be valid — that's fine, it only needs to bucket per-caller.
 */
final class RateLimitMiddleware implements MiddlewareInterface
{
    private const WINDOW_SECONDS = 60;

    /** @var (\Closure(ServerRequestInterface): string)|null */
    private readonly ?\Closure $identityResolver;

    public function __construct(
        private readonly string $policyName = 'auth',
        private readonly int $permitLimit = 10,
        ?\Closure $identityResolver = null
    ) {
        $this->identityResolver = $identityResolver;
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
        $identity = $this->identityResolver !== null ? ($this->identityResolver)($request) : $this->clientIp($request);
        $partitionKey = $this->policyName . ':' . $identity;
        $db = Database::connection();

        if (random_int(1, self::PRUNE_PROBABILITY_DENOMINATOR) === 1) {
            $db->prepare('DELETE FROM "RateLimitHits" WHERE "OccurredAt" < now() - INTERVAL :window SECOND')
                ->execute(['window' => self::WINDOW_SECONDS]);
        }

        // ARCHITECTURE-REVIEW.md finding 3.2 (first half, the real bug), MariaDB port: php-api's own
        // fix serializes count-then-insert per partition key via
        // `pg_advisory_xact_lock(hashtext(:key))` — a transaction-scoped advisory lock, auto-released
        // at commit/rollback. MariaDB has no equivalent primitive: `GET_LOCK()`/`RELEASE_LOCK()` are
        // SESSION-scoped, not transaction-scoped, and would leak across a pooled/reused connection if
        // a release were ever missed (a real risk, not theoretical, given PDO connections in this tier
        // are normally long-lived per-request singletons). Ordinary InnoDB row locking gives the exact
        // same "auto-released at commit/rollback, only this partition key contends" guarantee instead:
        // "RateLimitPartitionLocks" (src/Db/migrations/008_rate_limit_and_telemetry.sql) has one row
        // per partition key, INSERT IGNOREd into existence on first sight, then locked with
        // `SELECT ... FOR UPDATE` inside this same transaction before the count+insert below — a
        // different partition key's row is never touched, so normal traffic sees no added latency,
        // only concurrent requests from the same abusive client do.
        $db->beginTransaction();
        try {
            $db->prepare('INSERT IGNORE INTO "RateLimitPartitionLocks" ("PartitionKey") VALUES (:key)')
                ->execute(['key' => $partitionKey]);
            $db->prepare('SELECT "PartitionKey" FROM "RateLimitPartitionLocks" WHERE "PartitionKey" = :key FOR UPDATE')
                ->execute(['key' => $partitionKey]);

            $countStmt = $db->prepare(
                'SELECT COUNT(*) FROM "RateLimitHits" WHERE "PartitionKey" = :key AND "OccurredAt" > now() - INTERVAL :window SECOND'
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
