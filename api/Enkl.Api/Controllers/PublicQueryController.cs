using Enkl.Api.Auth;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Enkl.Api.Controllers;

/// <summary>
/// The app's first public/3rd-party-facing API surface — deliberately namespaced and versioned
/// apart from the internal "api/..." routes every other controller uses, since those are only ever
/// consumed by this app's own frontend and can evolve freely, while this one is now a contract
/// external callers depend on directly.
///
/// [AllowAnonymous] because auth here is the org API key (ApiKeyAuthFilter), not a user JWT —
/// AddAuthentication()'s JwtBearer handler would otherwise run first and 401 a request that never
/// carried a JWT at all. See ApiKeyAuthFilter's own doc comment for the no-enumeration-oracle
/// contract every failure mode here follows.
/// </summary>
[ApiController]
[AllowAnonymous]
[EnableRateLimiting("public-query")]
[Route("api/public/v1/queries")]
public class PublicQueryController : ControllerBase
{
    private readonly PublicQueryExecutionService _execution;

    public PublicQueryController(PublicQueryExecutionService execution)
    {
        _execution = execution;
    }

    [HttpGet("{savedQueryId:guid}/results")]
    [TypeFilter(typeof(ApiKeyAuthFilter))]
    public async Task<IActionResult> GetResults(Guid savedQueryId, CancellationToken ct)
    {
        var query = (SavedQuery)HttpContext.Items[ApiKeyAuthFilter.SavedQueryItemKey]!;
        var result = await _execution.ExecuteAsync(query.ProjectId, query.Sql, ct);
        return Ok(new { rows = result.Rows, truncated = result.Truncated });
    }
}
