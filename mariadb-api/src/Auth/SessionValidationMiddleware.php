<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

use Enkl\Api\Db\Database;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Ported from Program.cs's combined session-validation middleware — renamed from
 * MustChangePasswordMiddleware since it now also does the H2 revocation check; both need the same
 * live per-request DB read, so they're combined into one query rather than two separate middlewares.
 *
 * 1. Token revocation (security review finding H2): signature/issuer/audience/lifetime were
 *    previously the only things ever checked, so deactivating a user (SCIM) or changing their
 *    password/org-admin role kept their already-issued token(s) fully valid for up to the full
 *    8-hour expiry. User.SecurityStamp is regenerated at each of those points (AuthController::
 *    changePassword, OrganisationService::setUserAdmin, ScimUserService) and minted into the token
 *    as the "securityStamp" claim (JwtService::generateToken) — a mismatch against the live DB
 *    value (or a token from before this claim existed, which has none) means the token was issued
 *    under a state that's since changed, so it's rejected outright.
 *
 * 2. MustChangePassword enforcement (security review finding C4): the flag was being set at account
 *    creation (e.g. MigrationService's default "enklUserPassword" accounts) and returned in the
 *    login response, but nothing previously stopped the account from being used indefinitely
 *    without ever actually changing it. Only mutating requests (POST/PUT/PATCH/DELETE) are blocked
 *    — reads still work so a signed-in client isn't broken while the change-password prompt is up.
 *    /api/auth/change-password is the one exempted mutating route — it's the only way to ever clear
 *    the flag (and, since it also rotates SecurityStamp, the one route that must keep working under
 *    check 1 too using the caller's own current, about-to-be-superseded token).
 *
 * Registered at app level in routes.php, added BEFORE JwtAuthMiddleware so it runs AFTER it (Slim's
 * middleware stack is LIFO — the last ->add() call is outermost/runs first).
 */
final class SessionValidationMiddleware implements MiddlewareInterface
{
    private const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $claims = $request->getAttribute('jwtClaims');

        if ($claims !== null && isset($claims->sub)) {
            $stmt = Database::connection()->prepare('SELECT "IsActive", "SecurityStamp", "MustChangePassword" FROM "Users" WHERE "Id" = :id');
            $stmt->execute(['id' => (string) $claims->sub]);
            $current = $stmt->fetch();

            $tokenStamp = $claims->securityStamp ?? null;
            $stampMatches = $current !== false && $tokenStamp !== null && (string) $tokenStamp === (string) $current['SecurityStamp'];
            if ($current === false || !(bool) $current['IsActive'] || !$stampMatches) {
                $response = new Response(401);
                $response->getBody()->write(json_encode(['message' => 'Session expired. Please log in again.']));
                return $response->withHeader('Content-Type', 'application/json');
            }

            $isMutating = in_array(strtoupper($request->getMethod()), self::MUTATING_METHODS, true);
            $isChangePasswordRoute = str_starts_with($request->getUri()->getPath(), '/api/auth/change-password');
            // TelemetryController is anonymous and never checks the caller's identity — but this
            // middleware runs for ANY request whose attached token happens to decode successfully
            // (regardless of whether the endpoint it's hitting requires auth), so a signed-in browser
            // with MustChangePassword set would otherwise have its page-load beacon blocked here too.
            $isTelemetryRoute = str_starts_with($request->getUri()->getPath(), '/api/telemetry');
            if ($isMutating && !$isChangePasswordRoute && !$isTelemetryRoute && (bool) $current['MustChangePassword']) {
                $response = new Response(403);
                $response->getBody()->write(json_encode([
                    'code' => 'must_change_password',
                    'message' => 'You must change your password before making further changes.',
                ]));
                return $response->withHeader('Content-Type', 'application/json');
            }
        }

        return $handler->handle($request);
    }
}
