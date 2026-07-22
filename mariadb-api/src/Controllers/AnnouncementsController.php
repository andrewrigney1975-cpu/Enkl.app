<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\AnnouncementService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from php-api's Controllers/AnnouncementsController.php. Any authenticated user (no
 * OrgAdmin/ProjectMemberMiddleware) — reading "what's currently relevant to me" and acknowledging one
 * you've seen are things every signed-in user can do, not an admin-only action. See
 * OrganisationAnnouncementsController for the Org-Admin-only CRUD management surface.
 */
final class AnnouncementsController extends BaseController
{
    private function service(): AnnouncementService
    {
        return new AnnouncementService(Database::connection());
    }

    public function getActive(Request $request, Response $response): Response
    {
        return $this->json($response, $this->service()->getActiveForUser($this->callerOrgId($request), $this->callerUserId($request)));
    }

    public function acknowledge(Request $request, Response $response, array $args): Response
    {
        $this->service()->acknowledge($this->callerUserId($request), $args['announcementId']);
        return $this->noContent($response);
    }
}
