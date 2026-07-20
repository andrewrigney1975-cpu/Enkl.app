using Enkl.Api.Auth;
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
        var result = await _organisations.GetOrganisationAsync(User.OrgId());
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPut("users/{userId:guid}/admin")]
    public async Task<IActionResult> SetUserAdmin(Guid userId, SetOrgAdminRequest request)
    {
        var ok = await _organisations.SetUserAdminAsync(User.OrgId(), userId, request.IsOrgAdmin);
        return ok ? NoContent() : NotFound();
    }

    [HttpPost("users")]
    public async Task<IActionResult> CreateUser(CreateUserRequest request)
    {
        var result = await _organisations.CreateUserAsync(User.OrgId(), request);
        return Ok(result);
    }

    [HttpPut("users/{userId:guid}/email")]
    public async Task<IActionResult> SetUserEmail(Guid userId, SetUserEmailRequest request)
    {
        var ok = await _organisations.SetUserEmailAsync(User.OrgId(), userId, request.EmailAddress);
        return ok ? NoContent() : NotFound();
    }

    [HttpPost("users/{userId:guid}/deactivate")]
    public async Task<IActionResult> DeactivateUser(Guid userId)
    {
        var ok = await _organisations.DeactivateUserAsync(User.OrgId(), User.UserId(), userId);
        return ok ? NoContent() : NotFound();
    }

    [HttpGet("org-teams")]
    public async Task<IActionResult> GetOrgTeams()
    {
        return Ok(await _organisations.GetOrgTeamsAsync(User.OrgId()));
    }

    [HttpPut("default-password")]
    public async Task<IActionResult> SetDefaultNewUserPassword(SetDefaultNewUserPasswordRequest request)
    {
        var ok = await _organisations.SetDefaultNewUserPasswordAsync(User.OrgId(), request.Password);
        return ok ? NoContent() : NotFound();
    }
}
