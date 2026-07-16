<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\DecisionService;
use Enkl\Api\Services\DocumentService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for DecisionService — create()/update() got beginTransaction()/
 * commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1): the Decisions row
 * INSERT/UPDATE plus setLinks()'s four junction-table writes (Document/Risk/Principle/Objective).
 * delete() was not touched (single DELETE, nothing to wrap) but is covered here too for completeness.
 */
final class DecisionServiceTest extends TestCase
{
    private static PDO $db;
    private static DecisionService $decisions;
    private static DocumentService $documents;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$decisions = new DecisionService(self::$db);
        self::$documents = new DocumentService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $doc = self::$documents->create($projectId, ['title' => 'Doc 1']);

        $created = self::$decisions->create($projectId, [
            'title' => 'Adopt Postgres', 'type' => 'technical', 'status' => 'open', 'documentIds' => [$doc['id']],
        ]);
        self::assertNotNull($created);
        self::assertSame('Adopt Postgres', $created['title']);
        self::assertSame('technical', $created['type']);
        self::assertSame([$doc['id']], $created['documentIds']);
        $decisionId = $created['id'];

        $updated = self::$decisions->update($projectId, $decisionId, ['title' => 'Adopt Postgres 16', 'type' => 'technical', 'status' => 'completed', 'documentIds' => []]);
        self::assertNotNull($updated);
        self::assertSame('Adopt Postgres 16', $updated['title']);
        self::assertSame('completed', $updated['status']);
        self::assertSame([], $updated['documentIds']);

        $stmt = self::$db->prepare('SELECT COUNT(*) FROM "DecisionDocument" WHERE "DecisionId" = :id');
        $stmt->execute(['id' => $decisionId]);
        self::assertSame(0, (int) $stmt->fetchColumn());

        $deleted = self::$decisions->delete($projectId, $decisionId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Decisions" WHERE "Id" = :id');
        $stmt->execute(['id' => $decisionId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateWithInvalidTypeAndStatusFallsBackToDefaults(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$decisions->create($projectId, ['title' => 'X', 'type' => 'not-a-type', 'status' => 'not-a-status']);
        self::assertSame('operational', $created['type']);
        self::assertSame('open', $created['status']);
    }

    public function testDeleteNonExistentDecisionReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        self::assertFalse(self::$decisions->delete($projectId, Uuid::v4()));
    }
}
