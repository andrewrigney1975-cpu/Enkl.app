namespace Enkl.Api.Domain.Entities;

/// <summary>
/// A named, reusable snapshot of a project's Columns, TaskTypes, Workflow, and App Settings
/// (HeaderButtonVisibility) — owned by the Organisation, not any one Project, so every member of that
/// org can list/apply it (see TemplatesController's gating). Deliberately just jsonb blobs, same shape
/// as Project's own WorkflowJson/HeaderButtonVisibilityJson columns — this data is an inert snapshot,
/// never queried relationally.
/// </summary>
public class ProjectTemplate
{
    public Guid Id { get; set; }
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;
    public string Name { get; set; } = "";

    /// <summary>JSON array of TemplateColumnDto — column Id is preserved from the source project so ProjectService can correlate old-&gt;new ids when remapping Workflow on apply.</summary>
    public string ColumnsJson { get; set; } = "[]";

    /// <summary>JSON array of TemplateTaskTypeDto (name/iconName only — no id needed, never referenced by id elsewhere).</summary>
    public string TaskTypesJson { get; set; } = "[]";

    /// <summary>Null if the source project had no workflow configured. Column ids inside nodes/edges refer to the SOURCE project's columns and must be remapped through a fresh id map when a new project is created from this template.</summary>
    public string? WorkflowJson { get; set; }

    /// <summary>Raw JSON blob of the 11 opt-in/opt-out feature-flag booleans (mirrors Project.HeaderButtonVisibilityJson).</summary>
    public string SettingsJson { get; set; } = "{}";

    public DateTime CreatedAt { get; set; }
    public DateTime DateLastModified { get; set; }
}
