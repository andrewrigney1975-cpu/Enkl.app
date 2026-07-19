-- Saved Queries + the Public Query API — consolidates php-api's 022 (SavedQueries base table), 023
-- (ExposeViaApi + OrganisationApiKeys + the enkl_public_query role/views), and the 024/025 view
-- casing/shape fixes straight into their final, already-correct form (camelCase-aliased view columns
-- matching AlaSQL's TABLE_SCHEMAS naming exactly — no need to replay the two live bugs those two
-- migrations fixed on the Postgres tiers).
--
-- MariaDB architectural note (see mariadb-api/CLAUDE.md for the full writeup) — this went through
-- three real design iterations, verified against a live MariaDB 11.4 instance at each step, not just
-- reasoned about:
--   1. Postgres's `current_setting('app.query_project_id', true)`-filtered views rely on a
--      per-transaction session variable. A plain MariaDB session variable (`@project_id`) was tried
--      first — safe in principle here (Db/Database.php's publicQueryConnection() opens a
--      brand-new, never-reused PDO connection per call, so there's no cross-request leakage risk) —
--      but MariaDB rejects it outright at CREATE VIEW time: error 1351, "View's SELECT contains a
--      variable or parameter." MariaDB simply does not allow a session variable inside a view
--      definition at all, full stop.
--   2. Next tried: unfiltered views exposing a real `projectid` column, with
--      PublicQueryExecutionService wrapping the user's arbitrary SQL in an outer
--      `SELECT * FROM (<query>) sub WHERE sub.projectid = ?`. Rejected during design review (never
--      even reached a live test): this only filters correctly when the user's own query happens to
--      select the `projectid` column through to its own output — a saved query that doesn't
--      (e.g. `SELECT id, title FROM tasks`) would return EVERY project's rows unfiltered, since the
--      outer WHERE has nothing to filter on. Isolation has to happen at the FROM-source level, not
--      as a wrapper around an arbitrary caller-controlled projection.
--   3. What's below and what actually works, verified live: a `QueryContext` table keyed by
--      MariaDB's `CONNECTION_ID()` — a real, deterministic SQL function (not a session variable),
--      which MariaDB DOES permit inside a view's correlated subquery. Each view filters via
--      `WHERE t."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" =
--      CONNECTION_ID())`. PublicQueryExecutionService upserts this connection's row to the right
--      project id the instant it opens its fresh connection, and deletes it again when done. Verified
--      live: a connection with no QueryContext row sees zero rows from every view (the correlated
--      subquery returns NULL, and `"ProjectId" = NULL` is never true) — the same fail-closed default
--      this app's other defensive-parsing conventions already favor, not an information leak.
--      `enkl_public_query` needs no direct grant on `QueryContext` itself: like every other base
--      table these views reach, the correlated subquery runs with the VIEW'S OWNER's privileges
--      (MariaDB's default, same as Postgres's own default here), not the invoking low-privilege
--      user's — only the view's own SELECT grant (below) is needed.
--
-- Also note: MariaDB has no `array_agg()` — every one-to-many "IDs" column below uses
-- `GROUP_CONCAT()` instead, returning a comma-joined string (or NULL if empty) rather than a real
-- array. PublicQueryExecutionService is responsible for splitting that string into an array before
-- handing results back to the frontend's AlaSQL engine, which expects an array-shaped value for
-- these fields exactly like the other two tiers already produce.

CREATE TABLE "SavedQueries" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "Sql" TEXT NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "ExposeViaApi" BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT "FK_SavedQueries_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_SavedQueries_ProjectId" ON "SavedQueries" ("ProjectId");

-- Strict 1:1 with Organisations (OrganisationId is both PK and FK), same shape as
-- OrganisationSsoConfigs. KeyHash is a bcrypt hash via Auth/PasswordHasher.php, same as
-- ScimBearerTokenHash — the raw key is shown to the OrgAdmin exactly once at generation time and
-- never persisted or retrievable again.
CREATE TABLE "OrganisationApiKeys" (
    "OrganisationId" CHAR(36) PRIMARY KEY,
    "Enabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "KeyHash" TEXT NULL,
    "GeneratedAt" DATETIME(6) NULL,
    "LastUsedAt" DATETIME(6) NULL,
    CONSTRAINT "FK_OrganisationApiKeys_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;

-- MariaDB-only (no Postgres/.NET equivalent) — see this file's own header comment, design iteration
-- #3. One row per currently-executing public-query connection, cleaned up by
-- PublicQueryExecutionService itself (best-effort, in a `finally`) the moment that connection is
-- done with it — a stale leftover row (e.g. from a PHP crash mid-request) is harmless: the next
-- caller who happens to get the same reused CONNECTION_ID() overwrites it via
-- `INSERT ... ON DUPLICATE KEY UPDATE` before running anything.
CREATE TABLE "QueryContext" (
    "ConnectionId" BIGINT UNSIGNED PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL
) ENGINE=InnoDB;

-- PublicQueryExecutionService (all three tiers) executes a saved query's SQL text as this dedicated,
-- SELECT-only user — never the app's own high-privilege DB user — so it can see nothing except the
-- views below. Unlike Postgres's CREATE ROLE (needing a pg_roles-checked DO-block to be idempotent),
-- MariaDB's CREATE USER IF NOT EXISTS is natively idempotent, no workaround needed. The dev password
-- here MUST match the literal in Db/Database.php's publicQueryConnection() default and this tier's
-- own .env.example — same "duplicated-by-necessity constant" situation as the other two tiers' own
-- copies of this password; a real deployment overrides it via env, same as the main DB password.
CREATE USER IF NOT EXISTS 'enkl_public_query'@'%' IDENTIFIED BY 'enkl_public_query_dev_password';

CREATE VIEW tasks AS
    SELECT
        t."Id" AS id, t."Key" AS "key", t."Title" AS title,
        t."Description" AS description, t."Priority" AS priority,
        t."ColumnId" AS columnid,
        (SELECT GROUP_CONCAT(td."DependsOnTaskId") FROM "TaskDependencies" td WHERE td."TaskId" = t."Id") AS dependencies,
        t."AssigneeId" AS assigneeid, t."ReleaseId" AS releaseid, t."TypeId" AS typeid,
        t."DocumentationUrl" AS documentationurl, t."StartDate" AS startdate, t."EndDate" AS enddate,
        t."BusinessValue" AS businessvalue, t."TaskCost" AS taskcost, t."Progress" AS progress,
        t."EstimatedEffort" AS estimatedeffort, t."ActualEffort" AS actualeffort, t."Archived" AS archived,
        NULL AS isprivate,
        t."DateCreated" AS datecreated, t."DateLastModified" AS datelastmodified,
        t."DateDone" AS datedone, t."ParentTaskId" AS parenttaskid
    FROM "Tasks" t
    WHERE t."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW columns AS
    SELECT c."Id" AS id, c."Name" AS name, c."Done" AS done,
        c."Order" AS "order", c."Color" AS color, c."Cap" AS cap
    FROM "Columns" c
    WHERE c."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW members AS
    SELECT
        m."Id" AS id, u."DisplayName" AS name, u."EmailAddress" AS email,
        m."Color" AS color, m."Role" AS role, m."AllocatedFraction" AS allocatedfraction,
        m."ReportsToId" AS reportstoid, m."IsProjectAdmin" AS isprojectadmin
    FROM "ProjectMembers" m
    JOIN "Users" u ON u."Id" = m."UserId"
    WHERE m."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW risks AS
    SELECT
        r."Id" AS id, r."Key" AS "key", r."Title" AS title, r."Description" AS description,
        r."Likelihood" AS likelihood, r."Impact" AS impact, r."Mitigations" AS mitigations,
        r."OwnerId" AS ownerid, r."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(rd."DocumentId") FROM "RiskDocument" rd WHERE rd."RiskId" = r."Id") AS documentids,
        (SELECT GROUP_CONCAT(rp."PrincipleId") FROM "RiskPrinciple" rp WHERE rp."RiskId" = r."Id") AS principleids,
        (SELECT GROUP_CONCAT(ro."ObjectiveId") FROM "RiskObjective" ro WHERE ro."RiskId" = r."Id") AS objectiveids,
        r."Status" AS status, r."DateToClose" AS datetoclose, r."DateClosed" AS dateclosed,
        r."DateCreated" AS datecreated, r."DateLastModified" AS datelastmodified
    FROM "Risks" r
    WHERE r."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW decisions AS
    SELECT
        d."Id" AS id, d."Key" AS "key", d."Title" AS title, d."Description" AS description,
        d."Type" AS type, d."Status" AS status, d."Outcome" AS outcome, d."OwnerId" AS ownerid,
        d."Approver" AS approver, d."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(dd."DocumentId") FROM "DecisionDocument" dd WHERE dd."DecisionId" = d."Id") AS documentids,
        (SELECT GROUP_CONCAT(dr."RiskId") FROM "DecisionRisk" dr WHERE dr."DecisionId" = d."Id") AS riskids,
        (SELECT GROUP_CONCAT(dp."PrincipleId") FROM "DecisionPrinciple" dp WHERE dp."DecisionId" = d."Id") AS principleids,
        (SELECT GROUP_CONCAT(dob."ObjectiveId") FROM "DecisionObjective" dob WHERE dob."DecisionId" = d."Id") AS objectiveids,
        d."DateCreated" AS datecreated, d."DateLastModified" AS datelastmodified
    FROM "Decisions" d
    WHERE d."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW principles AS
    SELECT p."Id" AS id, p."Key" AS "key", p."Title" AS title, p."Description" AS description,
        p."DocumentUrl" AS documenturl, p."DateCreated" AS datecreated, p."DateLastModified" AS datelastmodified
    FROM "Principles" p
    WHERE p."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW objectives AS
    SELECT o."Id" AS id, o."Key" AS "key", o."Title" AS title, o."Description" AS description,
        (SELECT GROUP_CONCAT(op."PrincipleId") FROM "ObjectivePrinciple" op WHERE op."ObjectiveId" = o."Id") AS principleids,
        o."DateCreated" AS datecreated, o."DateLastModified" AS datelastmodified
    FROM "Objectives" o
    WHERE o."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW documents AS
    SELECT doc."Id" AS id, doc."Key" AS "key", doc."Title" AS title, doc."Url" AS url,
        doc."Description" AS description, doc."OwnerId" AS ownerid, doc."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(dr."RelatedDocumentId") FROM "DocumentRelation" dr WHERE dr."DocumentId" = doc."Id") AS relateddocumentids,
        doc."DateCreated" AS datecreated, doc."DateLastModified" AS datelastmodified
    FROM "Documents" doc
    WHERE doc."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW releases AS
    SELECT rl."Id" AS id, rl."Name" AS name, rl."Status" AS status, rl."OwnerId" AS ownerid,
        rl."StartDate" AS startdate, rl."EndDate" AS enddate,
        rl."DateCreated" AS datecreated, rl."DateLastModified" AS datelastmodified
    FROM "Releases" rl
    WHERE rl."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW tasktypes AS
    SELECT tt."Id" AS id, tt."Name" AS name, tt."IconName" AS iconname
    FROM "TaskTypes" tt
    WHERE tt."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

CREATE VIEW teamscommittees AS
    SELECT tc."Id" AS id, tc."Key" AS "key", tc."Name" AS name, tc."Description" AS description,
        tc."Type" AS type, tc."ParentId" AS parentid,
        (SELECT GROUP_CONCAT(tcm."ProjectMemberId") FROM "TeamCommitteeMember" tcm WHERE tcm."TeamCommitteeId" = tc."Id") AS memberids,
        tc."DateCreated" AS datecreated, tc."DateLastModified" AS datelastmodified
    FROM "TeamsCommittees" tc
    WHERE tc."ProjectId" = (SELECT "ProjectId" FROM "QueryContext" WHERE "ConnectionId" = CONNECTION_ID());

-- One db-qualified GRANT per view is required here (unlike Postgres, where GRANT is schema-relative
-- to whatever database the migration ran against) — hardcoded to the documented default database
-- name `enkl` (same convention as the dev password above). An operator using a different DB_NAME
-- must adjust the schema-qualifier below by hand, same as they'd already need to for DB_NAME itself.
-- No grant needed on "QueryContext" itself — the views' correlated subqueries run with the view
-- DEFINER's privileges (the migration-running high-privilege user), not the invoking
-- enkl_public_query user's, same as their access to the base tables above.
GRANT SELECT ON `enkl`.`tasks` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`columns` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`members` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`risks` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`decisions` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`principles` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`objectives` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`documents` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`releases` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`tasktypes` TO 'enkl_public_query'@'%';
GRANT SELECT ON `enkl`.`teamscommittees` TO 'enkl_public_query'@'%';
