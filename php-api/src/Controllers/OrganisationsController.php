<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\OrganisationService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/OrganisationsController.cs — every action here requires OrgAdminMiddleware (see routes.php). */
final class OrganisationsController extends BaseController
{
    private function service(): OrganisationService
    {
        return new OrganisationService(Database::connection());
    }

    public function getMyOrganisation(Request $request, Response $response): Response
    {
        $org = $this->service()->getOrganisation($this->callerOrgId($request));
        return $org === null ? $this->notFound($response) : $this->json($response, $org);
    }

    public function setUserAdmin(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $ok = $this->service()->setUserAdmin($this->callerOrgId($request), $args['userId'], (bool) ($body['isOrgAdmin'] ?? false));
        return $ok ? $this->noContent($response) : $this->notFound($response);
    }

    public function createUser(Request $request, Response $response): Response
    {
        $result = $this->service()->createUser($this->callerOrgId($request), $this->body($request));
        return $this->json($response, $result);
    }

    public function setUserEmail(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $ok = $this->service()->setUserEmail($this->callerOrgId($request), $args['userId'], $body['emailAddress'] ?? null);
        return $ok ? $this->noContent($response) : $this->notFound($response);
    }

    public function getOrgTeams(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->getOrgTeams($this->callerOrgId($request)));
    }
}
