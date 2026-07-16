<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ObjectiveService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ObjectiveService — create()/update() got beginTransaction()/
 * commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1): the Objectives
 * row plus setPrinciples()'s junction-table writes.
 */
final class ObjectiveServiceTest extends TestCase
{
    private static PDO $db;
    private static ObjectiveService $objectives;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$objectives = new ObjectiveService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$objectives->create($projectId, ['title' => 'Ship v2', 'description' => 'Ship the v2 release']);
        self::assertNotNull($created);
        self::assertSame('Ship v2', $created['title']);
        $objectiveId = $created['id'];

        $updated = self::$objectives->update($projectId, $objectiveId, ['title' => 'Ship v2.1', 'description' => 'Revised']);
        self::assertNotNull($updated);
        self::assertSame('Ship v2.1', $updated['title']);

        $stmt = self::$db->prepare('SELECT "Title" FROM "Objectives" WHERE "Id" = :id');
        $stmt->execute(['id' => $objectiveId]);
        self::assertSame('Ship v2.1', $stmt->fetchColumn());

        $deleted = self::$objectives->delete($projectId, $objectiveId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Objectives" WHERE "Id" = :id');
        $stmt->execute(['id' => $objectiveId]);
        self::assertFalse($stmt->fetch());
    }

    public function testDeleteNonExistentObjectiveReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        self::assertFalse(self::$objectives->delete($projectId, Uuid::v4()));
    }
}
