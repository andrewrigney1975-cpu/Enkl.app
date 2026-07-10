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
 *   orgAdmin     the STRING "true"/"false" (not a JSON bool — see the .NET comment this mirrors)
 *   projects     a JSON-encoded STRING (double-encoded) of [{"ProjectId":"...","Role":null}, ...],
 *                deliberately PascalCase inside to match System.Text.Json.Serialize's default output
 *                for the C# ProjectClaim record (no camelCase policy applied to that call site)
 */
final class JwtService
{
    /**
     * @param array{Id:string,Username:string,DisplayName:string,OrganisationId:string,IsOrgAdmin:bool} $user
     * @param array<array{ProjectId:string,Role:?string}> $memberships
     * @return array{token:string, expiresAt:string} expiresAt as an ISO-8601 UTC string, matching how
     *   the .NET DateTime gets JSON-serialized in LoginResponse/CreateProjectResponseDto
     */
    public static function generateToken(array $user, array $memberships): array
    {
        $expiryHours = (float) Config::get('JWT_EXPIRY_HOURS', '8');
        $now = new DateTimeImmutable('now');
        $expiresAt = $now->modify('+' . (int) round($expiryHours * 3600) . ' seconds');

        $projectsClaim = json_encode(array_map(
            static fn(array $m): array => ['ProjectId' => $m['ProjectId'], 'Role' => $m['Role']],
            $memberships
        ));

        $payload = [
            'sub' => $user['Id'],
            'username' => $user['Username'],
            'displayName' => $user['DisplayName'],
            'orgId' => $user['OrganisationId'],
            'orgAdmin' => $user['IsOrgAdmin'] ? 'true' : 'false',
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
