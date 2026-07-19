<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\MemberService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Ported from Controllers/MembersController.cs. */
final class MembersController extends BaseController
{
    private function service(): MemberService
    {
        return new MemberService(Database::connection());
    }

    // "Add a team member" combobox's candidate list — see MemberService::getOrgCandidates's own doc
    // comment for why this is the whole org roster, not just this project's existing members.
    public function orgCandidates(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->getOrgCandidates($args['projectId']);
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->create($args['projectId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $result = $this->service()->update($args['projectId'], $args['memberId'], $this->body($request));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        return $this->service()->delete($args['projectId'], $args['memberId']) ? $this->noContent($response) : $this->notFound($response);
    }

    // "The project admin role can be assigned to users via the Team management tool" — Project-Admin
    // gated same as every other action here (routes.php), so only an existing admin can promote/
    // demote another member. MemberService::setProjectAdmin's last-admin guard throws
    // ApiValidationException, mapped to 400 by bootstrap.php's global error handler like every other
    // manual validation check in this tier.
    public function setProjectAdmin(Request $request, Response $response, array $args): Response
    {
        $body = $this->body($request);
        $result = $this->service()->setProjectAdmin($args['projectId'], $args['memberId'], (bool) ($body['isProjectAdmin'] ?? false));
        return $result === null ? $this->notFound($response) : $this->json($response, $result);
    }
}
