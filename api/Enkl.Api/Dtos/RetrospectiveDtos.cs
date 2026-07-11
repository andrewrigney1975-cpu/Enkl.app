namespace Enkl.Api.Dtos;

public record RetrospectiveItemDto(Guid Id, string Column, string Text, int SortOrder, Guid? PromotedPrincipleId);
public record RetrospectiveActionItemDto(Guid Id, string Text, Guid? AssigneeId, bool Completed, int SortOrder);

public record RetrospectiveDto(
    Guid Id, string Key, Guid? ReleaseId, string? Team, string? Background, DateOnly? RetroDate,
    int? LastTimerDurationSeconds, List<Guid> ParticipantIds,
    List<RetrospectiveItemDto> Items, List<RetrospectiveActionItemDto> ActionItems,
    DateTime DateCreated, DateTime DateLastModified);

public record CreateRetrospectiveRequest(Guid? ReleaseId, string? Team, string? Background, DateOnly? RetroDate, List<Guid>? ParticipantIds);
public record UpdateRetrospectiveRequest(Guid? ReleaseId, string? Team, string? Background, DateOnly? RetroDate, List<Guid>? ParticipantIds, int? LastTimerDurationSeconds);

public record CreateRetrospectiveItemRequest(string Column, string Text);
public record UpdateRetrospectiveItemRequest(string Column, string Text, int SortOrder);

public record CreateRetrospectiveActionItemRequest(string Text, Guid? AssigneeId);
public record UpdateRetrospectiveActionItemRequest(string Text, Guid? AssigneeId, bool Completed, int SortOrder);

/// <summary>Title/Description are pre-filled client-side from the item's own text, but always sent
/// explicitly (rather than defaulted server-side) so the user's edits in the promote dialog win.</summary>
public record PromoteRetrospectiveItemRequest(string Title, string? Description);
public record PromoteRetrospectiveItemResponseDto(PrincipleDto Principle, RetrospectiveItemDto Item);
