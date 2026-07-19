-- MariaDB-only (no Postgres/.NET equivalent) — the live-updates/SSE replacement for Postgres
-- LISTEN/NOTIFY, which MariaDB has no equivalent primitive for at all (not a syntax difference —
-- there is genuinely nothing to port). See Realtime/Broadcaster.php and
-- Controllers/EventsController.php for the two sides of this: every task/chat mutation INSERTs a row
-- here instead of calling `pg_notify()`, and every open SSE stream polls for new rows on a ~2 second
-- interval (per this session's own decision — a short poll keeps the "live update" feel close to
-- instant, at the cost of a small steady per-connection query instead of blocking on a socket) instead
-- of blocking on `LISTEN`. `"Id"` is the polling cursor (`WHERE "Id" > :lastSeenId ORDER BY "Id"`),
-- so it must be a strictly-increasing `BIGINT AUTO_INCREMENT` (MariaDB's `bigserial` equivalent,
-- same PK style `"RateLimitHits"` already uses) — a UUID PK would give no usable ordering here.
CREATE TABLE "Events" (
    "Id" BIGINT AUTO_INCREMENT PRIMARY KEY,
    "Channel" VARCHAR(50) NOT NULL,
    "Payload" JSON NOT NULL,
    "CreatedAt" DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE INDEX "IX_Events_Id_Channel" ON "Events" ("Id", "Channel");
