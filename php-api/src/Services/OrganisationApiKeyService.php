<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\PasswordHasher;
use PDO;

/**
 * Ported from Services/OrganisationApiKeyService.cs. OrgAdmin-facing generate/revoke of the
 * one-per-Organisation public API key that gates PublicQueryController — same "rotate-only secret,
 * shown once, bcrypt-hashed" shape as OrganisationSsoConfigService's SCIM token, kept in its own
 * table/service (not folded into SSO config) since API keys are an unrelated concern.
 */
final class OrganisationApiKeyService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function get(string $organisationId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "OrganisationApiKeys" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $organisationId]);
        $key = $stmt->fetch();
        return $this->toDto($key === false ? null : $key);
    }

    /**
     * Mints a new random key, stores only its hash, and returns the raw value — the one and only
     * time it's ever retrievable. Generating a new key immediately invalidates whatever was issued
     * before, and re-enables the key if it was previously revoked.
     */
    public function generate(string $organisationId): array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrganisationApiKeys" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $organisationId]);
        $exists = $stmt->fetch() !== false;

        $rawKey = 'enklr_key_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $hash = PasswordHasher::hash($rawKey);

        if ($exists) {
            $this->db->prepare(
                'UPDATE "OrganisationApiKeys" SET "KeyHash" = :hash, "GeneratedAt" = now(), "Enabled" = true WHERE "OrganisationId" = :id'
            )->execute(['hash' => $hash, 'id' => $organisationId]);
        } else {
            $this->db->prepare(
                'INSERT INTO "OrganisationApiKeys" ("OrganisationId", "KeyHash", "GeneratedAt", "Enabled") VALUES (:id, :hash, now(), true)'
            )->execute(['id' => $organisationId, 'hash' => $hash]);
        }

        return ['key' => $rawKey];
    }

    public function revoke(string $organisationId): array
    {
        $this->db->prepare('UPDATE "OrganisationApiKeys" SET "Enabled" = false WHERE "OrganisationId" = :id')
            ->execute(['id' => $organisationId]);
        return $this->get($organisationId);
    }

    /** @param array<string,mixed>|null $key */
    private function toDto(?array $key): array
    {
        return [
            'enabled' => $key !== null && (bool) $key['Enabled'],
            'hasApiKey' => $key !== null && !empty($key['KeyHash']),
            'generatedAt' => $key['GeneratedAt'] ?? null,
            'lastUsedAt' => $key['LastUsedAt'] ?? null,
        ];
    }
}
