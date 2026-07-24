using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Enkl.Api.Services;

/// <summary>
/// AI Assistant (v4 Phase 1) — a server-mediated Claude tool-use loop scoped to one project. The
/// Anthropic API key never reaches the frontend (CLAUDE.md's CSP/security posture forbids that for a
/// single-file, publicly-servable bundle); every request goes through this service instead, which
/// calls the Messages API directly over raw HTTP (no SDK dependency — see the plan's rationale: no C#
/// SDK skill reference was loaded, and raw HTTP against a stable, documented endpoint is safer than
/// guessing SDK type names).
///
/// Tool calls are re-validated against projectId server-side (find-by-title/key queries, column
/// lookups) rather than trusting anything Claude's tool input claims — same "never trust the client's
/// id list" discipline as the rest of this codebase (root CLAUDE.md §4), just applied to
/// model-generated input instead of directly-client-supplied input.
///
/// No conversation persistence yet (§ "Data model additions" in the plan) — the frontend resends the
/// running transcript each call, same as any stateless chat UI.
/// </summary>
public class AiAssistantService
{
    private static readonly string[] PriorityOrder = { "trivial", "low", "medium", "high", "critical" };
    private const int MaxToolLoopIterations = 6;

    private readonly AppDbContext _db;
    private readonly TaskService _tasks;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<AiAssistantService> _logger;

    public AiAssistantService(AppDbContext db, TaskService tasks, IHttpClientFactory httpClientFactory, IConfiguration config, ILogger<AiAssistantService> logger)
    {
        _db = db;
        _tasks = tasks;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Reads Vendor Portal's own `vendor_feature_entitlements` table (org_id, feature_key, enabled) —
    /// a table this tier does not own/migrate, since Vendor Portal is the one that creates and writes
    /// it (same "vendor owns its own tables, main app just reads them" split as vendor_licenses/
    /// vendor_contracts). Fails OPEN (treats the org as entitled) if the table doesn't exist at all —
    /// Vendor Portal only ever runs against the Hosted/SaaS deployment model
    /// (SYSTEMS-INTEGRATOR-GUIDE.md §2); a Local or Self-hosted deployment never has Vendor Portal
    /// running against its database, so this table simply won't exist there, and that must never take
    /// AI Assistant away from those deployments.
    /// </summary>
    public async Task<bool> IsOrgEntitledAsync(Guid orgId, string featureKey)
    {
        try
        {
            var rows = await _db.Database
                .SqlQueryRaw<bool>(
                    "SELECT enabled FROM vendor_feature_entitlements WHERE org_id = {0} AND feature_key = {1}",
                    orgId, featureKey)
                .ToListAsync();
            // No row for this (org, feature) = not entitled - see the migration's row-presence
            // semantics (root CLAUDE.md §9's entitlement section).
            return rows.Count > 0 && rows[0];
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
        {
            return true;
        }
    }

    /// <summary>Project-scoped convenience wrapper around <see cref="IsOrgEntitledAsync"/> for the
    /// availability endpoint - null means the project itself wasn't found (404), not an entitlement
    /// answer either way.</summary>
    public async Task<bool?> IsProjectOrgEntitledAsync(Guid projectId, string featureKey)
    {
        var orgId = await _db.Projects.AsNoTracking().Where(p => p.Id == projectId).Select(p => (Guid?)p.OrganisationId).FirstOrDefaultAsync();
        if (orgId is null) return null;
        return await IsOrgEntitledAsync(orgId.Value, featureKey);
    }

    public async Task<AiAssistantChatResponse?> ChatAsync(Guid projectId, AiAssistantChatRequest request)
    {
        var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        if (!await IsOrgEntitledAsync(project.OrganisationId, "ai_assistant"))
        {
            throw new AiAssistantNotEntitledException();
        }

        var apiKey = _config["Anthropic:ApiKey"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InvalidOperationException("Anthropic:ApiKey is not configured — the AI assistant is unavailable until an API key is set.");
        }

        var columns = await _db.Columns.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.Order).ToListAsync();
        var members = await _db.ProjectMembers.AsNoTracking().Include(m => m.User).Where(m => m.ProjectId == projectId).ToListAsync();
        var taskTypes = await _db.TaskTypes.AsNoTracking().Where(t => t.ProjectId == projectId).ToListAsync();
        var systemPrompt = BuildSystemPrompt(project.Name, columns, members, taskTypes, request.AlertsSummary);

        var messages = new JsonArray();
        foreach (var m in request.Messages)
        {
            messages.Add(new JsonObject { ["role"] = m.Role, ["content"] = m.Content });
        }

        var actions = new List<AiAssistantActionDto>();
        var client = _httpClientFactory.CreateClient("Anthropic");
        client.DefaultRequestHeaders.Remove("x-api-key");
        client.DefaultRequestHeaders.Add("x-api-key", apiKey);
        if (!client.DefaultRequestHeaders.Contains("anthropic-version"))
        {
            client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
        }

        for (var iteration = 0; iteration < MaxToolLoopIterations; iteration++)
        {
            var body = new JsonObject
            {
                ["model"] = "claude-sonnet-5",
                ["max_tokens"] = 2000,
                ["system"] = systemPrompt,
                ["messages"] = JsonNode.Parse(messages.ToJsonString()),
                ["tools"] = BuildToolDefinitions(),
                ["output_config"] = new JsonObject { ["effort"] = "low" }
            };

            using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "v1/messages")
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json")
            };
            using var httpResponse = await client.SendAsync(httpRequest);
            var responseText = await httpResponse.Content.ReadAsStringAsync();

            if (!httpResponse.IsSuccessStatusCode)
            {
                _logger.LogError("Anthropic API returned {StatusCode}: {Body}", httpResponse.StatusCode, responseText);
                throw new InvalidOperationException("The AI assistant is temporarily unavailable. Please try again.");
            }

            var responseJson = JsonNode.Parse(responseText)!.AsObject();
            var stopReason = responseJson["stop_reason"]?.GetValue<string>();
            var contentBlocks = responseJson["content"]!.AsArray();

            var toolUseBlocks = contentBlocks.Where(b => b!["type"]!.GetValue<string>() == "tool_use").ToList();
            var replyText = string.Concat(contentBlocks
                .Where(b => b!["type"]!.GetValue<string>() == "text")
                .Select(b => b!["text"]!.GetValue<string>()));

            if (stopReason != "tool_use" || toolUseBlocks.Count == 0)
            {
                return new AiAssistantChatResponse(replyText, actions);
            }

            // Echo the assistant's turn (including tool_use blocks) back, then append one user turn
            // carrying every tool_result — parallel tool calls must return in a single message (per
            // the Claude API tool-use contract), never split across multiple.
            messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = JsonNode.Parse(contentBlocks.ToJsonString()) });

            var toolResults = new JsonArray();
            foreach (var toolUse in toolUseBlocks)
            {
                var toolName = toolUse!["name"]!.GetValue<string>();
                var toolUseId = toolUse["id"]!.GetValue<string>();
                var input = toolUse["input"]!.AsObject();

                var (resultText, isError, action) = await ExecuteToolAsync(projectId, toolName, input);
                if (action is not null) actions.Add(action);

                var toolResult = new JsonObject
                {
                    ["type"] = "tool_result",
                    ["tool_use_id"] = toolUseId,
                    ["content"] = resultText
                };
                if (isError) toolResult["is_error"] = true;
                toolResults.Add(toolResult);
            }

            messages.Add(new JsonObject { ["role"] = "user", ["content"] = JsonNode.Parse(toolResults.ToJsonString()) });
        }

        return new AiAssistantChatResponse("I wasn't able to finish that within the allotted number of steps — could you try a narrower request?", actions);
    }

    private async Task<(string ResultText, bool IsError, AiAssistantActionDto? Action)> ExecuteToolAsync(Guid projectId, string toolName, JsonObject input)
    {
        try
        {
            return toolName switch
            {
                "create_task" => await CreateTaskToolAsync(projectId, input),
                "update_task" => await UpdateTaskToolAsync(projectId, input),
                "get_task_details" => await GetTaskDetailsToolAsync(projectId, input),
                "list_critical_tasks" => await ListCriticalTasksToolAsync(projectId, input),
                _ => ($"Unknown tool: {toolName}", true, null)
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AI assistant tool {ToolName} failed for project {ProjectId}", toolName, projectId);
            return ("That action failed: " + ex.Message, true, null);
        }
    }

    private async Task<(string, bool, AiAssistantActionDto?)> CreateTaskToolAsync(Guid projectId, JsonObject input)
    {
        var title = input["title"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(title)) return ("A task title is required.", true, null);

        var (column, columnError) = await ResolveColumnAsync(projectId, input["columnName"]?.GetValue<string>());
        if (columnError is not null) return (columnError, true, null);

        var (_, assigneeId, assigneeError) = await ResolveAssigneeAsync(projectId, input, "assigneeName");
        if (assigneeError is not null) return (assigneeError, true, null);

        var (_, typeId, typeError) = await ResolveTaskTypeAsync(projectId, input, "typeName");
        if (typeError is not null) return (typeError, true, null);

        var priority = NormalizePriority(input["priority"]?.GetValue<string>());
        var dueDate = ParseDate(input["dueDate"]?.GetValue<string>());

        var created = await _tasks.CreateAsync(projectId, new CreateTaskRequest(
            Title: title, Description: input["description"]?.GetValue<string>(), Priority: priority ?? "medium",
            ColumnId: column!.Id, AssigneeId: assigneeId, ReleaseId: null, TypeId: typeId, ParentTaskId: null,
            DependsOnTaskIds: null, EndDate: dueDate));

        if (created is null) return ("Could not create the task — the target column may no longer exist.", true, null);

        return ($"Created task {created.Key}: \"{created.Title}\" in column \"{column.Name}\".", false,
            new AiAssistantActionDto("task_created", created.Id, created.Key, created.Title));
    }

    private async Task<(string, bool, AiAssistantActionDto?)> UpdateTaskToolAsync(Guid projectId, JsonObject input)
    {
        var identifier = input["taskIdentifier"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(identifier)) return ("A task identifier (title or key) is required.", true, null);

        var task = await FindTaskAsync(projectId, identifier);
        if (task is null) return ($"No task found matching \"{identifier}\".", true, null);

        Guid columnId = task.ColumnId;
        if (input["columnName"]?.GetValue<string>() is { } columnName)
        {
            var (column, columnError) = await ResolveColumnAsync(projectId, columnName);
            if (columnError is not null) return (columnError, true, null);
            columnId = column!.Id;
        }

        var (assigneeProvided, assigneeId, assigneeError) = await ResolveAssigneeAsync(projectId, input, "assigneeName");
        if (assigneeError is not null) return (assigneeError, true, null);

        var (typeProvided, typeId, typeError) = await ResolveTaskTypeAsync(projectId, input, "typeName");
        if (typeError is not null) return (typeError, true, null);

        var updated = await _tasks.UpdateAsync(projectId, task.Id, new UpdateTaskRequest(
            Title: input["title"]?.GetValue<string>() ?? task.Title,
            Description: input["description"]?.GetValue<string>() ?? task.Description,
            Priority: NormalizePriority(input["priority"]?.GetValue<string>()) ?? task.Priority,
            ColumnId: columnId,
            AssigneeId: assigneeProvided ? assigneeId : task.AssigneeId,
            ReleaseId: task.ReleaseId,
            TypeId: typeProvided ? typeId : task.TypeId,
            ParentTaskId: task.ParentTaskId,
            DependsOnTaskIds: task.Dependencies.Select(d => d.DependsOnTaskId).ToList(),
            DocumentationUrl: task.DocumentationUrl, StartDate: task.StartDate,
            EndDate: ParseDate(input["dueDate"]?.GetValue<string>()) ?? task.EndDate,
            BusinessValue: task.BusinessValue, TaskCost: task.TaskCost,
            Progress: input["progress"]?.GetValue<int?>() ?? task.Progress,
            EstimatedEffort: task.EstimatedEffort, ActualEffort: task.ActualEffort, Archived: task.Archived),
            changedByDisplayName: "AI Assistant");

        if (updated is null) return ("Could not update the task.", true, null);

        return ($"Updated task {updated.Key}: \"{updated.Title}\".", false,
            new AiAssistantActionDto("task_updated", updated.Id, updated.Key, updated.Title));
    }

    private async Task<(string, bool, AiAssistantActionDto?)> GetTaskDetailsToolAsync(Guid projectId, JsonObject input)
    {
        var identifier = input["taskIdentifier"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(identifier)) return ("A task identifier (title or key) is required.", true, null);

        var task = await FindTaskAsync(projectId, identifier);
        if (task is null) return ($"No task found matching \"{identifier}\".", true, null);

        var column = await _db.Columns.AsNoTracking().FirstOrDefaultAsync(c => c.Id == task.ColumnId);
        var assigneeName = task.AssigneeId.HasValue
            ? await _db.ProjectMembers.AsNoTracking().Include(m => m.User).Where(m => m.Id == task.AssigneeId).Select(m => m.User.DisplayName).FirstOrDefaultAsync()
            : null;
        var typeName = task.TypeId.HasValue
            ? await _db.TaskTypes.AsNoTracking().Where(t => t.Id == task.TypeId).Select(t => t.Name).FirstOrDefaultAsync()
            : null;

        var summary = $"{task.Key}: \"{task.Title}\" — priority {task.Priority}, column \"{column?.Name}\", " +
            $"assignee {assigneeName ?? "unassigned"}, type {typeName ?? "none"}, " +
            $"progress {task.Progress}%, due {(task.EndDate.HasValue ? task.EndDate.Value.ToString("yyyy-MM-dd") : "not set")}." +
            (string.IsNullOrWhiteSpace(task.Description) ? "" : $" Description: {task.Description}");

        return (summary, false, null);
    }

    private async Task<(string, bool, AiAssistantActionDto?)> ListCriticalTasksToolAsync(Guid projectId, JsonObject input)
    {
        var limit = Math.Clamp(input["limit"]?.GetValue<int?>() ?? 5, 1, 20);

        var openTasks = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.Column)
            .Where(t => t.ProjectId == projectId && !t.Column.Done && !t.Archived)
            .ToListAsync();

        var dependentCounts = await _db.TaskDependencies
            .Where(d => openTasks.Select(t => t.Id).Contains(d.DependsOnTaskId))
            .GroupBy(d => d.DependsOnTaskId)
            .Select(g => new { TaskId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.TaskId, x => x.Count);

        var ranked = openTasks
            .OrderByDescending(t => Array.IndexOf(PriorityOrder, t.Priority))
            .ThenByDescending(t => dependentCounts.GetValueOrDefault(t.Id, 0))
            .ThenBy(t => t.EndDate ?? DateOnly.MaxValue)
            .Take(limit)
            .Select(t => $"{t.Key} \"{t.Title}\" — priority {t.Priority}, progress {t.Progress}%, " +
                $"due {(t.EndDate.HasValue ? t.EndDate.Value.ToString("yyyy-MM-dd") : "not set")}, " +
                $"blocks {dependentCounts.GetValueOrDefault(t.Id, 0)} other task(s)")
            .ToList();

        if (ranked.Count == 0) return ("There are no open tasks in this project.", false, null);
        return (string.Join("\n", ranked), false, null);
    }

    private async Task<TaskItem?> FindTaskAsync(Guid projectId, string identifier)
    {
        var normalized = identifier.Trim();
        var byKey = await _db.Tasks.Include(t => t.Dependencies)
            .FirstOrDefaultAsync(t => t.ProjectId == projectId && t.Key.ToLower() == normalized.ToLower());
        if (byKey is not null) return byKey;

        return await _db.Tasks.Include(t => t.Dependencies)
            .Where(t => t.ProjectId == projectId && EF.Functions.ILike(t.Title, $"%{normalized}%"))
            .FirstOrDefaultAsync();
    }

    private async Task<(Column? Column, string? Error)> ResolveColumnAsync(Guid projectId, string? columnName)
    {
        var columns = await _db.Columns.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.Order).ToListAsync();
        if (columns.Count == 0) return (null, "This project has no columns.");

        if (string.IsNullOrWhiteSpace(columnName))
        {
            return (columns.FirstOrDefault(c => !c.Done) ?? columns[0], null);
        }

        var match = columns.FirstOrDefault(c => string.Equals(c.Name, columnName, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            return (null, $"No column named \"{columnName}\". Available columns: {string.Join(", ", columns.Select(c => c.Name))}.");
        }
        return (match, null);
    }

    /// <summary>Tri-state: Provided=false means the caller's tool input didn't include this key at all
    /// (keep whatever the task already has); Provided=true + Id=null means an explicit clear ("none"/
    /// "unassigned"/empty string); Provided=true + Id set means a resolved match. Error is non-null
    /// only when a name was given but didn't match any project member.</summary>
    private async Task<(bool Provided, Guid? Id, string? Error)> ResolveAssigneeAsync(Guid projectId, JsonObject input, string key)
    {
        if (!input.ContainsKey(key)) return (false, null, null);
        var name = input[key]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name) || name.Equals("none", StringComparison.OrdinalIgnoreCase) || name.Equals("unassigned", StringComparison.OrdinalIgnoreCase))
        {
            return (true, null, null);
        }

        var members = await _db.ProjectMembers.AsNoTracking().Include(m => m.User).Where(m => m.ProjectId == projectId).ToListAsync();
        var match = members.FirstOrDefault(m => string.Equals(m.User.DisplayName, name, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            var names = string.Join(", ", members.Select(m => m.User.DisplayName));
            return (true, null, $"No project member named \"{name}\". Available: {names}.");
        }
        return (true, match.Id, null);
    }

    /// <summary>Same tri-state shape as <see cref="ResolveAssigneeAsync"/>, for TaskType.</summary>
    private async Task<(bool Provided, Guid? Id, string? Error)> ResolveTaskTypeAsync(Guid projectId, JsonObject input, string key)
    {
        if (!input.ContainsKey(key)) return (false, null, null);
        var name = input[key]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name) || name.Equals("none", StringComparison.OrdinalIgnoreCase))
        {
            return (true, null, null);
        }

        var types = await _db.TaskTypes.AsNoTracking().Where(t => t.ProjectId == projectId).ToListAsync();
        var match = types.FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            var names = types.Count == 0 ? "(none defined for this project)" : string.Join(", ", types.Select(t => t.Name));
            return (true, null, $"No task type named \"{name}\". Available: {names}.");
        }
        return (true, match.Id, null);
    }

    private static string? NormalizePriority(string? priority) =>
        priority is not null && PriorityOrder.Contains(priority.ToLowerInvariant()) ? priority.ToLowerInvariant() : (priority is null ? null : "medium");

    private static DateOnly? ParseDate(string? date) =>
        date is not null && DateOnly.TryParse(date, out var parsed) ? parsed : null;

    private static string BuildSystemPrompt(string projectName, List<Column> columns, List<ProjectMember> members, List<TaskType> taskTypes, string? alertsSummary)
    {
        var columnList = string.Join(", ", columns.Select(c => $"\"{c.Name}\"{(c.Done ? " (done)" : "")}"));
        var memberList = members.Count == 0 ? "(none)" : string.Join(", ", members.Select(m => $"\"{m.User.DisplayName}\""));
        var typeList = taskTypes.Count == 0 ? "(none defined)" : string.Join(", ", taskTypes.Select(t => $"\"{t.Name}\""));
        var sb = new StringBuilder();
        sb.AppendLine($"You are the AI assistant embedded in the Enkl project management app, working within the project \"{projectName}\".");
        sb.AppendLine($"Its board columns, in order, are: {columnList}.");
        sb.AppendLine($"Its project members (valid assignee names) are: {memberList}.");
        sb.AppendLine($"Its task types (valid type names) are: {typeList}.");
        sb.AppendLine("Use the provided tools to create tasks, edit tasks, look up task details, and list the most critical open tasks. " +
            "When a request is ambiguous (e.g. which task, which column, which member), ask a brief clarifying question rather than guessing destructively.");
        sb.AppendLine("Keep replies short and conversational — this is a chat-style assistant, not a report generator.");
        if (!string.IsNullOrWhiteSpace(alertsSummary))
        {
            sb.AppendLine("Current alerts for this project (computed client-side, already up to date): " + alertsSummary);
        }
        return sb.ToString();
    }

    private static JsonArray BuildToolDefinitions() => new()
    {
        new JsonObject
        {
            ["name"] = "create_task",
            ["description"] = "Create a new task on the board. Call this whenever the user asks to create/add a task.",
            ["input_schema"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["title"] = new JsonObject { ["type"] = "string", ["description"] = "The task title." },
                    ["description"] = new JsonObject { ["type"] = "string" },
                    ["priority"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray { "trivial", "low", "medium", "high", "critical" } },
                    ["columnName"] = new JsonObject { ["type"] = "string", ["description"] = "Which board column to place it in. Omit to use the first non-done column." },
                    ["assigneeName"] = new JsonObject { ["type"] = "string", ["description"] = "Display name of the project member to assign this task to. Must match one of the project's members." },
                    ["typeName"] = new JsonObject { ["type"] = "string", ["description"] = "Name of the task type. Must match one of the project's defined task types." },
                    ["dueDate"] = new JsonObject { ["type"] = "string", ["description"] = "ISO date (YYYY-MM-DD), optional." }
                },
                ["required"] = new JsonArray { "title" }
            }
        },
        new JsonObject
        {
            ["name"] = "update_task",
            ["description"] = "Edit an existing task — change its title, description, priority, column, due date, or progress. Only the fields you provide are changed.",
            ["input_schema"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["taskIdentifier"] = new JsonObject { ["type"] = "string", ["description"] = "The task's key (e.g. PROJ-12) or title/part of its title." },
                    ["title"] = new JsonObject { ["type"] = "string" },
                    ["description"] = new JsonObject { ["type"] = "string" },
                    ["priority"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray { "trivial", "low", "medium", "high", "critical" } },
                    ["columnName"] = new JsonObject { ["type"] = "string" },
                    ["assigneeName"] = new JsonObject { ["type"] = "string", ["description"] = "Display name of the project member to assign. Pass \"none\"/\"unassigned\" to clear the assignee." },
                    ["typeName"] = new JsonObject { ["type"] = "string", ["description"] = "Name of the task type. Pass \"none\" to clear it." },
                    ["dueDate"] = new JsonObject { ["type"] = "string", ["description"] = "ISO date (YYYY-MM-DD)." },
                    ["progress"] = new JsonObject { ["type"] = "integer", ["description"] = "0-100." }
                },
                ["required"] = new JsonArray { "taskIdentifier" }
            }
        },
        new JsonObject
        {
            ["name"] = "get_task_details",
            ["description"] = "Look up a single task's current details by key or title.",
            ["input_schema"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["taskIdentifier"] = new JsonObject { ["type"] = "string" }
                },
                ["required"] = new JsonArray { "taskIdentifier" }
            }
        },
        new JsonObject
        {
            ["name"] = "list_critical_tasks",
            ["description"] = "List the most critical open tasks in this project, ranked by priority, how many other tasks depend on them, and due date. Use this to answer questions like 'what should I work on next' or 'what's most critical'.",
            ["input_schema"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["limit"] = new JsonObject { ["type"] = "integer", ["description"] = "How many tasks to return, default 5." }
                }
            }
        }
    };
}

/// <summary>Thrown by AiAssistantService.ChatAsync when the calling org's Vendor Portal entitlement
/// for "ai_assistant" is off - caught in AiAssistantController and mapped to 403, distinct from the
/// null/404 "project not found" case (root CLAUDE.md §4's no-enumeration-oracle rule still applies
/// between those two, but a caller who is genuinely a project member of a real, entitlement-revoked
/// project needs an actionable 403, not a misleading 404).</summary>
public class AiAssistantNotEntitledException : Exception { }
