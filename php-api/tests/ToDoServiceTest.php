<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ToDoService;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ToDoService — not transaction-wrapped this session (single-
 * statement create/update/delete throughout), but had zero coverage before this pass. The app's
 * first per-User (not per-Project) service — no project seeding needed, only a User.
 */
final class ToDoServiceTest extends TestCase
{
    private static PDO $db;
    private static ToDoService $todos;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$todos = new ToDoService(self::$db);
    }

    public function testListCreateRenameDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        $list = self::$todos->createList($seeded['userId'], ['title' => 'Groceries']);
        self::assertSame('Groceries', $list['title']);
        $listId = $list['id'];

        $renamed = self::$todos->renameList($seeded['userId'], $listId, ['title' => 'Shopping List']);
        self::assertNotNull($renamed);
        self::assertSame('Shopping List', $renamed['title']);

        $lists = self::$todos->list($seeded['userId']);
        self::assertNotEmpty(array_filter($lists, static fn(array $l): bool => $l['id'] === $listId));

        $deleted = self::$todos->deleteList($seeded['userId'], $listId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "ToDoLists" WHERE "Id" = :id');
        $stmt->execute(['id' => $listId]);
        self::assertFalse($stmt->fetch());
    }

    public function testItemCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $list = self::$todos->createList($seeded['userId'], ['title' => 'Work']);

        $item = self::$todos->createItem($seeded['userId'], $list['id'], ['note' => 'Write tests']);
        self::assertNotNull($item);
        self::assertFalse($item['completed']);

        $updated = self::$todos->updateItem($seeded['userId'], $list['id'], $item['id'], ['note' => 'Write tests', 'completed' => true]);
        self::assertTrue($updated['completed']);

        $deleted = self::$todos->deleteItem($seeded['userId'], $list['id'], $item['id']);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "ToDoItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $item['id']]);
        self::assertFalse($stmt->fetch());
    }

    public function testListsAreScopedToOwningUser(): void
    {
        $seededA = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-a'), TestDataHelper::unique('user'));
        $seededB = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-b'), TestDataHelper::unique('user'));

        $list = self::$todos->createList($seededA['userId'], ['title' => 'Private']);

        self::assertNull(self::$todos->renameList($seededB['userId'], $list['id'], ['title' => 'Hijacked']));
        self::assertFalse(self::$todos->deleteList($seededB['userId'], $list['id']));
        self::assertNull(self::$todos->createItem($seededB['userId'], $list['id'], ['note' => 'x']));
    }

    public function testCreateListWithBlankTitleThrowsValidationException(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        $this->expectException(ApiValidationException::class);
        self::$todos->createList($seeded['userId'], ['title' => '   ']);
    }
}
