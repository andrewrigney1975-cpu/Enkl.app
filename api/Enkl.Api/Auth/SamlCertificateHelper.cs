using System.Security.Cryptography.X509Certificates;

namespace Enkl.Api.Auth;

/// <summary>
/// Parses the IdP signing certificate an OrgAdmin pastes into the SSO config form — accepted as
/// either a full PEM block or a bare base64 DER string, since different IdPs' admin consoles offer
/// one or the other when you download/copy their signing cert.
/// </summary>
public static class SamlCertificateHelper
{
    // 2048 bits is the current NIST/CA-Browser-Forum floor for RSA; ECDSA keys (P-256 and up) are
    // already well above this in effective strength at far smaller key sizes, so only RSA is capped.
    private const int MinimumRsaKeySizeBits = 2048;

    public static X509Certificate2 Parse(string raw)
    {
        var cleaned = raw
            .Replace("-----BEGIN CERTIFICATE-----", "")
            .Replace("-----END CERTIFICATE-----", "")
            .Replace("\r", "").Replace("\n", "").Trim();
        return X509CertificateLoader.LoadCertificate(Convert.FromBase64String(cleaned));
    }

    public static bool TryParse(string raw, out X509Certificate2? certificate)
    {
        try
        {
            certificate = Parse(raw);
            return true;
        }
        catch
        {
            certificate = null;
            return false;
        }
    }

    /// <summary>
    /// Security review (Low/Informational finding): parsing alone never checked whether the
    /// certificate was still within its validity window or used a strong enough key — an expired
    /// cert (or one signed with a weak, e.g. 1024-bit, RSA key) was accepted just as readily as a
    /// current, strong one. Returns null if healthy, otherwise a caller-facing message explaining
    /// why it was rejected.
    /// </summary>
    public static string? ValidateHealth(X509Certificate2 certificate)
    {
        // NotBefore/NotAfter are exposed in local time by X509Certificate2 itself (per its own docs),
        // so comparing against DateTime.Now — not UtcNow — is correct here.
        var now = DateTime.Now;
        if (now < certificate.NotBefore)
        {
            return $"This certificate isn't valid until {certificate.NotBefore:yyyy-MM-dd}.";
        }
        if (now > certificate.NotAfter)
        {
            return $"This certificate expired on {certificate.NotAfter:yyyy-MM-dd}. Ask your identity provider for a current signing certificate.";
        }

        using var rsaKey = certificate.GetRSAPublicKey();
        if (rsaKey is not null && rsaKey.KeySize < MinimumRsaKeySizeBits)
        {
            return $"This certificate's RSA key is only {rsaKey.KeySize} bits — {MinimumRsaKeySizeBits}-bit or stronger is required.";
        }

        return null;
    }
}
