using Enkl.Api.Auth;
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
    private readonly PortfolioCategoryService _categories;
    private readonly PortfolioResourceService _resources;

    public PortfolioController(PortfolioService portfolio, PortfolioCategoryService categories, PortfolioResourceService resources)
    {
        _portfolio = portfolio;
        _categories = categories;
        _resources = resources;
    }

    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects()
    {
        return Ok(await _portfolio.ListProjectsAsync(User.OrgId()));
    }

    // A genuine mutation (creates a row), so this stays POST — unlike ListProjects/GetAggregate/
    // GetActivity above, there's no read-with-side-effects tension here to work around.
    [HttpPost("projects")]
    public async Task<IActionResult> CreateProject(CreatePortfolioProjectRequest request)
    {
        return Ok(await _portfolio.CreateProjectAsync(User.OrgId(), request));
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
        return Ok(await _portfolio.GetAggregateAsync(User.OrgId(), ParseProjectIds(projectIds)));
    }

    // projectIds is a single comma-joined string, not a repeated/indexed query param — ASP.NET Core
    // and Slim/PHP parse repeated-key or bracketed array query strings differently, and the frontend
    // (api.js) talks to either tier with zero changes, so a plain comma-joined value sidesteps that
    // entirely instead of relying on either framework's array-binding conventions matching the other.
    [HttpGet("activity")]
    public async Task<IActionResult> GetActivity([FromQuery] string? projectIds, [FromQuery] DateOnly start, [FromQuery] DateOnly end)
    {
        return Ok(await _portfolio.GetActivityAsync(User.OrgId(), ParseProjectIds(projectIds), start, end));
    }

    // A genuine mutation (unlike GetAggregate/GetActivity above), so this deliberately stays PUT —
    // it's meant to trip the global MustChangePassword gate in Program.cs like any other write.
    [HttpPut("projects/{projectId:guid}/dates")]
    public async Task<IActionResult> UpdateProjectDates(Guid projectId, UpdatePortfolioProjectDatesRequest request)
    {
        var updated = await _portfolio.UpdateProjectDatesAsync(User.OrgId(), projectId, request.StartDate, request.EndDate);
        if (!updated) return NotFound();
        return NoContent();
    }

    [HttpPut("projects/{projectId:guid}/active")]
    public async Task<IActionResult> UpdateProjectActive(Guid projectId, UpdatePortfolioProjectActiveRequest request)
    {
        var result = await _portfolio.UpdateProjectActiveAsync(User.OrgId(), projectId, request.IsActive);
        return result switch
        {
            PortfolioActivationResult.NotFound => NotFound(),
            PortfolioActivationResult.MissingDates => BadRequest(new { message = "A project must have both a start and end date before it can be activated." }),
            _ => NoContent()
        };
    }

    [HttpPut("projects/{projectId:guid}/category")]
    public async Task<IActionResult> UpdateProjectCategory(Guid projectId, UpdatePortfolioProjectCategoryRequest request)
    {
        var updated = await _portfolio.UpdateProjectCategoryAsync(User.OrgId(), projectId, request.CategoryId);
        if (!updated) return NotFound();
        return NoContent();
    }

    [HttpGet("categories")]
    public async Task<IActionResult> ListCategories()
    {
        return Ok(await _categories.ListCategoriesAsync(User.OrgId()));
    }

    [HttpPost("categories")]
    public async Task<IActionResult> CreateCategory(CreatePortfolioCategoryRequest request)
    {
        return Ok(await _categories.CreateCategoryAsync(User.OrgId(), request.Name));
    }

    [HttpPut("categories/{categoryId:guid}")]
    public async Task<IActionResult> UpdateCategory(Guid categoryId, UpdatePortfolioCategoryRequest request)
    {
        var updated = await _categories.UpdateCategoryAsync(User.OrgId(), categoryId, request.Name);
        if (updated is null) return NotFound();
        return Ok(updated);
    }

    [HttpDelete("categories/{categoryId:guid}")]
    public async Task<IActionResult> DeleteCategory(Guid categoryId)
    {
        var deleted = await _categories.DeleteCategoryAsync(User.OrgId(), categoryId);
        if (!deleted) return NotFound();
        return NoContent();
    }

    [HttpPut("categories/{categoryId:guid}/sort-order")]
    public async Task<IActionResult> UpdateCategorySortOrder(Guid categoryId, UpdatePortfolioCategorySortOrderRequest request)
    {
        var updated = await _categories.UpdateCategorySortOrderAsync(User.OrgId(), categoryId, request.SortOrder);
        if (!updated) return NotFound();
        return NoContent();
    }

    [HttpGet("projects/{projectId:guid}/resources")]
    public async Task<IActionResult> ListResources(Guid projectId)
    {
        var resources = await _resources.ListResourcesAsync(User.OrgId(), projectId);
        return resources is null ? NotFound() : Ok(resources);
    }

    [HttpPost("projects/{projectId:guid}/resources")]
    public async Task<IActionResult> AddResource(Guid projectId, CreateProjectResourcePlaceholderRequest request)
    {
        var resource = await _resources.AddResourceAsync(User.OrgId(), projectId, request);
        return resource is null ? NotFound() : Ok(resource);
    }

    [HttpPut("projects/{projectId:guid}/resources/{resourceId:guid}")]
    public async Task<IActionResult> UpdateResource(Guid projectId, Guid resourceId, UpdateProjectResourcePlaceholderRequest request)
    {
        var resource = await _resources.UpdateResourceAsync(User.OrgId(), projectId, resourceId, request);
        return resource is null ? NotFound() : Ok(resource);
    }

    [HttpDelete("projects/{projectId:guid}/resources/{resourceId:guid}")]
    public async Task<IActionResult> RemoveResource(Guid projectId, Guid resourceId)
    {
        var removed = await _resources.RemoveResourceAsync(User.OrgId(), projectId, resourceId);
        return removed ? NoContent() : NotFound();
    }

    [HttpGet("roles")]
    public async Task<IActionResult> ListRoles()
    {
        return Ok(await _resources.ListDistinctRolesAsync(User.OrgId()));
    }

    // GET, not POST — a pure read with no side effects, same MustChangePassword-gate-avoidance
    // reasoning as GetAggregate/GetActivity above. Deliberately takes no project ids at all — see
    // PortfolioResourceService.GetResourcingSummaryAsync's doc comment for why this is org-wide.
    [HttpGet("resourcing")]
    public async Task<IActionResult> GetResourcingSummary()
    {
        return Ok(await _resources.GetResourcingSummaryAsync(User.OrgId()));
    }

    private static List<Guid> ParseProjectIds(string? projectIds) =>
        (projectIds ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => Guid.TryParse(s, out var g) ? g : (Guid?)null)
            .Where(g => g.HasValue)
            .Select(g => g!.Value)
            .ToList();
}
