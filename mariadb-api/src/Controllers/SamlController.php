<?php

declare(strict_types=1);

namespace Enkl\Api\Controllers;

use Enkl\Api\Db\Database;
use Enkl\Api\Services\SamlRequestIdService;
use Enkl\Api\Services\SamlService;
use Enkl\Api\Services\SsoExchangeCodeService;
use OneLogin\Saml2\Auth;
use OneLogin\Saml2\Response as SamlResponse;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Ported from Controllers/SamlController.cs. The SAML 2.0 SP endpoints for one Organisation's SSO
 * — deliberately anonymous (no RequireAuthMiddleware in routes.php), same bootstrapping rationale
 * as MigrationController: nothing here can be gated behind a JWT, since the whole point is to
 * ISSUE one. Every action re-derives the org's config fresh from the DB rather than trusting
 * anything cached, and acs() cross-checks the resolved User's OrganisationId against {orgId} even
 * though email is already globally unique — see SamlService::processAssertion's own comment.
 */
final class SamlController extends BaseController
{
    private function service(): SamlService
    {
        $db = Database::connection();
        return new SamlService($db, new SsoExchangeCodeService($db));
    }

    private function requestIds(): SamlRequestIdService
    {
        return new SamlRequestIdService(Database::connection());
    }

    public function metadata(Request $request, Response $response, array $args): Response
    {
        $saml = $this->service();
        $ssoConfig = $saml->getEnabledConfig($args['orgId']);
        if ($ssoConfig === null) {
            return $this->notFound($response);
        }

        // Metadata only describes the SP itself — no IdP fields needed, so a minimal settings array
        // (just sp.entityId/ACS) is enough; the second Auth constructor arg (spValidationOnly)
        // skips onelogin's idp-block validation, which would otherwise reject a settings array with
        // no "idp" key at all. wantAssertionsSigned defaults to false in this library — set it
        // explicitly to match the .NET side's metadata (WantAssertionsSigned="true"), the correct
        // security posture to advertise to the IdP regardless.
        $auth = new Auth([
            'sp' => [
                'entityId' => $saml->spEntityId($args['orgId']),
                'assertionConsumerService' => [
                    'url' => $saml->acsUrl($args['orgId']),
                    'binding' => 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
                ],
                'NameIDFormat' => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            ],
            'security' => [
                'wantAssertionsSigned' => true,
            ],
        ], true);
        $metadata = $auth->getSettings()->getSPMetadata();

        $response->getBody()->write($metadata);
        return $response->withHeader('Content-Type', 'application/xml');
    }

    public function login(Request $request, Response $response, array $args): Response
    {
        $saml = $this->service();
        $ssoConfig = $saml->getEnabledConfig($args['orgId']);
        if ($ssoConfig === null || empty($ssoConfig['IdpSsoUrl'])) {
            return $this->notFound($response);
        }

        $auth = new Auth($saml->buildAuthSettings($args['orgId'], $ssoConfig));
        // $stay=true (5th arg): return the redirect URL as a string instead of the library sending
        // headers and calling exit() itself, so this stays a normal Slim action returning a Response
        // (see OneLogin\Saml2\Utils::redirect, which is where that behavior actually lives).
        $url = $auth->login(null, [], false, false, true);

        // Security review finding M5: recorded so acs() can correlate+single-use-consume the IdP's
        // eventual InResponseTo against a request this SP actually issued, closing the replay gap
        // (a captured, validly-signed response was otherwise reusable until its own NotOnOrAfter).
        $this->requestIds()->record($args['orgId'], $auth->getLastRequestID());

        return $response->withHeader('Location', $url)->withStatus(302);
    }

    public function acs(Request $request, Response $response, array $args): Response
    {
        $saml = $this->service();
        $ssoConfig = $saml->getEnabledConfig($args['orgId']);
        if ($ssoConfig === null || empty($ssoConfig['IdpSsoUrl'])) {
            return $this->notFound($response);
        }

        $auth = new Auth($saml->buildAuthSettings($args['orgId'], $ssoConfig));

        // Security review finding M5: peek the (not yet validated) response's InResponseTo so we
        // know which outstanding request to single-use-consume from the store and pass into
        // processResponse($requestId) below — the library then cryptographically ties signature
        // validation to this exact value (Response::isValid, in vendor/onelogin/php-saml), so an
        // attacker can't defeat this by forging a claimed InResponseTo the actual signed content
        // doesn't carry: they can only ever replay a real, previously-signed response, whose
        // InResponseTo is fixed by that signature and already consumed the first time it was used.
        try {
            $peek = new SamlResponse($auth->getSettings(), $_POST['SAMLResponse'] ?? '');
            $claimedRequestId = $peek->getXMLDocument()->documentElement->getAttribute('InResponseTo') ?: null;
        } catch (\Throwable) {
            $claimedRequestId = null;
        }
        $requestId = $claimedRequestId !== null && $this->requestIds()->consume($args['orgId'], $claimedRequestId)
            ? $claimedRequestId
            : null;
        if ($requestId === null) {
            return $response->withHeader('Location', $saml->errorRedirectUrl('This sign-in link has already been used or has expired. Please sign in again.'))->withStatus(302);
        }

        try {
            // processResponse() reads $_POST['SAMLResponse'] directly — the library's own design,
            // not routed through Slim's PSR-7 body — but PHP's SAPI already populates $_POST for
            // this request's form-urlencoded body before Slim (or this action) ever runs, so this
            // just works without needing $this->body($request) the way every other action does.
            $auth->processResponse($requestId);
        } catch (\Throwable $e) {
            return $response->withHeader('Location', $saml->errorRedirectUrl('SAML sign-in failed: ' . $e->getMessage()))->withStatus(302);
        }

        if (!$auth->isAuthenticated()) {
            $reason = $auth->getLastErrorReason() ?? implode(', ', $auth->getErrors());
            return $response->withHeader('Location', $saml->errorRedirectUrl('SAML sign-in failed (' . $reason . ').'))->withStatus(302);
        }

        $email = $auth->getNameId();
        if (empty($email)) {
            return $response->withHeader('Location', $saml->errorRedirectUrl("Your identity provider didn't supply an email address."))->withStatus(302);
        }

        $attributes = $auth->getAttributes();
        $displayNameHint = $attributes['displayName'][0]
            ?? $attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'][0]
            ?? null;

        $result = $saml->processAssertion($args['orgId'], $ssoConfig, $email, $displayNameHint);
        $url = match ($result['outcome']) {
            'success' => $saml->successRedirectUrl($result['exchangeCode']),
            'user_inactive' => $saml->errorRedirectUrl('Your account has been deactivated. Contact your organisation admin.'),
            default => $saml->errorRedirectUrl('No account found for your email. Contact your organisation admin.'),
        };
        return $response->withHeader('Location', $url)->withStatus(302);
    }
}
