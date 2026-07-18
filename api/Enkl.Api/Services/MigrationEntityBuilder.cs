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
/// ARCHITECTURE-REVIEW.md finding 2.1: split out of MigrationService.cs — the "create every entity
/// group and wire up their relational fields" seam, the bulk of the original file. Two passes per
/// entity group, same shape throughout: pass 1 (the Create* methods) creates rows and records an
/// old-id (or, for the Task hierarchy, old-key) -> new-entity map; pass 2 (the Wire* methods) wires
/// up the relational fields once every entity's map exists, so it doesn't matter what order entities
/// appear in the export doc. MigrationService orchestrates the call order; this class holds no
/// cross-call state of its own beyond the shared AppDbContext.
/// </summary>
public class MigrationEntityBuilder
{
    private readonly AppDbContext _db;

    public MigrationEntityBuilder(AppDbContext db)
    {
        _db = db;
    }

    public async Task<(Dictionary<string, ProjectMember> MemberByOldId, int UsersCreated, int UsersMatched)> CreateUsersAndMembersAsync(
        List<ImportMemberDto> members, Guid projectId, Guid organisationId, bool organisationCreated, List<string> warnings)
    {
        var usersCreated = 0;
        var usersMatched = 0;
        var userIdByNormalizedKey = new Dictionary<string, Guid>();
        var memberByOldId = new Dictionary<string, ProjectMember>();
        var firstAdminAssigned = false;
        // The first member listed in the export is treated as this project's "owner" — same
        // always-a-Project-Admin default ProjectService.CreateAsync gives a freshly created
        // project's creator, applied here so a migrated project isn't immediately locked out of
        // column/settings/workflow/member management either.
        var isFirstProjectMember = true;

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

            var member = new ProjectMember { Id = Guid.NewGuid(), ProjectId = projectId, UserId = userId, Color = m.Color, Role = m.Role, IsProjectAdmin = isFirstProjectMember, AllocatedFraction = m.AllocatedFraction is { } fraction ? Math.Clamp(fraction, 0, 100) : null };
            _db.ProjectMembers.Add(member);
            memberByOldId[m.Id] = member;
            isFirstProjectMember = false;
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

    public Dictionary<string, Release> CreateReleases(List<ImportReleaseDto>? releases, Guid projectId, Dictionary<string, ProjectMember> memberByOldId)
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

    public Dictionary<string, TaskType> CreateTaskTypes(List<ImportTaskTypeDto>? taskTypes, Guid projectId)
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

    public Dictionary<string, Principle> CreatePrinciples(List<ImportPrincipleDto>? principles, Guid projectId)
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

    /// <summary>buildHierarchy() (src/js/features/export.js) walks the dependency graph as a tree,
    /// but the underlying data is a DAG — a task depended on by two others gets serialized once under
    /// each dependent, so it can appear more than once in this tree. Dedup by key, or the per-project
    /// unique key constraint rejects the second copy.</summary>
    public static List<ImportTaskNodeDto> FlattenAndDedupTasks(List<ImportTaskNodeDto> hierarchy)
    {
        var flat = new List<ImportTaskNodeDto>();
        FlattenTasks(hierarchy, flat);
        var seenKeys = new HashSet<string>();
        return flat.Where(t => seenKeys.Add(t.Key)).ToList();
    }

    public (Dictionary<string, TaskItem> ByOldId, Dictionary<string, TaskItem> ByKey, int TaskCounter) CreateTasks(
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

    public void WireTaskRelations(List<ImportTaskNodeDto> flatTasks, Dictionary<string, TaskItem> taskByKey, Dictionary<string, ProjectMember> memberByOldId)
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

            foreach (var comment in t.Comments ?? new List<ImportCommentDto>())
            {
                _db.TaskComments.Add(new TaskComment
                {
                    Id = Guid.NewGuid(),
                    TaskId = task.Id,
                    Text = comment.Text,
                    DateCreated = ParseDateTime(comment.DateCreated) ?? DateTime.UtcNow,
                    AuthorId = comment.AuthorId is not null && memberByOldId.TryGetValue(comment.AuthorId, out var author) ? author.Id : null,
                    AuthorName = comment.AuthorName ?? ""
                });
            }
        }
    }

    public Dictionary<string, Document> CreateDocuments(List<ImportDocumentDto>? documents, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
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

    public void WireDocumentRelations(List<ImportDocumentDto>? documents, Dictionary<string, Document> documentByOldId)
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

    public Dictionary<string, Risk> CreateRisks(List<ImportRiskDto>? risks, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
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

    public void WireRiskRelations(
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

    public Dictionary<string, Objective> CreateObjectives(List<ImportObjectiveDto>? objectives, Guid projectId)
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

    public void WireObjectiveRelations(List<ImportObjectiveDto>? objectives, Dictionary<string, Objective> objectiveByOldId, Dictionary<string, Principle> principleByOldId)
    {
        foreach (var o in objectives ?? new List<ImportObjectiveDto>())
        {
            if (!objectiveByOldId.TryGetValue(o.Id, out var objective)) continue;
            foreach (var prinId in o.PrincipleIds ?? new List<string>())
                if (principleByOldId.TryGetValue(prinId, out var prin)) _db.Set<ObjectivePrinciple>().Add(new ObjectivePrinciple { ObjectiveId = objective.Id, PrincipleId = prin.Id });
        }
    }

    public Dictionary<string, TeamCommittee> CreateTeamsCommittees(List<ImportTeamCommitteeDto>? teamsCommittees, Guid projectId)
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

    public void WireTeamCommitteeRelations(List<ImportTeamCommitteeDto>? teamsCommittees, Dictionary<string, TeamCommittee> teamCommitteeByOldId, Dictionary<string, ProjectMember> memberByOldId)
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

    public Dictionary<string, Decision> CreateDecisions(List<ImportDecisionDto>? decisions, Guid projectId, Dictionary<string, ProjectMember> memberByOldId, Dictionary<string, TaskItem> taskByOldId)
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

    public void WireDecisionRelations(
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
