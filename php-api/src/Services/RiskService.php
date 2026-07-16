<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/RiskService.cs. */
final class RiskService
{
    private const VALID_STATUSES = ['new', 'in_review', 'closed'];

    public function __construct(private readonly PDO $db)
    {
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Risks row and setLinks()'s junction-table INSERTs used
    // to be separately auto-committed — a failure in the link-writing left a Risk created with none
    // of its Document/Principle/Objective cross-references, silently.
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
        $likelihood = max(1, min(5, (int) ($request['likelihood'] ?? 1)));
        $impact = max(1, min(5, (int) ($request['impact'] ?? 1)));
        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'new';

        $this->db->prepare(<<<SQL
            INSERT INTO "Risks" ("Id", "ProjectId", "Key", "Title", "Description", "Likelihood", "Impact", "Mitigations",
                "OwnerId", "TaskId", "Status", "DateToClose", "DateClosed", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :likelihood, :impact, :mitigations,
                :ownerId, :taskId, :status, :dateToClose, :dateClosed, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'key' => $key, 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'likelihood' => $likelihood, 'impact' => $impact, 'mitigations' => $request['mitigations'] ?? null,
            'ownerId' => $request['ownerId'] ?? null, 'taskId' => $request['taskId'] ?? null, 'status' => $status,
            'dateToClose' => $request['dateToClose'] ?? null, 'dateClosed' => $request['dateClosed'] ?? null,
        ]);

        $this->setLinks($projectId, $id, $request['documentIds'] ?? [], $request['principleIds'] ?? [], $request['objectiveIds'] ?? []);
        return $this->toDto($id);
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the Risks UPDATE, the three junction-table DELETEs, and
    // setLinks()'s re-INSERTs used to be separately auto-committed — a failure mid-sequence could
    // leave the row updated but its cross-reference links half-cleared, half-repopulated.
    public function update(string $projectId, string $riskId, array $request): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->updateInTransaction($projectId, $riskId, $request);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function updateInTransaction(string $projectId, string $riskId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Risks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $riskId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $likelihood = max(1, min(5, (int) ($request['likelihood'] ?? 1)));
        $impact = max(1, min(5, (int) ($request['impact'] ?? 1)));
        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'new';

        $this->db->prepare(<<<SQL
            UPDATE "Risks" SET "Title" = :title, "Description" = :description, "Likelihood" = :likelihood, "Impact" = :impact,
                "Mitigations" = :mitigations, "OwnerId" = :ownerId, "TaskId" = :taskId, "Status" = :status,
                "DateToClose" = :dateToClose, "DateClosed" = :dateClosed, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'likelihood' => $likelihood, 'impact' => $impact, 'mitigations' => $request['mitigations'] ?? null,
            'ownerId' => $request['ownerId'] ?? null, 'taskId' => $request['taskId'] ?? null, 'status' => $status,
            'dateToClose' => $request['dateToClose'] ?? null, 'dateClosed' => $request['dateClosed'] ?? null, 'id' => $riskId,
        ]);

        $this->db->prepare('DELETE FROM "RiskDocument" WHERE "RiskId" = :id')->execute(['id' => $riskId]);
        $this->db->prepare('DELETE FROM "RiskPrinciple" WHERE "RiskId" = :id')->execute(['id' => $riskId]);
        $this->db->prepare('DELETE FROM "RiskObjective" WHERE "RiskId" = :id')->execute(['id' => $riskId]);
        $this->setLinks($projectId, $riskId, $request['documentIds'] ?? [], $request['principleIds'] ?? [], $request['objectiveIds'] ?? []);

        return $this->toDto($riskId);
    }

    public function delete(string $projectId, string $riskId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Risks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $riskId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    private function setLinks(string $projectId, string $riskId, array $documentIds, array $principleIds, array $objectiveIds): void
    {
        $docCheck = $this->db->prepare('SELECT 1 FROM "Documents" WHERE "Id" = :id AND "ProjectId" = :pid');
        $docInsert = $this->db->prepare('INSERT INTO "RiskDocument" ("RiskId", "DocumentId") VALUES (:rid, :did)');
        foreach (array_unique($documentIds) as $id) {
            $docCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($docCheck->fetch() !== false) {
                $docInsert->execute(['rid' => $riskId, 'did' => $id]);
            }
        }

        $prinCheck = $this->db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $prinInsert = $this->db->prepare('INSERT INTO "RiskPrinciple" ("RiskId", "PrincipleId") VALUES (:rid, :pid2)');
        foreach (array_unique($principleIds) as $id) {
            $prinCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($prinCheck->fetch() !== false) {
                $prinInsert->execute(['rid' => $riskId, 'pid2' => $id]);
            }
        }

        $objCheck = $this->db->prepare('SELECT 1 FROM "Objectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $objInsert = $this->db->prepare('INSERT INTO "RiskObjective" ("RiskId", "ObjectiveId") VALUES (:rid, :oid)');
        foreach (array_unique($objectiveIds) as $id) {
            $objCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($objCheck->fetch() !== false) {
                $objInsert->execute(['rid' => $riskId, 'oid' => $id]);
            }
        }
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Risks" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return sprintf('%s-RISK-%03d', $projectKey, (int) $stmt->fetchColumn() + 1);
    }

    private function toDto(string $riskId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Risks" WHERE "Id" = :id');
        $stmt->execute(['id' => $riskId]);
        $r = $stmt->fetch();

        $docStmt = $this->db->prepare('SELECT "DocumentId" FROM "RiskDocument" WHERE "RiskId" = :id');
        $docStmt->execute(['id' => $riskId]);
        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "RiskPrinciple" WHERE "RiskId" = :id');
        $prinStmt->execute(['id' => $riskId]);
        $objStmt = $this->db->prepare('SELECT "ObjectiveId" FROM "RiskObjective" WHERE "RiskId" = :id');
        $objStmt->execute(['id' => $riskId]);

        return [
            'id' => $r['Id'], 'key' => $r['Key'], 'title' => $r['Title'], 'description' => $r['Description'],
            'likelihood' => (int) $r['Likelihood'], 'impact' => (int) $r['Impact'], 'mitigations' => $r['Mitigations'],
            'ownerId' => $r['OwnerId'], 'taskId' => $r['TaskId'], 'status' => $r['Status'],
            'dateToClose' => $r['DateToClose'], 'dateClosed' => $r['DateClosed'],
            'documentIds' => $docStmt->fetchAll(PDO::FETCH_COLUMN),
            'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN),
            'objectiveIds' => $objStmt->fetchAll(PDO::FETCH_COLUMN),
        ];
    }
}
