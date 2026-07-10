<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/PrincipleService.cs. */
final class PrincipleService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function create(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key']);
        $this->db->prepare(<<<SQL
            INSERT INTO "Principles" ("Id", "ProjectId", "Key", "Title", "Description", "DocumentUrl", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :description, :docUrl, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'key' => $key,
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'docUrl' => $request['documentUrl'] ?? null,
        ]);

        return ['id' => $id, 'key' => $key, 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'documentUrl' => $request['documentUrl'] ?? null];
    }

    public function update(string $projectId, string $principleId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key" FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $principleId, 'pid' => $projectId]);
        $existing = $stmt->fetch();
        if ($existing === false) {
            return null;
        }

        $this->db->prepare('UPDATE "Principles" SET "Title" = :title, "Description" = :description, "DocumentUrl" = :docUrl, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'docUrl' => $request['documentUrl'] ?? null, 'id' => $principleId]);

        return ['id' => $principleId, 'key' => $existing['Key'], 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'documentUrl' => $request['documentUrl'] ?? null];
    }

    public function delete(string $projectId, string $principleId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $principleId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Principles" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $count = (int) $stmt->fetchColumn();
        return sprintf('%s-PRIN-%03d', $projectKey, $count + 1);
    }
}
