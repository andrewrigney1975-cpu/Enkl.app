<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\RiskService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for RiskService — create()/update() got beginTransaction()/commit()/
 * rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1): the Risks row plus
 * setLinks()'s Document/Principle/Objective junction-table writes.
 */
final class RiskServiceTest extends TestCase
{
    private static PDO $db;
    private static RiskService $risks;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$risks = new RiskService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$risks->create($projectId, ['title' => 'Vendor lock-in', 'likelihood' => 3, 'impact' => 4, 'status' => 'new']);
        self::assertNotNull($created);
        self::assertSame('Vendor lock-in', $created['title']);
        self::assertSame(3, $created['likelihood']);
        self::assertSame(4, $created['impact']);
        $riskId = $created['id'];

        $updated = self::$risks->update($projectId, $riskId, ['title' => 'Vendor lock-in (mitigated)', 'likelihood' => 1, 'impact' => 4, 'status' => 'closed']);
        self::assertNotNull($updated);
        self::assertSame(1, $updated['likelihood']);
        self::assertSame('closed', $updated['status']);

        $stmt = self::$db->prepare('SELECT "Status" FROM "Risks" WHERE "Id" = :id');
        $stmt->execute(['id' => $riskId]);
        self::assertSame('closed', $stmt->fetchColumn());

        $deleted = self::$risks->delete($projectId, $riskId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Risks" WHERE "Id" = :id');
        $stmt->execute(['id' => $riskId]);
        self::assertFalse($stmt->fetch());
    }

    public function testLikelihoodAndImpactAreClampedToOneToFive(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$risks->create($projectId, ['title' => 'X', 'likelihood' => 99, 'impact' => -5]);
        self::assertSame(5, $created['likelihood']);
        self::assertSame(1, $created['impact']);
    }

    public function testDeleteNonExistentRiskReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        self::assertFalse(self::$risks->delete($projectId, Uuid::v4()));
    }
}
