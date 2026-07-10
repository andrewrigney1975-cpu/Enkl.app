<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\FieldClamps;
use PDO;

/** Ported from Services/TaskTypeService.cs. */
final class TaskTypeService
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
        $iconName = FieldClamps::validIconNameOrNull($request['iconName'] ?? null);
        $this->db->prepare('INSERT INTO "TaskTypes" ("Id", "ProjectId", "Name", "IconName") VALUES (:id, :pid, :name, :icon)')
            ->execute(['id' => $id, 'pid' => $projectId, 'name' => $request['name'] ?? '', 'icon' => $iconName]);

        return ['id' => $id, 'name' => $request['name'] ?? '', 'iconName' => $iconName];
    }

    public function update(string $projectId, string $typeId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "TaskTypes" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $typeId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $iconName = FieldClamps::validIconNameOrNull($request['iconName'] ?? null);
        $this->db->prepare('UPDATE "TaskTypes" SET "Name" = :name, "IconName" = :icon WHERE "Id" = :id')
            ->execute(['name' => $request['name'] ?? '', 'icon' => $iconName, 'id' => $typeId]);

        return ['id' => $typeId, 'name' => $request['name'] ?? '', 'iconName' => $iconName];
    }

    public function delete(string $projectId, string $typeId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "TaskTypes" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $typeId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }
}
