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
            $stmt = $this->db->prepare(<<<SQL
                INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt")
                VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, :hash, :displayName, true, false, now())
            SQL);
            $stmt->execute([
                'id' => $userId, 'orgId' => $project['OrganisationId'], 'username' => $usernameToUse,
                'normalized' => $usernameToUse, 'email' => $email, 'normalizedEmail' => $normalizedEmail,
                'hash' => PasswordHasher::hash('enklUserPassword'), 'displayName' => $trimmedName,
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

        return ['id' => $memberId, 'userId' => $user['Id'], 'displayName' => $user['DisplayName'], 'email' => $user['EmailAddress'] ?? null, 'color' => $color, 'role' => null, 'allocatedFraction' => null, 'reportsToId' => null];
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

        return ['id' => $memberId, 'userId' => $member['UserId'], 'displayName' => $displayName, 'email' => $member['UserEmailAddress'], 'color' => $member['Color'], 'role' => $role, 'allocatedFraction' => $allocatedFraction, 'reportsToId' => $reportsToId];
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
        $stmt = $this->db->prepare('SELECT 1 FROM "ProjectMembers" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $memberId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        // ReportsTo is a Restrict FK — anyone reporting to this member gets orphaned back to "no one"
        // first, same as mutations.js's removeMember. Every other reference (task Assignee, Document/
        // Release/Risk/Decision Owner, TeamCommitteeMember) is already SetNull/Cascade at the DB level.
        $this->db->prepare('UPDATE "ProjectMembers" SET "ReportsToId" = NULL WHERE "ProjectId" = :pid AND "ReportsToId" = :id')
            ->execute(['pid' => $projectId, 'id' => $memberId]);

        $this->db->prepare('DELETE FROM "ProjectMembers" WHERE "Id" = :id')->execute(['id' => $memberId]);
        return true;
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
