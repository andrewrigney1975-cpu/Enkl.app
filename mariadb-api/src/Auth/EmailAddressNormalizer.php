<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

/**
 * Ported from Enkl.Api.Domain.EmailAddressNormalizer (.NET) — must produce byte-identical output to
 * that version for the same reason UsernameNormalizer.php does: both API tiers share the same Users
 * table, and a normalized email computed differently by each would let the same address collide (or
 * not) differently depending on which tier handled the request.
 */
final class EmailAddressNormalizer
{
    public static function normalize(string $email): string
    {
        return mb_strtolower(trim($email));
    }

    public static function isValidFormat(string $email): bool
    {
        return preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/u', $email) === 1;
    }
}
