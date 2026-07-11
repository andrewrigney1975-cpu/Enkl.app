-- Ported from api/Enkl.Api's SamlRequestIdStore (security review finding M5 — SAML replay
-- protection). PHP-specific replacement for that .NET in-memory singleton — a PHP-FPM worker holds
-- no state between requests (same reasoning as 007_add_exchange_codes.sql's own note), so the
-- request ID minted in SamlController::login() and needed again in acs() (a separate, later HTTP
-- request) is persisted here instead. "RequestId" is the AuthnRequest's own SAML ID (already
-- effectively unique — an XML NCName the library generates), used as the primary key directly.
CREATE TABLE "SamlRequestIds" (
    "RequestId" text PRIMARY KEY,
    "OrgId" uuid NOT NULL,
    "ExpiresAt" timestamptz NOT NULL
);
