<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/ChatService.cs — see that file's own comments for the "why" behind each piece.
 * All chat data is organisation-scoped (no ProjectMember concept applies). Create/post: any org user.
 * Update: author-only. Delete: author OR Org Admin (soft delete only, text preserved). Viewing a
 * channel: member OR Org Admin.
 */
final class ChatService
{
    public function __construct(private readonly PDO $db)
    {
    }

    // ---- Roster (member picker / @mention autocomplete / presence dots) ----

    /** @return array<int, array{id: string, displayName: string, isOnline: bool}> */
    public function getOrgRoster(string $organisationId): array
    {
        $online = $this->onlineUserIds();
        $stmt = $this->db->prepare('SELECT "Id", "DisplayName" FROM "Users" WHERE "OrganisationId" = :orgId AND "IsActive" = true ORDER BY "DisplayName"');
        $stmt->execute(['orgId' => $organisationId]);

        return array_map(
            fn (array $u) => ['id' => $u['Id'], 'displayName' => $u['DisplayName'], 'isOnline' => in_array($u['Id'], $online, true)],
            $stmt->fetchAll()
        );
    }

    /** @return string[] */
    private function onlineUserIds(): array
    {
        // Grace window slightly wider than EventsController's 15s heartbeat, same reasoning as that
        // file's own comment — tolerates one missed beat without flickering a still-connected user offline.
        $stmt = $this->db->query('SELECT "UserId" FROM "SsePresence" WHERE "LastSeenAt" > now() - interval \'25 seconds\'');
        return array_column($stmt->fetchAll(), 'UserId');
    }

    // ---- Channels ----

    public function listChannels(string $organisationId, string $callerUserId, bool $callerIsOrgAdmin): array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Name", "IsDirectMessage", "DateCreated" FROM "ChatChannels" WHERE "OrganisationId" = :orgId ORDER BY "DateCreated" DESC');
        $stmt->execute(['orgId' => $organisationId]);
        $channels = $stmt->fetchAll();

        $online = $this->onlineUserIds();
        $memberChannels = [];
        $adminOnlyChannels = [];
        foreach ($channels as $c) {
            $members = $this->channelMembers($c['Id'], $online);
            $isMember = in_array($callerUserId, array_column($members, 'userId'), true);
            $dto = $this->toChannelDto($c, $members);
            if ($isMember) {
                $memberChannels[] = $dto;
            } elseif ($callerIsOrgAdmin) {
                $adminOnlyChannels[] = $dto;
            }
        }

        return ['channels' => $memberChannels, 'adminVisibleChannels' => $adminOnlyChannels];
    }

    public function createChannel(string $organisationId, string $callerUserId, string $callerDisplayName, array $request): array
    {
        $requestedIds = array_unique(array_merge($request['memberUserIds'] ?? [], [$callerUserId]));
        $placeholders = implode(',', array_map(fn ($i) => ":m$i", array_keys($requestedIds)));
        $params = ['orgId' => $organisationId];
        foreach (array_values($requestedIds) as $i => $id) {
            $params["m$i"] = $id;
        }
        $stmt = $this->db->prepare("SELECT \"Id\" FROM \"Users\" WHERE \"OrganisationId\" = :orgId AND \"Id\" IN ($placeholders)");
        $stmt->execute($params);
        $validMemberIds = array_column($stmt->fetchAll(), 'Id');
        if (count($validMemberIds) === 0) {
            $validMemberIds = [$callerUserId];
        }

        $isDirectMessage = (bool) ($request['isDirectMessage'] ?? false);
        if ($isDirectMessage) {
            if (count($validMemberIds) !== 2) {
                throw new ApiValidationException('A direct message must have exactly two members.');
            }

            $existing = $this->findExistingDirectMessage($organisationId, $validMemberIds);
            if ($existing !== null) {
                return $existing;
            }
        }

        $name = $isDirectMessage ? null : trim((string) ($request['name'] ?? ''));
        if (!$isDirectMessage && $name === '') {
            throw new ApiValidationException('Channel name is required.');
        }

        $this->db->beginTransaction();
        try {
            $channelId = Uuid::v4();
            $dateCreated = gmdate('Y-m-d\TH:i:s\Z');
            $this->db->prepare(
                'INSERT INTO "ChatChannels" ("Id", "OrganisationId", "Name", "IsDirectMessage", "CreatedByUserId", "DateCreated") VALUES (:id, :orgId, :name, :dm, :cb, :dc)'
            )->execute(['id' => $channelId, 'orgId' => $organisationId, 'name' => $name, 'dm' => $isDirectMessage ? 't' : 'f', 'cb' => $callerUserId, 'dc' => $dateCreated]);

            $memberStmt = $this->db->prepare('INSERT INTO "ChatChannelMembers" ("Id", "ChannelId", "UserId", "DateJoined") VALUES (:id, :cid, :uid, :dj)');
            foreach ($validMemberIds as $userId) {
                $memberStmt->execute(['id' => Uuid::v4(), 'cid' => $channelId, 'uid' => $userId, 'dj' => $dateCreated]);
            }
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        $online = $this->onlineUserIds();
        return $this->toChannelDto(['Id' => $channelId, 'Name' => $name, 'IsDirectMessage' => $isDirectMessage, 'DateCreated' => $dateCreated], $this->channelMembers($channelId, $online));
    }

    private function findExistingDirectMessage(string $organisationId, array $memberIds): ?array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT c."Id", c."Name", c."IsDirectMessage", c."DateCreated"
            FROM "ChatChannels" c
            WHERE c."OrganisationId" = :orgId AND c."IsDirectMessage" = true
              AND (SELECT COUNT(*) FROM "ChatChannelMembers" cm WHERE cm."ChannelId" = c."Id") = 2
              AND NOT EXISTS (
                  SELECT 1 FROM "ChatChannelMembers" cm WHERE cm."ChannelId" = c."Id" AND cm."UserId" NOT IN (:u1, :u2)
              )
        SQL);
        $stmt->execute(['orgId' => $organisationId, 'u1' => $memberIds[0], 'u2' => $memberIds[1]]);
        $row = $stmt->fetch();
        if ($row === false) {
            return null;
        }
        $online = $this->onlineUserIds();
        return $this->toChannelDto($row, $this->channelMembers($row['Id'], $online));
    }

    public function addMember(string $organisationId, string $callerUserId, bool $callerIsOrgAdmin, string $channelId, string $targetUserId): bool
    {
        if (!$this->canAccessChannel($channelId, $organisationId, $callerUserId, $callerIsOrgAdmin)) {
            return false;
        }

        $stmt = $this->db->prepare('SELECT 1 FROM "Users" WHERE "Id" = :uid AND "OrganisationId" = :orgId');
        $stmt->execute(['uid' => $targetUserId, 'orgId' => $organisationId]);
        if ($stmt->fetch() === false) {
            return false;
        }

        $stmt = $this->db->prepare('SELECT 1 FROM "ChatChannelMembers" WHERE "ChannelId" = :cid AND "UserId" = :uid');
        $stmt->execute(['cid' => $channelId, 'uid' => $targetUserId]);
        if ($stmt->fetch() !== false) {
            return true;
        }

        $this->db->prepare('INSERT INTO "ChatChannelMembers" ("Id", "ChannelId", "UserId", "DateJoined") VALUES (:id, :cid, :uid, :dj)')
            ->execute(['id' => Uuid::v4(), 'cid' => $channelId, 'uid' => $targetUserId, 'dj' => gmdate('Y-m-d\TH:i:s\Z')]);
        return true;
    }

    public function removeMember(string $organisationId, string $callerUserId, bool $callerIsOrgAdmin, string $channelId, string $targetUserId): bool
    {
        if ($targetUserId !== $callerUserId && !$this->canAccessChannel($channelId, $organisationId, $callerUserId, $callerIsOrgAdmin)) {
            return false;
        }

        $stmt = $this->db->prepare('DELETE FROM "ChatChannelMembers" WHERE "ChannelId" = :cid AND "UserId" = :uid');
        $stmt->execute(['cid' => $channelId, 'uid' => $targetUserId]);
        return $stmt->rowCount() > 0;
    }

    /** @return string[] */
    public function getChannelMemberUserIds(string $channelId): array
    {
        $stmt = $this->db->prepare('SELECT "UserId" FROM "ChatChannelMembers" WHERE "ChannelId" = :cid');
        $stmt->execute(['cid' => $channelId]);
        return array_column($stmt->fetchAll(), 'UserId');
    }

    // ---- Messages ----

    public function getMessages(string $organisationId, string $callerUserId, bool $callerIsOrgAdmin, string $channelId, ?string $before, int $limit): ?array
    {
        if (!$this->canAccessChannel($channelId, $organisationId, $callerUserId, $callerIsOrgAdmin)) {
            return null;
        }

        $limit = max(1, min(200, $limit));
        $sql = 'SELECT * FROM "ChatMessages" WHERE "ChannelId" = :cid';
        $params = ['cid' => $channelId];
        if ($before !== null) {
            $sql .= ' AND "DateCreated" < :before';
            $params['before'] = $before;
        }
        $sql .= ' ORDER BY "DateCreated" DESC LIMIT :limit';
        $stmt = $this->db->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $page = array_reverse($stmt->fetchAll()); // oldest-first within the page

        $memberNames = $this->channelMemberDisplayNames($channelId);
        $nextCursor = count($page) === $limit ? $page[0]['DateCreated'] : null;
        return [
            'messages' => array_map(fn ($m) => $this->toMessageDto($m, $memberNames), $page),
            'nextCursor' => $nextCursor,
        ];
    }

    public function postMessage(string $organisationId, string $callerUserId, string $callerDisplayName, string $channelId, array $request): ?array
    {
        $memberUserIds = $this->getChannelMemberUserIds($channelId);
        if (!in_array($callerUserId, $memberUserIds, true)) {
            return null;
        }

        $text = trim((string) ($request['text'] ?? ''));
        if ($text === '') {
            throw new ApiValidationException('Message text is required.');
        }

        $messageId = Uuid::v4();
        $dateCreated = gmdate('Y-m-d\TH:i:s\Z');
        $this->db->prepare(
            'INSERT INTO "ChatMessages" ("Id", "ChannelId", "AuthorUserId", "AuthorName", "Text", "DateCreated", "IsDeleted") VALUES (:id, :cid, :aid, :aname, :text, :dc, false)'
        )->execute(['id' => $messageId, 'cid' => $channelId, 'aid' => $callerUserId, 'aname' => $callerDisplayName, 'text' => $text, 'dc' => $dateCreated]);

        $memberNames = $this->channelMemberDisplayNames($channelId);
        $message = ['Id' => $messageId, 'ChannelId' => $channelId, 'AuthorUserId' => $callerUserId, 'AuthorName' => $callerDisplayName, 'Text' => $text, 'DateCreated' => $dateCreated, 'IsDeleted' => false, 'DateDeleted' => null];
        return ['message' => $this->toMessageDto($message, $memberNames), 'channelMemberUserIds' => $memberUserIds];
    }

    public function updateMessage(string $callerUserId, string $channelId, string $messageId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ChatMessages" WHERE "Id" = :id AND "ChannelId" = :cid AND "AuthorUserId" = :aid AND "IsDeleted" = false');
        $stmt->execute(['id' => $messageId, 'cid' => $channelId, 'aid' => $callerUserId]);
        $message = $stmt->fetch();
        if ($message === false) {
            return null;
        }

        $text = trim((string) ($request['text'] ?? ''));
        if ($text === '') {
            throw new ApiValidationException('Message text is required.');
        }

        $this->db->prepare('UPDATE "ChatMessages" SET "Text" = :text WHERE "Id" = :id')->execute(['text' => $text, 'id' => $messageId]);
        $message['Text'] = $text;

        $memberUserIds = $this->getChannelMemberUserIds($channelId);
        $memberNames = $this->channelMemberDisplayNames($channelId);
        return ['message' => $this->toMessageDto($message, $memberNames), 'channelMemberUserIds' => $memberUserIds];
    }

    public function deleteMessage(string $organisationId, string $callerUserId, bool $callerIsOrgAdmin, string $channelId, string $messageId): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "ChatMessages" WHERE "Id" = :id AND "ChannelId" = :cid');
        $stmt->execute(['id' => $messageId, 'cid' => $channelId]);
        $message = $stmt->fetch();
        if ($message === false || (bool) $message['IsDeleted']) {
            return null;
        }

        $isAuthor = $message['AuthorUserId'] === $callerUserId;
        $isAdmin = false;
        if ($callerIsOrgAdmin) {
            $orgStmt = $this->db->prepare('SELECT 1 FROM "ChatChannels" WHERE "Id" = :cid AND "OrganisationId" = :orgId');
            $orgStmt->execute(['cid' => $channelId, 'orgId' => $organisationId]);
            $isAdmin = $orgStmt->fetch() !== false;
        }
        if (!$isAuthor && !$isAdmin) {
            return null;
        }

        $dateDeleted = gmdate('Y-m-d\TH:i:s\Z');
        $this->db->prepare('UPDATE "ChatMessages" SET "IsDeleted" = true, "DateDeleted" = :dd WHERE "Id" = :id')
            ->execute(['dd' => $dateDeleted, 'id' => $messageId]);
        $message['IsDeleted'] = true;
        $message['DateDeleted'] = $dateDeleted;

        $memberUserIds = $this->getChannelMemberUserIds($channelId);
        $memberNames = $this->channelMemberDisplayNames($channelId);
        return ['message' => $this->toMessageDto($message, $memberNames), 'channelMemberUserIds' => $memberUserIds];
    }

    // ---- Truncate (Org-Admin-only, manual — see the "no scheduled job" decision) ----

    public function truncateOldMessages(string $organisationId): array
    {
        $cutoff = gmdate('Y-m-d\TH:i:s\Z', strtotime('-180 days'));
        $stmt = $this->db->prepare(
            'DELETE FROM "ChatMessages" WHERE "DateCreated" < :cutoff AND "ChannelId" IN (SELECT "Id" FROM "ChatChannels" WHERE "OrganisationId" = :orgId)'
        );
        $stmt->execute(['cutoff' => $cutoff, 'orgId' => $organisationId]);
        return ['deletedCount' => $stmt->rowCount(), 'cutoffDate' => $cutoff];
    }

    // ---- Helpers ----

    private function canAccessChannel(string $channelId, string $organisationId, string $callerUserId, bool $callerIsOrgAdmin): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "ChatChannels" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $channelId, 'orgId' => $organisationId]);
        if ($stmt->fetch() === false) {
            return false;
        }
        if ($callerIsOrgAdmin) {
            return true;
        }
        $memberStmt = $this->db->prepare('SELECT 1 FROM "ChatChannelMembers" WHERE "ChannelId" = :cid AND "UserId" = :uid');
        $memberStmt->execute(['cid' => $channelId, 'uid' => $callerUserId]);
        return $memberStmt->fetch() !== false;
    }

    /** @return array<string, string> UserId => DisplayName */
    private function channelMemberDisplayNames(string $channelId): array
    {
        $stmt = $this->db->prepare('SELECT m."UserId", u."DisplayName" FROM "ChatChannelMembers" m JOIN "Users" u ON u."Id" = m."UserId" WHERE m."ChannelId" = :cid');
        $stmt->execute(['cid' => $channelId]);
        $result = [];
        foreach ($stmt->fetchAll() as $row) {
            $result[$row['UserId']] = $row['DisplayName'];
        }
        return $result;
    }

    /** @param string[] $onlineUserIds @return array<int, array{userId: string, displayName: string, isOnline: bool}> */
    private function channelMembers(string $channelId, array $onlineUserIds): array
    {
        $names = $this->channelMemberDisplayNames($channelId);
        $result = [];
        foreach ($names as $userId => $displayName) {
            $result[] = ['userId' => $userId, 'displayName' => $displayName, 'isOnline' => in_array($userId, $onlineUserIds, true)];
        }
        return $result;
    }

    /**
     * Scans message text for "@FullDisplayName" occurrences against the channel's current member
     * roster — no separate mention-storage table, derived fresh every time (same philosophy as
     * features/hashtags.js's tag scanning on the frontend). Longest-name-first so "@Andrew Rigney"
     * isn't short-circuited by a member literally named "Andrew".
     *
     * @param array<string, string> $memberDisplayNames
     * @return string[]
     */
    private function parseMentions(string $text, array $memberDisplayNames): array
    {
        $entries = $memberDisplayNames;
        uasort($entries, fn ($a, $b) => mb_strlen($b) <=> mb_strlen($a));

        $mentioned = [];
        foreach ($entries as $userId => $displayName) {
            if (trim($displayName) === '') {
                continue;
            }
            if (mb_stripos($text, '@' . $displayName) !== false) {
                $mentioned[] = $userId;
            }
        }
        return $mentioned;
    }

    /** @param array<string, string> $memberDisplayNames */
    private function toMessageDto(array $m, array $memberDisplayNames): array
    {
        return [
            'id' => $m['Id'], 'channelId' => $m['ChannelId'], 'authorUserId' => $m['AuthorUserId'],
            'authorName' => $m['AuthorName'], 'text' => $m['Text'], 'dateCreated' => $m['DateCreated'],
            'isDeleted' => (bool) $m['IsDeleted'], 'dateDeleted' => $m['DateDeleted'] ?? null,
            'mentionedUserIds' => $this->parseMentions($m['Text'], $memberDisplayNames),
        ];
    }

    /** @param array<int, array{userId: string, displayName: string, isOnline: bool}> $members */
    private function toChannelDto(array $c, array $members): array
    {
        return [
            'id' => $c['Id'], 'name' => $c['Name'], 'isDirectMessage' => (bool) $c['IsDirectMessage'],
            'dateCreated' => $c['DateCreated'], 'members' => $members,
        ];
    }
}
