-- Ported from the .NET side's AddSavedQueryApiExposure migration (api/Enkl.Api/Data/Migrations).
--
-- SavedQueries.ExposeViaApi (default false): once true, PublicQueryController serves this query's
-- results to any caller presenting a valid API key for this project's Organisation.
--
-- OrganisationApiKeys is a strict 1:1 with Organisations (OrganisationId is both PK and FK), same
-- shape as OrganisationSsoConfigs — kept as its own table rather than folded into
-- OrganisationSsoConfigs since API keys are a distinct concern from SAML/SCIM and an org shouldn't
-- need an SSO config row to exist just to generate one. KeyHash is a bcrypt hash via
-- Auth/PasswordHasher.php, same as ScimBearerTokenHash — the raw key is shown to the OrgAdmin
-- exactly once at generation time and never persisted or retrievable again.
--
-- The role/view block below is IDENTICAL to the one in the .NET migration and is guarded to be
-- idempotent (CREATE ROLE checked via pg_roles, CREATE OR REPLACE VIEW, GRANT is naturally
-- idempotent) because both tiers point at the same Postgres and either one may run first in a given
-- environment. PublicQueryExecutionService (both tiers) executes a saved query's SQL text as this
-- dedicated, SELECT-only enkl_public_query role — never the app's own high-privilege DB user — so it
-- can see nothing except these ten query_* views, each hard-filtered to one project via a session
-- variable. "Is this SQL safe to run" is enforced by Postgres' own grants, not by parsing the text.
-- The dev password here MUST match the literal in the .NET migration and php-api's own
-- config/database.php ConnectionStrings-equivalent for the public-query connection — same
-- "duplicated-by-necessity constant, no cross-language enforcement" situation as MemberPalette
-- (CLAUDE.md §12); a real deployment overrides it via env, same as the main DB password.
ALTER TABLE "SavedQueries" ADD COLUMN "ExposeViaApi" boolean NOT NULL DEFAULT false;

CREATE TABLE "OrganisationApiKeys" (
    "OrganisationId" uuid PRIMARY KEY REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    "Enabled" boolean NOT NULL DEFAULT false,
    "KeyHash" text,
    "GeneratedAt" timestamptz,
    "LastUsedAt" timestamptz
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'enkl_public_query') THEN
        CREATE ROLE enkl_public_query LOGIN PASSWORD 'enkl_public_query_dev_password'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

CREATE OR REPLACE VIEW query_tasks AS
    SELECT * FROM "Tasks" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_columns AS
    SELECT * FROM "Columns" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_members AS
    SELECT * FROM "ProjectMembers" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_risks AS
    SELECT * FROM "Risks" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_decisions AS
    SELECT * FROM "Decisions" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_principles AS
    SELECT * FROM "Principles" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_objectives AS
    SELECT * FROM "Objectives" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_documents AS
    SELECT * FROM "Documents" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_releases AS
    SELECT * FROM "Releases" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_task_types AS
    SELECT * FROM "TaskTypes" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;
CREATE OR REPLACE VIEW query_teams_committees AS
    SELECT * FROM "TeamsCommittees" WHERE "ProjectId" = current_setting('app.query_project_id', true)::uuid;

GRANT SELECT ON
    query_tasks, query_columns, query_members, query_risks, query_decisions,
    query_principles, query_objectives, query_documents, query_releases,
    query_task_types, query_teams_committees
TO enkl_public_query;
GRANT USAGE ON SCHEMA public TO enkl_public_query;
