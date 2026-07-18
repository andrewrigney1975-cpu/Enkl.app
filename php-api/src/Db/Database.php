<?php

declare(strict_types=1);

namespace Enkl\Api\Db;

use Enkl\Api\Config\Config;
use PDO;
use PDOException;

/**
 * One PDO connection per request (Slim's DI container gives every controller/service the same
 * instance within a request via a shared factory closure — see src/bootstrap.php), configured for
 * exceptions-on-error and native (not emulated) prepared statements, matching how Npgsql/EF Core
 * talks to Postgres on the .NET side closely enough that parameter binding behaves the same way.
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
     * Controllers/EventsController.php, which holds a dedicated connection open for the lifetime of an
     * SSE stream (LISTEN) and must never share it with the request-scoped connection other
     * services/controllers use for ordinary queries.
     */
    public static function newConnection(): PDO
    {
        return self::connectWithRetry();
    }

    /**
     * A separate connection authenticated as the dedicated, SELECT-only enkl_public_query Postgres
     * role (created by 023_add_saved_query_api_exposure.sql) — used only by
     * Services/PublicQueryExecutionService.php to run a saved query's SQL text. Never the shared
     * singleton/request connection above: that one runs as the app's own high-privilege DB user,
     * which this deliberately must not be able to reach. See CLAUDE.md's public-query-execution
     * entry for why a locked-down Postgres role, not text-sandboxing, is the actual safety boundary
     * here.
     */
    public static function publicQueryConnection(): PDO
    {
        $dsn = Config::dbDsn();
        $user = Config::get('DB_PUBLIC_QUERY_USER', 'enkl_public_query');
        $password = Config::get('DB_PUBLIC_QUERY_PASSWORD', 'enkl_public_query_dev_password');

        return new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }

    /**
     * Mirrors Program.cs's MigrateDatabaseWithRetryAsync — a standalone Postgres instance the
     * organisation manages themselves may not be reachable the instant this process starts (network
     * hiccup, Postgres still starting up on their end, etc.), so the first connection attempt gets a
     * short retry loop rather than crashing the whole API on a transient failure.
     */
    private static function connectWithRetry(int $maxAttempts = 10): PDO
    {
        $dsn = Config::dbDsn();
        $user = Config::get('DB_USER', 'enkl');
        $password = Config::get('DB_PASSWORD', '');

        $lastError = null;
        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                return new PDO($dsn, $user, $password, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]);
            } catch (PDOException $e) {
                $lastError = $e;
                if ($attempt < $maxAttempts) {
                    sleep(3);
                }
            }
        }

        throw new PDOException('Could not connect to PostgreSQL after ' . $maxAttempts . ' attempts: ' . $lastError?->getMessage(), previous: $lastError);
    }
}
