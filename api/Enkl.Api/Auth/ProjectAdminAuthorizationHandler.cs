using Enkl.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Auth;

/// <summary>
/// Gates the Project Administrator role: adding/editing/deleting columns, changing a project's App
/// Settings, managing its Workflow, and managing its team members (including who else is a Project
/// Admin). Reads the route's {projectId} and checks a LIVE "ProjectMembers" row for
/// IsProjectAdmin = true, the same "server-side re-validation, never trust the client's embedded
/// claim" idiom ProjectMemberAuthorizationHandler already uses (ARCHITECTURE-REVIEW.md finding 2.4) —
/// the JWT's "projects" claim does carry an IsProjectAdmin flag per entry (JwtTokenService.cs), but
/// only for the frontend's own client-side "what to show" decisions (api.js's isProjectAdmin()),
/// never for authorization itself, so a promotion/demotion takes effect on the very next request
/// rather than waiting for the next login/token refresh.
///
/// An Org Admin also succeeds here even without a ProjectMembers row at all — Org Admins get every
/// Project Admin capability across their whole org's projects, on top of their org-only affordances.
/// The "orgAdmin" claim alone is never trusted for this (same no-trust-the-client's-id-list rule as
/// the Portfolio cross-org-isolation pattern, CLAUDE.md §4): the project's own OrganisationId is
/// re-queried live and compared against the caller's "orgId" claim, so an Org Admin from a different
/// org can't reach a project outside their org this way.
///
/// Registered as a Singleton (Program.cs — IAuthorizationHandler instances are shared across
/// requests), so AppDbContext (scoped) can't be constructor-injected directly; IServiceScopeFactory
/// resolves a fresh scoped instance per check instead, matching ProjectMemberAuthorizationHandler.
/// </summary>
public class ProjectAdminAuthorizationHandler : AuthorizationHandler<ProjectAdminRequirement>
{
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IServiceScopeFactory _scopeFactory;

    public ProjectAdminAuthorizationHandler(IHttpContextAccessor httpContextAccessor, IServiceScopeFactory scopeFactory)
    {
        _httpContextAccessor = httpContextAccessor;
        _scopeFactory = scopeFactory;
    }

    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, ProjectAdminRequirement requirement)
    {
        var httpContext = _httpContextAccessor.HttpContext;
        var routeProjectId = httpContext?.Request.RouteValues["projectId"] as string;

        if (routeProjectId is null || !Guid.TryParse(routeProjectId, out var projectId))
        {
            return;
        }

        var userId = context.User.TryUserId();
        if (userId is null)
        {
            return;
        }

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var isProjectAdmin = await db.ProjectMembers
            .AsNoTracking()
            .AnyAsync(m => m.ProjectId == projectId && m.UserId == userId && m.IsProjectAdmin);

        if (isProjectAdmin)
        {
            context.Succeed(requirement);
            return;
        }

        if (context.User.HasClaim("orgAdmin", "true"))
        {
            var callerOrgId = context.User.TryOrgId();
            if (callerOrgId is not null)
            {
                var projectOrgId = await db.Projects
                    .AsNoTracking()
                    .Where(p => p.Id == projectId)
                    .Select(p => (Guid?)p.OrganisationId)
                    .FirstOrDefaultAsync();

                if (projectOrgId is not null && projectOrgId == callerOrgId)
                {
                    context.Succeed(requirement);
                }
            }
        }
    }
}
