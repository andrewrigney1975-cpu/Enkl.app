using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.1: split out of PortfolioService.cs — the ProjectResourcePlaceholder
/// CRUD + org-wide resourcing-summary/role-autocomplete seam. Same OrgAdmin-only, org-ownership-
/// re-validated stance as every other Portfolio* class.
/// </summary>
public class PortfolioResourceService
{
    private readonly AppDbContext _db;

    public PortfolioResourceService(AppDbContext db)
    {
        _db = db;
    }

    /// <summary>Placeholder resourcing for one Portfolio Planner project — re-validates the owning
    /// project against the caller's org directly (not PortfolioService.ValidateProjectIdsAsync,
    /// that one's for the bulk multi-id read case only). Returns null (not an empty list) when the
    /// project itself doesn't belong to the caller's org, so the controller can tell "no resources
    /// yet" apart from "not your project" and return 404 for the latter.</summary>
    public async Task<List<ProjectResourcePlaceholderDto>?> ListResourcesAsync(Guid organisationId, Guid projectId)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return null;

        return await _db.ProjectResourcePlaceholders
            .Where(r => r.ProjectId == projectId)
            .Select(r => new ProjectResourcePlaceholderDto(r.Id, r.ProjectId, r.Role, r.UserId, r.User == null ? null : r.User.DisplayName, r.AllocatedFraction))
            .ToListAsync();
    }

    /// <summary>The Resources list also shows a project's *real* team (ProjectMembers, added via the
    /// normal Team modal), not just the manually-typed placeholder rows above — with or without an
    /// allocation set, so an active project that already has real people on it doesn't look
    /// unstaffed here just because nobody has entered a placeholder row for them too. Read-only from
    /// this endpoint's perspective (editing a real member happens through the Team modal, not here);
    /// same org-ownership re-validation and null-vs-empty-list distinction as ListResourcesAsync.</summary>
    public async Task<List<MemberDto>?> ListRealMembersAsync(Guid organisationId, Guid projectId)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return null;

        return await _db.ProjectMembers
            .Where(m => m.ProjectId == projectId)
            .Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.User.EmailAddress, m.Color, m.Role, m.AllocatedFraction, m.ReportsToId, m.IsProjectAdmin, m.User.IsActive))
            .ToListAsync();
    }

    public async Task<ProjectResourcePlaceholderDto?> AddResourceAsync(Guid organisationId, Guid projectId, CreateProjectResourcePlaceholderRequest request)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return null;

        var trimmedRole = (request.Role ?? "").Trim();
        if (trimmedRole.Length == 0) trimmedRole = "Unspecified";
        if (trimmedRole.Length > 100) trimmedRole = trimmedRole[..100];

        var userId = await ValidateOrgUserIdAsync(organisationId, request.UserId);

        var resource = new ProjectResourcePlaceholder
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            Role = trimmedRole,
            UserId = userId,
            AllocatedFraction = Math.Clamp(request.AllocatedFraction, 0, 100)
        };
        _db.ProjectResourcePlaceholders.Add(resource);
        await _db.SaveChangesAsync();

        var displayName = userId is null ? null : (await _db.Users.Where(u => u.Id == userId).Select(u => u.DisplayName).FirstOrDefaultAsync());
        return new ProjectResourcePlaceholderDto(resource.Id, resource.ProjectId, resource.Role, resource.UserId, displayName, resource.AllocatedFraction);
    }

    /// <summary>Edits an existing placeholder row's role/person/allocation in place — the Resources
    /// overlay's rows are editable, not just add-then-remove (see modals/portfolio-planner.js).</summary>
    public async Task<ProjectResourcePlaceholderDto?> UpdateResourceAsync(Guid organisationId, Guid projectId, Guid resourceId, UpdateProjectResourcePlaceholderRequest request)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return null;

        var resource = await _db.ProjectResourcePlaceholders.FirstOrDefaultAsync(r => r.Id == resourceId && r.ProjectId == projectId);
        if (resource is null) return null;

        var trimmedRole = (request.Role ?? "").Trim();
        if (trimmedRole.Length == 0) trimmedRole = "Unspecified";
        if (trimmedRole.Length > 100) trimmedRole = trimmedRole[..100];

        resource.Role = trimmedRole;
        resource.UserId = await ValidateOrgUserIdAsync(organisationId, request.UserId);
        resource.AllocatedFraction = Math.Clamp(request.AllocatedFraction, 0, 100);
        await _db.SaveChangesAsync();

        var displayName = resource.UserId is null ? null : (await _db.Users.Where(u => u.Id == resource.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync());
        return new ProjectResourcePlaceholderDto(resource.Id, resource.ProjectId, resource.Role, resource.UserId, displayName, resource.AllocatedFraction);
    }

    public async Task<bool> RemoveResourceAsync(Guid organisationId, Guid projectId, Guid resourceId)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return false;

        var resource = await _db.ProjectResourcePlaceholders.FirstOrDefaultAsync(r => r.Id == resourceId && r.ProjectId == projectId);
        if (resource is null) return false;

        _db.ProjectResourcePlaceholders.Remove(resource);
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>A supplied UserId must belong to the caller's own org — silently drops to null rather
    /// than rejecting the whole request over a foreign-org id.</summary>
    private async Task<Guid?> ValidateOrgUserIdAsync(Guid organisationId, Guid? userId)
    {
        if (userId is not { } id) return null;
        return await _db.Users.AnyAsync(u => u.Id == id && u.OrganisationId == organisationId) ? id : null;
    }

    /// <summary>The distinct, non-blank Role values already in use across every ProjectMember in the
    /// caller's org — backs the Resources overlay's role autocomplete (see CreateProjectResourcePlaceholderRequest's
    /// doc comment: this is a suggestion list, not an enforced vocabulary).</summary>
    public async Task<List<string>> ListDistinctRolesAsync(Guid organisationId)
    {
        return await _db.ProjectMembers
            .Where(m => m.Project.OrganisationId == organisationId && m.Role != null && m.Role != "")
            .Select(m => m.Role!)
            .Distinct()
            .OrderBy(r => r)
            .ToListAsync();
    }

    /// <summary>
    /// Backs the Portfolio Dashboard's Resourcing section. Deliberately org-wide, not scoped to any
    /// client-supplied project id list — unlike every other method in this class, there's no
    /// "selected projects" concept here at all, because placeholder resources only ever exist on
    /// inactive projects and the Dashboard's own project picker deliberately excludes those (see
    /// portfolio-dashboard.js's renderProjectPicker), so scoping this to that picker's selection
    /// would make it permanently empty. Two independent per-user sums (real ProjectMember
    /// allocations across every real project the org has, and placeholder allocations across every
    /// draft project) are computed and merged in memory rather than attempted as one SQL query,
    /// since they come from two unrelated tables with no shared join key besides UserId.
    /// </summary>
    public async Task<PortfolioResourcingSummaryDto> GetResourcingSummaryAsync(Guid organisationId)
    {
        var realTotals = await _db.ProjectMembers
            .Where(m => m.Project.OrganisationId == organisationId && m.AllocatedFraction != null)
            .GroupBy(m => new { m.UserId, m.User.DisplayName })
            .Select(g => new { g.Key.UserId, g.Key.DisplayName, Total = g.Sum(x => x.AllocatedFraction!.Value) })
            .ToListAsync();

        var placeholderTotals = await _db.ProjectResourcePlaceholders
            .Where(r => r.Project.OrganisationId == organisationId && r.UserId != null)
            .GroupBy(r => new { UserId = r.UserId!.Value, DisplayName = r.User!.DisplayName })
            .Select(g => new { g.Key.UserId, g.Key.DisplayName, Total = g.Sum(x => x.AllocatedFraction) })
            .ToListAsync();

        var byUser = new Dictionary<Guid, (string DisplayName, int Real, int Placeholder)>();
        foreach (var r in realTotals)
        {
            byUser[r.UserId] = (r.DisplayName, r.Total, 0);
        }
        foreach (var p in placeholderTotals)
        {
            var existing = byUser.TryGetValue(p.UserId, out var ex) ? ex : (DisplayName: p.DisplayName, Real: 0, Placeholder: 0);
            byUser[p.UserId] = (existing.DisplayName, existing.Real, p.Total);
        }

        var userAllocations = byUser
            .Select(kv => new UserAllocationDto(kv.Key, kv.Value.DisplayName, kv.Value.Real, kv.Value.Placeholder))
            .OrderByDescending(u => u.RealAllocationTotal + u.PlaceholderAllocationTotal)
            .ToList();

        var unfilledRoles = await _db.ProjectResourcePlaceholders
            .Where(r => r.Project.OrganisationId == organisationId && r.UserId == null)
            .Select(r => new UnfilledPlaceholderDto(r.Id, r.ProjectId, r.Project.Name, r.Project.Key, r.Role, r.AllocatedFraction))
            .ToListAsync();

        return new PortfolioResourcingSummaryDto(unfilledRoles, userAllocations);
    }
}
