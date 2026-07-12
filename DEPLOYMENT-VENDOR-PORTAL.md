# Deployment Guide — Enkl Portal (Vendor Management, standalone)

Enkl Portal (`vendor-portal/`) is a separate, standalone internal tool — organisation licensing
costs, contracts/agreements, and a live database-latency monitor. It has its own Node/Express
backend and its own plain-JS frontend, with **no dependency on `api/Enkl.Api` (.NET) or `php-api`**.
It is not one of the customer-facing product's deployment tiers covered by
[`DEPLOYMENT-PHP.md`](DEPLOYMENT-PHP.md) or [`DEPLOYMENT-NET-DOCKER.md`](DEPLOYMENT-NET-DOCKER.md).

**This is an internal admin tool, not a customer-facing product surface.** It reads the shared
`enkl` Postgres database's `"Organisations"`/`"Users"`/`"Tasks"` tables directly (read-only by
convention, not by database-enforced permission — see §6), owns four tables of its own
(`vendor_admin`, `vendor_licenses`, `vendor_contracts`, `vendor_schema_migrations`), and displays
commercially sensitive data (per-org licensing costs, contract values). Treat its deployment
target accordingly: it should never be reachable from the public internet, and access to wherever
it's hosted should be limited to the people who actually manage vendor/licensing commercials.

There is exactly **one** admin user — this app has no registration flow and no per-user accounts.
If more than one person needs access, they share that single login; there is no audit trail
distinguishing who did what.

```
                    ┌───────────────────────────────────────┐
  (internal         │        TLS-terminating layer          │
   network only) ──► │  (reverse proxy — NOT provided by     │
                    │   this app or its Dockerfile)          │
                    └───────────────┬───────────────────────┘
                                    │ plain HTTP
                            ┌───────▼────────┐
                            │ Enkl Portal     │  Node/Express, port 4000
                            │ (single process,│  serves its own static frontend +
                            │  no build step) │  the /api/* routes, same origin
                            └───────┬────────┘
                                    │ pg (ideally TLS)
                            ┌───────▼────────┐
                            │  Shared enkl    │  same Postgres database/instance the
                            │  PostgreSQL DB  │  main Task app itself uses
                            └────────────────┘
```

---

## 1. Prerequisites

- Node.js 20+ (the reference `Dockerfile` uses `node:20-alpine`).
- Access to the **same PostgreSQL database the main Enkl Task app uses** — this is not an optional
  integration, it's how this app gets its Organisations/Users/Projects/Tasks figures. It does not
  stand up its own separate database.
- No build tooling required for the frontend: `web/` is served as plain ES modules via
  `express.static` — there is no bundler, no `npm run build` step, unlike the main app's frontend.
  Deploying a code change means restarting the Node process with the new files in place, nothing
  more.

---

## 2. Configuration

Two environment variables, read via a `.env` file (loaded through Node's built-in env-file support
or your own process manager) or real process environment variables:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | A standard `postgres://user:password@host:port/database` connection string pointing at the **same** database the main app uses. In the reference `docker-compose.yml` this is assembled from `DB_PASSWORD` + Docker Desktop's `host.docker.internal` — for a real deployment, just point it at wherever that Postgres instance actually lives. |
| `SESSION_SECRET` | **yes** | Signs the session cookie. Random, 32+ characters — `openssl rand -base64 48`. The process refuses to start without it (`server/index.js` exits with an error if unset). |
| `PORT` | | Defaults to `4000`. |

Never commit a real `.env` to version control. This app's `.env.example` ships only placeholder
values (`change-me` / `change-me-to-a-random-32-plus-character-string`) — replace both before
starting the real process.

### Docker Compose (reference)

```bash
cd vendor-portal
cp .env.example .env   # fill in DB_PASSWORD and a real SESSION_SECRET
docker compose up --build -d
```

The reference `docker-compose.yml` assumes the main stack's `db` service is already running on the
same Docker host and reachable via `host.docker.internal` — that's a **local development
convenience**, not a production topology. For a real deployment, replace `DATABASE_URL`'s
construction with a plain connection string to your actual Postgres host (see §1), and drop the
`host.docker.internal` / `extra_hosts` entries if the database isn't on the same machine.

### Without Docker

```bash
cd vendor-portal
npm install --omit=dev
# set DATABASE_URL and SESSION_SECRET in the environment or a .env file
node server/index.js
```

---

## 3. Database migrations

Migrations (`server/migrations/*.sql`) run **automatically on every process start** —
`runMigrations()` is called before the HTTP server begins listening, tracked in a
`vendor_schema_migrations` table (filename primary key), each file applied in its own transaction,
sorted files applied in filename order, already-applied files skipped. There is no separate manual
migration command to remember to run — starting the process *is* the migration step. This also
means the very first start against a fresh checkout creates its four tables itself; nothing else
needs to provision them.

---

## 4. Creating / rotating the admin user

```bash
node server/scripts/seed-admin.js <username> <password>
# or, under Docker:
docker compose exec portal node server/scripts/seed-admin.js <username> <password>
```

This **replaces** whatever admin row currently exists — there is only ever one. The script enforces
real password strength itself (12+ characters, not the same as the username, not on a small
hardcoded common-password list, and at least 3 of {lowercase, uppercase, digit, symbol} character
classes) — weak input is rejected with a clear message rather than silently accepted. Run this once
after the first deploy, and again any time the admin credential needs rotating (e.g. after a change
of who's responsible for it, or on a routine rotation schedule).

---

## 5. Reverse proxy and TLS

Nothing in this app terminates TLS — Express listens on plain HTTP only. Put a reverse proxy or
load balancer in front that terminates TLS and forwards plain HTTP to the Node process, the same
requirement as the other two deployment tiers in this repo. A minimal nginx example:

```nginx
server {
  listen 443 ssl;
  server_name portal.internal.example.org;
  # ssl_certificate / ssl_certificate_key ...

  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}

server {
  listen 80;
  server_name portal.internal.example.org;
  return 301 https://$host$request_uri;
}
```

Because sessions are cookie-based (not the bearer-JWT pattern the other two tiers use), also set
`cookie.secure: true` on the session config once you're consistently serving over HTTPS (it isn't
set by default, so the cookie is currently sent over plain HTTP too — fine for the
loopback-only local dev setup this app ships with, not fine once real network hops are involved).
This is a one-line code change (`server/index.js`'s `session({...cookie: {...}})` block), not an
environment variable — make it as part of adapting this app for your real deployment target.

**Gotcha if you do set `cookie.secure: true`**: Express only considers a request "secure" if it can
see the connection actually used TLS. Behind a reverse proxy that terminates TLS and forwards plain
HTTP internally (exactly the setup above), Express needs `app.set('trust proxy', 1)` added
alongside it so it reads `X-Forwarded-Proto` from the proxy — without that, `cookie.secure: true`
silently stops the session cookie from ever being set, and login will appear to succeed but the
next request comes back unauthenticated. Only enable `trust proxy` once you've confirmed nothing
except your own reverse proxy can reach this app directly (matching the network-isolation point in
§7 below) — trusting `X-Forwarded-Proto` from an untrusted source is a spoofable header.

Restrict network access at the firewall/security-group level too: nothing about this app or its
reverse-proxy config restricts *who* can reach it once DNS/routing points at it — that's your
infrastructure's job, and given the "internal tool with commercially sensitive data" framing at the
top of this guide, it should be the first thing you lock down, not an afterthought.

---

## 6. Verify a fresh deployment

```bash
curl https://portal.internal.example.org/health
# {"status":"ok"}
```

Then sign in as the admin user created in §4, and confirm the Dashboard loads with real
figures (organisation/user/project counts, contract data) — this is a genuine end-to-end proof the
`DATABASE_URL` is pointed at the right instance and this app can actually read the main app's
tables. Also check the new "Database Latency" chart at the bottom of the Dashboard is pinging
successfully (green pulses appearing every 5s) — if it's immediately red/failing, that's usually a
`DATABASE_URL` or network-reachability problem worth chasing down before anything else.

---

## 7. Security best practices checklist

### Already built in (verify you haven't disabled or bypassed it)
- [ ] **Timing-safe login**: a nonexistent username still pays the same bcrypt-compare cost as a
      real one (a dummy hash, computed once at module load, same cost factor as real hashes) — this
      closes the "does this username even exist" timing side-channel. Don't add a fast-path
      "username not found" short-circuit anywhere in front of this.
- [ ] **Session fixation protection**: the session ID is regenerated on successful login, so a
      pre-authentication session ID (e.g. set by an attacker on a shared machine) never becomes an
      authenticated one.
- [ ] **Rate limiting on login**: 10 attempts/60s per client IP (not per username, so an attacker
      can't dodge it by cycling through guessed usernames — moot here anyway since there's only one
      real username, but the IP-keyed limit still caps brute-force attempts against it).
- [ ] **bcrypt, cost 12** — matches the main app's own hashing convention. Don't weaken this.
- [ ] **Password strength enforcement** happens in `seed-admin.js` itself (§4), not just as
      documentation — rerunning that script is the only way to set a password, so weak passwords
      can't be set by skipping a step elsewhere.
- [ ] **`SameSite=Lax` session cookie**: already blocks the classic cross-site-form-POST CSRF vector
      for state-changing requests (Lax only sends the cookie on top-level navigation GETs, not
      cross-origin POST/PUT/DELETE) — see the note below on why this matters more here than for the
      other two tiers.

### Your responsibility to configure correctly
- [ ] **TLS in front, and `cookie.secure: true` once it's there** (§5) — this app is cookie-session
      based, not bearer-JWT-in-localStorage like the other two tiers, so an intercepted plaintext
      session cookie is a direct account takeover, not just a leaked token that expires or can be
      revoked via a security-stamp check. Take the HTTPS requirement at least as seriously here as
      for the other tiers, arguably more so.
- [ ] **CSRF is a real, live concern for this app specifically** — unlike the JWT/localStorage-based
      .NET/PHP tiers (immune to classic CSRF by construction, since nothing is ever sent
      automatically by the browser), this app's session cookie *is* sent automatically on
      same-site requests. `SameSite=Lax` mitigates the common case, but isn't a complete answer
      (older browsers, some edge-case navigations) — if you extend this app's mutating routes,
      keep that threat model in mind rather than assuming the other two tiers' "no CSRF surface"
      reasoning applies here too.
- [ ] **Real, unique `SESSION_SECRET` and `DATABASE_URL` credentials**, sourced from a secrets
      manager or a restrictively-permissioned `.env` file (`chmod 600`), never committed to git.
- [ ] **Database permissions**: this app reads `"Organisations"`/`"Users"`/`"Tasks"` "read-only, by
      convention" — nothing at the database level currently stops it from writing to those tables
      if a future code change (accidentally or otherwise) tried to. Consider granting the connection
      user `SELECT`-only on those specific tables (it still needs full read/write on its own
      `vendor_*` tables) as defense-in-depth, so an application bug can't silently corrupt the main
      product's data.
- [ ] **Network isolation**: this should be reachable only from an internal network / VPN, never
      the public internet — there's no product reason for it to be, and every reason (commercially
      sensitive data, single shared admin credential, no per-user audit trail) not to be.
- [ ] **This git branch itself**: `vendor-portal/README.md` documents that this app deliberately
      lives only on the local `local/vendor-portal` branch, never merged into `main`, never pushed
      to `origin`, backed by a local (untracked) pre-push hook that rejects pushing any `local/*`
      branch. That's a source-control policy, not a deployment restriction — it doesn't stop you
      deploying the *running app* to real internal infrastructure, but don't let a deployment
      process (CI, a build script, a colleague's clone) inadvertently push or merge this branch in
      the process of standing the app up somewhere.
- [ ] **Backups**: this app owns no data backup mechanism of its own — its tables live in the same
      Postgres instance the main app uses, so whatever backup/restore process already covers that
      database covers this app's tables too. Confirm that's actually true rather than assuming it.
- [ ] **Log the single admin login**: since there's no per-user audit trail, at minimum make sure
      your reverse proxy's access logs (or the Node process's own stdout, which Express logs
      nothing to by default beyond the startup line) are retained somewhere, so "who used the admin
      account and when" is reconstructible from IP/timestamp if it's ever needed.

### Explicitly out of scope for this application
- Multi-user access control / audit trail — there is exactly one account by design; if your
  organisation needs per-person accountability for vendor/contract changes, that's a product change
  to this app, not a deployment configuration.
- File upload handling — not applicable; no binary uploads anywhere in this app.
