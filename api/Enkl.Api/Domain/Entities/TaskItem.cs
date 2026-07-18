namespace Enkl.Api.Domain.Entities;

/// <summary>
/// Named TaskItem (not Task) to avoid colliding with System.Threading.Tasks.Task, which
/// is implicitly in scope everywhere under ImplicitUsings. Maps to the "Task" entity in the plan.
/// Private-task encryption fields are still deferred to a later expansion pass.
/// </summary>
public class TaskItem
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string Priority { get; set; } = "medium";
    public Guid ColumnId { get; set; }
    public Column Column { get; set; } = null!;
    public Guid? AssigneeId { get; set; }
    public ProjectMember? Assignee { get; set; }
    public Guid? ReleaseId { get; set; }
    public Release? Release { get; set; }
    public Guid? TypeId { get; set; }
    public TaskType? Type { get; set; }
    /// <summary>Single-parent Sub-Tasks tree — separate from the multi-parent dependency DAG below.</summary>
    public Guid? ParentTaskId { get; set; }
    public TaskItem? ParentTask { get; set; }
    public string? DocumentationUrl { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }
    public DateTime? DateDone { get; set; }
    public DateOnly? StartDate { get; set; }
    public DateOnly? EndDate { get; set; }
    public int? BusinessValue { get; set; }
    public int? TaskCost { get; set; }
    public int Progress { get; set; }
    public decimal? EstimatedEffort { get; set; }
    public decimal? ActualEffort { get; set; }
    public bool Archived { get; set; }

    public List<TaskDependency> Dependencies { get; set; } = new();
    public List<TaskAuditLogEntry> AuditLog { get; set; } = new();
    public List<TaskComment> Comments { get; set; } = new();
}
