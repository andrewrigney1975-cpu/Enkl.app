using System.Security.Claims;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Any signed-in org member may browse/copy the shared library (same trust level as
/// TemplatesController's list/read) — sharing itself is gated per-project via
/// PrinciplesController.Share (ProjectMember policy), not here.
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
        var result = await _principles.CopyAsync(CallerOrgId(), principleId, request);
        return result is null ? NotFound() : Ok(result);
    }

    private Guid CallerOrgId() => Guid.Parse(User.FindFirstValue("orgId")!);
}
