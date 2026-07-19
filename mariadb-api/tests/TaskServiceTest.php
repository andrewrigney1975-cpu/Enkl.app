<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ColumnService;
use Enkl\Api\Services\TaskService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for TaskService — create()/update()/delete() all got
 * beginTransaction()/commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1).
 * Every task needs a seeded Column first (ColumnService::create), same as a real request would.
 */
final class TaskServiceTest extends TestCase
{
    private static PDO $db;
    private static TaskService $tasks;
    private static ColumnService $columns;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$tasks = new TaskService(self::$db);
        self::$columns = new ColumnService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));
        $todo = self::$columns->create($projectId, ['name' => 'To Do', 'done' => false]);
        $done = self::$columns->create($projectId, ['name' => 'Done', 'done' => true]);

        $created = self::$tasks->create($projectId, ['title' => 'My Task', 'priority' => 'high', 'columnId' => $todo['id']]);
        self::assertNotNull($created);
        self::assertSame('My Task', $created['title']);
        self::assertSame('high', $created['priority']);
        self::assertNull($created['dateDone']);
        $taskId = $created['id'];

        $stmt = self::$db->prepare('SELECT "Key" FROM "Tasks" WHERE "Id" = :id');
        $stmt->execute(['id' => $taskId]);
        self::assertNotFalse($stmt->fetchColumn());

        // Moving into the Done column should stamp DateDone.
        $updated = self::$tasks->update($projectId, $taskId, ['title' => 'My Task', 'priority' => 'high', 'columnId' => $done['id']], 'Tester');
        self::assertNotNull($updated);
        self::assertSame($done['id'], $updated['columnId']);
        self::assertNotNull($updated['dateDone']);

        $deleted = self::$tasks->delete($projectId, $taskId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Tasks" WHERE "Id" = :id');
        $stmt->execute(['id' => $taskId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateWithDependencyCycleThrowsValidationException(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));
        $todo = self::$columns->create($projectId, ['name' => 'To Do', 'done' => false]);

        $taskA = self::$tasks->create($projectId, ['title' => 'A', 'columnId' => $todo['id']]);
        $taskB = self::$tasks->create($projectId, ['title' => 'B', 'columnId' => $todo['id'], 'dependsOnTaskIds' => [$taskA['id']]]);

        $this->expectException(ApiValidationException::class);
        self::$tasks->update($projectId, $taskA['id'], ['title' => 'A', 'columnId' => $todo['id'], 'dependsOnTaskIds' => [$taskB['id']]], null);
    }

    public function testCreateWithNonExistentColumnReturnsNull(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertNull(self::$tasks->create($projectId, ['title' => 'X', 'columnId' => Uuid::v4()]));
    }

    public function testDeleteOrphansSubTasks(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));
        $todo = self::$columns->create($projectId, ['name' => 'To Do', 'done' => false]);

        $parent = self::$tasks->create($projectId, ['title' => 'Parent', 'columnId' => $todo['id']]);
        $child = self::$tasks->create($projectId, ['title' => 'Child', 'columnId' => $todo['id'], 'parentTaskId' => $parent['id']]);
        self::assertSame($parent['id'], $child['parentTaskId']);

        self::$tasks->delete($projectId, $parent['id']);

        $stmt = self::$db->prepare('SELECT "ParentTaskId" FROM "Tasks" WHERE "Id" = :id');
        $stmt->execute(['id' => $child['id']]);
        self::assertNull($stmt->fetchColumn());
    }
}
