<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\EmailAddressNormalizer;
use Enkl\Api\Auth\JwtService;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Config\Config;
use Enkl\Api\Support\Uuid;
use PDO;

/**
 * Ported from Services/SamlService.cs. SP-side SAML logic shared by SamlController's three
 * actions — org lookup, JIT provisioning, JWT issuance. Kept separate from the controller because
 * SamlController's actions are tightly coupled to onelogin/php-saml's Auth class and PHP
 * superglobals (see that file's own comment on why the ACS action reads $_POST directly), while
 * everything here is plain business logic, same split every other controller/service pair in this
 * codebase already follows.
 */
final class SamlService
{
    public function __construct(
        private readonly PDO $db,
        private readonly SsoExchangeCodeService $exchange
    ) {
    }

    private function publicBaseUrl(): string
    {
        return rtrim((string) Config::get('APP_PUBLIC_BASE_URL', ''), '/');
    }

    public function spEntityId(string $orgId): string
    {
        return $this->publicBaseUrl() . '/api/saml/' . $orgId . '/metadata';
    }

    public function acsUrl(string $orgId): string
    {
        return $this->publicBaseUrl() . '/api/saml/' . $orgId . '/acs';
    }

    public function successRedirectUrl(string $exchangeCode): string
    {
        return $this->publicBaseUrl() . '/?ssoCode=' . rawurlencode($exchangeCode);
    }

    public function errorRedirectUrl(string $message): string
    {
        return $this->publicBaseUrl() . '/?ssoError=' . rawurlencode($message);
    }

    /** @return array<string,mixed>|null */
    public function getEnabledConfig(string $orgId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "OrganisationSsoConfigs" WHERE "OrganisationId" = :id');
        $stmt->execute(['id' => $orgId]);
        $cfg = $stmt->fetch();
        if ($cfg === false || !$cfg['SamlEnabled']) {
            return null;
        }
        return $cfg;
    }

    /**
     * Builds the onelogin/php-saml settings array for actual IdP-facing operations (login/acs) —
     * the metadata action needs no IdP fields at all, see SamlController::metadata's own settings.
     * @param array<string,mixed> $ssoConfig
     * @return array<string,mixed>
     */
    public function buildAuthSettings(string $orgId, array $ssoConfig): array
    {
        return [
            'strict' => true,
            'sp' => [
                'entityId' => $this->spEntityId($orgId),
                'assertionConsumerService' => [
                    'url' => $this->acsUrl($orgId),
                    'binding' => 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
                ],
                'NameIDFormat' => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            ],
            'idp' => [
                'entityId' => $ssoConfig['IdpEntityId'],
                'singleSignOnService' => [
                    'url' => $ssoConfig['IdpSsoUrl'],
                    'binding' => 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
                ],
                // Utils::formatCert() (called internally by the library) accepts either a bare
                // base64 DER string or an already-PEM-wrapped certificate — the raw stored value is
                // passed through unchanged; see SamlCertificateHelper's own comment.
                'x509cert' => $ssoConfig['IdpSigningCertificate'] ?? '',
            ],
            'security' => [
                'authnRequestsSigned' => false,
                'wantAssertionsSigned' => true,
                'wantNameId' => true,
            ],
        ];
    }

    /**
     * Resolves a validated assertion's NameID (email) to a User and, on success, a single-use
     * exchange code the client trades for a real JWT (see SsoExchangeCodeService). A signed
     * assertion for a user of a DIFFERENT organisation is rejected as not-found even though email
     * is globally unique — defense in depth against a misconfigured/malicious IdP asserting for
     * this route's org.
     * @param array<string,mixed> $ssoConfig
     * @return array{outcome:string, exchangeCode:?string}
     */
    public function processAssertion(string $orgId, array $ssoConfig, string $email, ?string $displayNameHint): array
    {
        $normalizedEmail = EmailAddressNormalizer::normalize($email);
        $stmt = $this->db->prepare(<<<SQL
            SELECT u.*, o."Name" AS "OrganisationName" FROM "Users" u
            JOIN "Organisations" o ON o."Id" = u."OrganisationId"
            WHERE u."NormalizedEmailAddress" = :n LIMIT 1
        SQL);
        $stmt->execute(['n' => $normalizedEmail]);
        $user = $stmt->fetch();

        if ($user !== false && $user['OrganisationId'] !== $orgId) {
            $user = false;
        }

        if ($user === false) {
            if (!$ssoConfig['SamlJitProvisioning']) {
                return ['outcome' => 'jit_disabled', 'exchangeCode' => null];
            }
            $user = $this->jitProvisionUser($orgId, $email, $normalizedEmail, $displayNameHint);
        }

        if (!$user['IsActive']) {
            return ['outcome' => 'user_inactive', 'exchangeCode' => null];
        }

        $stmt = $this->db->prepare('SELECT "ProjectId", "Role", "IsProjectAdmin" FROM "ProjectMembers" WHERE "UserId" = :uid');
        $stmt->execute(['uid' => $user['Id']]);
        $memberships = $stmt->fetchAll();

        $tokenInfo = JwtService::generateToken($user, $memberships);
        $payload = json_encode([
            'token' => $tokenInfo['token'],
            'expiresAt' => $tokenInfo['expiresAt'],
            'user' => [
                'id' => $user['Id'],
                'username' => $user['Username'],
                'displayName' => $user['DisplayName'],
                'mustChangePassword' => $user['MustChangePassword'],
            ],
        ]);

        return ['outcome' => 'success', 'exchangeCode' => $this->exchange->issue((string) $payload)];
    }

    /** @return array<string,mixed> the created user row (including OrganisationName, for JwtService::generateToken) */
    private function jitProvisionUser(string $orgId, string $email, string $normalizedEmail, ?string $displayNameHint): array
    {
        $displayName = trim((string) $displayNameHint) !== '' ? trim((string) $displayNameHint) : explode('@', $email)[0];
        if (strlen($displayName) > 200) {
            $displayName = substr($displayName, 0, 200);
        }

        $baseUsername = UsernameNormalizer::normalize($displayName !== '' ? $displayName : $email);
        if ($baseUsername === '') {
            $baseUsername = 'user';
        }
        $usernameToUse = $this->resolveUniqueUsername($baseUsername);

        $userId = Uuid::v4();
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Users" ("Id", "OrganisationId", "Username", "NormalizedUsername", "EmailAddress", "NormalizedEmailAddress", "PasswordHash", "DisplayName", "MustChangePassword", "IsOrgAdmin", "IsActive", "CreatedAt")
            VALUES (:id, :orgId, :username, :normalized, :email, :normalizedEmail, NULL, :displayName, false, false, true, now())
        SQL);
        $stmt->execute([
            'id' => $userId, 'orgId' => $orgId, 'username' => $usernameToUse, 'normalized' => $usernameToUse,
            'email' => $email, 'normalizedEmail' => $normalizedEmail, 'displayName' => $displayName,
        ]);

        $stmt = $this->db->prepare(<<<SQL
            SELECT u.*, o."Name" AS "OrganisationName" FROM "Users" u
            JOIN "Organisations" o ON o."Id" = u."OrganisationId"
            WHERE u."Id" = :id
        SQL);
        $stmt->execute(['id' => $userId]);
        return $stmt->fetch();
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
