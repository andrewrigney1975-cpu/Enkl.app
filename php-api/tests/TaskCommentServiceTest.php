<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ColumnService;
use Enkl\Api\Services\TaskCommentService;
use Enkl\Api\Services\TaskService;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for TaskCommentService (mirrors api/Enkl.Api.Tests/TaskCommentServiceTests.cs).
 * Create: any project member, author always server-derived. Update: author-only. Delete: author OR
 * Project Admin OR Org Admin.
 */
final class TaskCommentServiceTest extends TestCase
{
    private static PDO $db;
    private static TaskCommentService $comments;
    private static TaskService $tasks;
    private static ColumnService $columns;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$comments = new TaskCommentService(self::$db);
        self::$tasks = new TaskService(self::$db);
        self::$columns = new ColumnService(self::$db);
    }

    /** @return array{projectId:string, taskId:string} */
    private function seedProjectWithTask(string $orgId): array
    {
        $projectId = TestDataHelper::seedProject(self::$db, $orgId, TestDataHelper::unique('P'));
        $column = self::$columns->create($projectId, ['name' => 'To Do', 'done' => false]);
        $task = self::$tasks->create($projectId, ['title' => 'Task', 'priority' => 'medium', 'columnId' => $column['id']]);
        return ['projectId' => $projectId, 'taskId' => $task['id']];
    }

    private function addMember(string $projectId, string $userId, bool $isProjectAdmin = false): string
    {
        $memberId = Uuid::v4();
        self::$db->prepare(
            'INSERT INTO "ProjectMembers" ("Id", "ProjectId", "UserId", "Color", "IsProjectAdmin") VALUES (:id, :pid, :uid, :color, :isProjectAdmin)'
        )->execute(['id' => $memberId, 'pid' => $projectId, 'uid' => $userId, 'color' => '#4f46e5', 'isProjectAdmin' => (int) $isProjectAdmin]);
        return $memberId;
    }

    public function testCreateStampsCallerAsAuthorFromTheirOwnMembership(): void
    {
        $username = TestDataHelper::unique('user');
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), $username);
        $ctx = $this->seedProjectWithTask($seeded['orgId']);
        $memberId = $this->addMember($ctx['projectId'], $seeded['userId']);

        $result = self::$comments->create($ctx['projectId'], $ctx['taskId'], $seeded['userId'], ['text' => 'Looks good']);

        self::assertNotNull($result);
        self::assertSame('Looks good', $result['text']);
        self::assertSame($memberId, $result['authorId']);
        self::assertSame($username, $result['authorName']);
    }

    public function testCreateThrowsWhenCallerHasNoMembership(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $ctx = $this->seedProjectWithTask($seeded['orgId']);

        $this->expectException(ApiValidationException::class);
        self::$comments->create($ctx['projectId'], $ctx['taskId'], $seeded['userId'], ['text' => 'Hi']);
    }

    public function testCreateReturnsNullForTaskOutsideProject(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $ctx = $this->seedProjectWithTask($seeded['orgId']);
        $otherProjectId = TestDataHelper::seedProject(self::$db, $seeded['orgId'], TestDataHelper::unique('P'));
        $this->addMember($ctx['projectId'], $seeded['userId']);

        $result = self::$comments->create($otherProjectId, $ctx['taskId'], $seeded['userId'], ['text' => 'Hi']);

        self::assertNull($result);
    }

    public function testUpdateAuthorCanEditTheirOwnComment(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $ctx = $this->seedProjectWithTask($seeded['orgId']);
        $this->addMember($ctx['projectId'], $seeded['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $seeded['userId'], ['text' => 'Original']);

        $updated = self::$comments->update($ctx['projectId'], $ctx['taskId'], $created['id'], $seeded['userId'], ['text' => 'Edited']);

        self::assertNotNull($updated);
        self::assertSame('Edited', $updated['text']);
    }

    public function testUpdateReturnsNullForNonAuthor(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $other = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('other'), false);
        $ctx = $this->seedProjectWithTask($author['orgId']);
        $this->addMember($ctx['projectId'], $author['userId']);
        $this->addMember($ctx['projectId'], $other['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $author['userId'], ['text' => 'Original']);

        $updated = self::$comments->update($ctx['projectId'], $ctx['taskId'], $created['id'], $other['userId'], ['text' => 'Hijacked']);

        self::assertNull($updated);
        $stmt = self::$db->prepare('SELECT "Text" FROM "TaskComments" WHERE "Id" = :id');
        $stmt->execute(['id' => $created['id']]);
        self::assertSame('Original', $stmt->fetchColumn());
    }

    public function testDeleteAuthorCanDeleteTheirOwnComment(): void
    {
        $seeded = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('user'));
        $ctx = $this->seedProjectWithTask($seeded['orgId']);
        $this->addMember($ctx['projectId'], $seeded['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $seeded['userId'], ['text' => 'Bye']);

        $deleted = self::$comments->delete($ctx['projectId'], $ctx['taskId'], $created['id'], $seeded['userId'], false, null);

        self::assertTrue($deleted);
        $stmt = self::$db->prepare('SELECT 1 FROM "TaskComments" WHERE "Id" = :id');
        $stmt->execute(['id' => $created['id']]);
        self::assertFalse($stmt->fetch());
    }

    public function testDeleteReturnsFalseForNonAuthorNonAdmin(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $other = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('other'), false);
        $ctx = $this->seedProjectWithTask($author['orgId']);
        $this->addMember($ctx['projectId'], $author['userId']);
        $this->addMember($ctx['projectId'], $other['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $author['userId'], ['text' => 'Mine']);

        $deleted = self::$comments->delete($ctx['projectId'], $ctx['taskId'], $created['id'], $other['userId'], false, null);

        self::assertFalse($deleted);
    }

    public function testDeleteProjectAdminCanDeleteAnotherMembersComment(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $admin = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('admin'), false);
        $ctx = $this->seedProjectWithTask($author['orgId']);
        $this->addMember($ctx['projectId'], $author['userId']);
        $this->addMember($ctx['projectId'], $admin['userId'], true);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $author['userId'], ['text' => 'Needs moderation']);

        $deleted = self::$comments->delete($ctx['projectId'], $ctx['taskId'], $created['id'], $admin['userId'], false, null);

        self::assertTrue($deleted);
    }

    public function testDeleteOrgAdminFromCallersOwnOrgCanDeleteWithoutMembership(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $orgAdmin = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org3'), TestDataHelper::unique('orgadmin'), true);
        $ctx = $this->seedProjectWithTask($author['orgId']);
        $this->addMember($ctx['projectId'], $author['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $author['userId'], ['text' => 'Needs moderation']);

        // orgAdmin has NO ProjectMembers row here — callerOrgId must equal the PROJECT's own
        // organisation (author's org), not orgAdmin's own seeded org, to prove live re-derivation.
        $deleted = self::$comments->delete($ctx['projectId'], $ctx['taskId'], $created['id'], $orgAdmin['userId'], true, $author['orgId']);

        self::assertTrue($deleted);
    }

    public function testDeleteOrgAdminFromDifferentOrgCannotDelete(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $foreignOrgAdmin = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org4'), TestDataHelper::unique('foreignadmin'), true);
        $ctx = $this->seedProjectWithTask($author['orgId']);
        $this->addMember($ctx['projectId'], $author['userId']);
        $created = self::$comments->create($ctx['projectId'], $ctx['taskId'], $author['userId'], ['text' => 'Needs moderation']);

        $deleted = self::$comments->delete($ctx['projectId'], $ctx['taskId'], $created['id'], $foreignOrgAdmin['userId'], true, $foreignOrgAdmin['orgId']);

        self::assertFalse($deleted);
    }
}
