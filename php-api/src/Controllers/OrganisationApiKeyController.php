<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\OrganisationApiKeyService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/OrganisationApiKeyController.cs. Same OrgAdmin gating and
 * callerOrgId() idiom as OrganisationSsoConfigController. */
final class OrganisationApiKeyController extends BaseController
{
    private function service(): OrganisationApiKeyService
    {
        return new OrganisationApiKeyService(Database::connection());
    }

    public function get(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->get($this->callerOrgId($request)));
    }

    public function generate(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->generate($this->callerOrgId($request)));
    }

    public function revoke(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->revoke($this->callerOrgId($request)));
    }
}
