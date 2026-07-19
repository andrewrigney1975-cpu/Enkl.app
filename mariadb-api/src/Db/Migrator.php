<?php

declare(strict_types=1);

namespace Enkl\Api\Db;

use PDO;
use RuntimeException;
use Throwable;

/**
 * Applies every not-yet-run .sql file in src/Db/migrations, in filename order, tracked in a
 * migrations_history table — same discovery/ordering/history-table shape as php-api/src/Db/
 * Migrator.php, ported to MariaDB (only the history table's timestamp column type changed, from
 * `TIMESTAMPTZ` to `DATETIME(6)` — see mariadb-api/CLAUDE.md's column-type-mapping table).
 *
 * This IS the "deploy tables and DB entities" mechanism for an organisation's freshly-provisioned,
 * standalone MariaDB instance — there's no separate provisioning tool. Run via `php migrate.php` (see
 * repo root) or automatically on boot when RUN_MIGRATIONS_ON_STARTUP=true (see public/index.php).
 *
 * **MariaDB-specific caveat, genuinely different from the Postgres tier — no transaction wrapper at
 * all, not just a syntax note**: php-api's own Migrator wraps each migration's `exec($sql)` +
 * `migrations_history` INSERT in `beginTransaction()`/`commit()`/`rollBack()`. That doesn't just
 * become "less safe" on MariaDB, it actively breaks: MariaDB (like MySQL) auto-commits DDL the
 * instant it runs, which silently ends the PDO-tracked transaction underneath you — confirmed live
 * against a real MariaDB 11.4 instance, where `$db->inTransaction()` was already `false`
 * immediately after `exec($sql)` on a `CREATE TABLE`-only migration. The following `commit()` then
 * throws "There is no active transaction" even though the migration fully succeeded, and the
 * catch block's own `rollBack()` throws the *same* error on top of that — crashing the whole
 * migration run with a misleading failure despite every statement having actually applied cleanly.
 * The fix isn't a workaround, it's removing the transaction wrapper entirely: there's nothing
 * transactional to protect here anyway once DDL auto-commits regardless. This does mean a
 * migration file that fails partway (e.g. its second CREATE TABLE has a typo) can leave its first
 * table applied but the file unmarked in `migrations_history` — an inherent MariaDB/MySQL
 * limitation every migration tool for these engines lives with, not something this class can paper
 * over. See DEPLOYMENT-MARIADB.md's troubleshooting notes for the manual recovery step (mark the
 * migration row present by hand once you've confirmed the DDL actually applied).
 */
final class Migrator
{
    public function __construct(
        private readonly PDO $db,
        private readonly string $migrationsPath,
    ) {
    }

    /** @return string[] names of migrations that were newly applied this run */
    public function run(): array
    {
        $this->ensureHistoryTable();
        $applied = $this->appliedMigrationNames();
        $newlyApplied = [];

        foreach ($this->migrationFiles() as $file) {
            $name = basename($file, '.sql');
            if (in_array($name, $applied, true)) {
                continue;
            }

            $sql = file_get_contents($file);
            if ($sql === false) {
                throw new RuntimeException("Could not read migration file: {$file}");
            }

            try {
                $this->db->exec($sql);
                $stmt = $this->db->prepare(
                    'INSERT INTO migrations_history (migration_name, applied_at) VALUES (:name, now())'
                );
                $stmt->execute(['name' => $name]);
                $newlyApplied[] = $name;
            } catch (Throwable $e) {
                throw new RuntimeException("Migration '{$name}' failed: " . $e->getMessage(), previous: $e);
            }
        }

        return $newlyApplied;
    }

    private function ensureHistoryTable(): void
    {
        $this->db->exec(<<<SQL
            CREATE TABLE IF NOT EXISTS migrations_history (
                migration_name VARCHAR(255) PRIMARY KEY,
                applied_at DATETIME(6) NOT NULL
            ) ENGINE=InnoDB
        SQL);
    }

    /** @return string[] */
    private function appliedMigrationNames(): array
    {
        $stmt = $this->db->query('SELECT migration_name FROM migrations_history');
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }

    /** @return string[] */
    private function migrationFiles(): array
    {
        $files = glob(rtrim($this->migrationsPath, '/') . '/*.sql');
        if ($files === false) {
            return [];
        }
        sort($files, SORT_STRING);
        return $files;
    }
}
