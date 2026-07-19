using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

// Every action here is a mutation (members are read via GET /api/projects/{id}'s own project-detail
// graph, not through this controller), so the whole class is Project-Admin-gated — "manage team
// members" is one of the four Project Administrator capabilities.
[ApiController]
[Authorize(Policy = "ProjectAdmin")]
[Route("api/projects/{projectId:guid}/members")]
public class MembersController : ControllerBase
{
    private readonly MemberService _members;

    public MembersController(MemberService members)
    {
        _members = members;
    }

    // "Add a team member" combobox's candidate list — see MemberService.GetOrgCandidatesAsync's doc
    // comment for why this is the whole org roster, not just this project's existing members.
    [HttpGet("org-candidates")]
    public async Task<IActionResult> GetOrgCandidates(Guid projectId)
    {
        var result = await _members.GetOrgCandidatesAsync(projectId);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, CreateMemberRequest request)
    {
        var result = await _members.CreateAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{memberId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid memberId, UpdateMemberRequest request)
    {
        var result = await _members.UpdateAsync(projectId, memberId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{memberId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid memberId)
    {
        return await _members.DeleteAsync(projectId, memberId) ? NoContent() : NotFound();
    }

    // "The project admin role can be assigned to users via the Team management tool" — Project-Admin
    // gated same as every other action here, so only an existing admin can promote/demote another
    // member (ApiValidationException from MemberService.SetProjectAdminAsync's last-admin guard maps
    // to 400 via Program.cs's global exception handler, same as every other manual validation check).
    [HttpPut("{memberId:guid}/admin")]
    public async Task<IActionResult> SetProjectAdmin(Guid projectId, Guid memberId, SetProjectAdminRequest request)
    {
        var result = await _members.SetProjectAdminAsync(projectId, memberId, request.IsProjectAdmin);
        return result is null ? NotFound() : Ok(result);
    }
}
