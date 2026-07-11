namespace Enkl.Api.Domain.Entities;

public class Project
{
    public Guid Id { get; set; }
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Key { get; set; } = "";
    public DateOnly? StartDate { get; set; }
    public DateOnly? EndDate { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }
    public DateTime? DateLastExported { get; set; }

    /// <summary>Next numeric suffix for a new task's Key (mirrors project.taskCounter in storage.js).</summary>
    public int TaskCounter { get; set; } = 1;

    /// <summary>Raw JSON blob of the 11 opt-in/opt-out feature-flag booleans (mirrors headerButtonVisibility in storage.js).</summary>
    public string HeaderButtonVisibilityJson { get; set; } = "{}";

    /// <summary>Null until the Workflow editor has been opened once client-side — distinguishes "never customized" from "customized to empty", same as the export format's null vs {nodes:[],edges:[]}.</summary>
    public string? WorkflowJson { get; set; }

    public List<ProjectMember> Members { get; set; } = new();
    public List<Column> Columns { get; set; } = new();
    public List<TaskItem> Tasks { get; set; } = new();
    public List<Release> Releases { get; set; } = new();
    public List<TaskType> TaskTypes { get; set; } = new();
    public List<Document> Documents { get; set; } = new();
    public List<Principle> Principles { get; set; } = new();
    public List<Risk> Risks { get; set; } = new();
    public List<Objective> Objectives { get; set; } = new();
    public List<TeamCommittee> TeamsCommittees { get; set; } = new();
    public List<Decision> Decisions { get; set; } = new();
    public List<Retrospective> Retrospectives { get; set; } = new();
}
