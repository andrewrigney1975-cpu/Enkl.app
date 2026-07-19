<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Realtime\Broadcaster;
use Enkl\Api\Services\ChatService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/ChatController.cs. Org-wide chat — RequireAuthMiddleware only on the base
 * group (no ProjectMember/OrgAdmin), since every org user can create channels/DMs and post messages;
 * only the Truncate route (see routes.php) is further restricted to OrgAdmin. */
final class ChatController extends BaseController
{
    private function service(): ChatService
    {
        return new ChatService(Database::connection());
    }

    private function callerIsOrgAdmin(Request $request): bool
    {
        $claims = $request->getAttribute('jwtClaims');
        return ($claims->orgAdmin ?? null) === 'true';
    }

    public function getOrgRoster(Request $request, Response $response, array $args): Response
    {
        return $this->json($response, $this->service()->getOrgRoster($this->callerOrgId($request)));
    }

    public function listChannels(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->listChannels($this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request));
        return $this->json($response, $result);
    }

    public function createChannel(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->createChannel(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerDisplayName($request) ?? 'Someone', $this->body($request)
        );
        return $this->json($response, $result);
    }

    public function addMember(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $ok = $this->service()->addMember(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request), $args['channelId'], (string) ($body['userId'] ?? '')
        );
        return $ok ? $this->noContent($response) : $this->notFound($response);
    }

    public function removeMember(Request $request, Response $response, array $args): Response
    {
        $ok = $this->service()->removeMember(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request), $args['channelId'], $args['userId']
        );
        return $ok ? $this->noContent($response) : $this->notFound($response);
    }

    public function getMessages(Request $request, Response $response, array $args): Response
    {
        $query = $request->getQueryParams();
        $before = isset($query['before']) && $query['before'] !== '' ? (string) $query['before'] : null;
        $limit = isset($query['limit']) ? (int) $query['limit'] : 50;

        $result = $this->service()->getMessages(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request), $args['channelId'], $before, $limit
        );
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function postMessage(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->postMessage(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerDisplayName($request) ?? 'Someone', $args['channelId'], $this->body($request)
        );
        if ($result === null) {
            return $this->notFound($response);
        }
        $this->broadcast($request, $args['channelId'], $result['message'], $result['channelMemberUserIds'], 'created');
        return $this->json($response, $result['message']);
    }

    public function updateMessage(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->updateMessage($this->callerUserId($request), $args['channelId'], $args['messageId'], $this->body($request));
        if ($result === null) {
            return $this->notFound($response);
        }
        $this->broadcast($request, $args['channelId'], $result['message'], $result['channelMemberUserIds'], 'updated');
        return $this->json($response, $result['message']);
    }

    public function deleteMessage(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->deleteMessage(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request), $args['channelId'], $args['messageId']
        );
        if ($result === null) {
            return $this->notFound($response);
        }
        $this->broadcast($request, $args['channelId'], $result['message'], $result['channelMemberUserIds'], 'deleted');
        return $this->json($response, $result['message']);
    }

    public function toggleReaction(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $result = $this->service()->toggleReaction(
            $this->callerOrgId($request), $this->callerUserId($request), $this->callerIsOrgAdmin($request),
            $args['channelId'], $args['messageId'], (string) ($body['emoji'] ?? '')
        );
        if ($result === null) {
            return $this->notFound($response);
        }
        $this->broadcastReaction($request, $args['channelId'], $result['message'], $result['channelMemberUserIds']);
        return $this->json($response, $result['message']);
    }

    // Best-effort — a notification failure must never fail the mutation itself (same convention as
    // broadcast() above).
    private function broadcastReaction(Request $request, string $channelId, array $message, array $channelMemberUserIds): void
    {
        try {
            $clientSessionId = $request->getHeaderLine('X-Client-Session-Id') ?: null;
            (new Broadcaster(Database::connection()))->broadcastChatReaction(
                $channelMemberUserIds, $channelId, $message['id'], $message['reactions'], $clientSessionId
            );
        } catch (\Throwable) {
            // best-effort, see comment above
        }
    }

    // Org-Admin-only manual replacement for a scheduled 180-day purge (see ChatService::truncateOldMessages's
    // own doc comment) — hard-deletes, gated by OrgAdminMiddleware in routes.php.
    public function truncate(Request $request, Response $response, array $args): Response
    {
        return $this->json($response, $this->service()->truncateOldMessages($this->callerOrgId($request)));
    }

    // Best-effort — a notification failure must never fail the mutation itself (same convention as
    // TasksController.php's own broadcast call site).
    private function broadcast(Request $request, string $channelId, array $message, array $channelMemberUserIds, string $changeType): void
    {
        try {
            $clientSessionId = $request->getHeaderLine('X-Client-Session-Id') ?: null;
            (new Broadcaster(Database::connection()))->broadcastChatMessage(
                $channelMemberUserIds, $channelId, $message['id'], $message['text'], $changeType,
                $message['authorUserId'], $message['authorName'], $message['dateCreated'], $message['isDeleted'],
                $message['mentionedUserIds'], $clientSessionId
            );
        } catch (\Throwable) {
            // best-effort, see comment above
        }
    }
}
