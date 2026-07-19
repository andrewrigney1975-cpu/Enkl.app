<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\SamlCertificateHelper;
use Enkl\Api\Config\Config;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/OrganisationSsoConfigService.cs. OrgAdmin-facing read/write of the
 * one-per-Organisation SAML/SCIM settings row — separate from OrganisationService (which manages
 * the org's Users) since this is a different resource with its own get/update shape, not another
 * User-CRUD operation.
 */
final class OrganisationSsoConfigService
{
    public function __construct(
        private readonly PDO $db,
        private readonly SamlService $saml
    ) {
    }

    private function scimBaseUrl(string $organisationId): string
    {
        return rtrim((string) Config::get('APP_PUBLIC_BASE_URL', ''), '/') . '/api/scim/v2/' . $organisationId;
    }

    public function get(string $organisationId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "OrganisationSsoConfigs" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $organisationId]);
        $cfg = $stmt->fetch();
        return $this->toDto($organisationId, $cfg === false ? null : $cfg);
    }

    /** @param array<string,mixed> $request */
    public function update(string $organisationId, array $request): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "OrganisationSsoConfigs" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $organisationId]);
        $existing = $stmt->fetch();

        $samlEnabled = (bool) ($request['samlEnabled'] ?? false);
        $idpEntityId = trim((string) ($request['idpEntityId'] ?? ''));
        $idpSsoUrl = trim((string) ($request['idpSsoUrl'] ?? ''));
        $samlJitProvisioning = (bool) ($request['samlJitProvisioning'] ?? false);
        $requireSso = (bool) ($request['requireSso'] ?? false);
        $scimEnabled = (bool) ($request['scimEnabled'] ?? false);

        // Certificate is optional in the request precisely because the DTO returned by get() never
        // sends the existing one back to the browser to resubmit unchanged. A non-empty value
        // replaces it; empty/omitted leaves whatever's already stored as-is.
        $idpSigningCertificate = $existing !== false ? $existing['IdpSigningCertificate'] : null;
        $rawCertificate = trim((string) ($request['idpSigningCertificate'] ?? ''));
        if ($rawCertificate !== '') {
            // Security review (Low/Informational finding): rejects an expired/not-yet-valid/
            // weak-key certificate at save time too, not just an unparseable one.
            $certificateError = SamlCertificateHelper::validationError($rawCertificate);
            if ($certificateError !== null) {
                throw new ApiValidationException($certificateError);
            }
            $idpSigningCertificate = $rawCertificate;
        }

        if ($samlEnabled && ($idpSsoUrl === '' || empty($idpSigningCertificate))) {
            throw new ApiValidationException('Enabling SAML requires an IdP SSO URL and signing certificate.');
        }
        if ($requireSso && !$samlEnabled) {
            throw new ApiValidationException('"Require SSO" needs SAML to be enabled and fully configured first.');
        }
        $scimBearerTokenHash = $existing !== false ? $existing['ScimBearerTokenHash'] : null;
        if ($scimEnabled && empty($scimBearerTokenHash)) {
            throw new ApiValidationException('Generate a SCIM bearer token before enabling SCIM provisioning.');
        }

        $params = [
            'samlEnabled' => (int) $samlEnabled,
            'idpEntityId' => $idpEntityId !== '' ? $idpEntityId : null,
            'idpSsoUrl' => $idpSsoUrl !== '' ? $idpSsoUrl : null,
            'cert' => $idpSigningCertificate,
            'jit' => (int) $samlJitProvisioning,
            'requireSso' => (int) $requireSso,
            'scimEnabled' => (int) $scimEnabled,
        ];

        if ($existing === false) {
            $this->db->prepare(<<<SQL
                INSERT INTO "OrganisationSsoConfigs"
                    ("OrganisationId", "SamlEnabled", "IdpEntityId", "IdpSsoUrl", "IdpSigningCertificate", "SamlJitProvisioning", "RequireSso", "ScimEnabled", "DateLastModified")
                VALUES (:orgId, :samlEnabled, :idpEntityId, :idpSsoUrl, :cert, :jit, :requireSso, :scimEnabled, now())
            SQL)->execute($params + ['orgId' => $organisationId]);
        } else {
            $this->db->prepare(<<<SQL
                UPDATE "OrganisationSsoConfigs" SET
                    "SamlEnabled" = :samlEnabled, "IdpEntityId" = :idpEntityId, "IdpSsoUrl" = :idpSsoUrl,
                    "IdpSigningCertificate" = :cert, "SamlJitProvisioning" = :jit, "RequireSso" = :requireSso,
                    "ScimEnabled" = :scimEnabled, "DateLastModified" = now()
                WHERE "OrganisationId" = :orgId
            SQL)->execute($params + ['orgId' => $organisationId]);
        }

        return $this->get($organisationId);
    }

    /**
     * Mints a new random bearer token, stores only its hash (same PasswordHasher bcrypt scheme as
     * a user password), and returns the raw value — the one and only time it's ever retrievable.
     * Generating a new token immediately invalidates whatever was issued before, same as rotating
     * any other secret; there's no way to have two valid tokens at once in this design.
     */
    public function generateScimToken(string $organisationId): array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "OrganisationSsoConfigs" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $organisationId]);
        $exists = $stmt->fetch() !== false;

        $rawToken = 'scim_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $hash = PasswordHasher::hash($rawToken);

        if ($exists) {
            $this->db->prepare(
                'UPDATE "OrganisationSsoConfigs" SET "ScimBearerTokenHash" = :hash, "ScimTokenGeneratedAt" = now(), "DateLastModified" = now() WHERE "OrganisationId" = :id'
            )->execute(['hash' => $hash, 'id' => $organisationId]);
        } else {
            $this->db->prepare(
                'INSERT INTO "OrganisationSsoConfigs" ("OrganisationId", "ScimBearerTokenHash", "ScimTokenGeneratedAt", "DateLastModified") VALUES (:id, :hash, now(), now())'
            )->execute(['id' => $organisationId, 'hash' => $hash]);
        }

        return ['token' => $rawToken];
    }

    /** @param array<string,mixed>|null $cfg */
    private function toDto(string $organisationId, ?array $cfg): array
    {
        return [
            'samlEnabled' => $cfg !== null && (bool) $cfg['SamlEnabled'],
            'idpEntityId' => $cfg['IdpEntityId'] ?? null,
            'idpSsoUrl' => $cfg['IdpSsoUrl'] ?? null,
            'hasIdpSigningCertificate' => $cfg !== null && !empty($cfg['IdpSigningCertificate']),
            'samlJitProvisioning' => $cfg !== null && (bool) $cfg['SamlJitProvisioning'],
            'requireSso' => $cfg !== null && (bool) $cfg['RequireSso'],
            'spEntityId' => $this->saml->spEntityId($organisationId),
            'spAcsUrl' => $this->saml->acsUrl($organisationId),
            'spMetadataUrl' => $this->saml->spEntityId($organisationId),
            'scimEnabled' => $cfg !== null && (bool) $cfg['ScimEnabled'],
            'hasScimToken' => $cfg !== null && !empty($cfg['ScimBearerTokenHash']),
            'scimBaseUrl' => $this->scimBaseUrl($organisationId),
        ];
    }
}
