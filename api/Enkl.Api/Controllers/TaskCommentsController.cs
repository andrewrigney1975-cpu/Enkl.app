using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/tasks/{taskId:guid}/comments")]
public class TaskCommentsController : ControllerBase
{
    private readonly TaskCommentService _comments;

    public TaskCommentsController(TaskCommentService comments)
    {
        _comments = comments;
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, Guid taskId, CreateTaskCommentRequest request)
    {
        var result = await _comments.CreateAsync(User.UserId(), projectId, taskId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{commentId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid taskId, Guid commentId, UpdateTaskCommentRequest request)
    {
        var result = await _comments.UpdateAsync(User.UserId(), projectId, taskId, commentId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{commentId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid taskId, Guid commentId)
    {
        var callerClaimsOrgAdmin = User.HasClaim("orgAdmin", "true");
        var deleted = await _comments.DeleteAsync(User.UserId(), projectId, taskId, commentId, callerClaimsOrgAdmin, User.TryOrgId());
        return deleted ? NoContent() : NotFound();
    }
}
