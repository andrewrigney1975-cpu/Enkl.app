CREATE TABLE "Announcements" (
    "Id" CHAR(36) PRIMARY KEY,
    "Scope" VARCHAR(20) NOT NULL,
    "OrganisationId" CHAR(36) NULL,
    "Title" VARCHAR(200) NOT NULL,
    "Body" TEXT NOT NULL,
    "Kind" VARCHAR(20) NOT NULL,
    "StartAt" DATETIME(6) NOT NULL,
    "EndAt" DATETIME(6) NULL,
    "CreatedByUserId" CHAR(36) NULL,
    "CreatedByVendor" TINYINT(1) NOT NULL DEFAULT 0,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_Announcements_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Announcements_CreatedBy" FOREIGN KEY ("CreatedByUserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_Announcements_OrganisationId" ON "Announcements" ("OrganisationId");
CREATE INDEX "IX_Announcements_CreatedByUserId" ON "Announcements" ("CreatedByUserId");
CREATE INDEX "IX_Announcements_StartAt_EndAt" ON "Announcements" ("StartAt", "EndAt");

-- Populated only when Scope='orgs' (Vendor Portal targeting a chosen subset of organisations).
CREATE TABLE "AnnouncementOrganisations" (
    "Id" CHAR(36) PRIMARY KEY,
    "AnnouncementId" CHAR(36) NOT NULL,
    "OrganisationId" CHAR(36) NOT NULL,
    CONSTRAINT "FK_AnnouncementOrganisations_Announcement" FOREIGN KEY ("AnnouncementId") REFERENCES "Announcements" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_AnnouncementOrganisations_Organisation" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_AnnouncementOrganisations_AnnouncementId_OrganisationId" ON "AnnouncementOrganisations" ("AnnouncementId", "OrganisationId");
CREATE INDEX "IX_AnnouncementOrganisations_OrganisationId" ON "AnnouncementOrganisations" ("OrganisationId");

-- Per-user "don't show again" for Kind='announcement' only — disruption notices are never acknowledged.
CREATE TABLE "AnnouncementAcknowledgements" (
    "Id" CHAR(36) PRIMARY KEY,
    "AnnouncementId" CHAR(36) NOT NULL,
    "UserId" CHAR(36) NOT NULL,
    "AcknowledgedAt" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_AnnouncementAcknowledgements_Announcement" FOREIGN KEY ("AnnouncementId") REFERENCES "Announcements" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_AnnouncementAcknowledgements_User" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_AnnouncementAcknowledgements_AnnouncementId_UserId" ON "AnnouncementAcknowledgements" ("AnnouncementId", "UserId");
CREATE INDEX "IX_AnnouncementAcknowledgements_UserId" ON "AnnouncementAcknowledgements" ("UserId");
