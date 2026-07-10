<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use Enkl\Api\Validation\CycleDetection;
use PDO;

/** Ported from Services/TeamCommitteeService.cs. */
final class TeamCommitteeService
{
    private const VALID_TYPES = ['team', 'committee'];

    public function __construct(private readonly PDO $db)
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

        $type = in_array($request['type'] ?? null, self::VALID_TYPES, true) ? $request['type'] : 'team';
        $parentId = $request['parentId'] ?? null;
        if ($parentId !== null) {
            $stmt = $this->db->prepare('SELECT 1 FROM "TeamsCommittees" WHERE "Id" = :id AND "ProjectId" = :pid');
            $stmt->execute(['id' => $parentId, 'pid' => $projectId]);
            if ($stmt->fetch() === false) {
                $parentId = null;
            }
        }

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key'], $type);
        $this->db->prepare(<<<SQL
            INSERT INTO "TeamsCommittees" ("Id", "ProjectId", "Key", "Name", "Description", "Type", "ParentId", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :name, :description, :type, :parentId, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'key' => $key, 'name' => $request['name'] ?? '',
            'description' => $request['description'] ?? null, 'type' => $type, 'parentId' => $parentId,
        ]);

        $this->setMembers($projectId, $id, $request['memberIds'] ?? []);
        return $this->toDto($id);
    }

    public function update(string $projectId, string $id, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "TeamsCommittees" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $id, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $proposedParentId = $request['parentId'] ?? null;
        if ($proposedParentId === $id) {
            $proposedParentId = null;
        } elseif ($proposedParentId !== null) {
            $stmt = $this->db->prepare('SELECT 1 FROM "TeamsCommittees" WHERE "Id" = :cid AND "ProjectId" = :pid');
            $stmt->execute(['cid' => $proposedParentId, 'pid' => $projectId]);
            if ($stmt->fetch() === false) {
                $proposedParentId = null;
            } elseif ($this->wouldCreateParentCycle($projectId, $id, $proposedParentId)) {
                throw new ApiValidationException('That parent would create a cycle in the Teams & Committees hierarchy.');
            }
        }

        $type = in_array($request['type'] ?? null, self::VALID_TYPES, true) ? $request['type'] : 'team';
        $this->db->prepare(<<<SQL
            UPDATE "TeamsCommittees" SET "Name" = :name, "Description" = :description, "Type" = :type,
                "ParentId" = :parentId, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'name' => $request['name'] ?? '', 'description' => $request['description'] ?? null,
            'type' => $type, 'parentId' => $proposedParentId, 'id' => $id,
        ]);

        $this->db->prepare('DELETE FROM "TeamCommitteeMember" WHERE "TeamCommitteeId" = :id')->execute(['id' => $id]);
        $this->setMembers($projectId, $id, $request['memberIds'] ?? []);

        return $this->toDto($id);
    }

    public function delete(string $projectId, string $id): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "TeamsCommittees" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $id, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        // Mirrors mutations.js's deleteTeamCommittee: children are orphaned to top-level rather than
        // cascade-deleted (ParentId is Restrict, so this must happen before the delete).
        $this->db->prepare('UPDATE "TeamsCommittees" SET "ParentId" = NULL WHERE "ParentId" = :id')->execute(['id' => $id]);
        $this->db->prepare('DELETE FROM "TeamsCommittees" WHERE "Id" = :id')->execute(['id' => $id]);
        return true;
    }

    private function wouldCreateParentCycle(string $projectId, string $id, string $newParentId): bool
    {
        $stmt = $this->db->prepare('SELECT "Id", "ParentId" FROM "TeamsCommittees" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);

        $parentById = [];
        foreach ($stmt->fetchAll() as $row) {
            $parentById[$row['Id']] = $row['ParentId'];
        }
        $parentById[$id] = $newParentId;

        return CycleDetection::hasParentCycle($parentById);
    }

    private function setMembers(string $projectId, string $teamCommitteeId, array $memberIds): void
    {
        $check = $this->db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id AND "ProjectId" = :pid');
        $insert = $this->db->prepare('INSERT INTO "TeamCommitteeMember" ("TeamCommitteeId", "ProjectMemberId") VALUES (:tid, :mid)');
        foreach (array_unique($memberIds) as $id) {
            $check->execute(['id' => $id, 'pid' => $projectId]);
            if ($check->fetch() !== false) {
                $insert->execute(['tid' => $teamCommitteeId, 'mid' => $id]);
            }
        }
    }

    private function nextKey(string $projectId, string $projectKey, string $type): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "TeamsCommittees" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $prefix = $type === 'committee' ? 'COMM' : 'TEAM';
        return sprintf('%s-%s-%03d', $projectKey, $prefix, (int) $stmt->fetchColumn() + 1);
    }

    private function toDto(string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "TeamsCommittees" WHERE "Id" = :id');
        $stmt->execute(['id' => $id]);
        $t = $stmt->fetch();

        $memberStmt = $this->db->prepare('SELECT "ProjectMemberId" FROM "TeamCommitteeMember" WHERE "TeamCommitteeId" = :id');
        $memberStmt->execute(['id' => $id]);

        return [
            'id' => $t['Id'], 'key' => $t['Key'], 'name' => $t['Name'], 'description' => $t['Description'],
            'type' => $t['Type'], 'parentId' => $t['ParentId'], 'memberIds' => $memberStmt->fetchAll(PDO::FETCH_COLUMN),
        ];
    }
}
