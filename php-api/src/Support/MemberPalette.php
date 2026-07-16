<?php

declare(strict_types=1);

namespace Enkl\Api\Support;

/**
 * ARCHITECTURE-REVIEW.md finding 3.3: the member-color palette used to be defined identically in
 * three separate places (MemberService::MEMBER_PALETTE, TeamCommitteeService::MEMBER_PALETTE, and a
 * hardcoded literal in ProjectService::FIRST_MEMBER_COLOR), each carrying a comment reminding the
 * reader to keep it in sync with src/js/config.js's own MEMBER_PALETTE — four copies of the same
 * constant across two languages, enforced only by comment discipline. One shared source here for
 * every PHP-side call site; still must be kept in sync with src/js/config.js by hand (no cross-
 * language enforcement exists, same as every other duplicated-by-necessity constant in this port).
 */
final class MemberPalette
{
    public const COLORS = [
        '#0052CC', '#00875A', '#FF8B00', '#974DE2', '#DE350B',
        '#006644', '#5243AA', '#B04632', '#1B5E20', '#8777D9',
    ];

    public static function colorForIndex(int $memberCount): string
    {
        return self::COLORS[$memberCount % count(self::COLORS)];
    }
}
