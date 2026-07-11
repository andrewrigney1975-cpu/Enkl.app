using Enkl.Api.Auth;
using Enkl.Api.Services;
using ITfoxtec.Identity.Saml2;
using ITfoxtec.Identity.Saml2.MvcCore;
using ITfoxtec.Identity.Saml2.Schemas;
using ITfoxtec.Identity.Saml2.Schemas.Metadata;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// The SAML 2.0 SP endpoints for one Organisation's SSO — deliberately anonymous, same bootstrapping
/// rationale as MigrationController: nothing here can be gated behind a JWT, since the whole point
/// is to ISSUE one. Every action re-derives the org's config fresh from the DB rather than trusting
/// anything cached, and /acs cross-checks the resolved User's OrganisationId against {orgId} even
/// though email is already globally unique — see SamlService.ProcessAssertionAsync's own comment.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/saml/{orgId:guid}")]
public class SamlController : ControllerBase
{
    private readonly SamlService _saml;
    private readonly SamlRequestIdStore _requestIds;

    public SamlController(SamlService saml, SamlRequestIdStore requestIds)
    {
        _saml = saml;
        _requestIds = requestIds;
    }

    [HttpGet("metadata")]
    public async Task<IActionResult> Metadata(Guid orgId)
    {
        var ssoConfig = await _saml.GetEnabledConfigAsync(orgId);
        if (ssoConfig is null) return NotFound();

        // EntityId has no public setter — EntityDescriptor(Saml2Configuration, bool) is the only way
        // to set it, so metadata gets a minimal config carrying just the SP's own Issuer (none of
        // the IdP-facing fields BuildSaml2Configuration adds are relevant to describing the SP).
        var metadataConfig = new ITfoxtec.Identity.Saml2.Saml2Configuration { Issuer = _saml.SpEntityId(orgId) };
        var entityDescriptor = new EntityDescriptor(metadataConfig, signMetadata: false)
        {
            SPSsoDescriptor = new SPSsoDescriptor
            {
                WantAssertionsSigned = true,
                AuthnRequestsSigned = false,
                NameIDFormats = new[] { new Uri("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress") },
                AssertionConsumerServices = new[]
                {
                    new AssertionConsumerService
                    {
                        Binding = ProtocolBindings.HttpPost,
                        Location = new Uri(_saml.AcsUrl(orgId)),
                        Index = 0,
                        IsDefault = true
                    }
                }
            }
        };
        return new Saml2Metadata(entityDescriptor).CreateMetadata().ToActionResult();
    }

    [HttpGet("login")]
    public async Task<IActionResult> Login(Guid orgId)
    {
        var ssoConfig = await _saml.GetEnabledConfigAsync(orgId);
        if (ssoConfig is null || string.IsNullOrEmpty(ssoConfig.IdpSsoUrl)) return NotFound();

        var config = _saml.BuildSaml2Configuration(orgId, ssoConfig);
        var authnRequest = new Saml2AuthnRequest(config)
        {
            AssertionConsumerServiceUrl = new Uri(_saml.AcsUrl(orgId)),
            NameIdPolicy = new NameIdPolicy
            {
                AllowCreate = true,
                Format = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
            }
        };
        // Security review finding M5: recorded so Acs can correlate+single-use-consume the IdP's
        // eventual InResponseTo against a request this SP actually issued, closing the replay gap
        // (a captured, validly-signed response was otherwise reusable until its own NotOnOrAfter).
        _requestIds.Record(orgId, authnRequest.IdAsString);
        var binding = new Saml2RedirectBinding();
        return binding.Bind(authnRequest).ToActionResult();
    }

    [HttpPost("acs")]
    public async Task<IActionResult> Acs(Guid orgId)
    {
        var ssoConfig = await _saml.GetEnabledConfigAsync(orgId);
        if (ssoConfig is null || string.IsNullOrEmpty(ssoConfig.IdpSsoUrl)) return NotFound();

        var config = _saml.BuildSaml2Configuration(orgId, ssoConfig);
        var authnResponse = new Saml2AuthnResponse(config);
        var binding = new Saml2PostBinding();

        // Two-step read: ReadSamlResponse only parses far enough to see the Status field, so an
        // IdP-reported failure (denied consent, no matching account there, etc.) can be reported
        // without first requiring a fully valid signature on what might be an error response.
        // Unbind does the real work — full parse, signature validation against
        // ssoConfig.IdpSigningCertificate, and populates NameId/ClaimsIdentity.
        binding.ReadSamlResponse(Request.ToGenericHttpRequest(validate: true), authnResponse);
        if (authnResponse.Status != Saml2StatusCodes.Success)
        {
            return Redirect(_saml.ErrorRedirectUrl($"SAML sign-in failed ({authnResponse.Status})."));
        }
        binding.Unbind(Request.ToGenericHttpRequest(validate: true), authnResponse);

        // Security review finding M5: only checked here, AFTER Unbind's signature validation —
        // InResponseTo is untrusted input before that (part of the signed content, so forgeable in
        // an unsigned/badly-signed response). Single-use: a captured, replayed copy of an otherwise
        // perfectly valid response fails this the second time, since the first successful use already
        // consumed the matching entry.
        if (!_requestIds.TryConsume(orgId, authnResponse.InResponseToAsString))
        {
            return Redirect(_saml.ErrorRedirectUrl("This sign-in link has already been used or has expired. Please sign in again."));
        }

        var email = authnResponse.NameId?.Value;
        if (string.IsNullOrWhiteSpace(email))
        {
            return Redirect(_saml.ErrorRedirectUrl("Your identity provider didn't supply an email address."));
        }
        var displayNameHint =
            authnResponse.ClaimsIdentity?.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value ??
            authnResponse.ClaimsIdentity?.FindFirst(System.Security.Claims.ClaimTypes.GivenName)?.Value;

        var result = await _saml.ProcessAssertionAsync(orgId, ssoConfig, email, displayNameHint);
        return result.Outcome switch
        {
            SamlAcsOutcome.Success => Redirect(_saml.SuccessRedirectUrl(result.ExchangeCode!)),
            SamlAcsOutcome.UserInactive => Redirect(_saml.ErrorRedirectUrl("Your account has been deactivated. Contact your organisation admin.")),
            _ => Redirect(_saml.ErrorRedirectUrl("No account found for your email. Contact your organisation admin."))
        };
    }
}
