<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TaskTypeService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for TaskTypeService — not transaction-wrapped this session (single-
 * statement create/update/delete), but had zero coverage before this pass.
 */
final class TaskTypeServiceTest extends TestCase
{
    private static PDO $db;
    private static TaskTypeService $taskTypes;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$taskTypes = new TaskTypeService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $created = self::$taskTypes->create($projectId, ['name' => 'Bug', 'iconName' => 'bug']);
        self::assertNotNull($created);
        self::assertSame('Bug', $created['name']);
        $typeId = $created['id'];

        $updated = self::$taskTypes->update($projectId, $typeId, ['name' => 'Defect', 'iconName' => 'bug']);
        self::assertNotNull($updated);
        self::assertSame('Defect', $updated['name']);

        $stmt = self::$db->prepare('SELECT "Name" FROM "TaskTypes" WHERE "Id" = :id');
        $stmt->execute(['id' => $typeId]);
        self::assertSame('Defect', $stmt->fetchColumn());

        $deleted = self::$taskTypes->delete($projectId, $typeId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "TaskTypes" WHERE "Id" = :id');
        $stmt->execute(['id' => $typeId]);
        self::assertFalse($stmt->fetch());
    }

    public function testDeleteNonExistentTaskTypeReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertFalse(self::$taskTypes->delete($projectId, Uuid::v4()));
    }
}
