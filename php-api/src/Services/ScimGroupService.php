<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from Services/ScimGroupService.cs. Maps SCIM's Groups resource onto OrgTeam/OrgTeamMember
 * — the Organisation-scoped grouping introduced specifically as the SCIM sync target, distinct
 * from the Project-scoped TeamsCommittees used by the org-chart feature (see the OrgTeams table's
 * own migration comment, 005_add_sso_and_scim_support.sql). This service never touches
 * TeamsCommittees at all; TeamCommitteeService::applyOrgTeam() is the one-way, manual bridge
 * between the two.
 */
final class ScimGroupService
{
    public function __construct(private readonly PDO $db)
    {
    }

    /** @return array{schemas: string[], totalResults: int, startIndex: int, itemsPerPage: int, resources: array[]} */
    public function list(string $orgId, ?string $filter, int $startIndex, int $count): array
    {
        $whereSql = '"OrganisationId" = :orgId';
        $filterParam = null;

        if ($filter !== null && trim($filter) !== '') {
            [$attr, $value] = ScimFilterParser::parseEq($filter);
            if ($attr === 'displayname' && $value !== null) {
                $whereSql .= ' AND "Name" = :filterValue';
                $filterParam = $value;
            } else {
                $whereSql .= ' AND 1 = 0';
            }
        }

        $countStmt = $this->db->prepare('SELECT COUNT(*) FROM "OrgTeams" WHERE ' . $whereSql);
        $countStmt->bindValue('orgId', $orgId);
        if ($filterParam !== null) {
            $countStmt->bindValue('filterValue', $filterParam);
        }
        $countStmt->execute();
        $total = (int) $countStmt->fetchColumn();

        $startIndex = max(1, $startIndex);
        $count = max(1, min(200, $count));
        $stmt = $this->db->prepare(
            'SELECT "Id" FROM "OrgTeams" WHERE ' . $whereSql . ' ORDER BY "Name" OFFSET :offset LIMIT :limit'
        );
        $stmt->bindValue('orgId', $orgId);
        if ($filterParam !== null) {
            $stmt->bindValue('filterValue', $filterParam);
        }
        $stmt->bindValue('offset', $startIndex - 1, PDO::PARAM_INT);
        $stmt->bindValue('limit', $count, PDO::PARAM_INT);
        $stmt->execute();
        $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $resources = array_map(fn(string $id): array => $this->toResponse($id), $ids);

        return [
            'schemas' => [ScimSchemas::LIST_RESPONSE],
            'totalResults' => $total,
            'startIndex' => $startIndex,
            'itemsPerPage' => count($resources),
            'resources' => $resources,
        ];
    }

    public function get(string $orgId, string $groupId): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrgTeams" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $groupId, 'orgId' => $orgId]);
        return $stmt->fetch() === false ? null : $this->toResponse($groupId);
    }

    /** @param array<string,mixed> $request */
    public function create(string $orgId, array $request): array
    {
        $teamId = Uuid::v4();
        $name = self::normalizeName($request['displayName'] ?? null);
        $externalId = trim((string) ($request['externalId'] ?? ''));

        $this->db->prepare(<<<SQL
            INSERT INTO "OrgTeams" ("Id", "OrganisationId", "Name", "ScimExternalId", "DateCreated", "DateLastModified")
            VALUES (:id, :orgId, :name, :externalId, now(), now())
        SQL)->execute([
            'id' => $teamId, 'orgId' => $orgId, 'name' => $name,
            'externalId' => $externalId !== '' ? $externalId : null,
        ]);

        $this->addMembers($orgId, $teamId, self::extractMemberIds($request['members'] ?? null));
        return $this->toResponse($teamId);
    }

    /** PUT replaces the whole membership list, per SCIM full-resource-replace semantics — unlike
     * PATCH's add/remove operations below, which touch only the members named.
     * @param array<string,mixed> $request */
    public function replace(string $orgId, string $groupId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrgTeams" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $groupId, 'orgId' => $orgId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $name = self::normalizeName($request['displayName'] ?? null);
        $this->db->prepare('UPDATE "OrgTeams" SET "Name" = :name, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['name' => $name, 'id' => $groupId]);

        $this->db->prepare('DELETE FROM "OrgTeamMember" WHERE "OrgTeamId" = :id')->execute(['id' => $groupId]);
        $this->addMembers($orgId, $groupId, self::extractMemberIds($request['members'] ?? null));

        return $this->toResponse($groupId);
    }

    /**
     * Recognizes the operations IdPs actually send for group membership changes: "add"/path
     * "members" (append one or more), "remove"/path "members[value eq \"<userId>\"]" (drop one
     * specific member — the common single-unassign case), and "replace" on displayName (rename, in
     * both the Okta path-scoped and Azure-AD whole-object-value forms — see ScimUserService::patch
     * for the same two shapes on Users). A bare "remove" on "members" with no targeted value clears
     * the whole list. Anything else is a no-op rather than an error, same scope-limit reasoning as
     * ScimUserService::applyFieldChange.
     * @param array<string,mixed> $request
     */
    public function patch(string $orgId, string $groupId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrgTeams" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $groupId, 'orgId' => $orgId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $operations = $request['Operations'] ?? $request['operations'] ?? [];
        foreach ($operations as $op) {
            if (!is_array($op)) {
                continue;
            }
            $opName = strtolower((string) ($op['op'] ?? ''));
            $path = (string) ($op['path'] ?? '');
            $pathKey = strtolower(trim(explode('[', $path)[0]));
            $hasValue = array_key_exists('value', $op) && $op['value'] !== null;
            $value = $hasValue ? $op['value'] : null;

            if ($hasValue && $opName === 'replace' && $path === '' && is_array($value) && !array_is_list($value)) {
                if (isset($value['displayName']) && is_string($value['displayName'])) {
                    $this->db->prepare('UPDATE "OrgTeams" SET "Name" = :name WHERE "Id" = :id')
                        ->execute(['name' => self::normalizeName($value['displayName']), 'id' => $groupId]);
                }
                continue;
            }
            if ($hasValue && $opName === 'replace' && $pathKey === 'displayname' && is_string($value)) {
                $this->db->prepare('UPDATE "OrgTeams" SET "Name" = :name WHERE "Id" = :id')
                    ->execute(['name' => self::normalizeName($value), 'id' => $groupId]);
                continue;
            }
            if ($hasValue && $opName === 'add' && $pathKey === 'members') {
                $this->addMembers($orgId, $groupId, self::extractMemberIds($value));
                continue;
            }
            if ($opName === 'remove' && $pathKey === 'members') {
                $targeted = self::extractMemberIdFromPathFilter($path)
                    ?? ($hasValue ? (self::extractMemberIds($value)[0] ?? null) : null);
                if ($targeted !== null) {
                    $this->db->prepare('DELETE FROM "OrgTeamMember" WHERE "OrgTeamId" = :id AND "UserId" = :userId')
                        ->execute(['id' => $groupId, 'userId' => $targeted]);
                } else {
                    $this->db->prepare('DELETE FROM "OrgTeamMember" WHERE "OrgTeamId" = :id')->execute(['id' => $groupId]);
                }
            }
        }

        $this->db->prepare('UPDATE "OrgTeams" SET "DateLastModified" = now() WHERE "Id" = :id')->execute(['id' => $groupId]);
        return $this->toResponse($groupId);
    }

    public function delete(string $orgId, string $groupId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrgTeams" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $groupId, 'orgId' => $orgId]);
        if ($stmt->fetch() === false) {
            return false;
        }
        // Cascades OrgTeamMember; any TeamsCommittees.SourceOrgTeamId pointing here SetNulls (see
        // 006_add_source_org_team_to_team_committee.sql) rather than touching the TeamCommittee
        // itself — deleting the source group must never reach into a project's org chart.
        $this->db->prepare('DELETE FROM "OrgTeams" WHERE "Id" = :id')->execute(['id' => $groupId]);
        return true;
    }

    private function addMembers(string $orgId, string $teamId, array $userIds): void
    {
        foreach ($userIds as $userId) {
            $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "Id" = :id AND "OrganisationId" = :orgId');
            $stmt->execute(['id' => $userId, 'orgId' => $orgId]);
            if ($stmt->fetch() === false) {
                continue;
            }
            $stmt = $this->db->prepare('SELECT 1 FROM "OrgTeamMember" WHERE "OrgTeamId" = :teamId AND "UserId" = :userId');
            $stmt->execute(['teamId' => $teamId, 'userId' => $userId]);
            if ($stmt->fetch() !== false) {
                continue;
            }
            $this->db->prepare('INSERT INTO "OrgTeamMember" ("OrgTeamId", "UserId") VALUES (:teamId, :userId)')
                ->execute(['teamId' => $teamId, 'userId' => $userId]);
        }
    }

    /** @return string[] */
    private static function extractMemberIds(mixed $members): array
    {
        if (!is_array($members)) {
            return [];
        }
        $ids = [];
        foreach ($members as $m) {
            if (is_array($m) && !empty($m['value'])) {
                $ids[] = (string) $m['value'];
            } elseif (is_string($m) && $m !== '') {
                $ids[] = $m;
            }
        }
        return $ids;
    }

    private static function extractMemberIdFromPathFilter(string $path): ?string
    {
        if (preg_match('/value\s+eq\s+"([0-9a-fA-F-]{36})"/i', $path, $m) === 1) {
            return $m[1];
        }
        return null;
    }

    private static function normalizeName(mixed $name): string
    {
        $trimmed = is_string($name) ? trim($name) : '';
        $trimmed = $trimmed === '' ? 'Unnamed Team' : $trimmed;
        return strlen($trimmed) > 200 ? substr($trimmed, 0, 200) : $trimmed;
    }

    private function toResponse(string $teamId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "OrgTeams" WHERE "Id" = :id');
        $stmt->execute(['id' => $teamId]);
        $team = $stmt->fetch();

        $stmt = $this->db->prepare(<<<SQL
            SELECT m."UserId", u."DisplayName" FROM "OrgTeamMember" m
            JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."OrgTeamId" = :id
        SQL);
        $stmt->execute(['id' => $teamId]);
        $members = array_map(
            static fn(array $m): array => ['value' => $m['UserId'], 'display' => $m['DisplayName']],
            $stmt->fetchAll()
        );

        return [
            'schemas' => [ScimSchemas::GROUP],
            'id' => $team['Id'],
            'externalId' => $team['ScimExternalId'],
            'displayName' => $team['Name'],
            'members' => $members,
            'meta' => [
                'resourceType' => 'Group',
                'created' => self::toIso($team['DateCreated']),
                'lastModified' => self::toIso($team['DateLastModified']),
                'location' => '/Groups/' . $team['Id'],
            ],
        ];
    }

    private static function toIso(string $timestamp): string
    {
        return (new \DateTimeImmutable($timestamp))->format('Y-m-d\TH:i:s.v\Z');
    }
}
