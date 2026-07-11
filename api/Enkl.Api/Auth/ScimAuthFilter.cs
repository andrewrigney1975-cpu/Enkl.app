using Enkl.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Auth;

/// <summary>
/// Gates every SCIM action behind a static, per-Organisation bearer token — not a user JWT, so this
/// deliberately doesn't hook into the app's AddAuthentication()/JwtBearer chain at all (no existing
/// mechanism to extend: confirmed during planning that no ApiKey/service-account pattern exists
/// anywhere else in the codebase). Applied via [TypeFilter(typeof(ScimAuthFilter))] so it can take
/// AppDbContext (a scoped service) as a constructor dependency, which a plain attribute can't do.
/// Every response here uses the SCIM error envelope (see ScimDtos.cs's ScimError), not the app's
/// usual {message} shape, since these responses are read by SCIM clients, not this app's own UI.
/// </summary>
public class ScimAuthFilter : IAsyncAuthorizationFilter
{
    private readonly AppDbContext _db;

    public ScimAuthFilter(AppDbContext db)
    {
        _db = db;
    }

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        if (!context.RouteData.Values.TryGetValue("orgId", out var orgIdValue) ||
            !Guid.TryParse(orgIdValue?.ToString(), out var orgId))
        {
            context.Result = ScimResult(404, "Organisation not found.");
            return;
        }

        var authHeader = context.HttpContext.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (!authHeader.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            context.Result = ScimResult(401, "Missing bearer token.");
            return;
        }
        var token = authHeader[prefix.Length..].Trim();
        if (token.Length == 0)
        {
            context.Result = ScimResult(401, "Missing bearer token.");
            return;
        }

        var cfg = await _db.OrganisationSsoConfigs.AsNoTracking()
            .FirstOrDefaultAsync(c => c.OrganisationId == orgId);
        if (cfg is not { ScimEnabled: true } || string.IsNullOrEmpty(cfg.ScimBearerTokenHash) ||
            !PasswordHasher.Verify(token, cfg.ScimBearerTokenHash))
        {
            context.Result = ScimResult(401, "Invalid bearer token.");
            return;
        }

        // Security review (Low/Informational finding): usage audit trail for a rotate-only token.
        // ExecuteUpdateAsync (a bulk update, no tracked entity needed) rather than loading `cfg`
        // trackable and calling SaveChangesAsync — cfg above is AsNoTracking() by design (a
        // read-only auth check shouldn't otherwise pay for change-tracking), so this stays a single
        // targeted UPDATE instead of a second full row load.
        await _db.OrganisationSsoConfigs
            .Where(c => c.OrganisationId == orgId)
            .ExecuteUpdateAsync(setters => setters.SetProperty(c => c.ScimTokenLastUsedAt, DateTime.UtcNow));
    }

    private static ObjectResult ScimResult(int status, string detail) => new(new
    {
        schemas = new[] { "urn:ietf:params:scim:api:messages:2.0:Error" },
        status = status.ToString(),
        detail
    })
    { StatusCode = status };
}
