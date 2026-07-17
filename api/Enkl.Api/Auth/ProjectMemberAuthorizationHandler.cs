using Enkl.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Auth;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.4: reads the route's {projectId} and checks it against a LIVE
/// "ProjectMembers" row, not the JWT's baked-in "projects" claim — that claim is minted once at
/// login and never re-queried, so removing a user from a project used to have no effect until their
/// token expired/they logged in again (up to the full 8h JWT lifetime), a real staleness window for
/// a governance tool where offboarding access changes are sometimes urgent. This mirrors the same
/// "server-side re-validation, never trust the client's embedded claim" idiom §1/§4 already establish
/// for cross-org isolation — the JWT is still trusted for WHO the caller is (userId/orgId claims,
/// checked elsewhere), just not for what they're currently a member of.
///
/// An Org Admin also succeeds here even without a ProjectMembers row at all — a Project Admin is
/// inherently also a project member (IsProjectAdmin is a column ON the ProjectMembers row), so an
/// Org Admin who gets full Project Admin capabilities (see ProjectAdminAuthorizationHandler) needs
/// this same bypass or they'd never reach those admin-gated routes to begin with (many are nested
/// under a ProjectMember-gated route group). Same live re-verification against the project's own
/// OrganisationId as ProjectAdminAuthorizationHandler — never just trusting the "orgAdmin" claim.
///
/// Registered as a Singleton (Program.cs — IAuthorizationHandler instances are shared across
/// requests), so AppDbContext (scoped) can't be constructor-injected directly; IServiceScopeFactory
/// resolves a fresh scoped instance per check instead, matching the standard ASP.NET Core pattern for
/// a singleton service needing a scoped dependency.
/// </summary>
public class ProjectMemberAuthorizationHandler : AuthorizationHandler<ProjectMemberRequirement>
{
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IServiceScopeFactory _scopeFactory;

    public ProjectMemberAuthorizationHandler(IHttpContextAccessor httpContextAccessor, IServiceScopeFactory scopeFactory)
    {
        _httpContextAccessor = httpContextAccessor;
        _scopeFactory = scopeFactory;
    }

    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, ProjectMemberRequirement requirement)
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
        var isMember = await db.ProjectMembers
            .AsNoTracking()
            .AnyAsync(m => m.ProjectId == projectId && m.UserId == userId);

        if (isMember)
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
