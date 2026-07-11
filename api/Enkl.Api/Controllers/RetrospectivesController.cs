using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/retrospectives")]
public class RetrospectivesController : ControllerBase
{
    private readonly RetrospectiveService _retrospectives;

    public RetrospectivesController(RetrospectiveService retrospectives)
    {
        _retrospectives = retrospectives;
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, CreateRetrospectiveRequest request)
    {
        var result = await _retrospectives.CreateAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{retrospectiveId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid retrospectiveId, UpdateRetrospectiveRequest request)
    {
        var result = await _retrospectives.UpdateAsync(projectId, retrospectiveId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{retrospectiveId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid retrospectiveId)
    {
        return await _retrospectives.DeleteAsync(projectId, retrospectiveId) ? NoContent() : NotFound();
    }

    [HttpPost("{retrospectiveId:guid}/items")]
    public async Task<IActionResult> CreateItem(Guid projectId, Guid retrospectiveId, CreateRetrospectiveItemRequest request)
    {
        var result = await _retrospectives.CreateItemAsync(projectId, retrospectiveId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{retrospectiveId:guid}/items/{itemId:guid}")]
    public async Task<IActionResult> UpdateItem(Guid projectId, Guid retrospectiveId, Guid itemId, UpdateRetrospectiveItemRequest request)
    {
        var result = await _retrospectives.UpdateItemAsync(projectId, retrospectiveId, itemId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{retrospectiveId:guid}/items/{itemId:guid}")]
    public async Task<IActionResult> DeleteItem(Guid projectId, Guid retrospectiveId, Guid itemId)
    {
        return await _retrospectives.DeleteItemAsync(projectId, retrospectiveId, itemId) ? NoContent() : NotFound();
    }

    [HttpPost("{retrospectiveId:guid}/items/{itemId:guid}/promote")]
    public async Task<IActionResult> PromoteItem(Guid projectId, Guid retrospectiveId, Guid itemId, PromoteRetrospectiveItemRequest request)
    {
        var result = await _retrospectives.PromoteItemAsync(projectId, retrospectiveId, itemId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPost("{retrospectiveId:guid}/action-items")]
    public async Task<IActionResult> CreateActionItem(Guid projectId, Guid retrospectiveId, CreateRetrospectiveActionItemRequest request)
    {
        var result = await _retrospectives.CreateActionItemAsync(projectId, retrospectiveId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{retrospectiveId:guid}/action-items/{itemId:guid}")]
    public async Task<IActionResult> UpdateActionItem(Guid projectId, Guid retrospectiveId, Guid itemId, UpdateRetrospectiveActionItemRequest request)
    {
        var result = await _retrospectives.UpdateActionItemAsync(projectId, retrospectiveId, itemId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{retrospectiveId:guid}/action-items/{itemId:guid}")]
    public async Task<IActionResult> DeleteActionItem(Guid projectId, Guid retrospectiveId, Guid itemId)
    {
        return await _retrospectives.DeleteActionItemAsync(projectId, retrospectiveId, itemId) ? NoContent() : NotFound();
    }
}
