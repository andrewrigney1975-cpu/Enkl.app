<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\MemberService;
use Enkl\Api\Services\ProjectService;
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
 *
 * Also covers the Project Administrator role: the "project owner is by default a Project Admin"
 * default (ProjectService::create), setProjectAdmin()'s promote/demote, and the last-admin guard (a
 * project must always keep at least one Project Admin, or nobody left could ever reach the "manage
 * team members" capability that grants the role at all) on both the demote and delete paths.
 */
final class MemberServiceTest extends TestCase
{
    private static PDO $db;
    private static MemberService $members;
    private static ProjectService $projects;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$members = new MemberService(self::$db);
        self::$projects = new ProjectService(self::$db);
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

    public function testProjectServiceCreateMakesCreatorAProjectAdmin(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        $result = self::$projects->create($seeded['userId'], ['name' => 'New Project', 'key' => TestDataHelper::unique('P')]);

        self::assertNotNull($result);
        $member = current(array_filter($result['project']['members'], static fn(array $m): bool => $m['userId'] === $seeded['userId']));
        self::assertNotFalse($member);
        self::assertTrue($member['isProjectAdmin']);
    }

    public function testSetProjectAdminPromotesAndDemotesWhenAnotherAdminRemains(): void
    {
        $org = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('owner'));
        $projectId = TestDataHelper::seedProject(self::$db, $org['orgId'], TestDataHelper::unique('P'), $org['userId'], memberIsProjectAdmin: true);
        $other = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('other'));

        $secondMemberId = Uuid::v4();
        self::$db->prepare('INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color") VALUES (:id, :pid, :uid, :color)')
            ->execute(['id' => $secondMemberId, 'pid' => $projectId, 'uid' => $other['userId'], 'color' => '#123456']);

        $promoted = self::$members->setProjectAdmin($projectId, $secondMemberId, true);
        self::assertNotNull($promoted);
        self::assertTrue($promoted['isProjectAdmin']);

        $ownerMemberId = self::ownerMemberId($projectId, $org['userId']);
        $demoted = self::$members->setProjectAdmin($projectId, $ownerMemberId, false);
        self::assertNotNull($demoted);
        self::assertFalse($demoted['isProjectAdmin']);
    }

    public function testSetProjectAdminRejectsDemotingTheOnlyProjectAdmin(): void
    {
        $org = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('owner'));
        $projectId = TestDataHelper::seedProject(self::$db, $org['orgId'], TestDataHelper::unique('P'), $org['userId'], memberIsProjectAdmin: true);
        $ownerMemberId = self::ownerMemberId($projectId, $org['userId']);

        $this->expectException(ApiValidationException::class);
        $this->expectExceptionMessageMatches('/at least one Project Admin/');
        self::$members->setProjectAdmin($projectId, $ownerMemberId, false);
    }

    public function testDeleteRejectsRemovingTheOnlyProjectAdmin(): void
    {
        $org = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('owner'));
        $projectId = TestDataHelper::seedProject(self::$db, $org['orgId'], TestDataHelper::unique('P'), $org['userId'], memberIsProjectAdmin: true);
        $ownerMemberId = self::ownerMemberId($projectId, $org['userId']);

        $this->expectException(ApiValidationException::class);
        self::$members->delete($projectId, $ownerMemberId);
    }

    public function testDeleteAllowsRemovingAProjectAdminWhenAnotherRemains(): void
    {
        $org = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('owner'));
        $projectId = TestDataHelper::seedProject(self::$db, $org['orgId'], TestDataHelper::unique('P'), $org['userId'], memberIsProjectAdmin: true);
        $other = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('other'));

        $secondMemberId = Uuid::v4();
        self::$db->prepare('INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color", "IsProjectAdmin") VALUES (:id, :pid, :uid, :color, true)')
            ->execute(['id' => $secondMemberId, 'pid' => $projectId, 'uid' => $other['userId'], 'color' => '#123456']);

        $ownerMemberId = self::ownerMemberId($projectId, $org['userId']);
        $deleted = self::$members->delete($projectId, $ownerMemberId);

        self::assertTrue($deleted);
        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id');
        $stmt->execute(['id' => $ownerMemberId]);
        self::assertFalse($stmt->fetch());
    }

    private static function ownerMemberId(string $projectId, string $userId): string
    {
        $stmt = self::$db->prepare('SELECT "Id" FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
        $stmt->execute(['pid' => $projectId, 'uid' => $userId]);
        return $stmt->fetchColumn();
    }
}
