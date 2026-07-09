namespace Enkl.Api.Dtos;

/// <summary>
/// Pushed over the SSE stream (Controllers/EventsController.cs) whenever a task is created, updated,
/// or deleted — mirrors the shape src/js/features/live-updates.js expects. ChangeType is one of
/// "created" | "updated" | "deleted".
/// </summary>
public record TaskChangedEventDto(
    Guid ProjectId, Guid TaskId, string TaskKey, string Title, string ChangeType,
    Guid ChangedByUserId, string ChangedByDisplayName);
