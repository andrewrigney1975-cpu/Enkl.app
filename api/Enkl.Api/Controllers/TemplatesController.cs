using Enkl.Api.Auth;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// Separate from OrganisationsController since its gating is split, not uniformly OrgAdmin: any
/// signed-in org member may list/read/create a template (same trust level as creating a column or
/// task type on a project they belong to), but renaming/deleting a shared org asset requires OrgAdmin
/// (see TemplateService's own note).
/// </summary>
[ApiController]
[Authorize]
[Route("api/organisations/me/templates")]
public class TemplatesController : ControllerBase
{
    private readonly TemplateService _templates;

    public TemplatesController(TemplateService templates)
    {
        _templates = templates;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        return Ok(await _templates.ListAsync(User.OrgId()));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> GetDetail(Guid id)
    {
        var result = await _templates.GetDetailAsync(User.OrgId(), id);
        return result is null ? NotFound() : Ok(result);
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateTemplateRequest request)
    {
        return Ok(await _templates.CreateAsync(User.OrgId(), request));
    }

    [HttpPut("{id:guid}")]
    [Authorize(Policy = "OrgAdmin")]
    public async Task<IActionResult> Rename(Guid id, UpdateTemplateRequest request)
    {
        var ok = await _templates.RenameAsync(User.OrgId(), id, request.Name);
        return ok ? NoContent() : NotFound();
    }

    [HttpDelete("{id:guid}")]
    [Authorize(Policy = "OrgAdmin")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var ok = await _templates.DeleteAsync(User.OrgId(), id);
        return ok ? NoContent() : NotFound();
    }
}
