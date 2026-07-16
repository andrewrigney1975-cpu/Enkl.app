using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Enkl.Api.Controllers;

// Security review finding H1: anonymous + no prior rate limiting made this a plausible
// unauthenticated resource-exhaustion / brute-force-org-name-guessing target (see MigrationService's
// ResolveOrganisationAsync, C3's fix) — see Program.cs's "auth" rate-limiting policy.
[EnableRateLimiting("auth")]
[ApiController]
[Route("api/migration")]
public class MigrationController : ControllerBase
{
    private readonly MigrationService _migration;

    public MigrationController(MigrationService migration)
    {
        _migration = migration;
    }

    // Anonymous deliberately: the very first migration creates the first Organisation and User
    // accounts, so there's no one to authenticate as yet. Revisit once there's a standalone
    // "create Organisation" flow that can hand back credentials before the first migration runs.
    // If a valid JWT IS present, though, we use its orgId claim so a signed-in user migrating an
    // additional local project always lands in their own Organisation — see MigrationService's
    // ResolveOrganisationAsync for why an anonymous caller can no longer target an existing org by
    // name (security review finding C3: that was an unauthenticated cross-tenant account-injection
    // vector).
    [AllowAnonymous]
    [HttpPost("projects")]
    public async Task<IActionResult> MigrateProject(MigrationImportRequest request)
    {
        var callerOrgId = User.Identity?.IsAuthenticated == true ? User.TryOrgId() : null;

        // ApiValidationException (cycle checks, etc.) is mapped to 400 by the global exception
        // handler in Program.cs — no per-controller try/catch needed.
        var result = await _migration.MigrateAsync(request, callerOrgId);
        return Ok(result);
    }
}
