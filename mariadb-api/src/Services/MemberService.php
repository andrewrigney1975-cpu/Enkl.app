<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Support\MemberPalette;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Team member CRUD for an already-migrated project. Unlike every other per-project entity, a
 * ProjectMember isn't a self-contained row — it's a join between the Project and a global User
 * account, so "add a member" here does the same find-or-create-User-by-name dedup MigrationService
 * does for a whole batch at once, just for one name at a time. Ported from Services/MemberService.cs.
 */
final class MemberService
{
    public function __construct(private readonly PDO $db)
    {
    }

    /**
     * Backs the "Add a team member" combobox — the project's whole Organisation roster (active
     * Users), not just its current ProjectMembers, so someone who's only a member of a sibling
     * project in the same org still shows up as a pickable candidate here. Ported from
     * Services/MemberService.cs's GetOrgCandidatesAsync.
     */
    public function getOrgCandidates(string $projectId): ?array
    {
        $stmt = $this->db->prepare('SELECT "OrganisationId" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $stmt = $this->db->prepare(
            'SELECT "Id", "DisplayName", "EmailAddress" FROM "Users" WHERE "OrganisationId" = :org AND "IsActive" = true ORDER BY "DisplayName"'
        );
        $stmt->execute(['org' => $project['OrganisationId']]);
        return array_map(
            fn(array $u) => ['id' => $u['Id'], 'displayName' => $u['DisplayName'], 'email' => $u['EmailAddress']],
            $stmt->fetchAll()
        );
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the User insert (new-user branch) and the ProjectMember
    // insert used to be two separately auto-committed statements — a failure on the second left a
    // real User account behind with no ProjectMember row at all, invisible on the project but still
    // occupying that username/email.
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
        $stmt = $this->db->prepare('SELECT "OrganisationId" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $trimmedName = trim((string) ($request['name'] ?? ''));
        if ($trimmedName === '') {
            throw new ApiValidationException('Please enter a name.');
        }
        if (strlen($trimmedName) > 60) {
            $trimmedName = substr($trimmedName, 0, 60);
        }

        $normalized = UsernameNormalizer::normalize($trimmedName);

        // Identity dedup is scoped to the Organisation, same rule migration uses — the same name in a
        // different org is a different real person and must never be silently merged.
        $stmt = $this->db->prepare('SELECT * FROM "Users" WHERE "NormalizedUsername" = :n AND "OrganisationId" = :org');
        $stmt->execute(['n' => $normalized, 'org' => $project['OrganisationId']]);
        $user = $stmt->fetch();

        if ($user === false) {
            $usernameToUse = $normalized;
            $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "NormalizedUsername" = :n');
            $stmt->execute(['n' => $normalized]);
            if ($stmt->fetch() !== false) {
                $usernameToUse = $this->resolveUniqueUsername($normalized);
            }

            // This is a real User account being created, same as OrganisationService::createUser —
            // an email is required here too, not just on the explicit OrgAdmin form.
            [$email, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $request['email'] ?? null, true, null);

            $userId = Uuid::v4();
            // MariaDB port: "SecurityStamp" has no DB-side default here (see
            // src/Db/migrations/001_initial_schema.sql's own note) — unlike php-api's original, which
            // relied on Postgres's `DEFAULT gen_random_uuid()`, this INSERT must supply one explicitly.
            $stmt = $this->db->prepare(<<<SQL
                INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt", "SecurityStamp")
                VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, :hash, :displayName, true, false, now(), :securityStamp)
            SQL);
            $stmt->execute([
                'id' => $userId, 'orgId' => $project['OrganisationId'], 'username' => $usernameToUse,
                'normalized' => $usernameToUse, 'email' => $email, 'normalizedEmail' => $normalizedEmail,
                'hash' => PasswordHasher::hash('enklUserPassword'), 'displayName' => $trimmedName,
                'securityStamp' => Uuid::v4(),
            ]);
            $user = ['Id' => $userId, 'DisplayName' => $trimmedName, 'EmailAddress' => $email];
        } else {
            $stmt = $this->db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
            $stmt->execute(['pid' => $projectId, 'uid' => $user['Id']]);
            if ($stmt->fetch() !== false) {
                throw new ApiValidationException("\"{$user['DisplayName']}\" is already a member of this project.");
            }

            // Self-heal a matched user's missing email if one was supplied — same backfill idea as
            // MigrationService's matched-existing-user case. Never blocks adding the member: an
            // invalid/duplicate email here is silently dropped rather than failing the whole request.
            if (($user['EmailAddress'] ?? null) === null && !empty($request['email'])) {
                try {
                    [$email, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $request['email'], false, $user['Id']);
                    $this->db->prepare('UPDATE "Users" SET "EmailAddress" = :email, "NormalizedEmailAddress" = :normalizedEmail WHERE "Id" = :id')
                        ->execute(['email' => $email, 'normalizedEmail' => $normalizedEmail, 'id' => $user['Id']]);
                    $user['EmailAddress'] = $email;
                } catch (ApiValidationException) {
                    // ignore — not the point of this request
                }
            }
        }

        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "ProjectMembers" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $memberCount = (int) $stmt->fetchColumn();
        $color = MemberPalette::colorForIndex($memberCount);

        $memberId = Uuid::v4();
        $this->db->prepare('INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color") VALUES (:id, :pid, :uid, :color)')
            ->execute(['id' => $memberId, 'pid' => $projectId, 'uid' => $user['Id'], 'color' => $color]);

        return ['id' => $memberId, 'userId' => $user['Id'], 'displayName' => $user['DisplayName'], 'email' => $user['EmailAddress'] ?? null, 'color' => $color, 'role' => null, 'allocatedFraction' => null, 'reportsToId' => null, 'isProjectAdmin' => false];
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: the conditional Users.DisplayName update and the
    // unconditional ProjectMembers update used to be two separately auto-committed statements — a
    // failure on the second left the User's display name changed with the ProjectMembers row (role/
    // allocation/reportsTo) never actually updated to match what the caller asked for.
    public function update(string $projectId, string $memberId, array $request): ?array
    {
        $this->db->beginTransaction();
        try {
            $result = $this->updateInTransaction($projectId, $memberId, $request);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function updateInTransaction(string $projectId, string $memberId, array $request): ?array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT m.*, u."DisplayName" AS "UserDisplayName", u."EmailAddress" AS "UserEmailAddress" FROM "ProjectMembers" m
            JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."Id" = :id AND m."ProjectId" = :pid
        SQL);
        $stmt->execute(['id' => $memberId, 'pid' => $projectId]);
        $member = $stmt->fetch();
        if ($member === false) {
            return null;
        }

        $trimmedName = trim((string) ($request['name'] ?? ''));
        $displayName = $member['UserDisplayName'];
        if ($trimmedName !== '') {
            $displayName = strlen($trimmedName) > 60 ? substr($trimmedName, 0, 60) : $trimmedName;
            $this->db->prepare('UPDATE "Users" SET "DisplayName" = :name WHERE "Id" = :id')
                ->execute(['name' => $displayName, 'id' => $member['UserId']]);
        }

        $trimmedRole = trim((string) ($request['role'] ?? ''));
        $role = $trimmedRole === '' ? null : (strlen($trimmedRole) > 100 ? substr($trimmedRole, 0, 100) : $trimmedRole);

        // Clamped the same way clampAllocatedFraction does client-side (date-utils.js) — null stays
        // null (never assigned an allocation), anything else is rounded and clamped to [0, 100].
        $allocatedFraction = $request['allocatedFraction'] ?? null;
        if ($allocatedFraction !== null) {
            $allocatedFraction = max(0, min(100, (int) round((float) $allocatedFraction)));
        }

        // Same lenient fallback-to-null as mutations.js's setMemberReportsTo — a self-reference or a
        // target that isn't (or is no longer) a member of this project quietly clears the field rather
        // than erroring, since the dropdown driving this should never offer an invalid option anyway.
        $reportsToId = $request['reportsToId'] ?? null;
        if ($reportsToId !== null && $reportsToId !== $memberId) {
            $stmt = $this->db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id AND "ProjectId" = :pid');
            $stmt->execute(['id' => $reportsToId, 'pid' => $projectId]);
            if ($stmt->fetch() === false) {
                $reportsToId = null;
            }
        } else {
            $reportsToId = null;
        }

        $this->db->prepare('UPDATE "ProjectMembers" SET "Role" = :role, "AllocatedFraction" = :allocatedFraction, "ReportsToId" = :reportsToId WHERE "Id" = :id')
            ->execute(['role' => $role, 'allocatedFraction' => $allocatedFraction, 'reportsToId' => $reportsToId, 'id' => $memberId]);

        return ['id' => $memberId, 'userId' => $member['UserId'], 'displayName' => $displayName, 'email' => $member['UserEmailAddress'], 'color' => $member['Color'], 'role' => $role, 'allocatedFraction' => $allocatedFraction, 'reportsToId' => $reportsToId, 'isProjectAdmin' => (bool) $member['IsProjectAdmin']];
    }

    // ARCHITECTURE-REVIEW.md finding 3.1: unlinking ReportsTo and deleting the member row used to be
    // two separately auto-committed statements — a failure on the DELETE left ReportsTo already
    // cleared for anyone who reported to this (still-existing) member, a confusing partial state.
    public function delete(string $projectId, string $memberId): bool
    {
        $this->db->beginTransaction();
        try {
            $result = $this->deleteInTransaction($projectId, $memberId);
            $this->db->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function deleteInTransaction(string $projectId, string $memberId): bool
    {
        $stmt = $this->db->prepare('SELECT "IsProjectAdmin" FROM "ProjectMembers" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $memberId, 'pid' => $projectId]);
        $member = $stmt->fetch();
        if ($member === false) {
            return false;
        }

        if ((bool) $member['IsProjectAdmin']) {
            $this->ensureNotLastProjectAdmin($projectId, $memberId);
        }

        // ReportsTo is a Restrict FK — anyone reporting to this member gets orphaned back to "no one"
        // first, same as mutations.js's removeMember. Every other reference (task Assignee, Document/
        // Release/Risk/Decision Owner, TeamCommitteeMember) is already SetNull/Cascade at the DB level.
        $this->db->prepare('UPDATE "ProjectMembers" SET "ReportsToId" = NULL WHERE "ProjectId" = :pid AND "ReportsToId" = :id')
            ->execute(['pid' => $projectId, 'id' => $memberId]);

        $this->db->prepare('DELETE FROM "ProjectMembers" WHERE "Id" = :id')->execute(['id' => $memberId]);
        return true;
    }

    /**
     * The Project Admin-assignment half of "manage team members" — promotes or demotes an existing
     * member. Guards against ever leaving a project with zero Project Admins (see
     * ensureNotLastProjectAdmin's own doc comment for why that's worth blocking outright rather than
     * just discouraging in the UI). Ported from Services/MemberService.cs's SetProjectAdminAsync.
     */
    public function setProjectAdmin(string $projectId, string $memberId, bool $isProjectAdmin): ?array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT m.*, u."DisplayName" AS "UserDisplayName", u."EmailAddress" AS "UserEmailAddress" FROM "ProjectMembers" m
            JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."Id" = :id AND m."ProjectId" = :pid
        SQL);
        $stmt->execute(['id' => $memberId, 'pid' => $projectId]);
        $member = $stmt->fetch();
        if ($member === false) {
            return null;
        }

        if (!$isProjectAdmin && (bool) $member['IsProjectAdmin']) {
            $this->ensureNotLastProjectAdmin($projectId, $memberId);
        }

        $this->db->prepare('UPDATE "ProjectMembers" SET "IsProjectAdmin" = :isAdmin WHERE "Id" = :id')
            ->execute(['isAdmin' => (int) $isProjectAdmin, 'id' => $memberId]);

        return [
            'id' => $memberId, 'userId' => $member['UserId'], 'displayName' => $member['UserDisplayName'],
            'email' => $member['UserEmailAddress'], 'color' => $member['Color'], 'role' => $member['Role'],
            'allocatedFraction' => $member['AllocatedFraction'], 'reportsToId' => $member['ReportsToId'],
            'isProjectAdmin' => $isProjectAdmin,
        ];
    }

    /**
     * A project with zero Project Admins can never have another one assigned again short of direct
     * DB access — nobody left could reach the "manage team members" capability that grants the role
     * in the first place. Called before demoting/removing a member who IS currently a Project Admin;
     * throws if they're the last one. Ported from Services/MemberService.cs's
     * EnsureNotLastProjectAdminAsync.
     */
    private function ensureNotLastProjectAdmin(string $projectId, string $excludingMemberId): void
    {
        $stmt = $this->db->prepare(
            'SELECT 1 FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "Id" != :id AND "IsProjectAdmin" = true'
        );
        $stmt->execute(['pid' => $projectId, 'id' => $excludingMemberId]);
        if ($stmt->fetch() === false) {
            throw new ApiValidationException('A project must always have at least one Project Admin. Assign another member as Project Admin first.');
        }
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
}
