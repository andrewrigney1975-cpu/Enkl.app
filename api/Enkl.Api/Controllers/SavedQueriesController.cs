using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/saved-queries")]
public class SavedQueriesController : ControllerBase
{
    private readonly SavedQueryService _savedQueries;
    private readonly PublicQueryExecutionService _execution;

    public SavedQueriesController(SavedQueryService savedQueries, PublicQueryExecutionService execution)
    {
        _savedQueries = savedQueries;
        _execution = execution;
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, CreateSavedQueryRequest request)
    {
        var result = await _savedQueries.CreateAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{queryId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid queryId, CreateSavedQueryRequest request)
    {
        var result = await _savedQueries.UpdateAsync(projectId, queryId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{queryId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid queryId)
    {
        return await _savedQueries.DeleteAsync(projectId, queryId) ? NoContent() : NotFound();
    }

    /// <summary>
    /// "Test API (GET)" button (Advanced Query tab, next to an exposed saved query's public URL) —
    /// runs the SAME PublicQueryExecutionService code path PublicQueryController's real public
    /// endpoint uses, but authenticated by the caller's own project-member JWT instead of an org API
    /// key (the raw key isn't retrievable after generation, so there's no key for the frontend to
    /// actually send here — see SAVED-QUERY-API.md). Results are identical to what a real API caller
    /// with a valid key would see; this only changes how the caller authenticates, not what runs.
    /// </summary>
    [HttpGet("{queryId:guid}/test")]
    public async Task<IActionResult> Test(Guid projectId, Guid queryId, CancellationToken ct)
    {
        var sql = await _savedQueries.GetSqlAsync(projectId, queryId);
        if (sql is null) return NotFound();

        var result = await _execution.ExecuteAsync(projectId, sql, ct);
        return Ok(new { rows = result.Rows, truncated = result.Truncated });
    }
}
