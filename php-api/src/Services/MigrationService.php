<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use Enkl\Api\Validation\CycleDetection;
use Enkl\Api\Validation\FieldClamps;
use PDO;

/**
 * One-time migration of an exportProjectJSON() document (src/js/features/export.js) into the
 * database, applying the Organisation find-or-create + cross-project User dedup heuristics. Runs as
 * a single transaction — any failure leaves nothing partially created. Ported from
 * Services/MigrationService.cs; see that file's own comments for the "why" behind the two-pass
 * (create rows, then wire relations by old-id/key map) shape.
 */
final class MigrationService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function migrate(array $request, ?string $callerOrgId = null): array
    {
        $warnings = [];
        $this->db->beginTransaction();

        try {
            [$organisationId, $organisationCreated] = $this->resolveOrganisation((string) ($request['organisationName'] ?? ''), $callerOrgId);

            // Project keys are unique per-Organisation, not globally — see resolveUniqueProjectKey.
            // Every fresh local install still seeds a project with the same "SMPL" key, so a key
            // collision WITHIN the target org is an expected, common case (e.g. repeat-migrating into
            // the same org), just no longer a false collision against some unrelated org's project.
            $requestedKey = (string) ($request['project']['key'] ?? '');
            $uniqueKey = $this->resolveUniqueProjectKey($requestedKey, $organisationId);
            if ($uniqueKey !== $requestedKey) {
                $warnings[] = "Project key \"{$requestedKey}\" was already in use in this organisation; migrated as \"{$uniqueKey}\" instead.";
            }

            $projectId = Uuid::v4();
            $headerButtonVisibilityJson = isset($request['headerButtonVisibility']) && $request['headerButtonVisibility'] !== null
                ? ProjectSettingsSerializer::serialize(ProjectSettingsSerializer::parse(json_encode($request['headerButtonVisibility'])))
                : '{}';
            $workflowJson = isset($request['workflow']) && $request['workflow'] !== null ? json_encode($request['workflow']) : null;

            $this->db->prepare(<<<SQL
                INSERT INTO "Projects" ("Id", "OrganisationId", "Name", "Key", "DateCreated", "DateLastModified", "TaskCounter", "HeaderButtonVisibilityJson", "WorkflowJson")
                VALUES (:id, :orgId, :name, :key, now(), now(), 1, :hbv, :workflow)
            SQL)->execute([
                'id' => $projectId, 'orgId' => $organisationId, 'name' => $request['project']['name'] ?? '',
                'key' => $uniqueKey, 'hbv' => $headerButtonVisibilityJson, 'workflow' => $workflowJson,
            ]);

            $columnsByName = [];
            $colStmt = $this->db->prepare('INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Color", "Order", "Cap") VALUES (:id, :pid, :name, :done, :color, :order, :cap)');
            foreach ($request['columns'] ?? [] as $c) {
                $id = Uuid::v4();
                $requestedCap = (int) ($c['cap'] ?? -1);
                $cap = $requestedCap < 1 ? -1 : $requestedCap;
                // (int), not the raw PHP bool — PDO's array-form execute() would bind false as ''
                // otherwise, which Postgres's boolean parser rejects.
                $colStmt->execute(['id' => $id, 'pid' => $projectId, 'name' => $c['name'], 'done' => (int) (bool) $c['done'], 'color' => $c['color'] ?? null, 'order' => (int) $c['order'], 'cap' => $cap]);
                $columnsByName[$c['name']] = $id;
            }

            [$memberByOldId, $usersCreated, $usersMatched] = $this->createUsersAndMembers(
                $request['members'] ?? [], $projectId, $organisationId, $organisationCreated, $warnings
            );

            $releasesByName = $this->createReleases($request['releases'] ?? [], $projectId, $memberByOldId);
            $taskTypesByName = $this->createTaskTypes($request['taskTypes'] ?? [], $projectId);
            $principleByOldId = $this->createPrinciples($request['principles'] ?? [], $projectId);

            $flatTasks = $this->flattenAndDedupTasks($request['hierarchy'] ?? []);
            [$taskByOldId, $taskByKey, $taskCounter] = $this->createTasks(
                $flatTasks, $projectId, $columnsByName, $memberByOldId, $releasesByName, $taskTypesByName, $warnings
            );
            $this->db->prepare('UPDATE "Projects" SET "TaskCounter" = :c WHERE "Id" = :id')->execute(['c' => $taskCounter, 'id' => $projectId]);

            $documentByOldId = $this->createDocuments($request['documents'] ?? [], $projectId, $memberByOldId, $taskByOldId);
            $riskByOldId = $this->createRisks($request['risks'] ?? [], $projectId, $memberByOldId, $taskByOldId);
            $objectiveByOldId = $this->createObjectives($request['objectives'] ?? [], $projectId);
            $teamCommitteeByOldId = $this->createTeamsCommittees($request['teamsCommittees'] ?? [], $projectId);
            $decisionByOldId = $this->createDecisions($request['decisions'] ?? [], $projectId, $memberByOldId, $taskByOldId);

            // Phase 2: relational wiring, now every old-id/key -> new-entity map exists.
            $this->wireTaskRelations($flatTasks, $taskByKey, $memberByOldId);
            $this->wireDocumentRelations($request['documents'] ?? [], $documentByOldId);
            $this->wireRiskRelations($request['risks'] ?? [], $riskByOldId, $documentByOldId, $principleByOldId, $objectiveByOldId);
            $this->wireObjectiveRelations($request['objectives'] ?? [], $objectiveByOldId, $principleByOldId);
            $this->wireTeamCommitteeRelations($request['teamsCommittees'] ?? [], $teamCommitteeByOldId, $memberByOldId);
            $this->wireDecisionRelations($request['decisions'] ?? [], $decisionByOldId, $documentByOldId, $riskByOldId, $principleByOldId, $objectiveByOldId);

            // Phase 3: an externally-supplied export is untrusted input — validate the DAG/trees it
            // describes before committing, exactly as the client-side wouldCreateCycle/wouldCreateParentCycle
            // guard interactive edits (src/js/utils.js).
            $this->validateNoCycles($flatTasks, $taskByKey, $request['teamsCommittees'] ?? [], $teamCommitteeByOldId);

            $this->db->commit();

            return [
                'projectId' => $projectId, 'organisationId' => $organisationId, 'organisationCreated' => $organisationCreated,
                'usersCreated' => $usersCreated, 'usersMatched' => $usersMatched, 'warnings' => $warnings,
            ];
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    /** @return array{0: string, 1: bool} */
    private function resolveOrganisation(string $name, ?string $callerOrgId): array
    {
        if ($callerOrgId !== null) {
            // Authenticated caller: always migrate into their own Organisation regardless of what
            // name the export document carries. This is the "add another local project to my
            // existing org" flow — never let a submitted name redirect it into someone else's org.
            $stmt = $this->db->prepare('SELECT "Id" FROM "Organisations" WHERE "Id" = :id');
            $stmt->execute(['id' => $callerOrgId]);
            $callerOrg = $stmt->fetchColumn();
            if ($callerOrg !== false) {
                return [$callerOrg, false];
            }
            // Falls through to name-based resolution only if the token's org somehow no longer
            // exists; the existing-org check below still protects that path.
        }

        $normalized = UsernameNormalizer::normalize($name);
        $stmt = $this->db->prepare('SELECT "Id" FROM "Organisations" WHERE "NormalizedName" = :n');
        $stmt->execute(['n' => $normalized]);
        $existing = $stmt->fetchColumn();
        if ($existing !== false) {
            // An unauthenticated caller matching an existing Organisation purely by name was the
            // cross-tenant account-injection vector from the security review (finding C3): anyone
            // who knew/guessed an org's display name could get a login-capable user account
            // silently created inside it. Only an authenticated member of that org (handled above)
            // may add users to it via migration — everyone else must go through the bootstrap
            // (brand-new org) path below.
            throw new ApiValidationException(
                "An organisation named \"{$name}\" already exists. Sign in as a member of that organisation to migrate additional projects into it."
            );
        }

        $id = Uuid::v4();
        $this->db->prepare('INSERT INTO "Organisations" ("Id", "Name", "NormalizedName", "CreatedAt") VALUES (:id, :name, :normalized, now())')
            ->execute(['id' => $id, 'name' => $name, 'normalized' => $normalized]);
        return [$id, true];
    }

    /** @return array{0: array<string,string>, 1: int, 2: int} old member id -> new ProjectMember id */
    private function createUsersAndMembers(array $members, string $projectId, string $organisationId, bool $organisationCreated, array &$warnings): array
    {
        $usersCreated = 0;
        $usersMatched = 0;
        $userIdByNormalizedKey = [];
        $memberByOldId = [];
        $firstAdminAssigned = false;
        // The first member listed in the export is treated as this project's "owner" — same
        // always-a-Project-Admin default ProjectService::create gives a freshly created project's
        // creator, applied here so a migrated project isn't immediately locked out of column/
        // settings/workflow/member management either.
        $isFirstProjectMember = true;

        $findInOrgStmt = $this->db->prepare('SELECT "Id", "EmailAddress" FROM "Users" WHERE "NormalizedUsername" = :n AND "OrganisationId" = :org');
        $findAnywhereStmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "NormalizedUsername" = :n');
        $insertUserStmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt")
            VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, :hash, :displayName, true, :isAdmin, now())
        SQL);
        $insertMemberStmt = $this->db->prepare('INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color", "Role", "AllocatedFraction", "IsProjectAdmin") VALUES (:id, :pid, :uid, :color, :role, :allocatedFraction, :isProjectAdmin)');
        $backfillEmailStmt = $this->db->prepare('UPDATE "Users" SET "EmailAddress" = :email, "NormalizedEmailAddress" = :normalizedEmail WHERE "Id" = :id');

        foreach ($members as $m) {
            $normalized = UsernameNormalizer::normalize($m['name']);

            if (!isset($userIdByNormalizedKey[$normalized])) {
                $findInOrgStmt->execute(['n' => $normalized, 'org' => $organisationId]);
                $existingInOrg = $findInOrgStmt->fetch();

                if ($existingInOrg !== false) {
                    $userId = $existingInOrg['Id'];
                    $usersMatched++;

                    // Self-heal a missing email on a matched account the same way MemberService's
                    // matched-existing-user branch does — never blocks the migration: an invalid or
                    // already-taken email is silently dropped rather than failing the import.
                    if ($existingInOrg['EmailAddress'] === null && !empty($m['email'])) {
                        try {
                            [$backfillEmail, $backfillNormalized] = EmailValidation::validateAndNormalize($this->db, $m['email'], false, $userId);
                            $backfillEmailStmt->execute(['email' => $backfillEmail, 'normalizedEmail' => $backfillNormalized, 'id' => $userId]);
                        } catch (ApiValidationException) {
                            // ignore — not the point of this import
                        }
                    }
                } else {
                    $usernameToUse = $normalized;
                    $findAnywhereStmt->execute(['n' => $normalized]);
                    if ($findAnywhereStmt->fetch() !== false) {
                        $usernameToUse = $this->resolveUniqueUsername($normalized);
                        $warnings[] = "User \"{$m['name']}\" already exists in another organisation; created as \"{$usernameToUse}\" instead.";
                    }

                    // Unlike OrganisationService::createUser/MemberService::create, a missing or
                    // unusable email here never blocks the migration itself — instead it's surfaced as
                    // a warning so the Org Admin can backfill it afterward via Manage Users.
                    $email = null;
                    $normalizedEmail = null;
                    if (empty($m['email'])) {
                        $warnings[] = "User \"{$m['name']}\" was migrated without an email address. An organisation admin must add one in Manage Users before SAML sign-in can be enabled for them.";
                    } else {
                        try {
                            [$email, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $m['email'], false, null);
                        } catch (ApiValidationException $ex) {
                            $warnings[] = "User \"{$m['name']}\": email \"{$m['email']}\" could not be used ({$ex->getMessage()}); an organisation admin must add a valid one in Manage Users.";
                        }
                    }

                    $isFirstAdminOfNewOrg = $organisationCreated && !$firstAdminAssigned;
                    $userId = Uuid::v4();
                    // (int), not the raw PHP bool — PDO's array-form execute() would bind false as ''
                    // otherwise, which Postgres's boolean parser rejects.
                    $insertUserStmt->execute([
                        'id' => $userId, 'orgId' => $organisationId, 'username' => $usernameToUse, 'normalized' => $usernameToUse,
                        'email' => $email, 'normalizedEmail' => $normalizedEmail,
                        'hash' => PasswordHasher::hash('enklUserPassword'), 'displayName' => $m['name'], 'isAdmin' => (int) $isFirstAdminOfNewOrg,
                    ]);
                    $usersCreated++;
                    if ($isFirstAdminOfNewOrg) {
                        $firstAdminAssigned = true;
                    }
                }
                $userIdByNormalizedKey[$normalized] = $userId;
            }

            // Clamped the same way MemberService::update does — null stays null (never assigned an
            // allocation), anything else is rounded and clamped to [0, 100].
            $allocatedFraction = $m['allocatedFraction'] ?? null;
            if ($allocatedFraction !== null) {
                $allocatedFraction = max(0, min(100, (int) round((float) $allocatedFraction)));
            }

            $memberId = Uuid::v4();
            $insertMemberStmt->execute([
                'id' => $memberId, 'pid' => $projectId, 'uid' => $userIdByNormalizedKey[$normalized], 'color' => $m['color'],
                'role' => $m['role'] ?? null, 'allocatedFraction' => $allocatedFraction, 'isProjectAdmin' => (int) $isFirstProjectMember,
            ]);
            $memberByOldId[$m['id']] = $memberId;
            $isFirstProjectMember = false;
        }

        $reportsToStmt = $this->db->prepare('UPDATE "ProjectMembers" SET "ReportsToId" = :reportsTo WHERE "Id" = :id');
        foreach ($members as $m) {
            if (($m['reportsToId'] ?? null) !== null && isset($memberByOldId[$m['reportsToId']])) {
                $reportsToStmt->execute(['reportsTo' => $memberByOldId[$m['reportsToId']], 'id' => $memberByOldId[$m['id']]]);
            }
        }

        return [$memberByOldId, $usersCreated, $usersMatched];
    }

    private function createReleases(array $releases, string $projectId, array $memberByOldId): array
    {
        $byName = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Releases" ("Id", "ProjectId", "Name", "Status", "OwnerId", "StartDate", "EndDate", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :name, :status, :ownerId, :start, :end, :created, :modified)
        SQL);
        foreach ($releases as $r) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'name' => $r['name'],
                'status' => in_array($r['status'] ?? null, ['pending', 'in_progress', 'deployed'], true) ? $r['status'] : 'pending',
                'ownerId' => $memberByOldId[$r['ownerId'] ?? ''] ?? null,
                'start' => $this->parseDateOnly($r['startDate'] ?? null), 'end' => $this->parseDateOnly($r['endDate'] ?? null),
                'created' => $this->parseDateTime($r['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($r['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byName[$r['name']] = $id;
        }
        return $byName;
    }

    private function createTaskTypes(array $taskTypes, string $projectId): array
    {
        $byName = [];
        $stmt = $this->db->prepare('INSERT INTO "TaskTypes" ("Id", "ProjectId", "Name", "IconName") VALUES (:id, :pid, :name, :icon)');
        foreach ($taskTypes as $t) {
            $id = Uuid::v4();
            $stmt->execute(['id' => $id, 'pid' => $projectId, 'name' => $t['name'], 'icon' => FieldClamps::validIconNameOrNull($t['iconName'] ?? null)]);
            $byName[$t['name']] = $id;
        }
        return $byName;
    }

    private function createPrinciples(array $principles, string $projectId): array
    {
        $byOldId = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Principles" ("Id", "ProjectId", "Key", "Title", "Description", "DocumentUrl", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :docUrl, :created, :modified)
        SQL);
        foreach ($principles as $p) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $p['key'], 'title' => $p['title'],
                'description' => $p['description'] ?? null, 'docUrl' => $p['documentUrl'] ?? null,
                'created' => $this->parseDateTime($p['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($p['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$p['id']] = $id;
        }
        return $byOldId;
    }

    /**
     * buildHierarchy() (src/js/features/export.js) walks the dependency graph as a tree, but the
     * underlying data is a DAG — a task depended on by two others gets serialized once under each
     * dependent, so it can appear more than once in this tree. Dedup by key, or the per-project
     * unique key constraint rejects the second copy.
     */
    private function flattenAndDedupTasks(array $hierarchy): array
    {
        $flat = [];
        $this->flattenTasks($hierarchy, $flat);

        $seenKeys = [];
        $deduped = [];
        foreach ($flat as $t) {
            if (!isset($seenKeys[$t['key']])) {
                $seenKeys[$t['key']] = true;
                $deduped[] = $t;
            }
        }
        return $deduped;
    }

    private function flattenTasks(array $nodes, array &$into): void
    {
        foreach ($nodes as $node) {
            $into[] = $node;
            if (!empty($node['subtasks'])) {
                $this->flattenTasks($node['subtasks'], $into);
            }
        }
    }

    /** @return array{0: array<string,string>, 1: array<string,string>, 2: int} */
    private function createTasks(array $flatTasks, string $projectId, array $columnsByName, array $memberByOldId, array $releasesByName, array $taskTypesByName, array &$warnings): array
    {
        $byOldId = [];
        $byKey = [];
        $maxCounter = 1;

        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Tasks" (
                "Id", "ProjectId", "Key", "Title", "Description", "Priority", "ColumnId", "AssigneeId", "ReleaseId", "TypeId",
                "DocumentationUrl", "DateCreated", "DateLastModified", "DateDone", "StartDate", "EndDate",
                "BusinessValue", "TaskCost", "Progress", "EstimatedEffort", "ActualEffort", "Archived"
            ) VALUES (
                :id, :pid, :key, :title, :description, :priority, :columnId, :assigneeId, :releaseId, :typeId,
                :docUrl, :created, :modified, :dateDone, :start, :end,
                :businessValue, :taskCost, :progress, :estimatedEffort, :actualEffort, :archived
            )
        SQL);

        foreach ($flatTasks as $t) {
            if (!isset($columnsByName[$t['column']])) {
                $warnings[] = "Task {$t['key']}: column \"{$t['column']}\" not found in this project, skipped.";
                continue;
            }

            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $t['key'], 'title' => $t['title'], 'description' => $t['description'] ?? null,
                'priority' => in_array($t['priority'] ?? null, ['low', 'medium', 'high', 'critical'], true) ? $t['priority'] : 'medium',
                'columnId' => $columnsByName[$t['column']],
                'assigneeId' => $memberByOldId[$t['assigneeId'] ?? ''] ?? null,
                'releaseId' => $releasesByName[$t['release'] ?? ''] ?? null,
                'typeId' => $taskTypesByName[$t['type'] ?? ''] ?? null,
                'docUrl' => $t['documentationUrl'] ?? null,
                'created' => $this->parseDateTime($t['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($t['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'dateDone' => $this->parseDateTime($t['dateDone'] ?? null),
                'start' => $this->parseDateOnly($t['startDate'] ?? null), 'end' => $this->parseDateOnly($t['endDate'] ?? null),
                'businessValue' => $t['businessValue'] ?? null, 'taskCost' => $t['taskCost'] ?? null, 'progress' => (int) ($t['progress'] ?? 0),
                'estimatedEffort' => $t['estimatedEffort'] ?? null, 'actualEffort' => $t['actualEffort'] ?? null,
                // (int), not the raw PHP bool — PDO's array-form execute() would bind false as ''
                // otherwise, which Postgres's boolean parser rejects.
                'archived' => (int) (bool) ($t['archived'] ?? false),
            ]);
            $byOldId[$t['id']] = $id;
            $byKey[$t['key']] = $id;

            $dashIndex = strrpos($t['key'], '-');
            if ($dashIndex !== false && is_numeric($n = substr($t['key'], $dashIndex + 1)) && (int) $n >= $maxCounter) {
                $maxCounter = (int) $n + 1;
            }
        }

        return [$byOldId, $byKey, $maxCounter];
    }

    private function wireTaskRelations(array $flatTasks, array $taskByKey, array $memberByOldId): void
    {
        $parentStmt = $this->db->prepare('UPDATE "Tasks" SET "ParentTaskId" = :parentId WHERE "Id" = :id');
        $depStmt = $this->db->prepare('INSERT INTO "TaskDependencies" ("TaskId", "DependsOnTaskId") VALUES (:tid, :did)');
        $auditStmt = $this->db->prepare(<<<SQL
            INSERT INTO "TaskAuditLogEntries" ("Id", "TaskId", "Timestamp", "Field", "OldValue", "NewValue")
            VALUES (:id, :taskId, :timestamp, :field, :oldValue, :newValue)
        SQL);
        $commentStmt = $this->db->prepare(<<<SQL
            INSERT INTO "TaskComments" ("Id", "TaskId", "Text", "DateCreated", "AuthorId", "AuthorName")
            VALUES (:id, :taskId, :text, :dateCreated, :authorId, :authorName)
        SQL);

        foreach ($flatTasks as $t) {
            if (!isset($taskByKey[$t['key']])) {
                continue;
            }
            $taskId = $taskByKey[$t['key']];

            if (($t['parentKey'] ?? null) !== null && isset($taskByKey[$t['parentKey']])) {
                $parentStmt->execute(['parentId' => $taskByKey[$t['parentKey']], 'id' => $taskId]);
            }

            foreach ($t['dependsOn'] ?? [] as $depKey) {
                if (isset($taskByKey[$depKey])) {
                    $depStmt->execute(['tid' => $taskId, 'did' => $taskByKey[$depKey]]);
                }
            }

            foreach ($t['auditLog'] ?? [] as $entry) {
                $auditStmt->execute([
                    'id' => Uuid::v4(), 'taskId' => $taskId,
                    'timestamp' => $this->parseDateTime($entry['timestamp'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                    'field' => $entry['field'], 'oldValue' => $entry['oldValue'] ?? null, 'newValue' => $entry['newValue'] ?? null,
                ]);
            }

            foreach ($t['comments'] ?? [] as $c) {
                $commentStmt->execute([
                    'id' => Uuid::v4(), 'taskId' => $taskId, 'text' => $c['text'],
                    'dateCreated' => $this->parseDateTime($c['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                    'authorId' => $memberByOldId[$c['authorId'] ?? ''] ?? null,
                    'authorName' => $c['authorName'] ?? '',
                ]);
            }
        }
    }

    private function createDocuments(array $documents, string $projectId, array $memberByOldId, array $taskByOldId): array
    {
        $byOldId = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Documents" ("Id", "ProjectId", "Key", "Title", "Url", "Description", "OwnerId", "TaskId", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :url, :description, :ownerId, :taskId, :created, :modified)
        SQL);
        foreach ($documents as $d) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $d['key'], 'title' => $d['title'], 'url' => $d['url'] ?? null, 'description' => $d['description'] ?? null,
                'ownerId' => $memberByOldId[$d['ownerId'] ?? ''] ?? null, 'taskId' => $taskByOldId[$d['taskId'] ?? ''] ?? null,
                'created' => $this->parseDateTime($d['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($d['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$d['id']] = $id;
        }
        return $byOldId;
    }

    private function wireDocumentRelations(array $documents, array $documentByOldId): void
    {
        $stmt = $this->db->prepare('INSERT INTO "DocumentRelation" ("DocumentId", "RelatedDocumentId") VALUES (:did, :rid)');
        foreach ($documents as $d) {
            if (!isset($documentByOldId[$d['id']])) {
                continue;
            }
            $docId = $documentByOldId[$d['id']];
            foreach ($d['relatedDocumentIds'] ?? [] as $relatedOldId) {
                if (isset($documentByOldId[$relatedOldId]) && $documentByOldId[$relatedOldId] !== $docId) {
                    $stmt->execute(['did' => $docId, 'rid' => $documentByOldId[$relatedOldId]]);
                }
            }
        }
    }

    private function createRisks(array $risks, string $projectId, array $memberByOldId, array $taskByOldId): array
    {
        $byOldId = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Risks" ("Id", "ProjectId", "Key", "Title", "Description", "Likelihood", "Impact", "Mitigations",
                "OwnerId", "TaskId", "Status", "DateToClose", "DateClosed", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :likelihood, :impact, :mitigations,
                :ownerId, :taskId, :status, :dateToClose, :dateClosed, :created, :modified)
        SQL);
        foreach ($risks as $r) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $r['key'], 'title' => $r['title'], 'description' => $r['description'] ?? null,
                'likelihood' => max(1, min(5, (int) $r['likelihood'])), 'impact' => max(1, min(5, (int) $r['impact'])), 'mitigations' => $r['mitigations'] ?? null,
                'ownerId' => $memberByOldId[$r['ownerId'] ?? ''] ?? null, 'taskId' => $taskByOldId[$r['taskId'] ?? ''] ?? null,
                'status' => in_array($r['status'] ?? null, ['new', 'in_review', 'closed'], true) ? $r['status'] : 'new',
                'dateToClose' => $this->parseDateOnly($r['dateToClose'] ?? null), 'dateClosed' => $this->parseDateOnly($r['dateClosed'] ?? null),
                'created' => $this->parseDateTime($r['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($r['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$r['id']] = $id;
        }
        return $byOldId;
    }

    private function wireRiskRelations(array $risks, array $riskByOldId, array $documentByOldId, array $principleByOldId, array $objectiveByOldId): void
    {
        $docStmt = $this->db->prepare('INSERT INTO "RiskDocument" ("RiskId", "DocumentId") VALUES (:rid, :did)');
        $prinStmt = $this->db->prepare('INSERT INTO "RiskPrinciple" ("RiskId", "PrincipleId") VALUES (:rid, :pid)');
        $objStmt = $this->db->prepare('INSERT INTO "RiskObjective" ("RiskId", "ObjectiveId") VALUES (:rid, :oid)');
        foreach ($risks as $r) {
            if (!isset($riskByOldId[$r['id']])) {
                continue;
            }
            $riskId = $riskByOldId[$r['id']];
            foreach ($r['documentIds'] ?? [] as $docId) {
                if (isset($documentByOldId[$docId])) {
                    $docStmt->execute(['rid' => $riskId, 'did' => $documentByOldId[$docId]]);
                }
            }
            foreach ($r['principleIds'] ?? [] as $prinId) {
                if (isset($principleByOldId[$prinId])) {
                    $prinStmt->execute(['rid' => $riskId, 'pid' => $principleByOldId[$prinId]]);
                }
            }
            foreach ($r['objectiveIds'] ?? [] as $objId) {
                if (isset($objectiveByOldId[$objId])) {
                    $objStmt->execute(['rid' => $riskId, 'oid' => $objectiveByOldId[$objId]]);
                }
            }
        }
    }

    private function createObjectives(array $objectives, string $projectId): array
    {
        $byOldId = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Objectives" ("Id", "ProjectId", "Key", "Title", "Description", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :created, :modified)
        SQL);
        foreach ($objectives as $o) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $o['key'], 'title' => $o['title'], 'description' => $o['description'] ?? null,
                'created' => $this->parseDateTime($o['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($o['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$o['id']] = $id;
        }
        return $byOldId;
    }

    private function wireObjectiveRelations(array $objectives, array $objectiveByOldId, array $principleByOldId): void
    {
        $stmt = $this->db->prepare('INSERT INTO "ObjectivePrinciple" ("ObjectiveId", "PrincipleId") VALUES (:oid, :pid)');
        foreach ($objectives as $o) {
            if (!isset($objectiveByOldId[$o['id']])) {
                continue;
            }
            foreach ($o['principleIds'] ?? [] as $prinId) {
                if (isset($principleByOldId[$prinId])) {
                    $stmt->execute(['oid' => $objectiveByOldId[$o['id']], 'pid' => $principleByOldId[$prinId]]);
                }
            }
        }
    }

    private function createTeamsCommittees(array $teamsCommittees, string $projectId): array
    {
        $byOldId = [];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "TeamsCommittees" ("Id", "ProjectId", "Key", "Name", "Description", "Type", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :name, :description, :type, :created, :modified)
        SQL);
        foreach ($teamsCommittees as $tc) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $tc['key'], 'name' => $tc['name'], 'description' => $tc['description'] ?? null,
                'type' => in_array($tc['type'] ?? null, ['team', 'committee'], true) ? $tc['type'] : 'team',
                'created' => $this->parseDateTime($tc['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($tc['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$tc['id']] = $id;
        }
        return $byOldId;
    }

    private function wireTeamCommitteeRelations(array $teamsCommittees, array $teamCommitteeByOldId, array $memberByOldId): void
    {
        $parentStmt = $this->db->prepare('UPDATE "TeamsCommittees" SET "ParentId" = :parentId WHERE "Id" = :id');
        $memberStmt = $this->db->prepare('INSERT INTO "TeamCommitteeMember" ("TeamCommitteeId", "ProjectMemberId") VALUES (:tid, :mid)');
        foreach ($teamsCommittees as $tc) {
            if (!isset($teamCommitteeByOldId[$tc['id']])) {
                continue;
            }
            $id = $teamCommitteeByOldId[$tc['id']];
            if (($tc['parentId'] ?? null) !== null && isset($teamCommitteeByOldId[$tc['parentId']])) {
                $parentStmt->execute(['parentId' => $teamCommitteeByOldId[$tc['parentId']], 'id' => $id]);
            }
            foreach ($tc['memberIds'] ?? [] as $memId) {
                if (isset($memberByOldId[$memId])) {
                    $memberStmt->execute(['tid' => $id, 'mid' => $memberByOldId[$memId]]);
                }
            }
        }
    }

    private function createDecisions(array $decisions, string $projectId, array $memberByOldId, array $taskByOldId): array
    {
        $byOldId = [];
        $validTypes = ['strategy', 'policy', 'budgetary', 'financial', 'functional', 'technical', 'process', 'operational'];
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Decisions" ("Id", "ProjectId", "Key", "Title", "Description", "Type", "Status", "Outcome",
                "OwnerId", "Approver", "TaskId", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :type, :status, :outcome, :ownerId, :approver, :taskId, :created, :modified)
        SQL);
        foreach ($decisions as $d) {
            $id = Uuid::v4();
            $stmt->execute([
                'id' => $id, 'pid' => $projectId, 'key' => $d['key'], 'title' => $d['title'], 'description' => $d['description'] ?? null,
                'type' => in_array($d['type'] ?? null, $validTypes, true) ? $d['type'] : 'operational',
                'status' => in_array($d['status'] ?? null, ['open', 'in_review', 'completed'], true) ? $d['status'] : 'open',
                'outcome' => $d['outcome'] ?? null, 'ownerId' => $memberByOldId[$d['ownerId'] ?? ''] ?? null,
                'approver' => $d['approver'] ?? null, 'taskId' => $taskByOldId[$d['taskId'] ?? ''] ?? null,
                'created' => $this->parseDateTime($d['dateCreated'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
                'modified' => $this->parseDateTime($d['dateLastModified'] ?? null) ?? gmdate('Y-m-d\TH:i:s\Z'),
            ]);
            $byOldId[$d['id']] = $id;
        }
        return $byOldId;
    }

    private function wireDecisionRelations(array $decisions, array $decisionByOldId, array $documentByOldId, array $riskByOldId, array $principleByOldId, array $objectiveByOldId): void
    {
        $docStmt = $this->db->prepare('INSERT INTO "DecisionDocument" ("DecisionId", "DocumentId") VALUES (:did2, :did)');
        $riskStmt = $this->db->prepare('INSERT INTO "DecisionRisk" ("DecisionId", "RiskId") VALUES (:did, :rid)');
        $prinStmt = $this->db->prepare('INSERT INTO "DecisionPrinciple" ("DecisionId", "PrincipleId") VALUES (:did, :pid)');
        $objStmt = $this->db->prepare('INSERT INTO "DecisionObjective" ("DecisionId", "ObjectiveId") VALUES (:did, :oid)');
        foreach ($decisions as $d) {
            if (!isset($decisionByOldId[$d['id']])) {
                continue;
            }
            $decisionId = $decisionByOldId[$d['id']];
            foreach ($d['documentIds'] ?? [] as $docId) {
                if (isset($documentByOldId[$docId])) {
                    $docStmt->execute(['did2' => $decisionId, 'did' => $documentByOldId[$docId]]);
                }
            }
            foreach ($d['riskIds'] ?? [] as $riskId) {
                if (isset($riskByOldId[$riskId])) {
                    $riskStmt->execute(['did' => $decisionId, 'rid' => $riskByOldId[$riskId]]);
                }
            }
            foreach ($d['principleIds'] ?? [] as $prinId) {
                if (isset($principleByOldId[$prinId])) {
                    $prinStmt->execute(['did' => $decisionId, 'pid' => $principleByOldId[$prinId]]);
                }
            }
            foreach ($d['objectiveIds'] ?? [] as $objId) {
                if (isset($objectiveByOldId[$objId])) {
                    $objStmt->execute(['did' => $decisionId, 'oid' => $objectiveByOldId[$objId]]);
                }
            }
        }
    }

    private function validateNoCycles(array $flatTasks, array $taskByKey, array $teamsCommittees, array $teamCommitteeByOldId): void
    {
        $adjacency = [];
        foreach ($flatTasks as $t) {
            if (!isset($taskByKey[$t['key']])) {
                continue;
            }
            $deps = [];
            foreach ($t['dependsOn'] ?? [] as $depKey) {
                if (isset($taskByKey[$depKey])) {
                    $deps[] = $taskByKey[$depKey];
                }
            }
            $adjacency[$taskByKey[$t['key']]] = $deps;
        }
        if (CycleDetection::hasCycle($adjacency)) {
            throw new ApiValidationException('The imported task dependency graph contains a cycle.');
        }

        $taskParentById = [];
        foreach ($flatTasks as $t) {
            if (!isset($taskByKey[$t['key']])) {
                continue;
            }
            $taskParentById[$taskByKey[$t['key']]] = ($t['parentKey'] ?? null) !== null && isset($taskByKey[$t['parentKey']]) ? $taskByKey[$t['parentKey']] : null;
        }
        if (CycleDetection::hasParentCycle($taskParentById)) {
            throw new ApiValidationException('The imported sub-task hierarchy contains a cycle.');
        }

        $committeeParentById = [];
        foreach ($teamsCommittees as $tc) {
            if (!isset($teamCommitteeByOldId[$tc['id']])) {
                continue;
            }
            $committeeParentById[$teamCommitteeByOldId[$tc['id']]] = ($tc['parentId'] ?? null) !== null && isset($teamCommitteeByOldId[$tc['parentId']]) ? $teamCommitteeByOldId[$tc['parentId']] : null;
        }
        if (CycleDetection::hasParentCycle($committeeParentById)) {
            throw new ApiValidationException('The imported Teams & Committees hierarchy contains a cycle.');
        }
    }

    private function resolveUniqueProjectKey(string $baseKey, string $organisationId): string
    {
        $candidate = $baseKey;
        $suffix = 1;
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Key" = :key AND "OrganisationId" = :orgId');
        while (true) {
            $stmt->execute(['key' => $candidate, 'orgId' => $organisationId]);
            if ($stmt->fetch() === false) {
                return $candidate;
            }
            $suffix++;
            $candidate = $baseKey . $suffix;
        }
    }

    private function resolveUniqueUsername(string $baseUsername): string
    {
        $candidate = $baseUsername;
        $suffix = 1;
        $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "NormalizedUsername" = :n');
        while (true) {
            $stmt->execute(['n' => $candidate]);
            if ($stmt->fetch() === false) {
                return $candidate;
            }
            $suffix++;
            $candidate = $baseUsername . $suffix;
        }
    }

    private function parseDateTime(?string $value): ?string
    {
        if ($value === null || trim($value) === '' || strtotime($value) === false) {
            return null;
        }
        return $value;
    }

    private function parseDateOnly(?string $value): ?string
    {
        $parsed = $this->parseDateTime($value);
        return $parsed === null ? null : date('Y-m-d', strtotime($parsed));
    }
}
