using Enkl.Api.Data;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

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
            .Select(p => new PortfolioProjectDto(p.Id, p.Name, p.Key, p.StartDate, p.EndDate))
            .ToListAsync();
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
            .Select(m => new MemberDto(m.Id, m.UserId, m.User.DisplayName, m.User.EmailAddress, m.Color, m.Role, m.ReportsToId))
            .ToListAsync();

        var columns = await _db.Columns
            .Where(c => validProjectIds.Contains(c.ProjectId))
            .Select(c => new ColumnDto(c.Id, c.Name, c.Done, c.Color, c.Order))
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
