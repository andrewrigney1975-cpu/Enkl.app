<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/ToDoService.cs. The app's first per-User (not per-Project/per-Organisation)
 * service — every method is scoped by the caller's own userId, no project-membership or org-admin
 * check anywhere (see ToDoController's routes.php registration, RequireAuthMiddleware only).
 */
final class ToDoService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function list(string $userId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ToDoLists" WHERE "UserId" = :uid ORDER BY "DateCreated"');
        $stmt->execute(['uid' => $userId]);
        return array_map(fn(array $l): array => $this->toDto($l), $stmt->fetchAll());
    }

    public function createList(string $userId, array $request): array
    {
        $title = $this->validateTitle($request);

        $listId = Uuid::v4();
        $stmt = $this->db->prepare(
            'INSERT INTO "ToDoLists" ("Id", "UserId", "Title", "DateCreated", "DateLastModified") VALUES (:id, :uid, :title, now(), now())'
        );
        $stmt->execute(['id' => $listId, 'uid' => $userId, 'title' => $title]);

        return $this->getListRow($userId, $listId);
    }

    /** Returns null if the list doesn't exist or belongs to a different User than the caller. */
    public function renameList(string $userId, string $listId, array $request): ?array
    {
        if (!$this->listOwned($userId, $listId)) {
            return null;
        }
        $title = $this->validateTitle($request);

        $stmt = $this->db->prepare('UPDATE "ToDoLists" SET "Title" = :title, "DateLastModified" = now() WHERE "Id" = :id');
        $stmt->execute(['title' => $title, 'id' => $listId]);

        return $this->getListRow($userId, $listId);
    }

    public function deleteList(string $userId, string $listId): bool
    {
        if (!$this->listOwned($userId, $listId)) {
            return false;
        }
        // ToDoItems.ToDoListId is Cascade — removing the list alone is enough (see the migration's own comment).
        $stmt = $this->db->prepare('DELETE FROM "ToDoLists" WHERE "Id" = :id');
        $stmt->execute(['id' => $listId]);
        return true;
    }

    /** Returns null if the list doesn't exist or belongs to a different User than the caller. */
    public function createItem(string $userId, string $listId, array $request): ?array
    {
        if (!$this->listOwned($userId, $listId)) {
            return null;
        }

        $itemId = Uuid::v4();
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "ToDoItems" ("Id", "ToDoListId", "Note", "Completed", "DueDate", "DateCreated", "DateLastModified")
            VALUES (:id, :lid, :note, false, :due, now(), now())
        SQL);
        $stmt->execute([
            'id' => $itemId, 'lid' => $listId,
            'note' => (string) ($request['note'] ?? ''), 'due' => $request['dueDate'] ?? null,
        ]);

        return $this->getItemRow($listId, $itemId);
    }

    /** ToDoItem carries no UserId of its own — ownership only ever flows through its parent list, checked via a join. */
    public function updateItem(string $userId, string $listId, string $itemId, array $request): ?array
    {
        if (!$this->itemOwned($userId, $listId, $itemId)) {
            return null;
        }

        $stmt = $this->db->prepare(<<<SQL
            UPDATE "ToDoItems" SET "Note" = :note, "Completed" = :completed, "DueDate" = :due, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL);
        $stmt->execute([
            'note' => (string) ($request['note'] ?? ''),
            // (int) here, not the raw PHP bool — see ColumnService::create's comment on why.
            'completed' => (int) (bool) ($request['completed'] ?? false),
            'due' => $request['dueDate'] ?? null,
            'id' => $itemId,
        ]);

        return $this->getItemRow($listId, $itemId);
    }

    public function deleteItem(string $userId, string $listId, string $itemId): bool
    {
        if (!$this->itemOwned($userId, $listId, $itemId)) {
            return false;
        }
        $stmt = $this->db->prepare('DELETE FROM "ToDoItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $itemId]);
        return true;
    }

    private function validateTitle(array $request): string
    {
        $title = trim((string) ($request['title'] ?? ''));
        if ($title === '') {
            throw new ApiValidationException('Please enter a list title.');
        }
        return mb_substr($title, 0, 200);
    }

    private function listOwned(string $userId, string $listId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "ToDoLists" WHERE "Id" = :id AND "UserId" = :uid');
        $stmt->execute(['id' => $listId, 'uid' => $userId]);
        return $stmt->fetch() !== false;
    }

    private function itemOwned(string $userId, string $listId, string $itemId): bool
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT 1 FROM "ToDoItems" i JOIN "ToDoLists" l ON l."Id" = i."ToDoListId"
            WHERE i."Id" = :itemId AND i."ToDoListId" = :listId AND l."UserId" = :uid
        SQL);
        $stmt->execute(['itemId' => $itemId, 'listId' => $listId, 'uid' => $userId]);
        return $stmt->fetch() !== false;
    }

    private function getListRow(string $userId, string $listId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ToDoLists" WHERE "Id" = :id AND "UserId" = :uid');
        $stmt->execute(['id' => $listId, 'uid' => $userId]);
        return $this->toDto($stmt->fetch());
    }

    private function getItemRow(string $listId, string $itemId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ToDoItems" WHERE "Id" = :id AND "ToDoListId" = :lid');
        $stmt->execute(['id' => $itemId, 'lid' => $listId]);
        return $this->toItemDto($stmt->fetch());
    }

    private function toDto(array $l): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ToDoItems" WHERE "ToDoListId" = :lid ORDER BY "DateCreated"');
        $stmt->execute(['lid' => $l['Id']]);
        $items = array_map(fn(array $i): array => $this->toItemDto($i), $stmt->fetchAll());

        return [
            'id' => $l['Id'], 'title' => $l['Title'],
            'dateCreated' => $l['DateCreated'], 'dateLastModified' => $l['DateLastModified'],
            'items' => $items,
        ];
    }

    private function toItemDto(array $i): array
    {
        return [
            'id' => $i['Id'], 'note' => $i['Note'], 'completed' => (bool) $i['Completed'],
            'dueDate' => $i['DueDate'], 'dateCreated' => $i['DateCreated'], 'dateLastModified' => $i['DateLastModified'],
        ];
    }
}
