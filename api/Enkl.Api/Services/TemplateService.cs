using System.Text.Json;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// Project Templates are owned by the Organisation, not any one Project — every signed-in member of
/// an org can list/create one (see TemplatesController's [Authorize] on those actions), matching the
/// trust level of creating a column or task type today. Renaming/deleting a shared org asset requires
/// OrgAdmin, the same bar as OrganisationService's user-management actions.
/// </summary>
public class TemplateService
{
    private readonly AppDbContext _db;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public TemplateService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<List<ProjectTemplateSummaryDto>> ListAsync(Guid organisationId)
    {
        return await _db.ProjectTemplates
            .Where(t => t.OrganisationId == organisationId)
            .OrderBy(t => t.Name)
            .Select(t => new ProjectTemplateSummaryDto(t.Id, t.Name, t.CreatedAt))
            .ToListAsync();
    }

    public async Task<ProjectTemplateDetailDto?> GetDetailAsync(Guid organisationId, Guid templateId)
    {
        var t = await _db.ProjectTemplates.FirstOrDefaultAsync(x => x.Id == templateId && x.OrganisationId == organisationId);
        return t is null ? null : ToDetailDto(t);
    }

    public async Task<ProjectTemplateSummaryDto> CreateAsync(Guid organisationId, CreateTemplateRequest request)
    {
        var name = (request.Name ?? "").Trim();
        if (name.Length == 0) throw new ApiValidationException("Please enter a template name.");
        if (name.Length > 200) name = name[..200];

        var now = DateTime.UtcNow;
        var template = new ProjectTemplate
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = name,
            ColumnsJson = JsonSerializer.Serialize(request.Columns ?? new List<TemplateColumnDto>(), JsonOptions),
            TaskTypesJson = JsonSerializer.Serialize(request.TaskTypes ?? new List<TemplateTaskTypeDto>(), JsonOptions),
            WorkflowJson = request.Workflow?.GetRawText(),
            SettingsJson = ProjectSettingsSerializer.Serialize(request.Settings),
            CreatedAt = now,
            DateLastModified = now
        };
        _db.ProjectTemplates.Add(template);
        await _db.SaveChangesAsync();

        return new ProjectTemplateSummaryDto(template.Id, template.Name, template.CreatedAt);
    }

    /// <summary>Returns false if the template doesn't exist or belongs to a different Organisation than the caller.</summary>
    public async Task<bool> RenameAsync(Guid organisationId, Guid templateId, string name)
    {
        var template = await _db.ProjectTemplates.FirstOrDefaultAsync(t => t.Id == templateId && t.OrganisationId == organisationId);
        if (template is null) return false;

        var trimmed = (name ?? "").Trim();
        if (trimmed.Length == 0) throw new ApiValidationException("Please enter a template name.");
        template.Name = trimmed.Length > 200 ? trimmed[..200] : trimmed;
        template.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<bool> DeleteAsync(Guid organisationId, Guid templateId)
    {
        var template = await _db.ProjectTemplates.FirstOrDefaultAsync(t => t.Id == templateId && t.OrganisationId == organisationId);
        if (template is null) return false;

        _db.ProjectTemplates.Remove(template);
        await _db.SaveChangesAsync();
        return true;
    }

    private static ProjectTemplateDetailDto ToDetailDto(ProjectTemplate t)
    {
        var columns = JsonSerializer.Deserialize<List<TemplateColumnDto>>(t.ColumnsJson, JsonOptions) ?? new();
        var taskTypes = JsonSerializer.Deserialize<List<TemplateTaskTypeDto>>(t.TaskTypesJson, JsonOptions) ?? new();
        JsonElement? workflow = null;
        if (!string.IsNullOrWhiteSpace(t.WorkflowJson))
        {
            try { workflow = JsonDocument.Parse(t.WorkflowJson).RootElement; }
            catch (JsonException) { workflow = null; }
        }

        return new ProjectTemplateDetailDto(
            t.Id, t.Name, columns, taskTypes, workflow,
            ProjectSettingsSerializer.Parse(t.SettingsJson), t.CreatedAt);
    }
}
