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
 * stored — it exists only so a bad paste is rejected with a clear message at save time, not the
 * first time an assertion fails to verify.
 */
final class SamlCertificateHelper
{
    public static function isValid(string $raw): bool
    {
        $resource = @openssl_x509_read(self::toPem($raw));
        if ($resource === false) {
            return false;
        }
        return openssl_x509_parse($resource) !== false;
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
