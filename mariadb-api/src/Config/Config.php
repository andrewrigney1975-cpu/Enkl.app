<?php

declare(strict_types=1);

namespace Enkl\Api\Config;

/**
 * Thin env-var reader — deliberately not a framework config-cache system, since the whole point of
 * this tier is "runs on whatever standalone box the organisation already has," not "runs inside our
 * container with our assumed layout." Every value here is read fresh from getenv() (populated by
 * vlucas/phpdotenv from .env in public/index.php, or by real process-level env vars in production —
 * either works identically). Ported from php-api/src/Config/Config.php.
 */
final class Config
{
    public static function get(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);
        if ($value === false || $value === '') {
            return $default;
        }
        return $value;
    }

    public static function getBool(string $key, bool $default = false): bool
    {
        $value = self::get($key);
        if ($value === null) {
            return $default;
        }
        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }

    public static function getInt(string $key, int $default = 0): int
    {
        $value = self::get($key);
        return $value === null ? $default : (int) $value;
    }

    /**
     * MariaDB tier — port note: php-api's own dbDsn() uses the `pgsql:` PDO driver prefix and
     * defaults to Postgres's 5432 port; this is the one central, purely mechanical change point for
     * the whole tier (see mariadb-api/CLAUDE.md).
     */
    public static function dbDsn(): string
    {
        $host = self::get('DB_HOST', 'localhost');
        $port = self::get('DB_PORT', '3306');
        $name = self::get('DB_NAME', 'enkl');
        return "mysql:host={$host};port={$port};dbname={$name}";
    }

    // php-api's pgConnectionString() doesn't exist here — it only ever existed to feed the raw
    // ext-pgsql LISTEN/NOTIFY socket connection in Controllers/EventsController.php, which has no
    // MariaDB equivalent at all (see mariadb-api/CLAUDE.md's SSE section). This tier's EventsController
    // polls via the normal PDO connection instead, so no second connection mechanism is needed.
}
