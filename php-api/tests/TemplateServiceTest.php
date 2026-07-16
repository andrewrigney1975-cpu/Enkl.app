<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TemplateService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for TemplateService — not transaction-wrapped this session
 * (single-statement create/rename/delete), but had zero coverage before this pass.
 */
final class TemplateServiceTest extends TestCase
{
    private static PDO $db;
    private static TemplateService $templates;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$templates = new TemplateService(self::$db);
    }

    public function testCreateRenameDeleteRoundTrip(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        $created = self::$templates->create($seeded['orgId'], [
            'name' => 'Standard Kanban',
            'columns' => [['id' => 'c1', 'name' => 'To Do', 'done' => false, 'order' => 0]],
            'taskTypes' => [['name' => 'Feature']],
        ]);
        self::assertSame('Standard Kanban', $created['name']);
        $templateId = $created['id'];

        $detail = self::$templates->getDetail($seeded['orgId'], $templateId);
        self::assertNotNull($detail);
        self::assertCount(1, $detail['columns']);

        $renamed = self::$templates->rename($seeded['orgId'], $templateId, 'Renamed Kanban');
        self::assertTrue($renamed);

        $stmt = self::$db->prepare('SELECT "Name" FROM "ProjectTemplates" WHERE "Id" = :id');
        $stmt->execute(['id' => $templateId]);
        self::assertSame('Renamed Kanban', $stmt->fetchColumn());

        $deleted = self::$templates->delete($seeded['orgId'], $templateId);
        self::assertTrue($deleted);

        $stmt = self::$db->prepare('SELECT 1 FROM "ProjectTemplates" WHERE "Id" = :id');
        $stmt->execute(['id' => $templateId]);
        self::assertFalse($stmt->fetch());
    }

    public function testTemplateIsScopedToOwningOrganisation(): void
    {
        $seededA = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-a'), TestDataHelper::unique('user'));
        $seededB = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org-b'), TestDataHelper::unique('user'));

        $created = self::$templates->create($seededA['orgId'], ['name' => 'Org A Template']);

        self::assertNull(self::$templates->getDetail($seededB['orgId'], $created['id']));
        self::assertFalse(self::$templates->rename($seededB['orgId'], $created['id'], 'Hijacked'));
        self::assertFalse(self::$templates->delete($seededB['orgId'], $created['id']));
    }

    public function testDeleteNonExistentTemplateReturnsFalse(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));

        self::assertFalse(self::$templates->delete($seeded['orgId'], Uuid::v4()));
    }
}
