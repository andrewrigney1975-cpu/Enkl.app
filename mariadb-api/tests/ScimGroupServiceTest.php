<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ScimGroupService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ScimGroupService — create()/replace()/patch() got
 * beginTransaction()/commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1).
 * Takes $orgId, not $projectId — this maps SCIM's Groups resource onto OrgTeam/OrgTeamMember.
 * Request shapes follow real SCIM (see ScimGroupsController.php).
 */
final class ScimGroupServiceTest extends TestCase
{
    private static PDO $db;
    private static ScimGroupService $groups;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$groups = new ScimGroupService(self::$db);
    }

    private static function seedScimUser(string $orgId, string $displayName): string
    {
        $userId = Uuid::v4();
        // MariaDB port: two fixes needed here — (1) "SecurityStamp" has no DB-side default (see
        // TestDataHelper's own note); (2) PDO_MYSQL's native prepared statements (unlike PDO_PGSQL)
        // reject the same named placeholder appearing twice in one query ("Invalid parameter
        // number") — php-api's original reuses `:username` for both "Username" and
        // "NormalizedUsername", which needs its own separate placeholder here even though both bind
        // the identical value.
        $username = TestDataHelper::unique('scimuser');
        self::$db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt", "SecurityStamp")
            VALUES (:id, :orgId, :username, :normalizedUsername, 'x', :displayName, false, false, true, now(), :securityStamp)
        SQL)->execute(['id' => $userId, 'orgId' => $orgId, 'username' => $username, 'normalizedUsername' => $username, 'displayName' => $displayName, 'securityStamp' => Uuid::v4()]);
        return $userId;
    }

    public function testCreateReplacePatchDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $userId = self::seedScimUser($seeded['orgId'], 'Scim User One');

        $created = self::$groups->create($seeded['orgId'], [
            'displayName' => 'Engineering', 'members' => [['value' => $userId]],
        ]);
        self::assertSame('Engineering', $created['displayName']);
        self::assertCount(1, $created['members']);
        $groupId = $created['id'];

        $replaced = self::$groups->replace($seeded['orgId'], $groupId, ['displayName' => 'Engineering Team', 'members' => []]);
        self::assertNotNull($replaced);
        self::assertSame('Engineering Team', $replaced['displayName']);
        self::assertCount(0, $replaced['members']);

        $stmt = self::$db->prepare('SELECT "Name" FROM "OrgTeams" WHERE "Id" = :id');
        $stmt->execute(['id' => $groupId]);
        self::assertSame('Engineering Team', $stmt->fetchColumn());

        $patched = self::$groups->patch($seeded['orgId'], $groupId, [
            'Operations' => [['op' => 'add', 'path' => 'members', 'value' => [['value' => $userId]]]],
        ]);
        self::assertNotNull($patched);
        self::assertCount(1, $patched['members']);

        $deleted = self::$groups->delete($seeded['orgId'], $groupId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "OrgTeams" WHERE "Id" = :id');
        $stmt->execute(['id' => $groupId]);
        self::assertFalse($stmt->fetch());
    }

    public function testPatchRemoveTargetedMember(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $userId = self::seedScimUser($seeded['orgId'], 'Scim User Two');

        $created = self::$groups->create($seeded['orgId'], ['displayName' => 'QA', 'members' => [['value' => $userId]]]);
        self::assertCount(1, $created['members']);

        $patched = self::$groups->patch($seeded['orgId'], $created['id'], [
            'Operations' => [['op' => 'remove', 'path' => 'members[value eq "' . $userId . '"]']],
        ]);
        self::assertNotNull($patched);
        self::assertCount(0, $patched['members']);
    }

    public function testCreateWithEmptyDisplayNameFallsBackToDefault(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $created = self::$groups->create($seeded['orgId'], []);
        self::assertSame('Unnamed Team', $created['displayName']);
    }

    public function testGetAndDeleteReturnNullFalseForForeignOrg(): void
    {
        $seededA = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-a'), TestDataHelper::unique('user'));
        $seededB = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-b'), TestDataHelper::unique('user'));
        $created = self::$groups->create($seededA['orgId'], ['displayName' => 'A Team']);

        self::assertNull(self::$groups->get($seededB['orgId'], $created['id']));
        self::assertFalse(self::$groups->delete($seededB['orgId'], $created['id']));
    }
}
