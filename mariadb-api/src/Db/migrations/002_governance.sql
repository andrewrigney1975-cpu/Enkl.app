-- Principles/Documents/Risks/Objectives/TeamsCommittees/Decisions/Retrospectives — consolidated from
-- php-api's own 001 (base tables) + 008 (Retrospectives feature, Principle.OrganisationId/
-- IsOrganisationWide sharing columns). See 001_initial_schema.sql's header comment for the general
-- consolidation approach.
--
-- TeamsCommittees."SourceOrgTeamId" is declared here but its FK constraint/index are added in
-- 003_sso_scim.sql, AFTER "OrgTeams" exists (that table isn't created until this file's follow-on) —
-- same forward-reference-avoidance reason php-api's own history has this column arrive in a later
-- migration (006) than TeamsCommittees' own creation (001).

-- Merges php-api's 008 (OrganisationId denormalized from Project.OrganisationId, IsOrganisationWide)
-- straight into the base table — no nullable-then-backfill-then-constrain two-step needed here since
-- there's no existing data.
CREATE TABLE "Principles" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "OrganisationId" CHAR(36) NOT NULL,
    "IsOrganisationWide" BOOLEAN NOT NULL DEFAULT FALSE,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Description" TEXT NULL,
    "DocumentUrl" TEXT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Principles_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Principles_ProjectId_Key" ON "Principles" ("ProjectId", "Key");
CREATE INDEX "IX_Principles_OrganisationId_IsOrganisationWide" ON "Principles" ("OrganisationId", "IsOrganisationWide");

CREATE TABLE "Documents" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Url" TEXT NULL,
    "Description" TEXT NULL,
    "OwnerId" CHAR(36) NULL,
    "TaskId" CHAR(36) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Documents_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Documents_Owner" FOREIGN KEY ("OwnerId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Documents_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Documents_ProjectId_Key" ON "Documents" ("ProjectId", "Key");
CREATE INDEX "IX_Documents_OwnerId" ON "Documents" ("OwnerId");
CREATE INDEX "IX_Documents_TaskId" ON "Documents" ("TaskId");

CREATE TABLE "DocumentRelation" (
    "DocumentId" CHAR(36) NOT NULL,
    "RelatedDocumentId" CHAR(36) NOT NULL,
    PRIMARY KEY ("DocumentId", "RelatedDocumentId"),
    CONSTRAINT "FK_DocumentRelation_Document" FOREIGN KEY ("DocumentId") REFERENCES "Documents" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_DocumentRelation_RelatedDocument" FOREIGN KEY ("RelatedDocumentId") REFERENCES "Documents" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_DocumentRelation_RelatedDocumentId" ON "DocumentRelation" ("RelatedDocumentId");

CREATE TABLE "Risks" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Description" TEXT NULL,
    "Likelihood" INT NOT NULL,
    "Impact" INT NOT NULL,
    "Mitigations" TEXT NULL,
    "OwnerId" CHAR(36) NULL,
    "TaskId" CHAR(36) NULL,
    "Status" VARCHAR(20) NOT NULL,
    "DateToClose" DATE NULL,
    "DateClosed" DATE NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Risks_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Risks_Owner" FOREIGN KEY ("OwnerId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Risks_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Risks_ProjectId_Key" ON "Risks" ("ProjectId", "Key");
CREATE INDEX "IX_Risks_OwnerId" ON "Risks" ("OwnerId");
CREATE INDEX "IX_Risks_TaskId" ON "Risks" ("TaskId");

CREATE TABLE "RiskDocument" (
    "RiskId" CHAR(36) NOT NULL,
    "DocumentId" CHAR(36) NOT NULL,
    PRIMARY KEY ("RiskId", "DocumentId"),
    CONSTRAINT "FK_RiskDocument_Risk" FOREIGN KEY ("RiskId") REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RiskDocument_Document" FOREIGN KEY ("DocumentId") REFERENCES "Documents" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_RiskDocument_DocumentId" ON "RiskDocument" ("DocumentId");

CREATE TABLE "Objectives" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Description" TEXT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Objectives_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Objectives_ProjectId_Key" ON "Objectives" ("ProjectId", "Key");

CREATE TABLE "RiskPrinciple" (
    "RiskId" CHAR(36) NOT NULL,
    "PrincipleId" CHAR(36) NOT NULL,
    PRIMARY KEY ("RiskId", "PrincipleId"),
    CONSTRAINT "FK_RiskPrinciple_Risk" FOREIGN KEY ("RiskId") REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RiskPrinciple_Principle" FOREIGN KEY ("PrincipleId") REFERENCES "Principles" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_RiskPrinciple_PrincipleId" ON "RiskPrinciple" ("PrincipleId");

CREATE TABLE "RiskObjective" (
    "RiskId" CHAR(36) NOT NULL,
    "ObjectiveId" CHAR(36) NOT NULL,
    PRIMARY KEY ("RiskId", "ObjectiveId"),
    CONSTRAINT "FK_RiskObjective_Risk" FOREIGN KEY ("RiskId") REFERENCES "Risks" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RiskObjective_Objective" FOREIGN KEY ("ObjectiveId") REFERENCES "Objectives" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_RiskObjective_ObjectiveId" ON "RiskObjective" ("ObjectiveId");

CREATE TABLE "ObjectivePrinciple" (
    "ObjectiveId" CHAR(36) NOT NULL,
    "PrincipleId" CHAR(36) NOT NULL,
    PRIMARY KEY ("ObjectiveId", "PrincipleId"),
    CONSTRAINT "FK_ObjectivePrinciple_Objective" FOREIGN KEY ("ObjectiveId") REFERENCES "Objectives" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ObjectivePrinciple_Principle" FOREIGN KEY ("PrincipleId") REFERENCES "Principles" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_ObjectivePrinciple_PrincipleId" ON "ObjectivePrinciple" ("PrincipleId");

-- "SourceOrgTeamId" FK constraint/index added in 003_sso_scim.sql, after "OrgTeams" exists.
CREATE TABLE "TeamsCommittees" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "Description" TEXT NULL,
    "Type" VARCHAR(20) NOT NULL,
    "ParentId" CHAR(36) NULL,
    "SourceOrgTeamId" CHAR(36) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_TeamsCommittees_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_TeamsCommittees_Parent" FOREIGN KEY ("ParentId") REFERENCES "TeamsCommittees" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_TeamsCommittees_ProjectId_Key" ON "TeamsCommittees" ("ProjectId", "Key");
CREATE INDEX "IX_TeamsCommittees_ParentId" ON "TeamsCommittees" ("ParentId");

CREATE TABLE "TeamCommitteeMember" (
    "TeamCommitteeId" CHAR(36) NOT NULL,
    "ProjectMemberId" CHAR(36) NOT NULL,
    PRIMARY KEY ("TeamCommitteeId", "ProjectMemberId"),
    CONSTRAINT "FK_TeamCommitteeMember_TeamCommittee" FOREIGN KEY ("TeamCommitteeId") REFERENCES "TeamsCommittees" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_TeamCommitteeMember_ProjectMember" FOREIGN KEY ("ProjectMemberId") REFERENCES "ProjectMembers" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_TeamCommitteeMember_ProjectMemberId" ON "TeamCommitteeMember" ("ProjectMemberId");

CREATE TABLE "Decisions" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Title" VARCHAR(500) NOT NULL,
    "Description" TEXT NULL,
    "Type" VARCHAR(20) NOT NULL,
    "Status" VARCHAR(20) NOT NULL,
    "Outcome" TEXT NULL,
    "OwnerId" CHAR(36) NULL,
    "Approver" VARCHAR(200) NULL,
    "TaskId" CHAR(36) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Decisions_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Decisions_Owner" FOREIGN KEY ("OwnerId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    CONSTRAINT "FK_Decisions_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Decisions_ProjectId_Key" ON "Decisions" ("ProjectId", "Key");
CREATE INDEX "IX_Decisions_OwnerId" ON "Decisions" ("OwnerId");
CREATE INDEX "IX_Decisions_TaskId" ON "Decisions" ("TaskId");

CREATE TABLE "DecisionDocument" (
    "DecisionId" CHAR(36) NOT NULL,
    "DocumentId" CHAR(36) NOT NULL,
    PRIMARY KEY ("DecisionId", "DocumentId"),
    CONSTRAINT "FK_DecisionDocument_Decision" FOREIGN KEY ("DecisionId") REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_DecisionDocument_Document" FOREIGN KEY ("DocumentId") REFERENCES "Documents" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_DecisionDocument_DocumentId" ON "DecisionDocument" ("DocumentId");

CREATE TABLE "DecisionRisk" (
    "DecisionId" CHAR(36) NOT NULL,
    "RiskId" CHAR(36) NOT NULL,
    PRIMARY KEY ("DecisionId", "RiskId"),
    CONSTRAINT "FK_DecisionRisk_Decision" FOREIGN KEY ("DecisionId") REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_DecisionRisk_Risk" FOREIGN KEY ("RiskId") REFERENCES "Risks" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_DecisionRisk_RiskId" ON "DecisionRisk" ("RiskId");

CREATE TABLE "DecisionPrinciple" (
    "DecisionId" CHAR(36) NOT NULL,
    "PrincipleId" CHAR(36) NOT NULL,
    PRIMARY KEY ("DecisionId", "PrincipleId"),
    CONSTRAINT "FK_DecisionPrinciple_Decision" FOREIGN KEY ("DecisionId") REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_DecisionPrinciple_Principle" FOREIGN KEY ("PrincipleId") REFERENCES "Principles" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_DecisionPrinciple_PrincipleId" ON "DecisionPrinciple" ("PrincipleId");

CREATE TABLE "DecisionObjective" (
    "DecisionId" CHAR(36) NOT NULL,
    "ObjectiveId" CHAR(36) NOT NULL,
    PRIMARY KEY ("DecisionId", "ObjectiveId"),
    CONSTRAINT "FK_DecisionObjective_Decision" FOREIGN KEY ("DecisionId") REFERENCES "Decisions" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_DecisionObjective_Objective" FOREIGN KEY ("ObjectiveId") REFERENCES "Objectives" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_DecisionObjective_ObjectiveId" ON "DecisionObjective" ("ObjectiveId");

CREATE TABLE "Retrospectives" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "ReleaseId" CHAR(36) NULL,
    "Key" VARCHAR(20) NOT NULL,
    "Team" VARCHAR(200) NULL,
    "Background" TEXT NULL,
    "RetroDate" DATE NULL,
    "LastTimerDurationSeconds" INT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Retrospectives_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Retrospectives_Releases" FOREIGN KEY ("ReleaseId") REFERENCES "Releases" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_Retrospectives_ProjectId_Key" ON "Retrospectives" ("ProjectId", "Key");
CREATE INDEX "IX_Retrospectives_ReleaseId" ON "Retrospectives" ("ReleaseId");

-- "Column" is quoted throughout (ANSI_QUOTES makes it a plain identifier despite being a reserved
-- keyword) — ported verbatim from php-api, which names this column after the Retrospective board's
-- own column (Went Well / To Improve / Action Items), not this table's own SQL columns.
CREATE TABLE "RetrospectiveItems" (
    "Id" CHAR(36) PRIMARY KEY,
    "RetrospectiveId" CHAR(36) NOT NULL,
    "Column" VARCHAR(20) NOT NULL,
    "Text" VARCHAR(2000) NOT NULL,
    "SortOrder" INT NOT NULL,
    "PromotedPrincipleId" CHAR(36) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_RetrospectiveItems_Retrospective" FOREIGN KEY ("RetrospectiveId") REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RetrospectiveItems_PromotedPrinciple" FOREIGN KEY ("PromotedPrincipleId") REFERENCES "Principles" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_RetrospectiveItems_RetrospectiveId" ON "RetrospectiveItems" ("RetrospectiveId");
CREATE INDEX "IX_RetrospectiveItems_PromotedPrincipleId" ON "RetrospectiveItems" ("PromotedPrincipleId");

CREATE TABLE "RetrospectiveActionItems" (
    "Id" CHAR(36) PRIMARY KEY,
    "RetrospectiveId" CHAR(36) NOT NULL,
    "Text" VARCHAR(2000) NOT NULL,
    "AssigneeId" CHAR(36) NULL,
    "Completed" BOOLEAN NOT NULL DEFAULT FALSE,
    "SortOrder" INT NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_RetrospectiveActionItems_Retrospective" FOREIGN KEY ("RetrospectiveId") REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RetrospectiveActionItems_Assignee" FOREIGN KEY ("AssigneeId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_RetrospectiveActionItems_RetrospectiveId" ON "RetrospectiveActionItems" ("RetrospectiveId");
CREATE INDEX "IX_RetrospectiveActionItems_AssigneeId" ON "RetrospectiveActionItems" ("AssigneeId");

CREATE TABLE "RetrospectiveParticipants" (
    "RetrospectiveId" CHAR(36) NOT NULL,
    "ProjectMemberId" CHAR(36) NOT NULL,
    PRIMARY KEY ("RetrospectiveId", "ProjectMemberId"),
    CONSTRAINT "FK_RetrospectiveParticipants_Retrospective" FOREIGN KEY ("RetrospectiveId") REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_RetrospectiveParticipants_ProjectMember" FOREIGN KEY ("ProjectMemberId") REFERENCES "ProjectMembers" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_RetrospectiveParticipants_ProjectMemberId" ON "RetrospectiveParticipants" ("ProjectMemberId");
