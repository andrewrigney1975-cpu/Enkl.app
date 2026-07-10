using System.Globalization;
using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// One-time migration of an exportProjectJSON() document (src/js/features/export.js) into the
/// database, applying the Organisation find-or-create + cross-project User dedup heuristics from
/// the plan. Runs as a single transaction — any failure leaves nothing partially created.
///
/// Two passes per entity group: pass 1 creates rows and records an old-id (or, for the Task
/// hierarchy, old-key) -> new-entity map; pass 2 wires up the relational fields once every entity's
/// map exists, so it doesn't matter what order entities appear in the export doc.
/// </summary>
public class MigrationService
{
    private readonly AppDbContext _db;

    public MigrationService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<MigrationResultDto> MigrateAsync(MigrationImportRequest request)
    {
        var warnings = new List<string>();
        await using var transaction = await _db.Database.BeginTransactionAsync();

        var (organisation, organisationCreated) = await ResolveOrganisationAsync(request.OrganisationName);

        // Project keys are globally unique server-side, but every fresh local install seeds a
        // project with the same "DEMO" key (createSeedDB in src/js/storage.js) — so a key collision
        // on migration is an expected, common case, not just repeat-migrating the same project.
        var uniqueKey = await ResolveUniqueProjectKeyAsync(request.Project.Key);
        if (uniqueKey != request.Project.Key)
        {
            warnings.Add($"Project key \"{request.Project.Key}\" was already in use on the server; migrated as \"{uniqueKey}\" instead.");
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
            var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = c.Name, Done = c.Done, Color = c.Color, Order = c.Order };
            _db.Columns.Add(column);
            columnsByName[c.Name] = column;
        }

        var (memberByOldId, usersCreated, usersMatched) = await CreateUsersAndMembersAsync(
            request.Members, project.Id, organisation.Id, organisationCreated, warnings);

        var releasesByName = CreateReleases(request.Releases, project.Id, memberByOldId);
        var taskTypesByName = CreateTaskTypes(request.TaskTypes, project.Id);
        var principleByOldId = CreatePrinciples(request.Principles, project.Id);

        var flatTasks = FlattenAndDedupTasks(request.Hierarchy);
        var (taskByOldId, taskByKey, taskCounter) = CreateTasks(flatTasks, project.Id, columnsByName, memberByOldId, releasesByName, taskTypesByName, warnings);
        project.TaskCounter = taskCounter;

        var documentByOldId = CreateDocuments(request.Documents, project.Id, memberByOldId, taskByOldId);
        var riskByOldId = CreateRisks(request.Risks, project.Id, memberByOldId, taskByOldId);
        var objectiveByOldId = CreateObjectives(request.Objectives, project.Id);
        var teamCommitteeByOldId = CreateTeamsCommittees(request.TeamsCommittees, project.Id);
        var decisionByOldId = CreateDecisions(request.Decisions, project.Id, memberByOldId, taskByOldId);

        // Phase 2: relational wiring, now every old-id/key -> new-entity map exists.
        WireTaskRelations(flatTasks, taskByKey);
        WireDocumentRelations(request.Documents, documentByOldId);
        WireRiskRelations(request.Risks, riskByOldId, documentByOldId, principleByOldId, objectiveByOldId);
        WireObjectiveRelations(request.Objectives, objectiveByOldId, principleByOldId);
        WireTeamCommitteeRelations(request.TeamsCommittees, teamCommitteeByOldId, memberByOldId);
        WireDecisionRelations(request.Decisions, decisionByOldId, documentByOldId, riskByOldId, principleByOldId, objectiveByOldId);

        // Phase 3: an externally-supplied export is untrusted input — validate the DAG/trees it
        // describes before committing, exactly as the client-side wouldCreateCycle/wouldCreateParentCycle
        // guard interactive edits (src/js/utils.js).
        ValidateNoCycles(flatTasks, taskByKey, request.TeamsCommittees, teamCommitteeByOldId);

        await _db.SaveChangesAsync();
        await transaction.CommitAsync();

        return new MigrationResultDto(project.Id, organisation.Id, organisationCreated, usersCreated, usersMatched, warnings);
    }

    private async Task<(Organisation Organisation, bool Created)> ResolveOrganisationAsync(string name)
    {
        var normalized = UsernameNormalizer.Normalize(name);
        var existing = await _db.Organisations.FirstOrDefaultAsync(o => o.NormalizedName == normalized);
        if (existing is not null) return (existing, false);

        var organisation = new Organisation { Id = Guid.NewGuid(), Name = name, NormalizedName = normalized, CreatedAt = DateTime.UtcNow };
        _db.Organisations.Add(organisation);
        return (organisation, true);
    }

    private async Task<(Dictionary<string, ProjectMember> MemberByOldId, int UsersCreated, int UsersMatched)> CreateUsersAndMembersAsync(
        List<ImportMemberDto> members, Guid projectId, Guid organisationId, bool organisationCreated, List<string> warnings)
    {
        var usersCreated = 0;
        var usersMatched = 0;
        var userIdByNormalizedKey = new Dictionary<string, Guid>();
        var memberByOldId = new Dictionary<string, ProjectMember>();
        var firstAdminAssigned = false;

        foreach (var m in members)
        {
            var normalized = UsernameNormalizer.Normalize(m.Name);

            if (!userIdByNormalizedKey.TryGetValue(normalized, out var userId))
            {
                // Identity dedup is scoped to this Organisation only — the same normalized name in a
                // different Organisation is a different real-world person and must never be silently
                // merged across tenant boundaries.
                var existingInOrg = await _db.Users.FirstOrDefaultAsync(u => u.NormalizedUsername == normalized && u.OrganisationId == organisationId);
                if (existingInOrg is not null)
                {
                    userId = existingInOrg.Id;
                    usersMatched++;

                    // Self-heal a missing email on a matched account the same way MemberService's
                    // matched-existing-user branch does — never blocks the migration: an invalid or
                    // already-taken email is silently dropped rather than failing the import.
                    if (existingInOrg.EmailAddress is null && !string.IsNullOrWhiteSpace(m.Email))
                    {
                        try
                        {
                            var (backfillEmail, backfillNormalized) = await EmailValidation.ValidateAndNormalizeAsync(_db, m.Email, requireEmail: false, excludeUserId: existingInOrg.Id);
                            existingInOrg.EmailAddress = backfillEmail;
                            existingInOrg.NormalizedEmailAddress = backfillNormalized;
                        }
                        catch (ApiValidationException) { /* ignore — not the point of this import */ }
                    }
                }
                else
                {
                    var usernameToUse = normalized;
                    if (await _db.Users.AnyAsync(u => u.NormalizedUsername == normalized))
                    {
                        usernameToUse = await ResolveUniqueUsernameAsync(normalized);
                        warnings.Add($"User \"{m.Name}\" already exists in another organisation; created as \"{usernameToUse}\" instead.");
                    }

                    // Unlike OrganisationService.CreateUserAsync/MemberService.CreateAsync, a missing or
                    // unusable email here never blocks the migration itself (an externally-supplied batch
                    // import shouldn't fail wholesale over one bad address) — instead it's surfaced as a
                    // warning so the Org Admin can backfill it afterward via Manage Users.
                    string? email = null;
                    string? normalizedEmail = null;
                    if (string.IsNullOrWhiteSpace(m.Email))
                    {
                        warnings.Add($"User \"{m.Name}\" was migrated without an email address. An organisation admin must add one in Manage Users before SAML sign-in can be enabled for them.");
                    }
                    else
                    {
                        try
                        {
                            (email, normalizedEmail) = await EmailValidation.ValidateAndNormalizeAsync(_db, m.Email, requireEmail: false, excludeUserId: null);
                        }
                        catch (ApiValidationException ex)
                        {
                            warnings.Add($"User \"{m.Name}\": email \"{m.Email}\" could not be used ({ex.Message}); an organisation admin must add a valid one in Manage Users.");
                        }
                    }

                    var isFirstAdminOfNewOrg = organisationCreated && !firstAdminAssigned;
                    var user = new User
                    {
                        Id = Guid.NewGuid(),
                        OrganisationId = organisationId,
                        Username = usernameToUse,
                        NormalizedUsername = usernameToUse,
                        EmailAddress = email,
                        NormalizedEmailAddress = normalizedEmail,
                        PasswordHash = PasswordHasher.Hash("enklUserPassword"),
                        DisplayName = m.Name,
                        MustChangePassword = true,
                        IsOrgAdmin = isFirstAdminOfNewOrg,
                        CreatedAt = DateTime.UtcNow
                    };
                    _db.Users.Add(user);
                    userId = user.Id;
                    usersCreated++;
                    if (isFirstAdminOfNewOrg) firstAdminAssigned = true;
                }
                userIdByNormalizedKey[normalized] = userId;
            }

            var member = new ProjectMember { Id = Guid.NewGuid(), ProjectId = projectId, UserId = userId, Color = m.Color, Role = m.Role };
            _db.ProjectMembers.Add(member);
            memberByOldId[m.Id] = member;
        }

        foreach (var m in members)
        {
            if (m.ReportsToId is not null && memberByOldId.TryGetValue(m.ReportsToId, out var reportsTo))
            {
                memberByOldId[m.Id].ReportsToId = reportsTo.Id;
            }
        }

        return (memberByOldId, usersCreated, usersMatched);
    }

    private Dictionary<string, Release> CreateReleases(List<ImportReleaseDto>? releases, Guid projectId, Dictionary<string, ProjectMember> memberByOldId)
    {
        var byName = new Dictionary<string, Release>();
        foreach (var r in releases ?? new List<ImportReleaseDto>())
        {
            var release = new Release
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Name = r.Name,
                Status = r.Status is "pending" or "in_progress" or "deployed" ? r.Status : "pending",
                OwnerId = r.OwnerId is not null && memberByOldId.TryGetValue(r.OwnerId, out var owner) ? owner.Id : null,
                StartDate = ParseDateOnly(r.StartDate),
                EndDate = ParseDateOnly(r.EndDate),
                DateCreated = ParseDateTime(r.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(r.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Releases.Add(release);
            byName[r.Name] = release;
        }
        return byName;
    }

    private Dictionary<string, TaskType> CreateTaskTypes(List<ImportTaskTypeDto>? taskTypes, Guid projectId)
    {
        var byName = new Dictionary<string, TaskType>();
        foreach (var t in taskTypes ?? new List<ImportTaskTypeDto>())
        {
            var taskType = new TaskType { Id = Guid.NewGuid(), ProjectId = projectId, Name = t.Name, IconName = FieldClamps.ValidIconNameOrNull(t.IconName) };
            _db.TaskTypes.Add(taskType);
            byName[t.Name] = taskType;
        }
        return byName;
    }

    private Dictionary<string, Principle> CreatePrinciples(List<ImportPrincipleDto>? principles, Guid projectId)
    {
        var byOldId = new Dictionary<string, Principle>();
        foreach (var p in principles ?? new List<ImportPrincipleDto>())
        {
            var principle = new Principle
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = p.Key,
                Title = p.Title,
                Description = p.Description,
                DocumentUrl = p.DocumentUrl,
                DateCreated = ParseDateTime(p.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(p.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Principles.Add(principle);
            byOldId[p.Id] = principle;
        }
        return byOldId;
    }

    private static List<ImportTaskNodeDto> FlattenAndDedupTasks(List<ImportTaskNodeDto> hierarchy)
    {
        // buildHierarchy() (src/js/features/export.js) walks the dependency graph as a tree, but the
        // underlying data is a DAG — a task depended on by two others gets serialized once under each
        // dependent, so it can appear more than once in this tree. Dedup by key, or the per-project
        // unique key constraint rejects the second copy.
        var flat = new List<ImportTaskNodeDto>();
        FlattenTasks(hierarchy, flat);
        var seenKeys = new HashSet<string>();
        return flat.Where(t => seenKeys.Add(t.Key)).ToList();
    }

    private (Dictionary<string, TaskItem> ByOldId, Dictionary<string, TaskItem> ByKey, int TaskCounter) CreateTasks(
        List<ImportTaskNodeDto> flatTasks, Guid projectId,
        Dictionary<string, Column> columnsByName, Dictionary<string, ProjectMember> memberByOldId,
        Dictionary<string, Release> releasesByName, Dictionary<string, TaskType> taskTypesByName, List<string> warnings)
    {
        var byOldId = new Dictionary<string, TaskItem>();
        var byKey = new Dictionary<string, TaskItem>();
        var maxCounter = 1;

        foreach (var t in flatTasks)
        {
            if (!columnsByName.TryGetValue(t.Column, out var column))
            {
                warnings.Add($"Task {t.Key}: column \"{t.Column}\" not found in this project, skipped.");
                continue;
            }

            var task = new TaskItem
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = t.Key,
                Title = t.Title,
                Description = t.Description,
                Priority = t.Priority is "low" or "medium" or "high" or "critical" ? t.Priority : "medium",
                ColumnId = column.Id,
                AssigneeId = t.AssigneeId is not null && memberByOldId.TryGetValue(t.AssigneeId, out var assignee) ? assignee.Id : null,
                ReleaseId = t.Release is not null && releasesByName.TryGetValue(t.Release, out var release) ? release.Id : null,
                TypeId = t.Type is not null && taskTypesByName.TryGetValue(t.Type, out var type) ? type.Id : null,
                DocumentationUrl = t.DocumentationUrl,
                DateCreated = ParseDateTime(t.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(t.DateLastModified) ?? DateTime.UtcNow,
                DateDone = ParseDateTime(t.DateDone),
                StartDate = ParseDateOnly(t.StartDate),
                EndDate = ParseDateOnly(t.EndDate),
                BusinessValue = t.BusinessValue,
                TaskCost = t.TaskCost,
                Progress = t.Progress,
                EstimatedEffort = t.EstimatedEffort,
                ActualEffort = t.ActualEffort,
                Archived = t.Archived
            };
            _db.Tasks.Add(task);
            byOldId[t.Id] = task;
            byKey[t.Key] = task;

            var dashIndex = t.Key.LastIndexOf('-');
            if (dashIndex >= 0 && int.TryParse(t.Key[(dashIndex + 1)..], out var n) && n >= maxCounter)
            {
                maxCounter = n + 1;
            }
        }

        return (byOldId, byKey, maxCounter);
    }

    private void WireTaskRelations(List<ImportTaskNodeDto> flatTasks, Dictionary<string, TaskItem> taskByKey)
    {
        foreach (var t in flatTasks)
        {
            if (!taskByKey.TryGetValue(t.Key, out var task)) continue;

            if (t.ParentKey is not null && taskByKey.TryGetValue(t.ParentKey, out var parent))
            {
                task.ParentTaskId = parent.Id;
            }

            foreach (var depKey in t.DependsOn ?? new List<string>())
            {
                if (taskByKey.TryGetValue(depKey, out var depTask))
                {
                    _db.TaskDependencies.Add(new TaskDependency { TaskId = task.Id, DependsOnTaskId = depTask.Id });
                }
            }

            foreach (var entry in t.AuditLog ?? new List<ImportAuditLogEntryDto>())
            {
                _db.TaskAuditLogEntries.Add(new TaskAuditLogEntry
                {
                    Id = Guid.NewGuid(),
                    TaskId = task.Id,
                    Timestamp = ParseDateTime(entry.Timestamp) ?? DateTime.UtcNow,
                    Field = entry.Field,
                    OldValue = entry.OldValue,
                    NewValue = entry.NewValue
                });
            }
        }
    }

    private Dictionary<string, Document> CreateDocuments(List<ImportDocumentDto>? documents, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
    {
        var byOldId = new Dictionary<string, Document>();
        foreach (var d in documents ?? new List<ImportDocumentDto>())
        {
            var doc = new Document
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = d.Key,
                Title = d.Title,
                Url = d.Url,
                Description = d.Description,
                OwnerId = d.OwnerId is not null && memberByOldId.TryGetValue(d.OwnerId, out var owner) ? owner.Id : null,
                TaskId = d.TaskId is not null && taskByOldId.TryGetValue(d.TaskId, out var task) ? task.Id : null,
                DateCreated = ParseDateTime(d.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(d.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Documents.Add(doc);
            byOldId[d.Id] = doc;
        }
        return byOldId;
    }

    private void WireDocumentRelations(List<ImportDocumentDto>? documents, Dictionary<string, Document> documentByOldId)
    {
        foreach (var d in documents ?? new List<ImportDocumentDto>())
        {
            if (!documentByOldId.TryGetValue(d.Id, out var doc)) continue;
            foreach (var relatedOldId in d.RelatedDocumentIds ?? new List<string>())
            {
                if (documentByOldId.TryGetValue(relatedOldId, out var related) && related.Id != doc.Id)
                {
                    _db.Set<DocumentRelation>().Add(new DocumentRelation { DocumentId = doc.Id, RelatedDocumentId = related.Id });
                }
            }
        }
    }

    private Dictionary<string, Risk> CreateRisks(List<ImportRiskDto>? risks, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
    {
        var byOldId = new Dictionary<string, Risk>();
        foreach (var r in risks ?? new List<ImportRiskDto>())
        {
            var risk = new Risk
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = r.Key,
                Title = r.Title,
                Description = r.Description,
                Likelihood = Math.Clamp(r.Likelihood, 1, 5),
                Impact = Math.Clamp(r.Impact, 1, 5),
                Mitigations = r.Mitigations,
                OwnerId = r.OwnerId is not null && memberByOldId.TryGetValue(r.OwnerId, out var owner) ? owner.Id : null,
                TaskId = r.TaskId is not null && taskByOldId.TryGetValue(r.TaskId, out var task) ? task.Id : null,
                Status = r.Status is "new" or "in_review" or "closed" ? r.Status : "new",
                DateToClose = ParseDateOnly(r.DateToClose),
                DateClosed = ParseDateOnly(r.DateClosed),
                DateCreated = ParseDateTime(r.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(r.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Risks.Add(risk);
            byOldId[r.Id] = risk;
        }
        return byOldId;
    }

    private void WireRiskRelations(
        List<ImportRiskDto>? risks, Dictionary<string, Risk> riskByOldId,
        Dictionary<string, Document> documentByOldId, Dictionary<string, Principle> principleByOldId, Dictionary<string, Objective> objectiveByOldId)
    {
        foreach (var r in risks ?? new List<ImportRiskDto>())
        {
            if (!riskByOldId.TryGetValue(r.Id, out var risk)) continue;
            foreach (var docId in r.DocumentIds ?? new List<string>())
                if (documentByOldId.TryGetValue(docId, out var doc)) _db.Set<RiskDocument>().Add(new RiskDocument { RiskId = risk.Id, DocumentId = doc.Id });
            foreach (var prinId in r.PrincipleIds ?? new List<string>())
                if (principleByOldId.TryGetValue(prinId, out var prin)) _db.Set<RiskPrinciple>().Add(new RiskPrinciple { RiskId = risk.Id, PrincipleId = prin.Id });
            foreach (var objId in r.ObjectiveIds ?? new List<string>())
                if (objectiveByOldId.TryGetValue(objId, out var obj)) _db.Set<RiskObjective>().Add(new RiskObjective { RiskId = risk.Id, ObjectiveId = obj.Id });
        }
    }

    private Dictionary<string, Objective> CreateObjectives(List<ImportObjectiveDto>? objectives, Guid projectId)
    {
        var byOldId = new Dictionary<string, Objective>();
        foreach (var o in objectives ?? new List<ImportObjectiveDto>())
        {
            var objective = new Objective
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = o.Key,
                Title = o.Title,
                Description = o.Description,
                DateCreated = ParseDateTime(o.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(o.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Objectives.Add(objective);
            byOldId[o.Id] = objective;
        }
        return byOldId;
    }

    private void WireObjectiveRelations(List<ImportObjectiveDto>? objectives, Dictionary<string, Objective> objectiveByOldId, Dictionary<string, Principle> principleByOldId)
    {
        foreach (var o in objectives ?? new List<ImportObjectiveDto>())
        {
            if (!objectiveByOldId.TryGetValue(o.Id, out var objective)) continue;
            foreach (var prinId in o.PrincipleIds ?? new List<string>())
                if (principleByOldId.TryGetValue(prinId, out var prin)) _db.Set<ObjectivePrinciple>().Add(new ObjectivePrinciple { ObjectiveId = objective.Id, PrincipleId = prin.Id });
        }
    }

    private Dictionary<string, TeamCommittee> CreateTeamsCommittees(List<ImportTeamCommitteeDto>? teamsCommittees, Guid projectId)
    {
        var byOldId = new Dictionary<string, TeamCommittee>();
        foreach (var tc in teamsCommittees ?? new List<ImportTeamCommitteeDto>())
        {
            var committee = new TeamCommittee
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = tc.Key,
                Name = tc.Name,
                Description = tc.Description,
                Type = tc.Type is "team" or "committee" ? tc.Type : "team",
                DateCreated = ParseDateTime(tc.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(tc.DateLastModified) ?? DateTime.UtcNow
            };
            _db.TeamsCommittees.Add(committee);
            byOldId[tc.Id] = committee;
        }
        return byOldId;
    }

    private void WireTeamCommitteeRelations(List<ImportTeamCommitteeDto>? teamsCommittees, Dictionary<string, TeamCommittee> teamCommitteeByOldId, Dictionary<string, ProjectMember> memberByOldId)
    {
        foreach (var tc in teamsCommittees ?? new List<ImportTeamCommitteeDto>())
        {
            if (!teamCommitteeByOldId.TryGetValue(tc.Id, out var committee)) continue;
            if (tc.ParentId is not null && teamCommitteeByOldId.TryGetValue(tc.ParentId, out var parent))
            {
                committee.ParentId = parent.Id;
            }
            foreach (var memId in tc.MemberIds ?? new List<string>())
                if (memberByOldId.TryGetValue(memId, out var member)) _db.Set<TeamCommitteeMember>().Add(new TeamCommitteeMember { TeamCommitteeId = committee.Id, ProjectMemberId = member.Id });
        }
    }

    private Dictionary<string, Decision> CreateDecisions(List<ImportDecisionDto>? decisions, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
    {
        var byOldId = new Dictionary<string, Decision>();
        foreach (var d in decisions ?? new List<ImportDecisionDto>())
        {
            var decision = new Decision
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Key = d.Key,
                Title = d.Title,
                Description = d.Description,
                Type = d.Type is "strategy" or "policy" or "budgetary" or "financial" or "functional" or "technical" or "process" or "operational" ? d.Type : "operational",
                Status = d.Status is "open" or "in_review" or "completed" ? d.Status : "open",
                Outcome = d.Outcome,
                OwnerId = d.OwnerId is not null && memberByOldId.TryGetValue(d.OwnerId, out var owner) ? owner.Id : null,
                Approver = d.Approver,
                TaskId = d.TaskId is not null && taskByOldId.TryGetValue(d.TaskId, out var task) ? task.Id : null,
                DateCreated = ParseDateTime(d.DateCreated) ?? DateTime.UtcNow,
                DateLastModified = ParseDateTime(d.DateLastModified) ?? DateTime.UtcNow
            };
            _db.Decisions.Add(decision);
            byOldId[d.Id] = decision;
        }
        return byOldId;
    }

    private void WireDecisionRelations(
        List<ImportDecisionDto>? decisions, Dictionary<string, Decision> decisionByOldId,
        Dictionary<string, Document> documentByOldId, Dictionary<string, Risk> riskByOldId,
        Dictionary<string, Principle> principleByOldId, Dictionary<string, Objective> objectiveByOldId)
    {
        foreach (var d in decisions ?? new List<ImportDecisionDto>())
        {
            if (!decisionByOldId.TryGetValue(d.Id, out var decision)) continue;
            foreach (var docId in d.DocumentIds ?? new List<string>())
                if (documentByOldId.TryGetValue(docId, out var doc)) _db.Set<DecisionDocument>().Add(new DecisionDocument { DecisionId = decision.Id, DocumentId = doc.Id });
            foreach (var riskId in d.RiskIds ?? new List<string>())
                if (riskByOldId.TryGetValue(riskId, out var risk)) _db.Set<DecisionRisk>().Add(new DecisionRisk { DecisionId = decision.Id, RiskId = risk.Id });
            foreach (var prinId in d.PrincipleIds ?? new List<string>())
                if (principleByOldId.TryGetValue(prinId, out var prin)) _db.Set<DecisionPrinciple>().Add(new DecisionPrinciple { DecisionId = decision.Id, PrincipleId = prin.Id });
            foreach (var objId in d.ObjectiveIds ?? new List<string>())
                if (objectiveByOldId.TryGetValue(objId, out var obj)) _db.Set<DecisionObjective>().Add(new DecisionObjective { DecisionId = decision.Id, ObjectiveId = obj.Id });
        }
    }

    private static void ValidateNoCycles(
        List<ImportTaskNodeDto> flatTasks, Dictionary<string, TaskItem> taskByKey,
        List<ImportTeamCommitteeDto>? teamsCommittees, Dictionary<string, TeamCommittee> teamCommitteeByOldId)
    {
        var adjacency = new Dictionary<Guid, List<Guid>>();
        foreach (var t in flatTasks)
        {
            if (!taskByKey.TryGetValue(t.Key, out var task)) continue;
            var deps = new List<Guid>();
            foreach (var depKey in t.DependsOn ?? new List<string>())
                if (taskByKey.TryGetValue(depKey, out var depTask)) deps.Add(depTask.Id);
            adjacency[task.Id] = deps;
        }
        if (CycleDetection.HasCycle(adjacency))
        {
            throw new ApiValidationException("The imported task dependency graph contains a cycle.");
        }

        var taskParentById = flatTasks
            .Where(t => taskByKey.ContainsKey(t.Key))
            .ToDictionary(
                t => taskByKey[t.Key].Id,
                t => t.ParentKey is not null && taskByKey.TryGetValue(t.ParentKey, out var p) ? (Guid?)p.Id : null);
        if (CycleDetection.HasParentCycle(taskParentById))
        {
            throw new ApiValidationException("The imported sub-task hierarchy contains a cycle.");
        }

        var committeeParentById = (teamsCommittees ?? new List<ImportTeamCommitteeDto>())
            .Where(tc => teamCommitteeByOldId.ContainsKey(tc.Id))
            .ToDictionary(
                tc => teamCommitteeByOldId[tc.Id].Id,
                tc => tc.ParentId is not null && teamCommitteeByOldId.TryGetValue(tc.ParentId, out var p) ? (Guid?)p.Id : null);
        if (CycleDetection.HasParentCycle(committeeParentById))
        {
            throw new ApiValidationException("The imported Teams & Committees hierarchy contains a cycle.");
        }
    }

    private async Task<string> ResolveUniqueProjectKeyAsync(string baseKey)
    {
        var candidate = baseKey;
        var suffix = 1;
        while (await _db.Projects.AnyAsync(p => p.Key == candidate))
        {
            candidate = $"{baseKey}{++suffix}";
        }
        return candidate;
    }

    private async Task<string> ResolveUniqueUsernameAsync(string baseUsername)
    {
        var candidate = baseUsername;
        var suffix = 1;
        while (await _db.Users.AnyAsync(u => u.NormalizedUsername == candidate))
        {
            candidate = $"{baseUsername}{++suffix}";
        }
        return candidate;
    }

    private static void FlattenTasks(IEnumerable<ImportTaskNodeDto> nodes, List<ImportTaskNodeDto> into)
    {
        foreach (var node in nodes)
        {
            into.Add(node);
            if (node.Subtasks is { Count: > 0 })
            {
                FlattenTasks(node.Subtasks, into);
            }
        }
    }

    private static DateTime? ParseDateTime(string? value) =>
        DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    private static DateOnly? ParseDateOnly(string? value) =>
        ParseDateTime(value) is { } d ? DateOnly.FromDateTime(d) : null;
}
