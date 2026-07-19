# Deployment Guide — Standalone MariaDB + PHP API + Static Frontend

This guide covers deploying Enkl's **self-hosted, MariaDB-backed tier** on infrastructure your
organisation owns and operates directly — no Docker, no managed platform assumptions. Three
independent pieces:

1. **MariaDB** — a database instance you provision and own.
2. **MariaDB API** (`mariadb-api/`) — a Slim 4 application, run under php-fpm behind a web server.
3. **Static frontend** — a single self-contained `index.html` file, produced by `npm run build`.

This is a **third**, parallel deployment path alongside the repo's Docker Compose stack (the .NET
tier) and `DEPLOYMENT-PHP.md` (the Postgres/PHP tier). All three API tiers speak the exact same HTTP
contract and share the same frontend unmodified, so everything in this guide applies only to the
MariaDB tier — **do not run more than one tier against the same database, and never point two
different tiers' own databases at each other** (a MariaDB instance provisioned for this tier is not
interchangeable with either Postgres tier's own database — the schemas, while equivalent in shape,
are not byte-compatible).

```
                    ┌─────────────────────────────────────────────┐
   HTTPS            │              Reverse proxy / LB             │
  (browser) ───────► │   TLS termination + security headers        │
                    │   /            → static index.html          │
                    │   /api/*, /health → php-fpm upstream         │
                    └───────────────┬───────────────────────────────┘
                                    │ (plain HTTP, private network)
                            ┌───────▼────────┐
                            │  php-fpm pool   │
                            │  (mariadb-api/) │
                            └───────┬────────┘
                                    │ PDO / pdo_mysql (TLS if possible)
                            ┌───────▼────────┐
                            │   MariaDB 11.4  │
                            │  (11.x minimum) │
                            └────────────────┘
```

---

## 1. Provision MariaDB

- **Version**: MariaDB 11.4 is what this tier's own tooling and tests are verified against. Earlier
  11.x releases are likely fine (nothing in this tier's migrations uses an 11.4-specific feature),
  but 11.4 is the only version this has actually been run against — treat anything older as
  unverified, not unsupported outright.
- Create a dedicated database and a dedicated, least-privilege application user — do not use the
  MariaDB `root` account for the application connection:

  ```sql
  CREATE DATABASE enkl CHARACTER SET utf8mb4;
  CREATE USER 'enkl_app'@'%' IDENTIFIED BY '<a long, randomly generated password>';
  GRANT ALL PRIVILEGES ON enkl.* TO 'enkl_app'@'%';
  ```

  The application itself creates every table via its own migrations (see §2.4) — you only need to
  create the empty database and a user with rights inside it. It does **not** need
  database-creation or account-management privileges, and does not need `SUPER`.

  **One MariaDB-specific exception**: `src/Db/migrations/006_saved_queries_and_public_api.sql`
  itself issues `CREATE USER IF NOT EXISTS 'enkl_public_query'@'%'` and `GRANT SELECT` statements
  for the Public Query API feature (a second, deliberately low-privilege account the app creates
  for itself — see `mariadb-api/CLAUDE.md` §4.2) — so `enkl_app` **does** need `CREATE USER` and
  `GRANT OPTION` privileges scoped to what it needs to create that one low-privilege account, e.g.:
  ```sql
  GRANT CREATE USER ON *.* TO 'enkl_app'@'%';
  GRANT SELECT ON enkl.* TO 'enkl_app'@'%' WITH GRANT OPTION;
  ```
  If your database name is anything other than the default `enkl`, that migration's `GRANT SELECT
  ON \`enkl\`.\`viewname\`` statements need the schema-qualifier changed to match **before** you run
  migrations for the first time (MariaDB's `GRANT` syntax is schema-qualified, unlike Postgres's own
  schema-relative `GRANT`) — see the migration file's own header comment.
- **Session settings the app configures itself, not you**: `Db/Database.php` sets `sql_mode`
  (appending `ANSI_QUOTES`) and `time_zone = '+00:00'` on every connection it opens. You don't need
  to (and shouldn't) set either of these at the server/`my.cnf` level — they're connection-scoped by
  design, so the app behaves consistently regardless of what the server's own defaults happen to be.
- **Network exposure**: MariaDB should **not** be reachable from the public internet. Bind it to a
  private network/VPC and restrict inbound connections (via MariaDB's own user `@host` grants and/or
  a security group/firewall) to only the host(s) running the MariaDB API.
- **Encryption in transit**: enable TLS on the MariaDB connection (`ssl_cert`/`ssl_key`/`ssl_ca` in
  the server's config, `REQUIRE SSL` on the application user's grant). PDO's `pdo_mysql` driver
  supports TLS via DSN options if you need to pin a CA certificate client-side.
- **Backups**: set up automated `mariabackup`/`mysqldump` (or your platform's managed-backup
  equivalent), with tested restores — there is no backup mechanism built into the application.

---

## 2. Deploy the MariaDB API

### 2.1 Requirements

- PHP **8.2+**
- PHP extensions: `pdo_mysql`, `mysqli`, `openssl`. (Unlike the Postgres/PHP tier, this tier has no
  extra extension requirement for its live-update stream — see §2.4's SSE note.)
- [Composer](https://getcomposer.org/).
- A web server capable of running PHP behind php-fpm (nginx or Apache). `php -S` is fine for a
  quick smoke test but is not a production server.

### 2.2 Install

```bash
cd mariadb-api
composer install --no-dev
cp .env.example .env
```

### 2.3 Configure `.env`

| Variable | Required | Notes |
|---|---|---|
| `DB_HOST` | yes | Your MariaDB host — **not** assumed to be `localhost` or a Docker service name |
| `DB_PORT` | | default `3306` |
| `DB_NAME` | yes | default `enkl` — see §1's note if you use a different name |
| `DB_USER` | yes | the least-privilege user from §1 |
| `DB_PASSWORD` | yes | **must not** be left as `change-me` — the app hard-fails at startup outside `APP_ENV=development` if it is empty or still the placeholder |
| `DB_PUBLIC_QUERY_USER` / `DB_PUBLIC_QUERY_PASSWORD` | yes if using the Saved Query API | must match whatever password migration `006` actually created the `enkl_public_query` account with |
| `JWT_SIGNING_KEY` | yes | **must** be a cryptographically random string, 32+ characters. Same hard-fail-if-placeholder/empty/short guard applies. Generate with e.g. `openssl rand -base64 48` |
| `JWT_ISSUER` / `JWT_AUDIENCE` | | defaults `Enkl.Api` / `Enkl.App` — only change if you also change them consistently everywhere tokens are validated |
| `JWT_EXPIRY_HOURS` | | default `8` |
| `RUN_MIGRATIONS_ON_STARTUP` | | default `true` — see §2.4 |
| `APP_ENV` | yes | set to `production`. `development` disables the secrets guard above and leaks exception details in error responses — never use it in production |
| `APP_PUBLIC_BASE_URL` | yes if using SAML/SSO | the browser-facing scheme+host (no trailing slash), e.g. `https://enkl.example.org`. Used to build the SAML SP entity id/ACS URL and SCIM base URL — **cannot** be correctly derived from the incoming request if a reverse proxy in front doesn't forward the original scheme |

Never commit a real `.env` to version control. Prefer injecting these as real process environment
variables (systemd unit `Environment=`/`EnvironmentFile=`, or your platform's secrets manager) over
a plaintext `.env` file sitting on disk where possible.

### 2.4 Run migrations

```bash
php migrate.php
```

Safe to re-run any time — already-applied migrations are tracked in a `migrations_history` table
and skipped. With the default `RUN_MIGRATIONS_ON_STARTUP=true`, the API also re-checks for and
applies any new migration on every process boot, so the explicit command above is mainly needed for
the very first deploy, or if you'd rather run schema updates out-of-band ahead of a rollout (set
`RUN_MIGRATIONS_ON_STARTUP=false` if so).

**MariaDB-specific limitation, not a bug**: unlike the Postgres tiers, DDL here is **not**
transactional — MariaDB auto-commits `CREATE TABLE`/`ALTER TABLE` statements immediately regardless
of any surrounding transaction (see `src/Db/Migrator.php`'s own doc comment for the full
explanation). In the rare case a migration file fails partway through (e.g. a syntax error in its
second statement), its first statement's schema change may already be applied even though the whole
file isn't marked as applied in `migrations_history` — re-running `php migrate.php` naively would
then retry the same first statement and fail with a "table/column already exists" error. **Recovery**:
inspect what actually applied (`SHOW TABLES`, `DESCRIBE <table>`), manually finish whatever the
failed migration file was supposed to do, then insert its own history row by hand:
```sql
INSERT INTO migrations_history (migration_name, applied_at) VALUES ('NNN_migration_name', NOW());
```
so the next run doesn't retry it. This is an inherent MariaDB/MySQL characteristic every migration
tool for these engines has to live with, not something specific to this app's own `Migrator.php`.

**No extra extension needed for live updates**: this tier's SSE stream (`/api/events/stream`) polls
an internal `Events` table every ~2 seconds rather than using Postgres's `LISTEN`/`NOTIFY` (which
MariaDB has no equivalent for at all) — see `mariadb-api/CLAUDE.md` §4.4. This means, unlike the
Postgres/PHP tier, you do **not** need any extra PHP extension analogous to `ext-pgsql` for this
feature; ordinary `pdo_mysql` is all it uses.

### 2.5 Run under php-fpm

Point a php-fpm pool at `public/index.php`, with the **document root set to `mariadb-api/public`**
(not the `mariadb-api/` root — nothing outside `public/` should ever be web-accessible). Example
pool snippet:

```ini
[enkl-mariadb-api]
listen = /run/php-fpm/enkl-mariadb-api.sock
user = www-data
group = www-data
pm = dynamic
pm.max_children = 20
env[APP_ENV] = production
; ...or load all config via EnvironmentFile in the systemd unit that starts php-fpm
```

Do not expose php-fpm's TCP port (if used instead of a socket) beyond the host it runs on — only
the reverse proxy in front of it should be able to reach it.

---

## 3. Build and deploy the static frontend

```bash
npm install
npm run build
```

This produces a **single self-contained file**, `dist/index.html` — the JS bundle, minified CSS,
and the keyword-matching web worker's source are all inlined into it. There is nothing else to
deploy: no separate `.js`/`.css`/asset files. Copy that one file to your web server's document root
as `index.html`.

The frontend calls its API at a **same-origin relative path**, `/api/...` — there is no
build-time or runtime configuration for pointing it at a different origin. The static file host and
the MariaDB API **must** be reachable through the same origin, with the API reverse-proxied under
`/api/`, exactly as set out in §4 below.

Rebuild and redeploy this file after every frontend code change — it is a build artifact, not
something to hand-edit.

---

## 4. Reverse proxy configuration

Everything (static file serving, `/api/` proxying, `/health` proxying, and security headers) needs
to live behind one reverse proxy so the frontend's same-origin assumption holds. The repo's own
`web/nginx.conf` is written for the Docker/.NET stack but the shape is identical for this tier —
only the upstream changes (a php-fpm socket instead of a container). Example, adapted:

```nginx
server {
  listen 80;
  root /var/www/enkl/html;   # wherever you copied dist/index.html to

  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; manifest-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;

  # SSE live-update stream — must not be buffered, and needs a long read timeout since the
  # connection stays open for hours (the app sends a ping roughly every 15s to keep it alive,
  # underneath which it polls its own Events table every ~2s — see §2.4's note on why no
  # LISTEN/NOTIFY-equivalent extension is needed here).
  location /api/events/ {
    fastcgi_pass unix:/run/php-fpm/enkl-mariadb-api.sock;
    fastcgi_param SCRIPT_FILENAME /var/www/enkl/mariadb-api/public/index.php;
    include fastcgi_params;
    fastcgi_param HTTP_AUTHORIZATION $http_authorization;   # PHP's fastcgi_params doesn't forward this by default
    fastcgi_buffering off;
    fastcgi_read_timeout 1h;
  }

  location /api/ {
    fastcgi_pass unix:/run/php-fpm/enkl-mariadb-api.sock;
    fastcgi_param SCRIPT_FILENAME /var/www/enkl/mariadb-api/public/index.php;
    include fastcgi_params;
    fastcgi_param HTTP_AUTHORIZATION $http_authorization;
  }

  location = /health {
    fastcgi_pass unix:/run/php-fpm/enkl-mariadb-api.sock;
    fastcgi_param SCRIPT_FILENAME /var/www/enkl/mariadb-api/public/index.php;
    include fastcgi_params;
  }

  location / {
    try_files /index.html =404;
  }
}
```

Notes:
- `Authorization` must reach the app — the API is bearer-JWT-only (no cookies, no sessions), and
  standard `fastcgi_params`/reverse-proxy configs often strip this header by default. Confirm it
  arrives (test a request with `Authorization: Bearer ...` and check the API actually sees it).
- If proxying to php-fpm via a TCP upstream instead of PHP directly (e.g. `proxy_pass` to an
  Apache/php-fpm HTTP frontend) instead of `fastcgi_pass`, forward `X-Forwarded-For` and
  `X-Forwarded-Proto` too — `RateLimitMiddleware` partitions by the first `X-Forwarded-For` entry
  (falling back to the raw connecting IP if absent), and `APP_PUBLIC_BASE_URL` combined with a
  correct forwarded scheme is what SAML's redirect URLs depend on.
- `/health` is intentionally **not** under `/api/` — every API tier exposes it at their own root,
  and the frontend's connectivity probe (`api.js`'s `pollApiReachability`) relies on it being
  reachable same-origin at exactly this path.

### 4.1 TLS termination

**Nothing in this stack terminates TLS on its own** — the example above listens on plain HTTP 80
only, matching the repo's own reference config. This is only safe once a TLS-terminating layer sits
in front of it: a cloud load balancer, an ingress controller, or a `listen 443 ssl` server block
with real certificates on this same host. Before going live, do one of:

- Put a TLS-terminating load balancer/ingress in front and confirm **it** sets
  `X-Forwarded-Proto: https` on every request it forwards (the API trusts this header
  unconditionally for building SAML redirect URLs and API responses — safe only if nothing except
  your trusted proxy can reach the app directly), **or**
- Add a real `listen 443 ssl;` block with a valid certificate (e.g. via Let's Encrypt/certbot)
  directly in this nginx config, and redirect all plain-HTTP traffic to it.

Never expose the php-fpm socket/port, or MariaDB, directly to any network the TLS-terminating
layer doesn't control.

---

## 5. Verify a fresh deployment

```bash
curl https://your-domain/health
# {"status":"ok"}
```

Then either:
- Migrate an existing local Enkl project into the fresh install via `POST /api/migration/projects`
  (the same JSON shape `exportProjectJSON()` produces client-side in the browser) — this single call
  creates the organisation too if it doesn't already exist (see `organisationName` in the request
  body), or
- Create an org/user directly in the database and sign in via the frontend's Login screen
  (`POST /api/auth/login`).

Confirm in the browser:
- The app loads and the header key badge shows the cloud icon for a migrated project.
- The connectivity pulse on that key is green (confirms `/health` is reachable same-origin through
  your proxy).
- Live updates (the SSE stream) work across two open tabs — edit a task in one, watch it update in
  the other within a couple of seconds (not instant — this tier polls rather than pushes, see §2.4).
  This is the single best end-to-end proof the reverse proxy's buffering/timeout settings for
  `/api/events/` are correct.

---

## 6. Security best practices checklist

Most of the following is already implemented in the application — this checklist is about not
undermining it at the infrastructure layer, plus the handful of things that are genuinely your
responsibility to configure.

### Already built in (verify you haven't disabled or bypassed it)
- [ ] **Passwords**: bcrypt (`PASSWORD_BCRYPT`, cost 12) — do not weaken this.
- [ ] **JWTs**: HS256, `iss`/`aud` checked on every request, 60s clock-skew leeway, and a live
      **SecurityStamp** check on every authenticated request — changing a password, deactivating a
      user, or toggling org-admin immediately invalidates every previously-issued token for that
      user, not just at expiry. Don't add a JWT-caching layer in front that could serve a stale
      validation result.
- [ ] **MustChangePassword enforcement**: a fresh/reset account can only call
      `POST /api/auth/change-password` until its password is changed — every other mutating
      request is rejected. Reads still work. Don't route around this.
- [ ] **Rate limiting**: 10 requests/60s per client IP on the login, SSO lookup/exchange,
      change-password, and anonymous-migration endpoints, DB-backed (via InnoDB row locking, not
      Postgres's advisory locks — see `mariadb-api/CLAUDE.md` §4.3) so it holds across php-fpm
      workers. This is what makes correct `X-Forwarded-For` forwarding from your proxy
      security-relevant, not just cosmetic — get it wrong and every client behind the proxy shares
      one rate-limit bucket (denial-of-service risk) or the limit is trivially bypassable (an
      attacker just needs to vary a header the proxy trusts blindly).
- [ ] **SAML replay protection & certificate validation**: every outgoing `AuthnRequest` ID is
      single-use; IdP signing certificates are validated for expiry and RSA key strength (≥2048
      bits) at save time. Don't hand-edit `OrganisationSsoConfigs` rows to bypass this.
- [ ] **SCIM** endpoints use a separate, per-organisation bearer token (bcrypt-hashed at rest), not
      a user JWT — rotate an org's SCIM token immediately if you suspect it's leaked (there is
      presently no automatic expiry).
- [ ] **Public Query API isolation**: the dedicated `enkl_public_query` MariaDB account can only
      `SELECT` from a fixed set of views, each transparently scoped to one project per request via
      a per-connection context table (see `mariadb-api/CLAUDE.md` §4.2) — it can never see another
      project's data or write anything, regardless of what SQL a saved query contains.

### Your responsibility to configure correctly
- [ ] **TLS everywhere in transit** — browser↔proxy (§4.1), and ideally proxy↔php-fpm and
      PHP↔MariaDB too if they cross any network segment you don't fully trust. As shipped, nothing
      in this stack enforces TLS on its own.
- [ ] **`JWT_SIGNING_KEY` and `DB_PASSWORD`**: real, unique, randomly generated secrets — the app
      refuses to boot in production with the checked-in placeholder values, but confirm nothing
      overrides `APP_ENV` to `development` in production to route around that guard.
- [ ] **Least-privilege database user** (§1) — not the MariaDB `root` account, and only the narrow
      `CREATE USER`/`GRANT OPTION` scope §1 describes, not blanket `SUPER`.
- [ ] **Network segmentation**: MariaDB and the php-fpm socket/port should be unreachable except
      from the exact hosts that need them. Nothing about this application enforces network-level
      isolation for you.
- [ ] **`X-Forwarded-Proto`/`X-Forwarded-For` set only by a proxy you control**, and the app only
      ever reachable through that proxy — both are trusted unconditionally once they arrive.
- [ ] **`APP_PUBLIC_BASE_URL`** set correctly and matching what users actually type into their
      browser, if you use SAML SSO — a mismatch breaks the SP entity id/ACS URL your IdP expects.
- [ ] **Secrets out of source control and off disk where possible** — use your platform's secrets
      manager or at minimum an `.env` file with restrictive filesystem permissions
      (`chmod 600`, owned by the php-fpm user only), never committed to git.
- [ ] **CORS**: none is configured, by design, because the app is only ever reached same-origin
      through your reverse proxy. If you ever need the API reachable from a different origin
      (a separate SPA domain, a mobile app calling it directly, etc.), you must add explicit CORS
      middleware yourself — do not simply widen `Access-Control-Allow-Origin` to `*` anywhere.
- [ ] **Composer dependencies**: `composer install --no-dev` in production (skip dev tooling), and
      keep dependencies patched — `composer outdated` / `composer audit` periodically. In
      particular, `onelogin/php-saml` should stay at 4.3.1+ (the pinned version here is already past
      the disclosed advisory GHSA-5j8p-438x-rgg5).
- [ ] **Backups and restore testing** for MariaDB (§1) — nothing in the application layer backs
      up your data.
- [ ] **Log monitoring**: `RUN_MIGRATIONS_ON_STARTUP` logs applied migrations via `error_log()` on
      every boot — route php-fpm/web-server error logs somewhere you actually watch, so an
      unexpected schema change or a wave of 401/403/429 responses gets noticed.
- [ ] **Don't run more than one API tier against the same database in production** — treat this as
      an either/or deployment choice, not a load-balanced pair, and never point this tier's own
      MariaDB database at a Postgres tier's connection details or vice versa (the schemas are
      equivalent in shape but not wire-compatible).

### Explicitly out of scope for this application (handle at your layer if needed)
- CSRF protection — not applicable; there are no cookies or server-side sessions, only bearer JWTs
  sent explicitly by the frontend's own JS.
- File upload virus scanning / storage — not applicable; the app stores no binary uploads, only
  URLs/text for documents and attachments.
