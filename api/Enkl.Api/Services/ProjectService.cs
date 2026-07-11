using System.Text.Json;
using System.Text.Json.Nodes;
using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class ProjectService
{
    private readonly AppDbContext _db;
    private readonly JwtTokenService _jwt;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // Must match MemberService.MemberPalette[0] — a brand new project's sole member (its creator)
    // gets the same first-slot color a migrated project's first member would.
    private const string FirstMemberColor = "#0052CC";

    public ProjectService(AppDbContext db, JwtTokenService jwt)
    {
        _db = db;
        _jwt = jwt;
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
            .Include(p => p.Retrospectives).ThenInclude(r => r.Participants)
            .Include(p => p.Retrospectives).ThenInclude(r => r.Items)
            .Include(p => p.Retrospectives).ThenInclude(r => r.ActionItems)
            .FirstOrDefaultAsync(p => p.Id == projectId);

        if (project is null) return null;

        return new ProjectDetailDto(
            project.Id, project.Name, project.Key, project.OrganisationId,
            project.Members.Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.User.EmailAddress, m.Color, m.Role, m.ReportsToId)).ToList(),
            project.Columns.OrderBy(c => c.Order).Select(c => new ColumnDto(c.Id, c.Name, c.Done, c.Color, c.Order)).ToList(),
            project.Tasks.Select(ToTaskDto).ToList(),
            project.Releases.Select(r => new ReleaseDto(r.Id, r.Name, r.Status, r.OwnerId, r.StartDate, r.EndDate)).ToList(),
            project.TaskTypes.Select(t => new TaskTypeDto(t.Id, t.Name, t.IconName)).ToList(),
            project.Principles.Select(p => new PrincipleDto(p.Id, p.Key, p.Title, p.Description, p.DocumentUrl, p.IsOrganisationWide)).ToList(),
            project.Documents.Select(d => new DocumentDto(d.Id, d.Key, d.Title, d.Url, d.Description, d.OwnerId, d.TaskId, d.RelatedDocuments.Select(rd => rd.RelatedDocumentId).ToList())).ToList(),
            project.Risks.Select(r => new RiskDto(
                r.Id, r.Key, r.Title, r.Description, r.Likelihood, r.Impact, r.Mitigations, r.OwnerId, r.TaskId, r.Status, r.DateToClose, r.DateClosed,
                r.Documents.Select(x => x.DocumentId).ToList(), r.Principles.Select(x => x.PrincipleId).ToList(), r.Objectives.Select(x => x.ObjectiveId).ToList())).ToList(),
            project.Objectives.Select(o => new ObjectiveDto(o.Id, o.Key, o.Title, o.Description, o.Principles.Select(x => x.PrincipleId).ToList())).ToList(),
            project.TeamsCommittees.Select(tc => new TeamCommitteeDto(tc.Id, tc.Key, tc.Name, tc.Description, tc.Type, tc.ParentId, tc.Members.Select(x => x.ProjectMemberId).ToList())).ToList(),
            project.Decisions.Select(d => new DecisionDto(
                d.Id, d.Key, d.Title, d.Description, d.Type, d.Status, d.Outcome, d.OwnerId, d.Approver, d.TaskId,
                d.Documents.Select(x => x.DocumentId).ToList(), d.Risks.Select(x => x.RiskId).ToList(), d.Principles.Select(x => x.PrincipleId).ToList(), d.Objectives.Select(x => x.ObjectiveId).ToList())).ToList(),
            project.Retrospectives.Select(ToRetrospectiveDto).ToList(),
            ProjectSettingsSerializer.Parse(project.HeaderButtonVisibilityJson),
            ParseWorkflow(project.WorkflowJson));
    }

    /// <summary>
    /// Creates a brand new project (not via migration) under the caller's own Organisation, seeded
    /// with the same default columns/task types createDefaultProject (src/js/storage.js) gives a new
    /// local project, and adds the caller as its first member — otherwise nothing (not even the
    /// caller) could ever pass the ProjectMember policy to read it back. See CreateProjectResponseDto
    /// for why a fresh JWT rides along in the response.
    /// </summary>
    public async Task<CreateProjectResponseDto?> CreateAsync(Guid callerUserId, CreateProjectRequest request)
    {
        var user = await _db.Users.Include(u => u.Organisation).FirstOrDefaultAsync(u => u.Id == callerUserId);
        if (user is null) return null;

        // Only a template belonging to the caller's own Organisation may be applied — same org-scoping
        // as every other Organisation-owned lookup (see TemplateService).
        ProjectTemplate? template = null;
        if (request.TemplateId is Guid templateId)
        {
            template = await _db.ProjectTemplates.FirstOrDefaultAsync(t => t.Id == templateId && t.OrganisationId == user.OrganisationId);
            if (template is null) throw new ApiValidationException("Template not found.");
        }

        var name = string.IsNullOrWhiteSpace(request.Name) ? "Untitled Project" : request.Name.Trim();
        var requestedKey = DeriveProjectKey(request.Key, name);
        var uniqueKey = await ResolveUniqueProjectKeyAsync(requestedKey);
        var warning = uniqueKey != requestedKey
            ? $"Project key \"{requestedKey}\" was already in use; created as \"{uniqueKey}\" instead."
            : null;

        var now = DateTime.UtcNow;
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganisationId = user.OrganisationId,
            Name = name,
            Key = uniqueKey,
            StartDate = request.StartDate,
            EndDate = request.EndDate,
            DateCreated = now,
            DateLastModified = now,
            TaskCounter = 1
        };
        _db.Projects.Add(project);
        _db.ProjectMembers.Add(new ProjectMember { Id = Guid.NewGuid(), ProjectId = project.Id, UserId = user.Id, Color = FirstMemberColor });

        if (template is not null)
        {
            var templateColumns = JsonSerializer.Deserialize<List<TemplateColumnDto>>(template.ColumnsJson, JsonOptions) ?? new();
            var templateTaskTypes = JsonSerializer.Deserialize<List<TemplateTaskTypeDto>>(template.TaskTypesJson, JsonOptions) ?? new();

            // Column ids are global PKs, never reused by a new project — every column gets a fresh id
            // here, and this map is what lets the template's Workflow (keyed by the SOURCE project's
            // column ids) be correctly rewritten to point at THESE new ids below, instead of silently
            // orphaning itself the way MigrationService's verbatim WorkflowJson copy does today.
            var idMap = new Dictionary<Guid, Guid>();
            foreach (var col in templateColumns.OrderBy(c => c.Order))
            {
                var newId = Guid.NewGuid();
                idMap[col.Id] = newId;
                _db.Columns.Add(new Column { Id = newId, ProjectId = project.Id, Name = col.Name, Done = col.Done, Color = col.Color, Order = col.Order });
            }
            foreach (var tt in templateTaskTypes)
            {
                _db.TaskTypes.Add(new TaskType { Id = Guid.NewGuid(), ProjectId = project.Id, Name = tt.Name, IconName = tt.IconName });
            }
            project.HeaderButtonVisibilityJson = template.SettingsJson;
            project.WorkflowJson = RemapWorkflowColumnIds(template.WorkflowJson, idMap);
        }
        else
        {
            var columnDefs = new (string Name, bool Done)[] { ("To Do", false), ("In Progress", false), ("Done", true) };
            for (var i = 0; i < columnDefs.Length; i++)
            {
                _db.Columns.Add(new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = columnDefs[i].Name, Done = columnDefs[i].Done, Order = i });
            }
            foreach (var typeName in new[] { "Feature", "Bug" })
            {
                _db.TaskTypes.Add(new TaskType { Id = Guid.NewGuid(), ProjectId = project.Id, Name = typeName });
            }
        }

        await _db.SaveChangesAsync();

        var memberships = await _db.ProjectMembers.Where(m => m.UserId == user.Id).ToListAsync();
        var (token, expiresAt) = _jwt.GenerateToken(user, memberships);
        var detail = await GetProjectDetailAsync(project.Id);

        return new CreateProjectResponseDto(detail!, token, expiresAt, warning);
    }

    public async Task<ProjectSummaryDto?> UpdateAsync(Guid projectId, UpdateProjectRequest request)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var name = string.IsNullOrWhiteSpace(request.Name) ? project.Name : request.Name.Trim();
        var requestedKey = DeriveProjectKey(request.Key, name);
        project.Key = requestedKey == project.Key ? project.Key : await ResolveUniqueProjectKeyAsync(requestedKey, projectId);
        project.Name = name;
        project.StartDate = request.StartDate;
        project.EndDate = request.EndDate;
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return new ProjectSummaryDto(project.Id, project.Name, project.Key);
    }

    public async Task<bool> DeleteAsync(Guid projectId)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return false;

        // Every child entity's ProjectId FK is Cascade (Columns, Tasks, Members, Releases, ...), so
        // removing the Project alone is enough — Postgres resolves the whole graph, including
        // TaskItem.ColumnId's Restrict FK, within this same delete (no task row survives to violate
        // it once its own Cascade-from-Project deletion has also been applied).
        _db.Projects.Remove(project);
        await _db.SaveChangesAsync();
        return true;
    }

    private static string DeriveProjectKey(string? requestedKey, string name)
    {
        var trimmed = (requestedKey ?? "").Trim().ToUpperInvariant();
        if (trimmed.Length > 0) return trimmed.Length > 20 ? trimmed[..20] : trimmed;

        var fromName = new string(name.Where(char.IsLetter).ToArray()).ToUpperInvariant();
        if (fromName.Length > 4) fromName = fromName[..4];
        return fromName.Length > 0 ? fromName : "PROJ";
    }

    private async Task<string> ResolveUniqueProjectKeyAsync(string baseKey, Guid? excludeProjectId = null)
    {
        var candidate = baseKey;
        var suffix = 1;
        while (await _db.Projects.AnyAsync(p => p.Key == candidate && p.Id != excludeProjectId))
        {
            candidate = $"{baseKey}{++suffix}";
        }
        return candidate;
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

    /// <summary>
    /// Rewrites a snapshotted Workflow's column-id references (workflow.nodes' object keys and every
    /// edge's fromColumnId/toColumnId — see features/workflow-engine.js's shape comment) through
    /// idMap, dropping anything that fails to map. Used when applying a Project Template: the
    /// template's Workflow was captured against the SOURCE project's column ids, which the newly
    /// created project's columns don't share (see the id-map comment in CreateAsync above).
    /// </summary>
    private static string? RemapWorkflowColumnIds(string? workflowJson, Dictionary<Guid, Guid> idMap)
    {
        if (string.IsNullOrWhiteSpace(workflowJson)) return null;

        JsonNode? root;
        try { root = JsonNode.Parse(workflowJson); }
        catch (JsonException) { return null; }
        if (root is not JsonObject rootObj) return null;

        var newNodes = new JsonObject();
        if (rootObj["nodes"] is JsonObject nodesObj)
        {
            foreach (var kvp in nodesObj)
            {
                if (kvp.Value is not null && Guid.TryParse(kvp.Key, out var oldId) && idMap.TryGetValue(oldId, out var newId))
                {
                    newNodes[newId.ToString()] = kvp.Value.DeepClone();
                }
            }
        }

        var newEdges = new JsonArray();
        if (rootObj["edges"] is JsonArray edgesArr)
        {
            foreach (var edgeNode in edgesArr)
            {
                if (edgeNode is not JsonObject edgeObj) continue;
                var fromStr = edgeObj["fromColumnId"]?.GetValue<string>();
                var toStr = edgeObj["toColumnId"]?.GetValue<string>();
                if (fromStr is null || toStr is null) continue;
                if (!Guid.TryParse(fromStr, out var oldFrom) || !idMap.TryGetValue(oldFrom, out var newFrom)) continue;
                if (!Guid.TryParse(toStr, out var oldTo) || !idMap.TryGetValue(oldTo, out var newTo)) continue;

                var newEdge = edgeObj.DeepClone().AsObject();
                newEdge["fromColumnId"] = newFrom.ToString();
                newEdge["toColumnId"] = newTo.ToString();
                newEdges.Add(newEdge);
            }
        }

        var result = new JsonObject { ["nodes"] = newNodes, ["edges"] = newEdges };
        return result.ToJsonString(JsonOptions);
    }

    public static TaskDto ToTaskDto(TaskItem t) => new(
        t.Id, t.Key, t.Title, t.Description, t.Priority, t.ColumnId, t.AssigneeId, t.ReleaseId, t.TypeId, t.ParentTaskId, t.DocumentationUrl,
        t.DateCreated, t.DateLastModified, t.DateDone, t.StartDate, t.EndDate,
        t.BusinessValue, t.TaskCost, t.Progress, t.EstimatedEffort, t.ActualEffort, t.Archived,
        t.Dependencies.Select(d => d.DependsOnTaskId).ToList(),
        t.AuditLog.Select(a => new TaskAuditLogEntryDto(a.Id, a.Timestamp, a.Field, a.OldValue, a.NewValue, a.ChangedBy)).ToList());

    public static RetrospectiveDto ToRetrospectiveDto(Retrospective r) => new(
        r.Id, r.Key, r.ReleaseId, r.Team, r.Background, r.RetroDate, r.LastTimerDurationSeconds,
        r.Participants.Select(p => p.ProjectMemberId).ToList(),
        r.Items.OrderBy(i => i.SortOrder).Select(i => new RetrospectiveItemDto(i.Id, i.Column, i.Text, i.SortOrder, i.PromotedPrincipleId)).ToList(),
        r.ActionItems.OrderBy(a => a.SortOrder).Select(a => new RetrospectiveActionItemDto(a.Id, a.Text, a.AssigneeId, a.Completed, a.SortOrder)).ToList(),
        r.DateCreated, r.DateLastModified);
}
