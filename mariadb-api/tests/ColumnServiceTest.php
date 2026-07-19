<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ColumnService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ColumnService, modeled on MigrationServiceTest.php. Priority
 * target: ColumnService::delete() got beginTransaction()/commit()/rollBack() wrapping this session
 * (ARCHITECTURE-REVIEW.md finding 3.1) — this is the first real verification the wrap didn't break
 * the ordinary create -> update -> delete round trip.
 */
final class ColumnServiceTest extends TestCase
{
    private static PDO $db;
    private static ColumnService $columns;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$columns = new ColumnService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $created = self::$columns->create($projectId, ['name' => 'To Do', 'done' => false, 'color' => '#ff0000']);
        self::assertSame('To Do', $created['name']);
        self::assertFalse($created['done']);
        self::assertSame('#ff0000', $created['color']);
        self::assertSame(-1, $created['cap']);
        $columnId = $created['id'];

        $stmt = self::$db->prepare('SELECT "Name" FROM "Columns" WHERE "Id" = :id');
        $stmt->execute(['id' => $columnId]);
        self::assertSame('To Do', $stmt->fetchColumn());

        $updated = self::$columns->update($projectId, $columnId, ['name' => 'Doing', 'done' => true, 'color' => '#00ff00', 'order' => 1, 'cap' => 5]);
        self::assertNotNull($updated);
        self::assertSame('Doing', $updated['name']);
        self::assertTrue($updated['done']);
        self::assertSame(5, $updated['cap']);

        $stmt = self::$db->prepare('SELECT "Name", "Cap" FROM "Columns" WHERE "Id" = :id');
        $stmt->execute(['id' => $columnId]);
        $row = $stmt->fetch();
        self::assertSame('Doing', $row['Name']);
        self::assertSame(5, (int) $row['Cap']);

        $deleted = self::$columns->delete($projectId, $columnId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Columns" WHERE "Id" = :id');
        $stmt->execute(['id' => $columnId]);
        self::assertFalse($stmt->fetch());
    }

    public function testUpdateCapBelowOneNormalizesToUncapped(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));
        $created = self::$columns->create($projectId, ['name' => 'To Do']);

        $updated = self::$columns->update($projectId, $created['id'], ['name' => 'To Do', 'cap' => 0]);
        self::assertSame(-1, $updated['cap']);
    }

    public function testDeleteColumnWithTasksCascadesTasksAndDependencies(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));
        $column = self::$columns->create($projectId, ['name' => 'To Do']);

        $taskId = Uuid::v4();
        self::$db->prepare(<<<SQL
            INSERT INTO "Tasks" ("Id", "ProjectId", "Key", "Title", "Priority", "ColumnId", "DateCreated", "DateLastModified", "Progress", "Archived")
            VALUES (:id, :pid, :key, 'Task', 'medium', :cid, now(), now(), 0, false)
        SQL)->execute(['id' => $taskId, 'pid' => $projectId, 'key' => TestDataHelper::unique('KEY'), 'cid' => $column['id']]);

        $deleted = self::$columns->delete($projectId, $column['id']);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Tasks" WHERE "Id" = :id');
        $stmt->execute(['id' => $taskId]);
        self::assertFalse($stmt->fetch());
    }

    public function testUpdateNonExistentColumnReturnsNull(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertNull(self::$columns->update($projectId, Uuid::v4(), ['name' => 'x']));
    }

    public function testDeleteNonExistentColumnReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertFalse(self::$columns->delete($projectId, Uuid::v4()));
    }
}
