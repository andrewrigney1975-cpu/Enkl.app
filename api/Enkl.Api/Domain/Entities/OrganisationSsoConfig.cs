namespace Enkl.Api.Domain.Entities;

/// <summary>
/// One-per-Organisation SAML/SCIM settings row (OrganisationId is both PK and FK, a strict 1:1).
/// SP entity id / ACS URL are deliberately NOT stored here — they're deterministic from
/// OrganisationId (see SamlController's routes) and rendered read-only in the admin UI instead of
/// being persisted, so there's nothing to keep in sync if the app's own hostname ever changes.
/// </summary>
public class OrganisationSsoConfig
{
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;

    public bool SamlEnabled { get; set; }
    public string? IdpEntityId { get; set; }
    public string? IdpSsoUrl { get; set; }
    public string? IdpSigningCertificate { get; set; }
    // Auto-create a User from an unrecognized SAML assertion's email rather than rejecting it —
    // off by default so an org relying on SCIM as its sole provisioning source doesn't get
    // surprise accounts from a SAML login alone. See AuthController/SamlController.
    public bool SamlJitProvisioning { get; set; }
    // Once true, AuthController.Login rejects password sign-in for every user in this
    // Organisation — off by default so enabling SAML never locks anyone out until the OrgAdmin
    // explicitly opts in after confirming SSO actually works.
    public bool RequireSso { get; set; }

    public bool ScimEnabled { get; set; }
    // Bcrypt hash via PasswordHasher, same as a user password — the raw token is shown to the
    // OrgAdmin exactly once at generation time and never persisted or retrievable again.
    public string? ScimBearerTokenHash { get; set; }
    public DateTime? ScimTokenGeneratedAt { get; set; }
    // Security review (Low/Informational finding): a rotate-only token otherwise had no usage
    // audit trail at all beyond its own generation time — this gives an OrgAdmin/support engineer
    // investigating suspected token compromise at least a coarse "is this IdP still actually
    // calling us" signal. Updated by ScimAuthFilter on every successful authentication.
    public DateTime? ScimTokenLastUsedAt { get; set; }

    public DateTime DateLastModified { get; set; }
}
