using System.Text.Json;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class ProjectService
{
    private readonly AppDbContext _db;

    public ProjectService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<List<ProjectSummaryDto>> GetProjectsForUserAsync(Guid userId)
    {
        return await _db.ProjectMembers
            .Where(m => m.UserId == userId)
            .Select(m => new ProjectSummaryDto(m.Project.Id, m.Project.Name, m.Project.Key))
            .ToListAsync();
    }

    public async Task<ProjectDetailDto?> GetProjectDetailAsync(Guid projectId)
    {
        var project = await _db.Projects
            .Include(p => p.Members).ThenInclude(m => m.User)
            .Include(p => p.Columns)
            .Include(p => p.Tasks).ThenInclude(t => t.Dependencies)
            .Include(p => p.Tasks).ThenInclude(t => t.AuditLog)
            .Include(p => p.Releases)
            .Include(p => p.TaskTypes)
            .Include(p => p.Principles)
            .Include(p => p.Documents).ThenInclude(d => d.RelatedDocuments)
            .Include(p => p.Risks).ThenInclude(r => r.Documents)
            .Include(p => p.Risks).ThenInclude(r => r.Principles)
            .Include(p => p.Risks).ThenInclude(r => r.Objectives)
            .Include(p => p.Objectives).ThenInclude(o => o.Principles)
            .Include(p => p.TeamsCommittees).ThenInclude(tc => tc.Members)
            .Include(p => p.Decisions).ThenInclude(d => d.Documents)
            .Include(p => p.Decisions).ThenInclude(d => d.Risks)
            .Include(p => p.Decisions).ThenInclude(d => d.Principles)
            .Include(p => p.Decisions).ThenInclude(d => d.Objectives)
            .FirstOrDefaultAsync(p => p.Id == projectId);

        if (project is null) return null;

        return new ProjectDetailDto(
            project.Id, project.Name, project.Key, project.OrganisationId,
            project.Members.Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.Color, m.Role, m.ReportsToId)).ToList(),
            project.Columns.OrderBy(c => c.Order).Select(c => new ColumnDto(c.Id, c.Name, c.Done, c.Color, c.Order)).ToList(),
            project.Tasks.Select(ToTaskDto).ToList(),
            project.Releases.Select(r => new ReleaseDto(r.Id, r.Name, r.Status, r.OwnerId, r.StartDate, r.EndDate)).ToList(),
            project.TaskTypes.Select(t => new TaskTypeDto(t.Id, t.Name, t.IconName)).ToList(),
            project.Principles.Select(p => new PrincipleDto(p.Id, p.Key, p.Title, p.Description, p.DocumentUrl)).ToList(),
            project.Documents.Select(d => new DocumentDto(d.Id, d.Key, d.Title, d.Url, d.Description, d.OwnerId, d.TaskId, d.RelatedDocuments.Select(rd => rd.RelatedDocumentId).ToList())).ToList(),
            project.Risks.Select(r => new RiskDto(
                r.Id, r.Key, r.Title, r.Description, r.Likelihood, r.Impact, r.Mitigations, r.OwnerId, r.TaskId, r.Status, r.DateToClose, r.DateClosed,
                r.Documents.Select(x => x.DocumentId).ToList(), r.Principles.Select(x => x.PrincipleId).ToList(), r.Objectives.Select(x => x.ObjectiveId).ToList())).ToList(),
            project.Objectives.Select(o => new ObjectiveDto(o.Id, o.Key, o.Title, o.Description, o.Principles.Select(x => x.PrincipleId).ToList())).ToList(),
            project.TeamsCommittees.Select(tc => new TeamCommitteeDto(tc.Id, tc.Key, tc.Name, tc.Description, tc.Type, tc.ParentId, tc.Members.Select(x => x.ProjectMemberId).ToList())).ToList(),
            project.Decisions.Select(d => new DecisionDto(
                d.Id, d.Key, d.Title, d.Description, d.Type, d.Status, d.Outcome, d.OwnerId, d.Approver, d.TaskId,
                d.Documents.Select(x => x.DocumentId).ToList(), d.Risks.Select(x => x.RiskId).ToList(), d.Principles.Select(x => x.PrincipleId).ToList(), d.Objectives.Select(x => x.ObjectiveId).ToList())).ToList(),
            ProjectSettingsSerializer.Parse(project.HeaderButtonVisibilityJson),
            ParseWorkflow(project.WorkflowJson));
    }

    public async Task<ProjectSettingsDto?> UpdateProjectSettingsAsync(Guid projectId, ProjectSettingsDto settings)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        project.HeaderButtonVisibilityJson = ProjectSettingsSerializer.Serialize(settings);
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return settings;
    }

    /// <summary>
    /// Persists the whole nodes/edges blob the Workflow editor's "Save Workflow" button sends
    /// (src/js/views/workflow-editor.js) — an opaque JSON document, not a modeled entity, since
    /// nothing server-side currently interprets workflow semantics (unlike HeaderButtonVisibilityJson,
    /// whose changeAuditing flag TaskService reads).
    /// </summary>
    public async Task<JsonElement?> UpdateProjectWorkflowAsync(Guid projectId, JsonElement workflow)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        project.WorkflowJson = workflow.GetRawText();
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return workflow;
    }

    private static JsonElement? ParseWorkflow(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonDocument.Parse(json).RootElement;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static TaskDto ToTaskDto(TaskItem t) => new(
        t.Id, t.Key, t.Title, t.Description, t.Priority, t.ColumnId, t.AssigneeId, t.ReleaseId, t.TypeId, t.ParentTaskId, t.DocumentationUrl,
        t.DateCreated, t.DateLastModified, t.DateDone, t.StartDate, t.EndDate,
        t.BusinessValue, t.TaskCost, t.Progress, t.EstimatedEffort, t.ActualEffort, t.Archived,
        t.Dependencies.Select(d => d.DependsOnTaskId).ToList(),
        t.AuditLog.Select(a => new TaskAuditLogEntryDto(a.Id, a.Timestamp, a.Field, a.OldValue, a.NewValue, a.ChangedBy)).ToList());
}
