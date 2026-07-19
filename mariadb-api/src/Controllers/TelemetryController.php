<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\TelemetryService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/TelemetryController.cs. Anonymous Real User Monitoring beacon — no auth
 * requirement at all (unlike every other controller in this API), since it's a fire-and-forget
 * report from every page load, signed in or not. See SessionValidationMiddleware.php, which
 * explicitly excludes this route's path from the MustChangePassword gate — there's no authenticated
 * session here for that gate to meaningfully apply to. Rate-limited under its own "telemetry" policy
 * (see routes.php) rather than "auth"'s brute-force-tuned limit.
 */
final class TelemetryController extends BaseController
{
    public function reportPageLoad(Request $request, Response $response): Response
    {
        $body = $this->body($request);
        $service = new TelemetryService(Database::connection());
        $service->recordPageLoad($body['durationMs'] ?? null);
        return $this->noContent($response);
    }
}
