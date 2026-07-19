<?php

declare(strict_types=1);

namespace Enkl\Api\Tests;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ChatService;
use Enkl\Api\Support\SqlDateTime;
use Enkl\Api\Tests\Support\TestDataHelper;
use Enkl\Api\Validation\ApiValidationException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Direct-service-call coverage for ChatService (mirrors api/Enkl.Api.Tests/ChatServiceTests.cs).
 * Create/post: any org user. Update: author-only. Delete: author OR Org Admin (soft delete, text
 * preserved). List: member sees own channels; Org Admin additionally sees every other org channel in
 * a separate bucket. Truncate: hard-deletes messages older than 180 days, scoped to the caller's org.
 */
final class ChatServiceTest extends TestCase
{
    private static PDO $db;
    private static ChatService $chat;

    public static function setUpBeforeClass(): void
    {
        self::$db = Database::connection();
        self::$chat = new ChatService(self::$db);
    }

    public function testCreateChannelGroupAddsCreatorAndRequestedMembers(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        $colleagueId = TestDataHelper::seedUserInOrg(self::$db, $creator['orgId'], TestDataHelper::unique('colleague'));

        $result = self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', [
            'name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => [$colleagueId],
        ]);

        self::assertSame('General', $result['name']);
        self::assertFalse($result['isDirectMessage']);
        self::assertCount(2, $result['members']);
        $memberIds = array_column($result['members'], 'userId');
        self::assertContains($creator['userId'], $memberIds);
        self::assertContains($colleagueId, $memberIds);
    }

    public function testCreateChannelDirectMessageThrowsUnlessExactlyTwoMembers(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));

        $this->expectException(ApiValidationException::class);
        self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', [
            'isDirectMessage' => true, 'memberUserIds' => [],
        ]);
    }

    public function testCreateChannelDirectMessageDedupesExistingDmBetweenSamePair(): void
    {
        $userA = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('a'));
        $userBId = TestDataHelper::seedUserInOrg(self::$db, $userA['orgId'], TestDataHelper::unique('b'));

        $first = self::$chat->createChannel($userA['orgId'], $userA['userId'], 'A', ['isDirectMessage' => true, 'memberUserIds' => [$userBId]]);
        $second = self::$chat->createChannel($userA['orgId'], $userBId, 'B', ['isDirectMessage' => true, 'memberUserIds' => [$userA['userId']]]);

        self::assertSame($first['id'], $second['id']);
        $stmt = self::$db->prepare('SELECT COUNT(*) FROM "ChatChannels" WHERE "Id" = :id');
        $stmt->execute(['id' => $first['id']]);
        self::assertSame(1, (int) $stmt->fetchColumn());
    }

    public function testListChannelsNonMemberDoesNotSeeChannelUnlessOrgAdmin(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        $outsiderId = TestDataHelper::seedUserInOrg(self::$db, $creator['orgId'], TestDataHelper::unique('outsider'), false);
        self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', ['name' => 'Private', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $outsiderView = self::$chat->listChannels($creator['orgId'], $outsiderId, false);

        self::assertEmpty($outsiderView['channels']);
        self::assertEmpty($outsiderView['adminVisibleChannels']);
    }

    public function testListChannelsOrgAdminSeesNonMemberChannelsInAdminBucketOnly(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        $adminId = TestDataHelper::seedUserInOrg(self::$db, $creator['orgId'], TestDataHelper::unique('admin'), true);
        $created = self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', ['name' => 'Private', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $adminView = self::$chat->listChannels($creator['orgId'], $adminId, true);

        self::assertEmpty($adminView['channels']);
        self::assertCount(1, $adminView['adminVisibleChannels']);
        self::assertSame($created['id'], $adminView['adminVisibleChannels'][0]['id']);
    }

    public function testListChannelsOrgAdminFromDifferentOrgSeesNothing(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        $foreignAdmin = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('foreignadmin'), true);
        self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', ['name' => 'Private', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $foreignView = self::$chat->listChannels($foreignAdmin['orgId'], $foreignAdmin['userId'], true);

        self::assertEmpty($foreignView['channels']);
        self::assertEmpty($foreignView['adminVisibleChannels']);
    }

    public function testPostMessageNonMemberCannotPost(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        $outsiderId = TestDataHelper::seedUserInOrg(self::$db, $creator['orgId'], TestDataHelper::unique('outsider'), false);
        $channel = self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $result = self::$chat->postMessage($creator['orgId'], $outsiderId, 'Outsider', $channel['id'], ['text' => 'Hi']);

        self::assertNull($result);
    }

    public function testPostMessageParsesMentionsAgainstChannelMembers(): void
    {
        $creator = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('creator'));
        // Unique-suffixed but still space-containing, matching this file's shared-Postgres-instance
        // convention (a fixed literal display name collides across runs) while still exercising the
        // "@Full Name" multi-word matching path.
        $mentionedName = 'Andrew Rigney ' . TestDataHelper::unique('u');
        $mentionedId = TestDataHelper::seedUserInOrg(self::$db, $creator['orgId'], $mentionedName);
        $channel = self::$chat->createChannel($creator['orgId'], $creator['userId'], 'Creator', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => [$mentionedId]]);

        $result = self::$chat->postMessage($creator['orgId'], $creator['userId'], 'Creator', $channel['id'], ['text' => "Hey @{$mentionedName}, can you take a look?"]);

        self::assertNotNull($result);
        self::assertContains($mentionedId, $result['message']['mentionedUserIds']);
    }

    public function testUpdateMessageNonAuthorCannotEdit(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $otherId = TestDataHelper::seedUserInOrg(self::$db, $author['orgId'], TestDataHelper::unique('other'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => [$otherId]]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Original']);

        $updated = self::$chat->updateMessage($otherId, $channel['id'], $posted['message']['id'], ['text' => 'Hijacked']);

        self::assertNull($updated);
        $stmt = self::$db->prepare('SELECT "Text" FROM "ChatMessages" WHERE "Id" = :id');
        $stmt->execute(['id' => $posted['message']['id']]);
        self::assertSame('Original', $stmt->fetchColumn());
    }

    public function testDeleteMessageSoftDeletesAndPreservesText(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Sensitive info']);

        $deleted = self::$chat->deleteMessage($author['orgId'], $author['userId'], false, $channel['id'], $posted['message']['id']);

        self::assertNotNull($deleted);
        $stmt = self::$db->prepare('SELECT "IsDeleted", "Text" FROM "ChatMessages" WHERE "Id" = :id');
        $stmt->execute(['id' => $posted['message']['id']]);
        $row = $stmt->fetch();
        self::assertNotFalse($row); // still in the DB — soft delete only
        self::assertTrue((bool) $row['IsDeleted']);
        self::assertSame('Sensitive info', $row['Text']); // text preserved, never cleared
    }

    public function testDeleteMessageNonAuthorNonAdminCannotDelete(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $otherId = TestDataHelper::seedUserInOrg(self::$db, $author['orgId'], TestDataHelper::unique('other'), false);
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => [$otherId]]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Mine']);

        $deleted = self::$chat->deleteMessage($author['orgId'], $otherId, false, $channel['id'], $posted['message']['id']);

        self::assertNull($deleted);
        $stmt = self::$db->prepare('SELECT "IsDeleted" FROM "ChatMessages" WHERE "Id" = :id');
        $stmt->execute(['id' => $posted['message']['id']]);
        self::assertFalse((bool) $stmt->fetchColumn());
    }

    public function testDeleteMessageOrgAdminCanDeleteAnyMessageInTheirOrg(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $adminId = TestDataHelper::seedUserInOrg(self::$db, $author['orgId'], TestDataHelper::unique('admin'), true);
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Needs moderation']);

        // Admin has no membership row on this channel at all — proves the admin override, not a
        // membership match.
        $deleted = self::$chat->deleteMessage($author['orgId'], $adminId, true, $channel['id'], $posted['message']['id']);

        self::assertNotNull($deleted);
    }

    public function testToggleReactionAddsThenRemovesOnSecondCall(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $reactorId = TestDataHelper::seedUserInOrg(self::$db, $author['orgId'], TestDataHelper::unique('reactor'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => [$reactorId]]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Hello']);

        $emoji = "\u{1F44D}";
        $afterAdd = self::$chat->toggleReaction($author['orgId'], $reactorId, false, $channel['id'], $posted['message']['id'], $emoji);
        self::assertNotNull($afterAdd);
        self::assertCount(1, $afterAdd['message']['reactions']);
        self::assertSame($emoji, $afterAdd['message']['reactions'][0]['emoji']);
        self::assertSame(1, $afterAdd['message']['reactions'][0]['count']);
        self::assertTrue($afterAdd['message']['reactions'][0]['reactedByMe']);

        $afterRemove = self::$chat->toggleReaction($author['orgId'], $reactorId, false, $channel['id'], $posted['message']['id'], $emoji);
        self::assertNotNull($afterRemove);
        self::assertCount(0, $afterRemove['message']['reactions']);
    }

    public function testToggleReactionRejectsAnEmojiOutsideTheAllowedSet(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Hello']);

        $this->expectException(ApiValidationException::class);
        self::$chat->toggleReaction($author['orgId'], $author['userId'], false, $channel['id'], $posted['message']['id'], "\u{1F355}");
    }

    public function testToggleReactionReturnsNullForANonMemberNonAdminCaller(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $outsiderId = TestDataHelper::seedUserInOrg(self::$db, $author['orgId'], TestDataHelper::unique('outsider'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);
        $posted = self::$chat->postMessage($author['orgId'], $author['userId'], 'Author', $channel['id'], ['text' => 'Hello']);

        $result = self::$chat->toggleReaction($author['orgId'], $outsiderId, false, $channel['id'], $posted['message']['id'], "\u{1F44D}");

        self::assertNull($result);
    }

    public function testTruncateOldMessagesHardDeletesOnlyMessagesOlderThan180Days(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $recentId = $this->insertMessageWithAge($channel['id'], $author['userId'], 'Author', 'Recent', 179);
        $oldId = $this->insertMessageWithAge($channel['id'], $author['userId'], 'Author', 'Old', 181);

        $result = self::$chat->truncateOldMessages($author['orgId']);

        self::assertSame(1, $result['deletedCount']);
        self::assertNotFalse($this->fetchMessage($recentId));
        self::assertFalse($this->fetchMessage($oldId));
    }

    public function testTruncateOldMessagesDoesNotTouchOtherOrganisationsMessages(): void
    {
        $author = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org'), TestDataHelper::unique('author'));
        $otherAuthor = TestDataHelper::seedOrgAndUser(self::$db, TestDataHelper::unique('org2'), TestDataHelper::unique('author2'));
        $channel = self::$chat->createChannel($author['orgId'], $author['userId'], 'Author', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);
        $otherChannel = self::$chat->createChannel($otherAuthor['orgId'], $otherAuthor['userId'], 'Author2', ['name' => 'General', 'isDirectMessage' => false, 'memberUserIds' => []]);

        $oldInThisOrg = $this->insertMessageWithAge($channel['id'], $author['userId'], 'Author', 'Old', 200);
        $oldInOtherOrg = $this->insertMessageWithAge($otherChannel['id'], $otherAuthor['userId'], 'Author2', 'Old too', 200);

        $result = self::$chat->truncateOldMessages($author['orgId']);

        self::assertSame(1, $result['deletedCount']);
        self::assertFalse($this->fetchMessage($oldInThisOrg));
        self::assertNotFalse($this->fetchMessage($oldInOtherOrg)); // untouched — different org
    }

    private function insertMessageWithAge(string $channelId, string $authorUserId, string $authorName, string $text, int $daysAgo): string
    {
        $id = \Enkl\Api\Support\Uuid::v4();
        // MariaDB port: bind SqlDateTime's own MariaDB-safe literal form, not php-api's original
        // ISO-8601-with-Z (rejected by a DATETIME column here — see that class's own doc comment).
        $dateCreated = SqlDateTime::fromTimestamp(strtotime("-{$daysAgo} days"));
        self::$db->prepare(
            'INSERT INTO "ChatMessages" ("Id", "ChannelId", "AuthorUserId", "AuthorName", "Text", "DateCreated", "IsDeleted") VALUES (:id, :cid, :aid, :aname, :text, :dc, false)'
        )->execute(['id' => $id, 'cid' => $channelId, 'aid' => $authorUserId, 'aname' => $authorName, 'text' => $text, 'dc' => $dateCreated]);
        return $id;
    }

    /** @return array<string, mixed>|false */
    private function fetchMessage(string $id)
    {
        $stmt = self::$db->prepare('SELECT * FROM "ChatMessages" WHERE "Id" = :id');
        $stmt->execute(['id' => $id]);
        return $stmt->fetch();
    }
}
