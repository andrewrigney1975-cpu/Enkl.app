using System.Security.Claims;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

[ApiController]
[Authorize(Policy = "OrgAdmin")]
[Route("api/organisations/me")]
public class OrganisationsController : ControllerBase
{
    private readonly OrganisationService _organisations;

    public OrganisationsController(OrganisationService organisations)
    {
        _organisations = organisations;
    }

    [HttpGet]
    public async Task<IActionResult> GetMyOrganisation()
    {
        var result = await _organisations.GetOrganisationAsync(CallerOrgId());
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("users/{userId:guid}/admin")]
    public async Task<IActionResult> SetUserAdmin(Guid userId, SetOrgAdminRequest request)
    {
        var ok = await _organisations.SetUserAdminAsync(CallerOrgId(), userId, request.IsOrgAdmin);
        return ok ? NoContent() : NotFound();
    }

    [HttpPost("users")]
    public async Task<IActionResult> CreateUser(CreateUserRequest request)
    {
        var result = await _organisations.CreateUserAsync(CallerOrgId(), request);
        return Ok(result);
    }

    private Guid CallerOrgId() => Guid.Parse(User.FindFirstValue("orgId")!);
}
