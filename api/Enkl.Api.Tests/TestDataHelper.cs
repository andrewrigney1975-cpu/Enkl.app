using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;

namespace Enkl.Api.Tests;

/// <summary>
/// Shared seeding helpers for direct-EF-Core test setup. Every name passed in must already be
/// unique-per-test (Guid-suffixed by the caller) — see PostgresApiFixture's own doc comment for why:
/// one Postgres container is shared across the whole test run, so a fixed name colliding with another
/// test's leftover data produces confusing failures rather than a clean, isolated test.
/// </summary>
public static class TestDataHelper
{
    public const string DefaultPassword = "TestPassword123!";

    public static async Task<(Organisation Org, User User)> SeedOrgAndUserAsync(
        AppDbContext db, string orgName, string username, bool isOrgAdmin = true, bool mustChangePassword = false)
    {
        var org = new Organisation
        {
            Id = Guid.NewGuid(),
            Name = orgName,
            NormalizedName = orgName.ToLowerInvariant(),
            CreatedAt = DateTime.UtcNow
        };
        db.Organisations.Add(org);

        var user = new User
        {
            Id = Guid.NewGuid(),
            OrganisationId = org.Id,
            Username = username,
            NormalizedUsername = UsernameNormalizer.Normalize(username),
            PasswordHash = PasswordHasher.Hash(DefaultPassword),
            DisplayName = username,
            MustChangePassword = mustChangePassword,
            IsOrgAdmin = isOrgAdmin,
            IsActive = true,
            CreatedAt = DateTime.UtcNow
        };
        db.Users.Add(user);

        await db.SaveChangesAsync();
        return (org, user);
    }

    public static async Task<Project> SeedProjectAsync(AppDbContext db, Guid organisationId, string key, User? member = null)
    {
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = key,
            Key = key,
            DateCreated = DateTime.UtcNow,
            DateLastModified = DateTime.UtcNow,
            TaskCounter = 1
        };
        db.Projects.Add(project);

        if (member is not null)
        {
            db.ProjectMembers.Add(new ProjectMember
            {
                Id = Guid.NewGuid(),
                ProjectId = project.Id,
                UserId = member.Id,
                Color = "#4f46e5"
            });
        }

        await db.SaveChangesAsync();
        return project;
    }

    /// <summary>Unique-per-call suffix (not per-test-run) — an 8-hex-char Guid segment, not a
    /// timestamp, so parallel test execution within the same run can never collide either. Short by
    /// design to stay comfortably under any column's length limit while still being effectively
    /// unique for a single test run's volume of calls.</summary>
    public static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..(prefix.Length + 9)];
}
