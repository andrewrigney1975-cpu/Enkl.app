<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\DocumentService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for DocumentService — create()/update() got beginTransaction()/
 * commit()/rollBack() wrapping this session (ARCHITECTURE-REVIEW.md finding 3.1): the Documents row
 * plus setRelatedDocuments()'s junction-table writes.
 */
final class DocumentServiceTest extends TestCase
{
    private static PDO $db;
    private static DocumentService $documents;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$documents = new DocumentService(self::$db);
    }

    public function testCreateUpdateDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $other = self::$documents->create($projectId, ['title' => 'Related Doc']);

        $created = self::$documents->create($projectId, ['title' => 'Design Doc', 'url' => 'https://example.com/doc', 'relatedDocumentIds' => [$other['id']]]);
        self::assertNotNull($created);
        self::assertSame('Design Doc', $created['title']);
        self::assertSame([$other['id']], $created['relatedDocumentIds']);
        $documentId = $created['id'];

        $updated = self::$documents->update($projectId, $documentId, ['title' => 'Design Doc v2', 'url' => 'https://example.com/doc2', 'relatedDocumentIds' => []]);
        self::assertNotNull($updated);
        self::assertSame('Design Doc v2', $updated['title']);
        self::assertSame([], $updated['relatedDocumentIds']);

        $stmt = self::$db->prepare('SELECT "Title" FROM "Documents" WHERE "Id" = :id');
        $stmt->execute(['id' => $documentId]);
        self::assertSame('Design Doc v2', $stmt->fetchColumn());

        $deleted = self::$documents->delete($projectId, $documentId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "Documents" WHERE "Id" = :id');
        $stmt->execute(['id' => $documentId]);
        self::assertFalse($stmt->fetch());
    }

    public function testRelatedDocumentsExcludesSelfReference(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        $created = self::$documents->create($projectId, ['title' => 'Self Ref']);
        $updated = self::$documents->update($projectId, $created['id'], ['title' => 'Self Ref', 'relatedDocumentIds' => [$created['id']]]);
        self::assertSame([], $updated['relatedDocumentIds']);
    }

    public function testDeleteNonExistentDocumentReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $projectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));

        self::assertFalse(self::$documents->delete($projectId, Uuid::v4()));
    }
}
