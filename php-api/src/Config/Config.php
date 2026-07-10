<?php

declare(strict_types=1);

namespace Enkl\Api\Config;

/**
 * Thin env-var reader — deliberately not a framework config-cache system, since the whole point of
 * this tier is "runs on whatever standalone box the organisation already has," not "runs inside our
 * container with our assumed layout." Every value here is read fresh from getenv() (populated by
 * vlucas/phpdotenv from .env in public/index.php, or by real process-level env vars in production —
 * either works identically).
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

    public static function dbDsn(): string
    {
        $host = self::get('DB_HOST', 'localhost');
        $port = self::get('DB_PORT', '5432');
        $name = self::get('DB_NAME', 'enkl');
        return "pgsql:host={$host};port={$port};dbname={$name}";
    }

    /**
     * libpq keyword/value connection string for pg_connect() — used only by
     * Controllers/EventsController.php, which needs the raw ext-pgsql driver (not PDO) for its
     * LISTEN/NOTIFY socket-level wait loop; see that file's own comment for why.
     */
    public static function pgConnectionString(): string
    {
        $host = self::get('DB_HOST', 'localhost');
        $port = self::get('DB_PORT', '5432');
        $name = self::get('DB_NAME', 'enkl');
        $user = self::get('DB_USER', 'enkl');
        $password = str_replace(['\\', "'"], ['\\\\', "\\'"], self::get('DB_PASSWORD', '') ?? '');
        return "host={$host} port={$port} dbname={$name} user={$user} password='{$password}'";
    }
}
