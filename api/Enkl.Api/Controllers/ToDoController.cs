using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Per-User resource, not per-Project/per-Organisation — plain [Authorize] with no Policy, same
/// gating as AuthController.ChangePassword (see that controller's own routing). Every action is
/// scoped by the caller's own userId; there's no {projectId}/{orgId} route segment anywhere here.
/// </summary>
[ApiController]
[Authorize]
[Route("api/todo-lists")]
public class ToDoController : ControllerBase
{
    private readonly ToDoService _todo;

    public ToDoController(ToDoService todo)
    {
        _todo = todo;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        return Ok(await _todo.ListAsync(User.UserId()));
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateToDoListRequest request)
    {
        return Ok(await _todo.CreateListAsync(User.UserId(), request));
    }

    [HttpPut("{listId:guid}")]
    public async Task<IActionResult> Rename(Guid listId, UpdateToDoListRequest request)
    {
        var result = await _todo.RenameListAsync(User.UserId(), listId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{listId:guid}")]
    public async Task<IActionResult> Delete(Guid listId)
    {
        return await _todo.DeleteListAsync(User.UserId(), listId) ? NoContent() : NotFound();
    }

    [HttpPost("{listId:guid}/items")]
    public async Task<IActionResult> CreateItem(Guid listId, CreateToDoItemRequest request)
    {
        var result = await _todo.CreateItemAsync(User.UserId(), listId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("{listId:guid}/items/{itemId:guid}")]
    public async Task<IActionResult> UpdateItem(Guid listId, Guid itemId, UpdateToDoItemRequest request)
    {
        var result = await _todo.UpdateItemAsync(User.UserId(), listId, itemId, request);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpDelete("{listId:guid}/items/{itemId:guid}")]
    public async Task<IActionResult> DeleteItem(Guid listId, Guid itemId)
    {
        return await _todo.DeleteItemAsync(User.UserId(), listId, itemId) ? NoContent() : NotFound();
    }
}
