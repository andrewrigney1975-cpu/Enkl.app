<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\AiAssistantNotEntitledException;
use Enkl\Api\Services\AiAssistantService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/AiAssistantController.cs. ProjectMemberMiddleware is applied on the route
 * group in routes.php (same shape as TasksController), not here. */
final class AiAssistantController extends BaseController
{
    private function service(): AiAssistantService
    {
        return new AiAssistantService(Database::connection());
    }

    public function chat(Request $request, Response $response, array $args): Response
    {
        try {
            $result = $this->service()->chat($args['projectId'], $this->body($request));
            return $result === null ? $this->notFound($response) : $this->json($response, $result);
        } catch (AiAssistantNotEntitledException) {
            return $this->json($response, ['message' => 'AI Assistant is not available for your organisation.'], 403);
        }
    }

    /** Lets the frontend decide whether to show the AI Assistant bubble at all, without a full chat
     * round-trip. Polled periodically (features/ai-assistant.js) - chat() above independently
     * re-checks on every call regardless of what this returns, so this is a UI convenience only. */
    public function availability(Request $request, Response $response, array $args): Response
    {
        $enabled = $this->service()->isProjectOrgEntitled($args['projectId'], 'ai_assistant');
        return $enabled === null ? $this->notFound($response) : $this->json($response, ['enabled' => $enabled]);
    }
}
