CREATE TABLE "Announcements" (
    "Id" uuid PRIMARY KEY,
    "Scope" varchar(20) NOT NULL,
    "OrganisationId" uuid REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    "Title" varchar(200) NOT NULL,
    "Body" text NOT NULL,
    "Kind" varchar(20) NOT NULL,
    "StartAt" timestamptz NOT NULL,
    "EndAt" timestamptz,
    "CreatedByUserId" uuid REFERENCES "Users" ("Id") ON DELETE SET NULL,
    "CreatedByVendor" boolean NOT NULL DEFAULT false,
    "DateCreated" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_Announcements_OrganisationId" ON "Announcements" ("OrganisationId");
CREATE INDEX "IX_Announcements_CreatedByUserId" ON "Announcements" ("CreatedByUserId");
CREATE INDEX "IX_Announcements_StartAt_EndAt" ON "Announcements" ("StartAt", "EndAt");

-- Populated only when Scope='orgs' (Vendor Portal targeting a chosen subset of organisations).
CREATE TABLE "AnnouncementOrganisations" (
    "Id" uuid PRIMARY KEY,
    "AnnouncementId" uuid NOT NULL REFERENCES "Announcements" ("Id") ON DELETE CASCADE,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "IX_AnnouncementOrganisations_AnnouncementId_OrganisationId" ON "AnnouncementOrganisations" ("AnnouncementId", "OrganisationId");
CREATE INDEX "IX_AnnouncementOrganisations_OrganisationId" ON "AnnouncementOrganisations" ("OrganisationId");

-- Per-user "don't show again" for Kind='announcement' only — disruption notices are never acknowledged.
CREATE TABLE "AnnouncementAcknowledgements" (
    "Id" uuid PRIMARY KEY,
    "AnnouncementId" uuid NOT NULL REFERENCES "Announcements" ("Id") ON DELETE CASCADE,
    "UserId" uuid NOT NULL REFERENCES "Users" ("Id") ON DELETE CASCADE,
    "AcknowledgedAt" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_AnnouncementAcknowledgements_AnnouncementId_UserId" ON "AnnouncementAcknowledgements" ("AnnouncementId", "UserId");
CREATE INDEX "IX_AnnouncementAcknowledgements_UserId" ON "AnnouncementAcknowledgements" ("UserId");
