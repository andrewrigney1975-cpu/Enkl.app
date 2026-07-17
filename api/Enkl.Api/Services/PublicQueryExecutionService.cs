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
/// exact-cased views (see FixSavedQueryApiViews migration) named/columned to match TABLE_SCHEMAS in
/// query-engine.js exactly, each hard-filtered to one project via a `SET LOCAL
/// app.query_project_id` session variable. That grant boundary is the actual guarantee that a saved
/// query can't read another project's or another org's data — it holds even though the SQL text
/// itself is run (after the bracket translation below) verbatim. The FORBIDDEN_PATTERN regex check
/// below (ported from query-engine.js) is deliberately redundant with that — defense-in-depth
/// matching the existing convention, not the primary control.
///
/// Real bug found live (2026-07-18, first production use of this feature): every query the SQL
/// formatter/intellisense produces bracket-quotes every identifier (`[tasks].[title]`), matching
/// AlaSQL's own grammar — but Postgres has no bracket-quoting syntax at all (`[` is only meaningful
/// as an array subscript), so EVERY saved query beyond a bare `SELECT 1` failed with a syntax error
/// the moment a real user tried this against the live API. TranslateBracketIdentifiers fixes this by
/// rewriting `[x]` to `"x"` before execution (respecting string literals so a literal `[` inside a
/// quoted string is left alone). This also surfaced a second, related bug in the original view
/// design: the views were named `query_tasks` etc. with `SELECT *` preserving the REAL Postgres
/// PascalCase column names, but a saved query written against the AlaSQL grammar references the
/// lowercase table names and camelCase field names TABLE_SCHEMAS defines (`columnId`, not
/// `ColumnId`) — fixed by renaming/re-aliasing the views to match exactly, see that migration's own
/// comment for the full column-by-column mapping including junction-table-backed array fields.
/// </summary>
public class PublicQueryExecutionService
{
    private static readonly Regex ForbiddenPattern = new(
        @"\b(CREATE|DELETE|DROP|INSERT|UPDATE|ALTER|TRUNCATE|ATTACH|DETACH|GRANT|REVOKE)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Rewrites AlaSQL-style `[identifier]` bracket-quoting to Postgres' `"identifier"`
    /// double-quoting — a simple character-level pass, not a real SQL tokenizer, so it toggles
    /// string-literal tracking on every unescaped `'` (a doubled `''` toggles twice, correctly
    /// leaving the parser "still inside" the same string, since no bracket character can meaningfully
    /// appear between the two quote characters of that escape sequence anyway).
    ///
    /// Real bug found live (2026-07-18, second report): a saved query need not bracket-quote every
    /// identifier at all — AlaSQL resolves a bare `t.columnId` just fine, matching the JS object
    /// property exactly as typed. Postgres, in contrast, folds an UNQUOTED identifier to lowercase
    /// before matching it against a real (quoted, case-preserved) column — so a view column named
    /// `"columnId"` is invisible to a bare `t.columnId` reference (Postgres looks for `columnid`).
    /// The only way for BOTH a bare `columnId` (auto-folded to lowercase by Postgres) and a
    /// bracket-quoted `[columnId]` (translated to a double-quoted, case-preserving reference) to
    /// resolve to the SAME view column is if that column is named fully lowercase to begin with —
    /// see the FixSavedQueryApiViewCasing migration. This method's job is the other half: it must
    /// also LOWERCASE whatever's inside the brackets, not just quote it, so `[columnId]` becomes
    /// `"columnid"` (matching the now-all-lowercase view schema) rather than `"columnId"` (which
    /// would just as surely fail to match an all-lowercase column, in the opposite direction).</summary>
    internal static string TranslateBracketIdentifiers(string sql)
    {
        var result = new System.Text.StringBuilder(sql.Length);
        var inString = false;
        System.Text.StringBuilder? bracketBuffer = null;
        foreach (var c in sql)
        {
            if (bracketBuffer is not null)
            {
                if (c == ']')
                {
                    result.Append('"').Append(bracketBuffer.ToString().ToLowerInvariant()).Append('"');
                    bracketBuffer = null;
                }
                else
                {
                    bracketBuffer.Append(c);
                }
            }
            else if (c == '\'')
            {
                inString = !inString;
                result.Append(c);
            }
            else if (!inString && c == '[')
            {
                bracketBuffer = new System.Text.StringBuilder();
            }
            else
            {
                result.Append(c);
            }
        }
        return result.ToString();
    }

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
        var translatedSql = TranslateBracketIdentifiers(sql);

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
            queryCmd.CommandText = translatedSql;
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
