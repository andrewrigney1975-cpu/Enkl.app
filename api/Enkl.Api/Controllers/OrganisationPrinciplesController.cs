using System.Security.Claims;
using System.Text.Json;
using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Any signed-in org member may browse the shared library (same trust level as TemplatesController's
/// list/read) — sharing itself is gated per-project via PrinciplesController.Share (ProjectMember
/// policy), not here. Copy is different: it WRITES a new Principle into a specific project, so
/// unlike the read-only endpoints above, it also requires the caller to actually be a member of the
/// target project (security review finding M9) — this route isn't under a {projectId} route segment
/// (TargetProjectId lives in the request body instead), so the usual [Authorize(Policy =
/// "ProjectMember")] route-based check (ProjectMemberAuthorizationHandler) can't apply here; the
/// same "projects" JWT claim it reads is checked manually below instead.
/// </summary>
[ApiController]
[Authorize]
[Route("api/organisations/me/principles")]
public class OrganisationPrinciplesController : ControllerBase
{
    private readonly PrincipleService _principles;

    public OrganisationPrinciplesController(PrincipleService principles)
    {
        _principles = principles;
    }

    [HttpGet]
    public async Task<IActionResult> ListWide()
    {
        return Ok(await _principles.ListOrganisationWideAsync(CallerOrgId()));
    }

    [HttpGet("suggestions")]
    public async Task<IActionResult> Suggestions()
    {
        return Ok(await _principles.GetSuggestionsAsync(CallerOrgId()));
    }

    [HttpPost("{principleId:guid}/copy")]
    public async Task<IActionResult> Copy(Guid principleId, CopyPrincipleRequest request)
    {
        if (!CallerIsMemberOf(request.TargetProjectId))
        {
            return Forbid();
        }

        var result = await _principles.CopyAsync(CallerOrgId(), principleId, request);
        return result is null ? NotFound() : Ok(result);
    }

    private Guid CallerOrgId() => Guid.Parse(User.FindFirstValue("orgId")!);

    private bool CallerIsMemberOf(Guid projectId)
    {
        var projectsClaim = User.FindFirst("projects")?.Value;
        if (projectsClaim is null) return false;

        var memberships = JsonSerializer.Deserialize<List<ProjectClaim>>(projectsClaim) ?? new();
        return memberships.Any(m => m.ProjectId == projectId);
    }
}
