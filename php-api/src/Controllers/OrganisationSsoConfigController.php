<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\OrganisationSsoConfigService;
use Enkl\Api\Services\SamlService;
use Enkl\Api\Services\SsoExchangeCodeService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/OrganisationSsoConfigController.cs. Same OrgAdmin gating and
 * callerOrgId() idiom as OrganisationsController — this is a separate resource (one settings row
 * per Organisation) rather than another action on OrganisationsController itself. */
final class OrganisationSsoConfigController extends BaseController
{
    private function service(): OrganisationSsoConfigService
    {
        $db = Database::connection();
        return new OrganisationSsoConfigService($db, new SamlService($db, new SsoExchangeCodeService($db)));
    }

    public function get(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->get($this->callerOrgId($request)));
    }

    public function update(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->update($this->callerOrgId($request), $this->body($request)));
    }

    public function generateScimToken(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->generateScimToken($this->callerOrgId($request)));
    }
}
