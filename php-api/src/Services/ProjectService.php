<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\JwtService;
use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from Services/ProjectService.cs. GetProjectDetail is built as several simple per-table
 * queries (one per related entity) rather than one giant EF-style multi-Include join — easier to
 * verify correct field-by-field against the .NET DTO shape than one large hand-written JOIN, and
 * Postgres handles a handful of small indexed queries per request perfectly well at this scale.
 */
final class ProjectService
{
    // Must match MemberService::MEMBER_PALETTE[0] — a brand new project's sole member (its creator)
    // gets the same first-slot color a migrated project's first member would.
    private const FIRST_MEMBER_COLOR = '#0052CC';

    public function __construct(private readonly PDO $db)
    {
    }

    public function getProjectsForUser(string $userId): array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT p."Id", p."Name", p."Key"
            FROM "ProjectMembers" m
            JOIN "Projects" p ON p."Id" = m."ProjectId"
            WHERE m."UserId" = :uid
        SQL);
        $stmt->execute(['uid' => $userId]);
        return array_map(static fn(array $p): array => [
            'id' => $p['Id'], 'name' => $p['Name'], 'key' => $p['Key'],
        ], $stmt->fetchAll());
    }

    public function getProjectDetail(string $projectId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        return [
            'id' => $project['Id'],
            'name' => $project['Name'],
            'key' => $project['Key'],
            'organisationId' => $project['OrganisationId'],
            'members' => $this->fetchMembers($projectId),
            'columns' => $this->fetchColumns($projectId),
            'tasks' => TaskService::fetchTaskDtos($this->db, $projectId),
            'releases' => $this->fetchReleases($projectId),
            'taskTypes' => $this->fetchTaskTypes($projectId),
            'principles' => $this->fetchPrinciples($projectId),
            'documents' => $this->fetchDocuments($projectId),
            'risks' => $this->fetchRisks($projectId),
            'objectives' => $this->fetchObjectives($projectId),
            'teamsCommittees' => $this->fetchTeamsCommittees($projectId),
            'decisions' => $this->fetchDecisions($projectId),
            'headerButtonVisibility' => ProjectSettingsSerializer::parse($project['HeaderButtonVisibilityJson']),
            'workflow' => $project['WorkflowJson'] !== null ? json_decode($project['WorkflowJson']) : null,
        ];
    }

    /**
     * Creates a brand new project (not via migration) under the caller's own Organisation, seeded
     * with the same default columns/task types createDefaultProject (src/js/storage.js) gives a new
     * local project, and adds the caller as its first member. Returns a fresh JWT alongside the
     * project, since the request's own token predates this project's existence and wouldn't grant
     * access to it otherwise (JWT membership claims are only refreshed at login — see JwtService).
     */
    public function create(string $callerUserId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $callerUserId]);
        $user = $stmt->fetch();
        if ($user === false) {
            return null;
        }

        $name = trim((string) ($request['name'] ?? ''));
        if ($name === '') {
            $name = 'Untitled Project';
        }
        $requestedKey = $this->deriveProjectKey($request['key'] ?? null, $name);
        $uniqueKey = $this->resolveUniqueProjectKey($requestedKey);
        $warning = $uniqueKey !== $requestedKey
            ? "Project key \"{$requestedKey}\" was already in use; created as \"{$uniqueKey}\" instead."
            : null;

        $projectId = Uuid::v4();
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Projects" ("Id", "OrganisationId", "Name", "Key", "StartDate", "EndDate", "DateCreated", "DateLastModified", "TaskCounter", "HeaderButtonVisibilityJson")
            VALUES (:id, :orgId, :name, :key, :start, :end, now(), now(), 1, '{}')
        SQL);
        $stmt->execute([
            'id' => $projectId,
            'orgId' => $user['OrganisationId'],
            'name' => $name,
            'key' => $uniqueKey,
            'start' => $request['startDate'] ?? null,
            'end' => $request['endDate'] ?? null,
        ]);

        $stmt = $this->db->prepare(
            'INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color") VALUES (:id, :pid, :uid, :color)'
        );
        $stmt->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'uid' => $callerUserId, 'color' => self::FIRST_MEMBER_COLOR]);

        $columnDefs = [['To Do', false], ['In Progress', false], ['Done', true]];
        $colStmt = $this->db->prepare(
            'INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Order") VALUES (:id, :pid, :name, :done, :order)'
        );
        foreach ($columnDefs as $i => [$colName, $done]) {
            // (int) here, not the raw PHP bool — see ColumnService::create's comment on why.
            $colStmt->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'name' => $colName, 'done' => (int) $done, 'order' => $i]);
        }

        $typeStmt = $this->db->prepare('INSERT INTO "TaskTypes" ("Id", "ProjectId", "Name") VALUES (:id, :pid, :name)');
        foreach (['Feature', 'Bug'] as $typeName) {
            $typeStmt->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'name' => $typeName]);
        }

        $stmt = $this->db->prepare('SELECT "ProjectId", "Role" FROM "ProjectMembers" WHERE "UserId" = :uid');
        $stmt->execute(['uid' => $callerUserId]);
        $memberships = $stmt->fetchAll();
        $tokenInfo = JwtService::generateToken($user, $memberships);

        return [
            'project' => $this->getProjectDetail($projectId),
            'token' => $tokenInfo['token'],
            'tokenExpiresAt' => $tokenInfo['expiresAt'],
            'warning' => $warning,
        ];
    }

    public function update(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $name = trim((string) ($request['name'] ?? ''));
        if ($name === '') {
            $name = $project['Name'];
        }
        $requestedKey = $this->deriveProjectKey($request['key'] ?? null, $name);
        $key = $requestedKey === $project['Key'] ? $project['Key'] : $this->resolveUniqueProjectKey($requestedKey, $projectId);

        $stmt = $this->db->prepare(<<<SQL
            UPDATE "Projects"
            SET "Name" = :name, "Key" = :key, "StartDate" = :start, "EndDate" = :end, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL);
        $stmt->execute([
            'name' => $name, 'key' => $key,
            'start' => $request['startDate'] ?? null, 'end' => $request['endDate'] ?? null,
            'id' => $projectId,
        ]);

        return ['id' => $projectId, 'name' => $name, 'key' => $key];
    }

    public function delete(string $projectId): bool
    {
        // Every child entity's ProjectId FK is Cascade (Columns, Tasks, Members, Releases, ...), so
        // removing the Project alone is enough — Postgres resolves the whole graph, including
        // Tasks.ColumnId's Restrict FK, within this same delete (verified empirically: no task row
        // survives to violate it once its own Cascade-from-Project deletion has also been applied).
        $stmt = $this->db->prepare('DELETE FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    public function updateSettings(string $projectId, array $settings): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $parsed = ProjectSettingsSerializer::parse(json_encode($settings));
        $stmt = $this->db->prepare(
            'UPDATE "Projects" SET "HeaderButtonVisibilityJson" = :json, "DateLastModified" = now() WHERE "Id" = :id'
        );
        $stmt->execute(['json' => ProjectSettingsSerializer::serialize($parsed), 'id' => $projectId]);
        return $parsed;
    }

    public function updateWorkflow(string $projectId, mixed $workflow): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $stmt = $this->db->prepare(
            'UPDATE "Projects" SET "WorkflowJson" = :json, "DateLastModified" = now() WHERE "Id" = :id'
        );
        $stmt->execute(['json' => json_encode($workflow), 'id' => $projectId]);
        return ['workflow' => $workflow];
    }

    private function deriveProjectKey(?string $requestedKey, string $name): string
    {
        $trimmed = strtoupper(trim((string) $requestedKey));
        if ($trimmed !== '') {
            return mb_substr($trimmed, 0, 20);
        }
        $fromName = strtoupper(preg_replace('/[^A-Za-z]/', '', $name) ?? '');
        $fromName = mb_substr($fromName, 0, 4);
        return $fromName !== '' ? $fromName : 'PROJ';
    }

    private function resolveUniqueProjectKey(string $baseKey, ?string $excludeProjectId = null): string
    {
        $candidate = $baseKey;
        $suffix = 1;
        while (true) {
            $sql = 'SELECT 1 FROM "Projects" WHERE "Key" = :key';
            $params = ['key' => $candidate];
            if ($excludeProjectId !== null) {
                $sql .= ' AND "Id" != :exclude';
                $params['exclude'] = $excludeProjectId;
            }
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            if ($stmt->fetch() === false) {
                return $candidate;
            }
            $suffix++;
            $candidate = $baseKey . $suffix;
        }
    }

    private function fetchMembers(string $projectId): array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT m."Id", m."UserId", u."DisplayName", m."Color", m."Role", m."ReportsToId"
            FROM "ProjectMembers" m JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."ProjectId" = :pid
        SQL);
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $m): array => [
            'id' => $m['Id'], 'userId' => $m['UserId'], 'displayName' => $m['DisplayName'],
            'color' => $m['Color'], 'role' => $m['Role'], 'reportsToId' => $m['ReportsToId'],
        ], $stmt->fetchAll());
    }

    private function fetchColumns(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Columns" WHERE "ProjectId" = :pid ORDER BY "Order"');
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $c): array => [
            'id' => $c['Id'], 'name' => $c['Name'], 'done' => (bool) $c['Done'], 'color' => $c['Color'], 'order' => (int) $c['Order'],
        ], $stmt->fetchAll());
    }

    private function fetchReleases(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Releases" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $r): array => [
            'id' => $r['Id'], 'name' => $r['Name'], 'status' => $r['Status'], 'ownerId' => $r['OwnerId'],
            'startDate' => $r['StartDate'], 'endDate' => $r['EndDate'],
        ], $stmt->fetchAll());
    }

    private function fetchTaskTypes(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "TaskTypes" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $t): array => [
            'id' => $t['Id'], 'name' => $t['Name'], 'iconName' => $t['IconName'],
        ], $stmt->fetchAll());
    }

    private function fetchPrinciples(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Principles" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $p): array => [
            'id' => $p['Id'], 'key' => $p['Key'], 'title' => $p['Title'], 'description' => $p['Description'], 'documentUrl' => $p['DocumentUrl'],
        ], $stmt->fetchAll());
    }

    private function fetchDocuments(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Documents" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $docs = $stmt->fetchAll();

        $relStmt = $this->db->prepare('SELECT "RelatedDocumentId" FROM "DocumentRelation" WHERE "DocumentId" = :id');
        return array_map(function (array $d) use ($relStmt): array {
            $relStmt->execute(['id' => $d['Id']]);
            return [
                'id' => $d['Id'], 'key' => $d['Key'], 'title' => $d['Title'], 'url' => $d['Url'], 'description' => $d['Description'],
                'ownerId' => $d['OwnerId'], 'taskId' => $d['TaskId'], 'relatedDocumentIds' => $relStmt->fetchAll(PDO::FETCH_COLUMN),
            ];
        }, $docs);
    }

    private function fetchRisks(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Risks" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $risks = $stmt->fetchAll();

        $docStmt = $this->db->prepare('SELECT "DocumentId" FROM "RiskDocument" WHERE "RiskId" = :id');
        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "RiskPrinciple" WHERE "RiskId" = :id');
        $objStmt = $this->db->prepare('SELECT "ObjectiveId" FROM "RiskObjective" WHERE "RiskId" = :id');

        return array_map(function (array $r) use ($docStmt, $prinStmt, $objStmt): array {
            $docStmt->execute(['id' => $r['Id']]);
            $prinStmt->execute(['id' => $r['Id']]);
            $objStmt->execute(['id' => $r['Id']]);
            return [
                'id' => $r['Id'], 'key' => $r['Key'], 'title' => $r['Title'], 'description' => $r['Description'],
                'likelihood' => (int) $r['Likelihood'], 'impact' => (int) $r['Impact'], 'mitigations' => $r['Mitigations'],
                'ownerId' => $r['OwnerId'], 'taskId' => $r['TaskId'], 'status' => $r['Status'],
                'dateToClose' => $r['DateToClose'], 'dateClosed' => $r['DateClosed'],
                'documentIds' => $docStmt->fetchAll(PDO::FETCH_COLUMN),
                'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN),
                'objectiveIds' => $objStmt->fetchAll(PDO::FETCH_COLUMN),
            ];
        }, $risks);
    }

    private function fetchObjectives(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Objectives" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $objectives = $stmt->fetchAll();

        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "ObjectivePrinciple" WHERE "ObjectiveId" = :id');
        return array_map(function (array $o) use ($prinStmt): array {
            $prinStmt->execute(['id' => $o['Id']]);
            return [
                'id' => $o['Id'], 'key' => $o['Key'], 'title' => $o['Title'], 'description' => $o['Description'],
                'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN),
            ];
        }, $objectives);
    }

    private function fetchTeamsCommittees(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "TeamsCommittees" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $teams = $stmt->fetchAll();

        $memberStmt = $this->db->prepare('SELECT "ProjectMemberId" FROM "TeamCommitteeMember" WHERE "TeamCommitteeId" = :id');
        return array_map(function (array $t) use ($memberStmt): array {
            $memberStmt->execute(['id' => $t['Id']]);
            return [
                'id' => $t['Id'], 'key' => $t['Key'], 'name' => $t['Name'], 'description' => $t['Description'],
                'type' => $t['Type'], 'parentId' => $t['ParentId'], 'memberIds' => $memberStmt->fetchAll(PDO::FETCH_COLUMN),
            ];
        }, $teams);
    }

    private function fetchDecisions(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Decisions" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $decisions = $stmt->fetchAll();

        $docStmt = $this->db->prepare('SELECT "DocumentId" FROM "DecisionDocument" WHERE "DecisionId" = :id');
        $riskStmt = $this->db->prepare('SELECT "RiskId" FROM "DecisionRisk" WHERE "DecisionId" = :id');
        $prinStmt = $this->db->prepare('SELECT "PrincipleId" FROM "DecisionPrinciple" WHERE "DecisionId" = :id');
        $objStmt = $this->db->prepare('SELECT "ObjectiveId" FROM "DecisionObjective" WHERE "DecisionId" = :id');

        return array_map(function (array $d) use ($docStmt, $riskStmt, $prinStmt, $objStmt): array {
            $docStmt->execute(['id' => $d['Id']]);
            $riskStmt->execute(['id' => $d['Id']]);
            $prinStmt->execute(['id' => $d['Id']]);
            $objStmt->execute(['id' => $d['Id']]);
            return [
                'id' => $d['Id'], 'key' => $d['Key'], 'title' => $d['Title'], 'description' => $d['Description'],
                'type' => $d['Type'], 'status' => $d['Status'], 'outcome' => $d['Outcome'],
                'ownerId' => $d['OwnerId'], 'approver' => $d['Approver'], 'taskId' => $d['TaskId'],
                'documentIds' => $docStmt->fetchAll(PDO::FETCH_COLUMN),
                'riskIds' => $riskStmt->fetchAll(PDO::FETCH_COLUMN),
                'principleIds' => $prinStmt->fetchAll(PDO::FETCH_COLUMN),
                'objectiveIds' => $objStmt->fetchAll(PDO::FETCH_COLUMN),
            ];
        }, $decisions);
    }
}
