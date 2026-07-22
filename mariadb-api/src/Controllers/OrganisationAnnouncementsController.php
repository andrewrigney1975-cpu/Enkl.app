<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\AnnouncementService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from php-api's Controllers/OrganisationAnnouncementsController.php. Org-Admin-only
 * management of the calling org's own Announcements/Disruption Notices — mirrors PortfolioController's
 * shape (a dedicated controller nested under api/organisations/me, rather than a method on
 * OrganisationsController) since this is its own distinct CRUD surface. Every write is always
 * Scope="org" + OrganisationId/CreatedByUserId re-derived from the caller's own JWT claims, never
 * client-supplied — see AnnouncementService's own doc comment.
 */
final class OrganisationAnnouncementsController extends BaseController
{
    private function service(): AnnouncementService
    {
        return new AnnouncementService(Database::connection());
    }

    public function list(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->listForOrg($this->callerOrgId($request)));
    }

    public function create(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        return $this->json($response, $this->service()->create($this->callerOrgId($request), $this->callerUserId($request), $body));
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $result = $this->service()->update($this->callerOrgId($request), $args['announcementId'], $body);
        return $result !== null ? $this->json($response, $result) : $this->notFound($response);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $deleted = $this->service()->delete($this->callerOrgId($request), $args['announcementId']);
        return $deleted ? $this->noContent($response) : $this->notFound($response);
    }
}
