<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use Enkl\Api\Validation\CycleDetection;
use PDO;

/** Ported from Services/TaskService.cs — see that file's own comments for the "why" behind each piece; kept here too where it isn't obvious from the code alone. */
final class TaskService
{
    private const AUDIT_DIFFED_FIELDS = [
        'title', 'description', 'priority', 'assigneeId', 'releaseId', 'typeId', 'documentationUrl',
        'startDate', 'endDate', 'businessValue', 'taskCost', 'progress', 'estimatedEffort',
        'actualEffort', 'archived', 'dependencies', 'parentTaskId',
    ];

    public function __construct(private readonly PDO $db)
    {
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Task INSERT, the Projects.TaskCounter increment, and
    // the TaskDependencies INSERTs used to be separately auto-committed — a failure after the Task
    // insert but before the counter increment leaves the NEXT created task in this project reusing
    // the same Key (duplicate task keys, likely a confusing unique-constraint failure on the next
    // create instead of this one); a failure mid-dependency-loop leaves a task created with an
    // incomplete dependency list and no error surfaced about it.
    public function create(string $projectId, array $request): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->createInTransaction($projectId, $request);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function createInTransaction(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();

        $stmt = $this->db->prepare('SELECT * FROM "Columns" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $request['columnId'] ?? null, 'pid' => $projectId]);
        $column = $stmt->fetch();

        if ($project === false || $column === false) {
            return null;
        }

        $dependsOn = array_values(array_unique($request['dependsOnTaskIds'] ?? []));
        if ($dependsOn !== [] && $this->wouldCreateDependencyCycle($projectId, null, $dependsOn)) {
            throw new ApiValidationException('That set of dependencies would create a cycle.');
        }
        $parentTaskId = $request['parentTaskId'] ?? null;
        if ($parentTaskId !== null && $this->wouldCreateParentCycle($projectId, null, $parentTaskId)) {
            throw new ApiValidationException('That parent task would create a cycle.');
        }

        $taskId = Uuid::v4();
        $key = $project['Key'] . '-' . $project['TaskCounter'];
        $done = (bool) $column['Done'];

        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Tasks" (
                "Id", "ProjectId", "Key", "Title", "Description", "Priority", "ColumnId", "AssigneeId",
                "ReleaseId", "TypeId", "ParentTaskId", "DateCreated", "DateLastModified", "DateDone", "Progress", "Archived"
            ) VALUES (
                :id, :pid, :key, :title, :description, :priority, :columnId, :assigneeId,
                :releaseId, :typeId, :parentTaskId, now(), now(), :dateDone, 0, false
            )
        SQL);
        $stmt->execute([
            'id' => $taskId, 'pid' => $projectId, 'key' => $key,
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'priority' => $request['priority'] ?? 'medium', 'columnId' => $request['columnId'],
            'assigneeId' => $request['assigneeId'] ?? null, 'releaseId' => $request['releaseId'] ?? null,
            'typeId' => $request['typeId'] ?? null, 'parentTaskId' => $parentTaskId,
            'dateDone' => $done ? gmdate('Y-m-d\TH:i:s\Z') : null,
        ]);

        $this->db->prepare('UPDATE "Projects" SET "TaskCounter" = "TaskCounter" + 1 WHERE "Id" = :id')->execute(['id' => $projectId]);

        $depStmt = $this->db->prepare('INSERT INTO "TaskDependencies" ("TaskId", "DependsOnTaskId") VALUES (:tid, :did)');
        foreach ($dependsOn as $depId) {
            if ($depId !== $taskId) {
                $depStmt->execute(['tid' => $taskId, 'did' => $depId]);
            }
        }

        return $this->toTaskDto($taskId);
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Task UPDATE, the TaskDependencies DELETE+re-INSERT, and
    // recordAuditEntries()'s own INSERTs used to be separately auto-committed — a failure mid-sequence
    // left the task's fields updated but its dependency list half-cleared, or audit history missing
    // for a change that did actually take effect.
    public function update(string $projectId, string $taskId, array $request, ?string $changedByDisplayName): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->updateInTransaction($projectId, $taskId, $request, $changedByDisplayName);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function updateInTransaction(string $projectId, string $taskId, array $request, ?string $changedByDisplayName): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Tasks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $taskId, 'pid' => $projectId]);
        $task = $stmt->fetch();
        if ($task === false) {
            return null;
        }

        $stmt = $this->db->prepare('SELECT * FROM "Columns" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $request['columnId'] ?? null, 'pid' => $projectId]);
        $newColumn = $stmt->fetch();
        if ($newColumn === false) {
            return null;
        }

        $newDeps = array_values(array_unique(array_filter(
            $request['dependsOnTaskIds'] ?? [],
            static fn($id) => $id !== $taskId
        )));
        if ($this->wouldCreateDependencyCycle($projectId, $taskId, $newDeps)) {
            throw new ApiValidationException('That set of dependencies would create a cycle.');
        }
        $newParentId = $request['parentTaskId'] ?? null;
        if ($newParentId !== null && $this->wouldCreateParentCycle($projectId, $taskId, $newParentId)) {
            throw new ApiValidationException('That parent task would create a cycle.');
        }

        $before = $this->captureAuditSnapshot($task, $this->currentDependencyIds($taskId));
        $wasDone = $task['DateDone'] !== null;

        $newDateDone = $task['DateDone'];
        if ((bool) $newColumn['Done'] && !$wasDone) {
            $newDateDone = gmdate('Y-m-d\TH:i:s\Z');
        } elseif (!$newColumn['Done'] && $wasDone) {
            $newDateDone = null;
        }

        $stmt = $this->db->prepare(<<<SQL
            UPDATE "Tasks" SET
                "Title" = :title, "Description" = :description, "Priority" = :priority, "ColumnId" = :columnId,
                "AssigneeId" = :assigneeId, "ReleaseId" = :releaseId, "TypeId" = :typeId, "ParentTaskId" = :parentTaskId,
                "DocumentationUrl" = :documentationUrl, "StartDate" = :startDate, "EndDate" = :endDate,
                "BusinessValue" = :businessValue, "TaskCost" = :taskCost, "Progress" = :progress,
                "EstimatedEffort" = :estimatedEffort, "ActualEffort" = :actualEffort, "Archived" = :archived,
                "DateLastModified" = now(), "DateDone" = :dateDone
            WHERE "Id" = :id
        SQL);
        $stmt->execute([
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'priority' => $request['priority'] ?? 'medium', 'columnId' => $request['columnId'],
            'assigneeId' => $request['assigneeId'] ?? null, 'releaseId' => $request['releaseId'] ?? null,
            'typeId' => $request['typeId'] ?? null, 'parentTaskId' => $newParentId,
            'documentationUrl' => $request['documentationUrl'] ?? null,
            'startDate' => $request['startDate'] ?? null, 'endDate' => $request['endDate'] ?? null,
            'businessValue' => $request['businessValue'] ?? null, 'taskCost' => $request['taskCost'] ?? null,
            'progress' => (int) ($request['progress'] ?? 0),
            'estimatedEffort' => $request['estimatedEffort'] ?? null, 'actualEffort' => $request['actualEffort'] ?? null,
            // (int), not the raw PHP bool — PDO's array-form execute() would bind false as '' otherwise,
            // which Postgres's boolean parser rejects.
            'archived' => (int) (bool) ($request['archived'] ?? false),
            'dateDone' => $newDateDone, 'id' => $taskId,
        ]);

        $this->db->prepare('DELETE FROM "TaskDependencies" WHERE "TaskId" = :id')->execute(['id' => $taskId]);
        $depStmt = $this->db->prepare('INSERT INTO "TaskDependencies" ("TaskId", "DependsOnTaskId") VALUES (:tid, :did)');
        foreach ($newDeps as $depId) {
            $depStmt->execute(['tid' => $taskId, 'did' => $depId]);
        }

        if ($this->isChangeAuditingEnabled($projectId)) {
            $updatedTask = array_merge($task, [
                'Title' => $request['title'] ?? '', 'Description' => $request['description'] ?? null,
                'Priority' => $request['priority'] ?? 'medium', 'AssigneeId' => $request['assigneeId'] ?? null,
                'ReleaseId' => $request['releaseId'] ?? null, 'TypeId' => $request['typeId'] ?? null,
                'DocumentationUrl' => $request['documentationUrl'] ?? null,
                'StartDate' => $request['startDate'] ?? null, 'EndDate' => $request['endDate'] ?? null,
                'BusinessValue' => $request['businessValue'] ?? null, 'TaskCost' => $request['taskCost'] ?? null,
                'Progress' => (int) ($request['progress'] ?? 0),
                'EstimatedEffort' => $request['estimatedEffort'] ?? null, 'ActualEffort' => $request['actualEffort'] ?? null,
                'Archived' => (bool) ($request['archived'] ?? false), 'ParentTaskId' => $newParentId,
            ]);
            $after = $this->captureAuditSnapshot($updatedTask, $newDeps);
            $this->recordAuditEntries($taskId, $before, $after, $changedByDisplayName);
        }

        return $this->toTaskDto($taskId);
    }

    public function getTaskSummary(string $projectId, string $taskId): ?array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Key", "Title" FROM "Tasks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $taskId, 'pid' => $projectId]);
        $row = $stmt->fetch();
        return $row === false ? null : ['taskId' => $row['Id'], 'key' => $row['Key'], 'title' => $row['Title']];
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: orphaning sub-tasks and deleting the task used to be two
    // separately auto-committed statements — a failure on the DELETE left sub-tasks already
    // unlinked from a parent that still exists.
    public function delete(string $projectId, string $taskId): bool
    {
        $this->db->beginTransaction();
        try {
            $result = $this->deleteInTransaction($projectId, $taskId);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function deleteInTransaction(string $projectId, string $taskId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Tasks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $taskId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        // ParentTaskId is a Restrict FK (see TaskItemConfiguration) — sub-tasks are orphaned back to
        // top-level, not cascade-deleted, mirroring mutations.js's deleteTask.
        $this->db->prepare('UPDATE "Tasks" SET "ParentTaskId" = NULL WHERE "ParentTaskId" = :id')->execute(['id' => $taskId]);
        $this->db->prepare('DELETE FROM "Tasks" WHERE "Id" = :id')->execute(['id' => $taskId]);
        return true;
    }

    public function getProjectMemberUserIds(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT "UserId" FROM "ProjectMembers" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }

    /** Shared with ProjectService::getProjectDetail — builds every task DTO (with dependencies + audit log + comments) for a project in one pass. */
    public static function fetchTaskDtos(PDO $db, string $projectId): array
    {
        $stmt = $db->prepare('SELECT * FROM "Tasks" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $tasks = $stmt->fetchAll();

        $depStmt = $db->prepare('SELECT "DependsOnTaskId" FROM "TaskDependencies" WHERE "TaskId" = :id');
        $auditStmt = $db->prepare('SELECT * FROM "TaskAuditLogEntries" WHERE "TaskId" = :id ORDER BY "Timestamp" DESC');
        $commentStmt = $db->prepare('SELECT * FROM "TaskComments" WHERE "TaskId" = :id ORDER BY "DateCreated" ASC');

        return array_map(function (array $t) use ($depStmt, $auditStmt, $commentStmt): array {
            $depStmt->execute(['id' => $t['Id']]);
            $auditStmt->execute(['id' => $t['Id']]);
            $commentStmt->execute(['id' => $t['Id']]);
            return self::mapTaskRow($t, $depStmt->fetchAll(PDO::FETCH_COLUMN), array_map(
                static fn(array $a): array => [
                    'id' => $a['Id'], 'timestamp' => $a['Timestamp'], 'field' => $a['Field'],
                    'oldValue' => $a['OldValue'], 'newValue' => $a['NewValue'], 'changedBy' => $a['ChangedBy'],
                ],
                $auditStmt->fetchAll()
            ), self::mapComments($commentStmt->fetchAll()));
        }, $tasks);
    }

    private function toTaskDto(string $taskId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Tasks" WHERE "Id" = :id');
        $stmt->execute(['id' => $taskId]);
        $task = $stmt->fetch();

        $depStmt = $this->db->prepare('SELECT "DependsOnTaskId" FROM "TaskDependencies" WHERE "TaskId" = :id');
        $depStmt->execute(['id' => $taskId]);

        $auditStmt = $this->db->prepare('SELECT * FROM "TaskAuditLogEntries" WHERE "TaskId" = :id ORDER BY "Timestamp" DESC');
        $auditStmt->execute(['id' => $taskId]);

        $commentStmt = $this->db->prepare('SELECT * FROM "TaskComments" WHERE "TaskId" = :id ORDER BY "DateCreated" ASC');
        $commentStmt->execute(['id' => $taskId]);

        return self::mapTaskRow($task, $depStmt->fetchAll(PDO::FETCH_COLUMN), array_map(
            static fn(array $a): array => [
                'id' => $a['Id'], 'timestamp' => $a['Timestamp'], 'field' => $a['Field'],
                'oldValue' => $a['OldValue'], 'newValue' => $a['NewValue'], 'changedBy' => $a['ChangedBy'],
            ],
            $auditStmt->fetchAll()
        ), self::mapComments($commentStmt->fetchAll()));
    }

    /** @param array<int,array<string,mixed>> $rows */
    private static function mapComments(array $rows): array
    {
        return array_map(static fn(array $c): array => [
            'id' => $c['Id'], 'text' => $c['Text'], 'dateCreated' => $c['DateCreated'],
            'authorId' => $c['AuthorId'], 'authorName' => $c['AuthorName'],
        ], $rows);
    }

    private static function mapTaskRow(array $t, array $dependsOnTaskIds, array $auditLog, array $comments = []): array
    {
        return [
            'id' => $t['Id'], 'key' => $t['Key'], 'title' => $t['Title'], 'description' => $t['Description'],
            'priority' => $t['Priority'], 'columnId' => $t['ColumnId'], 'assigneeId' => $t['AssigneeId'],
            'releaseId' => $t['ReleaseId'], 'typeId' => $t['TypeId'], 'parentTaskId' => $t['ParentTaskId'],
            'documentationUrl' => $t['DocumentationUrl'], 'dateCreated' => $t['DateCreated'],
            'dateLastModified' => $t['DateLastModified'], 'dateDone' => $t['DateDone'],
            'startDate' => $t['StartDate'], 'endDate' => $t['EndDate'],
            'businessValue' => $t['BusinessValue'] !== null ? (int) $t['BusinessValue'] : null,
            'taskCost' => $t['TaskCost'] !== null ? (int) $t['TaskCost'] : null,
            'progress' => (int) $t['Progress'],
            'estimatedEffort' => $t['EstimatedEffort'] !== null ? (float) $t['EstimatedEffort'] : null,
            'actualEffort' => $t['ActualEffort'] !== null ? (float) $t['ActualEffort'] : null,
            'archived' => (bool) $t['Archived'],
            'dependsOnTaskIds' => $dependsOnTaskIds,
            'auditLog' => $auditLog,
            'comments' => $comments,
        ];
    }

    private function currentDependencyIds(string $taskId): array
    {
        $stmt = $this->db->prepare('SELECT "DependsOnTaskId" FROM "TaskDependencies" WHERE "TaskId" = :id');
        $stmt->execute(['id' => $taskId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }

    private function wouldCreateDependencyCycle(string $projectId, ?string $taskId, array $newDeps): bool
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT d."TaskId", d."DependsOnTaskId" FROM "TaskDependencies" d
            JOIN "Tasks" t ON t."Id" = d."TaskId"
            WHERE t."ProjectId" = :pid
        SQL);
        $stmt->execute(['pid' => $projectId]);

        $adjacency = [];
        foreach ($stmt->fetchAll() as $row) {
            $adjacency[$row['TaskId']][] = $row['DependsOnTaskId'];
        }

        $effectiveId = $taskId ?? Uuid::v4();
        $adjacency[$effectiveId] = $newDeps;

        return CycleDetection::hasCycle($adjacency);
    }

    private function wouldCreateParentCycle(string $projectId, ?string $taskId, string $newParentId): bool
    {
        $stmt = $this->db->prepare('SELECT "Id", "ParentTaskId" FROM "Tasks" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);

        $parentById = [];
        foreach ($stmt->fetchAll() as $row) {
            $parentById[$row['Id']] = $row['ParentTaskId'];
        }

        $effectiveId = $taskId ?? Uuid::v4();
        $parentById[$effectiveId] = $newParentId;

        return CycleDetection::hasParentCycle($parentById);
    }

    private function isChangeAuditingEnabled(string $projectId): bool
    {
        $stmt = $this->db->prepare('SELECT "HeaderButtonVisibilityJson" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $json = $stmt->fetchColumn();
        if (!$json) {
            return false;
        }
        $decoded = json_decode($json, true);
        return is_array($decoded) && ($decoded['changeAuditing'] ?? false) === true;
    }

    private function captureAuditSnapshot(array $task, array $dependsOnTaskIds): array
    {
        return [
            'title' => $task['Title'], 'description' => $task['Description'], 'priority' => $task['Priority'],
            'assigneeId' => $task['AssigneeId'], 'releaseId' => $task['ReleaseId'], 'typeId' => $task['TypeId'],
            'documentationUrl' => $task['DocumentationUrl'], 'startDate' => $task['StartDate'], 'endDate' => $task['EndDate'],
            'businessValue' => $task['BusinessValue'], 'taskCost' => $task['TaskCost'], 'progress' => (int) $task['Progress'],
            'estimatedEffort' => $task['EstimatedEffort'], 'actualEffort' => $task['ActualEffort'],
            'archived' => (bool) $task['Archived'], 'dependencies' => $dependsOnTaskIds, 'parentTaskId' => $task['ParentTaskId'],
        ];
    }

    private function recordAuditEntries(string $taskId, array $before, array $after, ?string $changedBy): void
    {
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "TaskAuditLogEntries" ("Id", "TaskId", "Timestamp", "Field", "OldValue", "NewValue", "ChangedBy")
            VALUES (:id, :taskId, now(), :field, :oldValue, :newValue, :changedBy)
        SQL);

        foreach (self::AUDIT_DIFFED_FIELDS as $field) {
            $oldVal = $before[$field];
            $newVal = $after[$field];
            if (!$this->auditValuesEqual($oldVal, $newVal)) {
                $stmt->execute([
                    'id' => Uuid::v4(), 'taskId' => $taskId, 'field' => $field,
                    'oldValue' => $this->formatAuditValue($oldVal), 'newValue' => $this->formatAuditValue($newVal),
                    'changedBy' => $changedBy,
                ]);
            }
        }
    }

    private function auditValuesEqual(mixed $a, mixed $b): bool
    {
        if (is_array($a) && is_array($b)) {
            $sa = $a;
            $sb = $b;
            sort($sa);
            sort($sb);
            return $sa === $sb;
        }
        // Loose-ish but type-safe: bools/ints/strings/null compare by value, matching C#'s Equals()
        // for the corresponding boxed primitive types used in TaskAuditSnapshot.
        return $a === $b || (is_numeric($a) && is_numeric($b) && (float) $a === (float) $b);
    }

    private function formatAuditValue(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_array($value)) {
            return $value === [] ? '[]' : implode(',', $value);
        }
        if (is_bool($value)) {
            return $value ? 'True' : 'False'; // matches C#'s bool.ToString()
        }
        return (string) $value;
    }
}
