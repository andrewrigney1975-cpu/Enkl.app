namespace Enkl.Api.Dtos;

/// <summary>
/// Minimal, safe-for-any-authenticated-org-user roster entry — deliberately NOT OrgUserDto (which
/// carries Username/EmailAddress/IsOrgAdmin/IsActive, admin-management-only fields behind
/// OrganisationsController's OrgAdmin policy). Used for the channel/DM member picker, @mention
/// autocomplete, and presence dots — anything a regular team member needs to see about colleagues.
/// </summary>
public record ChatOrgUserDto(Guid Id, string DisplayName, bool IsOnline);

public record ChatChannelMemberDto(Guid UserId, string DisplayName, bool IsOnline);

public record ChatChannelDto(
    Guid Id, string? Name, bool IsDirectMessage, DateTime DateCreated,
    List<ChatChannelMemberDto> Members);

/// <summary>Channels bucket into two lists rather than one flat list with an IsMember flag — Channels
/// is what the caller actually belongs to (the normal chat panel view); AdminVisibleChannels is only
/// ever populated for an Org Admin, the oversight-only "every other channel in the org" list.</summary>
public record ChatChannelListDto(List<ChatChannelDto> Channels, List<ChatChannelDto> AdminVisibleChannels);

public record CreateChatChannelRequest(string? Name, bool IsDirectMessage, List<Guid> MemberUserIds);

/// <summary>
/// Text is always the real, un-redacted message text — including for a deleted message — regardless
/// of the caller's role; IsDeleted/DateDeleted are what the FRONTEND uses to decide whether to show a
/// placeholder to a regular member or the real text behind an Org-Admin-only "reveal" toggle. There's
/// no security reason to hide already-authored chat text server-side (unlike, say, another org's
/// data), so this keeps one response shape for every caller rather than branching the DTO on role.
/// </summary>
public record ChatMessageDto(
    Guid Id, Guid ChannelId, Guid? AuthorUserId, string AuthorName, string Text,
    DateTime DateCreated, bool IsDeleted, DateTime? DateDeleted, List<Guid> MentionedUserIds);

public record ChatMessagePageDto(List<ChatMessageDto> Messages, DateTime? NextCursor);

public record PostChatMessageRequest(string Text);
public record UpdateChatMessageRequest(string Text);
public record AddChatChannelMemberRequest(Guid UserId);

public record ChatTruncateResultDto(int DeletedCount, DateTime CutoffDate);
