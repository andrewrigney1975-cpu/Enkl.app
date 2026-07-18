-- Ported from the .NET side's FixSavedQueryApiViewCasing migration (api/Enkl.Api/Data/Migrations).
--
-- Real bug found live (2026-07-18, second report, same day as 024_fix_saved_query_api_views.sql):
-- a saved query need not bracket-quote every identifier — `t.columnId` (bare, no brackets) resolves
-- fine in AlaSQL, matching the JS object property exactly as typed. Postgres, in contrast, folds an
-- UNQUOTED identifier to lowercase before matching against a real column — so the previous
-- migration's mixed-case, double-quoted columns (`"columnId"`) were invisible to a bare
-- `t.columnId` reference (Postgres was looking for `columnid`). Fixed by making every view name and
-- column fully lowercase, paired with PublicQueryExecutionService::translateBracketIdentifiers()
-- now ALSO lowercasing bracket contents (not just quoting them) — so a bare `columnId`
-- (auto-folded by Postgres) and a bracketed `[columnId]` (translated to `"columnid"`) both resolve
-- to the identical column.
DROP VIEW IF EXISTS "tasks";
DROP VIEW IF EXISTS "columns";
DROP VIEW IF EXISTS "members";
DROP VIEW IF EXISTS "risks";
DROP VIEW IF EXISTS "decisions";
DROP VIEW IF EXISTS "principles";
DROP VIEW IF EXISTS "objectives";
DROP VIEW IF EXISTS "documents";
DROP VIEW IF EXISTS "releases";
DROP VIEW IF EXISTS "taskTypes";
DROP VIEW IF EXISTS "teamsCommittees";

CREATE VIEW tasks AS
    SELECT
        t."Id" AS id, t."Key" AS key, t."Title" AS title,
        t."Description" AS description, t."Priority" AS priority,
        t."ColumnId" AS columnid,
        (SELECT array_agg(td."DependsOnTaskId") FROM "TaskDependencies" td WHERE td."TaskId" = t."Id") AS dependencies,
        t."AssigneeId" AS assigneeid, t."ReleaseId" AS releaseid, t."TypeId" AS typeid,
        t."DocumentationUrl" AS documentationurl, t."StartDate" AS startdate, t."EndDate" AS enddate,
        t."BusinessValue" AS businessvalue, t."TaskCost" AS taskcost, t."Progress" AS progress,
        t."EstimatedEffort" AS estimatedeffort, t."ActualEffort" AS actualeffort, t."Archived" AS archived,
        NULL::boolean AS isprivate,
        t."DateCreated" AS datecreated, t."DateLastModified" AS datelastmodified,
        t."DateDone" AS datedone, t."ParentTaskId" AS parenttaskid
    FROM "Tasks" t
    WHERE t."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW columns AS
    SELECT c."Id" AS id, c."Name" AS name, c."Done" AS done,
        c."Order" AS "order", c."Color" AS color, c."Cap" AS cap
    FROM "Columns" c
    WHERE c."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW members AS
    SELECT
        m."Id" AS id, u."DisplayName" AS name, u."EmailAddress" AS email,
        m."Color" AS color, m."Role" AS role, m."AllocatedFraction" AS allocatedfraction,
        m."ReportsToId" AS reportstoid, m."IsProjectAdmin" AS isprojectadmin
    FROM "ProjectMembers" m
    JOIN "Users" u ON u."Id" = m."UserId"
    WHERE m."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW risks AS
    SELECT
        r."Id" AS id, r."Key" AS key, r."Title" AS title, r."Description" AS description,
        r."Likelihood" AS likelihood, r."Impact" AS impact, r."Mitigations" AS mitigations,
        r."OwnerId" AS ownerid, r."TaskId" AS taskid,
        (SELECT array_agg(rd."DocumentId") FROM "RiskDocument" rd WHERE rd."RiskId" = r."Id") AS documentids,
        (SELECT array_agg(rp."PrincipleId") FROM "RiskPrinciple" rp WHERE rp."RiskId" = r."Id") AS principleids,
        (SELECT array_agg(ro."ObjectiveId") FROM "RiskObjective" ro WHERE ro."RiskId" = r."Id") AS objectiveids,
        r."Status" AS status, r."DateToClose" AS datetoclose, r."DateClosed" AS dateclosed,
        r."DateCreated" AS datecreated, r."DateLastModified" AS datelastmodified
    FROM "Risks" r
    WHERE r."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW decisions AS
    SELECT
        d."Id" AS id, d."Key" AS key, d."Title" AS title, d."Description" AS description,
        d."Type" AS type, d."Status" AS status, d."Outcome" AS outcome, d."OwnerId" AS ownerid,
        d."Approver" AS approver, d."TaskId" AS taskid,
        (SELECT array_agg(dd."DocumentId") FROM "DecisionDocument" dd WHERE dd."DecisionId" = d."Id") AS documentids,
        (SELECT array_agg(dr."RiskId") FROM "DecisionRisk" dr WHERE dr."DecisionId" = d."Id") AS riskids,
        (SELECT array_agg(dp."PrincipleId") FROM "DecisionPrinciple" dp WHERE dp."DecisionId" = d."Id") AS principleids,
        (SELECT array_agg(dob."ObjectiveId") FROM "DecisionObjective" dob WHERE dob."DecisionId" = d."Id") AS objectiveids,
        d."DateCreated" AS datecreated, d."DateLastModified" AS datelastmodified
    FROM "Decisions" d
    WHERE d."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW principles AS
    SELECT p."Id" AS id, p."Key" AS key, p."Title" AS title, p."Description" AS description,
        p."DocumentUrl" AS documenturl, p."DateCreated" AS datecreated, p."DateLastModified" AS datelastmodified
    FROM "Principles" p
    WHERE p."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW objectives AS
    SELECT o."Id" AS id, o."Key" AS key, o."Title" AS title, o."Description" AS description,
        (SELECT array_agg(op."PrincipleId") FROM "ObjectivePrinciple" op WHERE op."ObjectiveId" = o."Id") AS principleids,
        o."DateCreated" AS datecreated, o."DateLastModified" AS datelastmodified
    FROM "Objectives" o
    WHERE o."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW documents AS
    SELECT doc."Id" AS id, doc."Key" AS key, doc."Title" AS title, doc."Url" AS url,
        doc."Description" AS description, doc."OwnerId" AS ownerid, doc."TaskId" AS taskid,
        (SELECT array_agg(dr."RelatedDocumentId") FROM "DocumentRelation" dr WHERE dr."DocumentId" = doc."Id") AS relateddocumentids,
        doc."DateCreated" AS datecreated, doc."DateLastModified" AS datelastmodified
    FROM "Documents" doc
    WHERE doc."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW releases AS
    SELECT rl."Id" AS id, rl."Name" AS name, rl."Status" AS status, rl."OwnerId" AS ownerid,
        rl."StartDate" AS startdate, rl."EndDate" AS enddate,
        rl."DateCreated" AS datecreated, rl."DateLastModified" AS datelastmodified
    FROM "Releases" rl
    WHERE rl."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW tasktypes AS
    SELECT tt."Id" AS id, tt."Name" AS name, tt."IconName" AS iconname
    FROM "TaskTypes" tt
    WHERE tt."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW teamscommittees AS
    SELECT tc."Id" AS id, tc."Key" AS key, tc."Name" AS name, tc."Description" AS description,
        tc."Type" AS type, tc."ParentId" AS parentid,
        (SELECT array_agg(tcm."ProjectMemberId") FROM "TeamCommitteeMember" tcm WHERE tcm."TeamCommitteeId" = tc."Id") AS memberids,
        tc."DateCreated" AS datecreated, tc."DateLastModified" AS datelastmodified
    FROM "TeamsCommittees" tc
    WHERE tc."ProjectId" = current_setting('app.query_project_id', true)::uuid;

GRANT SELECT ON
    tasks, columns, members, risks, decisions, principles,
    objectives, documents, releases, tasktypes, teamscommittees
TO enkl_public_query;
