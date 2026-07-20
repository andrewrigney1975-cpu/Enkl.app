using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// Coverage for OrganisationService.SetDefaultNewUserPasswordAsync/ResolveDefaultNewUserPasswordHashAsync
/// and their actual consumers (MemberService.CreateAsync's implicit "add a member by name" path) —
/// the org-configurable replacement for the previously hardcoded PasswordHasher.GlobalDefaultNewUserPassword.
/// Direct service-call style, same as MemberServiceTests.cs.
/// </summary>
[Collection("Postgres API collection")]
public class OrganisationServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public OrganisationServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task ResolveDefaultNewUserPasswordHashAsync_FallsBackToGlobalDefaultWhenUnset()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));

        var hash = await organisations.ResolveDefaultNewUserPasswordHashAsync(org.Id);

        Assert.True(PasswordHasher.Verify(PasswordHasher.GlobalDefaultNewUserPassword, hash));
    }

    [Fact]
    public async Task SetDefaultNewUserPasswordAsync_ChangesWhatResolveReturns_AndMarksHasCustomDefaultPassword()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));

        var ok = await organisations.SetDefaultNewUserPasswordAsync(org.Id, "OrgChosenPassword1!");
        Assert.True(ok);

        var hash = await organisations.ResolveDefaultNewUserPasswordHashAsync(org.Id);
        Assert.True(PasswordHasher.Verify("OrgChosenPassword1!", hash));
        Assert.False(PasswordHasher.Verify(PasswordHasher.GlobalDefaultNewUserPassword, hash));

        var detail = await organisations.GetOrganisationAsync(org.Id);
        Assert.NotNull(detail);
        Assert.True(detail!.HasCustomDefaultPassword);
    }

    [Fact]
    public async Task SetDefaultNewUserPasswordAsync_RejectsShortPassword()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, _) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));

        await Assert.ThrowsAsync<ApiValidationException>(() => organisations.SetDefaultNewUserPasswordAsync(org.Id, "short"));
    }

    [Fact]
    public async Task MemberService_CreateAsync_UsesOrgConfiguredDefaultPassword_ForImplicitlyCreatedUser()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();
        var members = scope.ServiceProvider.GetRequiredService<MemberService>();
        var projects = scope.ServiceProvider.GetRequiredService<ProjectService>();

        var (org, owner) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("owner"));
        await organisations.SetDefaultNewUserPasswordAsync(org.Id, "OrgChosenPassword2!");

        var project = await projects.CreateAsync(owner.Id, new CreateProjectRequest(TestDataHelper.Unique("New Project"), TestDataHelper.Unique("PRJ"), null, null));
        Assert.NotNull(project);

        var newMemberName = TestDataHelper.Unique("Brand New Person");
        var created = await members.CreateAsync(project!.Project!.Id, new CreateMemberRequest(newMemberName, TestDataHelper.Unique("newperson") + "@example.com"));
        Assert.NotNull(created);

        var newUser = await db.Users.FirstAsync(u => u.Id == created!.UserId);
        Assert.True(PasswordHasher.Verify("OrgChosenPassword2!", newUser.PasswordHash!));
        Assert.True(newUser.MustChangePassword);
    }

    [Fact]
    public async Task DeactivateUserAsync_FlipsIsActiveFalse_AndRotatesSecurityStamp()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));
        var target = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("target"));
        var stampBefore = target.SecurityStamp;

        var ok = await organisations.DeactivateUserAsync(org.Id, admin.Id, target.Id);
        Assert.True(ok);

        var reloaded = await db.Users.AsNoTracking().FirstAsync(u => u.Id == target.Id);
        Assert.False(reloaded.IsActive);
        Assert.NotEqual(stampBefore, reloaded.SecurityStamp);
    }

    [Fact]
    public async Task DeactivateUserAsync_IsIdempotent_DoesNotRotateStampAgainWhenAlreadyInactive()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));
        var target = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("target"));

        Assert.True(await organisations.DeactivateUserAsync(org.Id, admin.Id, target.Id));
        var stampAfterFirst = (await db.Users.AsNoTracking().FirstAsync(u => u.Id == target.Id)).SecurityStamp;

        var okAgain = await organisations.DeactivateUserAsync(org.Id, admin.Id, target.Id);
        Assert.True(okAgain);

        var stampAfterSecond = (await db.Users.AsNoTracking().FirstAsync(u => u.Id == target.Id)).SecurityStamp;
        Assert.Equal(stampAfterFirst, stampAfterSecond);
    }

    [Fact]
    public async Task DeactivateUserAsync_RejectsSelfDeactivation()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));

        await Assert.ThrowsAsync<ApiValidationException>(() => organisations.DeactivateUserAsync(org.Id, admin.Id, admin.Id));

        var reloaded = await db.Users.AsNoTracking().FirstAsync(u => u.Id == admin.Id);
        Assert.True(reloaded.IsActive);
    }

    [Fact]
    public async Task DeactivateUserAsync_ReturnsFalse_ForUserInAnotherOrg()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var organisations = scope.ServiceProvider.GetRequiredService<OrganisationService>();

        var (org, admin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("admin"));
        var (_, otherOrgUser) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("otherOrg"), TestDataHelper.Unique("otherUser"));

        var ok = await organisations.DeactivateUserAsync(org.Id, admin.Id, otherOrgUser.Id);
        Assert.False(ok);

        var reloaded = await db.Users.AsNoTracking().FirstAsync(u => u.Id == otherOrgUser.Id);
        Assert.True(reloaded.IsActive);
    }
}
