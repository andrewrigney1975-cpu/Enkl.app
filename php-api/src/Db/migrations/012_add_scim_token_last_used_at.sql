-- Ported from api/Enkl.Api's AddScimTokenLastUsedAt migration (security review Low/Informational
-- finding): a rotate-only SCIM bearer token otherwise had no usage audit trail at all beyond its
-- own generation time — this gives an OrgAdmin/support engineer investigating suspected token
-- compromise at least a coarse "is this IdP still actually calling us" signal. Updated by
-- ScimAuthMiddleware on every successful authentication.
ALTER TABLE "OrganisationSsoConfigs" ADD COLUMN "ScimTokenLastUsedAt" timestamptz;
