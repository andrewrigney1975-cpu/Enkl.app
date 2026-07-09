using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/members")]
public class MembersController : ControllerBase
{
    private readonly MemberService _members;

    public MembersController(MemberService members)
    {
        _members = members;
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
}
