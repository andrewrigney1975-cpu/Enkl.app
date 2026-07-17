<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Tests\Support\Http;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * PHP-tier mirror of api/Enkl.Api.Tests/AuthTests.cs — same scenarios, against the real `php -S`
 * process tests/bootstrap.php starts (real HTTP, real middleware stack: SessionValidationMiddleware /
 * JwtAuthMiddleware / RequireAuthMiddleware / OrgAdminMiddleware / ProjectMemberMiddleware / rate
 * limiting), not a direct controller call — the whole point is verifying the pipeline, matching the
 * .NET file's own stated intent.
 */
final class AuthTest extends TestCase
{
    private static PDO $db;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
    }

    public function testLoginWithValidCredentialsReturnsUsableToken(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $login['status']);
        self::assertNotEmpty($login['body']['token'] ?? null);

        // The token must actually work for a subsequent authenticated call, not just be non-empty.
        $whoAmI = Http::get('/api/projects', $login['body']['token'], ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $whoAmI['status']);
    }

    public function testLoginWithWrongPasswordReturnsUnauthorized(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user);

        $response = Http::post('/api/auth/login', ['username' => $user, 'password' => 'definitely-the-wrong-password'], null, ['X-Forwarded-For' => $ip]);
        self::assertSame(401, $response['status']);
    }

    // Security review finding H2, directly exercised: a token minted before a password change (or
    // any other event that rotates SecurityStamp) must stop working the instant the DB row changes —
    // not just eventually, at natural token expiry.
    public function testRequestWithTokenWhoseSecurityStampNoLongerMatchesLiveDbIsRejected(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        // Simulate "something else rotated this user's SecurityStamp" (a password change, a SCIM
        // deactivation, an admin-role toggle) without going through the already-issued token at all.
        self::$db->prepare('UPDATE "Users" SET "SecurityStamp" = gen_random_uuid() WHERE "Id" = :id')
            ->execute(['id' => $seeded['userId']]);

        $afterRotation = Http::get('/api/projects', $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(401, $afterRotation['status']);
    }

    public function testMustChangePasswordBlocksMutatingRequestsButNotReads(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user, mustChangePassword: true);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        self::assertTrue($login['body']['user']['mustChangePassword']);
        $token = $login['body']['token'];

        $read = Http::get('/api/projects', $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $read['status']);

        // Body content doesn't matter — the revocation/MustChangePassword middleware runs before the
        // route handler, so this 403s regardless of what a real create-project payload would need.
        $write = Http::post('/api/projects', [], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $write['status']);
    }

    public function testChangePasswordIsExemptFromItsOwnMustChangePasswordBlockAndClearsTheFlag(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user, mustChangePassword: true);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $changeResponse = Http::post('/api/auth/change-password', [
            'currentPassword' => TestDataHelper::DEFAULT_PASSWORD,
            'newPassword' => 'BrandNewPassword456!',
        ], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $changeResponse['status']);
        self::assertFalse($changeResponse['body']['user']['mustChangePassword']);

        // The fresh token this returns should now be usable for a mutating request too.
        $newToken = $changeResponse['body']['token'];
        $write = Http::post('/api/projects', [], $newToken, ['X-Forwarded-For' => $ip]);
        self::assertNotSame(403, $write['status']);
    }

    public function testTelemetryIsExemptFromMustChangePasswordBlock(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user, mustChangePassword: true);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::post('/api/telemetry/page-load', ['durationMs' => 123.4], $token, ['X-Forwarded-For' => $ip]);
        self::assertNotSame(403, $response['status']);
    }

    public function testOrgAdminPolicyRejectsNonAdminToken(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: false);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::get('/api/organisations/me', $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $response['status']);
    }

    // isOrgAdmin: false is explicit here since Org Admins now also pass ProjectMemberMiddleware (they
    // get every Project Admin capability, which is inherently also project-member-level access) —
    // this test needs a genuinely plain, non-org-admin user to isolate what it's actually testing.
    public function testProjectMemberPolicyRejectsTokenWithoutThatProjectMembership(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $projectKey = TestDataHelper::unique('PRJ');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: false);
        // Project exists in the SAME org, but the logged-in user is never added as a member of it —
        // the "projects" claim minted at login is empty, so ProjectMemberMiddleware must reject
        // regardless of same-org membership.
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey, null);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::get('/api/projects/' . $projectId, $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $response['status']);
    }

    // Project Administrator role: a plain (non-admin) project member can view the project but must
    // not be able to add a column — one of the four Project Admin capabilities. isOrgAdmin: false is
    // explicit here since Org Admins now also pass the ProjectAdmin check — this test needs a
    // genuinely plain, non-org-admin member to isolate what it's actually testing.
    public function testProjectAdminPolicyRejectsPlainMemberFromCreatingColumn(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $projectKey = TestDataHelper::unique('P');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: false);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey, $seeded['userId'], memberIsProjectAdmin: false);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $read = Http::get('/api/projects/' . $projectId, $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $read['status']);

        $response = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'New Column', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $response['status']);
    }

    public function testProjectAdminPolicyAllowsProjectAdminToCreateColumn(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $projectKey = TestDataHelper::unique('P');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey, $seeded['userId'], memberIsProjectAdmin: true);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'New Column', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $response['status']);
    }

    // Promotion/demotion takes effect on the very next request, not at next login — same live-check
    // guarantee ProjectMemberPolicy already relies on, applied to the Project Admin flag specifically.
    // isOrgAdmin: false, same reasoning as testProjectAdminPolicyRejectsPlainMemberFromCreatingColumn
    // above — must be a genuinely plain member pre-promotion for the "before" assertion to hold now
    // that Org Admins also pass.
    public function testProjectAdminPolicyPromotionTakesEffectWithoutReLogin(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $projectKey = TestDataHelper::unique('P');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: false);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey, $seeded['userId'], memberIsProjectAdmin: false);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $beforePromotion = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'Too Early', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $beforePromotion['status']);

        self::$db->prepare('UPDATE "ProjectMembers" SET "IsProjectAdmin" = true WHERE "ProjectId" = :pid AND "UserId" = :uid')
            ->execute(['pid' => $projectId, 'uid' => $seeded['userId']]);

        $afterPromotion = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'Now Allowed', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $afterPromotion['status']);
    }

    // An Org Admin gets every Project Admin capability across their own org's projects, even with no
    // ProjectMembers row for that project at all.
    public function testProjectAdminPolicyAllowsOrgAdminEvenWithoutProjectMembership(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $user = TestDataHelper::unique('user');
        $projectKey = TestDataHelper::unique('P');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: true);
        // No member argument — the Org Admin is deliberately not a ProjectMembers row at all.
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey);

        $login = Http::post('/api/auth/login', ['username' => $user, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'Org Admin Column', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $response['status']);
    }

    // Cross-org isolation (CLAUDE.md §4): an Org Admin's bypass is scoped to their OWN org's projects
    // only — the "orgId" claim is re-verified against the project's live OrganisationId, not just
    // trusted, so an Org Admin from a different org can't reach this project this way either.
    public function testProjectAdminPolicyRejectsOrgAdminFromADifferentOrganisation(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $otherOrg = TestDataHelper::unique('otherorg');
        $user = TestDataHelper::unique('user');
        $otherOrgAdmin = TestDataHelper::unique('otheradmin');
        $projectKey = TestDataHelper::unique('P');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $user, isOrgAdmin: false);
        TestDataHelper::seedOrgAndUser(self::$db, $otherOrg, $otherOrgAdmin, isOrgAdmin: true);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey);

        $login = Http::post('/api/auth/login', ['username' => $otherOrgAdmin, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];

        $response = Http::post('/api/projects/' . $projectId . '/columns', ['name' => 'Should Not Exist', 'done' => false, 'color' => null], $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(403, $response['status']);
    }
}
