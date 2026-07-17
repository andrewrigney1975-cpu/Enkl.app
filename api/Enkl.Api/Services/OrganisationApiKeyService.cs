using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// OrgAdmin-facing generate/revoke of the one-per-Organisation public API key that gates
/// PublicQueryController — same "rotate-only secret, shown once, bcrypt-hashed" shape as
/// OrganisationSsoConfigService's SCIM token, kept in its own table/service (not folded into SSO
/// config) since API keys are an unrelated concern.
/// </summary>
public class OrganisationApiKeyService
{
    private readonly AppDbContext _db;

    public OrganisationApiKeyService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<ApiKeyStatusDto> GetAsync(Guid organisationId)
    {
        var key = await _db.OrganisationApiKeys.AsNoTracking()
            .FirstOrDefaultAsync(k => k.OrganisationId == organisationId);
        return ToDto(key);
    }

    /// <summary>Mints a new random key, stores only its hash, and returns the raw value — the one
    /// and only time it's ever retrievable. Generating a new key immediately invalidates whatever
    /// was issued before (there's no way to have two valid keys at once), and re-enables the key if
    /// it was previously revoked.</summary>
    public async Task<GenerateApiKeyResponse> GenerateAsync(Guid organisationId)
    {
        var key = await _db.OrganisationApiKeys.FirstOrDefaultAsync(k => k.OrganisationId == organisationId);
        if (key is null)
        {
            key = new OrganisationApiKey { OrganisationId = organisationId };
            _db.OrganisationApiKeys.Add(key);
        }

        var rawKey = "enkl_key_" + Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        key.KeyHash = PasswordHasher.Hash(rawKey);
        key.GeneratedAt = DateTime.UtcNow;
        key.Enabled = true;
        await _db.SaveChangesAsync();

        return new GenerateApiKeyResponse(rawKey);
    }

    public async Task<ApiKeyStatusDto> RevokeAsync(Guid organisationId)
    {
        var key = await _db.OrganisationApiKeys.FirstOrDefaultAsync(k => k.OrganisationId == organisationId);
        if (key is not null)
        {
            // Soft-disable, row kept for audit — same shape as every other revoke path in this app.
            key.Enabled = false;
            await _db.SaveChangesAsync();
        }
        return ToDto(key);
    }

    private static ApiKeyStatusDto ToDto(OrganisationApiKey? key) => new(
        Enabled: key?.Enabled ?? false,
        HasApiKey: !string.IsNullOrEmpty(key?.KeyHash),
        GeneratedAt: key?.GeneratedAt,
        LastUsedAt: key?.LastUsedAt);
}
