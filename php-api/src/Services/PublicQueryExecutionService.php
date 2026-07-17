<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Db\Database;
use Enkl\Api\Validation\ApiValidationException;
use PDOException;

/**
 * Ported from Services/PublicQueryExecutionService.cs. Executes a SavedQuery's SQL text against
 * real Postgres for the first time anywhere in this codebase (every other execution of this SQL
 * grammar happens client-side, in the browser, via AlaSQL — see query-engine.js). Used only by
 * PublicQueryController.
 *
 * Safety model: Database::publicQueryConnection() authenticates as the dedicated, SELECT-only
 * enkl_public_query Postgres role (created by 023_add_saved_query_api_exposure.sql) — never the
 * app's own high-privilege connection. That role can see nothing except the ten exact-cased views
 * (see 024_fix_saved_query_api_views.sql) named/columned to match TABLE_SCHEMAS in query-engine.js
 * exactly, each hard-filtered to one project via a `SET LOCAL app.query_project_id` session
 * variable — that grant boundary is the actual guarantee, not the FORBIDDEN_PATTERN check below
 * (ported from query-engine.js, deliberately redundant defense-in-depth matching the existing
 * convention).
 *
 * Real bug found live (2026-07-18, first production use of this feature): every query the SQL
 * formatter/intellisense produces bracket-quotes every identifier (`[tasks].[title]`), matching
 * AlaSQL's own grammar — but Postgres has no bracket-quoting syntax at all, so EVERY saved query
 * beyond a bare `SELECT 1` failed with a syntax error. translateBracketIdentifiers() fixes this by
 * rewriting `[x]` to `"x"` before execution. This also surfaced a second, related bug: the views
 * were originally named `query_tasks` etc. with `SELECT *` preserving the REAL Postgres PascalCase
 * column names, but a saved query references the lowercase table names/camelCase field names
 * TABLE_SCHEMAS defines — fixed by renaming/re-aliasing the views to match exactly, see that
 * migration's own comment for the full mapping including junction-table-backed array fields.
 */
final class PublicQueryExecutionService
{
    private const FORBIDDEN_PATTERN = '/\b(CREATE|DELETE|DROP|INSERT|UPDATE|ALTER|TRUNCATE|ATTACH|DETACH|GRANT|REVOKE)\b/i';

    // A caller with a valid API key and an exposed query could otherwise force an unbounded
    // response by simply not writing a LIMIT — this caps worst-case payload size regardless of what
    // the saved SQL itself asks for.
    private const MAX_ROWS = 1000;

    /** Rewrites AlaSQL-style `[identifier]` bracket-quoting to Postgres' `"identifier"`
     * double-quoting — a simple character-level pass, not a real SQL tokenizer, so it toggles
     * string-literal tracking on every unescaped `'` (a doubled `''` toggles twice, correctly
     * leaving the parser "still inside" the same string). */
    private static function translateBracketIdentifiers(string $sql): string
    {
        $result = '';
        $inString = false;
        for ($i = 0, $len = strlen($sql); $i < $len; $i++) {
            $c = $sql[$i];
            if ($c === "'") {
                $inString = !$inString;
                $result .= $c;
            } elseif (!$inString && ($c === '[' || $c === ']')) {
                $result .= '"';
            } else {
                $result .= $c;
            }
        }
        return $result;
    }

    public function execute(string $projectId, string $sql): array
    {
        if (trim($sql) === '') {
            throw new ApiValidationException('Saved query has no SQL to execute.');
        }
        if (preg_match(self::FORBIDDEN_PATTERN, $sql) === 1) {
            throw new ApiValidationException(
                'This query contains a disallowed write/schema operation and cannot be executed.'
            );
        }
        $translatedSql = self::translateBracketIdentifiers($sql);

        $db = Database::publicQueryConnection();
        $db->beginTransaction();

        $rows = [];
        $truncated = false;
        try {
            // Bounds worst-case cost (e.g. an accidental/adversarial Cartesian join) — this
            // connection is shared infrastructure across every org's exposed queries.
            $db->exec("SET LOCAL statement_timeout = '5s'");

            // is_local = true scopes the setting to this transaction only — the next request's
            // connection never sees a stale project id.
            $scopeStmt = $db->prepare("SELECT set_config('app.query_project_id', :projectId, true)");
            $scopeStmt->execute(['projectId' => $projectId]);

            $stmt = $db->query($translatedSql);
            while (($row = $stmt->fetch()) !== false) {
                if (count($rows) >= self::MAX_ROWS) {
                    $truncated = true;
                    break;
                }
                $rows[] = $row;
            }
        } catch (PDOException $e) {
            throw new ApiValidationException('Query failed: ' . $e->getMessage());
        } finally {
            // Read-only by construction (enkl_public_query has no write grants at all) — rollback
            // rather than commit purely to release the transaction cleanly, nothing to persist.
            if ($db->inTransaction()) {
                $db->rollBack();
            }
        }

        return ['rows' => $rows, 'truncated' => $truncated];
    }
}
