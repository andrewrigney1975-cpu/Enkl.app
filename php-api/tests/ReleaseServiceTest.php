<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ReleaseService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ReleaseService — not transaction-wrapped this session (single-
 * statement create/update/delete, nothing to wrap), but had zero coverage before this pass.
 */
final class ReleaseServiceTest extends TestCase
{
    private static PDO $db;
    private static ReleaseService $releases;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$releases = new ReleaseService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $created = self::$releases->create($projectId, ['name' => 'v1.0', 'status' => 'pending']);
        self::assertNotNull($created);
        self::assertSame('v1.0', $created['name']);
        self::assertSame('pending', $created['status']);
        $releaseId = $created['id'];

        $updated = self::$releases->update($projectId, $releaseId, ['name' => 'v1.0', 'status' => 'deployed']);
        self::assertNotNull($updated);
        self::assertSame('deployed', $updated['status']);

        $stmt = self::$db->prepare('SELECT "Status" FROM "Releases" WHERE "Id" = :id');
        $stmt->execute(['id' => $releaseId]);
        self::assertSame('deployed', $stmt->fetchColumn());

        $deleted = self::$releases->delete($projectId, $releaseId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Releases" WHERE "Id" = :id');
        $stmt->execute(['id' => $releaseId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateWithInvalidStatusFallsBackToPending(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $created = self::$releases->create($projectId, ['name' => 'v2.0', 'status' => 'not-a-status']);
        self::assertSame('pending', $created['status']);
    }

    public function testDeleteNonExistentReleaseReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertFalse(self::$releases->delete($projectId, Uuid::v4()));
    }
}
