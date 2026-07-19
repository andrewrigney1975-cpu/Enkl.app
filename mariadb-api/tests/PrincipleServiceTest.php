<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PrincipleService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for PrincipleService — not transaction-wrapped this session
 * (single-statement create/update/delete/share), but had zero coverage before this pass.
 */
final class PrincipleServiceTest extends TestCase
{
    private static PDO $db;
    private static PrincipleService $principles;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$principles = new PrincipleService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$principles->create($projectId, ['title' => 'Simplicity first', 'description' => 'Prefer simple solutions']);
        self::assertNotNull($created);
        self::assertSame('Simplicity first', $created['title']);
        self::assertFalse($created['isOrganisationWide']);
        $principleId = $created['id'];

        $updated = self::$principles->update($projectId, $principleId, ['title' => 'Simplicity always', 'description' => 'Revised']);
        self::assertNotNull($updated);
        self::assertSame('Simplicity always', $updated['title']);

        $stmt = self::$db->prepare('SELECT "Title" FROM "Principles" WHERE "Id" = :id');
        $stmt->execute(['id' => $principleId]);
        self::assertSame('Simplicity always', $stmt->fetchColumn());

        $deleted = self::$principles->delete($projectId, $principleId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id');
        $stmt->execute(['id' => $principleId]);
        self::assertFalse($stmt->fetch());
    }

    public function testShareTogglesOrganisationWideAndCopyClonesIntoTargetProject(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $targetProjectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P2'));

        $principle = self::$principles->create($projectId, ['title' => 'Shared Principle']);
        $shared = self::$principles->share($projectId, $principle['id'], ['isOrganisationWide' => true]);
        self::assertTrue($shared['isOrganisationWide']);

        $wideList = self::$principles->listOrganisationWide($seeded['orgId']);
        self::assertNotEmpty(array_filter($wideList, static fn(array $p): bool => $p['id'] === $principle['id']));

        $copy = self::$principles->copy($seeded['orgId'], $principle['id'], ['targetProjectId' => $targetProjectId]);
        self::assertNotNull($copy);
        self::assertSame('Shared Principle', $copy['title']);
        self::assertNotSame($principle['id'], $copy['id']);

        $stmt = self::$db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $copy['id'], 'pid' => $targetProjectId]);
        self::assertNotFalse($stmt->fetch());
    }

    public function testDeleteNonExistentPrincipleReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        self::assertFalse(self::$principles->delete($projectId, Uuid::v4()));
    }
}
