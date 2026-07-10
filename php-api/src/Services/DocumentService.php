<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/DocumentService.cs. */
final class DocumentService
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
            INSERT INTO "Documents" ("Id", "ProjectId", "Key", "Title", "Url", "Description", "OwnerId", "TaskId", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :key, :title, :url, :description, :ownerId, :taskId, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'key' => $key,
            'title' => $request['title'] ?? '', 'url' => $request['url'] ?? null, 'description' => $request['description'] ?? null,
            'ownerId' => $request['ownerId'] ?? null, 'taskId' => $request['taskId'] ?? null,
        ]);

        $this->setRelatedDocuments($projectId, $id, $request['relatedDocumentIds'] ?? []);
        return $this->toDto($id);
    }

    public function update(string $projectId, string $documentId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Documents" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $documentId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $this->db->prepare(<<<SQL
            UPDATE "Documents" SET "Title" = :title, "Url" = :url, "Description" = :description,
                "OwnerId" = :ownerId, "TaskId" = :taskId, "DateLastModified" = now()
            WHERE "Id" = :id
        SQL)->execute([
            'title' => $request['title'] ?? '', 'url' => $request['url'] ?? null, 'description' => $request['description'] ?? null,
            'ownerId' => $request['ownerId'] ?? null, 'taskId' => $request['taskId'] ?? null, 'id' => $documentId,
        ]);

        $this->db->prepare('DELETE FROM "DocumentRelation" WHERE "DocumentId" = :id')->execute(['id' => $documentId]);
        $this->setRelatedDocuments($projectId, $documentId, $request['relatedDocumentIds'] ?? []);

        return $this->toDto($documentId);
    }

    public function delete(string $projectId, string $documentId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Documents" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $documentId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    /** A document can never relate to itself — filtered here too, not just client-side. */
    private function setRelatedDocuments(string $projectId, string $documentId, array $relatedIds): void
    {
        $checkStmt = $this->db->prepare('SELECT 1 FROM "Documents" WHERE "Id" = :id AND "ProjectId" = :pid');
        $insertStmt = $this->db->prepare('INSERT INTO "DocumentRelation" ("DocumentId", "RelatedDocumentId") VALUES (:did, :rid)');
        foreach (array_unique($relatedIds) as $relatedId) {
            if ($relatedId === $documentId) {
                continue;
            }
            $checkStmt->execute(['id' => $relatedId, 'pid' => $projectId]);
            if ($checkStmt->fetch() !== false) {
                $insertStmt->execute(['did' => $documentId, 'rid' => $relatedId]);
            }
        }
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Documents" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return sprintf('%s-DOC-%03d', $projectKey, (int) $stmt->fetchColumn() + 1);
    }

    private function toDto(string $documentId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Documents" WHERE "Id" = :id');
        $stmt->execute(['id' => $documentId]);
        $d = $stmt->fetch();

        $relStmt = $this->db->prepare('SELECT "RelatedDocumentId" FROM "DocumentRelation" WHERE "DocumentId" = :id');
        $relStmt->execute(['id' => $documentId]);

        return [
            'id' => $d['Id'], 'key' => $d['Key'], 'title' => $d['Title'], 'url' => $d['Url'], 'description' => $d['Description'],
            'ownerId' => $d['OwnerId'], 'taskId' => $d['TaskId'], 'relatedDocumentIds' => $relStmt->fetchAll(PDO::FETCH_COLUMN),
        ];
    }
}
