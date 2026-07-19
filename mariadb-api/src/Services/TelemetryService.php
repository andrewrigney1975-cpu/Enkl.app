<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from Services/TelemetryService.cs. Backs the anonymous Real User Monitoring beacon
 * (TelemetryController) — every method here is reachable with no authentication at all, so
 * validation here is data-quality hygiene (silently drop anything implausible), not a security
 * boundary the way the OrgAdmin-scoped services elsewhere in this API are.
 */
final class TelemetryService
{
    // A page load taking longer than this is more likely a bad/garbled client-side measurement
    // (e.g. a stopped debugger, a suspended background tab) than a real number worth plotting.
    private const MAX_PLAUSIBLE_DURATION_MS = 300_000; // 5 minutes

    public function __construct(private readonly PDO $db)
    {
    }

    public function recordPageLoad(mixed $durationMs): void
    {
        if (!is_numeric($durationMs)) {
            return;
        }
        $duration = (float) $durationMs;
        if (!is_finite($duration) || $duration <= 0 || $duration > self::MAX_PLAUSIBLE_DURATION_MS) {
            return; // silently dropped — see class doc comment
        }

        $stmt = $this->db->prepare(
            'INSERT INTO "PageLoadTimings" ("Id", "RecordedAt", "DurationMs") VALUES (:id, now(), :duration)'
        );
        $stmt->execute(['id' => Uuid::v4(), 'duration' => $duration]);
    }
}
