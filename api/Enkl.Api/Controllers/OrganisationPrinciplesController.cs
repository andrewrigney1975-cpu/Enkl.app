using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Controllers;

/// <summary>
/// Any signed-in org member may browse the shared library (same trust level as TemplatesController's
/// list/read) — sharing itself is gated per-project via PrinciplesController.Share (ProjectMember
/// policy), not here. Copy is different: it WRITES a new Principle into a specific project, so
/// unlike the read-only endpoints above, it also requires the caller to actually be a member of the
/// target project (security review finding M9) — this route isn't under a {projectId} route segment
/// (TargetProjectId lives in the request body instead), so the usual [Authorize(Policy =
/// "ProjectMember")] route-based check (ProjectMemberAuthorizationHandler) can't apply here; a live
/// DB check (ARCHITECTURE-REVIEW.md finding 2.4 — see ProjectMemberAuthorizationHandler's own doc
/// comment for why a live check replaced the stale JWT "projects" claim) is done manually below
/// instead, same reasoning, just without a route-based handler to hook into.
/// </summary>
[ApiController]
[Authorize]
[Route("api/organisations/me/principles")]
public class OrganisationPrinciplesController : ControllerBase
{
    private readonly PrincipleService _principles;
    private readonly AppDbContext _db;

    public OrganisationPrinciplesController(PrincipleService principles, AppDbContext db)
    {
        _principles = principles;
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> ListWide()
    {
        return Ok(await _principles.ListOrganisationWideAsync(User.OrgId()));
    }

    [HttpGet("suggestions")]
    public async Task<IActionResult> Suggestions()
    {
        return Ok(await _principles.GetSuggestionsAsync(User.OrgId()));
    }

    [HttpPost("{principleId:guid}/copy")]
    public async Task<IActionResult> Copy(Guid principleId, CopyPrincipleRequest request)
    {
        if (!await CallerIsMemberOfAsync(request.TargetProjectId))
        {
            return Forbid();
        }

        var result = await _principles.CopyAsync(User.OrgId(), principleId, request);
        return result is null ? NotFound() : Ok(result);
    }

    private async Task<bool> CallerIsMemberOfAsync(Guid projectId) =>
        await _db.ProjectMembers.AsNoTracking().AnyAsync(m => m.ProjectId == projectId && m.UserId == User.UserId());
}
