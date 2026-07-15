-- Ported from api/Enkl.Api's AddProjectDescription migration. Unbounded, nullable text, no length
-- constraint — matches every other entity's Description column on this tier (Documents, Risks,
-- Decisions, Principles, Objectives, TeamsCommittees).
ALTER TABLE "Projects" ADD COLUMN "Description" text;
