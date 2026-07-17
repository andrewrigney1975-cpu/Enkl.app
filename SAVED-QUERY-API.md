# Public Query API — Design, Provisioning, and Usage Guide

This document covers the "Expose via API" feature on the Advanced Query tab's Saved Query Library:
letting a 3rd-party application fetch the results of a specific saved SQL query as JSON, over plain
HTTP, authenticated by a per-Organisation API key rather than a user login. It's the app's first
public/3rd-party-facing API surface and the first time this codebase executes SQL server-side (every
other execution of the Advanced Query grammar happens client-side, in the browser, via AlaSQL).

See `CLAUDE.md` §20 for the terse architecture-reference version of this same material, cross-linked
with the rest of the codebase's conventions. This file is the standalone, org-facing explanation.

---

## 1. Design overview

```
                     ┌───────────────────────────────────────────────────────┐
 3rd-party app       │                      Enkl API                        │
 (server-side,   ──► │  GET /api/public/v1/queries/{savedQueryId}/results   │
  not a browser)     │  Authorization: Bearer <org API key>                  │
                     └───────────────────────┬───────────────────────────────┘
                                             │
                             1. ApiKeyAuthFilter/Middleware:
                                - look up SavedQuery by id
                                - reject unless ExposeViaApi = true
                                - hash-verify the bearer token against
                                  this query's Organisation's API key
                                - (all failure modes → identical 404)
                                             │
                             2. PublicQueryExecutionService:
                                - open a SEPARATE, low-privilege
                                  Postgres connection
                                             │
                     ┌───────────────────────▼───────────────────────────────┐
                     │  Postgres role: enkl_public_query (SELECT-only)       │
                     │  SET LOCAL app.query_project_id = '<project id>'      │
                     │  translates [bracket] quoting to "double" quoting,    │
                     │  then runs the saved query's SQL text against 10      │
                     │  project-scoped views, exact-cased/aliased to match   │
                     │  the Advanced Query grammar: "tasks", "columns",      │
                     │  "members", "risks", "decisions", "principles",       │
                     │  "objectives", "documents", "releases", "taskTypes",  │
                     │  "teamsCommittees"                                    │
                     └───────────────────────┬───────────────────────────────┘
                                             │
                             3. rows returned as JSON, transaction
                                rolled back (nothing ever persists)
                                             │
                     ┌───────────────────────▼───────────────────────────────┐
                     │  { "rows": [ {...}, {...} ], "truncated": false }     │
                     └───────────────────────────────────────────────────────┘
```

### Why a saved query can be exposed at all

Every project member with Project Admin or Org Admin rights can already build and save arbitrary
read-only SQL against their own project's data in the Advanced Query tab. "Expose via API" doesn't
grant any *new* data access — it just adds a second way to run a query someone with that access
already wrote and saved, without requiring a logged-in session. The org still controls exactly which
queries are reachable this way (one `ExposeViaApi` flag per saved query, off by default) and can
revoke access to all of them at once by revoking the org's API key.

### Why this needed real, server-side SQL execution

The Advanced Query engine (`query-engine.js`) runs entirely in the browser via a bundled SQL
library (AlaSQL), over an in-memory JavaScript object built from whatever project is currently open.
There's no server-side equivalent — until this feature, the server only ever stored a saved query's
SQL text as an opaque string. A public HTTP endpoint has no browser and no "currently open project"
to build that in-memory object from, so the server has to actually execute the SQL itself for the
first time.

Two ways to do that were considered:

1. **Reimplement the query engine server-side** — port AlaSQL's table definitions and execution
   logic into both the .NET and PHP backends. Rejected: this would be a real SQL-on-objects engine,
   built and maintained twice, forever kept in lockstep with the JavaScript version — a large,
   ongoing cost for a codebase that already carries the burden of two backend tiers.
2. **Run the query directly against Postgres, through a locked-down role** (chosen) — every "table"
   the Advanced Query grammar exposes (`tasks`, `risks`, `columns`, ...) already maps 1:1 to a real
   Postgres table, so there's no translation layer to build. Instead of trying to make the *SQL text*
   provably safe (parsing, sandboxing, an allow-list of SQL constructs), the safety boundary is moved
   to something Postgres already enforces natively: **what tables can this database role see at
   all.**

### The safety model, concretely

A dedicated Postgres role, `enkl_public_query`, is created by the database migration
(`AddSavedQueryApiExposure` / `023_add_saved_query_api_exposure.sql`); the queryable views
themselves were corrected in a follow-up migration (`FixSavedQueryApiViews` /
`024_fix_saved_query_api_views.sql`, see the note below). The role has:

- `SELECT` only, on exactly ten views — `"tasks"`, `"columns"`, `"members"`, `"risks"`,
  `"decisions"`, `"principles"`, `"objectives"`, `"documents"`, `"releases"`, `"taskTypes"`,
  `"teamsCommittees"` — named and columned to match the Advanced Query grammar exactly (lowercase
  table names, camelCase field names like `columnId`/`dateCreated`), so a saved query written
  against that grammar runs against them without any manual translation on the query author's part.
- No access to any other table — not `Organisations`, not `Users`, not the real `Tasks`/`Risks`/etc.
  tables, not anything belonging to any org other than the one the query's project belongs to.
- No write access anywhere, including to the ten views it can read.

Each view is hard-filtered to a single project via a Postgres session variable
(`current_setting('app.query_project_id', ...)`) that the execution service sets, inside a
transaction, immediately before running the saved query's SQL text. That transaction is always
rolled back afterward; nothing is ever written. Fields that are arrays of related-record ids on the
client side (a task's dependency ids, a risk's linked document ids, etc.) are computed via a
correlated subquery in the view definition, since there's no single database column to point at —
the view is what does that assembly, not the execution service.

Two small text transformations happen to the saved SQL immediately before it's sent to Postgres,
neither of which is a security boundary (the grant boundary above is what actually matters) — they
exist purely so a query written for the in-browser AlaSQL engine also runs, unmodified, here:

- **Bracket-to-double-quote translation.** The SQL formatter/intellisense in the Advanced Query tab
  bracket-quotes every identifier (`[tasks].[title]`) — that's valid syntax for AlaSQL, but Postgres
  has no bracket-quoting at all. `PublicQueryExecutionService` rewrites `[x]` to `"x"` (skipping
  anything inside a single-quoted string literal) before running the query.
- **Exact-cased, exact-named views**, as above — so `FROM [tasks]` (after bracket translation, `FROM
  "tasks"`) resolves to a real, case-sensitive Postgres relation with that literal name.

The practical effect: even though a saved query's SQL text is executed essentially verbatim (modulo
the harmless quoting-syntax translation above), it is **physically incapable** of reading another
project's data, another organisation's data, or any table outside the ten exposed views — the
database itself refuses, regardless of what the query asks for. This was confirmed directly:

```
$ psql -U enkl_public_query -d enkl -c 'SELECT * FROM "Organisations" LIMIT 1;'
ERROR:  permission denied for table Organisations

$ psql -U enkl_public_query -d enkl -c 'DELETE FROM "tasks";'
ERROR:  permission denied for view tasks
```

> **Note on the two text transformations above**: the first version of this feature only had the
> grant-boundary/view-scoping design and skipped both transformations, on the assumption every
> queryable table already mapped 1:1 to a real column. The very first real saved query run through
> it (from a real user, not the test suite's trivial `SELECT 1`) failed with a syntax error, which
> traced back to both gaps at once — the bracket-quoting mismatch, and several `TABLE_SCHEMAS`
> fields (task dependencies, risk/decision/objective cross-links, team membership) that only exist
> as junction tables client-side, not a plain column. Fixed in the `024_fix_saved_query_api_views`
> migration described above.

Two smaller, defense-in-depth measures sit on top of that primary control:

- **A forbidden-keyword check** (`CREATE`, `DELETE`, `DROP`, `INSERT`, `UPDATE`, `ALTER`, `TRUNCATE`,
  `ATTACH`, `DETACH`, `GRANT`, `REVOKE`) rejects a saved query containing any of those words before
  it's even sent to Postgres, with a clean `400` response instead of a raw permission-denied error.
  This is redundant with the role's own grants by design — it exists so a mistake never surfaces as
  an ugly database error, not because it's load-bearing.
- **A 5-second statement timeout** and a **1000-row cap** (with a `truncated: true` flag on the
  response if a query would have returned more) bound the worst case for an expensive or unbounded
  query — this connection is shared infrastructure across every organisation's exposed queries, not a
  resource dedicated to one caller.

---

## 2. Provisioning an API key

An API key is scoped to the whole Organisation, not to an individual saved query or project — one
key unlocks every saved query in the org that currently has "Expose via API" turned on. This mirrors
how the org's SCIM bearer token already works (one token for the whole org's user-provisioning
integration).

### Generating a key

1. As an Org Admin, open **Account menu → SSO & Provisioning**.
2. Scroll to the **Public API key** section.
3. Click **Generate new API key**.
4. The raw key is shown once, in a box labeled with a warning that it will not be shown again. Copy
   it immediately into wherever the 3rd-party integration will read it from (a secrets manager, an
   environment variable on the calling service, etc.) — there is no way to retrieve it again later.

Equivalent API call (useful for scripting key rotation):

```
POST /api/organisations/me/api-key
Authorization: Bearer <org admin's own JWT>

→ { "key": "enkl_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Only what's stored server-side survives generation: a bcrypt hash of the key (same hashing scheme
used for user passwords and the SCIM token), a generated timestamp, and an enabled flag. The server
can verify a presented key matches, but can never display or recover the original value.

### Rotating a key

Generating a new key immediately invalidates whatever key existed before — there is no way to have
two valid keys active for the same organisation at once. If a 3rd-party integration needs a rotation
with zero downtime, coordinate the swap: generate the new key, update the calling application's
configuration, confirm it's working, and only then consider the rotation complete (the old key is
already gone from the moment the new one was generated, so there's no overlap window to rely on).

### Revoking a key

Click **Revoke** in the same panel, or:

```
DELETE /api/organisations/me/api-key
Authorization: Bearer <org admin's own JWT>
```

This soft-disables the key (the row is kept for audit purposes — `GeneratedAt`/`LastUsedAt`
timestamps remain visible in the admin panel) but the key stops working on its **very next request**.
There is no propagation delay, cache to expire, or session to wait out — this was verified directly:
a request that succeeded with a key immediately started returning `404` the moment that key was
revoked, using the same live-running key value.

Revoking is the fastest way to shut off *every* exposed query for the org at once, without having to
find and un-toggle each individual saved query's "Expose via API" flag.

---

## 3. Exposing a specific saved query

Turning on public access is a per-query decision made by whoever can already manage the project's
Advanced Query tab (a Project Admin or Org Admin on that project):

1. Open the project's **Advanced Query** tab (via Project Search → Advanced Query).
2. Write and save a query as usual, or load an existing saved query.
3. Check **Expose via API**, then Save (or Update, if editing an existing saved query).
4. Once saved, the tab shows the query's public URL with a **Copy URL** button — this is exactly the
   URL to hand to the 3rd-party integration, alongside the org's API key.
5. A **Test API (GET)** button sits next to it. Clicking it runs the query through the exact same
   server-side execution path the real public endpoint uses and shows the result — status, row
   count, and the full JSON response — in a scrolling box underneath, the same way "try it out" works
   in a Swagger/OpenAPI explorer. This is a convenience for confirming a query returns what's
   expected *before* handing the URL and key to a 3rd party, without needing a separate HTTP client.
   It authenticates using your own logged-in session, not the org's actual API key — the raw key is
   never retrievable after generation (see §2), so there's nothing for this button to send even if it
   wanted to call the real endpoint directly. The results are identical either way; only how the
   request proves who's allowed to run it differs.

The URL has the shape:

```
GET /api/public/v1/queries/{savedQueryId}/results
```

The `savedQueryId` is a random UUID with no relationship to the organisation or project id — knowing
one saved query's URL does not help discover any other query, project, or organisation's data. There
is deliberately no org or project identifier anywhere in the URL; the server resolves both internally
from the saved query row itself once the API key has been validated against it.

Unchecking "Expose via API" (or deleting the saved query entirely) makes that specific URL start
returning `404` immediately, independent of whether the org's API key is still otherwise valid.

**Local-only projects cannot use this feature at all.** A project that has never been migrated to a
server-backed organisation has no `SavedQueries` row, no `Projects` row, and no `Organisation` row
anywhere on the server — there is nothing for an API key or a Postgres view filter to attach to. The
"Expose via API" checkbox is not shown at all for such a project (not merely greyed out); the project
must first be migrated to a real organisation before any of its saved queries can be exposed.

---

## 4. Calling the API (for the 3rd-party integration)

```
GET /api/public/v1/queries/{savedQueryId}/results
Authorization: Bearer enkl_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Successful response:

```json
{
  "rows": [
    { "title": "Fix login bug", "priority": "high", "columnId": "..." },
    { "title": "Write onboarding docs", "priority": "medium", "columnId": "..." }
  ],
  "truncated": false
}
```

`rows` is a plain array of row objects — one object per result row, keyed by whatever column names
or aliases the saved SQL used — not a `{columns: [...], rows: [...]}` wrapper. `truncated` is `true`
only if the query would have returned more than 1000 rows; the response still contains the first
1000 in that case.

### Error responses

Every one of the following situations returns the **exact same** `404 { "message": "Not found." }`
response, by design — there is no way to distinguish any of them from the response alone:

- The `savedQueryId` in the URL doesn't exist.
- The saved query exists, but "Expose via API" is turned off for it.
- The `Authorization` header is missing or malformed.
- The API key is wrong, was never generated, or has been revoked.
- The API key is valid, but belongs to a **different** organisation than the one that owns this
  saved query's project.

This is deliberate, not an oversight: a system that gave a different error for "this id doesn't
exist" versus "this id exists but you can't access it" would let a caller probe for the existence of
other organisations' saved queries by trial and error. From the outside, "wrong key" and "right key,
wrong query" look identical.

A `400` response (with a caller-facing message) means the query itself failed to run — most commonly
because the saved SQL contains a disallowed write/schema keyword. This is the one case where the
response body explains what went wrong, since it reflects a problem with the query's own text rather
than an authorization decision.

A `429` response means the rate limit (below) has been hit — retry after a short wait.

### Rate limiting

Requests are limited per API key (not per calling IP address), currently 60 requests per minute per
key, using a sliding window. Partitioning by key rather than IP means:

- A 3rd-party integration running from a shared or NAT'd IP address (common for server-side
  integrations, serverless functions, etc.) isn't penalized by unrelated traffic from other tenants
  on that same IP.
- One organisation's high-volume integration can't be starved by, or accidentally starve, another
  organisation's usage, even if both happen to originate from infrastructure sharing an IP.

A request that fails authorization (wrong/missing key) still counts toward the rate limit for
whatever key value was presented — this prevents the rate limit itself from becoming a way to probe
for valid keys by brute force without cost.

---

## 5. Real-world usage pattern

A typical integration:

1. An Org Admin generates an API key once, and stores it in whatever secrets store the 3rd-party
   system uses (never checked into source control, never embedded in client-side/browser code — this
   is a server-to-server credential).
2. A Project Admin builds and saves a small number of specific, purpose-built read-only queries in
   the Advanced Query tab — e.g. "open high-priority tasks", "this quarter's completed releases",
   "current risk register" — and turns on "Expose via API" for exactly those, and only those.
3. The 3rd-party system (a BI dashboard, a status page, an internal reporting tool, a Slack bot, a
   data warehouse sync job, etc.) polls the relevant URL(s) on whatever schedule it needs, using the
   stored API key, and consumes the returned JSON.
4. If the integration is retired, or the key is ever suspected to have leaked, the Org Admin revokes
   the key from the SSO & Provisioning panel — this immediately cuts off every exposed query across
   every project in the organisation in one action, with no further cleanup required.

Because the underlying execution is real-time (the query runs against live data on every request,
not a cached snapshot), the caller always sees current results — there's no separate "refresh" or
sync step to manage on the Enkl side.

### What this feature is not for

- **Not a general-purpose external API.** Only the specific tables/columns the Advanced Query grammar
  already exposes are reachable, and only via a saved query someone with Project Admin/Org Admin
  rights deliberately wrote and flagged. There's no way to reach arbitrary endpoints, mutate data, or
  query anything outside a single project's own data.
- **Not per-user.** The API key identifies the organisation, not an individual person — anyone
  holding the key can call every query the org has exposed. If per-caller attribution or scoped
  access is ever needed, that's a different, larger feature than what exists today.
- **Not suitable for embedding directly in a browser or mobile app.** The key is a long-lived,
  organisation-wide secret; it belongs in a server-side integration's configuration, not in
  client-side code where any user of that app could extract it.
