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

    /// <summary>Adds a second (third, ...) user to an ALREADY-seeded Organisation — SeedOrgAndUserAsync
    /// always creates a brand-new org, so this is the one to reach for when a test needs two colleagues
    /// in the SAME org (e.g. chat channel members).</summary>
    public static async Task<User> SeedUserInOrgAsync(AppDbContext db, Guid organisationId, string username, bool isOrgAdmin = false)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Username = username,
            NormalizedUsername = UsernameNormalizer.Normalize(username),
            PasswordHash = PasswordHasher.Hash(DefaultPassword),
            DisplayName = username,
            IsOrgAdmin = isOrgAdmin,
            IsActive = true,
            CreatedAt = DateTime.UtcNow
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    public static async Task<Project> SeedProjectAsync(AppDbContext db, Guid organisationId, string key, User? member = null, bool memberIsProjectAdmin = false)
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
                Color = "#4f46e5",
                IsProjectAdmin = memberIsProjectAdmin
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

    private static int _ipCounter;

    /// <summary>
    /// The "auth" rate-limit policy (Program.cs) partitions by client IP, sliding 10/min window,
    /// shared across every test in this collection since they all hit the same WebApplicationFactory.
    /// A test that logs in more than once, or a run with enough login-heavy tests, can trip it —
    /// spoof a fresh X-Forwarded-For per test instead (ForwardedHeadersOptions.KnownProxies/
    /// KnownIPNetworks are both cleared in Program.cs specifically so this is trusted unconditionally,
    /// same reasoning as the PHP tier's own equivalent finding) so unrelated tests never share a
    /// rate-limit bucket. Set via `client.DefaultRequestHeaders.Add("X-Forwarded-For", ...)` before
    /// the first request on a given HttpClient.
    /// </summary>
    public static string UniqueIp()
    {
        var n = Interlocked.Increment(ref _ipCounter);
        return $"10.{(n >> 16) & 0xff}.{(n >> 8) & 0xff}.{n & 0xff}";
    }
}
