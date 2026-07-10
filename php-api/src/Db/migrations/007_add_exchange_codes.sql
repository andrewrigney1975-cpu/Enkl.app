-- PHP-specific — no .NET equivalent. The .NET side's SsoExchangeCodeStore is an in-memory
-- ConcurrentDictionary singleton, which works because ASP.NET Core hosts the app as one long-lived
-- process; PHP's request model has no equivalent guarantee (a PHP-FPM worker holds no state between
-- requests, and a code issued while handling the SAML ACS callback would never be found by whichever
-- worker happens to handle the follow-up redeem request). This table replaces that in-memory store:
-- SamlService's ACS handoff issues a row here instead, and SsoExchangeCodeService deletes expired
-- rows opportunistically on every read/write (same lazy-prune idea as the .NET version's
-- PruneExpired()). No FK — "Payload" is an opaque, already-serialized string (an
-- SsoExchangeResponse-shaped JSON blob), and a code only ever needs to survive the one redirect hop
-- it was issued for.
CREATE TABLE "ExchangeCodes" (
    "Code" text PRIMARY KEY,
    "Payload" text NOT NULL,
    "ExpiresAt" timestamptz NOT NULL
);
