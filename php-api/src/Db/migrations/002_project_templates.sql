-- Project Templates: a named, reusable snapshot of a project's Columns, TaskTypes, Workflow, and
-- App Settings (HeaderButtonVisibility) — deliberately just jsonb blobs, same shape as the Projects
-- table's own WorkflowJson/HeaderButtonVisibilityJson columns, since this data is an inert snapshot
-- never queried relationally (no normalized child tables). Owned by the Organisation, not any one
-- Project, so every member of that org can see/use it (see TemplatesController's gating).
CREATE TABLE "ProjectTemplates" (
    "Id" uuid PRIMARY KEY,
    "OrganisationId" uuid NOT NULL REFERENCES "Organisations" ("Id") ON DELETE RESTRICT,
    "Name" varchar(200) NOT NULL,
    "ColumnsJson" jsonb NOT NULL,
    "TaskTypesJson" jsonb NOT NULL,
    "WorkflowJson" jsonb,
    "SettingsJson" jsonb NOT NULL DEFAULT '{}',
    "CreatedAt" timestamptz NOT NULL,
    "DateLastModified" timestamptz NOT NULL
);
CREATE INDEX "IX_ProjectTemplates_OrganisationId" ON "ProjectTemplates" ("OrganisationId");
