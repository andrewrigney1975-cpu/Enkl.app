using System.Security.Claims;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Backs the Org-Admin-only Portfolio Dashboard — OrgAdmin policy ONLY, deliberately no
/// ProjectMember requirement, since an admin reviewing their organisation's portfolio may not
/// personally belong to every project in it. See PortfolioService's own doc comment for the
/// cross-org isolation guarantee every action here relies on: every project id is re-validated
/// against the caller's own OrganisationId before any data is touched.
/// </summary>
[ApiController]
[Authorize(Policy = "OrgAdmin")]
[Route("api/organisations/me/portfolio")]
public class PortfolioController : ControllerBase
{
    private readonly PortfolioService _portfolio;

    public PortfolioController(PortfolioService portfolio)
    {
        _portfolio = portfolio;
    }

    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects()
    {
        return Ok(await _portfolio.ListProjectsAsync(CallerOrgId()));
    }

    // GET (not POST) even though this returns a computed, possibly-large payload: it's a pure read
    // with no side effects, and using POST here would have tripped the global MustChangePassword gate
    // in Program.cs, which blocks every mutating (POST/PUT/PATCH/DELETE) request — wrongly barring a
    // freshly-migrated Org Admin (MustChangePassword defaults true) from ever opening the Portfolio
    // Dashboard until they changed their password, even though nothing here mutates anything.
    // projectIds is a single comma-joined string, not a repeated/indexed query param — see GetActivity
    // below for why.
    [HttpGet("aggregate")]
    public async Task<IActionResult> GetAggregate([FromQuery] string? projectIds)
    {
        return Ok(await _portfolio.GetAggregateAsync(CallerOrgId(), ParseProjectIds(projectIds)));
    }

    // projectIds is a single comma-joined string, not a repeated/indexed query param — ASP.NET Core
    // and Slim/PHP parse repeated-key or bracketed array query strings differently, and the frontend
    // (api.js) talks to either tier with zero changes, so a plain comma-joined value sidesteps that
    // entirely instead of relying on either framework's array-binding conventions matching the other.
    [HttpGet("activity")]
    public async Task<IActionResult> GetActivity([FromQuery] string? projectIds, [FromQuery] DateOnly start, [FromQuery] DateOnly end)
    {
        return Ok(await _portfolio.GetActivityAsync(CallerOrgId(), ParseProjectIds(projectIds), start, end));
    }

    private static List<Guid> ParseProjectIds(string? projectIds) =>
        (projectIds ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => Guid.TryParse(s, out var g) ? g : (Guid?)null)
            .Where(g => g.HasValue)
            .Select(g => g!.Value)
            .ToList();

    private Guid CallerOrgId() => Guid.Parse(User.FindFirstValue("orgId")!);
}
