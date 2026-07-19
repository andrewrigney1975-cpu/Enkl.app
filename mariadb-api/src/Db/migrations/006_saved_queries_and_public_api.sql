-- Saved Queries + the Public Query API — consolidates php-api's 022 (SavedQueries base table), 023
-- (ExposeViaApi + OrganisationApiKeys + the enkl_public_query role/views), and the 024/025 view
-- casing/shape fixes straight into their final, already-correct form (camelCase-aliased view columns
-- matching AlaSQL's TABLE_SCHEMAS naming exactly — no need to replay the two live bugs those two
-- migrations fixed on the Postgres tiers).
--
-- MariaDB architectural note (see mariadb-api/CLAUDE.md for the full writeup) — TWO things had to
-- change here, not one:
--   1. Postgres's `current_setting('app.query_project_id', true)`-filtered views rely on a
--      per-transaction session variable. A first attempt at porting this used a plain MariaDB
--      session variable (`@project_id`) in the view's WHERE clause instead (safe here specifically
--      because Db/Database.php's publicQueryConnection() opens a brand-new, never-reused PDO
--      connection per call — no leakage risk across requests). That attempt was verified against a
--      real MariaDB 11.4 instance and rejected outright at CREATE VIEW time: MariaDB error 1351,
--      "View's SELECT contains a variable or parameter" — MariaDB simply does not allow a session
--      variable inside a view definition at all, full stop, not something to work around with
--      different syntax.
--   2. So instead: these views are UNFILTERED (every project's rows, unlike the Postgres tiers'
--      own per-project-filtered views) and each one exposes a real `projectid` column.
--      Services/PublicQueryExecutionService.php (Phase 2) is responsible for the actual isolation —
--      it wraps whatever SQL a saved query runs as `SELECT * FROM (<query>) sub WHERE sub.projectid
--      = ?` with the project id bound as an ordinary parameter, then strips the `projectid` key back
--      out of each result row before returning them, so the final response shape still matches the
--      other two tiers exactly (neither of which ever exposes this column, since their isolation
--      happens invisibly inside the view itself).
--
-- Also note: MariaDB has no `array_agg()` — every one-to-many "IDs" column below uses
-- `GROUP_CONCAT()` instead, returning a comma-joined string (or NULL if empty) rather than a real
-- array. PublicQueryExecutionService is also responsible for splitting that string into an array
-- before handing results back to the frontend's AlaSQL engine, which expects an array-shaped value
-- for these fields exactly like the other two tiers already produce.

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
        t."DateDone" AS datedone, t."ParentTaskId" AS parenttaskid,
        t."ProjectId" AS projectid
    FROM "Tasks" t;

CREATE VIEW columns AS
    SELECT c."Id" AS id, c."Name" AS name, c."Done" AS done,
        c."Order" AS "order", c."Color" AS color, c."Cap" AS cap,
        c."ProjectId" AS projectid
    FROM "Columns" c;

CREATE VIEW members AS
    SELECT
        m."Id" AS id, u."DisplayName" AS name, u."EmailAddress" AS email,
        m."Color" AS color, m."Role" AS role, m."AllocatedFraction" AS allocatedfraction,
        m."ReportsToId" AS reportstoid, m."IsProjectAdmin" AS isprojectadmin,
        m."ProjectId" AS projectid
    FROM "ProjectMembers" m
    JOIN "Users" u ON u."Id" = m."UserId";

CREATE VIEW risks AS
    SELECT
        r."Id" AS id, r."Key" AS "key", r."Title" AS title, r."Description" AS description,
        r."Likelihood" AS likelihood, r."Impact" AS impact, r."Mitigations" AS mitigations,
        r."OwnerId" AS ownerid, r."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(rd."DocumentId") FROM "RiskDocument" rd WHERE rd."RiskId" = r."Id") AS documentids,
        (SELECT GROUP_CONCAT(rp."PrincipleId") FROM "RiskPrinciple" rp WHERE rp."RiskId" = r."Id") AS principleids,
        (SELECT GROUP_CONCAT(ro."ObjectiveId") FROM "RiskObjective" ro WHERE ro."RiskId" = r."Id") AS objectiveids,
        r."Status" AS status, r."DateToClose" AS datetoclose, r."DateClosed" AS dateclosed,
        r."DateCreated" AS datecreated, r."DateLastModified" AS datelastmodified,
        r."ProjectId" AS projectid
    FROM "Risks" r;

CREATE VIEW decisions AS
    SELECT
        d."Id" AS id, d."Key" AS "key", d."Title" AS title, d."Description" AS description,
        d."Type" AS type, d."Status" AS status, d."Outcome" AS outcome, d."OwnerId" AS ownerid,
        d."Approver" AS approver, d."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(dd."DocumentId") FROM "DecisionDocument" dd WHERE dd."DecisionId" = d."Id") AS documentids,
        (SELECT GROUP_CONCAT(dr."RiskId") FROM "DecisionRisk" dr WHERE dr."DecisionId" = d."Id") AS riskids,
        (SELECT GROUP_CONCAT(dp."PrincipleId") FROM "DecisionPrinciple" dp WHERE dp."DecisionId" = d."Id") AS principleids,
        (SELECT GROUP_CONCAT(dob."ObjectiveId") FROM "DecisionObjective" dob WHERE dob."DecisionId" = d."Id") AS objectiveids,
        d."DateCreated" AS datecreated, d."DateLastModified" AS datelastmodified,
        d."ProjectId" AS projectid
    FROM "Decisions" d;

CREATE VIEW principles AS
    SELECT p."Id" AS id, p."Key" AS "key", p."Title" AS title, p."Description" AS description,
        p."DocumentUrl" AS documenturl, p."DateCreated" AS datecreated, p."DateLastModified" AS datelastmodified,
        p."ProjectId" AS projectid
    FROM "Principles" p;

CREATE VIEW objectives AS
    SELECT o."Id" AS id, o."Key" AS "key", o."Title" AS title, o."Description" AS description,
        (SELECT GROUP_CONCAT(op."PrincipleId") FROM "ObjectivePrinciple" op WHERE op."ObjectiveId" = o."Id") AS principleids,
        o."DateCreated" AS datecreated, o."DateLastModified" AS datelastmodified,
        o."ProjectId" AS projectid
    FROM "Objectives" o;

CREATE VIEW documents AS
    SELECT doc."Id" AS id, doc."Key" AS "key", doc."Title" AS title, doc."Url" AS url,
        doc."Description" AS description, doc."OwnerId" AS ownerid, doc."TaskId" AS taskid,
        (SELECT GROUP_CONCAT(dr."RelatedDocumentId") FROM "DocumentRelation" dr WHERE dr."DocumentId" = doc."Id") AS relateddocumentids,
        doc."DateCreated" AS datecreated, doc."DateLastModified" AS datelastmodified,
        doc."ProjectId" AS projectid
    FROM "Documents" doc;

CREATE VIEW releases AS
    SELECT rl."Id" AS id, rl."Name" AS name, rl."Status" AS status, rl."OwnerId" AS ownerid,
        rl."StartDate" AS startdate, rl."EndDate" AS enddate,
        rl."DateCreated" AS datecreated, rl."DateLastModified" AS datelastmodified,
        rl."ProjectId" AS projectid
    FROM "Releases" rl;

CREATE VIEW tasktypes AS
    SELECT tt."Id" AS id, tt."Name" AS name, tt."IconName" AS iconname,
        tt."ProjectId" AS projectid
    FROM "TaskTypes" tt;

CREATE VIEW teamscommittees AS
    SELECT tc."Id" AS id, tc."Key" AS "key", tc."Name" AS name, tc."Description" AS description,
        tc."Type" AS type, tc."ParentId" AS parentid,
        (SELECT GROUP_CONCAT(tcm."ProjectMemberId") FROM "TeamCommitteeMember" tcm WHERE tcm."TeamCommitteeId" = tc."Id") AS memberids,
        tc."DateCreated" AS datecreated, tc."DateLastModified" AS datelastmodified,
        tc."ProjectId" AS projectid
    FROM "TeamsCommittees" tc;

-- One db-qualified GRANT per view is required here (unlike Postgres, where GRANT is schema-relative
-- to whatever database the migration ran against) — hardcoded to the documented default database
-- name `enkl` (same convention as the dev password above). An operator using a different DB_NAME
-- must adjust the schema-qualifier below by hand, same as they'd already need to for DB_NAME itself.
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
