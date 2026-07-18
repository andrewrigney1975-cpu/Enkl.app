namespace Enkl.Api.Domain.Entities;

/// <summary>
/// One-per-Organisation public API key (OrganisationId is both PK and FK, a strict 1:1) — gates
/// PublicQueryController, the only endpoint any SavedQuery.ExposeViaApi=true row is reachable
/// through. Deliberately kept separate from OrganisationSsoConfig even though it's the same
/// "1:1 org settings row" shape — an org shouldn't need a SAML/SCIM config row to exist just to
/// generate an API key. Modeled directly on OrganisationSsoConfig's ScimBearerTokenHash pattern:
/// bcrypt hash via PasswordHasher, raw key shown to the OrgAdmin exactly once at generation time
/// and never persisted or retrievable again.
/// </summary>
public class OrganisationApiKey
{
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;

    public bool Enabled { get; set; }
    public string? KeyHash { get; set; }
    public DateTime? GeneratedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
}
