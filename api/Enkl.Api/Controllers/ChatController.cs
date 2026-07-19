using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Org-wide chat — [Authorize] only at class level (no ProjectMember/OrgAdmin policy), since every
/// org user can create channels/DMs and post messages; only the Truncate action below is further
/// restricted per-method to OrgAdmin. Mirrors TaskCommentsController's hand-spelled-routes shape
/// (nested under a specific resource, not a generic per-project entity helper) since this is also a
/// cross-cutting, non-generic pattern.
/// </summary>
[ApiController]
[Authorize]
[Route("api/chat")]
public class ChatController : ControllerBase
{
    private readonly ChatService _chat;
    private readonly SseBroadcaster _broadcaster;

    public ChatController(ChatService chat, SseBroadcaster broadcaster)
    {
        _chat = chat;
        _broadcaster = broadcaster;
    }

    private bool CallerIsOrgAdmin => User.HasClaim("orgAdmin", "true");
    private string CallerDisplayName => User.FindFirst("displayName")?.Value ?? "Someone";

    [HttpGet("org-users")]
    public async Task<IActionResult> GetOrgRoster()
    {
        return Ok(await _chat.GetOrgRosterAsync(User.OrgId()));
    }

    [HttpGet("channels")]
    public async Task<IActionResult> ListChannels()
    {
        return Ok(await _chat.ListChannelsAsync(User.OrgId(), User.UserId(), CallerIsOrgAdmin));
    }

    [HttpPost("channels")]
    public async Task<IActionResult> CreateChannel(CreateChatChannelRequest request)
    {
        var result = await _chat.CreateChannelAsync(User.OrgId(), User.UserId(), CallerDisplayName, request);
        return Ok(result);
    }

    [HttpPost("channels/{channelId:guid}/members")]
    public async Task<IActionResult> AddMember(Guid channelId, AddChatChannelMemberRequest request)
    {
        var ok = await _chat.AddMemberAsync(User.OrgId(), User.UserId(), CallerIsOrgAdmin, channelId, request.UserId);
        return ok ? NoContent() : NotFound();
    }

    [HttpDelete("channels/{channelId:guid}/members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid channelId, Guid userId)
    {
        var ok = await _chat.RemoveMemberAsync(User.OrgId(), User.UserId(), CallerIsOrgAdmin, channelId, userId);
        return ok ? NoContent() : NotFound();
    }

    [HttpGet("channels/{channelId:guid}/messages")]
    public async Task<IActionResult> GetMessages(Guid channelId, [FromQuery] DateTime? before, [FromQuery] int limit = 50)
    {
        var result = await _chat.GetMessagesAsync(User.OrgId(), User.UserId(), CallerIsOrgAdmin, channelId, before, limit);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPost("channels/{channelId:guid}/messages")]
    public async Task<IActionResult> PostMessage(Guid channelId, PostChatMessageRequest request)
    {
        var result = await _chat.PostMessageAsync(User.OrgId(), User.UserId(), CallerDisplayName, channelId, request);
        if (result is null) return NotFound();
        await BroadcastAsync(channelId, result.Value.Message, result.Value.ChannelMemberUserIds, "created");
        return Ok(result.Value.Message);
    }

    [HttpPut("channels/{channelId:guid}/messages/{messageId:guid}")]
    public async Task<IActionResult> UpdateMessage(Guid channelId, Guid messageId, UpdateChatMessageRequest request)
    {
        var result = await _chat.UpdateMessageAsync(User.UserId(), channelId, messageId, request);
        if (result is null) return NotFound();
        await BroadcastAsync(channelId, result.Value.Message, result.Value.ChannelMemberUserIds, "updated");
        return Ok(result.Value.Message);
    }

    [HttpDelete("channels/{channelId:guid}/messages/{messageId:guid}")]
    public async Task<IActionResult> DeleteMessage(Guid channelId, Guid messageId)
    {
        var result = await _chat.DeleteMessageAsync(User.OrgId(), User.UserId(), CallerIsOrgAdmin, channelId, messageId);
        if (result is null) return NotFound();
        await BroadcastAsync(channelId, result.Value.Message, result.Value.ChannelMemberUserIds, "deleted");
        return Ok(result.Value.Message);
    }

    // Org-Admin-only manual replacement for a scheduled 180-day purge (see ChatService.TruncateOldMessagesAsync's
    // own doc comment) — hard-deletes, no confirmation beyond the frontend's own confirm dialog.
    [HttpPost("truncate")]
    [Authorize(Policy = "OrgAdmin")]
    public async Task<IActionResult> Truncate()
    {
        return Ok(await _chat.TruncateOldMessagesAsync(User.OrgId()));
    }

    // Best-effort — a notification failure must never fail the mutation itself (same convention as
    // TasksController.BroadcastAsync).
    private async Task BroadcastAsync(Guid channelId, ChatMessageDto message, List<Guid> channelMemberUserIds, string changeType)
    {
        try
        {
            var clientSessionId = Request.Headers["X-Client-Session-Id"].FirstOrDefault();
            _broadcaster.BroadcastChatMessage(
                channelMemberUserIds,
                new ChatMessageEventDto(channelId, message.Id, message.Text, changeType, message.AuthorUserId, message.AuthorName, message.DateCreated, message.IsDeleted, message.MentionedUserIds),
                clientSessionId);
        }
        catch
        {
            // best-effort, see comment above
        }
    }
}
