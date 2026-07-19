<?php

declare(strict_types=1);

namespace Enkl\Api\Support;

/**
 * MariaDB port fix, found live: php-api's Services hand-construct "now, as a string" timestamps via
 * `gmdate('Y-m-d\TH:i:s\Z')` (ISO-8601 with a literal "T" separator and "Z" suffix) wherever the SQL
 * text itself doesn't already call `now()` — e.g. building a set of rows to insert in one batch, or
 * stamping a value shared across several statements in the same request. That format binds fine as a
 * Postgres `timestamptz` literal, but MariaDB's `DATETIME` column type rejects it outright
 * ("Incorrect datetime value") — MariaDB expects `'YYYY-MM-DD HH:MM:SS[.ffffff]'`, no `T`, no `Z`.
 * This is the one shared place that difference is fixed, rather than patching the same format string
 * at each of the ~30 call sites across Services/ individually.
 */
final class SqlDateTime
{
    /** Current UTC instant, MariaDB `DATETIME(6)`-literal-safe. */
    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s') . '.' . sprintf('%06d', (int) (microtime(true) * 1_000_000) % 1_000_000);
    }

    /**
     * Reformats an arbitrary, already-validated (caller must check `strtotime($value) !== false`
     * first, same as MigrationService::parseDateTime already does) date/time string — typically
     * client-supplied ISO-8601 (e.g. JS's `Date.prototype.toISOString()`, which always ends in "Z") —
     * into the same MariaDB-safe literal form. Uses \DateTime rather than strtotime()+gmdate() so
     * fractional seconds in the source string survive the round-trip.
     */
    public static function reformat(string $value): string
    {
        return (new \DateTime($value))->format('Y-m-d H:i:s.u');
    }

    /** Same literal form as now(), for an arbitrary already-computed Unix timestamp (e.g. a
     * "N days ago" cutoff) rather than the current instant. */
    public static function fromTimestamp(int $timestamp): string
    {
        return gmdate('Y-m-d H:i:s', $timestamp);
    }
}
