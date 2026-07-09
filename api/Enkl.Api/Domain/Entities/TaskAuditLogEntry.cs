namespace Enkl.Api.Domain.Entities;

public class TaskAuditLogEntry
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public TaskItem Task { get; set; } = null!;
    public DateTime Timestamp { get; set; }
    public string Field { get; set; } = "";
    public string? OldValue { get; set; }
    public string? NewValue { get; set; }

    /// <summary>
    /// The authenticated user's display name at the time of the change (a snapshot, not a live FK —
    /// same reasoning as OldValue/NewValue being formatted strings rather than references: this is an
    /// immutable historical record). Null for changes made before this field existed, and for any
    /// audit entry carried over from a project's local (pre-migration) history, since local mode has
    /// no login to attribute a change to.
    /// </summary>
    public string? ChangedBy { get; set; }
}
