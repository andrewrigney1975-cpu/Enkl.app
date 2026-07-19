<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TemplateService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/TemplatesController.cs. Separate from OrganisationsController since its
 * gating is split, not uniformly OrgAdmin — see routes.php, which puts list/detail/create under
 * RequireAuthMiddleware only, and rename/delete under an additional OrgAdminMiddleware.
 */
final class TemplatesController extends BaseController
{
    private function service(): TemplateService
    {
        return new TemplateService(Database::connection());
    }

    public function list(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->list($this->callerOrgId($request)));
    }

    public function detail(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->getDetail($this->callerOrgId($request), $args['id']);
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function create(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->create($this->callerOrgId($request), $this->body($request)));
    }

    public function rename(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $ok = $this->service()->rename($this->callerOrgId($request), $args['id'], (string) ($body['name'] ?? ''));
        return $ok ? $this->noContent($response) : $this->notFound($response);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($this->callerOrgId($request), $args['id']) ? $this->noContent($response) : $this->notFound($response);
    }
}
