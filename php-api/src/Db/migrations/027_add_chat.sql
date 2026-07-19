CREATE TABLE "ChatChannels" (
    "Id" uuid PRIMARY KEY,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE CASCADE,
    "Name" varchar(200),
    "IsDirectMessage" boolean NOT NULL,
    "CreatedByUserId" uuid REFERENCES "Users" ("Id") ON DELETE SET NULL,
    "DateCreated" timestamptz NOT NULL
);
CREATE INDEX "IX_ChatChannels_OrganisationId" ON "ChatChannels" ("OrganisationId");
CREATE INDEX "IX_ChatChannels_CreatedByUserId" ON "ChatChannels" ("CreatedByUserId");

CREATE TABLE "ChatChannelMembers" (
    "Id" uuid PRIMARY KEY,
    "ChannelId" uuid NOT NULL REFERENCES "ChatChannels" ("Id") ON DELETE CASCADE,
    "UserId" uuid NOT NULL REFERENCES "Users" ("Id") ON DELETE CASCADE,
    "DateJoined" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "IX_ChatChannelMembers_ChannelId_UserId" ON "ChatChannelMembers" ("ChannelId", "UserId");
CREATE INDEX "IX_ChatChannelMembers_UserId" ON "ChatChannelMembers" ("UserId");

CREATE TABLE "ChatMessages" (
    "Id" uuid PRIMARY KEY,
    "ChannelId" uuid NOT NULL REFERENCES "ChatChannels" ("Id") ON DELETE CASCADE,
    "AuthorUserId" uuid REFERENCES "Users" ("Id") ON DELETE SET NULL,
    "AuthorName" varchar(200) NOT NULL,
    "Text" text NOT NULL,
    "DateCreated" timestamptz NOT NULL,
    "IsDeleted" boolean NOT NULL DEFAULT false,
    "DateDeleted" timestamptz
);
CREATE INDEX "IX_ChatMessages_ChannelId" ON "ChatMessages" ("ChannelId");
CREATE INDEX "IX_ChatMessages_AuthorUserId" ON "ChatMessages" ("AuthorUserId");
CREATE INDEX "IX_ChatMessages_DateCreated" ON "ChatMessages" ("DateCreated");

-- PHP-tier-only presence tracking: unlike the .NET tier's in-memory SseBroadcaster registry
-- (_connectionsByUser), a PHP-FPM worker is stateless/short-lived, so there's no in-process place
-- to remember "who has an open SSE stream right now" — this table is the shared-across-workers
-- substitute. Controllers/EventsController.php upserts the caller's row on connect and every
-- heartbeat tick, deletes it on disconnect; "online" is read as LastSeenAt within a grace window
-- slightly wider than the heartbeat interval (tolerates one missed beat without flickering offline).
CREATE TABLE "SsePresence" (
    "UserId" uuid PRIMARY KEY REFERENCES "Users" ("Id") ON DELETE CASCADE,
    "LastSeenAt" timestamptz NOT NULL
);
