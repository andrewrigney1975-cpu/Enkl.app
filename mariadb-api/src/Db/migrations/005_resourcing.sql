-- Draft resourcing (role + allocated %) for a Portfolio Planner placeholder project —
-- project-scoped (FK to Projects), not org-scoped, same as ProjectMembers/TaskTypes. Role is an
-- unconstrained VARCHAR, no CHECK constraint, matching the ProjectMembers."Role"/Projects."Priority"
-- convention. Merges php-api's 017 (UserId — an optional link to a real org User; NULL means an
-- unfilled role) straight into the base table.
CREATE TABLE "ProjectResourcePlaceholders" (
    "Id" CHAR(36) PRIMARY KEY,
    "ProjectId" CHAR(36) NOT NULL,
    "Role" VARCHAR(100) NOT NULL,
    "AllocatedFraction" INT NOT NULL,
    "UserId" CHAR(36) NULL,
    CONSTRAINT "FK_ProjectResourcePlaceholders_Projects" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_ProjectResourcePlaceholders_Users" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_ProjectResourcePlaceholders_ProjectId" ON "ProjectResourcePlaceholders" ("ProjectId");
CREATE INDEX "IX_ProjectResourcePlaceholders_UserId" ON "ProjectResourcePlaceholders" ("UserId");
