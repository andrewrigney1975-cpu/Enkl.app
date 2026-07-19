<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use PDO;

/**
 * PHP-specific replacement for the .NET side's in-memory SsoExchangeCodeStore singleton — a
 * ConcurrentDictionary works there because ASP.NET Core hosts the app as one long-lived process;
 * PHP has no equivalent guarantee (a code issued while one PHP-FPM worker handles the SAML ACS
 * callback would never be found by whichever worker happens to handle the follow-up redeem
 * request), so this is backed by the "ExchangeCodes" table (007_add_exchange_codes.sql) instead.
 * Same security property either way: a short-lived, single-use code stands in for the real JWT in
 * a redirect URL, since putting a bearer token directly in a URL risks it leaking via browser
 * history or a Referer header.
 */
final class SsoExchangeCodeService
{
    private const TTL_SECONDS = 120;

    public function __construct(private readonly PDO $db)
    {
    }

    public function issue(string $payload): string
    {
        $this->pruneExpired();

        $code = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $stmt = $this->db->prepare('INSERT INTO "ExchangeCodes" ("Code", "Payload", "ExpiresAt") VALUES (:code, :payload, :expiresAt)');
        $stmt->execute([
            'code' => $code,
            'payload' => $payload,
            'expiresAt' => (new \DateTimeImmutable())->modify('+' . self::TTL_SECONDS . ' seconds')->format('Y-m-d H:i:s.uP'),
        ]);
        return $code;
    }

    /** Single-use: the row is deleted on lookup regardless of whether it was still valid. */
    public function tryRedeem(string $code): ?string
    {
        $stmt = $this->db->prepare('SELECT "Payload", "ExpiresAt" FROM "ExchangeCodes" WHERE "Code" = :code');
        $stmt->execute(['code' => $code]);
        $row = $stmt->fetch();

        $this->db->prepare('DELETE FROM "ExchangeCodes" WHERE "Code" = :code')->execute(['code' => $code]);

        if ($row === false) {
            return null;
        }
        if (new \DateTimeImmutable($row['ExpiresAt']) < new \DateTimeImmutable()) {
            return null;
        }
        return $row['Payload'];
    }

    private function pruneExpired(): void
    {
        $this->db->prepare('DELETE FROM "ExchangeCodes" WHERE "ExpiresAt" < now()')->execute();
    }
}
