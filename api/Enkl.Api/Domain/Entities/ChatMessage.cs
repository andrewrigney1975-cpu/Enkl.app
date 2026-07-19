namespace Enkl.Api.Domain.Entities;

/// <summary>
/// A chat message — same author-snapshot shape as TaskComment (AuthorUserId is a live FK, nullable
/// ON DELETE SET NULL, used to enforce "only the author can edit/delete"; AuthorName is a
/// display-name snapshot taken at post time, so a message stays attributable even after its author
/// leaves the org or is later renamed). Unlike TaskComment, delete is a SOFT delete (IsDeleted +
/// DateDeleted) rather than a real row removal — deleted messages must stay in the DB, per the
/// retention requirement, and are only permanently removed by the Org-Admin-only Truncate action once
/// they're older than 180 days (regardless of IsDeleted). No "edited" flag/timestamp — editing Text
/// happens silently in place, matching TaskComment's own convention exactly.
/// </summary>
public class ChatMessage
{
    public Guid Id { get; set; }
    public Guid ChannelId { get; set; }
    public ChatChannel Channel { get; set; } = null!;
    public Guid? AuthorUserId { get; set; }
    public User? AuthorUser { get; set; }
    public string AuthorName { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTime DateCreated { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime? DateDeleted { get; set; }
}
