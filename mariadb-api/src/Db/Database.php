<?php

declare(strict_types=1);

namespace Enkl\Api\Db;

use Enkl\Api\Config\Config;
use PDO;
use PDOException;

/**
 * One PDO connection per request, configured for exceptions-on-error and native (not emulated)
 * prepared statements — same shape as php-api/src/Db/Database.php, ported to MariaDB.
 *
 * Two MariaDB-specific session settings are applied to every connection this class hands out
 * (applySessionDefaults()), and they're load-bearing for the rest of this tier, not cosmetic:
 *   - `sql_mode` gains ANSI_QUOTES (appended, not replacing the server's other defaults like
 *     STRICT_TRANS_TABLES) — this makes double-quoted identifiers ("Users", "OrganisationId") behave
 *     exactly like Postgres, which is what lets the overwhelming majority of php-api's raw SQL get
 *     reused in this tier's Services/Controllers with no quoting-style rewrite at all.
 *   - `time_zone` is forced to '+00:00' — MariaDB's DATETIME columns (standing in for Postgres's
 *     tz-aware `timestamptz`) have no native timezone awareness; forcing every connection's session
 *     to UTC is what keeps every NOW()-stamped column consistent with the other two tiers, which both
 *     already treat all timestamps as UTC throughout.
 */
final class Database
{
    private static ?PDO $instance = null;

    public static function connection(): PDO
    {
        if (self::$instance === null) {
            self::$instance = self::connectWithRetry();
        }
        return self::$instance;
    }

    /**
     * A fresh, independent connection outside the shared singleton — used by
     * Controllers/EventsController.php's polling loop, which holds a dedicated connection open for
     * the lifetime of an SSE stream and must never share it with the request-scoped connection other
     * services/controllers use for ordinary queries.
     */
    public static function newConnection(): PDO
    {
        return self::connectWithRetry();
    }

    /**
     * A separate connection authenticated as the dedicated, SELECT-only enkl_public_query MariaDB
     * user (created by src/Db/migrations/006_saved_queries_and_public_api.sql) — used only by
     * Services/PublicQueryExecutionService.php to run a saved query's SQL text. Never the shared
     * singleton/request connection above: that one runs as the app's own high-privilege DB user, which
     * this deliberately must not be able to reach.
     */
    public static function publicQueryConnection(): PDO
    {
        $dsn = Config::dbDsn();
        $user = Config::get('DB_PUBLIC_QUERY_USER', 'enkl_public_query');
        $password = Config::get('DB_PUBLIC_QUERY_PASSWORD', 'enkl_public_query_dev_password');

        $pdo = new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        self::applySessionDefaults($pdo);
        return $pdo;
    }

    /**
     * Mirrors php-api's own connectWithRetry() (itself mirroring Program.cs's
     * MigrateDatabaseWithRetryAsync) — a standalone MariaDB instance the organisation manages
     * themselves may not be reachable the instant this process starts, so the first connection
     * attempt gets a short retry loop rather than crashing the whole API on a transient failure.
     */
    private static function connectWithRetry(int $maxAttempts = 10): PDO
    {
        $dsn = Config::dbDsn();
        $user = Config::get('DB_USER', 'enkl');
        $password = Config::get('DB_PASSWORD', '');

        $lastError = null;
        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $pdo = new PDO($dsn, $user, $password, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]);
                self::applySessionDefaults($pdo);
                return $pdo;
            } catch (PDOException $e) {
                $lastError = $e;
                if ($attempt < $maxAttempts) {
                    sleep(3);
                }
            }
        }

        throw new PDOException('Could not connect to MariaDB after ' . $maxAttempts . ' attempts: ' . $lastError?->getMessage(), previous: $lastError);
    }

    private static function applySessionDefaults(PDO $pdo): void
    {
        $pdo->exec("SET time_zone = '+00:00'");
        $pdo->exec("SET sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')");
    }
}
