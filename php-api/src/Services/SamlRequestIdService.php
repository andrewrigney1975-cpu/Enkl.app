<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use PDO;

/**
 * PHP-specific replacement for the .NET side's in-memory SamlRequestIdStore singleton — a
 * ConcurrentDictionary works there because ASP.NET Core hosts the app as one long-lived process;
 * PHP has no equivalent guarantee (a request ID recorded by whichever PHP-FPM worker handles
 * SamlController::login() would never be found by whichever worker later handles the ACS callback),
 * so this is backed by the "SamlRequestIds" table (011_add_saml_request_ids.sql) instead. Same
 * security property either way (security review finding M5): SamlController::login() mints an
 * AuthnRequest with its own ID, sends it to the IdP, then used to forget it entirely — nothing
 * correlated the ACS callback's InResponseTo back to a request this SP actually issued, so a
 * captured, validly-signed SAML response was replayable any number of times until its own
 * NotOnOrAfter window closed. This records each outstanding request ID and single-use-consumes it
 * against the response's InResponseTo in SamlController::acs.
 */
final class SamlRequestIdService
{
    // Generous relative to a normal SSO round-trip (redirect to IdP, authenticate, redirect back) to
    // tolerate a slow IdP-side MFA step, but still bounds how long a leaked InResponseTo value would
    // even be checkable against a still-outstanding entry.
    private const TTL_SECONDS = 600;

    public function __construct(private readonly PDO $db)
    {
    }

    public function record(string $orgId, string $requestId): void
    {
        $this->pruneExpired();
        $stmt = $this->db->prepare('INSERT INTO "SamlRequestIds" ("RequestId", "OrgId", "ExpiresAt") VALUES (:id, :orgId, :expiresAt)');
        $stmt->execute([
            'id' => $requestId,
            'orgId' => $orgId,
            'expiresAt' => (new \DateTimeImmutable())->modify('+' . self::TTL_SECONDS . ' seconds')->format('Y-m-d H:i:s.uP'),
        ]);
    }

    /**
     * Single-use: the row is deleted on lookup regardless of outcome, so the same InResponseTo value
     * can never pass this check twice — the actual replay-protection guarantee. Only call this with a
     * value read from a response that will ALSO be passed into Auth::processResponse($requestId) —
     * that call is what cryptographically ties the InResponseTo the IdP actually signed to the value
     * checked here; reading InResponseTo off an unvalidated response is never trusted on its own.
     */
    public function consume(string $orgId, ?string $requestId): bool
    {
        if ($requestId === null || $requestId === '') {
            return false;
        }

        $stmt = $this->db->prepare('SELECT "OrgId", "ExpiresAt" FROM "SamlRequestIds" WHERE "RequestId" = :id');
        $stmt->execute(['id' => $requestId]);
        $row = $stmt->fetch();

        $this->db->prepare('DELETE FROM "SamlRequestIds" WHERE "RequestId" = :id')->execute(['id' => $requestId]);

        if ($row === false) {
            return false;
        }
        if ($row['OrgId'] !== $orgId) {
            return false;
        }
        return new \DateTimeImmutable($row['ExpiresAt']) >= new \DateTimeImmutable();
    }

    private function pruneExpired(): void
    {
        $this->db->prepare('DELETE FROM "SamlRequestIds" WHERE "ExpiresAt" < now()')->execute();
    }
}
