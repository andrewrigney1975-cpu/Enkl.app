<?php

declare(strict_types=1);

namespace Enkl\Api\Support;

/**
 * A minimal RFC 4122 v4 UUID generator using PHP's CSPRNG (random_bytes) — deliberately not an extra
 * Composer dependency for something this small. Every entity id in this API is generated application-
 * side (matching the .NET side's explicit Guid.NewGuid() calls, needed so e.g. MigrationService can
 * build old-id -> new-id maps before relational rows referencing them exist) rather than left to
 * Postgres's gen_random_uuid() default.
 */
final class Uuid
{
    public static function v4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40); // version 4
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80); // variant 10xx

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
