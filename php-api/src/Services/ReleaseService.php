<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/ReleaseService.cs. */
final class ReleaseService
{
    private const VALID_STATUSES = ['pending', 'in_progress', 'deployed'];

    public function __construct(private readonly PDO $db)
    {
    }

    public function create(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $id = Uuid::v4();
        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'pending';
        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "Releases" ("Id", "ProjectId", "Name", "Status", "OwnerId", "StartDate", "EndDate", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :name, :status, :ownerId, :start, :end, now(), now())
        SQL);
        $stmt->execute([
            'id' => $id, 'pid' => $projectId, 'name' => $request['name'] ?? '', 'status' => $status,
            'ownerId' => $request['ownerId'] ?? null, 'start' => $request['startDate'] ?? null, 'end' => $request['endDate'] ?? null,
        ]);

        return ['id' => $id, 'name' => $request['name'] ?? '', 'status' => $status, 'ownerId' => $request['ownerId'] ?? null, 'startDate' => $request['startDate'] ?? null, 'endDate' => $request['endDate'] ?? null];
    }

    public function update(string $projectId, string $releaseId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Releases" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $releaseId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $status = in_array($request['status'] ?? null, self::VALID_STATUSES, true) ? $request['status'] : 'pending';
        $stmt = $this->db->prepare(<<<SQL
            UPDATE "Releases" SET "Name" = :name, "Status" = :status, "OwnerId" = :ownerId,
                "StartDate" = :start, "EndDate" = :end, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL);
        $stmt->execute([
            'name' => $request['name'] ?? '', 'status' => $status, 'ownerId' => $request['ownerId'] ?? null,
            'start' => $request['startDate'] ?? null, 'end' => $request['endDate'] ?? null, 'id' => $releaseId,
        ]);

        return ['id' => $releaseId, 'name' => $request['name'] ?? '', 'status' => $status, 'ownerId' => $request['ownerId'] ?? null, 'startDate' => $request['startDate'] ?? null, 'endDate' => $request['endDate'] ?? null];
    }

    public function delete(string $projectId, string $releaseId): bool
    {
        // Tasks.ReleaseId is already SetNull, so removing the row is enough — no explicit unassign
        // loop needed, mirrors mutations.js's deleteRelease.
        $stmt = $this->db->prepare('DELETE FROM "Releases" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $releaseId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }
}
