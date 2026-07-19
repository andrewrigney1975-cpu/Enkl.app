-- Consolidated current-end-state schema — this tier intentionally does NOT replay php-api's 28
-- historical incremental migration files one-for-one (there's no existing MariaDB data to carry
-- forward), it just produces the same final schema those 28 files converge on. Every table below
-- already includes columns/indexes that php-api only reached after several later ALTERs — see each
-- table's own comment for which later php-api migration a given column/index traces back to. See
-- mariadb-api/CLAUDE.md for the full column-type-mapping table (uuid->CHAR(36), jsonb->JSON,
-- timestamptz->DATETIME(6), bigserial->BIGINT AUTO_INCREMENT) and why ANSI_QUOTES (set per-connection
-- in Db/Database.php) is what lets every identifier below stay double-quoted exactly like the
-- Postgres tiers' own migrations.
--
-- FK ON DELETE behavior is load-bearing application logic, not incidental (ported verbatim from
-- php-api/src/Db/migrations/001_initial_schema.sql's own note): Restrict FKs (Tasks -> Columns,
-- Tasks -> parent Task, TaskDependencies -> DependsOnTask, ProjectMembers -> ReportsTo,
-- ProjectMembers -> Users, Projects -> Organisations, TeamsCommittees -> parent TeamCommittee) are
-- exactly the relationships whose service-layer code must explicitly clean up/orphan/reject before a
-- delete would otherwise fail. Every plain ProjectId FK is Cascade, which is what makes "delete a
-- Project" safe to implement as a single DELETE and let the DB do the rest.

CREATE TABLE "Organisations" (
    "Id" CHAR(36) PRIMARY KEY,
    "Name" VARCHAR(200) NOT NULL,
    "NormalizedName" VARCHAR(200) NOT NULL,
    "CreatedAt" DATETIME(6) NOT NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Organisations_NormalizedName" ON "Organisations" ("NormalizedName");

-- Merges php-api's 004 (EmailAddress/NormalizedEmailAddress), 005 (PasswordHash nullable + IsActive,
-- for SSO-only/SCIM-deprovisioned accounts), and 010 (SecurityStamp — JWT revocation check, security
-- review finding H2) straight into the base table. SecurityStamp has NO DB-side default here (unlike
-- php-api's `DEFAULT gen_random_uuid()`, which only exists because Postgres 13+ ships it natively) —
-- every INSERT INTO "Users" across this tier's ported Services already supplies its own
-- app-generated UUID for every other UUID column, so SecurityStamp just does the same
-- (Support/Uuid::v4()), needing no DB default at all.
CREATE TABLE "Users" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Username" VARCHAR(64) NOT NULL,
    "NormalizedUsername" VARCHAR(64) NOT NULL,
    "PasswordHash" TEXT NULL,
    "DisplayName" VARCHAR(200) NOT NULL,
    "MustChangePassword" BOOLEAN NOT NULL,
    "IsOrgAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
    "CreatedAt" DATETIME(6) NOT NULL,
    "EmailAddress" VARCHAR(320) NULL,
    "NormalizedEmailAddress" VARCHAR(320) NULL,
    "IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "SecurityStamp" CHAR(36) NOT NULL,
    CONSTRAINT "FK_Users_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Users_NormalizedUsername" ON "Users" ("NormalizedUsername");
CREATE INDEX "IX_Users_OrganisationId" ON "Users" ("OrganisationId");
-- InnoDB unique indexes already treat multiple NULLs as distinct (same as Postgres), so this is a
-- plain unique index rather than needing php-api's later org-scoping migration (020) replayed — it
-- lands here as the only index this column ever needed.
CREATE UNIQUE INDEX "IX_Users_NormalizedEmailAddress" ON "Users" ("NormalizedEmailAddress");

-- PortfolioCategories is created before Projects (unlike php-api's own migration order, where it
-- arrives much later in 013) purely so Projects.CategoryId's FK can be declared inline instead of a
-- separate ALTER — no behavioral difference, this is consolidation, not new design.
CREATE TABLE "PortfolioCategories" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Name" VARCHAR(100) NOT NULL,
    "SortOrder" INT NOT NULL,
    CONSTRAINT "FK_PortfolioCategories_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_PortfolioCategories_OrganisationId" ON "PortfolioCategories" ("OrganisationId");

-- Merges php-api's 013 (IsActive/Priority/CategoryId — Portfolio Planner) and 019 (Description)
-- straight in. The unique index is the org-scoped shape php-api only reached after its own 020 fixed
-- a real cross-org collision bug (see that migration's history for the story) — no need to replay
-- the original global-unique-then-fixed sequence here.
CREATE TABLE "Projects" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "StartDate" DATE NULL,
    "EndDate" DATE NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    "DateLastExported" DATETIME(6) NULL,
    "TaskCounter" INT NOT NULL,
    "HeaderButtonVisibilityJson" JSON NOT NULL DEFAULT '{}',
    "WorkflowJson" JSON NULL,
    "IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "Priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
    "CategoryId" CHAR(36) NULL,
    "Description" TEXT NULL,
    CONSTRAINT "FK_Projects_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE RESTRICT,
    CONSTRAINT "FK_Projects_PortfolioCategories" FOREIGN KEY ("CategoryId") REFERENCES "PortfolioCategories" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Projects_OrganisationId_Key" ON "Projects" ("OrganisationId", "Key");
CREATE INDEX "IX_Projects_CategoryId" ON "Projects" ("CategoryId");

-- Merges php-api's 018 (Cap — WIP limit, see workflow-engine.js's evaluateColumnCap).
CREATE TABLE "Columns" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Name" VARCHAR(100) NOT NULL,
    "Done" BOOLEAN NOT NULL,
    "Color" VARCHAR(20) NULL,
    "Order" INT NOT NULL,
    "Cap" INT NOT NULL DEFAULT -1,
    CONSTRAINT "FK_Columns_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_Columns_ProjectId" ON "Columns" ("ProjectId");

-- Merges php-api's 015 (AllocatedFraction) and 021 (IsProjectAdmin — the Project Administrator role).
CREATE TABLE "ProjectMembers" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "UserId" CHAR(36) NOT NULL,
    "Color" VARCHAR(20) NOT NULL,
    "Role" VARCHAR(100) NULL,
    "ReportsToId" CHAR(36) NULL,
    "AllocatedFraction" INT NULL,
    "IsProjectAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT "FK_ProjectMembers_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ProjectMembers_Users" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE RESTRICT,
    CONSTRAINT "FK_ProjectMembers_ReportsTo" FOREIGN KEY ("ReportsToId") REFERENCES "ProjectMembers" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_ProjectMembers_ProjectId_UserId" ON "ProjectMembers" ("ProjectId", "UserId");
CREATE INDEX "IX_ProjectMembers_UserId" ON "ProjectMembers" ("UserId");
CREATE INDEX "IX_ProjectMembers_ReportsToId" ON "ProjectMembers" ("ReportsToId");

CREATE TABLE "Releases" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "Status" VARCHAR(20) NOT NULL,
    "OwnerId" CHAR(36) NULL,
    "StartDate" DATE NULL,
    "EndDate" DATE NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Releases_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Releases_Owner" FOREIGN KEY ("OwnerId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_Releases_ProjectId" ON "Releases" ("ProjectId");
CREATE INDEX "IX_Releases_OwnerId" ON "Releases" ("OwnerId");

CREATE TABLE "TaskTypes" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Name" VARCHAR(100) NOT NULL,
    "IconName" VARCHAR(50) NULL,
    CONSTRAINT "FK_TaskTypes_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_TaskTypes_ProjectId" ON "TaskTypes" ("ProjectId");

CREATE TABLE "Tasks" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Description" TEXT NULL,
    "Priority" VARCHAR(20) NOT NULL,
    "ColumnId" CHAR(36) NOT NULL,
    "AssigneeId" CHAR(36) NULL,
    "ReleaseId" CHAR(36) NULL,
    "TypeId" CHAR(36) NULL,
    "ParentTaskId" CHAR(36) NULL,
    "DocumentationUrl" TEXT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    "DateDone" DATETIME(6) NULL,
    "StartDate" DATE NULL,
    "EndDate" DATE NULL,
    "BusinessValue" INT NULL,
    "TaskCost" INT NULL,
    "Progress" INT NOT NULL,
    "EstimatedEffort" DECIMAL(18,4) NULL,
    "ActualEffort" DECIMAL(18,4) NULL,
    "Archived" BOOLEAN NOT NULL,
    CONSTRAINT "FK_Tasks_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Tasks_Columns" FOREIGN KEY ("ColumnId") REFERENCES "Columns" ("Id") ON DELETE RESTRICT,
    CONSTRAINT "FK_Tasks_Assignee" FOREIGN KEY ("AssigneeId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Tasks_Releases" FOREIGN KEY ("ReleaseId") REFERENCES "Releases" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Tasks_TaskTypes" FOREIGN KEY ("TypeId") REFERENCES "TaskTypes" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Tasks_ParentTask" FOREIGN KEY ("ParentTaskId") REFERENCES "Tasks" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Tasks_ProjectId_Key" ON "Tasks" ("ProjectId", "Key");
CREATE INDEX "IX_Tasks_ColumnId" ON "Tasks" ("ColumnId");
CREATE INDEX "IX_Tasks_AssigneeId" ON "Tasks" ("AssigneeId");
CREATE INDEX "IX_Tasks_ReleaseId" ON "Tasks" ("ReleaseId");
CREATE INDEX "IX_Tasks_TypeId" ON "Tasks" ("TypeId");
CREATE INDEX "IX_Tasks_ParentTaskId" ON "Tasks" ("ParentTaskId");

CREATE TABLE "TaskDependencies" (
    "TaskId" CHAR(36) NOT NULL,
    "DependsOnTaskId" CHAR(36) NOT NULL,
    PRIMARY KEY ("TaskId", "DependsOnTaskId"),
    CONSTRAINT "FK_TaskDependencies_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_TaskDependencies_DependsOnTask" FOREIGN KEY ("DependsOnTaskId") REFERENCES "Tasks" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE INDEX "IX_TaskDependencies_DependsOnTaskId" ON "TaskDependencies" ("DependsOnTaskId");

CREATE TABLE "TaskAuditLogEntries" (
    "Id" CHAR(36) PRIMARY KEY,
    "TaskId" CHAR(36) NOT NULL,
    "Timestamp" DATETIME(6) NOT NULL,
    "Field" VARCHAR(100) NOT NULL,
    "OldValue" TEXT NULL,
    "NewValue" TEXT NULL,
    "ChangedBy" VARCHAR(200) NULL,
    CONSTRAINT "FK_TaskAuditLogEntries_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_TaskAuditLogEntries_TaskId" ON "TaskAuditLogEntries" ("TaskId");
