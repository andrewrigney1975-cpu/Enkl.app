namespace Enkl.Api.Domain.Entities;

/// <summary>
/// A plain-text discussion comment on a task. AuthorId is a live FK (nullable, ON DELETE SET NULL —
/// removing a member must not break existing comments), used to enforce "only the author can edit"
/// server-side; AuthorName is a display-name SNAPSHOT taken at creation time (same "immutable
/// historical record" reasoning as TaskAuditLogEntry.ChangedBy), so a comment stays attributable even
/// after its author is removed from the project or later renamed. Sort order is DateCreated alone —
/// editing Text never touches it, there is no separate "edited" timestamp.
/// </summary>
public class TaskComment
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public TaskItem Task { get; set; } = null!;
    public string Text { get; set; } = "";
    public DateTime DateCreated { get; set; }
    public Guid? AuthorId { get; set; }
    public ProjectMember? Author { get; set; }
    public string AuthorName { get; set; } = "";
}
