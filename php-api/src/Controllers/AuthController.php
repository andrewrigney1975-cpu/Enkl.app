<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Auth\JwtService;
use Enkl\Api\Auth\PasswordHasher;
use Enkl\Api\Auth\UsernameNormalizer;
use Enkl\Api\Db\Database;
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
        $stmt = $db->prepare('SELECT * FROM "Users" WHERE "NormalizedUsername" = :n LIMIT 1');
        $stmt->execute(['n' => $normalized]);
        $user = $stmt->fetch();

        if ($user === false || !PasswordHasher::verify($password, $user['PasswordHash'])) {
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
        if ($user === false || !PasswordHasher::verify($currentPassword, $user['PasswordHash'])) {
            return $this->json($response, ['message' => 'Current password is incorrect.'], 401);
        }

        $stmt = $db->prepare('UPDATE "Users" SET "PasswordHash" = :hash, "MustChangePassword" = false WHERE "Id" = :id');
        $stmt->execute(['hash' => PasswordHasher::hash($newPassword), 'id' => $userId]);

        return $this->noContent($response);
    }
}
