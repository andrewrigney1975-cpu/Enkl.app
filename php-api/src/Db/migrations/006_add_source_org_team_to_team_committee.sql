-- Adds TeamsCommittees.SourceOrgTeamId — ported from the .NET side's
-- AddSourceOrgTeamToTeamCommittee migration. Set only when a TeamCommittee row was created by
-- TeamCommitteeService::applyOrgTeam() ("apply to project") — lets a re-run find the same
-- TeamCommittee again reliably (matching by Name would break on a rename, or collide if two
-- OrgTeams happened to share a name). ON DELETE SET NULL: an OrgTeam deleted via SCIM must never
-- touch a project's TeamCommittee — that link is one-way and manual, not live.
ALTER TABLE "TeamsCommittees" ADD COLUMN "SourceOrgTeamId" uuid REFERENCES "OrgTeams" ("Id") ON DELETE SET NULL;
CREATE INDEX "IX_TeamsCommittees_SourceOrgTeamId" ON "TeamsCommittees" ("SourceOrgTeamId");
