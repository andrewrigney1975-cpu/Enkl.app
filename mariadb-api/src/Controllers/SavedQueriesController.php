<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\PublicQueryExecutionService;
use Enkl\Api\Services\SavedQueryService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/SavedQueriesController.cs. */
final class SavedQueriesController extends BaseController
{
    private function service(): SavedQueryService
    {
        return new SavedQueryService(Database::connection());
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $args['id'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['projectId'], $args['id']) ? $this->noContent($response) : $this->notFound($response);
    }

    /**
     * "Test API (GET)" button (Advanced Query tab, next to an exposed saved query's public URL) —
     * runs the SAME PublicQueryExecutionService code path PublicQueryController's real public
     * endpoint uses, but authenticated by the caller's own project-member session instead of an org
     * API key (the raw key isn't retrievable after generation, so there's no key for the frontend to
     * actually send here — see SAVED-QUERY-API.md). Results are identical to what a real API caller
     * with a valid key would see; this only changes how the caller authenticates, not what runs.
     */
    public function test(Request $request, Response $response, array $args): Response
    {
        $sql = $this->service()->getSql($args['projectId'], $args['id']);
        if ($sql === null) {
            return $this->notFound($response);
        }
        $result = (new PublicQueryExecutionService())->execute($args['projectId'], $sql);
        return $this->json($response, $result);
    }
}
