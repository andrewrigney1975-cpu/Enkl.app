using Enkl.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Auth;

/// <summary>
/// Gates PublicQueryController behind a static, per-Organisation bearer token — same shape as
/// ScimAuthFilter (not a user JWT, doesn't hook into AddAuthentication()/JwtBearer). Applied via
/// [TypeFilter(typeof(ApiKeyAuthFilter))] so it can take AppDbContext as a constructor dependency.
///
/// Every failure mode here — savedQueryId doesn't exist, the query exists but ExposeViaApi=false,
/// the key is missing/wrong/disabled, or the key belongs to a different org than the query's project
/// — returns the IDENTICAL 404, per this codebase's standing no-enumeration-oracle rule: a caller
/// must never be able to distinguish "this query id doesn't exist" from "it exists but isn't
/// exposed" or "your key doesn't grant access to it".
///
/// On success, the resolved SavedQuery is stashed in HttpContext.Items so PublicQueryController
/// doesn't need a second lookup.
/// </summary>
public class ApiKeyAuthFilter : IAsyncAuthorizationFilter
{
    public const string SavedQueryItemKey = "PublicQuery.SavedQuery";

    private readonly AppDbContext _db;

    public ApiKeyAuthFilter(AppDbContext db)
    {
        _db = db;
    }

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        if (!context.RouteData.Values.TryGetValue("savedQueryId", out var idValue) ||
            !Guid.TryParse(idValue?.ToString(), out var savedQueryId))
        {
            context.Result = NotFound();
            return;
        }

        var authHeader = context.HttpContext.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (!authHeader.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            context.Result = NotFound();
            return;
        }
        var apiKey = authHeader[prefix.Length..].Trim();
        if (apiKey.Length == 0)
        {
            context.Result = NotFound();
            return;
        }

        var query = await _db.SavedQueries.AsNoTracking()
            .Include(q => q.Project)
            .FirstOrDefaultAsync(q => q.Id == savedQueryId);
        if (query is not { ExposeViaApi: true })
        {
            context.Result = NotFound();
            return;
        }

        var organisationId = query.Project.OrganisationId;
        var orgKey = await _db.OrganisationApiKeys.AsNoTracking()
            .FirstOrDefaultAsync(k => k.OrganisationId == organisationId);
        if (orgKey is not { Enabled: true } || string.IsNullOrEmpty(orgKey.KeyHash) ||
            !PasswordHasher.Verify(apiKey, orgKey.KeyHash))
        {
            context.Result = NotFound();
            return;
        }

        // Lightweight usage audit trail, same convention/rationale as ScimTokenLastUsedAt.
        await _db.OrganisationApiKeys
            .Where(k => k.OrganisationId == organisationId)
            .ExecuteUpdateAsync(setters => setters.SetProperty(k => k.LastUsedAt, DateTime.UtcNow));

        context.HttpContext.Items[SavedQueryItemKey] = query;
    }

    private static NotFoundObjectResult NotFound() => new(new { message = "Not found." });
}
