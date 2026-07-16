using System.Security.Claims;

namespace Enkl.Api.Auth;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.1: the same orgId/userId claim-parsing was copy-pasted as a
/// private CallerOrgId()/CallerUserId() method (or inlined outright) across 10+ controllers. One
/// extension class, no behavior change — every call site read Guid.Parse(User.FindFirstValue("orgId")!)
/// or the ClaimTypes.NameIdentifier/"sub" fallback for user id, and still does, just from one place.
/// </summary>
public static class ClaimsPrincipalExtensions
{
    /// <summary>The caller's Organisation id. Throws if the "orgId" claim is absent — only call this
    /// from an endpoint that's already [Authorize]d (every existing CallerOrgId() call site was).</summary>
    public static Guid OrgId(this ClaimsPrincipal user) => Guid.Parse(user.FindFirstValue("orgId")!);

    /// <summary>Same as <see cref="OrgId"/> but null instead of throwing when the caller is
    /// unauthenticated — for the one anonymous-but-optionally-authenticated endpoint (migration
    /// bootstrap) that needs to know whether a caller org exists at all before trusting it.</summary>
    public static Guid? TryOrgId(this ClaimsPrincipal user)
    {
        var claim = user.FindFirstValue("orgId");
        return claim is null ? null : Guid.Parse(claim);
    }

    /// <summary>The caller's User id, from either ASP.NET Core's mapped ClaimTypes.NameIdentifier or
    /// the raw JWT "sub" claim (JwtBearer maps "sub" -> NameIdentifier by default, but this fallback
    /// was already present at every existing call site, so kept as-is rather than assuming the
    /// mapping always applies).</summary>
    public static Guid UserId(this ClaimsPrincipal user) =>
        Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub")!);

    /// <summary>Same as <see cref="UserId"/> but null instead of throwing when the claim is absent or
    /// unparsable — for callers (e.g. ProjectMemberAuthorizationHandler) that must fail closed rather
    /// than throw on a malformed/incomplete token.</summary>
    public static Guid? TryUserId(this ClaimsPrincipal user)
    {
        var claim = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
        return claim is not null && Guid.TryParse(claim, out var id) ? id : null;
    }
}
