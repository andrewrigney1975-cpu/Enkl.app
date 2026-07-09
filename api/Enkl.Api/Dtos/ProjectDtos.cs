using System.Text.Json;

namespace Enkl.Api.Dtos;

public record ProjectSummaryDto(Guid Id, string Name, string Key);

public record MemberDto(Guid Id, Guid UserId, string DisplayName, string Color, string? Role, Guid? ReportsToId);

public record ColumnDto(Guid Id, string Name, bool Done, string? Color, int Order);

public record TaskAuditLogEntryDto(Guid Id, DateTime Timestamp, string Field, string? OldValue, string? NewValue, string? ChangedBy);

public record TaskDto(
    Guid Id, string Key, string Title, string? Description, string Priority,
    Guid ColumnId, Guid? AssigneeId, Guid? ReleaseId, Guid? TypeId, Guid? ParentTaskId, string? DocumentationUrl,
    DateTime DateCreated, DateTime DateLastModified, DateTime? DateDone,
    DateOnly? StartDate, DateOnly? EndDate,
    int? BusinessValue, int? TaskCost, int Progress,
    decimal? EstimatedEffort, decimal? ActualEffort, bool Archived,
    List<Guid> DependsOnTaskIds, List<TaskAuditLogEntryDto> AuditLog);

public record ReleaseDto(Guid Id, string Name, string Status, Guid? OwnerId, DateOnly? StartDate, DateOnly? EndDate);
public record TaskTypeDto(Guid Id, string Name, string? IconName);
public record PrincipleDto(Guid Id, string Key, string Title, string? Description, string? DocumentUrl);
public record DocumentDto(Guid Id, string Key, string Title, string? Url, string? Description, Guid? OwnerId, Guid? TaskId, List<Guid> RelatedDocumentIds);
public record RiskDto(
    Guid Id, string Key, string Title, string? Description, int Likelihood, int Impact, string? Mitigations,
    Guid? OwnerId, Guid? TaskId, string Status, DateOnly? DateToClose, DateOnly? DateClosed,
    List<Guid> DocumentIds, List<Guid> PrincipleIds, List<Guid> ObjectiveIds);
public record ObjectiveDto(Guid Id, string Key, string Title, string? Description, List<Guid> PrincipleIds);
public record TeamCommitteeDto(Guid Id, string Key, string Name, string? Description, string Type, Guid? ParentId, List<Guid> MemberIds);
public record DecisionDto(
    Guid Id, string Key, string Title, string? Description, string Type, string Status, string? Outcome,
    Guid? OwnerId, string? Approver, Guid? TaskId,
    List<Guid> DocumentIds, List<Guid> RiskIds, List<Guid> PrincipleIds, List<Guid> ObjectiveIds);

public record ProjectDetailDto(
    Guid Id, string Name, string Key, Guid OrganisationId,
    List<MemberDto> Members, List<ColumnDto> Columns, List<TaskDto> Tasks,
    List<ReleaseDto> Releases, List<TaskTypeDto> TaskTypes, List<PrincipleDto> Principles,
    List<DocumentDto> Documents, List<RiskDto> Risks, List<ObjectiveDto> Objectives,
    List<TeamCommitteeDto> TeamsCommittees, List<DecisionDto> Decisions,
    ProjectSettingsDto HeaderButtonVisibility, JsonElement? Workflow);

/// <summary>
/// The 11 opt-in/opt-out feature-flag booleans shown in the "App Settings" modal
/// (normalizeHeaderButtonVisibility in src/js/storage.js) — persisted as
/// Project.HeaderButtonVisibilityJson. Property names are serialized camelCase (see
/// ProjectSettingsSerializer) so they line up exactly with the client's own field names, and with
/// the "changeAuditing" key TaskService.IsChangeAuditingEnabledAsync already reads from that same
/// column.
/// </summary>
public record ProjectSettingsDto(
    bool Documents, bool Risks, bool Decisions, bool Health, bool Principles, bool Objectives,
    bool TeamsCommittees, bool Workflow, bool TimeTracking, bool ChangeAuditing, bool SubTasks);

public record CreateColumnRequest(string Name, bool Done, string? Color);
public record UpdateColumnRequest(string Name, bool Done, string? Color, int Order);

public record CreateTaskRequest(
    string Title, string? Description, string Priority, Guid ColumnId, Guid? AssigneeId,
    Guid? ReleaseId, Guid? TypeId, Guid? ParentTaskId, List<Guid>? DependsOnTaskIds);
public record UpdateTaskRequest(
    string Title, string? Description, string Priority, Guid ColumnId, Guid? AssigneeId,
    Guid? ReleaseId, Guid? TypeId, Guid? ParentTaskId, List<Guid>? DependsOnTaskIds,
    string? DocumentationUrl, DateOnly? StartDate, DateOnly? EndDate,
    int? BusinessValue, int? TaskCost, int Progress,
    decimal? EstimatedEffort, decimal? ActualEffort, bool Archived);

public record CreateReleaseRequest(string Name, string Status, Guid? OwnerId, DateOnly? StartDate, DateOnly? EndDate);
public record UpdateReleaseRequest(string Name, string Status, Guid? OwnerId, DateOnly? StartDate, DateOnly? EndDate);

public record CreateTaskTypeRequest(string Name, string? IconName);
public record UpdateTaskTypeRequest(string Name, string? IconName);

public record CreatePrincipleRequest(string Title, string? Description, string? DocumentUrl);
public record UpdatePrincipleRequest(string Title, string? Description, string? DocumentUrl);

public record CreateDocumentRequest(string Title, string? Url, string? Description, Guid? OwnerId, Guid? TaskId, List<Guid>? RelatedDocumentIds);
public record UpdateDocumentRequest(string Title, string? Url, string? Description, Guid? OwnerId, Guid? TaskId, List<Guid>? RelatedDocumentIds);

public record CreateRiskRequest(
    string Title, string? Description, int Likelihood, int Impact, string? Mitigations,
    Guid? OwnerId, Guid? TaskId, List<Guid>? DocumentIds, List<Guid>? PrincipleIds, List<Guid>? ObjectiveIds,
    string Status, DateOnly? DateToClose, DateOnly? DateClosed);
public record UpdateRiskRequest(
    string Title, string? Description, int Likelihood, int Impact, string? Mitigations,
    Guid? OwnerId, Guid? TaskId, List<Guid>? DocumentIds, List<Guid>? PrincipleIds, List<Guid>? ObjectiveIds,
    string Status, DateOnly? DateToClose, DateOnly? DateClosed);

public record CreateObjectiveRequest(string Title, string? Description, List<Guid>? PrincipleIds);
public record UpdateObjectiveRequest(string Title, string? Description, List<Guid>? PrincipleIds);

public record CreateTeamCommitteeRequest(string Name, string? Description, string Type, Guid? ParentId, List<Guid>? MemberIds);
public record UpdateTeamCommitteeRequest(string Name, string? Description, string Type, Guid? ParentId, List<Guid>? MemberIds);

public record CreateDecisionRequest(
    string Title, string? Description, string Type, string Status, string? Outcome,
    Guid? OwnerId, string? Approver, Guid? TaskId,
    List<Guid>? DocumentIds, List<Guid>? RiskIds, List<Guid>? PrincipleIds, List<Guid>? ObjectiveIds);
public record UpdateDecisionRequest(
    string Title, string? Description, string Type, string Status, string? Outcome,
    Guid? OwnerId, string? Approver, Guid? TaskId,
    List<Guid>? DocumentIds, List<Guid>? RiskIds, List<Guid>? PrincipleIds, List<Guid>? ObjectiveIds);
