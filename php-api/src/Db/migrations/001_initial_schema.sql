-- Initial schema — ported field-for-field, index-for-index, and (most importantly) FK-behavior-for-
-- FK-behavior from the .NET API's EF Core migrations (api/Enkl.Api/Data/Migrations), verified against
-- a live dump of that schema rather than reconstructed from the C# entity classes by hand. This is a
-- single consolidated migration rather than mirroring the .NET side's 3 incremental migrations one-
-- for-one, since a brand-new standalone deployment has no history to replay — it just needs the
-- current end state.
--
-- FK ON DELETE behavior is load-bearing application logic, not incidental: Restrict FKs (TaskItem →
-- Column, TaskItem → parent TaskItem, TaskDependency → DependsOnTask, ProjectMember → ReportsTo,
-- ProjectMember → User, Project → Organisation, TeamCommittee → parent TeamCommittee) are exactly the
-- relationships whose service-layer code must explicitly clean up/orphan/reject before a delete would
-- otherwise fail — see the PHP service ports for each of these. Every plain ProjectId FK is Cascade,
-- which is what makes "delete a Project" safe to implement as a single DELETE and let Postgres do the
-- rest (verified empirically against the .NET version's live DB during that feature's build).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid(), used as the default in a couple of tests/tools; app code always supplies its own UUIDs

CREATE TABLE "Organisations" (
    "Id" uuid PRIMARY KEY,
    "Name" varchar(200) NOT NULL,
    "NormalizedName" varchar(200) NOT NULL,
    "CreatedAt" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Organisations_NormalizedName" ON "Organisations" ("NormalizedName");

CREATE TABLE "Users" (
    "Id" uuid PRIMARY KEY,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE RESTRICT,
    "Username" varchar(64) NOT NULL,
    "NormalizedUsername" varchar(64) NOT NULL,
    "PasswordHash" text NOT NULL,
    "DisplayName" varchar(200) NOT NULL,
    "MustChangePassword" boolean NOT NULL,
    "IsOrgAdmin" boolean NOT NULL DEFAULT false,
    "CreatedAt" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Users_NormalizedUsername" ON "Users" ("NormalizedUsername");
CREATE INDEX "IX_Users_OrganisationId" ON "Users" ("OrganisationId");

CREATE TABLE "Projects" (
    "Id" uuid PRIMARY KEY,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE RESTRICT,
    "Name" varchar(200) NOT NULL,
    "Key" varchar(20) NOT NULL,
    "StartDate" date,
    "EndDate" date,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL,
    "DateLastExported" timestamptz,
    "TaskCounter" integer NOT NULL,
    "HeaderButtonVisibilityJson" jsonb NOT NULL DEFAULT '{}',
    "WorkflowJson" jsonb
);
CREATE UNIQUE INDEX "IX_Projects_Key" ON "Projects" ("Key");
CREATE INDEX "IX_Projects_OrganisationId" ON "Projects" ("OrganisationId");

CREATE TABLE "Columns" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Name" varchar(100) NOT NULL,
    "Done" boolean NOT NULL,
    "Color" varchar(20),
    "Order" integer NOT NULL
);
CREATE INDEX "IX_Columns_ProjectId" ON "Columns" ("ProjectId");

CREATE TABLE "ProjectMembers" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "UserId" uuid NOT NULL REFERENCES "Users" ("Id") ON DELETE RESTRICT,
    "Color" varchar(20) NOT NULL,
    "Role" varchar(100),
    "ReportsToId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "IX_ProjectMembers_ProjectId_UserId" ON "ProjectMembers" ("ProjectId", "UserId");
CREATE INDEX "IX_ProjectMembers_UserId" ON "ProjectMembers" ("UserId");
CREATE INDEX "IX_ProjectMembers_ReportsToId" ON "ProjectMembers" ("ReportsToId");

CREATE TABLE "Releases" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Name" varchar(200) NOT NULL,
    "Status" varchar(20) NOT NULL,
    "OwnerId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "StartDate" date,
    "EndDate" date,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_Releases_ProjectId" ON "Releases" ("ProjectId");
CREATE INDEX "IX_Releases_OwnerId" ON "Releases" ("OwnerId");

CREATE TABLE "TaskTypes" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Name" varchar(100) NOT NULL,
    "IconName" varchar(50)
);
CREATE INDEX "IX_TaskTypes_ProjectId" ON "TaskTypes" ("ProjectId");

CREATE TABLE "Tasks" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Description" text,
    "Priority" varchar(20) NOT NULL,
    "ColumnId" uuid NOT NULL REFERENCES "Columns" ("Id") ON DELETE RESTRICT,
    "AssigneeId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "ReleaseId" uuid REFERENCES "Releases" ("Id") ON DELETE SET NULL,
    "TypeId" uuid REFERENCES "TaskTypes" ("Id") ON DELETE SET NULL,
    "ParentTaskId" uuid REFERENCES "Tasks" ("Id") ON DELETE RESTRICT,
    "DocumentationUrl" text,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL,
    "DateDone" timestamptz,
    "StartDate" date,
    "EndDate" date,
    "BusinessValue" integer,
    "TaskCost" integer,
    "Progress" integer NOT NULL,
    "EstimatedEffort" numeric,
    "ActualEffort" numeric,
    "Archived" boolean NOT NULL
);
CREATE UNIQUE INDEX "IX_Tasks_ProjectId_Key" ON "Tasks" ("ProjectId", "Key");
CREATE INDEX "IX_Tasks_ColumnId" ON "Tasks" ("ColumnId");
CREATE INDEX "IX_Tasks_AssigneeId" ON "Tasks" ("AssigneeId");
CREATE INDEX "IX_Tasks_ReleaseId" ON "Tasks" ("ReleaseId");
CREATE INDEX "IX_Tasks_TypeId" ON "Tasks" ("TypeId");
CREATE INDEX "IX_Tasks_ParentTaskId" ON "Tasks" ("ParentTaskId");

CREATE TABLE "TaskDependencies" (
    "TaskId" uuid NOT NULL REFERENCES "Tasks" ("Id") ON DELETE CASCADE,
    "DependsOnTaskId" uuid NOT NULL REFERENCES "Tasks" ("Id") ON DELETE RESTRICT,
    PRIMARY KEY ("TaskId", "DependsOnTaskId")
);
CREATE INDEX "IX_TaskDependencies_DependsOnTaskId" ON "TaskDependencies" ("DependsOnTaskId");

CREATE TABLE "TaskAuditLogEntries" (
    "Id" uuid PRIMARY KEY,
    "TaskId" uuid NOT NULL REFERENCES "Tasks" ("Id") ON DELETE CASCADE,
    "Timestamp" timestamptz NOT NULL,
    "Field" varchar(100) NOT NULL,
    "OldValue" text,
    "NewValue" text,
    "ChangedBy" varchar(200)
);
CREATE INDEX "IX_TaskAuditLogEntries_TaskId" ON "TaskAuditLogEntries" ("TaskId");

CREATE TABLE "Principles" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Description" text,
    "DocumentUrl" text,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Principles_ProjectId_Key" ON "Principles" ("ProjectId", "Key");

CREATE TABLE "Documents" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Url" text,
    "Description" text,
    "OwnerId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "TaskId" uuid REFERENCES "Tasks" ("Id") ON DELETE SET NULL,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Documents_ProjectId_Key" ON "Documents" ("ProjectId", "Key");
CREATE INDEX "IX_Documents_OwnerId" ON "Documents" ("OwnerId");
CREATE INDEX "IX_Documents_TaskId" ON "Documents" ("TaskId");

CREATE TABLE "DocumentRelation" (
    "DocumentId" uuid NOT NULL REFERENCES "Documents" ("Id") ON DELETE CASCADE,
    "RelatedDocumentId" uuid NOT NULL REFERENCES "Documents" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("DocumentId", "RelatedDocumentId")
);
CREATE INDEX "IX_DocumentRelation_RelatedDocumentId" ON "DocumentRelation" ("RelatedDocumentId");

CREATE TABLE "Risks" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Description" text,
    "Likelihood" integer NOT NULL,
    "Impact" integer NOT NULL,
    "Mitigations" text,
    "OwnerId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "TaskId" uuid REFERENCES "Tasks" ("Id") ON DELETE SET NULL,
    "Status" varchar(20) NOT NULL,
    "DateToClose" date,
    "DateClosed" date,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Risks_ProjectId_Key" ON "Risks" ("ProjectId", "Key");
CREATE INDEX "IX_Risks_OwnerId" ON "Risks" ("OwnerId");
CREATE INDEX "IX_Risks_TaskId" ON "Risks" ("TaskId");

CREATE TABLE "RiskDocument" (
    "RiskId" uuid NOT NULL REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    "DocumentId" uuid NOT NULL REFERENCES "Documents" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("RiskId", "DocumentId")
);
CREATE INDEX "IX_RiskDocument_DocumentId" ON "RiskDocument" ("DocumentId");

CREATE TABLE "Objectives" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Description" text,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Objectives_ProjectId_Key" ON "Objectives" ("ProjectId", "Key");

CREATE TABLE "RiskPrinciple" (
    "RiskId" uuid NOT NULL REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    "PrincipleId" uuid NOT NULL REFERENCES "Principles" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("RiskId", "PrincipleId")
);
CREATE INDEX "IX_RiskPrinciple_PrincipleId" ON "RiskPrinciple" ("PrincipleId");

CREATE TABLE "RiskObjective" (
    "RiskId" uuid NOT NULL REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    "ObjectiveId" uuid NOT NULL REFERENCES "Objectives" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("RiskId", "ObjectiveId")
);
CREATE INDEX "IX_RiskObjective_ObjectiveId" ON "RiskObjective" ("ObjectiveId");

CREATE TABLE "ObjectivePrinciple" (
    "ObjectiveId" uuid NOT NULL REFERENCES "Objectives" ("Id") ON DELETE CASCADE,
    "PrincipleId" uuid NOT NULL REFERENCES "Principles" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("ObjectiveId", "PrincipleId")
);
CREATE INDEX "IX_ObjectivePrinciple_PrincipleId" ON "ObjectivePrinciple" ("PrincipleId");

CREATE TABLE "TeamsCommittees" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Name" varchar(200) NOT NULL,
    "Description" text,
    "Type" varchar(20) NOT NULL,
    "ParentId" uuid REFERENCES "TeamsCommittees" ("Id") ON DELETE RESTRICT,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_TeamsCommittees_ProjectId_Key" ON "TeamsCommittees" ("ProjectId", "Key");
CREATE INDEX "IX_TeamsCommittees_ParentId" ON "TeamsCommittees" ("ParentId");

CREATE TABLE "TeamCommitteeMember" (
    "TeamCommitteeId" uuid NOT NULL REFERENCES "TeamsCommittees" ("Id") ON DELETE CASCADE,
    "ProjectMemberId" uuid NOT NULL REFERENCES "ProjectMembers" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("TeamCommitteeId", "ProjectMemberId")
);
CREATE INDEX "IX_TeamCommitteeMember_ProjectMemberId" ON "TeamCommitteeMember" ("ProjectMemberId");

CREATE TABLE "Decisions" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "Key" varchar(20) NOT NULL,
    "Title" varchar(500) NOT NULL,
    "Description" text,
    "Type" varchar(20) NOT NULL,
    "Status" varchar(20) NOT NULL,
    "Outcome" text,
    "OwnerId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "Approver" varchar(200),
    "TaskId" uuid REFERENCES "Tasks" ("Id") ON DELETE SET NULL,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Decisions_ProjectId_Key" ON "Decisions" ("ProjectId", "Key");
CREATE INDEX "IX_Decisions_OwnerId" ON "Decisions" ("OwnerId");
CREATE INDEX "IX_Decisions_TaskId" ON "Decisions" ("TaskId");

CREATE TABLE "DecisionDocument" (
    "DecisionId" uuid NOT NULL REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    "DocumentId" uuid NOT NULL REFERENCES "Documents" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("DecisionId", "DocumentId")
);
CREATE INDEX "IX_DecisionDocument_DocumentId" ON "DecisionDocument" ("DocumentId");

CREATE TABLE "DecisionRisk" (
    "DecisionId" uuid NOT NULL REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    "RiskId" uuid NOT NULL REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("DecisionId", "RiskId")
);
CREATE INDEX "IX_DecisionRisk_RiskId" ON "DecisionRisk" ("RiskId");

CREATE TABLE "DecisionPrinciple" (
    "DecisionId" uuid NOT NULL REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    "PrincipleId" uuid NOT NULL REFERENCES "Principles" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("DecisionId", "PrincipleId")
);
CREATE INDEX "IX_DecisionPrinciple_PrincipleId" ON "DecisionPrinciple" ("PrincipleId");

CREATE TABLE "DecisionObjective" (
    "DecisionId" uuid NOT NULL REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    "ObjectiveId" uuid NOT NULL REFERENCES "Objectives" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("DecisionId", "ObjectiveId")
);
CREATE INDEX "IX_DecisionObjective_ObjectiveId" ON "DecisionObjective" ("ObjectiveId");
