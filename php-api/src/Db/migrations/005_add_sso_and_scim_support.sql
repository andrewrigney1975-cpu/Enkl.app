-- Nullable PasswordHash + IsActive on Users, plus OrganisationSsoConfigs/OrgTeams/OrgTeamMember —
-- ported from the .NET side's AddSsoAndScimSupport migration (api/Enkl.Api/Data/Migrations). Users
-- gets two changes: PasswordHash becomes optional (an SSO-only user — SAML JIT-provisioned or
-- SCIM-created — never gets a local password hash; AuthController's login path rejects that case
-- with an SSO-specific message rather than attempting to verify against a hash that was never set),
-- and IsActive (default true) drives SCIM deprovisioning (PATCH active:false) as well as manual
-- deactivation — both the password and SAML login paths reject an inactive User.
--
-- OrganisationSsoConfigs is a strict 1:1 with Organisations (OrganisationId is both PK and FK) —
-- one settings row per org holding SAML config (IdP entity id/SSO URL/signing certificate, JIT
-- provisioning and Require-SSO toggles) and SCIM config (enabled flag, bearer token hash). SP
-- entity id / ACS URL are NOT stored — they're deterministic from OrganisationId (see
-- SamlService.php) and rendered read-only in the admin UI instead.
--
-- OrgTeams/OrgTeamMember is the Organisation-scoped grouping SCIM Groups sync into — distinct from
-- TeamsCommittees, which is scoped to a single Project and drives the per-project org chart (see
-- 006_add_source_org_team_to_team_committee.sql for the one-way, manual bridge between the two).
ALTER TABLE "Users" ALTER COLUMN "PasswordHash" DROP NOT NULL;
ALTER TABLE "Users" ADD COLUMN "IsActive" boolean NOT NULL DEFAULT true;

CREATE TABLE "OrganisationSsoConfigs" (
    "OrganisationId" uuid PRIMARY KEY REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    "SamlEnabled" boolean NOT NULL DEFAULT false,
    "IdpEntityId" varchar(500),
    "IdpSsoUrl" varchar(500),
    "IdpSigningCertificate" text,
    "SamlJitProvisioning" boolean NOT NULL DEFAULT false,
    "RequireSso" boolean NOT NULL DEFAULT false,
    "ScimEnabled" boolean NOT NULL DEFAULT false,
    "ScimBearerTokenHash" text,
    "ScimTokenGeneratedAt" timestamptz,
    "DateLastModified" timestamptz NOT NULL
);

CREATE TABLE "OrgTeams" (
    "Id" uuid PRIMARY KEY,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    "Name" varchar(200) NOT NULL,
    "ScimExternalId" varchar(200),
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_OrgTeams_OrganisationId" ON "OrgTeams" ("OrganisationId");
CREATE UNIQUE INDEX "IX_OrgTeams_OrganisationId_ScimExternalId" ON "OrgTeams" ("OrganisationId", "ScimExternalId") WHERE "ScimExternalId" IS NOT NULL;

CREATE TABLE "OrgTeamMember" (
    "OrgTeamId" uuid NOT NULL REFERENCES "OrgTeams" ("Id") ON DELETE CASCADE,
    "UserId" uuid NOT NULL REFERENCES "Users" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("OrgTeamId", "UserId")
);
CREATE INDEX "IX_OrgTeamMember_UserId" ON "OrgTeamMember" ("UserId");
