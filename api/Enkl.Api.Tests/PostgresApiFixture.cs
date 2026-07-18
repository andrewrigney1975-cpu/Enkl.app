using Enkl.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;

namespace Enkl.Api.Tests;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding #2: real Postgres via Testcontainers, not SQLite in-memory — the
/// schema uses jsonb columns (Project.HeaderButtonVisibilityJson/WorkflowJson) and the provider is
/// hardcoded to Npgsql in Program.cs, so a lighter substitute would silently test different behavior
/// than production. One container, one WebApplicationFactory, shared across the WHOLE test run (see
/// PostgresApiCollection below) — spinning up a fresh container per test class would make the suite
/// slow for no correctness benefit. Isolation between tests is via unique-per-test names (Guid-suffixed
/// org/user/project names in each test), not per-test transactions or per-class databases — the same
/// discipline already established in contract-tests/scenarios.js this session, and simpler to get
/// right against a WebApplicationFactory host that manages its own DbContext scoping internally.
/// </summary>
public class PostgresApiFixture : IAsyncLifetime
{
    private PostgreSqlContainer _container = null!;
    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .WithDatabase("enkl_test")
            .WithUsername("enkl_test")
            .WithPassword("enkl_test_password")
            .Build();
        await _container.StartAsync();

        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            // Development is the one environment Program.cs's non-Dev-only startup guards (checked-in
            // placeholder JWT signing key / DB password rejection) skip — same "zero-setup local run"
            // exemption both backend tiers already document, not fought here with fake-but-real-
            // looking values.
            builder.UseEnvironment("Development");
            builder.ConfigureAppConfiguration((_, config) =>
            {
                // Added AFTER Program.cs's own appsettings.json/env-var sources load, so this
                // overrides ConnectionStrings:Default to point at the Testcontainers instance rather
                // than the checked-in dev connection string — the standard WebApplicationFactory
                // config-override pattern.
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ConnectionStrings:Default"] = _container.GetConnectionString(),
                    // The AddSavedQueryApiExposure migration creates the enkl_public_query role
                    // directly inside THIS Testcontainers instance (same raw-SQL path production
                    // uses), so PublicQueryExecutionService just needs a connection string pointing
                    // at the same host/port/database under that role's credentials — same dev
                    // placeholder password the migration itself uses, safe here since Development
                    // skips Program.cs's non-Dev placeholder-password guard entirely.
                    ["ConnectionStrings:PublicQuery"] =
                        $"Host={_container.Hostname};Port={_container.GetMappedPublicPort(5432)};" +
                        "Database=enkl_test;Username=enkl_public_query;Password=enkl_public_query_dev_password",
                    // Program.cs's own MigrateDatabaseWithRetryAsync applies EF Core migrations on
                    // startup when this is true — reused as-is rather than re-implementing migration
                    // application here, so the test database's schema is produced by exactly the same
                    // code path production uses.
                    ["RunMigrationsOnStartup"] = "true"
                });
            });
        });

        // Forces the host to actually start (and therefore run migrations) before any test runs.
        using var warmupClient = Factory.CreateClient();
        await warmupClient.GetAsync("/health");
    }

    public async Task DisposeAsync()
    {
        await Factory.DisposeAsync();
        await _container.DisposeAsync();
    }

    /// <summary>
    /// A fresh DI scope + AppDbContext for direct test setup/assertions (seeding an org/user before
    /// exercising an endpoint, or reading back what a service call persisted). Caller owns disposal —
    /// wrap in `using`.
    /// </summary>
    public IServiceScope CreateScope() => Factory.Services.CreateScope();
}

[CollectionDefinition("Postgres API collection")]
public class PostgresApiCollection : ICollectionFixture<PostgresApiFixture>
{
    // No code needed — this class only exists to attach ICollectionFixture<PostgresApiFixture> to the
    // "Postgres API collection" name via the [CollectionDefinition] attribute, per xUnit's convention.
}
