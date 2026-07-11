# Enkl Portal

Standalone internal vendor-management app: organisations, per-org license cost/discount, and
contracts/agreements. Separate from the customer-facing Enkl Task app — its own Node/Express
backend, its own frontend, no dependency on `api/Enkl.Api` (.NET) or `php-api`. It reads the
`"Organisations"`/`"Users"` tables from the shared `enkl` Postgres database read-only, and owns
three tables of its own (`vendor_admin`, `vendor_licenses`, `vendor_contracts`).

## This branch never gets pushed

This app lives only on the local `local/vendor-portal` git branch, which is never merged into
`main` and never pushed to `origin`. A `.git/hooks/pre-push` hook (local-only, not tracked by git)
additionally rejects pushing any `local/*` branch as a backstop. Keep it that way — don't merge
this branch into `main`, and don't remove the hook.

## Running it

The main stack's `db` service must already be running (`docker compose up db` from the repo
root) — this app connects to that same Postgres instance via the host, not a shared Docker
network.

```
cp .env.example .env   # fill in DB_PASSWORD (matches the main repo's .env) and a real SESSION_SECRET
docker compose up --build
```

## Creating / rotating the single admin user

There is exactly one user. Seed or replace it with:

```
docker compose exec portal node server/scripts/seed-admin.js <username> <password>
```

Password must be at least 12 characters. Re-running this replaces whatever admin row exists.

Then open http://127.0.0.1:4000.
