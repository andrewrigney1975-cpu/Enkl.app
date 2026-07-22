using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class ReleaseService
{
    private readonly AppDbContext _db;

    public ReleaseService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<ReleaseDto?> CreateAsync(Guid projectId, CreateReleaseRequest request)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId);
        if (!projectExists) return null;

        var release = new Release
        {
            Id = Guid.NewGuid(), ProjectId = projectId, Name = request.Name,
            Status = request.Status is "pending" or "in_progress" or "deployed" ? request.Status : "pending",
            OwnerId = request.OwnerId, StartDate = request.StartDate, EndDate = request.EndDate,
            DateCreated = DateTime.UtcNow, DateLastModified = DateTime.UtcNow
        };
        _db.Releases.Add(release);
        await _db.SaveChangesAsync();
        return ToDto(release);
    }

    public async Task<ReleaseDto?> UpdateAsync(Guid projectId, Guid releaseId, UpdateReleaseRequest request)
    {
        var release = await _db.Releases.FirstOrDefaultAsync(r => r.Id == releaseId && r.ProjectId == projectId);
        if (release is null) return null;

        release.Name = request.Name;
        release.Status = request.Status is "pending" or "in_progress" or "deployed" ? request.Status : "pending";
        release.OwnerId = request.OwnerId;
        release.StartDate = request.StartDate;
        release.EndDate = request.EndDate;
        release.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return ToDto(release);
    }

    /// <summary>The ONLY write path for ReleaseNotes — gated by ReleasesController's own
    /// [Authorize(Policy = "ProjectAdmin")] on this one action, never via CreateAsync/UpdateAsync
    /// above (see root CLAUDE.md §7's "one-endpoint-owns-the-field" convention).</summary>
    public async Task<ReleaseDto?> UpdateNotesAsync(Guid projectId, Guid releaseId, UpdateReleaseNotesRequest request)
    {
        var release = await _db.Releases.FirstOrDefaultAsync(r => r.Id == releaseId && r.ProjectId == projectId);
        if (release is null) return null;

        release.ReleaseNotes = request.ReleaseNotes;
        release.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return ToDto(release);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid releaseId)
    {
        var release = await _db.Releases.FirstOrDefaultAsync(r => r.Id == releaseId && r.ProjectId == projectId);
        if (release is null) return false;

        // Mirrors mutations.js's deleteRelease: unassign referencing tasks rather than blocking
        // the delete (Task.ReleaseId is already configured ON DELETE SET NULL, so removing the
        // row is enough — no explicit unassign loop needed).
        _db.Releases.Remove(release);
        await _db.SaveChangesAsync();
        return true;
    }

    private static ReleaseDto ToDto(Release r) => new(r.Id, r.Name, r.Status, r.OwnerId, r.StartDate, r.EndDate, r.ReleaseNotes);
}
