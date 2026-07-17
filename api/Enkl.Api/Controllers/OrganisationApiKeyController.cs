using Enkl.Api.Auth;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>Same OrgAdmin gating as OrganisationSsoConfigController.</summary>
[ApiController]
[Authorize(Policy = "OrgAdmin")]
[Route("api/organisations/me/api-key")]
public class OrganisationApiKeyController : ControllerBase
{
    private readonly OrganisationApiKeyService _apiKey;

    public OrganisationApiKeyController(OrganisationApiKeyService apiKey)
    {
        _apiKey = apiKey;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        return Ok(await _apiKey.GetAsync(User.OrgId()));
    }

    [HttpPost]
    public async Task<IActionResult> Generate()
    {
        return Ok(await _apiKey.GenerateAsync(User.OrgId()));
    }

    [HttpDelete]
    public async Task<IActionResult> Revoke()
    {
        return Ok(await _apiKey.RevokeAsync(User.OrgId()));
    }
}
