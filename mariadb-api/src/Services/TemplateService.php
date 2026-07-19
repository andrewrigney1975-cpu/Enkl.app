<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/TemplateService.cs. Project Templates are owned by the Organisation, not any
 * one Project — every signed-in member of an org can list/create one (see TemplatesController's
 * gating), matching the trust level of creating a column or task type today. Renaming/deleting a
 * shared org asset requires OrgAdmin, the same bar as OrganisationService's user-management actions.
 */
final class TemplateService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function list(string $organisationId): array
    {
        $stmt = $this->db->prepare(
            'SELECT "Id", "Name", "CreatedAt" FROM "ProjectTemplates" WHERE "OrganisationId" = :orgId ORDER BY "Name"'
        );
        $stmt->execute(['orgId' => $organisationId]);
        return array_map(static fn(array $t): array => [
            'id' => $t['Id'], 'name' => $t['Name'], 'createdAt' => $t['CreatedAt'],
        ], $stmt->fetchAll());
    }

    public function getDetail(string $organisationId, string $templateId): ?array
    {
        $template = $this->findOwned($organisationId, $templateId);
        return $template === null ? null : $this->toDetailDto($template);
    }

    public function create(string $organisationId, array $request): array
    {
        $name = trim((string) ($request['name'] ?? ''));
        if ($name === '') {
            throw new ApiValidationException('Please enter a template name.');
        }
        $name = mb_substr($name, 0, 200);

        $templateId = Uuid::v4();
        $columnsJson = json_encode($request['columns'] ?? []);
        $taskTypesJson = json_encode($request['taskTypes'] ?? []);
        $workflow = $request['workflow'] ?? null;
        $workflowJson = $workflow !== null ? json_encode($workflow) : null;
        $settingsJson = ProjectSettingsSerializer::serialize(ProjectSettingsSerializer::parse(json_encode($request['settings'] ?? [])));

        $stmt = $this->db->prepare(<<<SQL
            INSERT INTO "ProjectTemplates"
                ("Id", "OrganisationId", "Name", "ColumnsJson", "TaskTypesJson", "WorkflowJson", "SettingsJson", "CreatedAt", "DateLastModified")
            VALUES (:id, :orgId, :name, :columns, :taskTypes, :workflow, :settings, now(), now())
        SQL);
        $stmt->execute([
            'id' => $templateId,
            'orgId' => $organisationId,
            'name' => $name,
            'columns' => $columnsJson,
            'taskTypes' => $taskTypesJson,
            'workflow' => $workflowJson,
            'settings' => $settingsJson,
        ]);

        $stmt = $this->db->prepare('SELECT "CreatedAt" FROM "ProjectTemplates" WHERE "Id" = :id');
        $stmt->execute(['id' => $templateId]);
        $createdAt = $stmt->fetchColumn();

        return ['id' => $templateId, 'name' => $name, 'createdAt' => $createdAt];
    }

    /** Returns false if the template doesn't exist or belongs to a different Organisation than the caller. */
    public function rename(string $organisationId, string $templateId, string $name): bool
    {
        if ($this->findOwned($organisationId, $templateId) === null) {
            return false;
        }

        $trimmed = trim($name);
        if ($trimmed === '') {
            throw new ApiValidationException('Please enter a template name.');
        }

        $stmt = $this->db->prepare(
            'UPDATE "ProjectTemplates" SET "Name" = :name, "DateLastModified" = now() WHERE "Id" = :id'
        );
        $stmt->execute(['name' => mb_substr($trimmed, 0, 200), 'id' => $templateId]);
        return true;
    }

    public function delete(string $organisationId, string $templateId): bool
    {
        if ($this->findOwned($organisationId, $templateId) === null) {
            return false;
        }

        $stmt = $this->db->prepare('DELETE FROM "ProjectTemplates" WHERE "Id" = :id');
        $stmt->execute(['id' => $templateId]);
        return true;
    }

    private function findOwned(string $organisationId, string $templateId): array|null
    {
        $stmt = $this->db->prepare('SELECT * FROM "ProjectTemplates" WHERE "Id" = :id AND "OrganisationId" = :orgId');
        $stmt->execute(['id' => $templateId, 'orgId' => $organisationId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    private function toDetailDto(array $t): array
    {
        return [
            'id' => $t['Id'],
            'name' => $t['Name'],
            'columns' => json_decode($t['ColumnsJson'], true) ?? [],
            'taskTypes' => json_decode($t['TaskTypesJson'], true) ?? [],
            'workflow' => $t['WorkflowJson'] !== null ? json_decode($t['WorkflowJson']) : null,
            'settings' => ProjectSettingsSerializer::parse($t['SettingsJson']),
            'createdAt' => $t['CreatedAt'],
        ];
    }
}
