-- Rate limiting + anonymous telemetry — consolidates php-api's 009 (RateLimitHits) and 014
-- (PageLoadTimings).
--
-- PHP-tier-only (no .NET equivalent, both Postgres and MariaDB tiers): the .NET side's rate limiter
-- is an in-memory sliding window, which works because it hosts as one long-lived process; a PHP
-- worker holds no state between requests, so this table replaces the in-memory window —
-- Auth/RateLimitMiddleware.php (Phase 2) inserts one row per request it's attached to and counts
-- rows for that partition key within the trailing window, pruning old rows opportunistically.
-- `"Id"` is `BIGINT AUTO_INCREMENT` here (MariaDB's equivalent of Postgres's `bigserial` — the one
-- non-UUID PK in the whole schema).
CREATE TABLE "RateLimitHits" (
    "Id" BIGINT AUTO_INCREMENT PRIMARY KEY,
    "PartitionKey" VARCHAR(255) NOT NULL,
    "OccurredAt" DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE INDEX "IX_RateLimitHits_PartitionKey_OccurredAt" ON "RateLimitHits" ("PartitionKey", "OccurredAt");

-- MariaDB-only companion table (no Postgres/.NET equivalent) — see mariadb-api/CLAUDE.md's
-- RateLimitMiddleware writeup. Postgres's `pg_advisory_xact_lock(hashtext(:key))` serializes the
-- count-then-insert race per partition key with a transaction-scoped advisory lock; MariaDB has no
-- advisory-lock primitive with the same auto-released-at-commit semantics (`GET_LOCK()`/
-- `RELEASE_LOCK()` are session-scoped and would leak across a pooled connection if a release were
-- ever missed). This table gives the same serialization via an ordinary InnoDB row lock instead: one
-- row per partition key, `INSERT IGNORE`d into existence on first sight, then locked with
-- `SELECT ... FOR UPDATE` inside the same transaction that counts+inserts into "RateLimitHits" —
-- released automatically at commit/rollback exactly like the advisory lock was, using nothing but
-- ordinary transaction semantics.
CREATE TABLE "RateLimitPartitionLocks" (
    "PartitionKey" VARCHAR(255) PRIMARY KEY
) ENGINE=InnoDB;

-- Anonymous Real User Monitoring samples (no OrganisationId/UserId — a pure ops/performance metric,
-- not user data). Read directly by the standalone Vendor Portal app if it's ever pointed at this
-- tier's database instead of Postgres, feeding its "APM - Web App Responsiveness" chart the same way
-- it already reads php-api's own copy of this table.
CREATE TABLE "PageLoadTimings" (
    "Id" CHAR(36) PRIMARY KEY,
    "RecordedAt" DATETIME(6) NOT NULL,
    "DurationMs" DOUBLE NOT NULL
) ENGINE=InnoDB;
CREATE INDEX "IX_PageLoadTimings_RecordedAt" ON "PageLoadTimings" ("RecordedAt");
