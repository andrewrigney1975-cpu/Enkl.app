-- SSO/SCIM support (OrganisationSsoConfigs merges php-api's 012 ScimTokenLastUsedAt column in
-- directly), plus PHP-tier-only ExchangeCodes/SamlRequestIds — see each table's own comment.

-- Strict 1:1 with Organisations (OrganisationId is both PK and FK) — one settings row per org holding
-- SAML config (IdP entity id/SSO URL/signing certificate, JIT provisioning and Require-SSO toggles)
-- and SCIM config (enabled flag, bearer token hash). SP entity id / ACS URL are NOT stored — they're
-- deterministic from OrganisationId and rendered read-only in the admin UI instead.
CREATE TABLE "OrganisationSsoConfigs" (
    "OrganisationId" CHAR(36) PRIMARY KEY,
    "SamlEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "IdpEntityId" VARCHAR(500) NULL,
    "IdpSsoUrl" VARCHAR(500) NULL,
    "IdpSigningCertificate" TEXT NULL,
    "SamlJitProvisioning" BOOLEAN NOT NULL DEFAULT FALSE,
    "RequireSso" BOOLEAN NOT NULL DEFAULT FALSE,
    "ScimEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "ScimBearerTokenHash" TEXT NULL,
    "ScimTokenGeneratedAt" DATETIME(6) NULL,
    "ScimTokenLastUsedAt" DATETIME(6) NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_OrganisationSsoConfigs_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;

-- Organisation-scoped grouping SCIM Groups sync into — distinct from TeamsCommittees, which is
-- scoped to a single Project and drives the per-project org chart.
CREATE TABLE "OrgTeams" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "ScimExternalId" VARCHAR(200) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_OrgTeams_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_OrgTeams_OrganisationId" ON "OrgTeams" ("OrganisationId");
-- php-api's own index is a PARTIAL unique index (`WHERE "ScimExternalId" IS NOT NULL`) — MariaDB has
-- no partial/filtered index support at all. Dropped the WHERE clause entirely rather than working
-- around it: InnoDB unique indexes already treat multiple NULL values as mutually distinct (the same
-- behavior the partial condition was really just optimizing the index's on-disk size around, not a
-- semantic requirement), so a plain unique index here is behaviorally equivalent.
CREATE UNIQUE INDEX "IX_OrgTeams_OrganisationId_ScimExternalId" ON "OrgTeams" ("OrganisationId", "ScimExternalId");

CREATE TABLE "OrgTeamMember" (
    "OrgTeamId" CHAR(36) NOT NULL,
    "UserId" CHAR(36) NOT NULL,
    PRIMARY KEY ("OrgTeamId", "UserId"),
    CONSTRAINT "FK_OrgTeamMember_OrgTeam" FOREIGN KEY ("OrgTeamId") REFERENCES "OrgTeams" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_OrgTeamMember_User" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_OrgTeamMember_UserId" ON "OrgTeamMember" ("UserId");

-- Deferred from 002_governance.sql — "OrgTeams" now exists, so TeamsCommittees.SourceOrgTeamId's FK
-- can finally be added. ON DELETE SET NULL: an OrgTeam deleted via SCIM must never touch a project's
-- TeamCommittee — that link is one-way and manual, not live.
ALTER TABLE "TeamsCommittees" ADD CONSTRAINT "FK_TeamsCommittees_SourceOrgTeam" FOREIGN KEY ("SourceOrgTeamId") REFERENCES "OrgTeams" ("Id") ON DELETE SET NULL;
CREATE INDEX "IX_TeamsCommittees_SourceOrgTeamId" ON "TeamsCommittees" ("SourceOrgTeamId");

-- PHP-tier-only (no .NET equivalent) — the .NET side's SsoExchangeCodeStore is an in-memory
-- ConcurrentDictionary singleton, which works because it hosts as one long-lived process; a PHP
-- (or PHP-FPM) worker holds no state between requests, so a code issued while handling the SAML ACS
-- callback would never be found by whichever worker/request happens to handle the follow-up redeem
-- request. This table replaces that in-memory store. No FK — "Payload" is an opaque, already-
-- serialized string, and a code only ever needs to survive the one redirect hop it was issued for.
CREATE TABLE "ExchangeCodes" (
    "Code" VARCHAR(255) PRIMARY KEY,
    "Payload" TEXT NOT NULL,
    "ExpiresAt" DATETIME(6) NOT NULL
) ENGINE=InnoDB;

-- PHP-tier-only (no .NET equivalent) — same "no in-process state between requests" reasoning as
-- ExchangeCodes above, replacing the .NET tier's in-memory SamlRequestIdStore (SAML replay
-- protection, security review finding M5). "RequestId" is the AuthnRequest's own SAML ID.
CREATE TABLE "SamlRequestIds" (
    "RequestId" VARCHAR(255) PRIMARY KEY,
    "OrgId" CHAR(36) NOT NULL,
    "ExpiresAt" DATETIME(6) NOT NULL
) ENGINE=InnoDB;
