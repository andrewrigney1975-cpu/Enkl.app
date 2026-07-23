using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// Real-HTTP coverage for PublicQueryController/ApiKeyAuthFilter (the "Expose Saved Queries via
/// Public API" feature, see CLAUDE.md §20) — same real-pipeline-not-just-service-logic reasoning as
/// AuthTests, since the whole point here is verifying ApiKeyAuthFilter's no-enumeration-oracle
/// behavior and the rate-limit/auth ordering, not just PublicQueryExecutionService's own SQL logic.
/// </summary>
[Collection("Postgres API collection")]
public class PublicQueryTests
{
    private readonly PostgresApiFixture _fixture;

    public PublicQueryTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    private async Task<(Guid ProjectId, Guid SavedQueryId, string ApiKey)> SeedExposedQueryWithApiKeyAsync(
        bool exposeViaApi = true, string sql = "SELECT 1 AS one")
    {
        var org = TestDataHelper.Unique("org");
        var admin = TestDataHelper.Unique("admin");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid projectId;
        Guid savedQueryId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, admin, isOrgAdmin: true);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);
            projectId = project.Id;

            var query = new SavedQuery
            {
                Id = Guid.NewGuid(),
                ProjectId = projectId,
                Name = "Test query",
                Sql = sql,
                DateCreated = DateTime.UtcNow,
                ExposeViaApi = exposeViaApi
            };
            db.SavedQueries.Add(query);
            await db.SaveChangesAsync();
            savedQueryId = query.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(admin, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var keyResponse = await client.PostAsync("/api/organisations/me/api-key", null);
        var key = await keyResponse.Content.ReadFromJsonAsync<GenerateApiKeyResponse>();

        return (projectId, savedQueryId, key!.Key);
    }

    [Fact]
    public async Task GetResults_WithValidKeyAndExposedQuery_ReturnsRows()
    {
        var (_, savedQueryId, apiKey) = await SeedExposedQueryWithApiKeyAsync();

        var anonymousClient = _fixture.Factory.CreateClient();
        anonymousClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        var response = await anonymousClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("rows").GetArrayLength());
        Assert.False(body.GetProperty("truncated").GetBoolean());
    }

    [Fact]
    public async Task GetResults_WithMissingOrWrongKey_ReturnsNotFound()
    {
        var (_, savedQueryId, _) = await SeedExposedQueryWithApiKeyAsync();

        var noKeyClient = _fixture.Factory.CreateClient();
        var noKeyResponse = await noKeyClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");
        Assert.Equal(HttpStatusCode.NotFound, noKeyResponse.StatusCode);

        var wrongKeyClient = _fixture.Factory.CreateClient();
        wrongKeyClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "enklr_key_definitely-wrong");
        var wrongKeyResponse = await wrongKeyClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");
        Assert.Equal(HttpStatusCode.NotFound, wrongKeyResponse.StatusCode);
    }

    // Cross-org isolation (CLAUDE.md §4): a valid, enabled API key from a DIFFERENT organisation must
    // not unlock a query belonging to some other org's project — same no-enumeration-oracle 404 as
    // every other failure mode here.
    [Fact]
    public async Task GetResults_WithApiKeyFromDifferentOrganisation_ReturnsNotFound()
    {
        var (_, savedQueryId, _) = await SeedExposedQueryWithApiKeyAsync();
        var (_, _, otherOrgApiKey) = await SeedExposedQueryWithApiKeyAsync();

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", otherOrgApiKey);
        var response = await client.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetResults_WhenExposeViaApiIsFalse_ReturnsNotFoundEvenWithAValidKey()
    {
        var (_, savedQueryId, apiKey) = await SeedExposedQueryWithApiKeyAsync(exposeViaApi: false);

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        var response = await client.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // Belt-and-suspenders check (PublicQueryExecutionService's FORBIDDEN_PATTERN) — the real
    // guarantee is the enkl_public_query role's SELECT-only grant, but this should still reject
    // cleanly with a 400, not a raw Postgres permission-denied 500.
    [Fact]
    public async Task GetResults_WithWriteStatementInSavedSql_RejectsWithBadRequest()
    {
        var (_, savedQueryId, apiKey) = await SeedExposedQueryWithApiKeyAsync(sql: "DELETE FROM [tasks]");

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        var response = await client.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Real bug found live (2026-07-18): a saved query authored via the Advanced Query UI is always
    // bracket-quoted (SQL formatter/intellisense, CLAUDE.md §17/§18) and uses AlaSQL's lowercase
    // table names / camelCase field names — Postgres understands neither verbatim. This exercises
    // the exact shape of query a real user would have saved, against real seeded task data, proving
    // both TranslateBracketIdentifiers AND the view's camelCase column aliases are correct together.
    [Fact]
    public async Task GetResults_WithBracketQuotedQueryAgainstRealTaskData_ReturnsCorrectlyMappedRows()
    {
        var org = TestDataHelper.Unique("org");
        var admin = TestDataHelper.Unique("admin");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid savedQueryId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, admin, isOrgAdmin: true);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);

            var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = "To Do", Done = false, Order = 0 };
            db.Columns.Add(column);
            db.Tasks.Add(new TaskItem
            {
                Id = Guid.NewGuid(), ProjectId = project.Id, Key = projectKey + "-1", Title = "Fix login bug",
                Priority = "high", ColumnId = column.Id, DateCreated = DateTime.UtcNow, DateLastModified = DateTime.UtcNow
            });

            var query = new SavedQuery
            {
                Id = Guid.NewGuid(), ProjectId = project.Id, Name = "Bracket-quoted test",
                Sql = "SELECT [title], [priority] FROM [tasks] WHERE [priority] = 'high'",
                DateCreated = DateTime.UtcNow, ExposeViaApi = true
            };
            db.SavedQueries.Add(query);
            await db.SaveChangesAsync();
            savedQueryId = query.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(admin, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);
        var keyResponse = await client.PostAsync("/api/organisations/me/api-key", null);
        var key = await keyResponse.Content.ReadFromJsonAsync<GenerateApiKeyResponse>();

        var publicClient = _fixture.Factory.CreateClient();
        publicClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key!.Key);
        var response = await publicClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = body.GetProperty("rows");
        Assert.Equal(1, rows.GetArrayLength());
        Assert.Equal("Fix login bug", rows[0].GetProperty("title").GetString());
        Assert.Equal("high", rows[0].GetProperty("priority").GetString());
    }

    // Real bug found live (2026-07-18, second report): a saved query need not bracket-quote EVERY
    // identifier — AlaSQL resolves a bare `t.columnId` just fine. This mirrors the exact reported
    // repro: a mix of unquoted (t.id, t.columnId, tasks, c.done) and bracket-quoted ([column] as an
    // alias, [columns] as a table name) identifiers in the same query, proving both the
    // all-lowercase view schema AND the bracket translator's now-lowercasing behavior are correct
    // together — a bare, Postgres-auto-folded reference and a bracketed, explicitly-lowercased one
    // must resolve to the identical column.
    [Fact]
    public async Task GetResults_WithMixedBracketedAndUnquotedIdentifiers_ReturnsCorrectlyMappedRows()
    {
        var org = TestDataHelper.Unique("org");
        var admin = TestDataHelper.Unique("admin");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid savedQueryId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, admin, isOrgAdmin: true);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);

            var column = new Column { Id = Guid.NewGuid(), ProjectId = project.Id, Name = "Done", Done = true, Order = 0 };
            db.Columns.Add(column);
            db.Tasks.Add(new TaskItem
            {
                Id = Guid.NewGuid(), ProjectId = project.Id, Key = projectKey + "-1", Title = "Ship the release",
                Priority = "medium", ColumnId = column.Id, DateCreated = DateTime.UtcNow, DateLastModified = DateTime.UtcNow
            });

            var query = new SavedQuery
            {
                Id = Guid.NewGuid(), ProjectId = project.Id, Name = "Mixed quoting test",
                Sql = "SELECT t.id, t.key, t.title, t.priority, c.name AS [column], t.dateLastModified " +
                      "FROM tasks t JOIN [columns] c ON t.columnId = c.id WHERE c.done = true ORDER BY t.dateLastModified DESC",
                DateCreated = DateTime.UtcNow, ExposeViaApi = true
            };
            db.SavedQueries.Add(query);
            await db.SaveChangesAsync();
            savedQueryId = query.Id;
        }

        var client = _fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(admin, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);
        var keyResponse = await client.PostAsync("/api/organisations/me/api-key", null);
        var key = await keyResponse.Content.ReadFromJsonAsync<GenerateApiKeyResponse>();

        var publicClient = _fixture.Factory.CreateClient();
        publicClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key!.Key);
        var response = await publicClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = body.GetProperty("rows");
        Assert.Equal(1, rows.GetArrayLength());
        Assert.Equal("Ship the release", rows[0].GetProperty("title").GetString());
        Assert.Equal("medium", rows[0].GetProperty("priority").GetString());
        Assert.Equal("Done", rows[0].GetProperty("column").GetString());
    }

    // Revoking the key must take effect immediately — no separate "logout" step for an API key.
    [Fact]
    public async Task GetResults_AfterKeyIsRevoked_ReturnsNotFound()
    {
        var org = TestDataHelper.Unique("org");
        var admin = TestDataHelper.Unique("admin");
        var projectKey = TestDataHelper.Unique("PRJ");
        Guid savedQueryId;
        using (var scope = _fixture.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var (seededOrg, _) = await TestDataHelper.SeedOrgAndUserAsync(db, org, admin, isOrgAdmin: true);
            var project = await TestDataHelper.SeedProjectAsync(db, seededOrg.Id, projectKey);
            var query = new SavedQuery
            {
                Id = Guid.NewGuid(), ProjectId = project.Id, Name = "Q", Sql = "SELECT 1 AS one",
                DateCreated = DateTime.UtcNow, ExposeViaApi = true
            };
            db.SavedQueries.Add(query);
            await db.SaveChangesAsync();
            savedQueryId = query.Id;
        }

        var adminClient = _fixture.Factory.CreateClient();
        adminClient.DefaultRequestHeaders.Add("X-Forwarded-For", TestDataHelper.UniqueIp());
        var loginResponse = await adminClient.PostAsJsonAsync("/api/auth/login", new LoginRequest(admin, TestDataHelper.DefaultPassword));
        var login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        adminClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login!.Token);

        var keyResponse = await adminClient.PostAsync("/api/organisations/me/api-key", null);
        var key = await keyResponse.Content.ReadFromJsonAsync<GenerateApiKeyResponse>();

        var publicClient = _fixture.Factory.CreateClient();
        publicClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key!.Key);
        var beforeRevoke = await publicClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");
        Assert.Equal(HttpStatusCode.OK, beforeRevoke.StatusCode);

        var revokeResponse = await adminClient.DeleteAsync("/api/organisations/me/api-key");
        Assert.Equal(HttpStatusCode.OK, revokeResponse.StatusCode);

        var afterRevoke = await publicClient.GetAsync($"/api/public/v1/queries/{savedQueryId}/results");
        Assert.Equal(HttpStatusCode.NotFound, afterRevoke.StatusCode);
    }
}
