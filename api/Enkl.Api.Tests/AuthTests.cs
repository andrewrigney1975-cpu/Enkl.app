using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Enkl.Api.Data;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding #2 — the review's own priority order for the FIRST slice of
/// coverage is the security-sensitive surface, ahead of broad controller coverage. These go through
/// real HTTP (WebApplicationFactory's HttpClient), not direct service calls — the whole point is
/// verifying the pipeline (middleware order, policy enforcement), not just business logic.
/// </summary>
[Collection("Postgres API collection")]
public class AuthTests
{
    private readonly PostgresApiFixture _fixture;

    public AuthTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Login_WithValidCredentials_ReturnsUsableToken()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user);
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);

        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(login);
        Assert.False(string.IsNullOrEmpty(login!.Token));

        // The token must actually work for a subsequent authenticated call, not just be non-empty.
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.Token);
        var whoAmI = await client.GetAsync("/api/projects");
        Assert.Equal(HttpStatusCode.OK, whoAmI.StatusCode);
    }

    [Fact]
    public async Task Login_WithWrongPassword_ReturnsUnauthorized()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user);
        }

        var client = _fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, "definitely-the-wrong-password"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // Security review finding H2, directly exercised: a token minted before a password change (or
    // any other event that rotates SecurityStamp) must stop working the instant the DB row changes —
    // not just eventually, at natural token expiry.
    [Fact]
    public async Task Request_WithTokenWhoseSecurityStampNoLongerMatchesLiveDb_IsRejected()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        Guid userId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (_, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user);
            userId = seededUser.Id;
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        // Simulate "something else rotated this user's SecurityStamp" (a password change, a SCIM
        // deactivation, an admin-role toggle) without going through the already-issued token at all.
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var dbUser = await db.Users.SingleAsync(u => u.Id == userId);
            dbUser.SecurityStamp = Guid.NewGuid();
            await db.SaveChangesAsync();
        }

        var afterRotation = await client.GetAsync("/api/projects");
        Assert.Equal(HttpStatusCode.Unauthorized, afterRotation.StatusCode);
    }

    [Fact]
    public async Task MustChangePassword_BlocksMutatingRequests_ButNotReads()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user, mustChangePassword: true);
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.True(login!.User.MustChangePassword);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.Token);

        var read = await client.GetAsync("/api/projects");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);

        // Body content doesn't matter — the revocation/MustChangePassword middleware runs before
        // model binding, so this 403s before a request body would ever be validated.
        var write = await client.PostAsync("/api/projects", JsonContent.Create(new { }));
        Assert.Equal(HttpStatusCode.Forbidden, write.StatusCode);
    }

    [Fact]
    public async Task ChangePassword_IsExemptFromItsOwnMustChangePasswordBlock_AndClearsTheFlag()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user, mustChangePassword: true);
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var changeResponse = await client.PostAsJsonAsync("/api/auth/change-password",
            new ChangePasswordRequest(TestDataHelper.DefaultPassword, "BrandNewPassword456!"));
        Assert.Equal(HttpStatusCode.OK, changeResponse.StatusCode);

        var changed = await changeResponse.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.False(changed!.User.MustChangePassword);

        // The fresh token this returns should now be usable for a mutating request too.
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", changed.Token);
        var write = await client.PostAsync("/api/projects", JsonContent.Create(new { }));
        Assert.NotEqual(HttpStatusCode.Forbidden, write.StatusCode);
    }

    [Fact]
    public async Task Telemetry_IsExemptFromMustChangePasswordBlock()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user, mustChangePassword: true);
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.PostAsJsonAsync("/api/telemetry/page-load", new ReportPageLoadRequest(123.4));
        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task OrgAdminPolicy_RejectsNonAdminToken()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.GetAsync("/api/organisations/me");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // isOrgAdmin: false is explicit here since Org Admins now also pass ProjectMemberAuthorizationHandler
    // (they get every Project Admin capability, which is inherently also project-member-level access)
    // — this test needs a genuinely plain, non-org-admin user to isolate what it's actually testing.
    [Fact]
    public async Task ProjectMemberPolicy_RejectsTokenWithoutThatProjectMembership()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
            // Project exists in the SAME org, but the logged-in user is never added as a member of it —
            // the "projects" claim minted at login is empty, so ProjectMemberAuthorizationHandler must
            // reject regardless of same-org membership.
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey, member: null);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.GetAsync($"/api/projects/{projectId}");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ARCHITECTURE-REVIEW.md finding 2.4, directly exercised: a project membership removed AFTER a
    // token was minted must stop granting access immediately — not just at next login/token expiry.
    // ProjectMemberAuthorizationHandler now checks a live "ProjectMembers" row instead of trusting the
    // JWT's baked-in "projects" claim, which still reflects membership as of login time throughout.
    // isOrgAdmin: false, same reasoning as ProjectMemberPolicy_RejectsTokenWithoutThatProjectMembership
    // above — the "afterRemoval" assertion needs a genuinely plain member so removal actually revokes
    // access, rather than an Org Admin bypass silently keeping it granted.
    [Fact]
    public async Task ProjectMemberPolicy_RejectsTokenWhoseMembershipWasRemovedAfterMint()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        Guid userId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
            userId = seededUser.Id;
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey, member: seededUser);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        // The token's "projects" claim now includes this membership — confirm access works first.
        var beforeRemoval = await client.GetAsync($"/api/projects/{projectId}");
        Assert.Equal(HttpStatusCode.OK, beforeRemoval.StatusCode);

        // Remove the membership directly (e.g. an admin removing them from the project) without
        // touching the already-issued token at all — SecurityStamp is untouched, so H2's revocation
        // check alone would NOT catch this; only a live membership check does.
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var membership = await db.ProjectMembers.SingleAsync(m => m.ProjectId == projectId && m.UserId == userId);
            db.ProjectMembers.Remove(membership);
            await db.SaveChangesAsync();
        }

        var afterRemoval = await client.GetAsync($"/api/projects/{projectId}");
        Assert.Equal(HttpStatusCode.Forbidden, afterRemoval.StatusCode);
    }

    // Project Administrator role: a plain (non-admin) project member can view the project but must
    // not be able to add a column — one of the four Project Admin capabilities. isOrgAdmin: false is
    // explicit here (not just relying on some other default) since Org Admins now also pass the
    // ProjectAdmin policy — this test needs a genuinely plain, non-org-admin member to isolate what
    // it's actually testing.
    [Fact]
    public async Task ProjectAdminPolicy_RejectsPlainMemberFromCreatingColumn()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey, member: seededUser, memberIsProjectAdmin: false);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        // Confirm plain membership works for a read first, isolating the assertion below to the
        // ProjectAdmin policy specifically rather than a broader auth failure.
        var read = await client.GetAsync($"/api/projects/{projectId}");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);

        var response = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("New Column", false, null));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task ProjectAdminPolicy_AllowsProjectAdminToCreateColumn()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey, member: seededUser, memberIsProjectAdmin: true);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("New Column", false, null));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // Promotion/demotion takes effect on the very next request, not at next login — same live-check
    // guarantee as ProjectMemberPolicy_RejectsTokenWhoseMembershipWasRemovedAfterMint above, applied
    // to the Project Admin flag specifically. isOrgAdmin: false, same reasoning as
    // ProjectAdminPolicy_RejectsPlainMemberFromCreatingColumn above — must be a genuinely plain member
    // pre-promotion for the "before" assertion to mean anything now that Org Admins also pass.
    [Fact]
    public async Task ProjectAdminPolicy_PromotionTakesEffectWithoutReLogin()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        Guid userId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
            userId = seededUser.Id;
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey, member: seededUser, memberIsProjectAdmin: false);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var beforePromotion = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("Too Early", false, null));
        Assert.Equal(HttpStatusCode.Forbidden, beforePromotion.StatusCode);

        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var membership = await db.ProjectMembers.SingleAsync(m => m.ProjectId == projectId && m.UserId == userId);
            membership.IsProjectAdmin = true;
            await db.SaveChangesAsync();
        }

        var afterPromotion = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("Now Allowed", false, null));
        Assert.Equal(HttpStatusCode.OK, afterPromotion.StatusCode);
    }

    // An Org Admin gets every Project Admin capability across their own org's projects, even with no
    // ProjectMembers row for that project at all.
    [Fact]
    public async Task ProjectAdminPolicy_AllowsOrgAdminEvenWithoutProjectMembership()
    {
        var org = TestDataHelper.Unique("org");
        var user = TestDataHelper.Unique("user");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, seededUser) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: true);
            // No `member:` argument — the Org Admin is deliberately not a ProjectMembers row at all.
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(user, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("Org Admin Column", false, null));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // Cross-org isolation (CLAUDE.md §4): an Org Admin's bypass is scoped to their OWN org's projects
    // only — the "orgId" claim is re-verified against the project's live OrganisationId, not just
    // trusted, so an Org Admin from a different org can't reach this project this way either.
    [Fact]
    public async Task ProjectAdminPolicy_RejectsOrgAdminFromADifferentOrganisation()
    {
        var org = TestDataHelper.Unique("org");
        var otherOrg = TestDataHelper.Unique("otherorg");
        var user = TestDataHelper.Unique("user");
        var otherOrgAdmin = TestDataHelper.Unique("otheradmin");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, user, isOrgAdmin: false);
            await TestDataHelper.SeedOrgAndUserAsync(db, otherOrg, otherOrgAdmin, isOrgAdmin: true);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);
            projectId = project.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(otherOrgAdmin, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var response = await client.PostAsJsonAsync($"/api/projects/{projectId}/columns", new CreateColumnRequest("Should Not Exist", false, null));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}
