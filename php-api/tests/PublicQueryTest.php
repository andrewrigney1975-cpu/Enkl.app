<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\Http;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * PHP-tier mirror of api/Enkl.Api.Tests/PublicQueryTests.cs — real HTTP against the `php -S` test
 * server (see bootstrap.php), same reasoning as AuthTest: the whole point is verifying
 * ApiKeyAuthMiddleware's pipeline/no-enumeration-oracle behavior, not just service logic.
 */
final class PublicQueryTest extends TestCase
{
    private static PDO $db;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
    }

    /** @return array{projectId:string, savedQueryId:string, apiKey:string} */
    private function seedExposedQueryWithApiKey(bool $exposeViaApi = true, string $sql = 'SELECT 1 AS one'): array
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $admin = TestDataHelper::unique('admin');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $admin, isOrgAdmin: true);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $savedQueryId = Uuid::v4();
        self::$db->prepare(<<<SQL
            INSERT INTO "SavedQueries" ("Id", "ProjectId", "Name", "Sql", "DateCreated", "ExposeViaApi")
            VALUES (:id, :pid, 'Test query', :sql, now(), :expose)
        SQL)->execute(['id' => $savedQueryId, 'pid' => $projectId, 'sql' => $sql, 'expose' => (int) $exposeViaApi]);

        $login = Http::post('/api/auth/login', ['username' => $admin, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $keyResponse = Http::post('/api/organisations/me/api-key', [], $login['body']['token'], ['X-Forwarded-For' => $ip]);

        return ['projectId' => $projectId, 'savedQueryId' => $savedQueryId, 'apiKey' => $keyResponse['body']['key']];
    }

    public function testGetResultsWithValidKeyAndExposedQueryReturnsRows(): void
    {
        $seeded = $this->seedExposedQueryWithApiKey();

        $response = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', $seeded['apiKey']);

        self::assertSame(200, $response['status']);
        self::assertCount(1, $response['body']['rows']);
        self::assertFalse($response['body']['truncated']);
    }

    public function testGetResultsWithMissingOrWrongKeyReturnsNotFound(): void
    {
        $seeded = $this->seedExposedQueryWithApiKey();

        $noKey = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results');
        self::assertSame(404, $noKey['status']);

        $wrongKey = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', 'enkl_key_definitely-wrong');
        self::assertSame(404, $wrongKey['status']);
    }

    // Cross-org isolation (CLAUDE.md §4): a valid, enabled API key from a DIFFERENT organisation must
    // not unlock a query belonging to some other org's project.
    public function testGetResultsWithApiKeyFromDifferentOrganisationReturnsNotFound(): void
    {
        $seeded = $this->seedExposedQueryWithApiKey();
        $otherOrg = $this->seedExposedQueryWithApiKey();

        $response = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', $otherOrg['apiKey']);

        self::assertSame(404, $response['status']);
    }

    public function testGetResultsWhenExposeViaApiIsFalseReturnsNotFoundEvenWithAValidKey(): void
    {
        $seeded = $this->seedExposedQueryWithApiKey(exposeViaApi: false);

        $response = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', $seeded['apiKey']);

        self::assertSame(404, $response['status']);
    }

    // Belt-and-suspenders check (PublicQueryExecutionService::FORBIDDEN_PATTERN) — the real
    // guarantee is the enkl_public_query role's SELECT-only grant, but this should still reject
    // cleanly with a 400, not a raw Postgres permission-denied 500.
    public function testGetResultsWithWriteStatementInSavedSqlRejectsWithBadRequest(): void
    {
        $seeded = $this->seedExposedQueryWithApiKey(sql: 'DELETE FROM [tasks]');

        $response = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', $seeded['apiKey']);

        self::assertSame(400, $response['status']);
    }

    // Real bug found live (2026-07-18): a saved query authored via the Advanced Query UI is always
    // bracket-quoted (SQL formatter/intellisense) and uses AlaSQL's lowercase table names/camelCase
    // field names — Postgres understands neither verbatim. This exercises the exact shape of query
    // a real user would have saved, against real seeded task data, proving both
    // translateBracketIdentifiers() AND the view's camelCase column aliases are correct together.
    public function testGetResultsWithBracketQuotedQueryAgainstRealTaskDataReturnsCorrectlyMappedRows(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $admin = TestDataHelper::unique('admin');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $admin, isOrgAdmin: true);
        $projectKey = TestDataHelper::unique('P');
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey);

        $columnId = Uuid::v4();
        self::$db->prepare(
            'INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Order") VALUES (:id, :pid, \'To Do\', false, 0)'
        )->execute(['id' => $columnId, 'pid' => $projectId]);
        self::$db->prepare(<<<SQL
            INSERT INTO "Tasks" ("Id", "ProjectId", "Key", "Title", "Priority", "ColumnId", "Progress", "Archived", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, 'Fix login bug', 'high', :columnId, 0, false, now(), now())
        SQL)->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'key' => $projectKey . '-1', 'columnId' => $columnId]);

        $savedQueryId = Uuid::v4();
        self::$db->prepare(<<<SQL
            INSERT INTO "SavedQueries" ("Id", "ProjectId", "Name", "Sql", "DateCreated", "ExposeViaApi")
            VALUES (:id, :pid, 'Bracket-quoted test', :sql, now(), true)
        SQL)->execute(['id' => $savedQueryId, 'pid' => $projectId, 'sql' => "SELECT [title], [priority] FROM [tasks] WHERE [priority] = 'high'"]);

        $login = Http::post('/api/auth/login', ['username' => $admin, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $keyResponse = Http::post('/api/organisations/me/api-key', [], $login['body']['token'], ['X-Forwarded-For' => $ip]);

        $response = Http::get('/api/public/v1/queries/' . $savedQueryId . '/results', $keyResponse['body']['key']);

        self::assertSame(200, $response['status']);
        self::assertCount(1, $response['body']['rows']);
        self::assertSame('Fix login bug', $response['body']['rows'][0]['title']);
        self::assertSame('high', $response['body']['rows'][0]['priority']);
    }

    // Real bug found live (2026-07-18, second report): a saved query need not bracket-quote EVERY
    // identifier — AlaSQL resolves a bare `t.columnId` just fine. This mirrors the exact reported
    // repro: a mix of unquoted (t.id, t.columnId, tasks, c.done) and bracket-quoted ([column] as an
    // alias, [columns] as a table name) identifiers in the same query, proving both the
    // all-lowercase view schema AND the bracket translator's now-lowercasing behavior are correct
    // together.
    public function testGetResultsWithMixedBracketedAndUnquotedIdentifiersReturnsCorrectlyMappedRows(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $admin = TestDataHelper::unique('admin');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $admin, isOrgAdmin: true);
        $projectKey = TestDataHelper::unique('P');
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], $projectKey);

        $columnId = Uuid::v4();
        self::$db->prepare(
            'INSERT INTO "Columns" ("Id", "ProjectId", "Name", "Done", "Order") VALUES (:id, :pid, \'Done\', true, 0)'
        )->execute(['id' => $columnId, 'pid' => $projectId]);
        self::$db->prepare(<<<SQL
            INSERT INTO "Tasks" ("Id", "ProjectId", "Key", "Title", "Priority", "ColumnId", "Progress", "Archived", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, 'Ship the release', 'medium', :columnId, 0, false, now(), now())
        SQL)->execute(['id' => Uuid::v4(), 'pid' => $projectId, 'key' => $projectKey . '-1', 'columnId' => $columnId]);

        $savedQueryId = Uuid::v4();
        $sql = 'SELECT t.id, t.key, t.title, t.priority, c.name AS [column], t.dateLastModified ' .
            'FROM tasks t JOIN [columns] c ON t.columnId = c.id WHERE c.done = true ORDER BY t.dateLastModified DESC';
        self::$db->prepare(<<<SQL
            INSERT INTO "SavedQueries" ("Id", "ProjectId", "Name", "Sql", "DateCreated", "ExposeViaApi")
            VALUES (:id, :pid, 'Mixed quoting test', :sql, now(), true)
        SQL)->execute(['id' => $savedQueryId, 'pid' => $projectId, 'sql' => $sql]);

        $login = Http::post('/api/auth/login', ['username' => $admin, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $keyResponse = Http::post('/api/organisations/me/api-key', [], $login['body']['token'], ['X-Forwarded-For' => $ip]);

        $response = Http::get('/api/public/v1/queries/' . $savedQueryId . '/results', $keyResponse['body']['key']);

        self::assertSame(200, $response['status']);
        self::assertCount(1, $response['body']['rows']);
        self::assertSame('Ship the release', $response['body']['rows'][0]['title']);
        self::assertSame('medium', $response['body']['rows'][0]['priority']);
        self::assertSame('Done', $response['body']['rows'][0]['column']);
    }

    // Revoking the key must take effect immediately — no separate "logout" step for an API key.
    public function testGetResultsAfterKeyIsRevokedReturnsNotFound(): void
    {
        $ip = TestDataHelper::uniqueIp();
        $org = TestDataHelper::unique('org');
        $admin = TestDataHelper::unique('admin');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, $org, $admin, isOrgAdmin: true);
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $savedQueryId = Uuid::v4();
        self::$db->prepare(<<<SQL
            INSERT INTO "SavedQueries" ("Id", "ProjectId", "Name", "Sql", "DateCreated", "ExposeViaApi")
            VALUES (:id, :pid, 'Q', 'SELECT 1 AS one', now(), true)
        SQL)->execute(['id' => $savedQueryId, 'pid' => $projectId]);

        $login = Http::post('/api/auth/login', ['username' => $admin, 'password' => TestDataHelper::DEFAULT_PASSWORD], null, ['X-Forwarded-For' => $ip]);
        $token = $login['body']['token'];
        $keyResponse = Http::post('/api/organisations/me/api-key', [], $token, ['X-Forwarded-For' => $ip]);
        $apiKey = $keyResponse['body']['key'];

        $beforeRevoke = Http::get('/api/public/v1/queries/' . $savedQueryId . '/results', $apiKey);
        self::assertSame(200, $beforeRevoke['status']);

        $revokeResponse = Http::delete('/api/organisations/me/api-key', $token, ['X-Forwarded-For' => $ip]);
        self::assertSame(200, $revokeResponse['status']);

        $afterRevoke = Http::get('/api/public/v1/queries/' . $savedQueryId . '/results', $apiKey);
        self::assertSame(404, $afterRevoke['status']);
    }
}
