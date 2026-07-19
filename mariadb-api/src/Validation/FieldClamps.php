<?php

declare(strict_types=1);

namespace Enkl\Api\Validation;

/**
 * Ported from Validation/FieldClamps.cs — a TaskType's IconName must be one of these or null, same
 * rule storage.js's isValidTaskTypeIconName enforces client-side (TASK_TYPE_ICON_LIBRARY, src/js/utils.js).
 */
final class FieldClamps
{
    /** @var string[] */
    private const TASK_TYPE_ICON_NAMES = [
        'sparkle', 'bug', 'ty_investigate', 'ty_document', 'ty_analyse', 'ty_procure', 'ty_audit',
        'ty_report', 'ty_communicate', 'ty_design', 'ty_develop', 'ty_test', 'ty_review', 'ty_plan',
        'ty_research', 'ty_train', 'ty_support', 'ty_deploy', 'ty_migrate', 'ty_configure',
        'ty_monitor', 'ty_approve', 'ty_negotiate', 'ty_schedule', 'ty_maintain', 'ty_coordinate',
    ];

    public static function validIconNameOrNull(?string $name): ?string
    {
        return $name !== null && in_array($name, self::TASK_TYPE_ICON_NAMES, true) ? $name : null;
    }
}
