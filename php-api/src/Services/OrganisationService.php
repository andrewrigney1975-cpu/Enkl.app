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
            'SELECT "Id", "Username", "DisplayName", "IsOrgAdmin", "CreatedAt" FROM "Users" WHERE "OrganisationId" = :id'
        );
        $stmt->execute(['id' => $organisationId]);
        $users = array_map(static fn(array $u): array => [
            'id' => $u['Id'],
            'username' => $u['Username'],
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
     * Usernames are unique across the whole system, not just this Organisation.
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

        $id = Uuid::v4();
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "CreatedAt")
            VALUES (:id, :orgId, :username, :normalized, :hash, :displayName, true, false, now())
        SQL);
        $stmt->execute([
            'id' => $id,
            'orgId' => $organisationId,
            'username' => $normalized,
            'normalized' => $normalized,
            'hash' => PasswordHasher::hash($password),
            'displayName' => $displayName,
        ]);

        return [
            'id' => $id,
            'username' => $normalized,
            'displayName' => $displayName,
            'isOrgAdmin' => false,
            'createdAt' => gmdate('Y-m-d\TH:i:s.v\Z'),
        ];
    }
}
