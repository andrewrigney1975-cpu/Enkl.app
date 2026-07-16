<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TeamCommitteeService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for TeamCommitteeService — update()/delete()/applyOrgTeam() got
 * beginTransaction()/commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1).
 * create() itself was not wrapped (single INSERT + setMembers(), no observed gap flagged in the
 * review), covered here anyway as part of the round trip.
 */
final class TeamCommitteeServiceTest extends TestCase
{
    private static PDO $db;
    private static TeamCommitteeService $teams;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$teams = new TeamCommitteeService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'), $seeded['userId']);

        $memberStmt = self::$db->prepare('SELECT "Id" FROM "ProjectMembers" WHERE "ProjectId" = :pid');
        $memberStmt->execute(['pid' => $projectId]);
        $memberId = $memberStmt->fetchColumn();

        $created = self::$teams->create($projectId, ['name' => 'Engineering', 'type' => 'team', 'memberIds' => [$memberId]]);
        self::assertNotNull($created);
        self::assertSame('Engineering', $created['name']);
        self::assertSame([$memberId], $created['memberIds']);
        $teamId = $created['id'];

        $updated = self::$teams->update($projectId, $teamId, ['name' => 'Engineering Guild', 'type' => 'team', 'memberIds' => []]);
        self::assertNotNull($updated);
        self::assertSame('Engineering Guild', $updated['name']);
        self::assertSame([], $updated['memberIds']);

        $stmt = self::$db->prepare('SELECT "Name" FROM "TeamsCommittees" WHERE "Id" = :id');
        $stmt->execute(['id' => $teamId]);
        self::assertSame('Engineering Guild', $stmt->fetchColumn());

        $deleted = self::$teams->delete($projectId, $teamId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "TeamsCommittees" WHERE "Id" = :id');
        $stmt->execute(['id' => $teamId]);
        self::assertFalse($stmt->fetch());
    }

    public function testUpdateParentCycleThrowsValidationException(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $a = self::$teams->create($projectId, ['name' => 'A', 'type' => 'team']);
        $b = self::$teams->create($projectId, ['name' => 'B', 'type' => 'team', 'parentId' => $a['id']]);

        $this->expectException(ApiValidationException::class);
        self::$teams->update($projectId, $a['id'], ['name' => 'A', 'type' => 'team', 'parentId' => $b['id']]);
    }

    public function testDeleteOrphansChildren(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $parent = self::$teams->create($projectId, ['name' => 'Parent', 'type' => 'team']);
        $child = self::$teams->create($projectId, ['name' => 'Child', 'type' => 'team', 'parentId' => $parent['id']]);
        self::assertSame($parent['id'], $child['parentId']);

        self::$teams->delete($projectId, $parent['id']);

        $stmt = self::$db->prepare('SELECT "ParentId" FROM "TeamsCommittees" WHERE "Id" = :id');
        $stmt->execute(['id' => $child['id']]);
        self::assertNull($stmt->fetchColumn());
    }

    public function testApplyOrgTeamCreatesTeamCommitteeAndProjectMembers(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        // Insert a second user directly into the project's own org (seedOrgAndUser always creates a
        // fresh org per call, which wouldn't be org-scoped correctly for this OrgTeam).
        $memberUserId = Uuid::v4();
        self::$db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt")
            VALUES (:id, :orgId, :username, :username, :hash, :displayName, false, false, true, now())
        SQL)->execute([
            'id' => $memberUserId, 'orgId' => $seeded['orgId'], 'username' => TestDataHelper::unique('teammate'),
            'hash' => 'x', 'displayName' => 'Teammate',
        ]);

        $orgTeamId = Uuid::v4();
        self::$db->prepare('INSERT INTO "OrgTeams" ("Id", "OrganisationId", "Name", "DateCreated", "DateLastModified") VALUES (:id, :orgId, :name, now(), now())')
            ->execute(['id' => $orgTeamId, 'orgId' => $seeded['orgId'], 'name' => 'Org Team']);
        self::$db->prepare('INSERT INTO "OrgTeamMember" ("OrgTeamId", "UserId") VALUES (:tid, :uid)')
            ->execute(['tid' => $orgTeamId, 'uid' => $memberUserId]);

        $result = self::$teams->applyOrgTeam($projectId, $orgTeamId);
        self::assertNotNull($result);
        self::assertSame('Org Team', $result['teamCommittee']['name']);
        self::assertCount(1, $result['teamCommittee']['memberIds']);

        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
        $stmt->execute(['pid' => $projectId, 'uid' => $memberUserId]);
        self::assertNotFalse($stmt->fetch());

        // Re-running is safe/idempotent — no duplicate ProjectMember or TeamCommitteeMember rows.
        $second = self::$teams->applyOrgTeam($projectId, $orgTeamId);
        self::assertSame($result['teamCommittee']['id'], $second['teamCommittee']['id']);
        self::assertCount(1, $second['teamCommittee']['memberIds']);
    }
}
