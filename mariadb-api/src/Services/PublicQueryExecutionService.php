<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Db\Database;
use Enkl\Api\Validation\ApiValidationException;
use PDOException;

/**
 * Ported from Services/PublicQueryExecutionService.cs (via php-api's own Postgres port). Executes a
 * SavedQuery's SQL text against real MariaDB (every other execution of this SQL grammar happens
 * client-side, in the browser, via AlaSQL — see query-engine.js). Used only by
 * PublicQueryController.
 *
 * Safety model: Database::publicQueryConnection() authenticates as the dedicated, SELECT-only
 * enkl_public_query MariaDB user (created by
 * src/Db/migrations/006_saved_queries_and_public_api.sql) — never the app's own high-privilege
 * connection. That user can see nothing except the eleven all-lowercase views named/columned to
 * match TABLE_SCHEMAS in query-engine.js — that grant boundary is the actual guarantee, not the
 * FORBIDDEN_PATTERN check below (ported from query-engine.js, deliberately redundant
 * defense-in-depth matching the existing convention).
 *
 * MariaDB-specific project isolation (see 006_saved_queries_and_public_api.sql's own header comment
 * for the two rejected designs that came before this one, each verified against a live MariaDB 11.4
 * instance): every view filters on `(SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" =
 * CONNECTION_ID())`, so `execute()` below must set that row on THIS fresh connection before running
 * the saved query, and clean it up again once done (best-effort, in `finally` — a leftover row is
 * harmless, see that migration's own comment on why).
 *
 * translateBracketIdentifiers() (ported unchanged from the Postgres tiers): the SQL formatter/
 * intellisense bracket-quotes every identifier (`[tasks].[title]`), matching AlaSQL's own grammar,
 * which needs rewriting to this tier's own double-quoted form before execution — MariaDB has no
 * bracket-quoting syntax either, so this rewrite is equally necessary here. Lowercasing the bracket
 * contents in the process keeps a bracketed `[columnId]` and a bare `columnId` reference resolving
 * to the same (already-lowercase) view column, matching the Postgres tiers' own identical reasoning.
 */
final class PublicQueryExecutionService
{
    private const FORBIDDEN_PATTERN = '/\b(CREATE|DELETE|DROP|INSERT|UPDATE|ALTER|TRUNCATE|ATTACH|DETACH|GRANT|REVOKE)\b/i';

    // A caller with a valid API key and an exposed query could otherwise force an unbounded
    // response by simply not writing a LIMIT — this caps worst-case payload size regardless of what
    // the saved SQL itself asks for.
    private const MAX_ROWS = 1000;

    // Every view's one-to-many "IDs"/dependency column (see the migration's own GROUP_CONCAT note) —
    // these arrive from MariaDB as a comma-joined string (or NULL), and must be split into a real
    // array before results reach the frontend's AlaSQL engine, which expects an array-shaped value
    // for each of these exactly like the other two tiers already produce natively.
    private const ARRAY_COLUMNS = [
        'dependencies', 'documentids', 'principleids', 'objectiveids', 'riskids', 'relateddocumentids', 'memberids',
    ];

    /** Rewrites AlaSQL-style `[identifier]` bracket-quoting to Postgres' `"identifier"`
     * double-quoting, LOWERCASING the bracket contents in the process (see this class's own doc
     * comment for why) — a simple character-level pass, not a real SQL tokenizer, so it toggles
     * string-literal tracking on every unescaped `'` (a doubled `''` toggles twice, correctly
     * leaving the parser "still inside" the same string). */
    private static function translateBracketIdentifiers(string $sql): string
    {
        $result = '';
        $inString = false;
        $bracketBuffer = null;
        for ($i = 0, $len = strlen($sql); $i < $len; $i++) {
            $c = $sql[$i];
            if ($bracketBuffer !== null) {
                if ($c === ']') {
                    $result .= '"' . strtolower($bracketBuffer) . '"';
                    $bracketBuffer = null;
                } else {
                    $bracketBuffer .= $c;
                }
            } elseif ($c === "'") {
                $inString = !$inString;
                $result .= $c;
            } elseif (!$inString && $c === '[') {
                $bracketBuffer = '';
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
        // enkl_public_query has no write grants anywhere (by design) — the QueryContext row that
        // scopes this connection's views to one project has to be set via the app's own
        // high-privilege connection instead, keyed by the LOW-privilege connection's own
        // CONNECTION_ID() (asked of that connection directly, since it's a per-connection value).
        $connectionId = (int) $db->query('SELECT CONNECTION_ID()')->fetchColumn();
        $adminDb = Database::connection();
        $adminDb->prepare(
            'INSERT INTO "QueryContext" ("ConnectionId", "ProjectId") VALUES (:cid, :pid) '
            . 'ON DUPLICATE KEY UPDATE "ProjectId" = VALUES("ProjectId")'
        )->execute(['cid' => $connectionId, 'pid' => $projectId]);

        // Bounds worst-case cost (e.g. an accidental/adversarial Cartesian join) — MariaDB's own
        // session-level statement-time cap (Postgres's `SET LOCAL statement_timeout` equivalent);
        // safe as a plain session setting (not transaction-scoped) because this connection is
        // freshly opened per call and discarded right after, never reused for a later request.
        $db->exec('SET SESSION max_statement_time = 5');

        $db->beginTransaction();

        $rows = [];
        $truncated = false;
        try {
            $stmt = $db->query($translatedSql);
            while (($row = $stmt->fetch()) !== false) {
                if (count($rows) >= self::MAX_ROWS) {
                    $truncated = true;
                    break;
                }
                foreach (self::ARRAY_COLUMNS as $column) {
                    if (array_key_exists($column, $row)) {
                        $row[$column] = $row[$column] === null || $row[$column] === '' ? [] : explode(',', (string) $row[$column]);
                    }
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
            // Best-effort cleanup of the QueryContext row — see that table's own migration comment
            // for why a missed cleanup (e.g. a crash right here) is harmless, not a leak.
            $adminDb->prepare('DELETE FROM "QueryContext" WHERE "ConnectionId" = :cid')->execute(['cid' => $connectionId]);
        }

        return ['rows' => $rows, 'truncated' => $truncated];
    }
}
