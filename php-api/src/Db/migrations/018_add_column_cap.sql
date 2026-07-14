-- Ported from api/Enkl.Api's AddColumnCap migration. WIP limit: -1 (default) means uncapped, any
-- positive integer caps how many active tasks may sit in this column at once — see
-- workflow-engine.js's evaluateColumnCap. No CHECK constraint — clamping to [-1] or [1, +inf) happens
-- in application code (ColumnService::update), matching this table's existing app-enforced-only
-- convention for Done/Color.
ALTER TABLE "Columns" ADD COLUMN "Cap" integer NOT NULL DEFAULT -1;
