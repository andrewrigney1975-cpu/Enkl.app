using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// Create: any project member, author always server-derived. Update: author-only. Delete: author OR
/// Project Admin OR Org Admin. Mirrors the PHP tier's TaskCommentServiceTest.php exactly.
/// </summary>
[Collection("Postgres API collection")]
public class TaskCommentServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public TaskCommentServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    private static async Task<(Project Project, Column Column, TaskItem Task)> SeedProjectWithTaskAsync(AppDbContext db, Guid organisationId)
    {
        var project = await TestDataHelper.SeedProjectAsync(db, organisationId, TestDataHelper.Unique("PRJ"));
        var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = "To Do", Done = false, Order = 0 };
        db.Columns.Add(column);
        var task = new TaskItem
        {
            Id = Guid.NewGuid(), ProjectId = project.Id, Key = $"{project.Key}-1", Title = "Task",
            ColumnId = column.Id, DateCreated = DateTime.UtcNow, DateLastModified = DateTime.UtcNow
        };
        db.Tasks.Add(task);
        await db.SaveChangesAsync();
        return (project, column, task);
    }

    private static async Task<ProjectMember> AddMemberAsync(AppDbContext db, Guid projectId, Guid userId, bool isProjectAdmin = false)
    {
        var member = new ProjectMember { Id = Guid.NewGuid(), ProjectId = projectId, UserId = userId, Color = "#4f46e5", IsProjectAdmin = isProjectAdmin };
        db.ProjectMembers.Add(member);
        await db.SaveChangesAsync();
        return member;
    }

    [Fact]
    public async Task CreateAsync_StampsCallerAsAuthorFromTheirOwnMembership()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        var member = await AddMemberAsync(db, project.Id, user.Id);

        var result = await comments.CreateAsync(user.Id, project.Id, task.Id, new CreateTaskCommentRequest("Looks good"));

        Assert.NotNull(result);
        Assert.Equal("Looks good", result!.Text);
        Assert.Equal(member.Id, result.AuthorId);
        Assert.Equal(user.DisplayName, result.AuthorName);
    }

    [Fact]
    public async Task CreateAsync_ThrowsWhenCallerHasNoMembership()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);

        await Assert.ThrowsAsync<ApiValidationException>(() =>
            comments.CreateAsync(user.Id, project.Id, task.Id, new CreateTaskCommentRequest("Hi")));
    }

    [Fact]
    public async Task CreateAsync_ReturnsNullForTaskOutsideProject()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        var otherProject = await TestDataHelper.SeedProjectAsync(db, org.Id, TestDataHelper.Unique("PRJ"));
        await AddMemberAsync(db, project.Id, user.Id);

        var result = await comments.CreateAsync(user.Id, otherProject.Id, task.Id, new CreateTaskCommentRequest("Hi"));

        Assert.Null(result);
    }

    [Fact]
    public async Task UpdateAsync_AuthorCanEditTheirOwnComment()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, user.Id);
        var created = await comments.CreateAsync(user.Id, project.Id, task.Id, new CreateTaskCommentRequest("Original"));

        var updated = await comments.UpdateAsync(user.Id, project.Id, task.Id, created!.Id, new UpdateTaskCommentRequest("Edited"));

        Assert.NotNull(updated);
        Assert.Equal("Edited", updated!.Text);
    }

    [Fact]
    public async Task UpdateAsync_ReturnsNullForNonAuthor()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (_, otherUser) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org2"), TestDataHelper.Unique("other"), isOrgAdmin: false);
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, author.Id);
        await AddMemberAsync(db, project.Id, otherUser.Id);
        var created = await comments.CreateAsync(author.Id, project.Id, task.Id, new CreateTaskCommentRequest("Original"));

        var updated = await comments.UpdateAsync(otherUser.Id, project.Id, task.Id, created!.Id, new UpdateTaskCommentRequest("Hijacked"));

        Assert.Null(updated);
        var row = await db.TaskComments.FindAsync(created.Id);
        Assert.Equal("Original", row!.Text);
    }

    [Fact]
    public async Task DeleteAsync_AuthorCanDeleteTheirOwnComment()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, user.Id);
        var created = await comments.CreateAsync(user.Id, project.Id, task.Id, new CreateTaskCommentRequest("Bye"));

        var deleted = await comments.DeleteAsync(user.Id, project.Id, task.Id, created!.Id, callerClaimsOrgAdmin: false, callerOrgId: null);

        Assert.True(deleted);
        Assert.Null(await db.TaskComments.FindAsync(created.Id));
    }

    [Fact]
    public async Task DeleteAsync_ReturnsFalseForNonAuthorNonAdmin()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (_, otherUser) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org2"), TestDataHelper.Unique("other"), isOrgAdmin: false);
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, author.Id);
        await AddMemberAsync(db, project.Id, otherUser.Id);
        var created = await comments.CreateAsync(author.Id, project.Id, task.Id, new CreateTaskCommentRequest("Mine"));

        var deleted = await comments.DeleteAsync(otherUser.Id, project.Id, task.Id, created!.Id, callerClaimsOrgAdmin: false, callerOrgId: null);

        Assert.False(deleted);
        Assert.NotNull(await db.TaskComments.FindAsync(created.Id));
    }

    [Fact]
    public async Task DeleteAsync_ProjectAdminCanDeleteAnotherMembersComment()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (_, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org2"), TestDataHelper.Unique("admin"), isOrgAdmin: false);
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, author.Id);
        await AddMemberAsync(db, project.Id, admin.Id, isProjectAdmin: true);
        var created = await comments.CreateAsync(author.Id, project.Id, task.Id, new CreateTaskCommentRequest("Needs moderation"));

        var deleted = await comments.DeleteAsync(admin.Id, project.Id, task.Id, created!.Id, callerClaimsOrgAdmin: false, callerOrgId: null);

        Assert.True(deleted);
    }

    [Fact]
    public async Task DeleteAsync_OrgAdminFromCallersOwnOrgCanDeleteWithoutMembership()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (_, orgAdmin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org3"), TestDataHelper.Unique("orgadmin"), isOrgAdmin: true);
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, author.Id);
        var created = await comments.CreateAsync(author.Id, project.Id, task.Id, new CreateTaskCommentRequest("Needs moderation"));

        // orgAdmin has NO ProjectMembers row at all here — callerOrgId must equal the PROJECT's own
        // organisation (org.Id), not orgAdmin's own seeded org, to prove the live re-derivation.
        var deleted = await comments.DeleteAsync(orgAdmin.Id, project.Id, task.Id, created!.Id, callerClaimsOrgAdmin: true, callerOrgId: org.Id);

        Assert.True(deleted);
    }

    [Fact]
    public async Task DeleteAsync_OrgAdminFromDifferentOrgCannotDelete()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = scope.ServiceProvider.GetRequiredService<TaskCommentService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (otherOrg, foreignOrgAdmin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org4"), TestDataHelper.Unique("foreignadmin"), isOrgAdmin: true);
        var (project, _, task) = await SeedProjectWithTaskAsync(db, org.Id);
        await AddMemberAsync(db, project.Id, author.Id);
        var created = await comments.CreateAsync(author.Id, project.Id, task.Id, new CreateTaskCommentRequest("Needs moderation"));

        var deleted = await comments.DeleteAsync(foreignOrgAdmin.Id, project.Id, task.Id, created!.Id, callerClaimsOrgAdmin: true, callerOrgId: otherOrg.Id);

        Assert.False(deleted);
    }
}
