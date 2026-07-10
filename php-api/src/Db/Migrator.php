<?php

declare(strict_types=1);

namespace Enkl\Api\Db;

use PDO;
use RuntimeException;
use Throwable;

/**
 * Applies every not-yet-run .sql file in src/Db/migrations, in filename order, tracked in a
 * migrations_history table (this project's own, not the .NET side's __EFMigrationsHistory — the two
 * API tiers each own their schema evolution independently, even when pointed at the same database).
 *
 * This IS the "deploy tables and DB entities" mechanism for an organisation's freshly-provisioned,
 * standalone Postgres instance — there's no separate provisioning tool. Run via `php migrate.php`
 * (see repo root) or automatically on boot when RUN_MIGRATIONS_ON_STARTUP=true (see public/index.php).
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

            $this->db->beginTransaction();
            try {
                $this->db->exec($sql);
                $stmt = $this->db->prepare(
                    'INSERT INTO migrations_history (migration_name, applied_at) VALUES (:name, now())'
                );
                $stmt->execute(['name' => $name]);
                $this->db->commit();
                $newlyApplied[] = $name;
            } catch (Throwable $e) {
                $this->db->rollBack();
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
                applied_at TIMESTAMPTZ NOT NULL
            )
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
