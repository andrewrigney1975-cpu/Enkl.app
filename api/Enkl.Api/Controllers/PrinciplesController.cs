using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/principles")]
public class PrinciplesController : ControllerBase
{
    private readonly PrincipleService _principles;

    public PrinciplesController(PrincipleService principles)
    {
        _principles = principles;
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, CreatePrincipleRequest request)
    {
        var result = await _principles.CreateAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{principleId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid principleId, UpdatePrincipleRequest request)
    {
        var result = await _principles.UpdateAsync(projectId, principleId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{principleId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid principleId)
    {
        return await _principles.DeleteAsync(projectId, principleId) ? NoContent() : NotFound();
    }

    [HttpPut("{principleId:guid}/share")]
    public async Task<IActionResult> Share(Guid projectId, Guid principleId, SharePrincipleRequest request)
    {
        var result = await _principles.ShareAsync(projectId, principleId, request);
        return result is null ? NotFound() : Ok(result);
    }
}
