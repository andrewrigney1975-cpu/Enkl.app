<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/** Ported from Services/OrganisationService.cs. */
final class OrganisationService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function getOrganisation(string $organisationId): ?array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Name", "DefaultNewUserPasswordHash" FROM "Organisations" WHERE "Id" = :id');
        $stmt->execute(['id' => $organisationId]);
        $org = $stmt->fetch();
        if ($org === false) {
            return null;
        }

        $stmt = $this->db->prepare(
            'SELECT "Id", "Username", "EmailAddress", "DisplayName", "IsOrgAdmin", "IsActive", "CreatedAt", "PasswordHash" FROM "Users" WHERE "OrganisationId" = :id'
        );
        $stmt->execute(['id' => $organisationId]);
        $online = $this->onlineUserIds();
        $users = array_map(static fn(array $u): array => [
            'id' => $u['Id'],
            'username' => $u['Username'],
            'emailAddress' => $u['EmailAddress'],
            'displayName' => $u['DisplayName'],
            'isOrgAdmin' => (bool) $u['IsOrgAdmin'],
            'isActive' => (bool) $u['IsActive'],
            'createdAt' => $u['CreatedAt'],
            'isOnline' => in_array($u['Id'], $online, true),
            'hasPassword' => $u['PasswordHash'] !== null,
        ], $stmt->fetchAll());

        return [
            'id' => $org['Id'],
            'name' => $org['Name'],
            'hasCustomDefaultPassword' => $org['DefaultNewUserPasswordHash'] !== null,
            'users' => $users,
        ];
    }

    /**
     * Lets an OrgAdmin configure the password newly (implicitly) created users in their org get,
     * instead of the hardcoded PasswordHasher::GLOBAL_DEFAULT_NEW_USER_PASSWORD every org used to
     * share. Only the bcrypt HASH is ever persisted — there is deliberately no corresponding "get the
     * current default password" endpoint; an admin who forgets what they set can only overwrite it
     * with a new one, never read it back.
     */
    public function setDefaultNewUserPassword(string $organisationId, string $password): bool
    {
        if (strlen($password) < 8) {
            throw new ApiValidationException('Password must be at least 8 characters.');
        }

        $stmt = $this->db->prepare('SELECT 1 FROM "Organisations" WHERE "Id" = :id');
        $stmt->execute(['id' => $organisationId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        $stmt = $this->db->prepare('UPDATE "Organisations" SET "DefaultNewUserPasswordHash" = :hash WHERE "Id" = :id');
        $stmt->execute(['hash' => PasswordHasher::hash($password), 'id' => $organisationId]);
        return true;
    }

    /** @return string[] Same query/grace-window as ChatService::onlineUserIds — duplicated rather
     * than shared, matching this tier's existing per-class-duplication convention (see php-api/CLAUDE.md). */
    private function onlineUserIds(): array
    {
        // MariaDB port: Postgres's `interval '25 seconds'` literal syntax isn't valid here — MariaDB
        // uses the keyword form `INTERVAL 25 SECOND` (no quotes, unit as a bare keyword).
        $stmt = $this->db->query('SELECT "UserId" FROM "SsePresence" WHERE "LastSeenAt" > now() - INTERVAL 25 SECOND');
        return array_column($stmt->fetchAll(), 'UserId');
    }

    /** Returns false if the target user doesn't exist or belongs to a different Organisation than the caller. */
    public function setUserAdmin(string $callerOrganisationId, string $targetUserId, bool $isOrgAdmin): bool
    {
        $stmt = $this->db->prepare('SELECT "OrganisationId" FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $targetUserId]);
        $row = $stmt->fetch();
        if ($row === false || $row['OrganisationId'] !== $callerOrganisationId) {
            return false;
        }

        // Security review finding H2: rotating SecurityStamp here invalidates the target's
        // already-issued token(s), whose orgAdmin claim would otherwise stay stale (still
        // false/true from before this change) for up to the token's full 8-hour lifetime. MariaDB
        // port: no gen_random_uuid() function exists here — generate the replacement value in PHP
        // and bind it instead.
        $stmt = $this->db->prepare('UPDATE "Users" SET "IsOrgAdmin" = :admin, "SecurityStamp" = :stamp WHERE "Id" = :id');
        // (int), not the raw PHP bool — PDO's array-form execute() would bind false as '' otherwise,
        // which neither Postgres's nor MariaDB's boolean parser accepts.
        $stmt->execute(['admin' => (int) $isOrgAdmin, 'stamp' => Uuid::v4(), 'id' => $targetUserId]);
        return true;
    }

    /**
     * Explicit account creation by an OrgAdmin, distinct from the implicit account-per-name creation
     * MemberService/MigrationService do when adding a project member — here the admin sets a real
     * username and initial password directly, and the new user must change it on first login.
     * Usernames are unique across the whole system, not just this Organisation. Email is required
     * here (unlike the implicit-creation paths, which can leave it blank and flag it for later)
     * since an OrgAdmin filling out this form explicitly has no excuse not to supply one — it's the
     * planned SAML2 identifier.
     */
    public function createUser(string $organisationId, array $request): array
    {
        $displayName = trim((string) ($request['displayName'] ?? ''));
        if ($displayName === '') {
            throw new ApiValidationException('Please enter a display name.');
        }
        if (strlen($displayName) > 200) {
            $displayName = substr($displayName, 0, 200);
        }

        $password = (string) ($request['password'] ?? '');
        if (strlen($password) < 8) {
            throw new ApiValidationException('Password must be at least 8 characters.');
        }

        $normalized = UsernameNormalizer::normalize((string) ($request['username'] ?? ''));
        if ($normalized === '') {
            throw new ApiValidationException('Please enter a username.');
        }

        $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "NormalizedUsername" = :n');
        $stmt->execute(['n' => $normalized]);
        if ($stmt->fetch() !== false) {
            throw new ApiValidationException("Username \"{$normalized}\" is already taken.");
        }

        [$email, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $request['emailAddress'] ?? null, true, null);

        $id = Uuid::v4();
        // MariaDB port: "SecurityStamp" has no DB-side default here (see
        // src/Db/migrations/001_initial_schema.sql's own note) — unlike php-api's original, which
        // relied on Postgres's `DEFAULT gen_random_uuid()`, this INSERT must supply one explicitly.
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt", "SecurityStamp")
            VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, :hash, :displayName, true, false, now(), :securityStamp)
        SQL);
        $stmt->execute([
            'id' => $id,
            'orgId' => $organisationId,
            'username' => $normalized,
            'normalized' => $normalized,
            'email' => $email,
            'normalizedEmail' => $normalizedEmail,
            'hash' => PasswordHasher::hash($password),
            'displayName' => $displayName,
            'securityStamp' => Uuid::v4(),
        ]);

        return [
            'id' => $id,
            'username' => $normalized,
            'emailAddress' => $email,
            'displayName' => $displayName,
            'isOrgAdmin' => false,
            'isActive' => true,
            'createdAt' => gmdate('Y-m-d\TH:i:s.v\Z'),
            'hasPassword' => true,
        ];
    }

    /**
     * The backfill path for a User created before this field existed (or migrated without one, see
     * MigrationService's warnings) — same validation as createUser, scoped to the caller's own
     * Organisation the same way setUserAdmin is.
     */
    public function setUserEmail(string $callerOrganisationId, string $targetUserId, ?string $emailAddress): bool
    {
        $stmt = $this->db->prepare('SELECT "OrganisationId" FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $targetUserId]);
        $row = $stmt->fetch();
        if ($row === false || $row['OrganisationId'] !== $callerOrganisationId) {
            return false;
        }

        [$email, $normalizedEmail] = EmailValidation::validateAndNormalize($this->db, $emailAddress, true, $targetUserId);

        $stmt = $this->db->prepare('UPDATE "Users" SET "EmailAddress" = :email, "NormalizedEmailAddress" = :normalizedEmail WHERE "Id" = :id');
        $stmt->execute(['email' => $email, 'normalizedEmail' => $normalizedEmail, 'id' => $targetUserId]);
        return true;
    }

    /**
     * OrgAdmin-initiated password reset for an existing user — distinct from
     * setDefaultNewUserPassword (only affects users created *after* the setting changes) and
     * createUser (creates a brand-new account). A null/blank $password falls back to the org's
     * configured default via resolveDefaultNewUserPasswordHash() (the same value a freshly-created
     * implicit user would get). Always sets MustChangePassword and rotates SecurityStamp — MariaDB
     * port: no gen_random_uuid() function here, generate the replacement value in PHP and bind it,
     * same as setUserAdmin/deactivateUser above. Rejects (ApiValidationException) for a user whose
     * PasswordHash is null — an SSO/SCIM-provisioned account has no password to reset.
     */
    public function resetUserPassword(string $callerOrganisationId, string $targetUserId, ?string $password): bool
    {
        $stmt = $this->db->prepare('SELECT "OrganisationId", "PasswordHash" FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $targetUserId]);
        $row = $stmt->fetch();
        if ($row === false || $row['OrganisationId'] !== $callerOrganisationId) {
            return false;
        }

        if ($row['PasswordHash'] === null) {
            throw new ApiValidationException('This user signs in via SSO and has no password to reset.');
        }

        if ($password === null || $password === '') {
            $hash = $this->resolveDefaultNewUserPasswordHash($callerOrganisationId);
        } else {
            if (strlen($password) < 8) {
                throw new ApiValidationException('Password must be at least 8 characters.');
            }
            $hash = PasswordHasher::hash($password);
        }

        $stmt = $this->db->prepare('UPDATE "Users" SET "PasswordHash" = :hash, "MustChangePassword" = 1, "SecurityStamp" = :stamp WHERE "Id" = :id');
        $stmt->execute(['hash' => $hash, 'stamp' => Uuid::v4(), 'id' => $targetUserId]);
        return true;
    }

    /** Duplicated per-class private helper (this tier's own convention — see mariadb-api/CLAUDE.md /
     * root CLAUDE.md §7). */
    private function resolveDefaultNewUserPasswordHash(string $organisationId): string
    {
        $stmt = $this->db->prepare('SELECT "DefaultNewUserPasswordHash" FROM "Organisations" WHERE "Id" = :id');
        $stmt->execute(['id' => $organisationId]);
        $hash = $stmt->fetchColumn();
        return $hash !== false && $hash !== null ? $hash : PasswordHasher::hash(PasswordHasher::GLOBAL_DEFAULT_NEW_USER_PASSWORD);
    }

    /**
     * Org-admin-initiated deprovisioning — flips IsActive false and rotates SecurityStamp, the same
     * pattern ScimUserService's Active-flag path already uses for SCIM-driven deactivation. Rotating
     * SecurityStamp means any already-issued JWT for this user is rejected on its very next request,
     * not just at its natural ~8h expiry. An OrgAdmin cannot deactivate their own account — a guard
     * against a self-lockout misclick, not itself a security boundary. Idempotent: deactivating an
     * already-inactive user returns true without rotating the stamp again. MariaDB port: no
     * gen_random_uuid() function exists here — generate the replacement SecurityStamp in PHP and
     * bind it, same as setUserAdmin above.
     */
    public function deactivateUser(string $callerOrganisationId, string $callerUserId, string $targetUserId): bool
    {
        if ($targetUserId === $callerUserId) {
            throw new ApiValidationException('You cannot deactivate your own account.');
        }

        $stmt = $this->db->prepare('SELECT "OrganisationId", "IsActive" FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $targetUserId]);
        $row = $stmt->fetch();
        if ($row === false || $row['OrganisationId'] !== $callerOrganisationId) {
            return false;
        }

        if (!(bool) $row['IsActive']) {
            return true;
        }

        $stmt = $this->db->prepare('UPDATE "Users" SET "IsActive" = 0, "SecurityStamp" = :stamp WHERE "Id" = :id');
        $stmt->execute(['stamp' => Uuid::v4(), 'id' => $targetUserId]);
        return true;
    }

    /** Read-only listing for the SSO & Provisioning modal's Org Teams section — SCIM (ScimGroupService)
     * is the only writer of OrgTeams/OrgTeamMember, mirroring GetOrgTeamsAsync in OrganisationService.cs. */
    public function getOrgTeams(string $organisationId): array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Name" FROM "OrgTeams" WHERE "OrganisationId" = :id ORDER BY "Name"');
        $stmt->execute(['id' => $organisationId]);
        $teams = $stmt->fetchAll();

        $memberStmt = $this->db->prepare(<<<SQL
            SELECT m."UserId", u."DisplayName" FROM "OrgTeamMember" m
            JOIN "Users" u ON u."Id" = m."UserId"
            WHERE m."OrgTeamId" = :id
        SQL);

        return array_map(function (array $t) use ($memberStmt): array {
            $memberStmt->execute(['id' => $t['Id']]);
            return [
                'id' => $t['Id'],
                'name' => $t['Name'],
                'members' => array_map(
                    static fn(array $m): array => ['userId' => $m['UserId'], 'displayName' => $m['DisplayName']],
                    $memberStmt->fetchAll()
                ),
            ];
        }, $teams);
    }
}
