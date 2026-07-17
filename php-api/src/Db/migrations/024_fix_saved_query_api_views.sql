-- Ported from the .NET side's FixSavedQueryApiViews migration (api/Enkl.Api/Data/Migrations).
--
-- Real bug found live (2026-07-18): the original ten `query_*` views (023_add_saved_query_api_
-- exposure.sql) did `SELECT *`, preserving the real Postgres PascalCase column names — but a saved
-- query is authored against the AlaSQL grammar (query-engine.js's TABLE_SCHEMAS), which uses
-- lowercase table names and camelCase field names (`columnId`, not `ColumnId`). Combined with the
-- separate bracket-quoting bug fixed in PublicQueryExecutionService, EVERY saved query beyond a
-- bare `SELECT 1` failed. Fix: drop the old views, recreate with exact-cased names matching
-- AlaSQL's table names (`"tasks"`, `"taskTypes"`, ... — double-quoted at creation so Postgres
-- doesn't fold them to lowercase) and every column aliased to its TABLE_SCHEMAS camelCase name.
--
-- Fields backed by a junction table client-side (dependencies, documentIds, principleIds,
-- objectiveIds, riskIds, relatedDocumentIds, memberIds) are exposed via a correlated `array_agg`
-- subquery — there's no single column to alias. `members.name`/`members.email` come from a JOIN to
-- "Users" (ProjectMember itself has no display name/email — see MemberDto), which works without
-- granting enkl_public_query direct access to "Users": Postgres views run with the VIEW OWNER's
-- privileges by default (security_invoker is off unless set), so the low-privilege role only ever
-- needs SELECT on the view itself. `tasks.isPrivate` has no server-side column at all (a
-- local-storage-only concept, never synced — see mutations.js) and is exposed as a literal NULL so
-- a saved query referencing it doesn't error.
DROP VIEW IF EXISTS query_tasks;
DROP VIEW IF EXISTS query_columns;
DROP VIEW IF EXISTS query_members;
DROP VIEW IF EXISTS query_risks;
DROP VIEW IF EXISTS query_decisions;
DROP VIEW IF EXISTS query_principles;
DROP VIEW IF EXISTS query_objectives;
DROP VIEW IF EXISTS query_documents;
DROP VIEW IF EXISTS query_releases;
DROP VIEW IF EXISTS query_task_types;
DROP VIEW IF EXISTS query_teams_committees;

CREATE VIEW "tasks" AS
    SELECT
        t."Id" AS "id", t."Key" AS "key", t."Title" AS "title",
        t."Description" AS "description", t."Priority" AS "priority",
        t."ColumnId" AS "columnId",
        (SELECT array_agg(td."DependsOnTaskId") FROM "TaskDependencies" td WHERE td."TaskId" = t."Id") AS "dependencies",
        t."AssigneeId" AS "assigneeId", t."ReleaseId" AS "releaseId", t."TypeId" AS "typeId",
        t."DocumentationUrl" AS "documentationUrl", t."StartDate" AS "startDate", t."EndDate" AS "endDate",
        t."BusinessValue" AS "businessValue", t."TaskCost" AS "taskCost", t."Progress" AS "progress",
        t."EstimatedEffort" AS "estimatedEffort", t."ActualEffort" AS "actualEffort", t."Archived" AS "archived",
        NULL::boolean AS "isPrivate",
        t."DateCreated" AS "dateCreated", t."DateLastModified" AS "dateLastModified",
        t."DateDone" AS "dateDone", t."ParentTaskId" AS "parentTaskId"
    FROM "Tasks" t
    WHERE t."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "columns" AS
    SELECT c."Id" AS "id", c."Name" AS "name", c."Done" AS "done",
        c."Order" AS "order", c."Color" AS "color", c."Cap" AS "cap"
    FROM "Columns" c
    WHERE c."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "members" AS
    SELECT
        m."Id" AS "id", u."DisplayName" AS "name", u."EmailAddress" AS "email",
        m."Color" AS "color", m."Role" AS "role", m."AllocatedFraction" AS "allocatedFraction",
        m."ReportsToId" AS "reportsToId", m."IsProjectAdmin" AS "isProjectAdmin"
    FROM "ProjectMembers" m
    JOIN "Users" u ON u."Id" = m."UserId"
    WHERE m."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "risks" AS
    SELECT
        r."Id" AS "id", r."Key" AS "key", r."Title" AS "title", r."Description" AS "description",
        r."Likelihood" AS "likelihood", r."Impact" AS "impact", r."Mitigations" AS "mitigations",
        r."OwnerId" AS "ownerId", r."TaskId" AS "taskId",
        (SELECT array_agg(rd."DocumentId") FROM "RiskDocument" rd WHERE rd."RiskId" = r."Id") AS "documentIds",
        (SELECT array_agg(rp."PrincipleId") FROM "RiskPrinciple" rp WHERE rp."RiskId" = r."Id") AS "principleIds",
        (SELECT array_agg(ro."ObjectiveId") FROM "RiskObjective" ro WHERE ro."RiskId" = r."Id") AS "objectiveIds",
        r."Status" AS "status", r."DateToClose" AS "dateToClose", r."DateClosed" AS "dateClosed",
        r."DateCreated" AS "dateCreated", r."DateLastModified" AS "dateLastModified"
    FROM "Risks" r
    WHERE r."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "decisions" AS
    SELECT
        d."Id" AS "id", d."Key" AS "key", d."Title" AS "title", d."Description" AS "description",
        d."Type" AS "type", d."Status" AS "status", d."Outcome" AS "outcome", d."OwnerId" AS "ownerId",
        d."Approver" AS "approver", d."TaskId" AS "taskId",
        (SELECT array_agg(dd."DocumentId") FROM "DecisionDocument" dd WHERE dd."DecisionId" = d."Id") AS "documentIds",
        (SELECT array_agg(dr."RiskId") FROM "DecisionRisk" dr WHERE dr."DecisionId" = d."Id") AS "riskIds",
        (SELECT array_agg(dp."PrincipleId") FROM "DecisionPrinciple" dp WHERE dp."DecisionId" = d."Id") AS "principleIds",
        (SELECT array_agg(dob."ObjectiveId") FROM "DecisionObjective" dob WHERE dob."DecisionId" = d."Id") AS "objectiveIds",
        d."DateCreated" AS "dateCreated", d."DateLastModified" AS "dateLastModified"
    FROM "Decisions" d
    WHERE d."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "principles" AS
    SELECT p."Id" AS "id", p."Key" AS "key", p."Title" AS "title", p."Description" AS "description",
        p."DocumentUrl" AS "documentUrl", p."DateCreated" AS "dateCreated", p."DateLastModified" AS "dateLastModified"
    FROM "Principles" p
    WHERE p."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "objectives" AS
    SELECT o."Id" AS "id", o."Key" AS "key", o."Title" AS "title", o."Description" AS "description",
        (SELECT array_agg(op."PrincipleId") FROM "ObjectivePrinciple" op WHERE op."ObjectiveId" = o."Id") AS "principleIds",
        o."DateCreated" AS "dateCreated", o."DateLastModified" AS "dateLastModified"
    FROM "Objectives" o
    WHERE o."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "documents" AS
    SELECT doc."Id" AS "id", doc."Key" AS "key", doc."Title" AS "title", doc."Url" AS "url",
        doc."Description" AS "description", doc."OwnerId" AS "ownerId", doc."TaskId" AS "taskId",
        (SELECT array_agg(dr."RelatedDocumentId") FROM "DocumentRelation" dr WHERE dr."DocumentId" = doc."Id") AS "relatedDocumentIds",
        doc."DateCreated" AS "dateCreated", doc."DateLastModified" AS "dateLastModified"
    FROM "Documents" doc
    WHERE doc."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "releases" AS
    SELECT rl."Id" AS "id", rl."Name" AS "name", rl."Status" AS "status", rl."OwnerId" AS "ownerId",
        rl."StartDate" AS "startDate", rl."EndDate" AS "endDate",
        rl."DateCreated" AS "dateCreated", rl."DateLastModified" AS "dateLastModified"
    FROM "Releases" rl
    WHERE rl."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "taskTypes" AS
    SELECT tt."Id" AS "id", tt."Name" AS "name", tt."IconName" AS "iconName"
    FROM "TaskTypes" tt
    WHERE tt."ProjectId" = current_setting('app.query_project_id', true)::uuid;

CREATE VIEW "teamsCommittees" AS
    SELECT tc."Id" AS "id", tc."Key" AS "key", tc."Name" AS "name", tc."Description" AS "description",
        tc."Type" AS "type", tc."ParentId" AS "parentId",
        (SELECT array_agg(tcm."ProjectMemberId") FROM "TeamCommitteeMember" tcm WHERE tcm."TeamCommitteeId" = tc."Id") AS "memberIds",
        tc."DateCreated" AS "dateCreated", tc."DateLastModified" AS "dateLastModified"
    FROM "TeamsCommittees" tc
    WHERE tc."ProjectId" = current_setting('app.query_project_id', true)::uuid;

GRANT SELECT ON
    "tasks", "columns", "members", "risks", "decisions", "principles",
    "objectives", "documents", "releases", "taskTypes", "teamsCommittees"
TO enkl_public_query;
