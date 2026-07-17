namespace Enkl.Api.Dtos;

/// <summary>Never echoes KeyHash — HasApiKey/LastUsedAt are the only signal the admin UI gets about
/// whether one is already configured, same convention as SsoConfigDto's HasScimToken.</summary>
public record ApiKeyStatusDto(bool Enabled, bool HasApiKey, DateTime? GeneratedAt, DateTime? LastUsedAt);

/// <summary>The raw key, shown to the OrgAdmin exactly once — see OrganisationApiKey.KeyHash's own
/// comment for why it's never retrievable again.</summary>
public record GenerateApiKeyResponse(string Key);
