using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Org-Admin-only management of the calling org's own Announcements/Disruption Notices — mirrors
/// PortfolioController's shape (a dedicated controller nested under api/organisations/me, rather than
/// a method on OrganisationsController) since this is its own distinct CRUD surface. Every write is
/// always Scope="org" + OrganisationId/CreatedByUserId re-derived from User.OrgId()/User.UserId(),
/// never client-supplied — see AnnouncementService's own doc comment.
/// </summary>
[ApiController]
[Authorize(Policy = "OrgAdmin")]
[Route("api/organisations/me/announcements")]
public class OrganisationAnnouncementsController : ControllerBase
{
    private readonly AnnouncementService _announcements;

    public OrganisationAnnouncementsController(AnnouncementService announcements)
    {
        _announcements = announcements;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        return Ok(await _announcements.ListForOrgAsync(User.OrgId()));
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateAnnouncementRequest request)
    {
        return Ok(await _announcements.CreateAsync(User.OrgId(), User.UserId(), request));
    }

    [HttpPut("{announcementId:guid}")]
    public async Task<IActionResult> Update(Guid announcementId, UpdateAnnouncementRequest request)
    {
        var result = await _announcements.UpdateAsync(User.OrgId(), announcementId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{announcementId:guid}")]
    public async Task<IActionResult> Delete(Guid announcementId)
    {
        var deleted = await _announcements.DeleteAsync(User.OrgId(), announcementId);
        return deleted ? NoContent() : NotFound();
    }
}
