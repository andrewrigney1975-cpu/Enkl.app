using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.2 — GetTasksPagedAsync is a brand-new endpoint (additive, not a
/// replacement for GetProjectDetailAsync), so this is its only coverage: proves the pagination math
/// (page/pageSize/TotalCount) and the not-found-project case, both introduced by this change.
/// </summary>
[Collection("Postgres API collection")]
public class TaskServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public TaskServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task GetTasksPagedAsync_ReturnsCorrectSliceAndTotalCount()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tasks = scope.ServiceProvider.GetRequiredService<TaskService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await TestDataHelper.SeedProjectAsync(db, org.Id, TestDataHelper.Unique("PRJ"));

        var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = "To Do", Done = false, Order = 0 };
        db.Columns.Add(column);

        for (var i = 0; i < 5; i++)
        {
            db.Tasks.Add(new TaskItem
            {
                Id = Guid.NewGuid(),
                ProjectId = project.Id,
                Key = $"{project.Key}-{i + 1}",
                Title = $"Task {i}",
                ColumnId = column.Id,
                DateCreated = DateTime.UtcNow.AddMinutes(i),
                DateLastModified = DateTime.UtcNow.AddMinutes(i)
            });
        }
        await db.SaveChangesAsync();

        var firstPage = await tasks.GetTasksPagedAsync(project.Id, page: 1, pageSize: 2);
        Assert.NotNull(firstPage);
        Assert.Equal(5, firstPage!.TotalCount);
        Assert.Equal(2, firstPage.Items.Count);
        Assert.Equal("Task 0", firstPage.Items[0].Title);
        Assert.Equal("Task 1", firstPage.Items[1].Title);

        var secondPage = await tasks.GetTasksPagedAsync(project.Id, page: 2, pageSize: 2);
        Assert.Equal("Task 2", secondPage!.Items[0].Title);

        var lastPage = await tasks.GetTasksPagedAsync(project.Id, page: 3, pageSize: 2);
        Assert.Single(lastPage!.Items);
        Assert.Equal("Task 4", lastPage.Items[0].Title);
    }

    [Fact]
    public async Task GetTasksPagedAsync_ReturnsNullForNonexistentProject()
    {
        using var scope = _fixture.CreateScope();
        var tasks = scope.ServiceProvider.GetRequiredService<TaskService>();

        var result = await tasks.GetTasksPagedAsync(Guid.NewGuid(), page: 1, pageSize: 50);

        Assert.Null(result);
    }

    [Fact]
    public async Task GetTasksPagedAsync_ClampsPageSizeToMaximum()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tasks = scope.ServiceProvider.GetRequiredService<TaskService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await TestDataHelper.SeedProjectAsync(db, org.Id, TestDataHelper.Unique("PRJ"));

        var result = await tasks.GetTasksPagedAsync(project.Id, page: 1, pageSize: 10000);

        Assert.NotNull(result);
        Assert.Equal(200, result!.PageSize);
    }
}
