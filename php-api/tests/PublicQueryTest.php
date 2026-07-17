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
        $seeded = $this->seedExposedQueryWithApiKey(sql: 'DELETE FROM query_tasks');

        $response = Http::get('/api/public/v1/queries/' . $seeded['savedQueryId'] . '/results', $seeded['apiKey']);

        self::assertSame(400, $response['status']);
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
