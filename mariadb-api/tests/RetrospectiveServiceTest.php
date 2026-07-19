<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PrincipleService;
use Enkl\Api\Services\RetrospectiveService;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for RetrospectiveService — create()/update()/promoteItem() got
 * beginTransaction()/commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1).
 * promoteItem() mirrors a real bug found and fixed on the .NET tier (finding 2.2 there): distilling a
 * retro item into a Principle used to be two separately auto-committed statements (create the
 * Principle, then link it back via PromotedPrincipleId) — high value to verify the wrap holds.
 */
final class RetrospectiveServiceTest extends TestCase
{
    private static PDO $db;
    private static RetrospectiveService $retros;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$retros = new RetrospectiveService(self::$db, new PrincipleService(self::$db));
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'), $seeded['userId']);

        $memberStmt = self::$db->prepare('SELECT "Id" FROM "ProjectMembers" WHERE "ProjectId" = :pid');
        $memberStmt->execute(['pid' => $projectId]);
        $memberId = $memberStmt->fetchColumn();

        $created = self::$retros->create($projectId, ['team' => 'Team A', 'background' => 'Sprint 12', 'participantIds' => [$memberId]]);
        self::assertNotNull($created);
        self::assertSame('Team A', $created['team']);
        self::assertSame([$memberId], $created['participantIds']);
        $retroId = $created['id'];

        $updated = self::$retros->update($projectId, $retroId, ['team' => 'Team A+', 'background' => 'Sprint 12 revised', 'participantIds' => []]);
        self::assertNotNull($updated);
        self::assertSame('Team A+', $updated['team']);
        self::assertSame([], $updated['participantIds']);

        $stmt = self::$db->prepare('SELECT "Team" FROM "Retrospectives" WHERE "Id" = :id');
        $stmt->execute(['id' => $retroId]);
        self::assertSame('Team A+', $stmt->fetchColumn());

        $deleted = self::$retros->delete($projectId, $retroId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Retrospectives" WHERE "Id" = :id');
        $stmt->execute(['id' => $retroId]);
        self::assertFalse($stmt->fetch());
    }

    public function testCreateItemUpdateItemDeleteItem(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $retro = self::$retros->create($projectId, ['team' => 'Team B']);

        $item = self::$retros->createItem($projectId, $retro['id'], ['column' => 'start', 'text' => 'Do daily standups']);
        self::assertNotNull($item);
        self::assertSame('start', $item['column']);

        $updatedItem = self::$retros->updateItem($projectId, $retro['id'], $item['id'], ['column' => 'keep', 'text' => 'Keep doing standups', 'sortOrder' => 0]);
        self::assertNotNull($updatedItem);
        self::assertSame('keep', $updatedItem['column']);

        $deletedItem = self::$retros->deleteItem($projectId, $retro['id'], $item['id']);
        self::assertTrue($deletedItem);

        $stmt = self::$db->prepare('SELECT 1 FROM "RetrospectiveItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $item['id']]);
        self::assertFalse($stmt->fetch());
    }

    public function testPromoteItemCreatesLinkedPrinciple(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $retro = self::$retros->create($projectId, ['team' => 'Team C']);
        $item = self::$retros->createItem($projectId, $retro['id'], ['column' => 'keep', 'text' => 'Write ADRs for big decisions']);

        $result = self::$retros->promoteItem($projectId, $retro['id'], $item['id'], ['title' => 'Always write an ADR', 'description' => 'Big decisions need an ADR']);
        self::assertNotNull($result);
        self::assertSame('Always write an ADR', $result['principle']['title']);
        self::assertSame($result['principle']['id'], $result['item']['promotedPrincipleId']);

        // Verify the link actually landed in the DB (not just the returned DTO) — this is exactly the
        // gap the .NET tier's own finding 2.2 bug produced: a real Principle created with the link
        // back on RetrospectiveItems never actually committed.
        $stmt = self::$db->prepare('SELECT "PromotedPrincipleId" FROM "RetrospectiveItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $item['id']]);
        self::assertSame($result['principle']['id'], $stmt->fetchColumn());

        $stmt = self::$db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $result['principle']['id'], 'pid' => $projectId]);
        self::assertNotFalse($stmt->fetch());
    }

    public function testCreateActionItemUpdateDelete(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $retro = self::$retros->create($projectId, ['team' => 'Team D']);

        $action = self::$retros->createActionItem($projectId, $retro['id'], ['text' => 'Follow up with vendor']);
        self::assertNotNull($action);
        self::assertFalse($action['completed']);

        $updatedAction = self::$retros->updateActionItem($projectId, $retro['id'], $action['id'], ['text' => 'Follow up with vendor', 'completed' => true, 'sortOrder' => 0]);
        self::assertTrue($updatedAction['completed']);

        $deletedAction = self::$retros->deleteActionItem($projectId, $retro['id'], $action['id']);
        self::assertTrue($deletedAction);
    }
}
