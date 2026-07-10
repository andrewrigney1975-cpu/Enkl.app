using System.Text.Json;

namespace Enkl.Api.Dtos;

/// <summary>Id is the SOURCE project's column id, preserved so ProjectService can build an old-&gt;new id map when remapping a template's Workflow on apply (see ProjectService.CreateAsync).</summary>
public record TemplateColumnDto(Guid Id, string Name, bool Done, string? Color, int Order);
public record TemplateTaskTypeDto(string Name, string? IconName);

public record ProjectTemplateSummaryDto(Guid Id, string Name, DateTime CreatedAt);

public record ProjectTemplateDetailDto(
    Guid Id, string Name, List<TemplateColumnDto> Columns, List<TemplateTaskTypeDto> TaskTypes,
    JsonElement? Workflow, ProjectSettingsDto Settings, DateTime CreatedAt);

public record CreateTemplateRequest(
    string Name, List<TemplateColumnDto> Columns, List<TemplateTaskTypeDto> TaskTypes,
    JsonElement? Workflow, ProjectSettingsDto Settings);

public record UpdateTemplateRequest(string Name);
