using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// OrgAdmin-facing read/write of the one-per-Organisation SAML/SCIM settings row — separate from
/// OrganisationService (which manages the org's Users) since this is a different resource with its
/// own get/update shape, not another User-CRUD operation.
/// </summary>
public class OrganisationSsoConfigService
{
    private readonly AppDbContext _db;
    private readonly SamlService _saml;
    private readonly IConfiguration _config;

    public OrganisationSsoConfigService(AppDbContext db, SamlService saml, IConfiguration config)
    {
        _db = db;
        _saml = saml;
        _config = config;
    }

    private string PublicBaseUrl => (_config["App:PublicBaseUrl"] ?? "").TrimEnd('/');
    private string ScimBaseUrl(Guid organisationId) => $"{PublicBaseUrl}/api/scim/v2/{organisationId}";

    public async Task<SsoConfigDto> GetAsync(Guid organisationId)
    {
        var cfg = await _db.OrganisationSsoConfigs.FirstOrDefaultAsync(c => c.OrganisationId == organisationId);
        return ToDto(organisationId, cfg);
    }

    public async Task<SsoConfigDto> UpdateAsync(Guid organisationId, UpdateSsoConfigRequest request)
    {
        var cfg = await _db.OrganisationSsoConfigs.FirstOrDefaultAsync(c => c.OrganisationId == organisationId);
        if (cfg is null)
        {
            cfg = new OrganisationSsoConfig { OrganisationId = organisationId };
            _db.OrganisationSsoConfigs.Add(cfg);
        }

        cfg.SamlEnabled = request.SamlEnabled;
        cfg.IdpEntityId = string.IsNullOrWhiteSpace(request.IdpEntityId) ? null : request.IdpEntityId.Trim();
        cfg.IdpSsoUrl = string.IsNullOrWhiteSpace(request.IdpSsoUrl) ? null : request.IdpSsoUrl.Trim();
        cfg.SamlJitProvisioning = request.SamlJitProvisioning;
        cfg.RequireSso = request.RequireSso;
        cfg.ScimEnabled = request.ScimEnabled;

        // Certificate is optional in the request precisely because SsoConfigDto never sends the
        // existing one back to the browser to resubmit unchanged — see UpdateSsoConfigRequest's
        // own doc comment. A non-empty value replaces it; empty/omitted leaves it as-is.
        if (!string.IsNullOrWhiteSpace(request.IdpSigningCertificate))
        {
            if (!SamlCertificateHelper.TryParse(request.IdpSigningCertificate, out var parsedCertificate))
            {
                throw new ApiValidationException("Could not parse the IdP signing certificate. Paste the PEM block or base64 DER value your identity provider gave you.");
            }
            // Security review (Low/Informational finding): reject an expired/not-yet-valid/weak-key
            // certificate at save time rather than accepting it silently and only surfacing a
            // confusing failure the first time an assertion fails to verify against it.
            var healthIssue = SamlCertificateHelper.ValidateHealth(parsedCertificate!);
            if (healthIssue is not null)
            {
                throw new ApiValidationException(healthIssue);
            }
            cfg.IdpSigningCertificate = request.IdpSigningCertificate.Trim();
        }

        if (cfg.SamlEnabled && (string.IsNullOrEmpty(cfg.IdpSsoUrl) || string.IsNullOrEmpty(cfg.IdpSigningCertificate)))
        {
            throw new ApiValidationException("Enabling SAML requires an IdP SSO URL and signing certificate.");
        }
        if (cfg.RequireSso && !cfg.SamlEnabled)
        {
            throw new ApiValidationException("\"Require SSO\" needs SAML to be enabled and fully configured first.");
        }
        if (cfg.ScimEnabled && string.IsNullOrEmpty(cfg.ScimBearerTokenHash))
        {
            throw new ApiValidationException("Generate a SCIM bearer token before enabling SCIM provisioning.");
        }

        cfg.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return ToDto(organisationId, cfg);
    }

    /// <summary>
    /// Mints a new random bearer token, stores only its hash (same PasswordHasher bcrypt scheme as
    /// a user password), and returns the raw value — the one and only time it's ever retrievable.
    /// Generating a new token immediately invalidates whatever was issued before, same as rotating
    /// any other secret; there's no way to have two valid tokens at once in this design.
    /// </summary>
    public async Task<GenerateScimTokenResponse> GenerateScimTokenAsync(Guid organisationId)
    {
        var cfg = await _db.OrganisationSsoConfigs.FirstOrDefaultAsync(c => c.OrganisationId == organisationId);
        if (cfg is null)
        {
            cfg = new OrganisationSsoConfig { OrganisationId = organisationId };
            _db.OrganisationSsoConfigs.Add(cfg);
        }

        var rawToken = "scim_" + Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        cfg.ScimBearerTokenHash = PasswordHasher.Hash(rawToken);
        cfg.ScimTokenGeneratedAt = DateTime.UtcNow;
        cfg.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return new GenerateScimTokenResponse(rawToken);
    }

    private SsoConfigDto ToDto(Guid organisationId, OrganisationSsoConfig? cfg) => new(
        SamlEnabled: cfg?.SamlEnabled ?? false,
        IdpEntityId: cfg?.IdpEntityId,
        IdpSsoUrl: cfg?.IdpSsoUrl,
        HasIdpSigningCertificate: !string.IsNullOrEmpty(cfg?.IdpSigningCertificate),
        SamlJitProvisioning: cfg?.SamlJitProvisioning ?? false,
        RequireSso: cfg?.RequireSso ?? false,
        SpEntityId: _saml.SpEntityId(organisationId),
        SpAcsUrl: _saml.AcsUrl(organisationId),
        SpMetadataUrl: _saml.SpEntityId(organisationId),
        ScimEnabled: cfg?.ScimEnabled ?? false,
        HasScimToken: !string.IsNullOrEmpty(cfg?.ScimBearerTokenHash),
        ScimBaseUrl: ScimBaseUrl(organisationId));
}
