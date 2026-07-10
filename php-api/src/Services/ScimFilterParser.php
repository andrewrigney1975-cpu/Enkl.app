<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

/**
 * Ported from Services/ScimFilterParser.cs. Shared by ScimUserService and ScimGroupService's list
 * filtering — both only need to recognize the single-clause `attr eq "value"` shape (the common
 * case every IdP sends for a targeted lookup); anything else falls through to each service's own
 * "no matches" fallback rather than a hard 400.
 */
final class ScimFilterParser
{
    /** @return array{0: ?string, 1: ?string} [attr, value] */
    public static function parseEq(string $filter): array
    {
        if (preg_match('/^(?<attr>[\w.]+)\s+eq\s+"(?<value>[^"]*)"$/i', trim($filter), $m) === 1) {
            return [strtolower($m['attr']), $m['value']];
        }
        return [null, null];
    }
}
