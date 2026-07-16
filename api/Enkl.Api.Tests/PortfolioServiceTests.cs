using Enkl.Api.Data;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.1 — PortfolioService.cs (486 lines) was split into
/// PortfolioService/PortfolioCategoryService/PortfolioResourceService with zero existing test
/// coverage as a safety net (unlike MigrationService, which had MigrationServiceTests.cs already).
/// These tests exist specifically to verify that split, not as exhaustive coverage of every method —
/// one round-trip per new class, plus the cross-org isolation guarantee every Portfolio* class
/// documents, since that's the single most repeated security idiom in this codebase (CLAUDE.md §1).
/// </summary>
[Collection("Postgres API collection")]
public class PortfolioServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public PortfolioServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task CreateProjectAsync_CreatesInactivePlaceholderProject()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var portfolio = scope.ServiceProvider.GetRequiredService<PortfolioService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));

        var request = new CreatePortfolioProjectRequest(TestDataHelper.Unique("Draft Project"), null, "high", null, null, null);
        var result = await portfolio.CreateProjectAsync(org.Id, request);

        Assert.False(result.IsActive);
        Assert.Equal("high", result.Priority);

        var listed = await portfolio.ListProjectsAsync(org.Id);
        Assert.Contains(listed, p => p.Id == result.Id);
    }

    [Fact]
    public async Task UpdateProjectActiveAsync_RejectsActivationWithoutBothDates()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var portfolio = scope.ServiceProvider.GetRequiredService<PortfolioService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await portfolio.CreateProjectAsync(org.Id, new CreatePortfolioProjectRequest(TestDataHelper.Unique("Draft"), null, null, null, null, null));

        var withoutDates = await portfolio.UpdateProjectActiveAsync(org.Id, project.Id, isActive: true);
        Assert.Equal(PortfolioActivationResult.MissingDates, withoutDates);

        var datesSet = await portfolio.UpdateProjectDatesAsync(org.Id, project.Id, DateOnly.FromDateTime(DateTime.UtcNow), DateOnly.FromDateTime(DateTime.UtcNow.AddDays(30)));
        Assert.True(datesSet);

        var withDates = await portfolio.UpdateProjectActiveAsync(org.Id, project.Id, isActive: true);
        Assert.Equal(PortfolioActivationResult.Ok, withDates);
    }

    // Cross-org isolation (CLAUDE.md §1/§4): a project id from a DIFFERENT org must be treated as
    // not-found, never touched, regardless of which Portfolio* class owns the write.
    [Fact]
    public async Task UpdateProjectDatesAsync_RejectsProjectFromAnotherOrg()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var portfolio = scope.ServiceProvider.GetRequiredService<PortfolioService>();

        var (ownerOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (otherOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await portfolio.CreateProjectAsync(ownerOrg.Id, new CreatePortfolioProjectRequest(TestDataHelper.Unique("Draft"), null, null, null, null, null));

        var result = await portfolio.UpdateProjectDatesAsync(otherOrg.Id, project.Id, DateOnly.FromDateTime(DateTime.UtcNow), DateOnly.FromDateTime(DateTime.UtcNow.AddDays(1)));

        Assert.False(result);
    }

    [Fact]
    public async Task PortfolioCategoryService_CreateListUpdateDeleteRoundTrip()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var categories = scope.ServiceProvider.GetRequiredService<PortfolioCategoryService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));

        var created = await categories.CreateCategoryAsync(org.Id, "Growth Initiatives");
        Assert.Equal("Growth Initiatives", created.Name);

        var listed = await categories.ListCategoriesAsync(org.Id);
        Assert.Contains(listed, c => c.Id == created.Id);

        var renamed = await categories.UpdateCategoryAsync(org.Id, created.Id, "Renamed");
        Assert.NotNull(renamed);
        Assert.Equal("Renamed", renamed!.Name);

        var deleted = await categories.DeleteCategoryAsync(org.Id, created.Id);
        Assert.True(deleted);
        Assert.DoesNotContain(await categories.ListCategoriesAsync(org.Id), c => c.Id == created.Id);
    }

    [Fact]
    public async Task PortfolioResourceService_AddUpdateRemoveRoundTrip()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var portfolio = scope.ServiceProvider.GetRequiredService<PortfolioService>();
        var resources = scope.ServiceProvider.GetRequiredService<PortfolioResourceService>();

        var (org, user) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await portfolio.CreateProjectAsync(org.Id, new CreatePortfolioProjectRequest(TestDataHelper.Unique("Draft"), null, null, null, null, null));

        var added = await resources.AddResourceAsync(org.Id, project.Id, new CreateProjectResourcePlaceholderRequest("Engineer", user.Id, 50));
        Assert.NotNull(added);
        Assert.Equal(50, added!.AllocatedFraction);

        var listed = await resources.ListResourcesAsync(org.Id, project.Id);
        Assert.NotNull(listed);
        Assert.Single(listed!);

        var updated = await resources.UpdateResourceAsync(org.Id, project.Id, added.Id, new UpdateProjectResourcePlaceholderRequest("Lead Engineer", user.Id, 80));
        Assert.NotNull(updated);
        Assert.Equal("Lead Engineer", updated!.Role);
        Assert.Equal(80, updated.AllocatedFraction);

        var removed = await resources.RemoveResourceAsync(org.Id, project.Id, added.Id);
        Assert.True(removed);
        Assert.Empty((await resources.ListResourcesAsync(org.Id, project.Id))!);
    }

    // A UserId belonging to a DIFFERENT org must silently drop to null (ValidateOrgUserIdAsync),
    // never assign a foreign-org user onto this org's placeholder resource.
    [Fact]
    public async Task PortfolioResourceService_AddResourceAsync_DropsUserIdFromAnotherOrg()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var portfolio = scope.ServiceProvider.GetRequiredService<PortfolioService>();
        var resources = scope.ServiceProvider.GetRequiredService<PortfolioResourceService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var (otherOrg, otherUser) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("user"));
        var project = await portfolio.CreateProjectAsync(org.Id, new CreatePortfolioProjectRequest(TestDataHelper.Unique("Draft"), null, null, null, null, null));

        var added = await resources.AddResourceAsync(org.Id, project.Id, new CreateProjectResourcePlaceholderRequest("Engineer", otherUser.Id, 50));

        Assert.NotNull(added);
        Assert.Null(added!.UserId);
    }
}
