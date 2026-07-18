using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// Create: any project member. Author is NEVER accepted from the client — always derived from the
/// caller's own ProjectMembers row (§4's standing "never trust the client's id list" rule); if the
/// caller has no such row (the Org-Admin-without-membership edge case), there's no valid author to
/// stamp and creation is rejected.
///
/// Update: author-only — filtered by AuthorId == caller's own ProjectMember.Id in the query itself,
/// same "return null rather than throw a separate 403" shape as ToDoService's owner-only checks
/// (a comment that isn't the caller's own simply doesn't match).
///
/// Delete: author OR Project Admin OR Org Admin — the admin half mirrors
/// ProjectAdminAuthorizationHandler's own live-DB check (IsProjectAdmin row, or an Org Admin whose
/// own OrganisationId matches the project's), inlined here since the controller's class-level policy
/// is only ProjectMember, not ProjectAdmin.
/// </summary>
public class TaskCommentService
{
    private readonly AppDbContext _db;

    public TaskCommentService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<TaskCommentDto?> CreateAsync(Guid callerUserId, Guid projectId, Guid taskId, CreateTaskCommentRequest request)
    {
        var taskExists = await _db.Tasks.AnyAsync(t => t.Id == taskId && t.ProjectId == projectId);
        if (!taskExists) return null;

        var member = await _db.ProjectMembers.Include(m => m.User)
            .FirstOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == callerUserId);
        if (member is null)
        {
            throw new ApiValidationException("You must be a member of this project to comment.");
        }

        var text = (request.Text ?? "").Trim();
        if (text.Length == 0)
        {
            throw new ApiValidationException("Comment text is required.");
        }

        var comment = new TaskComment
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            Text = text,
            DateCreated = DateTime.UtcNow,
            AuthorId = member.Id,
            AuthorName = member.User.DisplayName
        };
        _db.TaskComments.Add(comment);
        await _db.SaveChangesAsync();
        return ToDto(comment);
    }

    public async Task<TaskCommentDto?> UpdateAsync(Guid callerUserId, Guid projectId, Guid taskId, Guid commentId, UpdateTaskCommentRequest request)
    {
        var member = await _db.ProjectMembers.FirstOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == callerUserId);
        if (member is null) return null;

        var comment = await _db.TaskComments
            .FirstOrDefaultAsync(c => c.Id == commentId && c.TaskId == taskId && c.Task.ProjectId == projectId && c.AuthorId == member.Id);
        if (comment is null) return null;

        var text = (request.Text ?? "").Trim();
        if (text.Length == 0)
        {
            throw new ApiValidationException("Comment text is required.");
        }
        comment.Text = text;
        await _db.SaveChangesAsync();
        return ToDto(comment);
    }

    public async Task<bool> DeleteAsync(Guid callerUserId, Guid projectId, Guid taskId, Guid commentId, bool callerClaimsOrgAdmin, Guid? callerOrgId)
    {
        var comment = await _db.TaskComments
            .FirstOrDefaultAsync(c => c.Id == commentId && c.TaskId == taskId && c.Task.ProjectId == projectId);
        if (comment is null) return false;

        var member = await _db.ProjectMembers.AsNoTracking()
            .FirstOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == callerUserId);
        var isAuthor = member is not null && comment.AuthorId == member.Id;
        var isAdmin = (member?.IsProjectAdmin ?? false) || await IsOrgAdminForProjectAsync(projectId, callerClaimsOrgAdmin, callerOrgId);

        if (!isAuthor && !isAdmin) return false;

        _db.TaskComments.Remove(comment);
        await _db.SaveChangesAsync();
        return true;
    }

    private async Task<bool> IsOrgAdminForProjectAsync(Guid projectId, bool callerClaimsOrgAdmin, Guid? callerOrgId)
    {
        if (!callerClaimsOrgAdmin || callerOrgId is null) return false;
        var projectOrgId = await _db.Projects.AsNoTracking()
            .Where(p => p.Id == projectId).Select(p => (Guid?)p.OrganisationId).FirstOrDefaultAsync();
        return projectOrgId is not null && projectOrgId == callerOrgId;
    }

    private static TaskCommentDto ToDto(TaskComment c) => new(c.Id, c.Text, c.DateCreated, c.AuthorId, c.AuthorName);
}
