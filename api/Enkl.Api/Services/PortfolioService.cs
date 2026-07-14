using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>Result of UpdateProjectActiveAsync — a nullable/tri-state bool would be less
/// self-documenting at every call site.</summary>
public enum PortfolioActivationResult { Ok, NotFound, MissingDates }

/// <summary>
/// Backs the Org-Admin-only Portfolio Dashboard — the first feature in this API where an Org Admin
/// can pull data from projects they aren't necessarily a *member* of (every other endpoint is
/// [Authorize(Policy = "ProjectMember")]). Every method here takes the caller's OrganisationId and
/// independently re-validates every requested project id against it before touching any data — a
/// project id that doesn't belong to the caller's own org is silently dropped from the result, never
/// surfaced as a distinguishable error, so a client can't use this to probe whether some other org's
/// project id exists. `validProjectIds` (re-derived from the DB, never the raw request) is the only
/// thing every query below is scoped by.
/// </summary>
public class PortfolioService
{
    private readonly AppDbContext _db;

    public PortfolioService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<List<PortfolioProjectDto>> ListProjectsAsync(Guid organisationId)
    {
        return await _db.Projects
            .Where(p => p.OrganisationId == organisationId)
            .OrderBy(p => p.Name)
            .Select(p => new PortfolioProjectDto(p.Id, p.Name, p.Key, p.StartDate, p.EndDate, p.Priority, p.IsActive, p.CategoryId))
            .ToListAsync();
    }

    /// <summary>
    /// Creates a Portfolio-Planner placeholder project. Deliberately does NOT add a ProjectMember row
    /// and does NOT mint/return a fresh JWT, unlike ProjectService.CreateAsync — an Org Admin sketching
    /// out a portfolio of activities isn't necessarily a member of every one of them, mirroring why
    /// UpdateProjectDatesAsync below already bypasses ProjectsController's ProjectMember-gated PUT.
    /// IsActive is always false here; it can only ever become true via UpdateProjectActiveAsync, once
    /// both dates are set.
    /// </summary>
    public async Task<PortfolioProjectDto> CreateProjectAsync(Guid organisationId, CreatePortfolioProjectRequest request)
    {
        var name = string.IsNullOrWhiteSpace(request.Name) ? "Untitled Project" : request.Name.Trim();
        var requestedKey = ProjectKeyResolver.DeriveKey(request.Key, name);
        var uniqueKey = await ProjectKeyResolver.ResolveUniqueKeyAsync(_db, requestedKey, organisationId);

        // A supplied categoryId must belong to the caller's own org, same re-validation stance as
        // every other id this class ever accepts from a client — a foreign-org id is silently dropped
        // to null rather than rejected with a distinguishable error.
        Guid? categoryId = null;
        if (request.CategoryId is Guid catId && await _db.PortfolioCategories.AnyAsync(c => c.Id == catId && c.OrganisationId == organisationId))
        {
            categoryId = catId;
        }

        var priority = string.IsNullOrWhiteSpace(request.Priority) ? "medium" : request.Priority;

        var now = DateTime.UtcNow;
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = name,
            Key = uniqueKey,
            Priority = priority,
            IsActive = false,
            CategoryId = categoryId,
            StartDate = request.StartDate,
            EndDate = request.EndDate,
            DateCreated = now,
            DateLastModified = now,
            TaskCounter = 1
        };
        _db.Projects.Add(project);
        await _db.SaveChangesAsync();

        return new PortfolioProjectDto(project.Id, project.Name, project.Key, project.StartDate, project.EndDate, project.Priority, project.IsActive, project.CategoryId);
    }

    public async Task<PortfolioAggregateDto> GetAggregateAsync(Guid organisationId, List<Guid> requestedProjectIds)
    {
        var validProjectIds = await ValidateProjectIdsAsync(organisationId, requestedProjectIds);
        var orgUserCount = await CountOrgUsersAsync(organisationId);

        if (validProjectIds.Count == 0)
        {
            return new PortfolioAggregateDto(
                new(), new(), new(), new(), new(), new(),
                StartDate: null, EndDate: null,
                OrgUserCount: orgUserCount, PrincipleCount: 0, ObjectiveCount: 0, DocumentCount: 0, RetrospectiveCount: 0);
        }

        var members = await _db.ProjectMembers
            .Where(m => validProjectIds.Contains(m.ProjectId))
            .Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.User.EmailAddress, m.Color, m.Role, m.AllocatedFraction, m.ReportsToId))
            .ToListAsync();

        var columns = await _db.Columns
            .Where(c => validProjectIds.Contains(c.ProjectId))
            .Select(c => new ColumnDto(c.Id, c.Name, c.Done, c.Color, c.Order, c.Cap))
            .ToListAsync();

        // Materialize entities first, then map in-memory (ProjectService.ToTaskDto isn't EF
        // Core-translatable) — same two-step shape ProjectService.GetProjectDetailAsync itself uses.
        var taskEntities = await _db.Tasks
            .Where(t => validProjectIds.Contains(t.ProjectId))
            .Include(t => t.Dependencies)
            .Include(t => t.AuditLog)
            .ToListAsync();
        var tasks = taskEntities.Select(ProjectService.ToTaskDto).ToList();

        var releases = await _db.Releases
            .Where(r => validProjectIds.Contains(r.ProjectId))
            .Select(r => new ReleaseDto(r.Id, r.Name, r.Status, r.OwnerId, r.StartDate, r.EndDate))
            .ToListAsync();

        var risks = await _db.Risks
            .Where(r => validProjectIds.Contains(r.ProjectId))
            .Select(r => new PortfolioRiskDto(
                r.Id, r.Key, r.Title, r.Description, r.Likelihood, r.Impact, r.Mitigations,
                r.OwnerId, r.TaskId, r.Status, r.DateToClose, r.DateClosed,
                r.ProjectId, r.Project.Key))
            .ToListAsync();

        var decisions = await _db.Decisions
            .Where(d => validProjectIds.Contains(d.ProjectId))
            .Select(d => new DecisionDto(
                d.Id, d.Key, d.Title, d.Description, d.Type, d.Status, d.Outcome, d.OwnerId, d.Approver, d.TaskId,
                d.Documents.Select(x => x.DocumentId).ToList(), d.Risks.Select(x => x.RiskId).ToList(),
                d.Principles.Select(x => x.PrincipleId).ToList(), d.Objectives.Select(x => x.ObjectiveId).ToList()))
            .ToListAsync();

        var projectRanges = await _db.Projects
            .Where(p => validProjectIds.Contains(p.Id))
            .Select(p => new { p.StartDate, p.EndDate })
            .ToListAsync();
        var starts = projectRanges.Where(p => p.StartDate.HasValue).Select(p => p.StartDate!.Value).ToList();
        var ends = projectRanges.Where(p => p.EndDate.HasValue).Select(p => p.EndDate!.Value).ToList();

        var principleCount = await _db.Principles.CountAsync(p => validProjectIds.Contains(p.ProjectId));
        var objectiveCount = await _db.Objectives.CountAsync(o => validProjectIds.Contains(o.ProjectId));
        var documentCount = await _db.Documents.CountAsync(d => validProjectIds.Contains(d.ProjectId));
        var retrospectiveCount = await _db.Retrospectives.CountAsync(r => validProjectIds.Contains(r.ProjectId));

        return new PortfolioAggregateDto(
            members, columns, tasks, releases, risks, decisions,
            StartDate: starts.Count > 0 ? starts.Min() : null,
            EndDate: ends.Count > 0 ? ends.Max() : null,
            OrgUserCount: orgUserCount,
            PrincipleCount: principleCount, ObjectiveCount: objectiveCount,
            DocumentCount: documentCount, RetrospectiveCount: retrospectiveCount);
    }

    public async Task<PortfolioActivityDto> GetActivityAsync(Guid organisationId, List<Guid> requestedProjectIds, DateOnly start, DateOnly end)
    {
        var validProjectIds = await ValidateProjectIdsAsync(organisationId, requestedProjectIds);
        if (validProjectIds.Count == 0) return new PortfolioActivityDto(new(), new(), new());

        // DateTime.Kind must be Utc — Tasks' DateCreated/DateLastModified/DateDone columns are
        // `timestamp with time zone`, and Npgsql refuses to bind a Kind=Unspecified DateTime against them.
        var startDt = DateTime.SpecifyKind(start.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc);
        // Half-open [start, endExclusive) so the end date's own day is fully included, same
        // convention vendor-portal's own /dashboard/activity endpoint uses.
        var endExclusiveDt = DateTime.SpecifyKind(end.AddDays(1).ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc);

        var created = await _db.Tasks
            .Where(t => validProjectIds.Contains(t.ProjectId) && t.DateCreated >= startDt && t.DateCreated < endExclusiveDt)
            .GroupBy(t => t.DateCreated.Date)
            .Select(g => new PortfolioActivityPointDto(DateOnly.FromDateTime(g.Key), g.Count()))
            .ToListAsync();

        // "Edited" excludes a task's own creation timestamp (DateLastModified == DateCreated at
        // insert time) — otherwise every created task would also silently count as "edited" on the
        // same day, matching vendor-portal's identical exclusion.
        var edited = await _db.Tasks
            .Where(t => validProjectIds.Contains(t.ProjectId) && t.DateLastModified >= startDt && t.DateLastModified < endExclusiveDt && t.DateLastModified != t.DateCreated)
            .GroupBy(t => t.DateLastModified.Date)
            .Select(g => new PortfolioActivityPointDto(DateOnly.FromDateTime(g.Key), g.Count()))
            .ToListAsync();

        var done = await _db.Tasks
            .Where(t => validProjectIds.Contains(t.ProjectId) && t.DateDone != null && t.DateDone >= startDt && t.DateDone < endExclusiveDt)
            .GroupBy(t => t.DateDone!.Value.Date)
            .Select(g => new PortfolioActivityPointDto(DateOnly.FromDateTime(g.Key), g.Count()))
            .ToListAsync();

        return new PortfolioActivityDto(
            created.OrderBy(p => p.Date).ToList(),
            edited.OrderBy(p => p.Date).ToList(),
            done.OrderBy(p => p.Date).ToList());
    }

    /// <summary>
    /// Backs the Timeline chart's click-to-edit modal and drag-to-schedule bars. Deliberately its own
    /// endpoint rather than reusing ProjectsController's PUT /api/projects/{id} — that one requires
    /// ProjectMember (see ProjectsController.cs), which an Org Admin scheduling a project they don't
    /// personally belong to would fail. OrgAdmin + org-ownership check only, same as every other
    /// method here. Returns false (not found / wrong org) without revealing which — same
    /// no-enumeration-oracle stance as ValidateProjectIdsAsync below.
    /// </summary>
    public async Task<bool> UpdateProjectDatesAsync(Guid organisationId, Guid projectId, DateOnly? startDate, DateOnly? endDate)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (project is null) return false;

        project.StartDate = startDate;
        project.EndDate = endDate;
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// The only place Project.IsActive is ever written. Deactivating (true -> false) never needs
    /// dates; activating (false -> true) is rejected unless the row's CURRENTLY PERSISTED StartDate
    /// and EndDate are both already set — never trusting a client-supplied dates+active combo in the
    /// same request, since that would let a hand-crafted request activate a dateless project.
    /// </summary>
    public async Task<PortfolioActivationResult> UpdateProjectActiveAsync(Guid organisationId, Guid projectId, bool isActive)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (project is null) return PortfolioActivationResult.NotFound;

        if (isActive && (project.StartDate is null || project.EndDate is null))
        {
            return PortfolioActivationResult.MissingDates;
        }

        project.IsActive = isActive;
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return PortfolioActivationResult.Ok;
    }

    /// <summary>
    /// Re-validates BOTH the project id and the category id against the caller's org before linking
    /// them — a request pairing a legitimate own-org project with another org's category id fails
    /// closed (treated as not-found), never silently cross-linked.
    /// </summary>
    public async Task<bool> UpdateProjectCategoryAsync(Guid organisationId, Guid projectId, Guid? categoryId)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (project is null) return false;

        if (categoryId is Guid catId)
        {
            var categoryExists = await _db.PortfolioCategories.AnyAsync(c => c.Id == catId && c.OrganisationId == organisationId);
            if (!categoryExists) return false;
        }

        project.CategoryId = categoryId;
        project.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<List<PortfolioCategoryDto>> ListCategoriesAsync(Guid organisationId)
    {
        return await _db.PortfolioCategories
            .Where(c => c.OrganisationId == organisationId)
            .OrderBy(c => c.SortOrder)
            .Select(c => new PortfolioCategoryDto(c.Id, c.Name, c.SortOrder))
            .ToListAsync();
    }

    public async Task<PortfolioCategoryDto> CreateCategoryAsync(Guid organisationId, string name)
    {
        var trimmedName = string.IsNullOrWhiteSpace(name) ? "Untitled Category" : name.Trim();
        var maxSortOrder = await _db.PortfolioCategories.Where(c => c.OrganisationId == organisationId)
            .Select(c => (int?)c.SortOrder).MaxAsync() ?? -1;

        var category = new PortfolioCategory
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = trimmedName,
            SortOrder = maxSortOrder + 1
        };
        _db.PortfolioCategories.Add(category);
        await _db.SaveChangesAsync();
        return new PortfolioCategoryDto(category.Id, category.Name, category.SortOrder);
    }

    public async Task<PortfolioCategoryDto?> UpdateCategoryAsync(Guid organisationId, Guid categoryId, string name)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return null;

        category.Name = string.IsNullOrWhiteSpace(name) ? category.Name : name.Trim();
        await _db.SaveChangesAsync();
        return new PortfolioCategoryDto(category.Id, category.Name, category.SortOrder);
    }

    /// <summary>Deleting a category is a pure DB-level SetNull cascade (see ProjectConfiguration) —
    /// no application-side fan-out needed to un-categorize its projects.</summary>
    public async Task<bool> DeleteCategoryAsync(Guid organisationId, Guid categoryId)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return false;

        _db.PortfolioCategories.Remove(category);
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<bool> UpdateCategorySortOrderAsync(Guid organisationId, Guid categoryId, int sortOrder)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return false;

        category.SortOrder = sortOrder;
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>Placeholder resourcing for one Portfolio Planner project — re-validates the owning
    /// project against the caller's org the same way UpdateProjectDatesAsync does, not
    /// ValidateProjectIdsAsync (that one's for the bulk multi-id read case only). Returns null (not an
    /// empty list) when the project itself doesn't belong to the caller's org, so the controller can
    /// tell "no resources yet" apart from "not your project" and return 404 for the latter.</summary>
    public async Task<List<ProjectResourcePlaceholderDto>?> ListResourcesAsync(Guid organisationId, Guid projectId)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId && p.OrganisationId == organisationId);
        if (!projectExists) return null;

        return await _db.ProjectResourcePlaceholders
            .Where(r => r.ProjectId == projectId)
            .Select(r => new ProjectResourcePlaceholderDto(r.Id, r.ProjectId, r.Role, r.UserId, r.User == null ? null : r.User.DisplayName, r.AllocatedFraction))
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

    /// <summary>A supplied UserId must belong to the caller's own org — same silently-drop-to-null
    /// stance CreateProjectAsync already uses for CategoryId, rather than rejecting the whole
    /// request over a foreign-org id.</summary>
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

    /// <summary>The one place a client-supplied project id list is trusted at all: re-derived
    /// against the caller's own OrganisationId, so every subsequent query in this class only ever
    /// touches project ids proven to belong to the caller's org.</summary>
    private async Task<List<Guid>> ValidateProjectIdsAsync(Guid organisationId, List<Guid> requestedProjectIds)
    {
        if (requestedProjectIds.Count == 0) return new List<Guid>();
        return await _db.Projects
            .Where(p => requestedProjectIds.Contains(p.Id) && p.OrganisationId == organisationId)
            .Select(p => p.Id)
            .ToListAsync();
    }

    private async Task<int> CountOrgUsersAsync(Guid organisationId) =>
        await _db.Users.CountAsync(u => u.OrganisationId == organisationId && u.IsActive);
}
