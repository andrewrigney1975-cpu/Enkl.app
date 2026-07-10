<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Auth\EmailAddressNormalizer;
use Enkl\Api\Auth\JwtService;
use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Db\Database;
use Enkl\Api\Services\SsoExchangeCodeService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/AuthController.cs — kept thin, no separate service, same as the .NET version. */
final class AuthController extends BaseController
{
    public function login(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        $username = (string) ($body['username'] ?? '');
        $password = (string) ($body['password'] ?? '');
        $normalized = UsernameNormalizer::normalize($username);

        $db = Database::connection();
        $stmt = $db->prepare(<<<SQL
            SELECT u.*, o."Name" AS "OrganisationName", c."RequireSso" FROM "Users" u
            JOIN "Organisations" o ON o."Id" = u."OrganisationId"
            LEFT JOIN "OrganisationSsoConfigs" c ON c."OrganisationId" = u."OrganisationId"
            WHERE u."NormalizedUsername" = :n LIMIT 1
        SQL);
        $stmt->execute(['n' => $normalized]);
        $user = $stmt->fetch();

        if ($user === false || !(bool) $user['IsActive']) {
            return $this->json($response, ['message' => 'Invalid username or password.'], 401);
        }
        if ((bool) ($user['RequireSso'] ?? false)) {
            return $this->json($response, ['message' => 'This organisation requires SSO sign-in. Use the "Sign in with SSO" option.'], 401);
        }
        // An SSO-only user (SAML JIT-provisioned or SCIM-created) never gets a local password hash —
        // tell them where to actually sign in rather than a generic "invalid password" that implies
        // retrying with a different password would help.
        if ($user['PasswordHash'] === null) {
            return $this->json($response, ['message' => 'This account signs in via your organisation\'s SSO. Use the "Sign in with SSO" option.'], 401);
        }
        if (!PasswordHasher::verify($password, $user['PasswordHash'])) {
            return $this->json($response, ['message' => 'Invalid username or password.'], 401);
        }

        $stmt = $db->prepare('SELECT "ProjectId", "Role" FROM "ProjectMembers" WHERE "UserId" = :uid');
        $stmt->execute(['uid' => $user['Id']]);
        $memberships = $stmt->fetchAll();

        $tokenInfo = JwtService::generateToken($user, $memberships);

        return $this->json($response, [
            'token' => $tokenInfo['token'],
            'expiresAt' => $tokenInfo['expiresAt'],
            'user' => [
                'id' => $user['Id'],
                'username' => $user['Username'],
                'displayName' => $user['DisplayName'],
                'mustChangePassword' => $user['MustChangePassword'],
            ],
        ]);
    }

    /**
     * Ported from AuthController.cs's SsoLookup. Anonymous, minimal-disclosure org discovery for
     * the login screen's "Sign in with SSO" affordance: the caller could have typed either a
     * username or an email into that one field (the client can't tell which), so this tries both
     * normalizations and returns only whether SSO is available — never anything about whether the
     * identifier matched a real account, to avoid leaking account existence to an anonymous request.
     */
    public function ssoLookup(Request $request, Response $response): Response
    {
        $identifier = trim((string) ($request->getQueryParams()['identifier'] ?? ''));
        if ($identifier === '') {
            return $this->json($response, ['ssoAvailable' => false, 'organisationId' => null]);
        }

        $normalizedUsername = UsernameNormalizer::normalize($identifier);
        $normalizedEmail = EmailAddressNormalizer::normalize($identifier);

        $db = Database::connection();
        $stmt = $db->prepare(<<<SQL
            SELECT u."OrganisationId", c."SamlEnabled" FROM "Users" u
            LEFT JOIN "OrganisationSsoConfigs" c ON c."OrganisationId" = u."OrganisationId"
            WHERE u."NormalizedUsername" = :nu OR u."NormalizedEmailAddress" = :ne
            LIMIT 1
        SQL);
        $stmt->execute(['nu' => $normalizedUsername, 'ne' => $normalizedEmail]);
        $row = $stmt->fetch();

        if ($row !== false && (bool) ($row['SamlEnabled'] ?? false)) {
            return $this->json($response, ['ssoAvailable' => true, 'organisationId' => $row['OrganisationId']]);
        }
        return $this->json($response, ['ssoAvailable' => false, 'organisationId' => null]);
    }

    /**
     * Ported from AuthController.cs's SsoExchange. Trades the single-use code SamlController's acs
     * action redirected the browser with for the actual login response — see
     * SsoExchangeCodeService's own doc comment for why the token never rides in the redirect URL
     * itself.
     */
    public function ssoExchange(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        $code = (string) ($body['code'] ?? '');

        $exchange = new SsoExchangeCodeService(Database::connection());
        $payload = $code !== '' ? $exchange->tryRedeem($code) : null;
        if ($payload === null) {
            return $this->json($response, ['message' => 'This sign-in link has expired or was already used. Please sign in again.'], 401);
        }

        $response->getBody()->write($payload);
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function changePassword(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        $newPassword = (string) ($body['newPassword'] ?? '');
        if (strlen($newPassword) < 8) {
            return $this->json($response, ['message' => 'New password must be at least 8 characters.'], 400);
        }

        $userId = $this->callerUserId($request);
        $db = Database::connection();
        $stmt = $db->prepare('SELECT * FROM "Users" WHERE "Id" = :id');
        $stmt->execute(['id' => $userId]);
        $user = $stmt->fetch();

        $currentPassword = (string) ($body['currentPassword'] ?? '');
        if ($user === false || $user['PasswordHash'] === null || !PasswordHasher::verify($currentPassword, $user['PasswordHash'])) {
            return $this->json($response, ['message' => 'Current password is incorrect.'], 401);
        }

        $stmt = $db->prepare('UPDATE "Users" SET "PasswordHash" = :hash, "MustChangePassword" = false WHERE "Id" = :id');
        $stmt->execute(['hash' => PasswordHasher::hash($newPassword), 'id' => $userId]);

        return $this->noContent($response);
    }
}
