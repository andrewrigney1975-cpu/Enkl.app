<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/ColumnService.cs. */
final class ColumnService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function create(string $projectId, array $request): array
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Columns" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $nextOrder = (int) $stmt->fetchColumn();

        $id = Uuid::v4();
        $done = (bool) ($request['done'] ?? false);
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Color", "Order")
            VALUES (:id, :pid, :name, :done, :color, :order)
        SQL);
        // PDO's array-form execute() binds every value as PDO::PARAM_STR, and PHP's (string) cast of
        // false is '' — which Postgres's boolean parser rejects (it needs '0'/'1'/'true'/'false'), so
        // bool params must be sent as int here; the DTO below keeps the real PHP bool for json_encode.
        $stmt->execute([
            'id' => $id, 'pid' => $projectId, 'name' => $request['name'] ?? '',
            'done' => (int) $done, 'color' => $request['color'] ?? null, 'order' => $nextOrder,
        ]);

        return ['id' => $id, 'name' => $request['name'] ?? '', 'done' => $done, 'color' => $request['color'] ?? null, 'order' => $nextOrder, 'cap' => -1];
    }

    public function update(string $projectId, string $columnId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Columns" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $columnId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $done = (bool) ($request['done'] ?? false);
        // -1 means uncapped; anything <1 (0, other negatives) normalizes back to -1 rather than
        // being rejected — there's no such thing as a column that holds zero tasks — matching
        // clampColumnCap's client-side twin (storage.js).
        $requestedCap = (int) ($request['cap'] ?? -1);
        $cap = $requestedCap < 1 ? -1 : $requestedCap;

        $stmt = $this->db->prepare('UPDATE "Columns" SET "Name" = :name, "Done" = :done, "Color" = :color, "Order" = :order, "Cap" = :cap WHERE "Id" = :id');
        $stmt->execute([
            'name' => $request['name'] ?? '', 'done' => (int) $done,
            'color' => $request['color'] ?? null, 'order' => (int) ($request['order'] ?? 0), 'cap' => $cap, 'id' => $columnId,
        ]);

        return ['id' => $columnId, 'name' => $request['name'] ?? '', 'done' => $done, 'color' => $request['color'] ?? null, 'order' => (int) ($request['order'] ?? 0), 'cap' => $cap];
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: unlink ParentTaskId -> delete TaskDependencies -> delete
    // Tasks -> delete Column used to run as four separately auto-committed statements — a
    // mid-sequence failure (e.g. the TaskDependencies delete) left orphaned rows referencing tasks
    // that either still exist with a dangling dependency, or were about to be deleted, either way an
    // inconsistent state no retry could cleanly recover from.
    public function delete(string $projectId, string $columnId): bool
    {
        $this->db->beginTransaction();
        try {
            $result = $this->deleteInTransaction($projectId, $columnId);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function deleteInTransaction(string $projectId, string $columnId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Columns" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $columnId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        // Tasks.ColumnId is a Restrict FK — deleting a column that still holds tasks would otherwise
        // fail at the DB level. Mirrors mutations.js's deleteColumn: every task in the column is
        // deleted outright (not reassigned elsewhere), with the same cleanup TasksController.delete
        // does per task — sub-tasks orphaned back to top-level (ParentTaskId is also Restrict),
        // dependency rows removed on both sides (DependsOnTaskId is Restrict too). Document/Risk/
        // Decision.TaskId and Tasks.AssigneeId are already SetNull, so those clear themselves.
        $stmt = $this->db->prepare('SELECT "Id" FROM "Tasks" WHERE "ColumnId" = :cid');
        $stmt->execute(['cid' => $columnId]);
        $taskIds = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if ($taskIds !== []) {
            $placeholders = implode(',', array_fill(0, count($taskIds), '?'));

            $this->db->prepare(
                "UPDATE \"Tasks\" SET \"ParentTaskId\" = NULL WHERE \"ParentTaskId\" IN ($placeholders) AND \"Id\" NOT IN ($placeholders)"
            )->execute([...$taskIds, ...$taskIds]);

            $this->db->prepare(
                "DELETE FROM \"TaskDependencies\" WHERE \"TaskId\" IN ($placeholders) OR \"DependsOnTaskId\" IN ($placeholders)"
            )->execute([...$taskIds, ...$taskIds]);

            $this->db->prepare("DELETE FROM \"Tasks\" WHERE \"Id\" IN ($placeholders)")->execute($taskIds);
        }

        $this->db->prepare('DELETE FROM "Columns" WHERE "Id" = :id')->execute(['id' => $columnId]);
        return true;
    }
}
