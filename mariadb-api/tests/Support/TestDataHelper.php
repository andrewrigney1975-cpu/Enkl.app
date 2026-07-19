<?php

declare(strict_types=1);

namespace Enkl\Api\Tests\Support;

use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from php-api/tests/Support/TestDataHelper.php (itself the PHP-tier mirror of
 * api/Enkl.Api.Tests/TestDataHelper.cs). Every name passed in must already be unique-per-test
 * (Guid-suffixed by the caller, see unique()) since the test MariaDB instance is shared across the
 * whole run, not reset between tests.
 *
 * One real MariaDB-specific fix needed here, found live: php-api's own "Users" INSERTs never list
 * "SecurityStamp" at all, relying on Postgres's `DEFAULT gen_random_uuid()` column default (see
 * src/Db/migrations/001_initial_schema.sql's own note on why this tier has no equivalent DB-side
 * default). Every real Service on this tier already supplies its own app-generated value for that
 * column, but this test helper's raw INSERT didn't — it 500'd every single service test that seeds a
 * user (121 of 124 test methods) with "Field 'SecurityStamp' doesn't have a default value" until this
 * was caught and fixed.
 */
final class TestDataHelper
{
    public const DEFAULT_PASSWORD = 'TestPassword123!';

    /** @return array{orgId:string, userId:string} */
    public static function seedOrgAndUser(
        PDO $db,
        string $orgName,
        string $username,
        bool $isOrgAdmin = true,
        bool $mustChangePassword = false
    ): array {
        $orgId = Uuid::v4();
        $db->prepare(
            'INSERT INTO "Organisations" ("Id", "Name", "NormalizedName", "CreatedAt") VALUES (:id, :name, :normalizedName, now())'
        )->execute(['id' => $orgId, 'name' => $orgName, 'normalizedName' => strtolower($orgName)]);

        $userId = Uuid::v4();
        // NormalizedUsername MUST go through the real UsernameNormalizer (strips non-alphanumerics,
        // not just lowercases) — a hand-rolled strtolower() here would silently diverge from what
        // AuthController::login actually looks up by the moment a seeded username contains a hyphen
        // (exactly what unique() below produces), the same mismatch that made every .NET AuthTests
        // login 401 until TestDataHelper.cs was fixed to call UsernameNormalizer.Normalize() too.
        $db->prepare(<<<SQL
            INSERT INTO "Users" (
                "Id", "OrganisationId", "Username", "NormalizedUsername", "PasswordHash", "DisplayName",
                "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt", "SecurityStamp"
            ) VALUES (
                :id, :orgId, :username, :normalizedUsername, :passwordHash, :displayName,
                :mustChangePassword, :isOrgAdmin, true, now(), :securityStamp
            )
        SQL)->execute([
            'id' => $userId,
            'orgId' => $orgId,
            'username' => $username,
            'normalizedUsername' => UsernameNormalizer::normalize($username),
            'passwordHash' => PasswordHasher::hash(self::DEFAULT_PASSWORD),
            'displayName' => $username,
            'mustChangePassword' => $mustChangePassword ? 1 : 0,
            'isOrgAdmin' => $isOrgAdmin ? 1 : 0,
            'securityStamp' => Uuid::v4(),
        ]);

        return ['orgId' => $orgId, 'userId' => $userId];
    }

    /** Adds a second (third, ...) user to an ALREADY-seeded Organisation — seedOrgAndUser always
     * creates a brand-new org, so this is the one to reach for when a test needs two colleagues in
     * the SAME org (e.g. chat channel members). Mirrors TestDataHelper.cs's SeedUserInOrgAsync. */
    public static function seedUserInOrg(PDO $db, string $organisationId, string $username, bool $isOrgAdmin = false): string
    {
        $userId = Uuid::v4();
        $db->prepare(<<<SQL
            INSERT INTO "Users" (
                "Id", "OrganisationId", "Username", "NormalizedUsername", "PasswordHash", "DisplayName",
                "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt", "SecurityStamp"
            ) VALUES (
                :id, :orgId, :username, :normalizedUsername, :passwordHash, :displayName,
                false, :isOrgAdmin, true, now(), :securityStamp
            )
        SQL)->execute([
            'id' => $userId,
            'orgId' => $organisationId,
            'username' => $username,
            'normalizedUsername' => UsernameNormalizer::normalize($username),
            'passwordHash' => PasswordHasher::hash(self::DEFAULT_PASSWORD),
            'displayName' => $username,
            'isOrgAdmin' => $isOrgAdmin ? 1 : 0,
            'securityStamp' => Uuid::v4(),
        ]);
        return $userId;
    }

    public static function seedProject(PDO $db, string $organisationId, string $key, ?string $memberUserId = null, bool $memberIsProjectAdmin = false): string
    {
        $projectId = Uuid::v4();
        $db->prepare(<<<SQL
            INSERT INTO "Projects" ("Id", "OrganisationId", "Name", "Key", "DateCreated", "DateLastModified", "TaskCounter")
            VALUES (:id, :orgId, :name, :key, now(), now(), 1)
        SQL)->execute(['id' => $projectId, 'orgId' => $organisationId, 'name' => $key, 'key' => $key]);

        if ($memberUserId !== null) {
            $db->prepare(
                'INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color", "IsProjectAdmin") VALUES (:id, :pid, :uid, :color, :isProjectAdmin)'
            )->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'uid' => $memberUserId, 'color' => '#4f46e5', 'isProjectAdmin' => (int) $memberIsProjectAdmin]);
        }

        return $projectId;
    }

    /** Unique-per-call suffix — an 8-hex-char segment of a v4 UUID, short by design (see
     *  AuthTests.cs's Unique() for the .NET twin of this helper). */
    public static function unique(string $prefix): string
    {
        return $prefix . '-' . substr(str_replace('-', '', Uuid::v4()), 0, 8);
    }

    /**
     * RateLimitMiddleware (see its own doc comment) partitions purely by client IP + policy name, DB-
     * backed and shared across this whole test run — with no per-test isolation, AuthTest's several
     * logins-per-test would otherwise trip the "auth" policy's 10/min limit by the 4th or 5th test.
     * A monotonically-increasing fake X-Forwarded-For per test (this PHPUnit process is single-
     * threaded, so a static counter is safely unique across every call in the whole run) sidesteps it
     * without weakening RateLimitMiddleware.php itself or its own test coverage elsewhere.
     */
    public static function uniqueIp(): string
    {
        static $counter = 0;
        $counter++;
        return sprintf('10.%d.%d.%d', ($counter >> 16) & 0xff, ($counter >> 8) & 0xff, $counter & 0xff);
    }
}
