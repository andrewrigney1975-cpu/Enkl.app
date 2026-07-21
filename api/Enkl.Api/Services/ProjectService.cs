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
        // Inactive (Portfolio-Planner placeholder) projects never appear in this switcher list — see
        // PortfolioService.UpdateProjectActiveAsync for the only place IsActive is ever flipped.
        return await _db.ProjectMembers
            .Where(m => m.UserId == userId && m.Project.IsActive)
            .Select(m => new ProjectSummaryDto(m.Project.Id, m.Project.Name, m.Project.Key))
            .ToListAsync();
    }

    public async Task<ProjectDetailDto?> GetProjectDetailAsync(Guid projectId)
    {
        // AsSplitQuery is required here, not optional: 18 Include/ThenInclude chains on one root
        // query means EF Core's default single-query behavior LEFT JOINs every one of these
        // one-to-many collections together, so the result set size is their ROW COUNTS MULTIPLIED
        // (members * tasks * columns * releases * risks * decisions * ...) — a genuine "cartesian
        // explosion". For a project with real data (confirmed: 11 members) this took 30+ seconds and
        // got cancelled by Npgsql's command timeout, returning a 500 — AsSplitQuery makes EF Core
        // issue one query per collection instead, so row counts add rather than multiply.
        var project = await _db.Projects
            .AsNoTracking()
            .AsSplitQuery()
            .Include(p => p.Members).ThenInclude(m => m.User)
            .Include(p => p.Columns)
            .Include(p => p.Tasks).ThenInclude(t => t.Dependencies)
            .Include(p => p.Tasks).ThenInclude(t => t.AuditLog)
            .Include(p => p.Tasks).ThenInclude(t => t.Comments)
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
            .Include(p => p.SavedQueries)
            .FirstOrDefaultAsync(p => p.Id == projectId);

        if (project is null) return null;

        return new ProjectDetailDto(
            project.Id, project.Name, project.Key, project.OrganisationId,
            project.Members.Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.User.EmailAddress, m.Color, m.Role, m.AllocatedFraction, m.ReportsToId, m.IsProjectAdmin, m.User.IsActive)).ToList(),
            project.Columns.OrderBy(c => c.Order).Select(c => new ColumnDto(c.Id, c.Name, c.Done, c.Color, c.Order, c.Cap)).ToList(),
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
            project.SavedQueries.OrderBy(q => q.DateCreated).Select(q => new SavedQueryDto(q.Id, q.Name, q.Sql, q.DateCreated, q.ExposeViaApi)).ToList(),
            ProjectSettingsSerializer.Parse(project.HeaderButtonVisibilityJson),
            ParseWorkflow(project.WorkflowJson),
            project.StartDate, project.EndDate, project.Description);
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
        var user = await _db.Users.AsNoTracking().Include(u => u.Organisation).FirstOrDefaultAsync(u => u.Id == callerUserId);
        if (user is null) return null;

        // Only a template belonging to the caller's own Organisation may be applied — same org-scoping
        // as every other Organisation-owned lookup (see TemplateService).
        ProjectTemplate? template = null;
        if (request.TemplateId is Guid templateId)
        {
            template = await _db.ProjectTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Id == templateId && t.OrganisationId == user.OrganisationId);
            if (template is null) throw new ApiValidationException("Template not found.");
        }

        var name = string.IsNullOrWhiteSpace(request.Name) ? "Untitled Project" : request.Name.Trim();
        var requestedKey = ProjectKeyResolver.DeriveKey(request.Key, name);
        var uniqueKey = await ProjectKeyResolver.ResolveUniqueKeyAsync(_db, requestedKey, user.OrganisationId);
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
            Description = request.Description?.Trim(),
            DateCreated = now,
            DateLastModified = now,
            TaskCounter = 1
        };
        _db.Projects.Add(project);
        // The creator is the project's "owner" — always its first Project Admin, so a freshly
        // created project is never immediately locked out of column/settings/workflow/member
        // management (see ProjectAdminAuthorizationHandler's own doc comment for what this gates).
        _db.ProjectMembers.Add(new ProjectMember { Id = Guid.NewGuid(), ProjectId = project.Id, UserId = user.Id, Color = FirstMemberColor, IsProjectAdmin = true });

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
                _db.Columns.Add(new Column { Id = newId, ProjectId = project.Id, Name = col.Name, Done = col.Done, Color = col.Color, Order = col.Order, Cap = col.Cap });
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

        var memberships = await _db.ProjectMembers.AsNoTracking().Where(m => m.UserId == user.Id).ToListAsync();
        var (token, expiresAt) = _jwt.GenerateToken(user, memberships);
        var detail = await GetProjectDetailAsync(project.Id);

        return new CreateProjectResponseDto(detail!, token, expiresAt, warning);
    }

    public async Task<ProjectSummaryDto?> UpdateAsync(Guid projectId, UpdateProjectRequest request)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var name = string.IsNullOrWhiteSpace(request.Name) ? project.Name : request.Name.Trim();
        var requestedKey = ProjectKeyResolver.DeriveKey(request.Key, name);
        project.Key = requestedKey == project.Key ? project.Key : await ProjectKeyResolver.ResolveUniqueKeyAsync(_db, requestedKey, project.OrganisationId, projectId);
        project.Name = name;
        project.StartDate = request.StartDate;
        project.EndDate = request.EndDate;
        project.Description = request.Description?.Trim();
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return new ProjectSummaryDto(project.Id, project.Name, project.Key);
    }

    /// <summary>Pure check, no mutation — re-derives org membership from the caller's own JWT claim
    /// (organisationId), never a client-supplied value, same cross-org-isolation shape as
    /// PortfolioService. A wrong-org or nonexistent projectId returns null (404) either way — no
    /// enumeration oracle.</summary>
    public async Task<KeyAvailabilityDto?> CheckKeyAvailabilityAsync(Guid organisationId, Guid projectId, string requestedKey)
    {
        var exists = await _db.Projects.AsNoTracking().AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!exists) return null;

        var normalized = ProjectKeyResolver.DeriveKey(requestedKey, "");
        var available = normalized.Length > 0 && !await _db.Projects.AsNoTracking()
            .AnyAsync(p => p.Key == normalized && p.OrganisationId == organisationId && p.Id != projectId);
        return new KeyAvailabilityDto(available, normalized);
    }

    /// <summary>Same check as CheckKeyAvailabilityAsync, but for a project that doesn't exist yet
    /// (creation time) — any authenticated org user may create a project (see ProjectsController's
    /// CreateProject, ungated by any per-project policy), so this has no projectId to verify against,
    /// just the caller's own org.</summary>
    public async Task<KeyAvailabilityDto> CheckKeyAvailabilityForCreationAsync(Guid organisationId, string requestedKey)
    {
        var normalized = ProjectKeyResolver.DeriveKey(requestedKey, "");
        var available = normalized.Length > 0 && !await _db.Projects.AsNoTracking()
            .AnyAsync(p => p.Key == normalized && p.OrganisationId == organisationId);
        return new KeyAvailabilityDto(available, normalized);
    }

    /// <summary>Org-Admin-only, cascading rename: unlike UpdateAsync's silent auto-suffix-on-collision
    /// behavior (fine for an incidental name-driven key derivation), an explicit key CHANGE the caller
    /// is about to irreversibly confirm must fail loudly on collision instead — re-checked here even
    /// though the frontend already called CheckKeyAvailabilityAsync, closing the race window between
    /// that check and this commit. Every task's Key ("{oldKey}-{counter}") is rebuilt by a length-
    /// prefix replace so it stays correct even if a key itself contains a hyphen (DeriveKey doesn't
    /// strip them) — active and archived tasks are the same table (TaskItem.Archived is a plain bool),
    /// so one statement covers both.</summary>
    public async Task<ProjectSummaryDto?> ChangeKeyAsync(Guid organisationId, Guid projectId, string newKey)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (project is null) return null;

        var normalized = ProjectKeyResolver.DeriveKey(newKey, "");
        if (normalized.Length == 0) throw new ApiValidationException("Project key is required.");
        if (await _db.Projects.AnyAsync(p => p.Key == normalized && p.OrganisationId == organisationId && p.Id != projectId))
            throw new ApiValidationException("That project key is already in use in this organisation.");

        var oldKey = project.Key;
        if (normalized == oldKey) return new ProjectSummaryDto(project.Id, project.Name, project.Key);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            project.Key = normalized;
            project.DateLastModified = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            await _db.Tasks.Where(t => t.ProjectId == projectId)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.Key, t => normalized + t.Key.Substring(oldKey.Length)));
            await tx.CommitAsync();
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }

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
        // Server-side order is a sensible default (oldest first) — the frontend's own sort toggle is
        // what actually controls display order, this just avoids leaving it as unspecified/EF-natural-
        // order (previously left unordered here — a real bug, reported as "audit trail order seems
        // random" — while Comments below always had this same OrderBy; now consistent with it).
        t.AuditLog.OrderBy(a => a.Timestamp).Select(a => new TaskAuditLogEntryDto(a.Id, a.Timestamp, a.Field, a.OldValue, a.NewValue, a.ChangedBy)).ToList(),
        t.Comments.OrderBy(c => c.DateCreated).Select(c => new TaskCommentDto(c.Id, c.Text, c.DateCreated, c.AuthorId, c.AuthorName)).ToList());

    public static RetrospectiveDto ToRetrospectiveDto(Retrospective r) => new(
        r.Id, r.Key, r.ReleaseId, r.Team, r.Background, r.RetroDate, r.LastTimerDurationSeconds,
        r.Participants.Select(p => p.ProjectMemberId).ToList(),
        r.Items.OrderBy(i => i.SortOrder).Select(i => new RetrospectiveItemDto(i.Id, i.Column, i.Text, i.SortOrder, i.PromotedPrincipleId)).ToList(),
        r.ActionItems.OrderBy(a => a.SortOrder).Select(a => new RetrospectiveActionItemDto(a.Id, a.Text, a.AssigneeId, a.Completed, a.SortOrder)).ToList(),
        r.DateCreated, r.DateLastModified);
}
