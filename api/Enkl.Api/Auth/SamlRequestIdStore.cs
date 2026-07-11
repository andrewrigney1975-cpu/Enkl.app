using System.Collections.Concurrent;

namespace Enkl.Api.Auth;

/// <summary>
/// Security review finding M5 (SAML replay protection): SamlController.Login mints an AuthnRequest
/// with its own Id, sends it to the IdP, then forgets it entirely — nothing correlates the ACS
/// callback's InResponseTo back to a request this SP actually issued, so a captured, validly-signed
/// SAML response is replayable any number of times until its own NotOnOrAfter window closes. This
/// store records each outstanding request Id and single-use-consumes it against the response's
/// InResponseTo in Acs (see SamlController.Acs). In-memory and singleton, same trade-off as
/// SsoExchangeCodeStore (this class's own doc comment explains why): a request only ever needs to
/// survive the one IdP round-trip within the process that issued it, so losing pending entries on a
/// restart just means that one in-flight login retries from scratch.
/// </summary>
public class SamlRequestIdStore
{
    private sealed record Entry(Guid OrgId, DateTime ExpiresAt);

    // Generous relative to a normal SSO round-trip (redirect to IdP, authenticate, redirect back) to
    // tolerate a slow IdP-side MFA step, but still bounds how long a leaked InResponseTo value would
    // even be checkable against a still-outstanding entry.
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, Entry> _requestIds = new();

    public void Record(Guid orgId, string requestId)
    {
        PruneExpired();
        _requestIds[requestId] = new Entry(orgId, DateTime.UtcNow.Add(Ttl));
    }

    /// <summary>
    /// Single-use: the entry is removed on lookup regardless of outcome, so the same InResponseTo
    /// value can never pass this check twice — the actual replay-protection guarantee. Only call this
    /// with a value that's already been cryptographically validated (i.e. after Saml2PostBinding.
    /// Unbind's signature check succeeds) — InResponseTo itself is untrusted input before that.
    /// </summary>
    public bool TryConsume(Guid orgId, string? requestId)
    {
        if (string.IsNullOrEmpty(requestId)) return false;
        if (!_requestIds.TryRemove(requestId, out var entry)) return false;
        return entry.OrgId == orgId && entry.ExpiresAt >= DateTime.UtcNow;
    }

    private void PruneExpired()
    {
        var now = DateTime.UtcNow;
        foreach (var kvp in _requestIds)
        {
            if (kvp.Value.ExpiresAt < now) _requestIds.TryRemove(kvp.Key, out _);
        }
    }
}
