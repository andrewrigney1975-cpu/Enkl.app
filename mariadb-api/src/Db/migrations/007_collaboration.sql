-- Task Comments + org-wide Chat — consolidates php-api's 026 (TaskComments), 027 (Chat* tables +
-- SsePresence), 028 (ChatMessageReactions).
CREATE TABLE "TaskComments" (
    "Id" CHAR(36) PRIMARY KEY,
    "TaskId" CHAR(36) NOT NULL,
    "Text" TEXT NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "AuthorId" CHAR(36) NULL,
    "AuthorName" VARCHAR(200) NOT NULL,
    CONSTRAINT "FK_TaskComments_Task" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_TaskComments_Author" FOREIGN KEY ("AuthorId") REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_TaskComments_TaskId" ON "TaskComments" ("TaskId");
CREATE INDEX "IX_TaskComments_AuthorId" ON "TaskComments" ("AuthorId");

CREATE TABLE "ChatChannels" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NULL,
    "IsDirectMessage" BOOLEAN NOT NULL,
    "CreatedByUserId" CHAR(36) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ChatChannels_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ChatChannels_CreatedBy" FOREIGN KEY ("CreatedByUserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_ChatChannels_OrganisationId" ON "ChatChannels" ("OrganisationId");
CREATE INDEX "IX_ChatChannels_CreatedByUserId" ON "ChatChannels" ("CreatedByUserId");

CREATE TABLE "ChatChannelMembers" (
    "Id" CHAR(36) PRIMARY KEY,
    "ChannelId" CHAR(36) NOT NULL,
    "UserId" CHAR(36) NOT NULL,
    "DateJoined" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ChatChannelMembers_Channel" FOREIGN KEY ("ChannelId") REFERENCES "ChatChannels" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ChatChannelMembers_User" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_ChatChannelMembers_ChannelId_UserId" ON "ChatChannelMembers" ("ChannelId", "UserId");
CREATE INDEX "IX_ChatChannelMembers_UserId" ON "ChatChannelMembers" ("UserId");

CREATE TABLE "ChatMessages" (
    "Id" CHAR(36) PRIMARY KEY,
    "ChannelId" CHAR(36) NOT NULL,
    "AuthorUserId" CHAR(36) NULL,
    "AuthorName" VARCHAR(200) NOT NULL,
    "Text" TEXT NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "IsDeleted" BOOLEAN NOT NULL DEFAULT FALSE,
    "DateDeleted" DATETIME(6) NULL,
    CONSTRAINT "FK_ChatMessages_Channel" FOREIGN KEY ("ChannelId") REFERENCES "ChatChannels" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ChatMessages_Author" FOREIGN KEY ("AuthorUserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_ChatMessages_ChannelId" ON "ChatMessages" ("ChannelId");
CREATE INDEX "IX_ChatMessages_AuthorUserId" ON "ChatMessages" ("AuthorUserId");
CREATE INDEX "IX_ChatMessages_DateCreated" ON "ChatMessages" ("DateCreated");

-- PHP-tier-only presence tracking (both php-api and this tier): unlike the .NET tier's in-memory
-- SseBroadcaster registry, a PHP process/worker is stateless/short-lived, so there's no in-process
-- place to remember "who has an open SSE stream right now" — this table is the shared-across-workers
-- substitute. Controllers/EventsController.php (Phase 3) upserts the caller's row on connect and
-- every heartbeat tick, deletes it on disconnect; "online" is read as LastSeenAt within a grace
-- window slightly wider than the poll interval (tolerates one missed beat without flickering offline).
CREATE TABLE "SsePresence" (
    "UserId" CHAR(36) PRIMARY KEY,
    "LastSeenAt" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_SsePresence_User" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE "ChatMessageReactions" (
    "Id" CHAR(36) PRIMARY KEY,
    "MessageId" CHAR(36) NOT NULL,
    "UserId" CHAR(36) NOT NULL,
    "Emoji" VARCHAR(8) NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ChatMessageReactions_Message" FOREIGN KEY ("MessageId") REFERENCES "ChatMessages" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ChatMessageReactions_User" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX "IX_ChatMessageReactions_MessageId_UserId_Emoji" ON "ChatMessageReactions" ("MessageId", "UserId", "Emoji");
CREATE INDEX "IX_ChatMessageReactions_UserId" ON "ChatMessageReactions" ("UserId");
