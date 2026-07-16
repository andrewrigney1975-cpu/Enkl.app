using System.Text.Json;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class TaskService
{
    private readonly AppDbContext _db;

    public TaskService(AppDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// ARCHITECTURE-REVIEW.md finding 2.2: a targeted, paginated alternative to pulling every task in
    /// a project through ProjectService.GetProjectDetailAsync's one all-in-one graph fetch. Ordered by
    /// DateCreated (oldest first) for stable pagination — a project's task set only grows/gets
    /// reordered within columns, never reordered by creation time, so this ordering is stable across
    /// pages even while the board itself is being edited concurrently. Returns null (not an empty
    /// page) if the project itself doesn't exist, so the controller can 404 rather than return an
    /// empty-but-200 page for a nonexistent project.
    /// </summary>
    public async Task<PagedResultDto<TaskDto>?> GetTasksPagedAsync(Guid projectId, int page, int pageSize)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId);
        if (!projectExists) return null;

        page = Math.Max(page, 1);
        pageSize = Math.Clamp(pageSize, 1, 200);

        var totalCount = await _db.Tasks.CountAsync(t => t.ProjectId == projectId);

        // AsSplitQuery, same reasoning as ProjectService.GetProjectDetailAsync's own multi-Include
        // fetch: two collection Includes (Dependencies, AuditLog) on the same paged-down row set would
        // otherwise multiply rather than add, even at this much smaller (<=200 task) scale.
        var pageEntities = await _db.Tasks
            .AsNoTracking()
            .AsSplitQuery()
            .Where(t => t.ProjectId == projectId)
            .OrderBy(t => t.DateCreated)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Include(t => t.Dependencies)
            .Include(t => t.AuditLog)
            .ToListAsync();

        var items = pageEntities.Select(ProjectService.ToTaskDto).ToList();
        return new PagedResultDto<TaskDto>(items, totalCount, page, pageSize);
    }

    public async Task<TaskDto?> CreateAsync(Guid projectId, CreateTaskRequest request)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        var column = await _db.Columns.AsNoTracking().FirstOrDefaultAsync(c => c.Id == request.ColumnId && c.ProjectId == projectId);
        if (project is null || column is null) return null;

        if (request.DependsOnTaskIds is { Count: > 0 } && await WouldCreateDependencyCycleAsync(projectId, Guid.Empty, request.DependsOnTaskIds, isNewTask: true))
        {
            throw new ApiValidationException("That set of dependencies would create a cycle.");
        }
        if (request.ParentTaskId is { } newParentForCreate && await WouldCreateParentCycleAsync(projectId, Guid.Empty, newParentForCreate, isNewTask: true))
        {
            throw new ApiValidationException("That parent task would create a cycle.");
        }

        var now = DateTime.UtcNow;
        var task = new TaskItem
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            Key = $"{project.Key}-{project.TaskCounter}",
            Title = request.Title,
            Description = request.Description,
            Priority = request.Priority,
            ColumnId = request.ColumnId,
            AssigneeId = request.AssigneeId,
            ReleaseId = request.ReleaseId,
            TypeId = request.TypeId,
            ParentTaskId = request.ParentTaskId,
            DateCreated = now,
            DateLastModified = now,
            // A task created directly into a Done column counts as transitioning to Done immediately,
            // same rule as mutations.js's addTask (mutations.js:1056).
            DateDone = column.Done ? now : null,
            Progress = 0
        };
        project.TaskCounter++;

        _db.Tasks.Add(task);

        foreach (var depId in (request.DependsOnTaskIds ?? new List<Guid>()).Distinct())
        {
            if (depId != task.Id) _db.TaskDependencies.Add(new TaskDependency { TaskId = task.Id, DependsOnTaskId = depId });
        }

        await _db.SaveChangesAsync();
        return await ToTaskDtoWithRelationsAsync(task.Id);
    }

    public async Task<TaskDto?> UpdateAsync(Guid projectId, Guid taskId, UpdateTaskRequest request, string? changedByDisplayName)
    {
        var task = await _db.Tasks
            .Include(t => t.Dependencies)
            .FirstOrDefaultAsync(t => t.Id == taskId && t.ProjectId == projectId);
        if (task is null) return null;

        var newColumn = await _db.Columns.AsNoTracking().FirstOrDefaultAsync(c => c.Id == request.ColumnId && c.ProjectId == projectId);
        if (newColumn is null) return null;

        var newDeps = (request.DependsOnTaskIds ?? new List<Guid>()).Where(id => id != taskId).Distinct().ToList();
        if (await WouldCreateDependencyCycleAsync(projectId, taskId, newDeps, isNewTask: false))
        {
            throw new ApiValidationException("That set of dependencies would create a cycle.");
        }
        if (request.ParentTaskId is { } newParent && await WouldCreateParentCycleAsync(projectId, taskId, newParent, isNewTask: false))
        {
            throw new ApiValidationException("That parent task would create a cycle.");
        }

        var before = CaptureAuditSnapshot(task);
        var wasDone = task.DateDone.HasValue;
        var now = DateTime.UtcNow;

        task.Title = request.Title;
        task.Description = request.Description;
        task.Priority = request.Priority;
        task.ColumnId = request.ColumnId;
        task.AssigneeId = request.AssigneeId;
        task.ReleaseId = request.ReleaseId;
        task.TypeId = request.TypeId;
        task.ParentTaskId = request.ParentTaskId;
        task.DocumentationUrl = request.DocumentationUrl;
        task.StartDate = request.StartDate;
        task.EndDate = request.EndDate;
        task.BusinessValue = request.BusinessValue;
        task.TaskCost = request.TaskCost;
        task.Progress = request.Progress;
        task.EstimatedEffort = request.EstimatedEffort;
        task.ActualEffort = request.ActualEffort;
        task.Archived = request.Archived;
        task.DateLastModified = now;

        // Ported from mutations.js's updateTask (mutations.js:1198-1204): dateDone marks the most
        // recent time this task actually became Done, cleared if it leaves a Done column again.
        if (newColumn.Done && !wasDone) task.DateDone = now;
        else if (!newColumn.Done && wasDone) task.DateDone = null;

        _db.TaskDependencies.RemoveRange(task.Dependencies);
        foreach (var depId in newDeps)
        {
            _db.TaskDependencies.Add(new TaskDependency { TaskId = task.Id, DependsOnTaskId = depId });
        }

        if (await IsChangeAuditingEnabledAsync(projectId))
        {
            var after = CaptureAuditSnapshot(task, newDeps);
            RecordAuditEntries(task, before, after with { DependsOnTaskIds = newDeps }, changedByDisplayName);
        }

        await _db.SaveChangesAsync();
        return await ToTaskDtoWithRelationsAsync(task.Id);
    }

    /// <summary>
    /// Used by TasksController to capture a deleted task's key/title for its SSE broadcast *before*
    /// DeleteAsync removes the row — there's nothing left to read it from afterward.
    /// </summary>
    public async Task<(Guid TaskId, string Key, string Title)?> GetTaskSummaryAsync(Guid projectId, Guid taskId)
    {
        var task = await _db.Tasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId && t.ProjectId == projectId);
        return task is null ? null : (task.Id, task.Key, task.Title);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid taskId)
    {
        var task = await _db.Tasks.FirstOrDefaultAsync(t => t.Id == taskId && t.ProjectId == projectId);
        if (task is null) return false;

        // Mirrors mutations.js's deleteTask: a deleted task's sub-tasks are orphaned back to
        // top-level rather than cascade-deleted, and any Document/Risk/Decision pointing at it
        // is unlinked rather than blocked — matches the SetNull FKs already configured, but
        // ParentTaskId is Restrict so it needs the explicit unlink below.
        var children = await _db.Tasks.Where(t => t.ParentTaskId == taskId).ToListAsync();
        foreach (var child in children) child.ParentTaskId = null;

        _db.Tasks.Remove(task);
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>Used by TasksController to know who to notify over SSE after a task change (see SseBroadcaster).</summary>
    public Task<List<Guid>> GetProjectMemberUserIdsAsync(Guid projectId) =>
        _db.ProjectMembers.Where(m => m.ProjectId == projectId).Select(m => m.UserId).ToListAsync();

    private async Task<TaskDto> ToTaskDtoWithRelationsAsync(Guid taskId)
    {
        var task = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.Dependencies)
            .Include(t => t.AuditLog)
            .FirstAsync(t => t.Id == taskId);
        return ProjectService.ToTaskDto(task);
    }

    private async Task<bool> WouldCreateDependencyCycleAsync(Guid projectId, Guid taskId, List<Guid> newDeps, bool isNewTask)
    {
        var adjacency = await _db.TaskDependencies
            .Where(d => d.Task.ProjectId == projectId)
            .GroupBy(d => d.TaskId)
            .Select(g => new { g.Key, Deps = g.Select(x => x.DependsOnTaskId).ToList() })
            .ToDictionaryAsync(g => g.Key, g => g.Deps);

        var effectiveId = isNewTask ? Guid.NewGuid() : taskId;
        adjacency[effectiveId] = newDeps;
        return CycleDetection.HasCycle(adjacency);
    }

    private async Task<bool> WouldCreateParentCycleAsync(Guid projectId, Guid taskId, Guid newParentId, bool isNewTask)
    {
        var parentById = await _db.Tasks
            .Where(t => t.ProjectId == projectId)
            .Select(t => new { t.Id, t.ParentTaskId })
            .ToDictionaryAsync(t => t.Id, t => t.ParentTaskId);

        var effectiveId = isNewTask ? Guid.NewGuid() : taskId;
        parentById[effectiveId] = newParentId;
        return CycleDetection.HasParentCycle(parentById);
    }

    private async Task<bool> IsChangeAuditingEnabledAsync(Guid projectId)
    {
        var json = await _db.Projects.Where(p => p.Id == projectId).Select(p => p.HeaderButtonVisibilityJson).FirstOrDefaultAsync();
        if (string.IsNullOrEmpty(json)) return false;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("changeAuditing", out var val) && val.ValueKind == JsonValueKind.True;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static readonly (string Field, Func<TaskAuditSnapshot, object?> Get)[] AuditDiffedFields =
    {
        ("title", s => s.Title), ("description", s => s.Description), ("priority", s => s.Priority),
        ("assigneeId", s => s.AssigneeId), ("releaseId", s => s.ReleaseId), ("typeId", s => s.TypeId),
        ("documentationUrl", s => s.DocumentationUrl), ("startDate", s => s.StartDate), ("endDate", s => s.EndDate),
        ("businessValue", s => s.BusinessValue), ("taskCost", s => s.TaskCost), ("progress", s => s.Progress),
        ("estimatedEffort", s => s.EstimatedEffort), ("actualEffort", s => s.ActualEffort),
        ("archived", s => s.Archived), ("dependencies", s => s.DependsOnTaskIds), ("parentTaskId", s => s.ParentTaskId)
    };

    private static TaskAuditSnapshot CaptureAuditSnapshot(TaskItem t, List<Guid>? deps = null) => new(
        t.Title, t.Description, t.Priority, t.AssigneeId, t.ReleaseId, t.TypeId, t.DocumentationUrl,
        t.StartDate, t.EndDate, t.BusinessValue, t.TaskCost, t.Progress, t.EstimatedEffort, t.ActualEffort,
        t.Archived, deps ?? t.Dependencies.Select(d => d.DependsOnTaskId).ToList(), t.ParentTaskId);

    private void RecordAuditEntries(TaskItem task, TaskAuditSnapshot before, TaskAuditSnapshot after, string? changedBy)
    {
        var now = DateTime.UtcNow;
        foreach (var (field, get) in AuditDiffedFields)
        {
            var oldVal = get(before);
            var newVal = get(after);
            if (!AuditValuesEqual(oldVal, newVal))
            {
                _db.TaskAuditLogEntries.Add(new TaskAuditLogEntry
                {
                    Id = Guid.NewGuid(), TaskId = task.Id, Timestamp = now, Field = field,
                    OldValue = FormatAuditValue(oldVal), NewValue = FormatAuditValue(newVal), ChangedBy = changedBy
                });
            }
        }
    }

    private static bool AuditValuesEqual(object? a, object? b)
    {
        if (a is List<Guid> la && b is List<Guid> lb)
        {
            return la.OrderBy(x => x).SequenceEqual(lb.OrderBy(x => x));
        }
        return Equals(a, b);
    }

    private static string? FormatAuditValue(object? value) => value switch
    {
        null => null,
        List<Guid> list => list.Count == 0 ? "[]" : string.Join(",", list),
        _ => value.ToString()
    };

    private record TaskAuditSnapshot(
        string Title, string? Description, string Priority, Guid? AssigneeId, Guid? ReleaseId, Guid? TypeId,
        string? DocumentationUrl, DateOnly? StartDate, DateOnly? EndDate, int? BusinessValue, int? TaskCost,
        int Progress, decimal? EstimatedEffort, decimal? ActualEffort, bool Archived, List<Guid> DependsOnTaskIds,
        Guid? ParentTaskId);
}
