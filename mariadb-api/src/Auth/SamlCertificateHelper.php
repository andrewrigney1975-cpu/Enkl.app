<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

/**
 * Ported from Auth/SamlCertificateHelper.cs. Validates an IdP signing certificate an OrgAdmin
 * pastes into the SSO config form — accepted as either a full PEM block or a bare base64 DER
 * string, since different IdPs' admin consoles offer one or the other. This is purely a save-time
 * sanity check: onelogin\Saml2\Utils::formatCert() already accepts and normalizes either form
 * itself when the raw stored string is later handed to it in the settings array (see
 * SamlService::buildAuthSettings), so nothing here needs to touch the value that actually gets
 * stored — it exists only so a bad paste (or an expired/weak-key one) is rejected with a clear
 * message at save time, not the first time an assertion fails to verify.
 */
final class SamlCertificateHelper
{
    // 2048 bits is the current NIST/CA-Browser-Forum floor for RSA; ECDSA keys (P-256 and up) are
    // already well above this in effective strength at far smaller key sizes, so only RSA is capped.
    private const MIN_RSA_KEY_SIZE_BITS = 2048;

    public static function isValid(string $raw): bool
    {
        return self::validationError($raw) === null;
    }

    /**
     * Security review (Low/Informational finding): parsing alone never checked whether the
     * certificate was still within its validity window or used a strong enough key — an expired
     * cert (or one signed with a weak, e.g. 1024-bit, RSA key) was accepted just as readily as a
     * current, strong one. Returns null if healthy, otherwise a caller-facing message explaining
     * why it was rejected.
     */
    public static function validationError(string $raw): ?string
    {
        $resource = @openssl_x509_read(self::toPem($raw));
        if ($resource === false) {
            return 'Could not parse the IdP signing certificate. Paste the PEM block or base64 DER value your identity provider gave you.';
        }
        $parsed = openssl_x509_parse($resource);
        if ($parsed === false) {
            return 'Could not parse the IdP signing certificate. Paste the PEM block or base64 DER value your identity provider gave you.';
        }

        $now = time();
        if (isset($parsed['validFrom_time_t']) && $now < $parsed['validFrom_time_t']) {
            return 'This certificate isn\'t valid until ' . date('Y-m-d', $parsed['validFrom_time_t']) . '.';
        }
        if (isset($parsed['validTo_time_t']) && $now > $parsed['validTo_time_t']) {
            return 'This certificate expired on ' . date('Y-m-d', $parsed['validTo_time_t']) . '. Ask your identity provider for a current signing certificate.';
        }

        $publicKey = openssl_pkey_get_public($resource);
        if ($publicKey !== false) {
            $details = openssl_pkey_get_details($publicKey);
            if ($details !== false && ($details['type'] ?? null) === OPENSSL_KEYTYPE_RSA && $details['bits'] < self::MIN_RSA_KEY_SIZE_BITS) {
                return "This certificate's RSA key is only {$details['bits']} bits — " . self::MIN_RSA_KEY_SIZE_BITS . '-bit or stronger is required.';
            }
        }

        return null;
    }

    /** openssl_x509_read() requires PEM-with-headers specifically, unlike onelogin/php-saml's own
     * formatCert() — this local conversion exists only to feed that one call above. */
    private static function toPem(string $raw): string
    {
        $trimmed = trim($raw);
        if (str_contains($trimmed, '-----BEGIN CERTIFICATE-----')) {
            return $trimmed;
        }
        $cleaned = trim(preg_replace('/\s+/', '', $trimmed) ?? '');
        return "-----BEGIN CERTIFICATE-----\n" . chunk_split($cleaned, 64, "\n") . "-----END CERTIFICATE-----\n";
    }
}
