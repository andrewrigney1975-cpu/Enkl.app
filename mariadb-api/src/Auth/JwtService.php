<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use DateTimeImmutable;
use Enkl\Api\Config\Config;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use stdClass;

/**
 * Ported from Auth/JwtTokenService.cs. Claim names/shapes must match byte-for-byte with the .NET
 * side's output — a token minted by either API tier is meant to validate against the other when both
 * point at the same database (see the parity-testing note in the build plan), and the frontend's own
 * client-side claim reading (api.js's decodeTokenPayload/isOrgAdmin) depends on this exact shape too:
 *   sub          user id
 *   username     login username
 *   displayName  display name
 *   orgId        organisation id
 *   orgName      organisation display name (display-only, e.g. the header logo — never used for auth)
 *   orgAdmin     the STRING "true"/"false" (not a JSON bool — see the .NET comment this mirrors)
 *   securityStamp the live User.SecurityStamp value at mint time (security review finding H2) —
 *                 re-checked against the DB on every authenticated request (SecurityStampMiddleware)
 *                 so password/role/deactivation changes invalidate already-issued tokens
 *   projects     a JSON-encoded STRING (double-encoded) of
 *                [{"ProjectId":"...","Role":null,"IsProjectAdmin":false}, ...], deliberately
 *                PascalCase inside to match System.Text.Json.Serialize's default output for the C#
 *                ProjectClaim record (no camelCase policy applied to that call site). IsProjectAdmin
 *                is display-only client-side (api.js's isProjectAdmin()) — the server always
 *                re-checks a live ProjectMembers row (Auth/ProjectAdminMiddleware.php) for
 *                authorization itself, never this claim.
 */
final class JwtService
{
    /**
     * @param array{Id:string,Username:string,DisplayName:string,OrganisationId:string,OrganisationName:string,IsOrgAdmin:bool,SecurityStamp:string} $user
     * @param array<array{ProjectId:string,Role:?string,IsProjectAdmin:bool}> $memberships
     * @return array{token:string, expiresAt:string} expiresAt as an ISO-8601 UTC string, matching how
     *   the .NET DateTime gets JSON-serialized in LoginResponse/CreateProjectResponseDto
     */
    public static function generateToken(array $user, array $memberships): array
    {
        $expiryHours = (float) Config::get('JWT_EXPIRY_HOURS', '8');
        $now = new DateTimeImmutable('now');
        $expiresAt = $now->modify('+' . (int) round($expiryHours * 3600) . ' seconds');

        $projectsClaim = json_encode(array_map(
            static fn(array $m): array => ['ProjectId' => $m['ProjectId'], 'Role' => $m['Role'], 'IsProjectAdmin' => (bool) $m['IsProjectAdmin']],
            $memberships
        ));

        $payload = [
            'sub' => $user['Id'],
            'username' => $user['Username'],
            'displayName' => $user['DisplayName'],
            'orgId' => $user['OrganisationId'],
            // Display-only (the header logo shows "<app title> - <org name>" once logged in — see
            // api.js's getOrgName()); never used for authorization.
            'orgName' => $user['OrganisationName'],
            'orgAdmin' => $user['IsOrgAdmin'] ? 'true' : 'false',
            'securityStamp' => $user['SecurityStamp'],
            'projects' => $projectsClaim,
            'iat' => $now->getTimestamp(),
            'exp' => $expiresAt->getTimestamp(),
            'iss' => Config::get('JWT_ISSUER', 'Enkl.Api'),
            'aud' => Config::get('JWT_AUDIENCE', 'Enkl.App'),
        ];

        $token = JWT::encode($payload, self::signingKey(), 'HS256');

        return [
            'token' => $token,
            'expiresAt' => $expiresAt->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }

    /** Returns the decoded claims object, or null if the token is missing/expired/invalid/wrong signature. */
    public static function tryDecode(string $token): ?stdClass
    {
        // Security review finding M4: firebase/php-jwt's leeway defaults to 0, while the .NET side
        // sets ClockSkew = 1 minute (Program.cs) — the two tiers are documented as interchangeable/
        // parity and weren't for this behavior (a token minted by one, validated a few seconds late
        // by the other across a container clock drift, would fail here but not there).
        JWT::$leeway = 60;

        try {
            $decoded = JWT::decode($token, new Key(self::signingKey(), 'HS256'));
        } catch (\Throwable) {
            return null;
        }

        $issuer = Config::get('JWT_ISSUER', 'Enkl.Api');
        $audience = Config::get('JWT_AUDIENCE', 'Enkl.App');
        if (($decoded->iss ?? null) !== $issuer || ($decoded->aud ?? null) !== $audience) {
            return null;
        }

        return $decoded;
    }

    /**
     * @return array<array{ProjectId:string,Role:?string}>
     */
    public static function parseProjectsClaim(stdClass $claims): array
    {
        if (!isset($claims->projects) || !is_string($claims->projects)) {
            return [];
        }
        $decoded = json_decode($claims->projects, true);
        return is_array($decoded) ? $decoded : [];
    }

    private static function signingKey(): string
    {
        return Config::get('JWT_SIGNING_KEY', '');
    }
}
