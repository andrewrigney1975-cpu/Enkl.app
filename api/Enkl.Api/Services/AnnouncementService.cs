using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// Org-Admin CRUD is always Scope="org" + OrganisationId/CreatedByUserId re-derived from the
/// caller's own JWT claims (never client-supplied) — same cross-org-isolation discipline as
/// PortfolioCategoryService. Vendor-authored rows (Scope="orgs"/"platform", CreatedByVendor=true)
/// are written directly by the standalone Vendor Portal via raw SQL against this same table — this
/// service only ever produces/manages Scope="org" rows, it has no vendor-authoring path of its own.
/// </summary>
public class AnnouncementService
{
    private readonly AppDbContext _db;

    public AnnouncementService(AppDbContext db)
    {
        _db = db;
    }

    // ---- Org-Admin management (Scope="org" only) ----

    public async Task<List<AnnouncementDto>> ListForOrgAsync(Guid organisationId)
    {
        return await _db.Announcements.AsNoTracking()
            .Where(a => a.OrganisationId == organisationId)
            .OrderByDescending(a => a.DateCreated)
            .Select(a => new AnnouncementDto(a.Id, a.Scope, a.Title, a.Body, a.Kind, a.StartAt, a.EndAt, a.CreatedByVendor, a.DateCreated))
            .ToListAsync();
    }

    public async Task<AnnouncementDto> CreateAsync(Guid organisationId, Guid callerUserId, CreateAnnouncementRequest request)
    {
        var title = (request.Title ?? "").Trim();
        if (title.Length == 0) throw new ApiValidationException("Title is required.");
        if (request.StartAt == default) throw new ApiValidationException("A valid start date/time is required.");
        var kind = NormalizeKind(request.Kind);

        var announcement = new Announcement
        {
            Id = Guid.NewGuid(),
            Scope = "org",
            OrganisationId = organisationId,
            Title = title,
            Body = (request.Body ?? "").Trim(),
            Kind = kind,
            StartAt = request.StartAt,
            EndAt = request.EndAt,
            CreatedByUserId = callerUserId,
            CreatedByVendor = false,
            DateCreated = DateTime.UtcNow,
            DateLastModified = DateTime.UtcNow
        };
        _db.Announcements.Add(announcement);
        await _db.SaveChangesAsync();
        return new AnnouncementDto(announcement.Id, announcement.Scope, announcement.Title, announcement.Body, announcement.Kind, announcement.StartAt, announcement.EndAt, announcement.CreatedByVendor, announcement.DateCreated);
    }

    public async Task<AnnouncementDto?> UpdateAsync(Guid organisationId, Guid announcementId, UpdateAnnouncementRequest request)
    {
        var announcement = await _db.Announcements.FirstOrDefaultAsync(a => a.Id == announcementId && a.OrganisationId == organisationId);
        if (announcement is null) return null;

        var title = (request.Title ?? "").Trim();
        if (title.Length == 0) throw new ApiValidationException("Title is required.");
        if (request.StartAt == default) throw new ApiValidationException("A valid start date/time is required.");

        announcement.Title = title;
        announcement.Body = (request.Body ?? "").Trim();
        announcement.Kind = NormalizeKind(request.Kind);
        announcement.StartAt = request.StartAt;
        announcement.EndAt = request.EndAt;
        announcement.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return new AnnouncementDto(announcement.Id, announcement.Scope, announcement.Title, announcement.Body, announcement.Kind, announcement.StartAt, announcement.EndAt, announcement.CreatedByVendor, announcement.DateCreated);
    }

    public async Task<bool> DeleteAsync(Guid organisationId, Guid announcementId)
    {
        var announcement = await _db.Announcements.FirstOrDefaultAsync(a => a.Id == announcementId && a.OrganisationId == organisationId);
        if (announcement is null) return false;

        _db.Announcements.Remove(announcement);
        await _db.SaveChangesAsync();
        return true;
    }

    // ---- Any signed-in user: what's currently active and relevant to them ----

    /// <summary>Resolves all three Scope shapes at once (own-org, targeted-org-list, platform-wide),
    /// filtered to the active window (StartAt already passed, EndAt not yet passed or absent), tagged
    /// with whether THIS caller has already acknowledged it. Never trusts a client-supplied org id —
    /// organisationId here is always the caller's own, from their JWT claim.</summary>
    public async Task<List<ActiveAnnouncementDto>> GetActiveForUserAsync(Guid organisationId, Guid callerUserId)
    {
        var now = DateTime.UtcNow;

        var relevant = await _db.Announcements.AsNoTracking()
            .Where(a => a.StartAt <= now && (a.EndAt == null || a.EndAt >= now))
            .Where(a => a.Scope == "platform"
                || (a.Scope == "org" && a.OrganisationId == organisationId)
                || (a.Scope == "orgs" && a.TargetOrganisations.Any(t => t.OrganisationId == organisationId)))
            .OrderByDescending(a => a.StartAt)
            .ToListAsync();

        if (relevant.Count == 0) return new List<ActiveAnnouncementDto>();

        var relevantIds = relevant.Select(a => a.Id).ToList();
        var acknowledgedIds = await _db.AnnouncementAcknowledgements.AsNoTracking()
            .Where(ack => ack.UserId == callerUserId && relevantIds.Contains(ack.AnnouncementId))
            .Select(ack => ack.AnnouncementId)
            .ToListAsync();
        var acknowledgedSet = acknowledgedIds.ToHashSet();

        return relevant
            .Select(a => new ActiveAnnouncementDto(a.Id, a.Title, a.Body, a.Kind, a.StartAt, a.EndAt, acknowledgedSet.Contains(a.Id)))
            .ToList();
    }

    /// <summary>Idempotent — calling this twice for the same (announcement, user) pair is a no-op the
    /// second time, matching the unique index on AnnouncementAcknowledgements.</summary>
    public async Task AcknowledgeAsync(Guid callerUserId, Guid announcementId)
    {
        var exists = await _db.AnnouncementAcknowledgements
            .AnyAsync(ack => ack.AnnouncementId == announcementId && ack.UserId == callerUserId);
        if (exists) return;

        _db.AnnouncementAcknowledgements.Add(new AnnouncementAcknowledgement
        {
            Id = Guid.NewGuid(),
            AnnouncementId = announcementId,
            UserId = callerUserId,
            AcknowledgedAt = DateTime.UtcNow
        });
        await _db.SaveChangesAsync();
    }

    private static string NormalizeKind(string? kind) =>
        kind == "disruption" ? "disruption" : "announcement";
}
