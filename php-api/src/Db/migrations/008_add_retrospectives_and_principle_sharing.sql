-- Retrospectives feature + Principle sharing/library — ported from the .NET side's
-- AddRetrospectivesAndPrincipleSharing migration (20260711040513_AddRetrospectivesAndPrincipleSharing).

-- Principles gains OrganisationId (denormalized from Project.OrganisationId at creation time so the
-- organisation-wide library/suggestions queries can filter directly without joining through
-- Projects) and IsOrganisationWide (opt-in per principle; sharing never duplicates the row, it just
-- becomes visible/copyable from other projects in the same organisation).
ALTER TABLE "Principles" ADD COLUMN "IsOrganisationWide" boolean NOT NULL DEFAULT false;

-- Added nullable first (not NOT NULL DEFAULT '00000000-...') because every existing row needs its
-- real backfilled value below, not a placeholder — matches the .NET migration's own two-step
-- add-then-backfill-then-constrain approach.
ALTER TABLE "Principles" ADD COLUMN "OrganisationId" uuid;
UPDATE "Principles" p SET "OrganisationId" = pr."OrganisationId" FROM "Projects" pr WHERE pr."Id" = p."ProjectId";
ALTER TABLE "Principles" ALTER COLUMN "OrganisationId" SET NOT NULL;

-- Backs the "Organisation Library" and suggestions queries (WHERE "OrganisationId" = x AND "IsOrganisationWide" = true).
CREATE INDEX "IX_Principles_OrganisationId_IsOrganisationWide" ON "Principles" ("OrganisationId", "IsOrganisationWide");

CREATE TABLE "Retrospectives" (
    "Id" uuid PRIMARY KEY,
    "ProjectId" uuid NOT NULL REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    "ReleaseId" uuid REFERENCES "Releases" ("Id") ON DELETE SET NULL,
    "Key" varchar(20) NOT NULL,
    "Team" varchar(200),
    "Background" text,
    "RetroDate" date,
    "LastTimerDurationSeconds" integer,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_Retrospectives_ProjectId_Key" ON "Retrospectives" ("ProjectId", "Key");
CREATE INDEX "IX_Retrospectives_ReleaseId" ON "Retrospectives" ("ReleaseId");

CREATE TABLE "RetrospectiveItems" (
    "Id" uuid PRIMARY KEY,
    "RetrospectiveId" uuid NOT NULL REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    "Column" varchar(20) NOT NULL,
    "Text" varchar(2000) NOT NULL,
    "SortOrder" integer NOT NULL,
    "PromotedPrincipleId" uuid REFERENCES "Principles" ("Id") ON DELETE SET NULL,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_RetrospectiveItems_RetrospectiveId" ON "RetrospectiveItems" ("RetrospectiveId");
CREATE INDEX "IX_RetrospectiveItems_PromotedPrincipleId" ON "RetrospectiveItems" ("PromotedPrincipleId");

CREATE TABLE "RetrospectiveActionItems" (
    "Id" uuid PRIMARY KEY,
    "RetrospectiveId" uuid NOT NULL REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    "Text" varchar(2000) NOT NULL,
    "AssigneeId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "Completed" boolean NOT NULL DEFAULT false,
    "SortOrder" integer NOT NULL,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_RetrospectiveActionItems_RetrospectiveId" ON "RetrospectiveActionItems" ("RetrospectiveId");
CREATE INDEX "IX_RetrospectiveActionItems_AssigneeId" ON "RetrospectiveActionItems" ("AssigneeId");

CREATE TABLE "RetrospectiveParticipants" (
    "RetrospectiveId" uuid NOT NULL REFERENCES "Retrospectives" ("Id") ON DELETE CASCADE,
    "ProjectMemberId" uuid NOT NULL REFERENCES "ProjectMembers" ("Id") ON DELETE CASCADE,
    PRIMARY KEY ("RetrospectiveId", "ProjectMemberId")
);
CREATE INDEX "IX_RetrospectiveParticipants_ProjectMemberId" ON "RetrospectiveParticipants" ("ProjectMemberId");
