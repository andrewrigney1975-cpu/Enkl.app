<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\ScimUserService;
use Enkl\Api\Validation\ApiValidationException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/ScimUsersController.cs. SCIM 2.0 Users endpoint for one Organisation —
 * gated by ScimAuthMiddleware's per-org static bearer token (see routes.php), not a user JWT, so
 * orgId comes from the route ($args), never callerOrgId(). ApiValidationException (thrown by the
 * shared EmailValidation helper) is caught locally here and translated into a SCIM error envelope
 * rather than the app's usual {message} shape, which a SCIM client wouldn't recognize.
 */
final class ScimUsersController extends BaseController
{
    private function service(): ScimUserService
    {
        return new ScimUserService(Database::connection());
    }

    public function list(Request $request, Response $response, array $args): Response
    {
        $query = $request->getQueryParams();
        $filter = $query['filter'] ?? null;
        $startIndex = isset($query['startIndex']) ? (int) $query['startIndex'] : 1;
        $count = isset($query['count']) ? (int) $query['count'] : 100;
        return $this->json($response, $this->service()->list($args['orgId'], $filter, $startIndex, $count));
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->get($args['orgId'], $args['id']);
        return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        try {
            $result = $this->service()->create($args['orgId'], $this->body($request));
            return $this->json($response, $result, 201);
        } catch (ApiValidationException $e) {
            return $this->scimError($response, 400, $e->getMessage());
        }
    }

    public function replace(Request $request, Response $response, array $args): Response
    {
        try {
            $result = $this->service()->replace($args['orgId'], $args['id'], $this->body($request));
            return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
        } catch (ApiValidationException $e) {
            return $this->scimError($response, 400, $e->getMessage());
        }
    }

    public function patch(Request $request, Response $response, array $args): Response
    {
        try {
            $result = $this->service()->patch($args['orgId'], $args['id'], $this->body($request));
            return $result === null ? $this->scimNotFound($response) : $this->json($response, $result);
        } catch (ApiValidationException $e) {
            return $this->scimError($response, 400, $e->getMessage());
        }
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->delete($args['orgId'], $args['id']);
        return match ($result) {
            'deleted' => $this->noContent($response),
            'not_found' => $this->scimNotFound($response),
            'has_project_memberships' => $this->scimError($response, 409, 'This user is still a member of one or more projects. Remove them from those projects, or deactivate the account (PATCH active:false) instead of deleting it.'),
            default => $this->scimError($response, 500, 'Unexpected error.'),
        };
    }

    private function scimNotFound(Response $response): Response
    {
        return $this->scimError($response, 404, 'User not found.');
    }

    private function scimError(Response $response, int $status, string $detail): Response
    {
        return $this->json($response, [
            'schemas' => ['urn:ietf:params:scim:api:messages:2.0:Error'],
            'status' => (string) $status,
            'detail' => $detail,
        ], $status);
    }
}
