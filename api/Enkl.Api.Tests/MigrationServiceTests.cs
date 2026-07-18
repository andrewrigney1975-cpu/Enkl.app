using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding #2 — MigrationService.cs (683 lines: import dedup/wiring/cycle-
/// detection) was specifically called out in the review as complex and security-sensitive enough to
/// prioritize early. Direct service calls (resolved from the fixture's DI container), not HTTP — the
/// service takes only AppDbContext, and what's under test here is the service's own logic, not the
/// HTTP/auth pipeline (that's AuthTests.cs's job).
/// </summary>
[Collection("Postgres API collection")]
public class MigrationServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public MigrationServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    private static MigrationImportRequest BuildRequest(
        string orgName, string projectKey, List<ImportMemberDto> members, List<ImportTaskNodeDto>? hierarchy = null)
    {
        // CreateTasks (MigrationService.cs) looks columns up by Name, not Id — every ImportTaskNodeDto
        // in this file sets Column: "c1", so Name must be "c1" too or the task is silently skipped as
        // "column not found" (which is exactly what masked the cycle-detection test below).
        var columns = new List<ImportColumnDto> { new("c1", "c1", false, null, 0) };
        return new MigrationImportRequest(
            OrganisationName: orgName,
            Project: new ImportProjectDto(projectKey, projectKey),
            Members: members,
            Columns: columns,
            Releases: null, TaskTypes: null, Principles: null, Documents: null, Risks: null,
            Objectives: null, TeamsCommittees: null, Decisions: null,
            Hierarchy: hierarchy ?? new List<ImportTaskNodeDto>());
    }

    [Fact]
    public async Task Migrate_NewOrgName_BootstrapsOrgAndMakesFirstMemberAdmin()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var orgName = TestDataHelper.Unique("org");
        var request = BuildRequest(orgName, TestDataHelper.Unique("PRJ"), new List<ImportMemberDto>
        {
            new("m1", "First Admin", "#4f46e5", Role: null, ReportsToId: null)
        });

        var result = await migration.MigrateAsync(request, callerOrgId: null);

        Assert.True(result.OrganisationCreated);
        Assert.Equal(1, result.UsersCreated);

        var createdUser = await db.Users.SingleAsync(u => u.OrganisationId == result.OrganisationId);
        Assert.True(createdUser.IsOrgAdmin);
    }

    // Security review finding C3: the exact vector that fix closed — an anonymous caller could
    // previously get a login-capable account silently created inside ANY org whose display name they
    // knew or guessed.
    [Fact]
    public async Task Migrate_AnonymousCallerTargetingExistingOrgName_ThrowsValidationException()
    {
        using var scope = _fixture.CreateScope();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var orgName = TestDataHelper.Unique("org");
        var bootstrapRequest = BuildRequest(orgName, TestDataHelper.Unique("PRJ"), new List<ImportMemberDto>
        {
            new("m1", "Original Admin", "#4f46e5", Role: null, ReportsToId: null)
        });
        await migration.MigrateAsync(bootstrapRequest, callerOrgId: null);

        var intruderRequest = BuildRequest(orgName, TestDataHelper.Unique("PRJ"), new List<ImportMemberDto>
        {
            new("m1", "Uninvited", "#4f46e5", Role: null, ReportsToId: null)
        });

        await Assert.ThrowsAsync<ApiValidationException>(() => migration.MigrateAsync(intruderRequest, callerOrgId: null));
    }

    [Fact]
    public async Task Migrate_AuthenticatedCaller_AlwaysLandsInOwnOrg_RegardlessOfDocumentOrgName()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var (callerOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));

        var request = BuildRequest(
            orgName: TestDataHelper.Unique("some-other-org-entirely"),
            projectKey: TestDataHelper.Unique("PRJ"),
            members: new List<ImportMemberDto> { new("m1", "Second Project Owner", "#4f46e5", Role: null, ReportsToId: null) });

        var result = await migration.MigrateAsync(request, callerOrgId: callerOrg.Id);

        Assert.False(result.OrganisationCreated);
        Assert.Equal(callerOrg.Id, result.OrganisationId);
    }

    [Fact]
    public async Task Migrate_DuplicateUsernameWithinSameOrg_IsMatchedNotDuplicated()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var memberName = TestDataHelper.Unique("Alice");
        var orgName = TestDataHelper.Unique("org");
        var first = await migration.MigrateAsync(
            BuildRequest(orgName, TestDataHelper.Unique("PRJ1"), new List<ImportMemberDto> { new("m1", memberName, "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: null);

        var second = await migration.MigrateAsync(
            BuildRequest(TestDataHelper.Unique("unused-name"), TestDataHelper.Unique("PRJ2"), new List<ImportMemberDto> { new("m1", memberName, "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: first.OrganisationId);

        Assert.Equal(0, second.UsersCreated);
        Assert.Equal(1, second.UsersMatched);

        var normalizedMemberName = UsernameNormalizer.Normalize(memberName);
        var usersWithThatName = await db.Users.CountAsync(u => u.OrganisationId == first.OrganisationId && u.NormalizedUsername == normalizedMemberName);
        Assert.Equal(1, usersWithThatName);
    }

    [Fact]
    public async Task Migrate_SameUsernameAcrossDifferentOrgs_GetsSuffixedWithWarning_NotMergedCrossTenant()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var memberName = TestDataHelper.Unique("Bob");
        var firstOrgResult = await migration.MigrateAsync(
            BuildRequest(TestDataHelper.Unique("org-a"), TestDataHelper.Unique("PRJ1"), new List<ImportMemberDto> { new("m1", memberName, "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: null);

        var secondOrgResult = await migration.MigrateAsync(
            BuildRequest(TestDataHelper.Unique("org-b"), TestDataHelper.Unique("PRJ2"), new List<ImportMemberDto> { new("m1", memberName, "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: null);

        Assert.Equal(1, secondOrgResult.UsersCreated);
        Assert.Contains(secondOrgResult.Warnings, w => w.Contains("already exists in another organisation", StringComparison.OrdinalIgnoreCase));

        var userInSecondOrg = await db.Users.SingleAsync(u => u.OrganisationId == secondOrgResult.OrganisationId);
        var userInFirstOrg = await db.Users.SingleAsync(u => u.OrganisationId == firstOrgResult.OrganisationId);
        Assert.NotEqual(userInFirstOrg.NormalizedUsername, userInSecondOrg.NormalizedUsername);
    }

    [Fact]
    public async Task Migrate_TaskWithComments_RemapsAuthorIdThroughMemberByOldId()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var node = new ImportTaskNodeDto(
            Id: "t1", Key: "CMT-1", Title: "Task A", Description: null, Priority: "medium", Column: "c1",
            AssigneeId: null, Assignee: null, Release: null, Type: null, DocumentationUrl: null,
            DateCreated: null, DateLastModified: null, DateDone: null, StartDate: null, EndDate: null,
            BusinessValue: null, TaskCost: null, Progress: 0, EstimatedEffort: null, ActualEffort: null,
            Archived: false, DependsOn: null, AuditLog: null,
            Comments: new List<ImportCommentDto> { new("c1", "Looks good to me", "2026-01-01T00:00:00Z", "m1", "Local Author") },
            ParentKey: null, Subtasks: null);

        var request = BuildRequest(TestDataHelper.Unique("org"), TestDataHelper.Unique("PRJ"),
            new List<ImportMemberDto> { new("m1", "Local Author", "#4f46e5", Role: null, ReportsToId: null) },
            new List<ImportTaskNodeDto> { node });

        var result = await migration.MigrateAsync(request);

        var task = await db.Tasks.SingleAsync(t => t.ProjectId == result.ProjectId && t.Key == "CMT-1");
        var comment = await db.TaskComments.SingleAsync(c => c.TaskId == task.Id);
        var member = await db.ProjectMembers.SingleAsync(m => m.ProjectId == result.ProjectId);

        Assert.Equal("Looks good to me", comment.Text);
        Assert.Equal("Local Author", comment.AuthorName);
        Assert.Equal(member.Id, comment.AuthorId);
    }

    [Fact]
    public async Task Migrate_TaskHierarchyWithDependencyCycle_ThrowsValidationException()
    {
        using var scope = _fixture.CreateScope();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var taskA = new ImportTaskNodeDto(
            Id: "t1", Key: "CYC-1", Title: "Task A", Description: null, Priority: "medium", Column: "c1",
            AssigneeId: null, Assignee: null, Release: null, Type: null, DocumentationUrl: null,
            DateCreated: null, DateLastModified: null, DateDone: null, StartDate: null, EndDate: null,
            BusinessValue: null, TaskCost: null, Progress: 0, EstimatedEffort: null, ActualEffort: null,
            Archived: false, DependsOn: new List<string> { "CYC-2" }, AuditLog: null, Comments: null, ParentKey: null, Subtasks: null);
        var taskB = taskA with { Id = "t2", Key = "CYC-2", Title = "Task B", DependsOn = new List<string> { "CYC-1" } };

        var request = BuildRequest(TestDataHelper.Unique("org"), TestDataHelper.Unique("PRJ"),
            new List<ImportMemberDto> { new("m1", "Owner", "#4f46e5", Role: null, ReportsToId: null) },
            hierarchy: new List<ImportTaskNodeDto> { taskA, taskB });

        await Assert.ThrowsAsync<ApiValidationException>(() => migration.MigrateAsync(request, callerOrgId: null));
    }

    [Fact]
    public async Task Migrate_ProjectKeyCollisionWithinOrg_GetsAutoSuffixedWithWarning()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var migration = scope.ServiceProvider.GetRequiredService<MigrationService>();

        var projectKey = TestDataHelper.Unique("DUP");
        var first = await migration.MigrateAsync(
            BuildRequest(TestDataHelper.Unique("org"), projectKey, new List<ImportMemberDto> { new("m1", "Owner", "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: null);

        var second = await migration.MigrateAsync(
            BuildRequest(TestDataHelper.Unique("unused-name"), projectKey, new List<ImportMemberDto> { new("m2", "Second Owner", "#4f46e5", Role: null, ReportsToId: null) }),
            callerOrgId: first.OrganisationId);

        Assert.Contains(second.Warnings, w => w.Contains("already in use", StringComparison.OrdinalIgnoreCase));

        var secondProject = await db.Projects.SingleAsync(p => p.Id == second.ProjectId);
        Assert.NotEqual(projectKey, secondProject.Key);
    }
}
