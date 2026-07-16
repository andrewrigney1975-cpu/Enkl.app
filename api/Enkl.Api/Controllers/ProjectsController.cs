using System.Text.Json;
using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/projects")]
public class ProjectsController : ControllerBase
{
    private readonly ProjectService _projects;

    public ProjectsController(ProjectService projects)
    {
        _projects = projects;
    }

    [HttpGet]
    public async Task<IActionResult> GetProjects()
    {
        var userId = User.UserId();
        return Ok(await _projects.GetProjectsForUserAsync(userId));
    }

    [HttpGet("{projectId:guid}")]
    [Authorize(Policy = "ProjectMember")]
    public async Task<IActionResult> GetProject(Guid projectId)
    {
        var detail = await _projects.GetProjectDetailAsync(projectId);
        return detail is null ? NotFound() : Ok(detail);
    }

    // No ProjectMember policy — the project doesn't exist yet, so there's nothing for that policy to
    // check against. Any authenticated user may create a project under their own Organisation.
    [HttpPost]
    public async Task<IActionResult> CreateProject(CreateProjectRequest request)
    {
        var userId = User.UserId();
        var result = await _projects.CreateAsync(userId, request);
        return result is null ? Unauthorized() : Ok(result);
    }

    [HttpPut("{projectId:guid}")]
    [Authorize(Policy = "ProjectMember")]
    public async Task<IActionResult> UpdateProject(Guid projectId, UpdateProjectRequest request)
    {
        var result = await _projects.UpdateAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{projectId:guid}")]
    [Authorize(Policy = "ProjectMember")]
    public async Task<IActionResult> DeleteProject(Guid projectId)
    {
        return await _projects.DeleteAsync(projectId) ? NoContent() : NotFound();
    }

    [HttpPut("{projectId:guid}/settings")]
    [Authorize(Policy = "ProjectMember")]
    public async Task<IActionResult> UpdateSettings(Guid projectId, ProjectSettingsDto request)
    {
        var result = await _projects.UpdateProjectSettingsAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{projectId:guid}/workflow")]
    [Authorize(Policy = "ProjectMember")]
    public async Task<IActionResult> UpdateWorkflow(Guid projectId, [FromBody] JsonElement request)
    {
        var result = await _projects.UpdateProjectWorkflowAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }
}
