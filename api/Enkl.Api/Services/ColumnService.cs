using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class ColumnService
{
    private readonly AppDbContext _db;

    public ColumnService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<ColumnDto> CreateAsync(Guid projectId, CreateColumnRequest request)
    {
        var nextOrder = await _db.Columns.Where(c => c.ProjectId == projectId).CountAsync();
        var column = new Column
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            Name = request.Name,
            Done = request.Done,
            Color = request.Color,
            Order = nextOrder
        };
        _db.Columns.Add(column);
        await _db.SaveChangesAsync();
        return new ColumnDto(column.Id, column.Name, column.Done, column.Color, column.Order);
    }

    public async Task<ColumnDto?> UpdateAsync(Guid projectId, Guid columnId, UpdateColumnRequest request)
    {
        var column = await _db.Columns.FirstOrDefaultAsync(c => c.Id == columnId && c.ProjectId == projectId);
        if (column is null) return null;

        column.Name = request.Name;
        column.Done = request.Done;
        column.Color = request.Color;
        column.Order = request.Order;
        await _db.SaveChangesAsync();
        return new ColumnDto(column.Id, column.Name, column.Done, column.Color, column.Order);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid columnId)
    {
        var column = await _db.Columns.FirstOrDefaultAsync(c => c.Id == columnId && c.ProjectId == projectId);
        if (column is null) return false;

        // TaskItem.ColumnId is a Restrict FK (see TaskItemConfiguration) — deleting a column that
        // still holds tasks would otherwise fail at the DB level. Mirrors mutations.js's deleteColumn:
        // every task in the column is deleted outright (not reassigned elsewhere), with the same
        // cleanup TasksController.Delete does per task — sub-tasks orphaned back to top-level (their
        // ParentTaskId FK is also Restrict), dependency rows removed on both sides since
        // TaskDependency.DependsOnTaskId is Restrict too. Document/Risk/Decision.TaskId and
        // TaskItem.AssigneeId are already SetNull, so those clear themselves.
        var taskIds = await _db.Tasks.Where(t => t.ColumnId == columnId).Select(t => t.Id).ToListAsync();
        if (taskIds.Count > 0)
        {
            var orphanedChildren = await _db.Tasks.Where(t => t.ParentTaskId != null && taskIds.Contains(t.ParentTaskId!.Value) && !taskIds.Contains(t.Id)).ToListAsync();
            foreach (var child in orphanedChildren) child.ParentTaskId = null;

            var dependencies = await _db.TaskDependencies.Where(d => taskIds.Contains(d.TaskId) || taskIds.Contains(d.DependsOnTaskId)).ToListAsync();
            _db.TaskDependencies.RemoveRange(dependencies);

            var tasks = await _db.Tasks.Where(t => taskIds.Contains(t.Id)).ToListAsync();
            _db.Tasks.RemoveRange(tasks);
        }

        _db.Columns.Remove(column);
        await _db.SaveChangesAsync();
        return true;
    }
}
