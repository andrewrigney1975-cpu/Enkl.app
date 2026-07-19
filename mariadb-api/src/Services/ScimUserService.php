<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\EmailAddressNormalizer;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from Services/ScimUserService.cs. Maps SCIM's Users resource onto the app's existing
 * "Users" table — the same table OrganisationService's explicit create and SamlService's JIT
 * provisioning already write to, so a user created here shows up in Manage Users and can sign in
 * via SAML exactly like any other account. Deliberately does not touch ProjectMembers/
 * OrgTeamMember: SCIM's Users resource only owns the account itself, not project membership or Org
 * Team membership (that's Groups — ScimGroupService).
 */
final class ScimUserService
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
            if ($attr === 'username' && $value !== null) {
                $whereSql .= ' AND "NormalizedUsername" = :filterValue';
                $filterParam = UsernameNormalizer::normalize($value);
            } elseif (($attr === 'emails.value' || $attr === 'emails') && $value !== null) {
                $whereSql .= ' AND "NormalizedEmailAddress" = :filterValue';
                $filterParam = EmailAddressNormalizer::normalize($value);
            } else {
                // Unsupported filter attribute/syntax: SCIM clients should get a clean "no matches"
                // rather than every user in the org (silently ignoring the filter) or a hard 400 for
                // every filter shape they might try — this only recognizes userName/emails.value eq.
                $whereSql .= ' AND 1 = 0';
            }
        }

        $countStmt = $this->db->prepare('SELECT COUNT(*) FROM "Users" WHERE ' . $whereSql);
        $countStmt->bindValue('orgId', $orgId);
        if ($filterParam !== null) {
            $countStmt->bindValue('filterValue', $filterParam);
        }
        $countStmt->execute();
        $total = (int) $countStmt->fetchColumn();

        $startIndex = max(1, $startIndex);
        $count = max(1, min(200, $count));
        $stmt = $this->db->prepare(
            'SELECT * FROM "Users" WHERE ' . $whereSql . ' ORDER BY "Username" OFFSET :offset LIMIT :limit'
        );
        $stmt->bindValue('orgId', $orgId);
        if ($filterParam !== null) {
            $stmt->bindValue('filterValue', $filterParam);
        }
        $stmt->bindValue('offset', $startIndex - 1, PDO::PARAM_INT);
        $stmt->bindValue('limit', $count, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();

        return [
            'schemas' => [ScimSchemas::LIST_RESPONSE],
            'totalResults' => $total,
            'startIndex' => $startIndex,
            'itemsPerPage' => count($rows),
            'resources' => array_map(fn(array $r): array => $this->toResponse($r), $rows),
        ];
    }

    public function get(string $orgId, string $userId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $userId, 'orgId' => $orgId]);
        $user = $stmt->fetch();
        return $user === false ? null : $this->toResponse($user);
    }

    /** @param array<string,mixed> $request */
    public function create(string $orgId, array $request): array
    {
        $email = self::extractEmail($request);
        [$validEmail, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $email, true, null);

        $displayName = self::extractDisplayName($request, (string) $validEmail);
        $baseUsername = UsernameNormalizer::normalize($displayName);
        if ($baseUsername === '') {
            $baseUsername = 'user';
        }
        $usernameToUse = $this->resolveUniqueUsername($baseUsername);

        $userId = Uuid::v4();
        $active = array_key_exists('active', $request) && $request['active'] !== null ? (bool) $request['active'] : true;
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt")
            VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, NULL, :displayName, false, false, :active, now())
        SQL);
        $stmt->execute([
            'id' => $userId, 'orgId' => $orgId, 'username' => $usernameToUse, 'normalized' => $usernameToUse,
            'email' => $validEmail, 'normalizedEmail' => $normalizedEmail, 'displayName' => $displayName,
            'active' => (int) $active,
        ]);

        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $userId]);
        return $this->toResponse($stmt->fetch());
    }

    /** PUT semantics are intentionally partial: email/displayName/active get replaced from the
     * request, but the app's internal Username is never renamed by SCIM once created — see
     * applyFieldChange()'s "username" case for the same reasoning applied to PATCH.
     * @param array<string,mixed> $request */
    public function replace(string $orgId, string $userId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $userId, 'orgId' => $orgId]);
        $user = $stmt->fetch();
        if ($user === false) {
            return null;
        }

        $email = self::extractEmail($request);
        $emailToSave = $user['EmailAddress'];
        $normalizedEmail = $user['NormalizedEmailAddress'];
        if ($email !== null && trim($email) !== '' && strcasecmp($email, (string) $user['EmailAddress']) !== 0) {
            [$emailToSave, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $email, true, $userId);
        }
        $displayName = self::extractDisplayName($request, (string) ($emailToSave ?? $user['Username']));
        $wasActive = (bool) $user['IsActive'];
        $active = array_key_exists('active', $request) && $request['active'] !== null ? (bool) $request['active'] : $wasActive;

        // Security review finding H2: an already-issued token is otherwise still fully valid for up
        // to 8 hours after this exact deprovisioning event — only rotate when the value actually
        // changes, not on every no-op PUT that just re-sends the same active:true/false.
        $securityStampSql = $active !== $wasActive ? ', "SecurityStamp" = gen_random_uuid()' : '';
        $this->db->prepare(
            'UPDATE "Users" SET "EmailAddress" = :email, "NormalizedEmailAddress" = :normalizedEmail, "DisplayName" = :displayName, "IsActive" = :active' . $securityStampSql . ' WHERE "Id" = :id'
        )->execute([
            'email' => $emailToSave, 'normalizedEmail' => $normalizedEmail, 'displayName' => $displayName,
            'active' => (int) $active, 'id' => $userId,
        ]);

        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $userId]);
        return $this->toResponse($stmt->fetch());
    }

    /** @param array<string,mixed> $request */
    public function patch(string $orgId, string $userId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $userId, 'orgId' => $orgId]);
        $user = $stmt->fetch();
        if ($user === false) {
            return null;
        }

        // "Operations" (capital O) is the SCIM spec's own casing (RFC 7644's PatchOp JSON examples
        // use it inconsistently with the rest of the spec's camelCase) — real IdPs send either, so
        // both are accepted here the same way ASP.NET Core's case-insensitive JSON binding already
        // makes the .NET side tolerant of both without any special-casing there.
        $wasActive = (bool) $user['IsActive'];
        $operations = $request['Operations'] ?? $request['operations'] ?? [];
        foreach ($operations as $op) {
            if (!is_array($op)) {
                continue;
            }
            $opName = strtolower((string) ($op['op'] ?? ''));
            if ($opName !== 'replace' && $opName !== 'add') {
                continue;
            }
            $value = $op['value'] ?? null;
            if ($value === null) {
                continue;
            }
            $path = $op['path'] ?? null;

            // Two shapes seen in practice: Azure AD sends {"op":"Replace","value":{"active":false}}
            // (no path, one or more attributes under value); Okta sends
            // {"op":"replace","path":"active","value":false} (a single scalar at a specific path).
            if (($path === null || $path === '') && is_array($value) && !array_is_list($value)) {
                foreach ($value as $fieldName => $fieldValue) {
                    $user = $this->applyFieldChange($user, (string) $fieldName, $fieldValue);
                }
            } elseif ($path !== null && $path !== '') {
                $user = $this->applyFieldChange($user, (string) $path, $value);
            }
        }

        // Security review finding H2: an already-issued token is otherwise still fully valid for up
        // to 8 hours after this exact deprovisioning event (PATCH active:false is the real-world
        // IdP deprovisioning path — see delete()'s own note) — only rotate when the value actually
        // changed, not on every no-op PATCH that just re-sends the same active:true/false.
        $isActiveNow = (bool) $user['IsActive'];
        $securityStampSql = $isActiveNow !== $wasActive ? ', "SecurityStamp" = gen_random_uuid()' : '';
        $this->db->prepare(
            'UPDATE "Users" SET "EmailAddress" = :email, "NormalizedEmailAddress" = :normalizedEmail, "DisplayName" = :displayName, "IsActive" = :active' . $securityStampSql . ' WHERE "Id" = :id'
        )->execute([
            'email' => $user['EmailAddress'], 'normalizedEmail' => $user['NormalizedEmailAddress'],
            'displayName' => $user['DisplayName'], 'active' => (int) $isActiveNow, 'id' => $userId,
        ]);

        return $this->toResponse($user);
    }

    /**
     * ProjectMembers.UserId is a Restrict FK on purpose (see ProjectMemberConfiguration.cs /
     * 001_initial_schema.sql) — a directory deprovisioning event should never silently cascade away
     * someone's task assignments and project history. Rejecting with 'has_project_memberships'
     * (surfaced as a 409 by the controller) is the correct behavior here; PATCH active:false is the
     * expected real-world deprovisioning path and always works regardless of project memberships.
     * @return 'deleted'|'not_found'|'has_project_memberships'
     */
    public function delete(string $orgId, string $userId): string
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $userId, 'orgId' => $orgId]);
        if ($stmt->fetch() === false) {
            return 'not_found';
        }

        $stmt = $this->db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "UserId" = :id');
        $stmt->execute(['id' => $userId]);
        if ($stmt->fetch() !== false) {
            return 'has_project_memberships';
        }

        $this->db->prepare('DELETE FROM "Users" WHERE "Id" = :id')->execute(['id' => $userId]);
        return 'deleted';
    }

    /** @param array<string,mixed> $user
     * @return array<string,mixed> */
    private function applyFieldChange(array $user, string $path, mixed $value): array
    {
        // Strips a SCIM array-filter suffix like emails[type eq "work"].value down to "emails" —
        // "name.formatted" has no brackets and passes through unchanged.
        $key = strtolower(trim(explode('[', $path)[0]));
        switch ($key) {
            case 'active':
                if (is_bool($value)) {
                    $user['IsActive'] = $value;
                } elseif (is_string($value) && in_array(strtolower($value), ['true', 'false'], true)) {
                    $user['IsActive'] = strtolower($value) === 'true';
                }
                break;
            case 'displayname':
            case 'name.formatted':
                if (is_string($value) && $value !== '') {
                    $user['DisplayName'] = strlen($value) > 200 ? substr($value, 0, 200) : $value;
                }
                break;
            case 'username':
                // Deliberately unsupported — the app's internal Username is derived once at
                // creation and used for login/dedup elsewhere (e.g. MemberService's project-member
                // matching); renaming it out from under those paths is a bigger change than this
                // integration takes on. displayName/emails are the identifying fields SCIM can change.
                break;
            case 'emails':
                $newEmail = self::extractEmailFromValue($value);
                if ($newEmail !== null && trim($newEmail) !== '' && strcasecmp($newEmail, (string) $user['EmailAddress']) !== 0) {
                    [$validEmail, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $newEmail, false, $user['Id']);
                    if ($validEmail !== null) {
                        $user['EmailAddress'] = $validEmail;
                        $user['NormalizedEmailAddress'] = $normalizedEmail;
                    }
                }
                break;
        }
        return $user;
    }

    private static function extractEmailFromValue(mixed $value): ?string
    {
        if (is_string($value)) {
            return $value;
        }
        if (is_array($value)) {
            foreach ($value as $item) {
                if (is_array($item) && isset($item['value']) && is_string($item['value'])) {
                    return $item['value'];
                }
            }
        }
        return null;
    }

    /** @param array<string,mixed> $request */
    private static function extractEmail(array $request): ?string
    {
        $emails = $request['emails'] ?? null;
        if (is_array($emails)) {
            foreach ($emails as $e) {
                if (is_array($e) && ($e['primary'] ?? false) === true && !empty($e['value'])) {
                    return (string) $e['value'];
                }
            }
            foreach ($emails as $e) {
                if (is_array($e) && !empty($e['value'])) {
                    return (string) $e['value'];
                }
            }
        }
        // Many IdPs' SCIM implementations set userName to the email itself — accept that as a
        // fallback identifier when no explicit emails entry was sent.
        $userName = (string) ($request['userName'] ?? '');
        if ($userName !== '' && str_contains($userName, '@')) {
            return $userName;
        }
        return null;
    }

    /** @param array<string,mixed> $request */
    private static function extractDisplayName(array $request, string $emailFallback): string
    {
        $name = trim((string) ($request['displayName'] ?? ''));
        if ($name === '') {
            $name = trim((string) ($request['name']['formatted'] ?? ''));
        }
        if ($name === '') {
            $given = trim((string) ($request['name']['givenName'] ?? ''));
            $family = trim((string) ($request['name']['familyName'] ?? ''));
            $name = trim($given . ' ' . $family);
        }
        if ($name === '') {
            $name = explode('@', $emailFallback)[0];
        }
        return strlen($name) > 200 ? substr($name, 0, 200) : $name;
    }

    private function resolveUniqueUsername(string $baseUsername): string
    {
        $candidate = $baseUsername;
        $suffix = 1;
        $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "NormalizedUsername" = :n');
        do {
            $stmt->execute(['n' => $candidate]);
            if ($stmt->fetch() === false) {
                break;
            }
            $suffix++;
            $candidate = $baseUsername . $suffix;
        } while (true);
        return $candidate;
    }

    // User has no DateLastModified column — created/lastModified both report CreatedAt, a known
    // simplification rather than adding a column no other read path in the app needs yet (matches
    // ScimUserService.cs's own ToResponse comment).
    /** @param array<string,mixed> $user */
    private function toResponse(array $user): array
    {
        return [
            'schemas' => [ScimSchemas::USER],
            'id' => $user['Id'],
            'userName' => $user['Username'],
            'name' => ['formatted' => $user['DisplayName'], 'givenName' => null, 'familyName' => null],
            'displayName' => $user['DisplayName'],
            'emails' => $user['EmailAddress'] === null
                ? []
                : [['value' => $user['EmailAddress'], 'primary' => true, 'type' => 'work']],
            'active' => (bool) $user['IsActive'],
            'meta' => [
                'resourceType' => 'User',
                'created' => self::toIso($user['CreatedAt']),
                'lastModified' => self::toIso($user['CreatedAt']),
                'location' => '/Users/' . $user['Id'],
            ],
        ];
    }

    private static function toIso(string $timestamp): string
    {
        return (new \DateTimeImmutable($timestamp))->format('Y-m-d\TH:i:s.v\Z');
    }
}
