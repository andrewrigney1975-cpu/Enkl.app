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

    // Same "no ProjectMember policy" reasoning as CreateProject above — this is the pre-creation
    // uniqueness check for the "New Project" flow, called before a project (and thus a projectId to
    // scope {projectId:guid}/key-availability below to) exists at all.
    [HttpGet("key-availability")]
    public async Task<IActionResult> CheckKeyAvailabilityForCreation([FromQuery] string key)
    {
        return Ok(await _projects.CheckKeyAvailabilityForCreationAsync(User.OrgId(), key));
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

    // Org-Admin-only: changing a project's key is restricted well above ordinary project editing
    // (ProjectMember above) — see ProjectService.ChangeKeyAsync's own doc comment for why.
    [HttpGet("{projectId:guid}/key-availability")]
    [Authorize(Policy = "OrgAdmin")]
    public async Task<IActionResult> CheckKeyAvailability(Guid projectId, [FromQuery] string key)
    {
        var result = await _projects.CheckKeyAvailabilityAsync(User.OrgId(), projectId, key);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{projectId:guid}/key")]
    [Authorize(Policy = "OrgAdmin")]
    public async Task<IActionResult> ChangeKey(Guid projectId, ChangeProjectKeyRequest request)
    {
        var result = await _projects.ChangeKeyAsync(User.OrgId(), projectId, request.NewKey);
        return result is null ? NotFound() : Ok(result);
    }

    // Project Administrator capability: "change app settings" — see ProjectAdminAuthorizationHandler.
    [HttpPut("{projectId:guid}/settings")]
    [Authorize(Policy = "ProjectAdmin")]
    public async Task<IActionResult> UpdateSettings(Guid projectId, ProjectSettingsDto request)
    {
        var result = await _projects.UpdateProjectSettingsAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    // Project Administrator capability: "manage workflow" — see ProjectAdminAuthorizationHandler.
    [HttpPut("{projectId:guid}/workflow")]
    [Authorize(Policy = "ProjectAdmin")]
    public async Task<IActionResult> UpdateWorkflow(Guid projectId, [FromBody] JsonElement request)
    {
        var result = await _projects.UpdateProjectWorkflowAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }
}
