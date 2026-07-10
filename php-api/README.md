# Enkl PHP API (self-hosted tier)

A parity port of [`api/Enkl.Api`](../api/Enkl.Api) (the .NET API) to PHP 8.2+ / [Slim 4](https://www.slimframework.com/),
for organisations that want to self-host against their own standalone PostgreSQL instance instead of
running the Docker Compose stack. Same HTTP contract as the .NET API, so the existing frontend
(`src/js/api.js`) works unmodified against either backend — this tier runs **in parallel** to the .NET
one as an alternative deployment option, not a replacement.

Neither PHP nor PostgreSQL need to run in a container here. Docker is used elsewhere in this repo only
as a local verification harness for this code during development — it is not part of the deployment
model this tier targets.

## Requirements

- PHP 8.2+ with the `pdo_pgsql` and `pgsql` extensions (the latter is needed only for the SSE live-update
  stream's `LISTEN`/`NOTIFY` support — see [Realtime](#realtime-sse) below).
- [Composer](https://getcomposer.org/).
- A PostgreSQL instance you provision and own. This API does not create the database itself, only the
  tables/entities inside a database you point it at.
- Any web server capable of running PHP (php-fpm + nginx/Apache, or `php -S` for quick local testing).

## Setup

```bash
cd php-api
composer install --no-dev
cp .env.example .env
# edit .env: DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD for your Postgres instance,
# and JWT_SIGNING_KEY (32+ random characters — see the note in .env.example about
# sharing this value with the .NET API if you ever run both against the same database).

php migrate.php   # deploys/updates the schema — safe to re-run any time
```

By default (`RUN_MIGRATIONS_ON_STARTUP=true`) the API also re-checks for and applies any new migrations
on every process start, so `php migrate.php` is mainly useful for the very first deploy or for running
schema updates out-of-band ahead of a rollout. Set it to `false` if your organisation prefers migrations
to only ever run via the explicit CLI command.

## Running

Local/dev:

```bash
php -S 0.0.0.0:8080 -t public
```

Production: point php-fpm's pool at `public/index.php` behind nginx/Apache like any other PHP
application, with the document root set to `php-api/public`. `web/nginx.conf` in the repo root
shows the buffering/timeout settings the SSE stream endpoint (`/api/events/stream`) needs to actually
stream through a reverse proxy rather than getting held until the connection closes — the same settings
apply here (`X-Accel-Buffering: no`, no proxy buffering, a read timeout comfortably above the 15s
heartbeat interval in `src/Controllers/EventsController.php`).

## Architecture notes

- **PDO + raw parameterized SQL, no ORM.** Every FK `ON DELETE` behavior (cascade/restrict/set-null) is
  load-bearing application logic ported exactly from the .NET side's EF Core configuration — see
  `src/Db/migrations/001_initial_schema.sql`, which was captured from a live `pg_dump --schema-only` of
  the .NET API's own database as ground truth, not reconstructed from memory.
- **JWTs are interchangeable with the .NET API's.** Claim names, the string (not JSON bool) `orgAdmin`
  claim, and the double-JSON-encoded PascalCase `projects` claim all match byte-for-byte — a token
  minted by either tier validates against the other when both point at the same database and share the
  same `JWT_SIGNING_KEY`.
- **Passwords** use PHP's native `password_hash()`/`PASSWORD_BCRYPT`, which is hash-format-compatible
  with the .NET side's BCrypt.Net-Next — a user created via one tier can log in via the other.

### Realtime (SSE)

The .NET API's live task-change notifications use an in-memory singleton (`SseBroadcaster`), which only
works within a single process. This tier instead publishes every task mutation via Postgres
`NOTIFY task_changed` (`src/Realtime/Broadcaster.php`), and each open SSE stream
(`src/Controllers/EventsController.php`) holds its own dedicated `LISTEN task_changed` connection,
filtering incoming payloads for itself. This is strictly better for horizontal scaling: it works
correctly across any number of php-fpm workers or hosts, since Postgres itself is the shared backplane,
whereas the .NET singleton only sees connections on its own replica.

This is why `ext-pgsql` (not just `pdo_pgsql`) is required — PDO's Postgres driver doesn't expose an
async notification-wait primitive, so the stream endpoint uses the raw `pg_connect`/`pg_get_notify`
functions for that one piece.

## Verifying a fresh deploy

```
GET /health   -> {"status":"ok"}
```

Then either migrate an existing local Enkl project via `POST /api/migration/projects` (the same payload
`src/js/features/export.js`'s `exportProjectJSON()` produces client-side), or create a fresh org/user
directly in the database and log in via `POST /api/auth/login`.
