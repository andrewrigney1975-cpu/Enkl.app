using Enkl.Api.Auth;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Any authenticated user (no OrgAdmin/ProjectMember policy) — reading "what's currently relevant to
/// me" and acknowledging one you've seen are things every signed-in user can do, not an admin-only
/// action. See OrganisationAnnouncementsController for the Org-Admin-only CRUD management surface.
/// </summary>
[ApiController]
[Authorize]
[Route("api/announcements")]
public class AnnouncementsController : ControllerBase
{
    private readonly AnnouncementService _announcements;

    public AnnouncementsController(AnnouncementService announcements)
    {
        _announcements = announcements;
    }

    [HttpGet("active")]
    public async Task<IActionResult> GetActive()
    {
        return Ok(await _announcements.GetActiveForUserAsync(User.OrgId(), User.UserId()));
    }

    [HttpPost("{announcementId:guid}/acknowledge")]
    public async Task<IActionResult> Acknowledge(Guid announcementId)
    {
        await _announcements.AcknowledgeAsync(User.UserId(), announcementId);
        return NoContent();
    }
}
