using System.Security.Claims;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "ProjectMember")]
[Route("api/projects/{projectId:guid}/tasks")]
public class TasksController : ControllerBase
{
    private readonly TaskService _tasks;
    private readonly SseBroadcaster _broadcaster;

    public TasksController(TaskService tasks, SseBroadcaster broadcaster)
    {
        _tasks = tasks;
        _broadcaster = broadcaster;
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, CreateTaskRequest request)
    {
        var result = await _tasks.CreateAsync(projectId, request);
        if (result is null) return BadRequest(new { message = "Invalid column." });
        await BroadcastAsync(projectId, result, "created");
        return Ok(result);
    }

    [HttpPut("{taskId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid taskId, UpdateTaskRequest request)
    {
        var result = await _tasks.UpdateAsync(projectId, taskId, request);
        if (result is null) return NotFound();
        await BroadcastAsync(projectId, result, "updated");
        return Ok(result);
    }

    [HttpDelete("{taskId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid taskId)
    {
        // Grab the key/title before deleting so the "X was deleted" toast can still name it.
        var deleted = await _tasks.GetTaskSummaryAsync(projectId, taskId);
        if (!await _tasks.DeleteAsync(projectId, taskId)) return NotFound();
        if (deleted is not null) await BroadcastAsync(projectId, deleted.Value.TaskId, deleted.Value.Key, deleted.Value.Title, "deleted");
        return NoContent();
    }

    // Best-effort — a notification failure must never fail the mutation itself, so any exception here
    // (e.g. a momentarily broken connection registry) is swallowed rather than surfaced to the caller.
    private async Task BroadcastAsync(Guid projectId, TaskDto task, string changeType) =>
        await BroadcastAsync(projectId, task.Id, task.Key, task.Title, changeType);

    private async Task BroadcastAsync(Guid projectId, Guid taskId, string taskKey, string title, string changeType)
    {
        try
        {
            var memberUserIds = await _tasks.GetProjectMemberUserIdsAsync(projectId);
            var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier) ?? User.FindFirstValue("sub")!);
            var displayName = User.FindFirstValue("displayName") ?? "Someone";
            var clientSessionId = Request.Headers["X-Client-Session-Id"].FirstOrDefault();

            _broadcaster.BroadcastTaskChanged(
                memberUserIds,
                new TaskChangedEventDto(projectId, taskId, taskKey, title, changeType, userId, displayName),
                clientSessionId);
        }
        catch
        {
            // Notification is best-effort — the mutation already succeeded and was already returned/
            // will be returned to the caller regardless.
        }
    }
}
