<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/DecisionService.cs. */
final class DecisionService
{
    private const VALID_TYPES = ['strategy', 'policy', 'budgetary', 'financial', 'functional', 'technical', 'process', 'operational'];
    private const VALID_STATUSES = ['open', 'in_review', 'completed'];

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

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key']);
        $type = in_array($request['type'] ?? null, self::VALID_TYPES, true) ? $request['type'] : 'operational';
        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'open';

        $this->db->prepare(<<<SQL
            INSERT INTO "Decisions" ("Id", "ProjectId", "Key", "Title", "Description", "Type", "Status", "Outcome",
                "OwnerId", "Approver", "TaskId", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :type, :status, :outcome, :ownerId, :approver, :taskId, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'key' => $key, 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'type' => $type, 'status' => $status, 'outcome' => $request['outcome'] ?? null,
            'ownerId' => $request['ownerId'] ?? null, 'approver' => $request['approver'] ?? null, 'taskId' => $request['taskId'] ?? null,
        ]);

        $this->setLinks($projectId, $id, $request['documentIds'] ?? [], $request['riskIds'] ?? [], $request['principleIds'] ?? [], $request['objectiveIds'] ?? []);
        return $this->toDto($id);
    }

    public function update(string $projectId, string $decisionId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Decisions" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $decisionId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $type = in_array($request['type'] ?? null, self::VALID_TYPES, true) ? $request['type'] : 'operational';
        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'open';

        $this->db->prepare(<<<SQL
            UPDATE "Decisions" SET "Title" = :title, "Description" = :description, "Type" = :type, "Status" = :status,
                "Outcome" = :outcome, "OwnerId" = :ownerId, "Approver" = :approver, "TaskId" = :taskId, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'type' => $type, 'status' => $status,
            'outcome' => $request['outcome'] ?? null, 'ownerId' => $request['ownerId'] ?? null,
            'approver' => $request['approver'] ?? null, 'taskId' => $request['taskId'] ?? null, 'id' => $decisionId,
        ]);

        $this->db->prepare('DELETE FROM "DecisionDocument" WHERE "DecisionId" = :id')->execute(['id' => $decisionId]);
        $this->db->prepare('DELETE FROM "DecisionRisk" WHERE "DecisionId" = :id')->execute(['id' => $decisionId]);
        $this->db->prepare('DELETE FROM "DecisionPrinciple" WHERE "DecisionId" = :id')->execute(['id' => $decisionId]);
        $this->db->prepare('DELETE FROM "DecisionObjective" WHERE "DecisionId" = :id')->execute(['id' => $decisionId]);
        $this->setLinks($projectId, $decisionId, $request['documentIds'] ?? [], $request['riskIds'] ?? [], $request['principleIds'] ?? [], $request['objectiveIds'] ?? []);

        return $this->toDto($decisionId);
    }

    public function delete(string $projectId, string $decisionId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Decisions" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $decisionId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    private function setLinks(string $projectId, string $decisionId, array $documentIds, array $riskIds, array $principleIds, array $objectiveIds): void
    {
        $docCheck = $this->db->prepare('SELECT 1 FROM "Documents" WHERE "Id" = :id AND "ProjectId" = :pid');
        $docInsert = $this->db->prepare('INSERT INTO "DecisionDocument" ("DecisionId", "DocumentId") VALUES (:did2, :did)');
        foreach (array_unique($documentIds) as $id) {
            $docCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($docCheck->fetch() !== false) {
                $docInsert->execute(['did2' => $decisionId, 'did' => $id]);
            }
        }

        $riskCheck = $this->db->prepare('SELECT 1 FROM "Risks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $riskInsert = $this->db->prepare('INSERT INTO "DecisionRisk" ("DecisionId", "RiskId") VALUES (:did, :rid)');
        foreach (array_unique($riskIds) as $id) {
            $riskCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($riskCheck->fetch() !== false) {
                $riskInsert->execute(['did' => $decisionId, 'rid' => $id]);
            }
        }

        $prinCheck = $this->db->prepare('SELECT 1 FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $prinInsert = $this->db->prepare('INSERT INTO "DecisionPrinciple" ("DecisionId", "PrincipleId") VALUES (:did, :pid2)');
        foreach (array_unique($principleIds) as $id) {
            $prinCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($prinCheck->fetch() !== false) {
                $prinInsert->execute(['did' => $decisionId, 'pid2' => $id]);
            }
        }

        $objCheck = $this->db->prepare('SELECT 1 FROM "Objectives" WHERE "Id" = :id AND "ProjectId" = :pid');
        $objInsert = $this->db->prepare('INSERT INTO "DecisionObjective" ("DecisionId", "ObjectiveId") VALUES (:did, :oid)');
        foreach (array_unique($objectiveIds) as $id) {
            $objCheck->execute(['id' => $id, 'pid' => $projectId]);
            if ($objCheck->fetch() !== false) {
                $objInsert->execute(['did' => $decisionId, 'oid' => $id]);
            }
        }
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Decisions" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return sprintf('%s-DEC-%03d', $projectKey, (int) $stmt->fetchColumn() + 1);
    }

    private function toDto(string $decisionId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Decisions" WHERE "Id" = :id');
        $stmt->execute(['id' => $decisionId]);
        $d = $stmt->fetch();

        $docStmt = $this->db->prepare('SELECT "DocumentId" FROM "DecisionDocument" WHERE "DecisionId" = :id');
        $docStmt->execute(['id' => $decisionId]);
        $riskStmt = $this->db->prepare('SELECT "RiskId" FROM "DecisionRisk" WHERE "DecisionId" = :id');
        $riskStmt->execute(['id' => $decisionId]);
        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "DecisionPrinciple" WHERE "DecisionId" = :id');
        $prinStmt->execute(['id' => $decisionId]);
        $objStmt = $this->db->prepare('SELECT "ObjectiveId" FROM "DecisionObjective" WHERE "DecisionId" = :id');
        $objStmt->execute(['id' => $decisionId]);

        return [
            'id' => $d['Id'], 'key' => $d['Key'], 'title' => $d['Title'], 'description' => $d['Description'],
            'type' => $d['Type'], 'status' => $d['Status'], 'outcome' => $d['Outcome'],
            'ownerId' => $d['OwnerId'], 'approver' => $d['Approver'], 'taskId' => $d['TaskId'],
            'documentIds' => $docStmt->fetchAll(PDO::FETCH_COLUMN),
            'riskIds' => $riskStmt->fetchAll(PDO::FETCH_COLUMN),
            'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN),
            'objectiveIds' => $objStmt->fetchAll(PDO::FETCH_COLUMN),
        ];
    }
}
