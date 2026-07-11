<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/** Ported from Services/RetrospectiveService.cs. */
final class RetrospectiveService
{
    private const VALID_COLUMNS = ['start', 'stop', 'keep'];

    public function __construct(private readonly PDO $db, private readonly PrincipleService $principles)
    {
    }

    public function create(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key']);
        $this->db->prepare(<<<SQL
            INSERT INTO "Retrospectives"
                ("Id", "ProjectId", "ReleaseId", "Key", "Team", "Background", "RetroDate", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :releaseId, :key, :team, :background, :retroDate, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'releaseId' => $request['releaseId'] ?? null,
            'key' => $key, 'team' => $request['team'] ?? null, 'background' => $request['background'] ?? null,
            'retroDate' => $request['retroDate'] ?? null,
        ]);
        $this->applyParticipants($id, $request['participantIds'] ?? null);

        return $this->getFullDto($projectId, $id);
    }

    public function update(string $projectId, string $retrospectiveId, array $request): ?array
    {
        if (!$this->retrospectiveExists($projectId, $retrospectiveId)) {
            return null;
        }

        // Matches the .NET side's `if (request.LastTimerDurationSeconds.HasValue)` guard: only
        // touch the column when the request explicitly carries a non-null value, so a client that
        // omits the field (or sends it null) never clobbers the convener's last-set timer default.
        if (isset($request['lastTimerDurationSeconds'])) {
            $this->db->prepare('UPDATE "Retrospectives" SET "LastTimerDurationSeconds" = :val WHERE "Id" = :id')
                ->execute(['val' => (int) $request['lastTimerDurationSeconds'], 'id' => $retrospectiveId]);
        }

        $this->db->prepare(<<<SQL
            UPDATE "Retrospectives" SET
                "ReleaseId" = :releaseId, "Team" = :team, "Background" = :background, "RetroDate" = :retroDate,
                "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'releaseId' => $request['releaseId'] ?? null, 'team' => $request['team'] ?? null,
            'background' => $request['background'] ?? null, 'retroDate' => $request['retroDate'] ?? null,
            'id' => $retrospectiveId,
        ]);
        $this->applyParticipants($retrospectiveId, $request['participantIds'] ?? null);

        return $this->getFullDto($projectId, $retrospectiveId);
    }

    public function delete(string $projectId, string $retrospectiveId): bool
    {
        // RetrospectiveItems/ActionItems/Participants are all ON DELETE CASCADE from Retrospectives.
        $stmt = $this->db->prepare('DELETE FROM "Retrospectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $retrospectiveId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    public function createItem(string $projectId, string $retrospectiveId, array $request): ?array
    {
        if (!$this->retrospectiveExists($projectId, $retrospectiveId)) {
            return null;
        }

        $countStmt = $this->db->prepare('SELECT COUNT(*) FROM "RetrospectiveItems" WHERE "RetrospectiveId" = :rid');
        $countStmt->execute(['rid' => $retrospectiveId]);
        $nextOrder = (int) $countStmt->fetchColumn();

        $id = Uuid::v4();
        $this->db->prepare(<<<SQL
            INSERT INTO "RetrospectiveItems" ("Id", "RetrospectiveId", "Column", "Text", "SortOrder", "DateCreated", "DateLastModified")
            VALUES (:id, :rid, :col, :text, :sortOrder, now(), now())
        SQL)->execute([
            'id' => $id, 'rid' => $retrospectiveId,
            'col' => $this->normalizeColumn($request['column'] ?? null),
            'text' => (string) ($request['text'] ?? ''), 'sortOrder' => $nextOrder,
        ]);

        return $this->getItemRow($retrospectiveId, $id);
    }

    public function updateItem(string $projectId, string $retrospectiveId, string $itemId, array $request): ?array
    {
        if (!$this->itemOwned($projectId, $retrospectiveId, $itemId)) {
            return null;
        }

        $this->db->prepare(<<<SQL
            UPDATE "RetrospectiveItems" SET "Column" = :col, "Text" = :text, "SortOrder" = :sortOrder, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'col' => $this->normalizeColumn($request['column'] ?? null),
            'text' => (string) ($request['text'] ?? ''),
            'sortOrder' => (int) ($request['sortOrder'] ?? 0),
            'id' => $itemId,
        ]);

        return $this->getItemRow($retrospectiveId, $itemId);
    }

    public function deleteItem(string $projectId, string $retrospectiveId, string $itemId): bool
    {
        if (!$this->itemOwned($projectId, $retrospectiveId, $itemId)) {
            return false;
        }
        $stmt = $this->db->prepare('DELETE FROM "RetrospectiveItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $itemId]);
        return true;
    }

    /**
     * Distills a Start/Keep-doing item into a Principle (via the existing PrincipleService, so a
     * shared org-wide Principle library sees it too), then links the item back to the new Principle
     * so the UI can show it as already promoted.
     */
    public function promoteItem(string $projectId, string $retrospectiveId, string $itemId, array $request): ?array
    {
        if (!$this->itemOwned($projectId, $retrospectiveId, $itemId)) {
            return null;
        }

        $title = trim((string) ($request['title'] ?? ''));
        if ($title === '') {
            throw new ApiValidationException('Please enter a principle title.');
        }

        $principle = $this->principles->create($projectId, [
            'title' => $title, 'description' => $request['description'] ?? null, 'documentUrl' => null,
        ]);
        if ($principle === null) {
            return null;
        }

        $this->db->prepare('UPDATE "RetrospectiveItems" SET "PromotedPrincipleId" = :pid, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['pid' => $principle['id'], 'id' => $itemId]);

        return ['principle' => $principle, 'item' => $this->getItemRow($retrospectiveId, $itemId)];
    }

    public function createActionItem(string $projectId, string $retrospectiveId, array $request): ?array
    {
        if (!$this->retrospectiveExists($projectId, $retrospectiveId)) {
            return null;
        }

        $countStmt = $this->db->prepare('SELECT COUNT(*) FROM "RetrospectiveActionItems" WHERE "RetrospectiveId" = :rid');
        $countStmt->execute(['rid' => $retrospectiveId]);
        $nextOrder = (int) $countStmt->fetchColumn();

        $id = Uuid::v4();
        $this->db->prepare(<<<SQL
            INSERT INTO "RetrospectiveActionItems" ("Id", "RetrospectiveId", "Text", "AssigneeId", "Completed", "SortOrder", "DateCreated", "DateLastModified")
            VALUES (:id, :rid, :text, :assigneeId, false, :sortOrder, now(), now())
        SQL)->execute([
            'id' => $id, 'rid' => $retrospectiveId,
            'text' => (string) ($request['text'] ?? ''), 'assigneeId' => $request['assigneeId'] ?? null,
            'sortOrder' => $nextOrder,
        ]);

        return $this->getActionItemRow($retrospectiveId, $id);
    }

    public function updateActionItem(string $projectId, string $retrospectiveId, string $itemId, array $request): ?array
    {
        if (!$this->actionItemOwned($projectId, $retrospectiveId, $itemId)) {
            return null;
        }

        $this->db->prepare(<<<SQL
            UPDATE "RetrospectiveActionItems" SET
                "Text" = :text, "AssigneeId" = :assigneeId, "Completed" = :completed, "SortOrder" = :sortOrder, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'text' => (string) ($request['text'] ?? ''), 'assigneeId' => $request['assigneeId'] ?? null,
            // (int) here, not the raw PHP bool — see ColumnService::create's comment on why.
            'completed' => (int) (bool) ($request['completed'] ?? false),
            'sortOrder' => (int) ($request['sortOrder'] ?? 0),
            'id' => $itemId,
        ]);

        return $this->getActionItemRow($retrospectiveId, $itemId);
    }

    public function deleteActionItem(string $projectId, string $retrospectiveId, string $itemId): bool
    {
        if (!$this->actionItemOwned($projectId, $retrospectiveId, $itemId)) {
            return false;
        }
        $stmt = $this->db->prepare('DELETE FROM "RetrospectiveActionItems" WHERE "Id" = :id');
        $stmt->execute(['id' => $itemId]);
        return true;
    }

    private function retrospectiveExists(string $projectId, string $retrospectiveId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Retrospectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $retrospectiveId, 'pid' => $projectId]);
        return $stmt->fetch() !== false;
    }

    private function itemOwned(string $projectId, string $retrospectiveId, string $itemId): bool
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT 1 FROM "RetrospectiveItems" i
            JOIN "Retrospectives" r ON r."Id" = i."RetrospectiveId"
            WHERE i."Id" = :itemId AND i."RetrospectiveId" = :rid AND r."ProjectId" = :pid
        SQL);
        $stmt->execute(['itemId' => $itemId, 'rid' => $retrospectiveId, 'pid' => $projectId]);
        return $stmt->fetch() !== false;
    }

    private function actionItemOwned(string $projectId, string $retrospectiveId, string $itemId): bool
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT 1 FROM "RetrospectiveActionItems" i
            JOIN "Retrospectives" r ON r."Id" = i."RetrospectiveId"
            WHERE i."Id" = :itemId AND i."RetrospectiveId" = :rid AND r."ProjectId" = :pid
        SQL);
        $stmt->execute(['itemId' => $itemId, 'rid' => $retrospectiveId, 'pid' => $projectId]);
        return $stmt->fetch() !== false;
    }

    /** Diffs the wanted participant set against what's already stored, same as RetrospectiveService.cs's ApplyParticipants. */
    private function applyParticipants(string $retrospectiveId, ?array $participantIds): void
    {
        $wanted = array_values(array_unique(array_map('strval', $participantIds ?? [])));

        if (count($wanted) > 0) {
            $placeholders = implode(', ', array_fill(0, count($wanted), '?'));
            $stmt = $this->db->prepare(
                'DELETE FROM "RetrospectiveParticipants" WHERE "RetrospectiveId" = ? AND "ProjectMemberId" NOT IN (' . $placeholders . ')'
            );
            $stmt->execute(array_merge([$retrospectiveId], $wanted));
        } else {
            $stmt = $this->db->prepare('DELETE FROM "RetrospectiveParticipants" WHERE "RetrospectiveId" = ?');
            $stmt->execute([$retrospectiveId]);
        }

        $existingStmt = $this->db->prepare('SELECT "ProjectMemberId" FROM "RetrospectiveParticipants" WHERE "RetrospectiveId" = :rid');
        $existingStmt->execute(['rid' => $retrospectiveId]);
        $existing = array_flip($existingStmt->fetchAll(PDO::FETCH_COLUMN));

        $insertStmt = $this->db->prepare('INSERT INTO "RetrospectiveParticipants" ("RetrospectiveId", "ProjectMemberId") VALUES (:rid, :mid)');
        foreach ($wanted as $memberId) {
            if (!isset($existing[$memberId])) {
                $insertStmt->execute(['rid' => $retrospectiveId, 'mid' => $memberId]);
            }
        }
    }

    private function normalizeColumn(?string $column): string
    {
        return in_array($column, self::VALID_COLUMNS, true) ? $column : 'start';
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Retrospectives" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $count = (int) $stmt->fetchColumn();
        return sprintf('%s-RETRO-%03d', $projectKey, $count + 1);
    }

    private function getFullDto(string $projectId, string $retrospectiveId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Retrospectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $retrospectiveId, 'pid' => $projectId]);
        $r = $stmt->fetch();
        if ($r === false) {
            return null;
        }

        $participantsStmt = $this->db->prepare('SELECT "ProjectMemberId" FROM "RetrospectiveParticipants" WHERE "RetrospectiveId" = :rid');
        $participantsStmt->execute(['rid' => $retrospectiveId]);

        $itemsStmt = $this->db->prepare('SELECT * FROM "RetrospectiveItems" WHERE "RetrospectiveId" = :rid ORDER BY "SortOrder"');
        $itemsStmt->execute(['rid' => $retrospectiveId]);

        $actionItemsStmt = $this->db->prepare('SELECT * FROM "RetrospectiveActionItems" WHERE "RetrospectiveId" = :rid ORDER BY "SortOrder"');
        $actionItemsStmt->execute(['rid' => $retrospectiveId]);

        return [
            'id' => $r['Id'], 'key' => $r['Key'], 'releaseId' => $r['ReleaseId'], 'team' => $r['Team'],
            'background' => $r['Background'], 'retroDate' => $r['RetroDate'],
            'lastTimerDurationSeconds' => $r['LastTimerDurationSeconds'] !== null ? (int) $r['LastTimerDurationSeconds'] : null,
            'participantIds' => $participantsStmt->fetchAll(PDO::FETCH_COLUMN),
            'items' => array_map(fn(array $i): array => $this->toItemDto($i), $itemsStmt->fetchAll()),
            'actionItems' => array_map(fn(array $a): array => $this->toActionItemDto($a), $actionItemsStmt->fetchAll()),
            'dateCreated' => $r['DateCreated'], 'dateLastModified' => $r['DateLastModified'],
        ];
    }

    private function getItemRow(string $retrospectiveId, string $itemId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "RetrospectiveItems" WHERE "Id" = :id AND "RetrospectiveId" = :rid');
        $stmt->execute(['id' => $itemId, 'rid' => $retrospectiveId]);
        $i = $stmt->fetch();
        return $i === false ? null : $this->toItemDto($i);
    }

    private function getActionItemRow(string $retrospectiveId, string $itemId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "RetrospectiveActionItems" WHERE "Id" = :id AND "RetrospectiveId" = :rid');
        $stmt->execute(['id' => $itemId, 'rid' => $retrospectiveId]);
        $a = $stmt->fetch();
        return $a === false ? null : $this->toActionItemDto($a);
    }

    private function toItemDto(array $i): array
    {
        return [
            'id' => $i['Id'], 'column' => $i['Column'], 'text' => $i['Text'],
            'sortOrder' => (int) $i['SortOrder'], 'promotedPrincipleId' => $i['PromotedPrincipleId'],
        ];
    }

    private function toActionItemDto(array $a): array
    {
        return [
            'id' => $a['Id'], 'text' => $a['Text'], 'assigneeId' => $a['AssigneeId'],
            'completed' => (bool) $a['Completed'], 'sortOrder' => (int) $a['SortOrder'],
        ];
    }
}
