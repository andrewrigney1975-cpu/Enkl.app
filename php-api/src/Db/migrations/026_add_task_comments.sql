CREATE TABLE "TaskComments" (
    "Id" uuid PRIMARY KEY,
    "TaskId" uuid NOT NULL REFERENCES "Tasks" ("Id") ON DELETE CASCADE,
    "Text" text NOT NULL,
    "DateCreated" timestamptz NOT NULL,
    "AuthorId" uuid REFERENCES "ProjectMembers" ("Id") ON DELETE SET NULL,
    "AuthorName" varchar(200) NOT NULL
);
CREATE INDEX "IX_TaskComments_TaskId" ON "TaskComments" ("TaskId");
CREATE INDEX "IX_TaskComments_AuthorId" ON "TaskComments" ("AuthorId");
