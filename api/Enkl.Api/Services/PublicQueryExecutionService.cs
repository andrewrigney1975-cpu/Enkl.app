using System.Text.RegularExpressions;
using Enkl.Api.Validation;
using Npgsql;

namespace Enkl.Api.Services;

/// <summary>Row-array shape mirrors query-engine.js's own JSON export convention (§16) — a plain
/// array of row objects, not a {columns,rows} wrapper.</summary>
public record PublicQueryResult(List<Dictionary<string, object?>> Rows, bool Truncated);

/// <summary>
/// Executes a SavedQuery's SQL text against real Postgres for the first time anywhere in this
/// codebase (every other execution of this SQL grammar happens client-side, in the browser, via
/// AlaSQL over an in-memory JS object — see query-engine.js). Used only by PublicQueryController.
///
/// Safety model: the connection this opens authenticates as the dedicated, SELECT-only
/// enkl_public_query Postgres role (created by the AddSavedQueryApiExposure migration) — never the
/// app's own high-privilege "Default" connection. That role can see nothing except the ten
/// query_* views, each hard-filtered to one project via a `SET LOCAL app.query_project_id`
/// session variable. That grant boundary is the actual guarantee that a saved query can't read
/// another project's or another org's data — it holds even though the SQL text itself is run
/// completely verbatim. The FORBIDDEN_PATTERN regex check below (ported from query-engine.js) is
/// deliberately redundant with that — defense-in-depth matching the existing convention, not the
/// primary control.
/// </summary>
public class PublicQueryExecutionService
{
    private static readonly Regex ForbiddenPattern = new(
        @"\b(CREATE|DELETE|DROP|INSERT|UPDATE|ALTER|TRUNCATE|ATTACH|DETACH|GRANT|REVOKE)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // A caller with a valid API key and an exposed query could otherwise force an unbounded
    // response by simply not writing a LIMIT — this caps worst-case payload size regardless of what
    // the saved SQL itself asks for.
    private const int MaxRows = 1000;

    private readonly string _connectionString;

    public PublicQueryExecutionService(IConfiguration configuration)
    {
        _connectionString = configuration.GetConnectionString("PublicQuery")
            ?? throw new InvalidOperationException("ConnectionStrings:PublicQuery is not configured.");
    }

    public async Task<PublicQueryResult> ExecuteAsync(Guid projectId, string sql, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            throw new ApiValidationException("Saved query has no SQL to execute.");
        }
        if (ForbiddenPattern.IsMatch(sql))
        {
            throw new ApiValidationException(
                "This query contains a disallowed write/schema operation and cannot be executed.");
        }

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        // Bounds worst-case cost (e.g. an accidental/adversarial Cartesian join) — this connection
        // is shared infrastructure across every org's exposed queries, not a per-caller resource.
        await using (var timeoutCmd = connection.CreateCommand())
        {
            timeoutCmd.Transaction = transaction;
            timeoutCmd.CommandText = "SET LOCAL statement_timeout = '5s'";
            await timeoutCmd.ExecuteNonQueryAsync(ct);
        }

        // set_config(..., is_local = true) scopes the setting to this transaction only — the next
        // request's connection (or even a later query on a pooled one) never sees a stale project id.
        await using (var scopeCmd = connection.CreateCommand())
        {
            scopeCmd.Transaction = transaction;
            scopeCmd.CommandText = "SELECT set_config('app.query_project_id', $1, true)";
            scopeCmd.Parameters.AddWithValue(projectId.ToString());
            await scopeCmd.ExecuteScalarAsync(ct);
        }

        var rows = new List<Dictionary<string, object?>>();
        var truncated = false;
        try
        {
            await using var queryCmd = connection.CreateCommand();
            queryCmd.Transaction = transaction;
            queryCmd.CommandText = sql;
            await using var reader = await queryCmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count >= MaxRows)
                {
                    truncated = true;
                    break;
                }
                var row = new Dictionary<string, object?>();
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    row[reader.GetName(i)] = await reader.IsDBNullAsync(i, ct) ? null : reader.GetValue(i);
                }
                rows.Add(row);
            }
        }
        catch (PostgresException ex)
        {
            throw new ApiValidationException("Query failed: " + ex.MessageText);
        }
        finally
        {
            // Read-only by construction (enkl_public_query has no write grants at all) — rollback
            // rather than commit purely to release the transaction cleanly, nothing to persist.
            await transaction.RollbackAsync(ct);
        }

        return new PublicQueryResult(rows, truncated);
    }
}
