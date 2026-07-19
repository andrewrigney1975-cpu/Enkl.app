namespace Enkl.Api.Dtos;

/// <summary>
/// Pushed over the SSE stream (Controllers/EventsController.cs) whenever a task is created, updated,
/// or deleted — mirrors the shape src/js/features/live-updates.js expects. ChangeType is one of
/// "created" | "updated" | "deleted".
/// </summary>
public record TaskChangedEventDto(
    Guid ProjectId, Guid TaskId, string TaskKey, string Title, string ChangeType,
    Guid ChangedByUserId, string ChangedByDisplayName);

/// <summary>
/// Pushed over the SSE stream whenever a chat message is posted, edited, or (soft-)deleted —
/// ChangeType is one of "created" | "updated" | "deleted", same convention as TaskChangedEventDto.
/// MentionedUserIds is the set of channel members @-tagged in this message (only meaningful on
/// "created"/"updated"); the frontend shows an extra highlighted alert to whichever recipient's own
/// user id appears in it, everyone else just sees the normal live-message update.
/// </summary>
public record ChatMessageEventDto(
    Guid ChannelId, Guid MessageId, string Text, string ChangeType,
    Guid? AuthorUserId, string AuthorName, DateTime DateCreated, bool IsDeleted,
    List<Guid> MentionedUserIds);
