using System.Text.Json;

namespace Enkl.Api.Dtos;

// Mirrors the JSON shape exportProjectJSON() produces (src/js/features/export.js). Cross-references
// use two different key spaces, exactly as the export does: entities elsewhere in the doc (documents,
// risks, principles, objectives, teamsCommittees, tasks-by-id, members) are referenced by their
// original local id (regenerated server-side, so an old-id -> new-entity map is built during import),
// while cross-task links inside the `hierarchy` tree (dependsOn, parentKey) use the task's Key instead,
// because export.js itself only carries keys there. Private-task encryption fields are still deferred.

public record ImportProjectDto(string Name, string Key);
public record ImportMemberDto(string Id, string Name, string Color, string? Role, string? ReportsToId, string? Email = null, int? AllocatedFraction = null);
public record ImportColumnDto(string Id, string Name, bool Done, string? Color, int Order, int Cap = -1);
public record ImportReleaseDto(string Id, string Name, string Status, string? OwnerId, string? StartDate, string? EndDate, string? DateCreated, string? DateLastModified);
public record ImportTaskTypeDto(string Id, string Name, string? IconName);
public record ImportPrincipleDto(string Id, string Key, string Title, string? Description, string? DocumentUrl, string? DateCreated, string? DateLastModified);
public record ImportDocumentDto(string Id, string Key, string Title, string? Url, string? Description, string? OwnerId, string? TaskId, List<string>? RelatedDocumentIds, string? DateCreated, string? DateLastModified);
public record ImportRiskDto(
    string Id, string Key, string Title, string? Description, int Likelihood, int Impact, string? Mitigations,
    string? OwnerId, string? TaskId, List<string>? DocumentIds, List<string>? PrincipleIds, List<string>? ObjectiveIds,
    string Status, string? DateToClose, string? DateClosed, string? DateCreated, string? DateLastModified);
public record ImportObjectiveDto(string Id, string Key, string Title, string? Description, List<string>? PrincipleIds, string? DateCreated, string? DateLastModified);
public record ImportTeamCommitteeDto(string Id, string Key, string Name, string? Description, string Type, string? ParentId, List<string>? MemberIds, string? DateCreated, string? DateLastModified);
public record ImportDecisionDto(
    string Id, string Key, string Title, string? Description, string Type, string Status, string? Outcome,
    string? OwnerId, string? Approver, string? TaskId,
    List<string>? DocumentIds, List<string>? RiskIds, List<string>? PrincipleIds, List<string>? ObjectiveIds,
    string? DateCreated, string? DateLastModified);
public record ImportAuditLogEntryDto(string? Timestamp, string Field, string? OldValue, string? NewValue);

public record ImportTaskNodeDto(
    string Id, string Key, string Title, string? Description, string Priority, string Column,
    string? AssigneeId, string? Assignee, string? Release, string? Type,
    string? DocumentationUrl, string? DateCreated, string? DateLastModified, string? DateDone,
    string? StartDate, string? EndDate, int? BusinessValue, int? TaskCost, int Progress,
    decimal? EstimatedEffort, decimal? ActualEffort, bool Archived,
    List<string>? DependsOn, List<ImportAuditLogEntryDto>? AuditLog, string? ParentKey,
    List<ImportTaskNodeDto>? Subtasks);

public record MigrationImportRequest(
    string OrganisationName,
    ImportProjectDto Project,
    List<ImportMemberDto> Members,
    List<ImportColumnDto> Columns,
    List<ImportReleaseDto>? Releases,
    List<ImportTaskTypeDto>? TaskTypes,
    List<ImportPrincipleDto>? Principles,
    List<ImportDocumentDto>? Documents,
    List<ImportRiskDto>? Risks,
    List<ImportObjectiveDto>? Objectives,
    List<ImportTeamCommitteeDto>? TeamsCommittees,
    List<ImportDecisionDto>? Decisions,
    List<ImportTaskNodeDto> Hierarchy,
    // Matches buildExportDoc's top-level `headerButtonVisibility` (src/js/features/export.js) — null
    // only for a payload from an older client that predates this field, in which case the migrated
    // project just gets ProjectSettingsSerializer's all-defaults ("{}").
    ProjectSettingsDto? HeaderButtonVisibility = null,
    // Matches buildExportDoc's top-level `workflow` — null both for older clients and for a project
    // whose Workflow editor was never opened (export.js sends null in that case deliberately, see its
    // comment there), so the migrated project ends up with WorkflowJson = null either way.
    JsonElement? Workflow = null);

public record MigrationResultDto(Guid ProjectId, Guid OrganisationId, bool OrganisationCreated, int UsersCreated, int UsersMatched, List<string> Warnings);
