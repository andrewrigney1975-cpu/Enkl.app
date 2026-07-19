-- Project Templates: a named, reusable snapshot of a project's Columns, TaskTypes, Workflow, and
-- App Settings (HeaderButtonVisibility) — deliberately just JSON blobs, same shape as the Projects
-- table's own WorkflowJson/HeaderButtonVisibilityJson columns, since this data is an inert snapshot
-- never queried relationally (no normalized child tables). Owned by the Organisation, not any one
-- Project, so every member of that org can see/use it.
CREATE TABLE "ProjectTemplates" (
    "Id" CHAR(36) PRIMARY KEY,
    "OrganisationId" CHAR(36) NOT NULL,
    "Name" VARCHAR(200) NOT NULL,
    "ColumnsJson" JSON NOT NULL,
    "TaskTypesJson" JSON NOT NULL,
    "WorkflowJson" JSON NULL,
    "SettingsJson" JSON NOT NULL DEFAULT '{}',
    "CreatedAt" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ProjectTemplates_Organisations" FOREIGN KEY ("OrganisationId") REFERENCES "Organisations" ("Id") ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE INDEX "IX_ProjectTemplates_OrganisationId" ON "ProjectTemplates" ("OrganisationId");

-- To-Do Lists: the app's first genuinely per-USER resource (not scoped to a Project or an
-- Organisation like everything else). A list belongs to exactly one User; deleting a User or a List
-- cascades to its children, unlike the deliberate ON DELETE RESTRICT used for Organisation->Project
-- and Organisation->ProjectTemplate — there's no service-layer orphan-handling for a user's own
-- private to-do data, and the app's own requirement is that deleting a list deletes its items.
CREATE TABLE "ToDoLists" (
    "Id" CHAR(36) PRIMARY KEY,
    "UserId" CHAR(36) NOT NULL,
    "Title" VARCHAR(200) NOT NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ToDoLists_Users" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_ToDoLists_UserId" ON "ToDoLists" ("UserId");

CREATE TABLE "ToDoItems" (
    "Id" CHAR(36) PRIMARY KEY,
    "ToDoListId" CHAR(36) NOT NULL,
    "Note" TEXT NOT NULL,
    "Completed" BOOLEAN NOT NULL DEFAULT FALSE,
    "DueDate" DATETIME(6) NULL,
    "DateCreated" DATETIME(6) NOT NULL,
    "DateLastModified" DATETIME(6) NOT NULL,
    CONSTRAINT "FK_ToDoItems_ToDoLists" FOREIGN KEY ("ToDoListId") REFERENCES "ToDoLists" ("Id") ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX "IX_ToDoItems_ToDoListId" ON "ToDoItems" ("ToDoListId");
