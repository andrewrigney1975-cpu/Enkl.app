-- Adds User.EmailAddress, the planned SAML2 unique identifier — ported from the .NET side's
-- AddEmailAddressToUsers migration. Nullable at the DB level (unlike Username): local-only Team
-- members never get an account at all, and pre-existing/migrated Users can lack one until an Org
-- Admin backfills it via Manage Users. Postgres unique indexes treat multiple NULLs as distinct, so
-- that's compatible with the unique-once-set constraint below.
ALTER TABLE "Users" ADD COLUMN "EmailAddress" varchar(320);
ALTER TABLE "Users" ADD COLUMN "NormalizedEmailAddress" varchar(320);
CREATE UNIQUE INDEX "IX_Users_NormalizedEmailAddress" ON "Users" ("NormalizedEmailAddress");
