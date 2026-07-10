<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

/**
 * Ported from Enkl.Api.Domain.UsernameNormalizer (.NET) — must produce byte-identical output to that
 * version, since both API tiers can share the same Users table and a normalized username computed
 * differently by each would let the same person register/collide differently depending on which
 * tier handled the request.
 */
final class UsernameNormalizer
{
    public static function normalize(string $name): string
    {
        $lower = mb_strtolower(trim($name));
        return preg_replace('/[^a-z0-9]/u', '', $lower) ?? '';
    }
}
