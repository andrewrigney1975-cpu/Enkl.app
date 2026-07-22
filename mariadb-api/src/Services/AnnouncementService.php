<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\SqlDateTime;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from php-api's Services/AnnouncementService.php (itself ported from
 * Services/AnnouncementService.cs). Org-Admin CRUD is always Scope="org" +
 * OrganisationId/CreatedByUserId re-derived from the caller's own JWT claims (never client-supplied)
 * — same cross-org-isolation discipline as PortfolioService. Vendor-authored rows (Scope="orgs"/
 * "platform", CreatedByVendor=true) are written directly by the standalone Vendor Portal via raw SQL
 * against this same table — this service only ever produces/manages Scope="org" rows, it has no
 * vendor-authoring path of its own.
 *
 * MariaDB-specific divergences from the Postgres tier (see mariadb-api/CLAUDE.md §4): client-supplied
 * StartAt/EndAt are reformatted via SqlDateTime::reformat() before binding (§4.6 — raw ISO-8601 with
 * "T"/"Z" is rejected by DATETIME columns here), and CreatedByVendor is cast (bool) on read (§4.8 —
 * PDO_MYSQL returns TINYINT(1) as a plain int, never a real bool).
 */
final class AnnouncementService
{
    public function __construct(private readonly PDO $db)
    {
    }

    // ---- Org-Admin management (Scope="org" only) ----

    public function listForOrg(string $organisationId): array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT "Id", "Scope", "Title", "Body", "Kind", "StartAt", "EndAt", "CreatedByVendor", "DateCreated"
            FROM "Announcements" WHERE "OrganisationId" = :orgId ORDER BY "DateCreated" DESC
        SQL);
        $stmt->execute(['orgId' => $organisationId]);
        return array_map([$this, 'mapRow'], $stmt->fetchAll());
    }

    public function create(string $organisationId, string $callerUserId, array $request): array
    {
        $title = trim((string) ($request['title'] ?? ''));
        if ($title === '') {
            throw new ApiValidationException('Title is required.');
        }
        $kind = $this->normalizeKind($request['kind'] ?? null);
        $id = Uuid::v4();
        $now = SqlDateTime::now();

        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Announcements"
                ("Id", "Scope", "OrganisationId", "Title", "Body", "Kind", "StartAt", "EndAt",
                 "CreatedByUserId", "CreatedByVendor", "DateCreated", "DateLastModified")
            VALUES (:id, 'org', :orgId, :title, :body, :kind, :startAt, :endAt, :userId, 0, :now1, :now2)
        SQL);
        $stmt->execute([
            'id' => $id, 'orgId' => $organisationId, 'title' => $title,
            'body' => trim((string) ($request['body'] ?? '')), 'kind' => $kind,
            'startAt' => $this->reformatRequired($request['startAt'] ?? null),
            'endAt' => $this->reformatOptional($request['endAt'] ?? null),
            'userId' => $callerUserId, 'now1' => $now, 'now2' => $now,
        ]);

        return $this->find($id, $organisationId);
    }

    public function update(string $organisationId, string $announcementId, array $request): ?array
    {
        $existing = $this->find($announcementId, $organisationId);
        if ($existing === null) {
            return null;
        }

        $title = trim((string) ($request['title'] ?? ''));
        if ($title === '') {
            throw new ApiValidationException('Title is required.');
        }
        $kind = $this->normalizeKind($request['kind'] ?? null);

        $stmt = $this->db->prepare(<<<SQL
            UPDATE "Announcements"
            SET "Title" = :title, "Body" = :body, "Kind" = :kind, "StartAt" = :startAt, "EndAt" = :endAt, "DateLastModified" = :now
            WHERE "Id" = :id AND "OrganisationId" = :orgId
        SQL);
        $stmt->execute([
            'title' => $title, 'body' => trim((string) ($request['body'] ?? '')), 'kind' => $kind,
            'startAt' => $this->reformatRequired($request['startAt'] ?? null),
            'endAt' => $this->reformatOptional($request['endAt'] ?? null),
            'now' => SqlDateTime::now(),
            'id' => $announcementId, 'orgId' => $organisationId,
        ]);

        return $this->find($announcementId, $organisationId);
    }

    public function delete(string $organisationId, string $announcementId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Announcements" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $announcementId, 'orgId' => $organisationId]);
        return $stmt->rowCount() > 0;
    }

    // ---- Any signed-in user: what's currently active and relevant to them ----

    /** Resolves all three Scope shapes at once (own-org, targeted-org-list, platform-wide), filtered
     * to the active window (StartAt already passed, EndAt not yet passed or absent), tagged with
     * whether THIS caller has already acknowledged it. Never trusts a client-supplied org id —
     * $organisationId here is always the caller's own, from their JWT claim. */
    public function getActiveForUser(string $organisationId, string $callerUserId): array
    {
        $now = SqlDateTime::now();
        $stmt = $this->db->prepare(<<<SQL
            SELECT DISTINCT a."Id", a."Title", a."Body", a."Kind", a."StartAt", a."EndAt"
            FROM "Announcements" a
            LEFT JOIN "AnnouncementOrganisations" ao ON ao."AnnouncementId" = a."Id" AND ao."OrganisationId" = :orgId1
            WHERE a."StartAt" <= :now1 AND (a."EndAt" IS NULL OR a."EndAt" >= :now2)
              AND (a."Scope" = 'platform'
                   OR (a."Scope" = 'org' AND a."OrganisationId" = :orgId2)
                   OR (a."Scope" = 'orgs' AND ao."Id" IS NOT NULL))
            ORDER BY a."StartAt" DESC
        SQL);
        $stmt->execute(['orgId1' => $organisationId, 'now1' => $now, 'now2' => $now, 'orgId2' => $organisationId]);
        $rows = $stmt->fetchAll();
        if ($rows === []) {
            return [];
        }

        $ids = array_column($rows, 'Id');
        $placeholders = implode(',', array_map(static fn(int $i): string => ":id{$i}", array_keys($ids)));
        $ackStmt = $this->db->prepare(<<<SQL
            SELECT "AnnouncementId" FROM "AnnouncementAcknowledgements"
            WHERE "UserId" = :userId AND "AnnouncementId" IN ({$placeholders})
        SQL);
        $params = ['userId' => $callerUserId];
        foreach ($ids as $i => $id) {
            $params["id{$i}"] = $id;
        }
        $ackStmt->execute($params);
        $acknowledged = array_flip(array_column($ackStmt->fetchAll(), 'AnnouncementId'));

        return array_map(static fn(array $a): array => [
            'id' => $a['Id'], 'title' => $a['Title'], 'body' => $a['Body'], 'kind' => $a['Kind'],
            'startAt' => $a['StartAt'], 'endAt' => $a['EndAt'],
            'acknowledged' => isset($acknowledged[$a['Id']]),
        ], $rows);
    }

    /** Idempotent — calling this twice for the same (announcement, user) pair is a no-op the second
     * time, matching the unique index on AnnouncementAcknowledgements. */
    public function acknowledge(string $callerUserId, string $announcementId): void
    {
        $existsStmt = $this->db->prepare('SELECT 1 FROM "AnnouncementAcknowledgements" WHERE "AnnouncementId" = :id AND "UserId" = :userId');
        $existsStmt->execute(['id' => $announcementId, 'userId' => $callerUserId]);
        if ($existsStmt->fetch() !== false) {
            return;
        }

        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "AnnouncementAcknowledgements" ("Id", "AnnouncementId", "UserId", "AcknowledgedAt")
            VALUES (:id, :announcementId, :userId, :now)
        SQL);
        $stmt->execute([
            'id' => Uuid::v4(), 'announcementId' => $announcementId, 'userId' => $callerUserId,
            'now' => SqlDateTime::now(),
        ]);
    }

    private function find(string $announcementId, string $organisationId): ?array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT "Id", "Scope", "Title", "Body", "Kind", "StartAt", "EndAt", "CreatedByVendor", "DateCreated"
            FROM "Announcements" WHERE "Id" = :id AND "OrganisationId" = :orgId
        SQL);
        $stmt->execute(['id' => $announcementId, 'orgId' => $organisationId]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->mapRow($row);
    }

    private function mapRow(array $a): array
    {
        return [
            'id' => $a['Id'], 'scope' => $a['Scope'], 'title' => $a['Title'], 'body' => $a['Body'],
            'kind' => $a['Kind'], 'startAt' => $a['StartAt'], 'endAt' => $a['EndAt'],
            'createdByVendor' => (bool) $a['CreatedByVendor'], 'dateCreated' => $a['DateCreated'],
        ];
    }

    private function normalizeKind(?string $kind): string
    {
        return $kind === 'disruption' ? 'disruption' : 'announcement';
    }

    private function reformatRequired(mixed $value): string
    {
        if (!is_string($value) || $value === '' || strtotime($value) === false) {
            throw new ApiValidationException('A valid start date/time is required.');
        }
        return SqlDateTime::reformat($value);
    }

    private function reformatOptional(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || strtotime($value) === false) {
            throw new ApiValidationException('End date/time is invalid.');
        }
        return SqlDateTime::reformat($value);
    }
}
