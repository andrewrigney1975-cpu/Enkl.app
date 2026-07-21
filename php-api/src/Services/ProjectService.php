<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\JwtService;
use Enkl\Api\Support\MemberPalette;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/ProjectService.cs. GetProjectDetail is built as several simple per-table
 * queries (one per related entity) rather than one giant EF-style multi-Include join — easier to
 * verify correct field-by-field against the .NET DTO shape than one large hand-written JOIN, and
 * Postgres handles a handful of small indexed queries per request perfectly well at this scale.
 */
final class ProjectService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function getProjectsForUser(string $userId): array
    {
        // Inactive (Portfolio-Planner placeholder) projects never appear in this switcher list — see
        // PortfolioService::updateProjectActive for the only place IsActive is ever flipped.
        $stmt = $this->db->prepare(<<<SQL
            SELECT p."Id", p."Name", p."Key"
            FROM "ProjectMembers" m
            JOIN "Projects" p ON p."Id" = m."ProjectId"
            WHERE m."UserId" = :uid AND p."IsActive" = true
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
            'savedQueries' => $this->fetchSavedQueries($projectId),
            'teamsCommittees' => $this->fetchTeamsCommittees($projectId),
            'decisions' => $this->fetchDecisions($projectId),
            'retrospectives' => $this->fetchRetrospectives($projectId),
            'headerButtonVisibility' => ProjectSettingsSerializer::parse($project['HeaderButtonVisibilityJson']),
            'workflow' => $project['WorkflowJson'] !== null ? json_decode($project['WorkflowJson']) : null,
            'startDate' => $project['StartDate'],
            'endDate' => $project['EndDate'],
            'description' => $project['Description'],
        ];
    }

    /**
     * Creates a brand new project (not via migration) under the caller's own Organisation, seeded
     * with the same default columns/task types createDefaultProject (src/js/storage.js) gives a new
     * local project, and adds the caller as its first member. Returns a fresh JWT alongside the
     * project, since the request's own token predates this project's existence and wouldn't grant
     * access to it otherwise (JWT membership claims are only refreshed at login — see JwtService).
     */
    // ARCHITECTURE-REVIEW.md finding 3.1, the review's own named example: this used to run INSERT
    // Project -> INSERT ProjectMember -> several INSERT Column/TaskType -> optional UPDATE Workflow
    // as separately auto-committed statements under PDO's default autocommit mode — a mid-sequence
    // failure (e.g. a constraint violation on the Nth column) left a partially-created project (a
    // Project row with no columns/task types, or worse, no ProjectMember row at all, orphaning it
    // from the caller who just "created" it). Wrapped exactly like MigrationService::migrate() does.
    public function create(string $callerUserId, array $request): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->createInTransaction($callerUserId, $request);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function createInTransaction(string $callerUserId, array $request): ?array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT u.*, o."Name" AS "OrganisationName" FROM "Users" u
            JOIN "Organisations" o ON o."Id" = u."OrganisationId"
            WHERE u."Id" = :id
        SQL);
        $stmt->execute(['id' => $callerUserId]);
        $user = $stmt->fetch();
        if ($user === false) {
            return null;
        }

        // Only a template belonging to the caller's own Organisation may be applied — same org-scoping
        // as every other Organisation-owned lookup (see TemplateService).
        $template = null;
        if (!empty($request['templateId'])) {
            $tplStmt = $this->db->prepare('SELECT * FROM "ProjectTemplates" WHERE "Id" = :id AND "OrganisationId" = :orgId');
            $tplStmt->execute(['id' => $request['templateId'], 'orgId' => $user['OrganisationId']]);
            $template = $tplStmt->fetch();
            if ($template === false) {
                throw new ApiValidationException('Template not found.');
            }
        }

        $name = trim((string) ($request['name'] ?? ''));
        if ($name === '') {
            $name = 'Untitled Project';
        }
        $requestedKey = $this->deriveProjectKey($request['key'] ?? null, $name);
        $uniqueKey = $this->resolveUniqueProjectKey($requestedKey, $user['OrganisationId']);
        $warning = $uniqueKey !== $requestedKey
            ? "Project key \"{$requestedKey}\" was already in use; created as \"{$uniqueKey}\" instead."
            : null;

        $projectId = Uuid::v4();
        $settingsJson = $template !== null ? $template['SettingsJson'] : '{}';
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Projects" ("Id", "OrganisationId", "Name", "Key", "StartDate", "EndDate", "Description", "DateCreated", "DateLastModified", "TaskCounter", "HeaderButtonVisibilityJson")
            VALUES (:id, :orgId, :name, :key, :start, :end, :description, now(), now(), 1, :settings)
        SQL);
        $stmt->execute([
            'id' => $projectId,
            'orgId' => $user['OrganisationId'],
            'name' => $name,
            'key' => $uniqueKey,
            'start' => $request['startDate'] ?? null,
            'end' => $request['endDate'] ?? null,
            'description' => isset($request['description']) ? trim((string) $request['description']) : null,
            'settings' => $settingsJson,
        ]);

        // The creator is the project's "owner" — always its first Project Admin, so a freshly
        // created project is never immediately locked out of column/settings/workflow/member
        // management (see Auth/ProjectAdminMiddleware.php's own doc comment for what this gates).
        $stmt = $this->db->prepare(
            'INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color", "IsProjectAdmin") VALUES (:id, :pid, :uid, :color, true)'
        );
        $stmt->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'uid' => $callerUserId, 'color' => MemberPalette::COLORS[0]]);

        if ($template !== null) {
            $templateColumns = json_decode($template['ColumnsJson'], true) ?? [];
            usort($templateColumns, static fn(array $a, array $b): int => $a['order'] <=> $b['order']);

            // Column ids are global PKs, never reused by a new project — every column gets a fresh id
            // here, and this map is what lets the template's Workflow (keyed by the SOURCE project's
            // column ids) be correctly rewritten to point at THESE new ids below, instead of silently
            // orphaning itself the way a verbatim WorkflowJson copy would (see remapWorkflowColumnIds).
            $idMap = [];
            $colStmt = $this->db->prepare(
                'INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Color", "Order", "Cap") VALUES (:id, :pid, :name, :done, :color, :order, :cap)'
            );
            foreach ($templateColumns as $col) {
                $newId = Uuid::v4();
                $idMap[$col['id']] = $newId;
                // (int) here, not the raw PHP bool — see ColumnService::create's comment on why.
                $colStmt->execute([
                    'id' => $newId, 'pid' => $projectId, 'name' => $col['name'],
                    'done' => (int) $col['done'], 'color' => $col['color'] ?? null, 'order' => $col['order'],
                    'cap' => $col['cap'] ?? -1,
                ]);
            }

            $templateTaskTypes = json_decode($template['TaskTypesJson'], true) ?? [];
            $typeStmt = $this->db->prepare('INSERT INTO "TaskTypes" ("Id", "ProjectId", "Name", "IconName") VALUES (:id, :pid, :name, :icon)');
            foreach ($templateTaskTypes as $tt) {
                $typeStmt->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'name' => $tt['name'], 'icon' => $tt['iconName'] ?? null]);
            }

            if ($template['WorkflowJson'] !== null) {
                $remapped = $this->remapWorkflowColumnIds($template['WorkflowJson'], $idMap);
                if ($remapped !== null) {
                    $wfStmt = $this->db->prepare('UPDATE "Projects" SET "WorkflowJson" = :json WHERE "Id" = :id');
                    $wfStmt->execute(['json' => $remapped, 'id' => $projectId]);
                }
            }
        } else {
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
        }

        $stmt = $this->db->prepare('SELECT "ProjectId", "Role", "IsProjectAdmin" FROM "ProjectMembers" WHERE "UserId" = :uid');
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
        $key = $requestedKey === $project['Key'] ? $project['Key'] : $this->resolveUniqueProjectKey($requestedKey, $project['OrganisationId'], $projectId);

        $stmt = $this->db->prepare(<<<SQL
            UPDATE "Projects"
            SET "Name" = :name, "Key" = :key, "StartDate" = :start, "EndDate" = :end, "Description" = :description, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL);
        $stmt->execute([
            'name' => $name, 'key' => $key,
            'start' => $request['startDate'] ?? null, 'end' => $request['endDate'] ?? null,
            'description' => isset($request['description']) ? trim((string) $request['description']) : null,
            'id' => $projectId,
        ]);

        return ['id' => $projectId, 'name' => $name, 'key' => $key];
    }

    /** Pure check, no mutation — re-derives org membership from the caller's own JWT claim
     * (organisationId), never a client-supplied value, same cross-org-isolation shape as
     * PortfolioService. A wrong-org or nonexistent projectId returns null (404) either way — no
     * enumeration oracle. */
    public function checkKeyAvailability(string $organisationId, string $projectId, string $requestedKey): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $projectId, 'orgId' => $organisationId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $normalized = $this->deriveProjectKey($requestedKey, '');
        $available = false;
        if ($normalized !== '') {
            $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Key" = :key AND "OrganisationId" = :orgId AND "Id" != :id');
            $stmt->execute(['key' => $normalized, 'orgId' => $organisationId, 'id' => $projectId]);
            $available = $stmt->fetch() === false;
        }
        return ['available' => $available, 'normalizedKey' => $normalized];
    }

    /** Same check as checkKeyAvailability, but for a project that doesn't exist yet (creation time) —
     * any authenticated org user may create a project (see ProjectsController::create, ungated by any
     * per-project policy), so this has no projectId to verify against, just the caller's own org. */
    public function checkKeyAvailabilityForCreation(string $organisationId, string $requestedKey): array
    {
        $normalized = $this->deriveProjectKey($requestedKey, '');
        $available = false;
        if ($normalized !== '') {
            $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Key" = :key AND "OrganisationId" = :orgId');
            $stmt->execute(['key' => $normalized, 'orgId' => $organisationId]);
            $available = $stmt->fetch() === false;
        }
        return ['available' => $available, 'normalizedKey' => $normalized];
    }

    /** Org-Admin-only, cascading rename: unlike update()'s silent auto-suffix-on-collision behavior
     * (fine for an incidental name-driven key derivation), an explicit key CHANGE the caller is about
     * to irreversibly confirm must fail loudly on collision instead — re-checked here even though the
     * frontend already called checkKeyAvailability, closing the race window between that check and
     * this commit. Every task's Key ("{oldKey}-{counter}") is rebuilt by a length-prefix replace via
     * SUBSTRING so it stays correct even if a key itself contains a hyphen (deriveProjectKey doesn't
     * strip them) — active and archived tasks are the same table (Tasks.Archived is a plain bool), so
     * one statement covers both. */
    public function changeKey(string $organisationId, string $projectId, string $newKey): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key", "Name" FROM "Projects" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $projectId, 'orgId' => $organisationId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $normalized = $this->deriveProjectKey($newKey, '');
        if ($normalized === '') {
            throw new ApiValidationException('Project key is required.');
        }
        $dupStmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Key" = :key AND "OrganisationId" = :orgId AND "Id" != :id');
        $dupStmt->execute(['key' => $normalized, 'orgId' => $organisationId, 'id' => $projectId]);
        if ($dupStmt->fetch() !== false) {
            throw new ApiValidationException('That project key is already in use in this organisation.');
        }

        $oldKey = $project['Key'];
        if ($normalized === $oldKey) {
            return ['id' => $projectId, 'name' => $project['Name'], 'key' => $oldKey];
        }

        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE "Projects" SET "Key" = :key, "DateLastModified" = now() WHERE "Id" = :id')
                ->execute(['key' => $normalized, 'id' => $projectId]);
            $this->db->prepare(
                'UPDATE "Tasks" SET "Key" = :newKey || SUBSTRING("Key" FROM :oldKeyLen + 1) WHERE "ProjectId" = :projectId'
            )->execute(['newKey' => $normalized, 'oldKeyLen' => strlen($oldKey), 'projectId' => $projectId]);
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        return ['id' => $projectId, 'name' => $project['Name'], 'key' => $normalized];
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

    /**
     * Rewrites a snapshotted Workflow's column-id references (workflow.nodes' object keys and every
     * edge's fromColumnId/toColumnId — see features/workflow-engine.js's shape comment) through
     * $idMap, dropping anything that fails to map. Used when applying a Project Template: the
     * template's Workflow was captured against the SOURCE project's column ids, which the newly
     * created project's columns don't share (see the id-map comment in create() above).
     * @param array<string, string> $idMap oldColumnId => newColumnId
     */
    private function remapWorkflowColumnIds(?string $workflowJson, array $idMap): ?string
    {
        if ($workflowJson === null || $workflowJson === '') {
            return null;
        }
        $decoded = json_decode($workflowJson, true);
        if (!is_array($decoded)) {
            return null;
        }

        $newNodes = [];
        foreach ($decoded['nodes'] ?? [] as $oldId => $node) {
            if (isset($idMap[$oldId])) {
                $newNodes[$idMap[$oldId]] = $node;
            }
        }

        $newEdges = [];
        foreach ($decoded['edges'] ?? [] as $edge) {
            if (!is_array($edge) || !isset($edge['fromColumnId'], $edge['toColumnId'])) {
                continue;
            }
            if (!isset($idMap[$edge['fromColumnId']], $idMap[$edge['toColumnId']])) {
                continue;
            }
            $edge['fromColumnId'] = $idMap[$edge['fromColumnId']];
            $edge['toColumnId'] = $idMap[$edge['toColumnId']];
            $newEdges[] = $edge;
        }

        return json_encode(['nodes' => (object) $newNodes, 'edges' => $newEdges]);
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

    // Scoped to the target Organisation, not global — a project key is only ever displayed/used
    // within its own org's context, so two unrelated organisations both having a "DEMO" project is
    // fine and should never force one of them into a "DEMO2"-style rename.
    private function resolveUniqueProjectKey(string $baseKey, string $organisationId, ?string $excludeProjectId = null): string
    {
        $candidate = $baseKey;
        $suffix = 1;
        while (true) {
            $sql = 'SELECT 1 FROM "Projects" WHERE "Key" = :key AND "OrganisationId" = :orgId';
            $params = ['key' => $candidate, 'orgId' => $organisationId];
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
            SELECT m."Id", m."UserId", u."DisplayName", u."EmailAddress", u."IsActive", m."Color", m."Role", m."AllocatedFraction", m."ReportsToId", m."IsProjectAdmin"
            FROM "ProjectMembers" m JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."ProjectId" = :pid
        SQL);
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $m): array => [
            'id' => $m['Id'], 'userId' => $m['UserId'], 'displayName' => $m['DisplayName'], 'email' => $m['EmailAddress'],
            'color' => $m['Color'], 'role' => $m['Role'], 'allocatedFraction' => $m['AllocatedFraction'] !== null ? (int) $m['AllocatedFraction'] : null, 'reportsToId' => $m['ReportsToId'],
            'isProjectAdmin' => (bool) $m['IsProjectAdmin'], 'isActive' => (bool) $m['IsActive'],
        ], $stmt->fetchAll());
    }

    private function fetchColumns(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Columns" WHERE "ProjectId" = :pid ORDER BY "Order"');
        $stmt->execute(['pid' => $projectId]);
        return array_map(static fn(array $c): array => [
            'id' => $c['Id'], 'name' => $c['Name'], 'done' => (bool) $c['Done'], 'color' => $c['Color'], 'order' => (int) $c['Order'],
            'cap' => (int) ($c['Cap'] ?? -1),
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
            'isOrganisationWide' => (bool) $p['IsOrganisationWide'],
        ], $stmt->fetchAll());
    }

    private function fetchRetrospectives(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Retrospectives" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $retros = $stmt->fetchAll();

        $participantsStmt = $this->db->prepare('SELECT "ProjectMemberId" FROM "RetrospectiveParticipants" WHERE "RetrospectiveId" = :rid');
        $itemsStmt = $this->db->prepare('SELECT * FROM "RetrospectiveItems" WHERE "RetrospectiveId" = :rid ORDER BY "SortOrder"');
        $actionItemsStmt = $this->db->prepare('SELECT * FROM "RetrospectiveActionItems" WHERE "RetrospectiveId" = :rid ORDER BY "SortOrder"');

        return array_map(function (array $r) use ($participantsStmt, $itemsStmt, $actionItemsStmt): array {
            $participantsStmt->execute(['rid' => $r['Id']]);
            $itemsStmt->execute(['rid' => $r['Id']]);
            $actionItemsStmt->execute(['rid' => $r['Id']]);

            return [
                'id' => $r['Id'], 'key' => $r['Key'], 'releaseId' => $r['ReleaseId'], 'team' => $r['Team'],
                'background' => $r['Background'], 'retroDate' => $r['RetroDate'],
                'lastTimerDurationSeconds' => $r['LastTimerDurationSeconds'] !== null ? (int) $r['LastTimerDurationSeconds'] : null,
                'participantIds' => $participantsStmt->fetchAll(PDO::FETCH_COLUMN),
                'items' => array_map(static fn(array $i): array => [
                    'id' => $i['Id'], 'column' => $i['Column'], 'text' => $i['Text'],
                    'sortOrder' => (int) $i['SortOrder'], 'promotedPrincipleId' => $i['PromotedPrincipleId'],
                ], $itemsStmt->fetchAll()),
                'actionItems' => array_map(static fn(array $a): array => [
                    'id' => $a['Id'], 'text' => $a['Text'], 'assigneeId' => $a['AssigneeId'],
                    'completed' => (bool) $a['Completed'], 'sortOrder' => (int) $a['SortOrder'],
                ], $actionItemsStmt->fetchAll()),
                'dateCreated' => $r['DateCreated'], 'dateLastModified' => $r['DateLastModified'],
            ];
        }, $retros);
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

    private function fetchSavedQueries(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Name", "Sql", "DateCreated", "ExposeViaApi" FROM "SavedQueries" WHERE "ProjectId" = :pid ORDER BY "DateCreated"');
        $stmt->execute(['pid' => $projectId]);
        return array_map(fn($q) => [
            'id' => $q['Id'], 'name' => $q['Name'], 'sql' => $q['Sql'], 'dateCreated' => $q['DateCreated'],
            'exposeViaApi' => (bool) $q['ExposeViaApi'],
        ], $stmt->fetchAll());
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
