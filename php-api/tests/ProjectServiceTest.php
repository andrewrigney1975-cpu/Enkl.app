<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ProjectService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ProjectService::create — the ARCHITECTURE-REVIEW.md finding 3.1
 * write-up's own named example of the transaction-wrap gap: Project INSERT -> ProjectMember INSERT
 * -> several Column/TaskType INSERTs (+ optional Workflow UPDATE if a template was used) used to run
 * as separately auto-committed statements.
 */
final class ProjectServiceTest extends TestCase
{
    private static PDO $db;
    private static ProjectService $projects;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$projects = new ProjectService(self::$db);
    }

    public function testCreateSeedsDefaultColumnsAndTaskTypesAndAddsCallerAsMember(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $key = TestDataHelper::unique('PRJ');

        $result = self::$projects->create($seeded['userId'], ['name' => 'My New Project', 'key' => $key]);
        self::assertNotNull($result);
        self::assertNotEmpty($result['token']);
        self::assertNull($result['warning']);

        $project = $result['project'];
        self::assertSame('My New Project', $project['name']);
        self::assertCount(3, $project['columns']);
        self::assertCount(2, $project['taskTypes']);
        self::assertCount(1, $project['members']);
        $projectId = $project['id'];

        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
        $stmt->execute(['pid' => $projectId, 'uid' => $seeded['userId']]);
        self::assertNotFalse($stmt->fetch());

        $updated = self::$projects->update($projectId, ['name' => 'Renamed Project', 'key' => $key]);
        self::assertNotNull($updated);
        self::assertSame('Renamed Project', $updated['name']);

        $stmt = self::$db->prepare('SELECT "Name" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        self::assertSame('Renamed Project', $stmt->fetchColumn());

        $deleted = self::$projects->delete($projectId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateWithDuplicateKeyInSameOrgAutoSuffixesWithWarning(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $key = TestDataHelper::unique('DUP');

        self::$projects->create($seeded['userId'], ['name' => 'First', 'key' => $key]);
        $second = self::$projects->create($seeded['userId'], ['name' => 'Second', 'key' => $key]);

        self::assertNotNull($second['warning']);
        self::assertNotSame($key, $second['project']['key']);
    }

    public function testCreateForNonExistentUserReturnsNull(): void
    {
        self::assertNull(self::$projects->create(Uuid::v4(), ['name' => 'X', 'key' => TestDataHelper::unique('KEY')]));
    }
}
