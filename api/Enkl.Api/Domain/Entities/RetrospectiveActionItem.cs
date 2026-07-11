namespace Enkl.Api.Domain.Entities;

public class RetrospectiveActionItem
{
    public Guid Id { get; set; }
    public Guid RetrospectiveId { get; set; }
    public Retrospective Retrospective { get; set; } = null!;
    public string Text { get; set; } = "";
    /// <summary>Same field/convention as TaskItem.AssigneeId — a plain dropdown against
    /// ProjectMember, no @mention parsing anywhere in this codebase.</summary>
    public Guid? AssigneeId { get; set; }
    public ProjectMember? Assignee { get; set; }
    public bool Completed { get; set; }
    public int SortOrder { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }
}
