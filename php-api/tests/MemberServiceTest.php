<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\MemberService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for MemberService — create()/update()/delete() all got
 * beginTransaction()/commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1).
 * create() is the interesting one: it does a find-or-create-User-by-name dance and requires an email
 * for a brand-new user (EmailValidation::validateAndNormalize with requireEmail: true).
 */
final class MemberServiceTest extends TestCase
{
    private static PDO $db;
    private static MemberService $members;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$members = new MemberService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $memberName = TestDataHelper::unique('Alice');
        $email = TestDataHelper::unique('alice') . '@example.com';
        $created = self::$members->create($projectId, ['name' => $memberName, 'email' => $email]);
        self::assertNotNull($created);
        self::assertSame($memberName, $created['displayName']);
        self::assertSame($email, $created['email']);
        $memberId = $created['id'];

        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $memberId, 'pid' => $projectId]);
        self::assertNotFalse($stmt->fetch());

        $updated = self::$members->update($projectId, $memberId, ['name' => 'Alice Updated', 'role' => 'Engineer', 'allocatedFraction' => 50]);
        self::assertNotNull($updated);
        self::assertSame('Alice Updated', $updated['displayName']);
        self::assertSame('Engineer', $updated['role']);
        self::assertSame(50, $updated['allocatedFraction']);

        $stmt = self::$db->prepare('SELECT "Role" FROM "ProjectMembers" WHERE "Id" = :id');
        $stmt->execute(['id' => $memberId]);
        self::assertSame('Engineer', $stmt->fetchColumn());

        $deleted = self::$members->delete($projectId, $memberId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id');
        $stmt->execute(['id' => $memberId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateWithoutEmailThrowsValidationException(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $this->expectException(ApiValidationException::class);
        self::$members->create($projectId, ['name' => TestDataHelper::unique('NoEmail')]);
    }

    public function testCreateDuplicateNameInSameProjectThrowsValidationException(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $memberName = TestDataHelper::unique('Bob');
        self::$members->create($projectId, ['name' => $memberName, 'email' => TestDataHelper::unique('bob') . '@example.com']);

        $this->expectException(ApiValidationException::class);
        self::$members->create($projectId, ['name' => $memberName, 'email' => TestDataHelper::unique('bob2') . '@example.com']);
    }

    public function testDeleteNonExistentMemberReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        self::assertFalse(self::$members->delete($projectId, Uuid::v4()));
    }

    public function testUpdateReportsToUnlinkedOnDelete(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('PRJ'));

        $manager = self::$members->create($projectId, ['name' => TestDataHelper::unique('Manager'), 'email' => TestDataHelper::unique('mgr') . '@example.com']);
        $report = self::$members->create($projectId, ['name' => TestDataHelper::unique('Report'), 'email' => TestDataHelper::unique('rep') . '@example.com']);

        $updatedReport = self::$members->update($projectId, $report['id'], ['name' => 'Report', 'reportsToId' => $manager['id']]);
        self::assertSame($manager['id'], $updatedReport['reportsToId']);

        self::$members->delete($projectId, $manager['id']);

        $stmt = self::$db->prepare('SELECT "ReportsToId" FROM "ProjectMembers" WHERE "Id" = :id');
        $stmt->execute(['id' => $report['id']]);
        self::assertNull($stmt->fetchColumn() ?: null);
    }
}
