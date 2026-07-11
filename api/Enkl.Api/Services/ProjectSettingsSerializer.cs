using System.Text.Json;
using Enkl.Api.Dtos;

namespace Enkl.Api.Services;

/// <summary>
/// Shared camelCase (de)serialization for Project.HeaderButtonVisibilityJson. Defaults mirror
/// normalizeHeaderButtonVisibility (src/js/storage.js) exactly: every field is opt-out (defaults to
/// true, so a missing/corrupted value never silently hides something the user never chose to hide)
/// except Workflow, ChangeAuditing and Retrospective, which are opt-in (default false, so a
/// missing/corrupted value never silently starts enforcing/recording/showing something the user
/// never asked for).
/// </summary>
public static class ProjectSettingsSerializer
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static string Serialize(ProjectSettingsDto settings) => JsonSerializer.Serialize(settings, Options);

    public static ProjectSettingsDto Parse(string? json)
    {
        JsonDocument? doc = null;
        try
        {
            if (!string.IsNullOrWhiteSpace(json)) doc = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            // Corrupted/garbled JSON falls through to defaults below, same as the client-side guard.
        }

        bool Get(string name, bool defaultValue)
        {
            if (doc is not null && doc.RootElement.TryGetProperty(name, out var val) &&
                (val.ValueKind == JsonValueKind.True || val.ValueKind == JsonValueKind.False))
            {
                return val.ValueKind == JsonValueKind.True;
            }
            return defaultValue;
        }

        var result = new ProjectSettingsDto(
            Documents: Get("documents", true),
            Risks: Get("risks", true),
            Decisions: Get("decisions", true),
            Health: Get("health", true),
            Principles: Get("principles", true),
            Objectives: Get("objectives", true),
            TeamsCommittees: Get("teamsCommittees", true),
            Workflow: Get("workflow", false),
            TimeTracking: Get("timeTracking", true),
            ChangeAuditing: Get("changeAuditing", false),
            SubTasks: Get("subTasks", true),
            // Opt-in, like Workflow: brand-new functionality nobody has configured yet, so a
            // missing/corrupted value must never silently turn it on.
            Retrospective: Get("retrospective", false));

        doc?.Dispose();
        return result;
    }
}
