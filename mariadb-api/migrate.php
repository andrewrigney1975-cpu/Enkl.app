<?php

declare(strict_types=1);

/**
 * `php migrate.php` — deploys/updates the schema on whatever standalone MariaDB instance the
 * organisation has configured in .env, without booting the HTTP server. Run this once against a
 * freshly-provisioned database before pointing the API at it for the first time, and again after
 * pulling any update that adds a new file to src/Db/migrations. Safe to re-run any time — already-
 * applied migrations are tracked and skipped (see src/Db/Migrator.php). Ported from php-api/migrate.php.
 */

require __DIR__ . '/vendor/autoload.php';

(\Dotenv\Dotenv::createImmutable(__DIR__))->safeLoad();

use Enkl\Api\Db\Database;
use Enkl\Api\Db\Migrator;

$migrator = new Migrator(Database::connection(), __DIR__ . '/src/Db/migrations');

echo "Connecting to " . (getenv('DB_HOST') ?: 'localhost') . ":" . (getenv('DB_PORT') ?: '3306') . "/" . (getenv('DB_NAME') ?: 'enkl') . "...\n";

$applied = $migrator->run();

if ($applied === []) {
    echo "Already up to date — no migrations to apply.\n";
} else {
    echo "Applied " . count($applied) . " migration(s):\n";
    foreach ($applied as $name) {
        echo "  - {$name}\n";
    }
}
