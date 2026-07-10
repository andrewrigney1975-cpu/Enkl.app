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
        $stmt = $this->db->prepare('SELECT "Id", "Name" FROM "Organisations" WHERE "Id" = :id');
        $stmt->execute(['id' => $organisationId]);
        $org = $stmt->fetch();
        if ($org === false) {
            return null;
        }

        $stmt = $this->db->prepare(
            'SELECT "Id", "Username", "EmailAddress", "DisplayName", "IsOrgAdmin", "CreatedAt" FROM "Users" WHERE "OrganisationId" = :id'
        );
        $stmt->execute(['id' => $organisationId]);
        $users = array_map(static fn(array $u): array => [
            'id' => $u['Id'],
            'username' => $u['Username'],
            'emailAddress' => $u['EmailAddress'],
            'displayName' => $u['DisplayName'],
            'isOrgAdmin' => (bool) $u['IsOrgAdmin'],
            'createdAt' => $u['CreatedAt'],
        ], $stmt->fetchAll());

        return ['id' => $org['Id'], 'name' => $org['Name'], 'users' => $users];
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

        $stmt = $this->db->prepare('UPDATE "Users" SET "IsOrgAdmin" = :admin WHERE "Id" = :id');
        // (int), not the raw PHP bool — PDO's array-form execute() would bind false as '' otherwise,
        // which Postgres's boolean parser rejects.
        $stmt->execute(['admin' => (int) $isOrgAdmin, 'id' => $targetUserId]);
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
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt")
            VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, :hash, :displayName, true, false, now())
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
        ]);

        return [
            'id' => $id,
            'username' => $normalized,
            'emailAddress' => $email,
            'displayName' => $displayName,
            'isOrgAdmin' => false,
            'createdAt' => gmdate('Y-m-d\TH:i:s.v\Z'),
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
