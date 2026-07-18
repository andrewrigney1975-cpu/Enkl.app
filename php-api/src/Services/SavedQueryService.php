<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/SavedQueryService.cs. */
final class SavedQueryService
{
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
        $this->db->prepare(<<<SQL
            INSERT INTO "SavedQueries" ("Id", "ProjectId", "Name", "Sql", "DateCreated", "ExposeViaApi")
            VALUES (:id, :pid, :name, :sql, now(), :exposeViaApi)
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'name' => $request['name'] ?? '', 'sql' => $request['sql'] ?? '',
            'exposeViaApi' => (int) ($request['exposeViaApi'] ?? false),
        ]);

        return $this->toDto($id);
    }

    public function update(string $projectId, string $queryId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "SavedQueries" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $queryId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $this->db->prepare(<<<SQL
            UPDATE "SavedQueries" SET "Name" = :name, "Sql" = :sql, "ExposeViaApi" = :exposeViaApi WHERE "Id" = :id
        SQL)->execute([
            'name' => $request['name'] ?? '', 'sql' => $request['sql'] ?? '', 'id' => $queryId,
            'exposeViaApi' => (int) ($request['exposeViaApi'] ?? false),
        ]);

        return $this->toDto($queryId);
    }

    /** Raw Sql text for the "Test API" button (Controllers/SavedQueriesController.php::test) — the
     * saved-query CRUD DTO (toDto()) already returns Sql too, but this is a dedicated, minimal
     * existence+ownership check rather than pulling the whole DTO shape through for one field. */
    public function getSql(string $projectId, string $queryId): ?string
    {
        $stmt = $this->db->prepare('SELECT "Sql" FROM "SavedQueries" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $queryId, 'pid' => $projectId]);
        $sql = $stmt->fetchColumn();
        return $sql === false ? null : $sql;
    }

    public function delete(string $projectId, string $queryId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "SavedQueries" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $queryId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    private function toDto(string $queryId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "SavedQueries" WHERE "Id" = :id');
        $stmt->execute(['id' => $queryId]);
        $q = $stmt->fetch();

        return [
            'id' => $q['Id'], 'name' => $q['Name'], 'sql' => $q['Sql'], 'dateCreated' => $q['DateCreated'],
            'exposeViaApi' => (bool) $q['ExposeViaApi'],
        ];
    }
}
