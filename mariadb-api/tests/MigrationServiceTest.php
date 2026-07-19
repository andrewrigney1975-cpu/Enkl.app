<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Db\Database;
use Enkl\Api\Services\MigrationService;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * PHP-tier mirror of api/Enkl.Api.Tests/MigrationServiceTests.cs — MigrationService.php (see its own
 * docblock: import dedup/wiring/cycle-detection, ported from the .NET service) is complex and
 * security-sensitive enough to prioritize early, same reasoning as the .NET file. Calls the service
 * directly (resolved with the shared Database::connection(), the same PDO instance tests/bootstrap.php
 * already migrated), not HTTP — what's under test is the service's own logic, not the HTTP/auth
 * pipeline (that's AuthTest.php's job).
 */
final class MigrationServiceTest extends TestCase
{
    private static PDO $db;
    private static MigrationService $migration;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$migration = new MigrationService(self::$db);
    }

    /** @param list<array<string,mixed>> $members */
    private static function buildRequest(string $orgName, string $projectKey, array $members, ?array $hierarchy = null): array
    {
        return [
            'organisationName' => $orgName,
            'project' => ['key' => $projectKey, 'name' => $projectKey],
            'members' => $members,
            // CreateTasks (MigrationService.php) looks columns up by "name", not any id field — every
            // task fixture in this file sets 'column' => 'c1', so this must be 'c1' too, or the task
            // is silently skipped as "column not found" with only a warning, no exception. This
            // exact mismatch masked the .NET tier's own cycle-detection test until it was fixed (see
            // MigrationServiceTests.cs's BuildRequest for the full story).
            'columns' => [['name' => 'c1', 'done' => false, 'color' => null, 'order' => 0]],
            'hierarchy' => $hierarchy ?? [],
        ];
    }

    public function testMigrateNewOrgNameBootstrapsOrgAndMakesFirstMemberAdmin(): void
    {
        $orgName = TestDataHelper::unique('org');
        $request = self::buildRequest($orgName, TestDataHelper::unique('PRJ'), [
            ['id' => 'm1', 'name' => 'First Admin', 'color' => '#4f46e5'],
        ]);

        $result = self::$migration->migrate($request, null);

        self::assertTrue($result['organisationCreated']);
        self::assertSame(1, $result['usersCreated']);

        $stmt = self::$db->prepare('SELECT "IsOrgAdmin" FROM "Users" WHERE "OrganisationId" = :orgId');
        $stmt->execute(['orgId' => $result['organisationId']]);
        self::assertTrue((bool) $stmt->fetchColumn());
    }

    // Security review finding C3: the exact vector that fix closed — an anonymous caller could
    // previously get a login-capable account silently created inside ANY org whose display name they
    // knew or guessed.
    public function testMigrateAnonymousCallerTargetingExistingOrgNameThrowsValidationException(): void
    {
        $orgName = TestDataHelper::unique('org');
        $bootstrapRequest = self::buildRequest($orgName, TestDataHelper::unique('PRJ'), [
            ['id' => 'm1', 'name' => 'Original Admin', 'color' => '#4f46e5'],
        ]);
        self::$migration->migrate($bootstrapRequest, null);

        $intruderRequest = self::buildRequest($orgName, TestDataHelper::unique('PRJ'), [
            ['id' => 'm1', 'name' => 'Uninvited', 'color' => '#4f46e5'],
        ]);

        $this->expectException(ApiValidationException::class);
        self::$migration->migrate($intruderRequest, null);
    }

    public function testMigrateAuthenticatedCallerAlwaysLandsInOwnOrgRegardlessOfDocumentOrgName(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        $request = self::buildRequest(
            TestDataHelper::unique('some-other-org-entirely'),
            TestDataHelper::unique('PRJ'),
            [['id' => 'm1', 'name' => 'Second Project Owner', 'color' => '#4f46e5']]
        );

        $result = self::$migration->migrate($request, $seeded['orgId']);

        self::assertFalse($result['organisationCreated']);
        self::assertSame($seeded['orgId'], $result['organisationId']);
    }

    public function testMigrateDuplicateUsernameWithinSameOrgIsMatchedNotDuplicated(): void
    {
        $memberName = TestDataHelper::unique('Alice');
        $orgName = TestDataHelper::unique('org');
        $first = self::$migration->migrate(
            self::buildRequest($orgName, TestDataHelper::unique('PRJ1'), [['id' => 'm1', 'name' => $memberName, 'color' => '#4f46e5']]),
            null
        );

        $second = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('unused-name'), TestDataHelper::unique('PRJ2'), [['id' => 'm1', 'name' => $memberName, 'color' => '#4f46e5']]),
            $first['organisationId']
        );

        self::assertSame(0, $second['usersCreated']);
        self::assertSame(1, $second['usersMatched']);

        $stmt = self::$db->prepare('SELECT COUNT(*) FROM "Users" WHERE "OrganisationId" = :orgId AND "NormalizedUsername" = :n');
        $stmt->execute(['orgId' => $first['organisationId'], 'n' => UsernameNormalizer::normalize($memberName)]);
        self::assertSame(1, (int) $stmt->fetchColumn());
    }

    public function testMigrateSameUsernameAcrossDifferentOrgsGetsSuffixedWithWarningNotMergedCrossTenant(): void
    {
        $memberName = TestDataHelper::unique('Bob');
        $firstOrgResult = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('org-a'), TestDataHelper::unique('PRJ1'), [['id' => 'm1', 'name' => $memberName, 'color' => '#4f46e5']]),
            null
        );

        $secondOrgResult = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('org-b'), TestDataHelper::unique('PRJ2'), [['id' => 'm1', 'name' => $memberName, 'color' => '#4f46e5']]),
            null
        );

        self::assertSame(1, $secondOrgResult['usersCreated']);
        self::assertTrue(self::containsSubstring($secondOrgResult['warnings'], 'already exists in another organisation'));

        $stmt = self::$db->prepare('SELECT "NormalizedUsername" FROM "Users" WHERE "OrganisationId" = :orgId');
        $stmt->execute(['orgId' => $secondOrgResult['organisationId']]);
        $secondUsername = $stmt->fetchColumn();
        $stmt->execute(['orgId' => $firstOrgResult['organisationId']]);
        $firstUsername = $stmt->fetchColumn();
        self::assertNotSame($firstUsername, $secondUsername);
    }

    public function testMigrateTaskHierarchyWithDependencyCycleThrowsValidationException(): void
    {
        $taskA = [
            'id' => 't1', 'key' => 'CYC-1', 'title' => 'Task A', 'priority' => 'medium', 'column' => 'c1',
            'dependsOn' => ['CYC-2'],
        ];
        $taskB = ['id' => 't2', 'key' => 'CYC-2', 'title' => 'Task B', 'priority' => 'medium', 'column' => 'c1', 'dependsOn' => ['CYC-1']];

        $request = self::buildRequest(
            TestDataHelper::unique('org'),
            TestDataHelper::unique('PRJ'),
            [['id' => 'm1', 'name' => 'Owner', 'color' => '#4f46e5']],
            [$taskA, $taskB]
        );

        $this->expectException(ApiValidationException::class);
        self::$migration->migrate($request, null);
    }

    // Regression coverage for a real gap found while writing this suite: MigrationService.php's own
    // resolveUniqueProjectKey() assumes org-scoped key uniqueness (it queries
    // WHERE "Key" = :key AND "OrganisationId" = :orgId), but the schema's unique index on
    // Projects.Key was global until 020_scope_project_key_uniqueness_to_organisation.sql — meaning
    // two DIFFERENT organisations importing the same project key (e.g. every fresh install's default
    // "SMPL") previously hit a raw DB constraint violation (409) instead of this auto-suffix path.
    public function testMigrateProjectKeyCollisionAcrossDifferentOrgsDoesNotConflict(): void
    {
        $projectKey = TestDataHelper::unique('DUP');
        $first = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('org-a'), $projectKey, [['id' => 'm1', 'name' => 'Owner', 'color' => '#4f46e5']]),
            null
        );

        $second = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('org-b'), $projectKey, [['id' => 'm1', 'name' => 'Owner', 'color' => '#4f46e5']]),
            null
        );

        $stmt = self::$db->prepare('SELECT "Key" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $second['projectId']]);
        self::assertSame($projectKey, $stmt->fetchColumn());
    }

    public function testMigrateProjectKeyCollisionWithinOrgGetsAutoSuffixedWithWarning(): void
    {
        $projectKey = TestDataHelper::unique('DUP');
        $first = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('org'), $projectKey, [['id' => 'm1', 'name' => 'Owner', 'color' => '#4f46e5']]),
            null
        );

        $second = self::$migration->migrate(
            self::buildRequest(TestDataHelper::unique('unused-name'), $projectKey, [['id' => 'm2', 'name' => 'Second Owner', 'color' => '#4f46e5']]),
            $first['organisationId']
        );

        self::assertTrue(self::containsSubstring($second['warnings'], 'already in use'));

        $stmt = self::$db->prepare('SELECT "Key" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $second['projectId']]);
        self::assertNotSame($projectKey, $stmt->fetchColumn());
    }

    /** @param list<string> $warnings */
    private static function containsSubstring(array $warnings, string $needle): bool
    {
        foreach ($warnings as $warning) {
            if (stripos($warning, $needle) !== false) {
                return true;
            }
        }
        return false;
    }
}
