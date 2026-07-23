using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Enkl.Api.Controllers;

/// <summary>
/// v4 Phase 1 AI Assistant — [Authorize(Policy = "ProjectMember")] since it acts on one project's
/// tasks on the caller's behalf; no OrgAdmin gate (any project member can use it, same as the board
/// itself). See AiAssistantService's own doc comment for the tool-loop shape and security model.
/// [EnableRateLimiting("ai-assistant")] (Program.cs) caps per-caller spend, since each request can
/// fan out to several Claude API calls internally.
/// </summary>
[ApiController]
[Authorize(Policy = "ProjectMember")]
[EnableRateLimiting("ai-assistant")]
[Route("api/projects/{projectId:guid}/ai-assistant")]
public class AiAssistantController : ControllerBase
{
    private readonly AiAssistantService _assistant;

    public AiAssistantController(AiAssistantService assistant)
    {
        _assistant = assistant;
    }

    [HttpPost("chat")]
    public async Task<IActionResult> Chat(Guid projectId, AiAssistantChatRequest request)
    {
        var result = await _assistant.ChatAsync(projectId, request);
        return result is null ? NotFound() : Ok(result);
    }
}
