<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

/**
 * Ported from Services/ProjectSettingsSerializer.cs. Defaults mirror normalizeHeaderButtonVisibility
 * (src/js/storage.js) exactly: every field is opt-out (defaults true) except workflow and
 * changeAuditing, which are opt-in (default false). Keys are camelCase to match both the frontend's
 * own field names and the "changeAuditing" key TaskService::isChangeAuditingEnabled reads from this
 * same column.
 *
 * @phpstan-type ProjectSettings array{documents:bool,risks:bool,decisions:bool,health:bool,principles:bool,objectives:bool,teamsCommittees:bool,workflow:bool,timeTracking:bool,changeAuditing:bool,subTasks:bool}
 */
final class ProjectSettingsSerializer
{
    private const DEFAULTS = [
        'documents' => true,
        'risks' => true,
        'decisions' => true,
        'health' => true,
        'principles' => true,
        'objectives' => true,
        'teamsCommittees' => true,
        'workflow' => false,
        'timeTracking' => true,
        'changeAuditing' => false,
        'subTasks' => true,
    ];

    public static function serialize(array $settings): string
    {
        $result = [];
        foreach (self::DEFAULTS as $key => $default) {
            $result[$key] = (bool) ($settings[$key] ?? $default);
        }
        return json_encode($result);
    }

    /** @return ProjectSettings */
    public static function parse(?string $json): array
    {
        $decoded = [];
        if ($json !== null && $json !== '') {
            $tmp = json_decode($json, true);
            if (is_array($tmp)) {
                $decoded = $tmp;
            }
        }

        $result = [];
        foreach (self::DEFAULTS as $key => $default) {
            $value = $decoded[$key] ?? null;
            $result[$key] = is_bool($value) ? $value : $default;
        }
        return $result;
    }
}
