using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;

namespace Enkl.Api.Services;

/// <summary>
/// One-time migration of an exportProjectJSON() document (src/js/features/export.js) into the
/// database, applying the Organisation find-or-create + cross-project User dedup heuristics from
/// the plan. Runs as a single transaction — any failure leaves nothing partially created.
///
/// ARCHITECTURE-REVIEW.md finding 2.1: this class used to be 683 lines mixing org/key resolution,
/// entity creation/wiring, and cycle validation in one file. It's now purely the orchestrator —
/// MigrationOrganisationResolver, MigrationEntityBuilder, and MigrationHierarchyValidator each own
/// one seam, and MigrateAsync's shape below (still a straightforward two-pass "create everything,
/// then wire everything, then validate" flow) is otherwise unchanged from before the split.
/// </summary>
public class MigrationService
{
    private readonly AppDbContext _db;
    private readonly MigrationOrganisationResolver _organisationResolver;
    private readonly MigrationEntityBuilder _entityBuilder;

    public MigrationService(AppDbContext db, MigrationOrganisationResolver organisationResolver, MigrationEntityBuilder entityBuilder)
    {
        _db = db;
        _organisationResolver = organisationResolver;
        _entityBuilder = entityBuilder;
    }

    public async Task<MigrationResultDto> MigrateAsync(MigrationImportRequest request, Guid? callerOrgId = null)
    {
        var warnings = new List<string>();
        await using var transaction = await _db.Database.BeginTransactionAsync();

        var (organisation, organisationCreated) = await _organisationResolver.ResolveOrganisationAsync(request.OrganisationName, callerOrgId);

        var uniqueKey = await _organisationResolver.ResolveUniqueProjectKeyAsync(request.Project.Key, organisation.Id);
        if (uniqueKey != request.Project.Key)
        {
            warnings.Add($"Project key \"{request.Project.Key}\" was already in use in this organisation; migrated as \"{uniqueKey}\" instead.");
        }

        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisation.Id,
            Name = request.Project.Name,
            Key = uniqueKey,
            DateCreated = DateTime.UtcNow,
            DateLastModified = DateTime.UtcNow,
            TaskCounter = 1,
            HeaderButtonVisibilityJson = request.HeaderButtonVisibility is not null
                ? ProjectSettingsSerializer.Serialize(request.HeaderButtonVisibility)
                : "{}",
            WorkflowJson = request.Workflow?.GetRawText()
        };
        _db.Projects.Add(project);

        var columnsByName = new Dictionary<string, Column>();
        foreach (var c in request.Columns)
        {
            var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = c.Name, Done = c.Done, Color = c.Color, Order = c.Order, Cap = c.Cap < 1 ? -1 : c.Cap };
            _db.Columns.Add(column);
            columnsByName[c.Name] = column;
        }

        var (memberByOldId, usersCreated, usersMatched) = await _entityBuilder.CreateUsersAndMembersAsync(
            request.Members, project.Id, organisation.Id, organisationCreated, warnings);

        var releasesByName = _entityBuilder.CreateReleases(request.Releases, project.Id, memberByOldId);
        var taskTypesByName = _entityBuilder.CreateTaskTypes(request.TaskTypes, project.Id);
        var principleByOldId = _entityBuilder.CreatePrinciples(request.Principles, project.Id);

        var flatTasks = MigrationEntityBuilder.FlattenAndDedupTasks(request.Hierarchy);
        var (taskByOldId, taskByKey, taskCounter) = _entityBuilder.CreateTasks(flatTasks, project.Id, columnsByName, memberByOldId, releasesByName, taskTypesByName, warnings);
        project.TaskCounter = taskCounter;

        var documentByOldId = _entityBuilder.CreateDocuments(request.Documents, project.Id, memberByOldId, taskByOldId);
        var riskByOldId = _entityBuilder.CreateRisks(request.Risks, project.Id, memberByOldId, taskByOldId);
        var objectiveByOldId = _entityBuilder.CreateObjectives(request.Objectives, project.Id);
        var teamCommitteeByOldId = _entityBuilder.CreateTeamsCommittees(request.TeamsCommittees, project.Id);
        var decisionByOldId = _entityBuilder.CreateDecisions(request.Decisions, project.Id, memberByOldId, taskByOldId);

        // Phase 2: relational wiring, now every old-id/key -> new-entity map exists.
        _entityBuilder.WireTaskRelations(flatTasks, taskByKey, memberByOldId);
        _entityBuilder.WireDocumentRelations(request.Documents, documentByOldId);
        _entityBuilder.WireRiskRelations(request.Risks, riskByOldId, documentByOldId, principleByOldId, objectiveByOldId);
        _entityBuilder.WireObjectiveRelations(request.Objectives, objectiveByOldId, principleByOldId);
        _entityBuilder.WireTeamCommitteeRelations(request.TeamsCommittees, teamCommitteeByOldId, memberByOldId);
        _entityBuilder.WireDecisionRelations(request.Decisions, decisionByOldId, documentByOldId, riskByOldId, principleByOldId, objectiveByOldId);

        // Phase 3: an externally-supplied export is untrusted input — validate the DAG/trees it
        // describes before committing, exactly as the client-side wouldCreateCycle/wouldCreateParentCycle
        // guard interactive edits (src/js/utils.js).
        MigrationHierarchyValidator.ValidateNoCycles(flatTasks, taskByKey, request.TeamsCommittees, teamCommitteeByOldId);

        await _db.SaveChangesAsync();
        await transaction.CommitAsync();

        return new MigrationResultDto(project.Id, organisation.Id, organisationCreated, usersCreated, usersMatched, warnings);
    }
}
