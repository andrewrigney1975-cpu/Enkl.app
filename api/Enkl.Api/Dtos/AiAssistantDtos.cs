namespace Enkl.Api.Dtos;

/// <summary>One turn of the AI assistant conversation. Role is "user" or "assistant" — the frontend
/// keeps the running transcript client-side (v4 Phase 1 is stateless server-side, no persisted
/// AiAssistantMessage table yet) and resends it each call, same shape as any simple chat UI.</summary>
public record AiAssistantChatMessageDto(string Role, string Content);

/// <summary>AlertsSummary is computed client-side by session-alerts.js's summarizeProjectAlerts() and
/// passed through as plain text context — deliberately not re-derived server-side, since that logic
/// is already correct and tested on the frontend and duplicating it here would be a second copy to
/// keep in sync for no benefit (see root CLAUDE.md §1's duplication principle).</summary>
public record AiAssistantChatRequest(List<AiAssistantChatMessageDto> Messages, string? AlertsSummary);

/// <summary>A tool call the assistant actually executed, surfaced to the frontend so it can show
/// "created TASK-42" style confirmation chips and refresh the board — not just the reply text.</summary>
public record AiAssistantActionDto(string Type, Guid? TaskId, string? TaskKey, string? Title);

public record AiAssistantChatResponse(string Reply, List<AiAssistantActionDto> Actions);
