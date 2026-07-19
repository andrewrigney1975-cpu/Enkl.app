<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/ObjectiveService.cs. */
final class ObjectiveService
{
    public function __construct(private readonly PDO $db)
    {
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Objectives row and setPrinciples()'s junction-table
    // INSERTs used to be separately auto-committed — a failure in the link-writing left an Objective
    // created with none of its Principle cross-references, silently.
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
        $stmt = $this->db->prepare('SELECT "Key" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key']);
        $this->db->prepare('INSERT INTO "Objectives" ("Id", "ProjectId", "Key", "Title", "Description", "DateCreated", "DateLastModified") VALUES (:id, :pid, :key, :title, :description, now(), now())')
            ->execute(['id' => $id, 'pid' => $projectId, 'key' => $key, 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null]);

        $this->setPrinciples($projectId, $id, $request['principleIds'] ?? []);
        return $this->toDto($id);
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Objectives UPDATE, the ObjectivePrinciple DELETE, and
    // setPrinciples()'s re-INSERTs used to be separately auto-committed.
    public function update(string $projectId, string $objectiveId, array $request): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->updateInTransaction($projectId, $objectiveId, $request);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function updateInTransaction(string $projectId, string $objectiveId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Objectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $objectiveId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $this->db->prepare('UPDATE "Objectives" SET "Title" = :title, "Description" = :description, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'id' => $objectiveId]);

        $this->db->prepare('DELETE FROM "ObjectivePrinciple" WHERE "ObjectiveId" = :id')->execute(['id' => $objectiveId]);
        $this->setPrinciples($projectId, $objectiveId, $request['principleIds'] ?? []);

        return $this->toDto($objectiveId);
    }

    public function delete(string $projectId, string $objectiveId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Objectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $objectiveId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    private function setPrinciples(string $projectId, string $objectiveId, array $principleIds): void
    {
        $check = $this->db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $insert = $this->db->prepare('INSERT INTO "ObjectivePrinciple" ("ObjectiveId", "PrincipleId") VALUES (:oid, :pid2)');
        foreach (array_unique($principleIds) as $id) {
            $check->execute(['id' => $id, 'pid' => $projectId]);
            if ($check->fetch() !== false) {
                $insert->execute(['oid' => $objectiveId, 'pid2' => $id]);
            }
        }
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Objectives" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return sprintf('%s-OBJ-%03d', $projectKey, (int) $stmt->fetchColumn() + 1);
    }

    private function toDto(string $objectiveId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Objectives" WHERE "Id" = :id');
        $stmt->execute(['id' => $objectiveId]);
        $o = $stmt->fetch();

        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "ObjectivePrinciple" WHERE "ObjectiveId" = :id');
        $prinStmt->execute(['id' => $objectiveId]);

        return ['id' => $o['Id'], 'key' => $o['Key'], 'title' => $o['Title'], 'description' => $o['Description'], 'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN)];
    }
}
