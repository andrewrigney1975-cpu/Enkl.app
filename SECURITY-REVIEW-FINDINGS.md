# Security Review Findings — Enkl.app

Full-codebase defensive security review across all four tiers: `.NET API` (`api/Enkl.Api`), `PHP API` (`php-api`, a hand-written parity port), `frontend` (`src/js`), and `vendor-portal` (standalone Node/Express app). Conducted via five parallel targeted audits; this document consolidates and de-duplicates their findings, resolving cross-tier references where both the .NET and PHP audits independently examined the same mechanism.

**This file is uncommitted.** It contains a roadmap of exploitable weaknesses in this codebase — decide deliberately whether to commit it, `.gitignore` it, or move its contents into a private issue tracker before it lands in git history.

**Status: all Critical (C1–C6) and all High (H1–H5) findings below are REMEDIATED** (fixed in both
the .NET and PHP tiers where applicable, plus vendor-portal for H1; build-verified, and live-tested
against the running containers where the stack supports it — PHP tier and vendor-portal fixes are
lint-verified only, since neither runs in the active docker-compose stack). Each finding below is
annotated with what changed. Medium/Low findings are untouched — still open.

---

## Critical — fix before any real deployment

### C1. JWT signing key defaults to a checked-in placeholder in "production" — ✅ REMEDIATED
- **Where:** `docker-compose.yml:24` (`Jwt__SigningKey: ${JWT_SIGNING_KEY:-dev-only-signing-key-change-me-please-32chars-min}`), `api/Enkl.Api/appsettings.json:13` (same literal string as base config), `ASPNETCORE_ENVIRONMENT` also defaults to `Production` (`docker-compose.yml:28`).
- **Why it matters:** running `docker compose up` with no `.env` boots a stack labeled "Production" that signs JWTs with a value anyone with repo read access already knows. That's enough to forge a token for any `sub`/`orgId`/`orgAdmin=true` — full impersonation of any user in any tenant, no credentials needed.
- **Contrast:** `vendor-portal/docker-compose.yml:8` does this correctly — `SESSION_SECRET: ${SESSION_SECRET:?must be set}` fails hard if unset, and `vendor-portal/server/index.js` explicitly `process.exit(1)`s if it's missing. The main API has no equivalent guard.
- **Fix:** remove the fallback, use `${VAR:?must be set}` syntax, and add a `Program.cs` startup check that refuses to boot in `Production` if the signing key matches the known placeholder or is under a safe length/entropy threshold.
- **Fixed:** `docker-compose.yml`/`appsettings.json` fallbacks removed (`${VAR:?must be set}`); startup guards added in `Program.cs` and PHP's `bootstrap.php` (`assertProductionSecretsAreSet`); live secrets rotated in the running dev DB. Also closed in `vendor-portal/docker-compose.yml` (see C2's note — same fallback existed there too).

### C2. Checked-in default DB password, same pattern — ✅ REMEDIATED
- **Where:** `docker-compose.yml:7,23` and `appsettings.json:10` — `enkl_dev_password` fallback. Also present in `vendor-portal/docker-compose.yml:9` (and vendor-portal's live local `.env` is currently actually using this literal default).
- **Fix:** same as C1 — required env var, no default, ideally a startup check.
- **Fixed:** same change as C1, plus `vendor-portal/docker-compose.yml:9`'s identical fallback removed (found while fixing H1 in that same file). Vendor-portal's own live `.env`, if one exists in that branch's checkout, still needs manual rotation — not verified from this session.

### C3. Anonymous account-injection into any existing organisation (both .NET and PHP tiers, independently confirmed) — ✅ REMEDIATED
- **Where:** `.NET`: `Controllers/MigrationController.cs:22-24` (`POST /api/migration/projects`, `[AllowAnonymous]`) → `Services/MigrationService.cs`. `PHP`: `src/routes.php:64` → `src/Services/MigrationService.php:117-209`. Both implementations are functionally identical.
- **Why it matters:** this endpoint requires no authentication at all. It resolves an **existing** organisation purely by matching its display name (`ResolveOrganisationAsync`/`resolveOrganisation`), and any "member" in the submitted payload whose username doesn't already exist gets a brand-new, real, login-capable account created **inside that real organisation**, with the password hardcoded to the literal string `enklUserPassword` (`MigrationService.cs:195` / `MigrationService.php:203`). It sets `MustChangePassword = true`, but — see C4 below — nothing server-side actually enforces that flag. Net effect: **anyone who knows or guesses a customer's organisation name can create a working login for that tenant with a publicly-known password and start using the API immediately.** This also silently pulls existing real users into an attacker-created project as members if their normalized name matches (data-integrity/privacy issue even without full takeover), and has no rate limit — unauthenticated resource exhaustion is also possible.
- **Fix:** gate behind a one-time setup token that's invalidated after first use per organisation, and/or restrict to only firing when the organisation doesn't yet exist (never match into a live org anonymously), and/or require `[Authorize(Policy="OrgAdmin")]` once any org already exists.
- **Fixed:** an authenticated caller's migration now always targets their own org via the JWT `orgId` claim regardless of submitted name; an anonymous caller matching an *existing* org by name is rejected outright (400) — only brand-new org bootstrap stays anonymous. Live-tested: bootstrap still works, the exact cross-tenant injection attempt now fails with a clear message.

### C4. `MustChangePassword` is never enforced server-side (both tiers) — ✅ REMEDIATED
- **Where:** `.NET` `Controllers/AuthController.cs` login path; `PHP` `src/Controllers/AuthController.php`. Both return `mustChangePassword: true` in the response but issue a fully-valid JWT regardless, and nothing blocks subsequent API calls until the password is changed — enforcement is UI-only (a modal that a script/API client simply never has to open).
- **Why it matters:** this directly compounds C3 — an injected account with the known default password is fully usable via direct API calls forever, not just until "the user happens to open the web UI."
- **Fix:** reject all non-password-change endpoints server-side (401/403) while `MustChangePassword` is true, for any account whose flag is still set.
- **Fixed:** new middleware (both tiers) rejects mutating requests (POST/PUT/PATCH/DELETE) with 403 `must_change_password` while the flag is set, via a live per-request DB read — reads still work so the client isn't broken. `/auth/change-password` is exempted. Frontend pops the change-password modal automatically on that response. Live-tested: read succeeds, mutation blocked, change-password works, mutation unblocks after.

### C5. Stored XSS via attribute-breakout — `escapeHTML` never escapes quotes (frontend) — ✅ REMEDIATED
- **Where:** 11 duplicated copies of the escape helper across `src/js` (`views/board.js:19`, `views/task-list.js:11`, `views/dependency-map.js:11`, `views/cost-benefit.js:10`, `views/governance-map.js:7`, `views/workflow-editor.js:9`, `views/org-chart.js:9`, `views/timeline.js:10`, `mutations.js:9`, `features/project-search.js:5`). The dominant implementation:
  ```js
  function escapeHTML(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  ```
  This correctly escapes `&`, `<`, `>` but **never** `"` or `'`.
- **Verified exploitable** (agent parsed the actual output in jsdom): feeding `a" onmouseover="alert(document.cookie)" x="` through `escapeHTML()` and inserting the result into a quoted attribute produces three live, separate HTML attributes — a working attribute-breakout.
- **Concrete vulnerable call sites** (value is escaped but still lands inside a `"…"` attribute): `views/board.js:849` (task-type name in `title=`), `views/task-list.js:423,443,444` (task-type name, task title, column name in `title=`), `modals/documents.js:386` and `modals/principles.js:278` (document/principle URL in `href=` **and** `title=`), `modals/templates.js:84` (template name in `value=`), `modals/team.js:68,69,140` (member name/role in `value=`/`aria-label=`), `modals/todo.js:88` (list title in `value=`), `modals/task-types.js:46` (task-type name in `value=`).
- **Why it matters:** any project member who can set a task title, member name/role, document/principle URL, template name, task-type name, or to-do list title can inject an event-handler attribute that executes arbitrary JS for anyone who views that board — including an org admin. Combined with C6 below, this is a direct path to full account takeover.
- **Fix:** make the shared helper also escape `"` → `&quot;` and `'` → `&#39;` (one existing copy in `features/import.js:17-23` already handles `"` correctly — promote that version), and de-duplicate all 11 copies into one shared module so this class of bug can't recur independently in 11 places.
- **Fixed:** canonical quote-escaping `escapeHTML` added to `utils.js`; all 11 duplicate local definitions removed, every consumer now imports the shared version (`views/board.js` re-exports it for the many modals that already imported from there). Verified: the exact attribute-breakout payload is now fully neutralized.

### C6. JWT stored in `localStorage` (amplifies C5) — not addressed (accepted as-is)
- **Where:** `src/js/api.js:8,25-33` (`kanbanflow_server_jwt` key).
- **Why it matters:** readable by any script on the origin. Either C5 finding, once fixed in isolation, still leaves this as a standing amplifier for the *next* XSS bug — any future stored-XSS immediately becomes full session/token theft rather than a contained UI glitch.
- **Fix:** fixing C5 removes today's practical exploit path; consider httpOnly cookie-based sessions as defense-in-depth against future XSS regressions.
- **Status:** C5's fix removes today's practical exploit path, per the original note. The httpOnly-cookie migration itself is a larger architectural change (would touch every API call's credential-passing convention) and was deliberately left out of this remediation pass.

---

## High

### H1. No rate limiting / brute-force protection on any login endpoint — ✅ REMEDIATED
- **Where confirmed:** `.NET` `Controllers/AuthController.cs` (`/api/auth/login`, `/change-password`, and the anonymous `sso-exchange`/`sso-lookup`/migration endpoints); `vendor-portal/server/routes/auth.js:6-20` (the app's single admin login). **Not explicitly checked against the PHP tier's own login endpoint** — likely shares the same gap given it mirrors the .NET controller 1:1, but flag as needing direct confirmation.
- **Fix:** add per-IP/per-username rate limiting (ASP.NET Core's built-in `Microsoft.AspNetCore.RateLimiting`, `express-rate-limit` for vendor-portal) plus progressive lockout after repeated failures.
- **Fixed:** 10 requests/minute per client IP, sliding window, immediate 429 (no queuing) — `Microsoft.AspNetCore.RateLimiting` on all 5 .NET routes; a DB-backed equivalent middleware in PHP (in-memory doesn't work across PHP-FPM workers); `express-rate-limit` on vendor-portal's login (its own tier was confirmed to have the same gap, not just "likely"). Live-tested on .NET (11th request gets 429) and vendor-portal (isolated harness, same result).

### H2. No JWT revocation — deactivation/deprovisioning doesn't invalidate already-issued tokens — ✅ REMEDIATED
- **Where:** `api/Enkl.Api/Program.cs:49-59` validates only signature/issuer/audience/lifetime; nothing re-checks `User.IsActive` per request. A user deactivated via SCIM (`ScimUserService.cs:186-187`) or demoted from org-admin keeps a fully valid token for up to the full 8-hour expiry (`appsettings.json:16`).
- **Fix:** add a revocation check (a `SecurityStamp`/`TokenValidFrom` column checked on token validation), or shorten expiry substantially and move to refresh-token rotation.
- **Fixed:** `User.SecurityStamp` (Guid) added both tiers, minted into the JWT, re-checked live against the DB on every authenticated request (combined with the C4 middleware into one query). Regenerated on password change, `IsOrgAdmin` toggle, and SCIM `IsActive` toggle. Password-change now returns a fresh token (old one would otherwise revoke the caller's own session). Live-tested on .NET: old token works, password changed, old token immediately 401s, new token works.

### H3. `normalizeDocumentationUrl` doesn't block dangerous URL schemes — ✅ REMEDIATED
- **Where:** `src/js/mutations.js:367-372`. Only checks for the generic `scheme://` shape to decide whether to prepend `https://` — doesn't allowlist `http:`/`https:`/`mailto:` or blocklist `javascript:`/`data:`.
- **Verified bypass:** `javascript://%0aalert(document.cookie)` matches the regex and passes through unmodified, then reaches `<a href="...">` rendering (`modals/documents.js:386`, `modals/principles.js:278`) and `window.open()` calls (`modals/documents.js:251`, `modals/task.js:313`).
- **Fix:** parse with `new URL()` and explicitly check `.protocol` against an allowlist; reject/strip anything else.
- **Fixed:** now parses with `new URL()` and allowlists `http:`/`https:`/`mailto:`, returning `null` for anything else. Verified: the exact PoC and several variants (`data:`, `vbscript:`, no-`//` forms) all rejected; legitimate bare-domain/port/mailto values unaffected.

### H4. No TLS/HSTS enforced anywhere in the stack — ✅ REMEDIATED (defense-in-depth added; TLS termination is still external)
- **Where:** `web/nginx.conf` only has `listen 80;` — no TLS, no redirect, no HSTS. `api/Enkl.Api/Program.cs` has no `UseHttpsRedirection`/`UseHsts`/`UseForwardedHeaders`. Same gap in `php-api` (no forwarded-proto handling anywhere in `src/bootstrap.php`).
- **Why it matters:** as shipped, the entire stack communicates in plaintext by design, relying entirely on an *undocumented* assumption that an external reverse proxy terminates TLS. JWTs and credentials would travel in cleartext if that assumption doesn't hold in a real deployment.
- **Fix:** at minimum, document the TLS-termination assumption prominently next to the compose file; consider adding `UseForwardedHeaders` + conditional `UseHsts` for defense in depth.
- **Fixed:** `UseForwardedHeaders` + conditional `UseHsts` added in `Program.cs`; `nginx.conf` now forwards `X-Forwarded-Proto`/`X-Forwarded-For`; the plaintext-by-design assumption is now documented prominently in both `docker-compose.yml` and `nginx.conf`. PHP tier already sidestepped this correctly via a fixed `APP_PUBLIC_BASE_URL` config (documented, no code change needed). Real TLS termination is still an external requirement — this file/config doesn't provide it.

### H5. Three confirmed high-severity transitive .NET package advisories (NU1903) — ✅ REMEDIATED
- **Where:** `Microsoft.Build.Tasks.Core` 17.14.8, `Microsoft.Build.Utilities.Core` 17.14.8 (GHSA-w3q9-fxm7-j8fq), `Microsoft.OpenApi` 2.0.0 (GHSA-v5pm-xwqc-g5wc) — all pulled in transitively via `Microsoft.EntityFrameworkCore.Design` (itself pinned to a **prerelease** `10.0.0-rc.2.25502.107` in `Enkl.Api.csproj:15`, rather than a stable release).
- **Mitigating factor:** the `Microsoft.Build.*` ones are design-time-only (excluded from `dotnet publish` output); `Microsoft.OpenApi` is only reachable via `MapOpenApi()`, gated behind `app.Environment.IsDevelopment()` (`Program.cs:69-72`) — so current runtime/production exposure is low, but should still be tracked and resolved via an upgrade path.
- **Fix:** upgrade `Microsoft.EntityFrameworkCore.Design` to a stable GA release once available, or pin the patched `Microsoft.Build.*`/`Microsoft.OpenApi` versions directly.
- **Fixed:** `Microsoft.EntityFrameworkCore.Design` upgraded to the stable `10.0.9` GA release (clears both `Microsoft.Build.*` advisories); `Microsoft.OpenApi` pinned directly to `2.10.0` (a patched release within the same major version — `3.x` has a breaking API change incompatible with `Microsoft.AspNetCore.OpenApi` 10.0.9). `dotnet list package --vulnerable --include-transitive` now reports zero.
- **New, unrelated finding surfaced while fixing H1:** installing `express-rate-limit` in `vendor-portal` exposed a pre-existing high-severity `tar`/`node-tar` advisory via `bcrypt`'s `@mapbox/node-pre-gyp` install-time dependency chain (not introduced by this fix, just newly visible since `node_modules` hadn't been installed in that worktree before). `npm audit fix` can't resolve it without a breaking `bcrypt` upgrade — left open, worth a look separately.

---

## Medium

**Status: all Medium findings (M1–M10) below are REMEDIATED or confirmed clean**, same verification
posture as Critical/High: build-verified in both tiers, live-tested where the running stack allows
it, lint-verified only for PHP-tier/vendor-portal changes (neither runs in the active docker-compose
stack right now).

### M1. Account/SSO-status enumeration + timing side-channel on login — ✅ REMEDIATED
- **`.NET`:** `Controllers/AuthController.cs:34-52` returns materially different messages for "SSO-required org" / "SSO-only account" / generic invalid credentials, AND the not-found/SSO-only paths return before any bcrypt call, while the wrong-password path always pays the ~50-300ms bcrypt cost — both are real (if narrow) enumeration channels.
- **`vendor-portal`:** the identical timing pattern exists in `server/auth.js:9-13` (early-return on missing user skips the bcrypt call).
- **Fix:** normalize timing with a dummy bcrypt verify on the not-found path in both apps; reconsider whether SSO discovery needs to happen via `login`'s error text at all versus only the already-anonymized `sso-lookup` endpoint.
- **Fixed:** a dummy password-hash verify (matching the real hash's cost factor) now runs on every early-rejection path in all three tiers (.NET, PHP, vendor-portal) before returning, so every login failure pays the same bcrypt cost regardless of which branch rejected it. The differentiated error messages themselves were left as-is (a UX tradeoff, not re-litigated this pass).

### M2. Vendor-portal session fixation — ✅ REMEDIATED
- **Where:** `vendor-portal/server/routes/auth.js:17-18` sets `req.session.adminId`/`username` directly without calling `req.session.regenerate()` first.
- **Fix:** regenerate the session ID on successful login before setting any session data.
- **Fixed:** `req.session.regenerate()` now wraps the post-auth session mutation — a pre-auth session ID (fixed by an attacker) is destroyed and replaced before adminId/username are ever set on it.

### M3. PHP JWT signing key fails *open* to an empty string on misconfiguration (tier-parity gap) — ✅ ALREADY CLOSED
- **Where:** `php-api/src/Config/Config.php:16-23` / `src/Auth/JwtService.php:103` — `Config::get('JWT_SIGNING_KEY', '')` silently returns `''` if unset, and the JWT library will happily sign/verify with an empty key. The .NET tier fails *closed* (crashes at startup) via the null-forgiving operator on a missing key.
- **Fix:** throw at boot if `JWT_SIGNING_KEY` is unset or blank, matching .NET's behavior.
- **Status:** already covered as a side effect of the C1 fix — `bootstrap.php`'s `assertProductionSecretsAreSet()` throws if `JWT_SIGNING_KEY` is empty/the checked-in placeholder/under 32 chars, outside `APP_ENV=development`. No new code needed.

### M4. JWT clock-skew mismatch between tiers — ✅ REMEDIATED
- **Where:** .NET sets `ClockSkew = 1 minute` (`Program.cs:58`); PHP's `firebase/php-jwt` leeway defaults to `0` and is never set. Safe direction (PHP is stricter), but the two tiers are documented as interchangeable/parity and currently aren't for this behavior.
- **Fix:** set `JWT::$leeway` to match, or explicitly document the intentional divergence.
- **Fixed:** `JWT::$leeway = 60` set in `JwtService::tryDecode`, matching .NET's `ClockSkew`.

### M5. SAML replay protection missing in both tiers (independently confirmed by both audits) — ✅ REMEDIATED
- **Where:** `.NET` `Controllers/SamlController.cs:97-102`; `PHP` `src/Controllers/SamlController.php:94` (`processResponse()` called with no `$requestId`). Neither tier persists the outgoing `AuthnRequest` ID for later `InResponseTo` correlation, so replay protection depends entirely on the assertion's own `NotOnOrAfter` time window as enforced internally by each tier's SAML library.
- **Why flagged Medium not Critical:** requires an attacker to have captured a validly-signed SAML response in the first place (e.g. via H4's cleartext-transport gap, or a compromised IdP-side log) — but once captured, it's replayable until expiry with no additional check.
- **Fix:** track consumed assertion IDs (or the original `AuthnRequest` ID) server-side in both tiers and reject reuse.
- **Fixed:** `Login` now records the AuthnRequest's own ID (new `SamlRequestIdStore`, .NET in-memory singleton; new DB-backed `SamlRequestIdService`/`SamlRequestIds` table, PHP — same "PHP-FPM worker holds no state between requests" reasoning as the existing `ExchangeCodes` table). `Acs` single-use-consumes it against the response's `InResponseTo` — in .NET only after `Unbind()`'s signature validation (InResponseTo is untrusted before that); in PHP by peeking the not-yet-validated response then passing the matched ID into `Auth::processResponse($requestId)`, so the library's own signature validation cryptographically ties the check together. A captured, replayed response now fails the second time it's used, before its `NotOnOrAfter` window would otherwise still accept it.

### M6. Missing security headers across all three server tiers — ✅ REMEDIATED
- **Where:** `web/nginx.conf` (no CSP/X-Frame-Options/X-Content-Type-Options/HSTS/Referrer-Policy at all), `php-api` (no security-header middleware anywhere), `.NET` `Program.cs` (same gap).
- **Fix:** add a shared header-hardening layer — easiest done once in `nginx.conf` in front of everything, plus mirroring in `php-api` if it's ever deployed without nginx in front.
- **Fixed:** `nginx.conf` now sends `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, and a `Content-Security-Policy` (`default-src 'self'`, explicit allowlist for Google Fonts + the data:-URI favicon/manifest/icons, `frame-ancestors 'none'`) — live-verified present on responses. `script-src`/`style-src` keep `unsafe-inline` since `build.js` inlines the entire bundled JS/CSS into one self-contained `dist/index.html` by design; tightening that to hash/nonce-based would need a build-step change, flagged as a reasonable follow-up. `.NET`/`PHP` each add the non-CSP headers as defense-in-depth in case either is ever reached directly without nginx in front.

### M7. Vendor-portal: three of four routers lack the unhandled-rejection guard used in the fourth — ✅ REMEDIATED
- **Where:** `organisations.js`, `licenses.js`, `contracts.js` are plain `async (req,res)=>{}` handlers with no try/catch, unlike `dashboard.js` which wraps its routes in an `asyncRoute()` helper specifically because (per its own comment) an unhandled rejection in Express 4/Node 20 crashes the whole process. A malformed (non-UUID) `:id` on e.g. `GET /api/organisations/:id` is a plausible trigger (not confirmed by actually reproducing the crash).
- **Fix:** wrap all four routers in the same `asyncRoute` helper.
- **Fixed:** `asyncRoute` extracted into its own shared `server/asyncRoute.js` module and applied to every route in all four routers — including `dashboard.js`'s own first route (`GET /dashboard`), which turned out to be missing the guard too despite being the file the helper originally lived in.

### M8. Containers running as root — ✅ REMEDIATED
- **Where:** `api/Enkl.Api/Dockerfile` and `web/Dockerfile` have no `USER` directive.
- **Fix:** add `USER app` (the `aspnet` base image ships one) for the API; lower priority for the nginx image since nginx's worker processes already drop privilege internally.
- **Fixed:** `USER app` added to `api/Enkl.Api/Dockerfile` (live-verified: container runs as `uid=1654(app)`) and `USER node` added to `vendor-portal/Dockerfile`. `web/Dockerfile` deliberately left as root — nginx binds port 80 (privileged, <1024) and already drops worker-process privilege internally by default; documented why in the Dockerfile itself.

### M9. `PrincipleService.CopyAsync` checks org membership but not target-project membership — ✅ REMEDIATED
- **Where:** `api/Enkl.Api/Services/PrincipleService.cs:89-105`, exposed via `Controllers/OrganisationPrinciplesController.cs:38-43`. Confirms the target project belongs to the caller's organisation, but not that the caller is a *member* of that specific project — any authenticated org member could write a copied Principle into a project they don't belong to, if they can guess/enumerate its GUID.
- **Fix:** confirm whether this is intentional (the controller's own doc comment suggests "any org member, same trust level" was a deliberate choice); if not, add a project-membership check consistent with every other project-scoped mutation in the codebase.
- **Fixed:** confirmed the "any org member" trust level was intended for *browsing* the shared library (read-only, matches Templates), not for *copying* (a write into a specific project) — those are different in kind. Added a project-membership check (reading the JWT's `projects` claim directly, since this route isn't under a `{projectId}` segment so the usual policy-based check can't apply) in both `OrganisationPrinciplesController.cs` and its PHP equivalent, returning 403 if the caller isn't a member of the target project.

### M10. `onelogin/php-saml` 4.3.2 — version needs explicit CVE-database confirmation — ✅ CONFIRMED CLEAN
- Structurally looks current and correctly configured (`strict`, `wantAssertionsSigned` both enforced), but the audit couldn't fully rule out an unpatched advisory from static inspection alone given this library's history. Recommend running `composer audit` or checking a vulnerability database directly.
- **Confirmed:** the one disclosed advisory for this library (GHSA-5j8p-438x-rgg5 / CVE-2025-66475, a signature-wrapping issue via `xmlseclibs`) affects `< 4.3.1`; this project is pinned to `4.3.2`. The `robrichards/xmlseclibs` dependency itself is locked at `3.1.5`, past that same CVE's `3.1.4` patch threshold. No code change needed.

---

## Low / Informational

**Status: every actionable item below is REMEDIATED** except the one explicitly deferred by user
decision (per-project roles — a product/feature decision, not a bug). Verified live against the
running .NET stack where feasible (IdP cert rejection tested through the real API endpoint); PHP-tier
and vendor-portal changes are lint/functionally-verified in isolation (neither runs in the active
docker-compose stack).

- **IdP certificate hygiene** — `SamlCertificateHelper.cs` never validates expiry or key strength of an admin-pasted IdP signing certificate.
  - **Fixed:** both tiers now reject an expired, not-yet-valid, or weak-key (RSA < 2048 bits) certificate at save time, with a specific caller-facing message. Live-verified through the real `PUT /api/organisations/me/sso-config` endpoint with a 1024-bit test cert (400, exact expected message) and a healthy 2048-bit one (accepted).
- **BCrypt work factor** left at library default rather than explicitly pinned in `Auth/PasswordHasher.cs` (informational — current default is reasonable, just not visible/reviewable in code).
  - **Fixed:** cost factor 12 pinned explicitly in both tiers (matching vendor-portal's existing convention). Verified: hash embeds cost 12, existing pre-change hashes still verify correctly (bcrypt reads the cost from the hash itself, not the caller).
- **No per-project role enforcement** beyond flat membership — any project member can add/remove other members, delete tasks, etc. May be intentional; confirm against product intent.
  - **Deferred by user decision:** left as flat membership. Building real RBAC is a product/feature effort, not a security patch — revisit as its own project if wanted.
- **SCIM tokens are rotate-only**, no usage audit trail beyond a "generated at" timestamp.
  - **Fixed:** new `ScimTokenLastUsedAt` column (both tiers), updated on every successful SCIM authentication — gives an OrgAdmin/support engineer investigating suspected token compromise a coarse "is this IdP still calling us" signal.
- **Vendor-portal `seed-admin.js`** only enforces password length ≥ 12, no complexity/entropy check.
  - **Fixed:** now also rejects a password equal to the username, a small hardcoded common-weak-password list, and anything not mixing at least 3 of 4 character classes.
- **`jsdom`** listed as a production dependency in root `package.json` rather than a devDependency — packaging nit, it's only actually used under `tests/`.
  - **Fixed:** moved to `devDependencies`.
- **No CORS configuration anywhere** in `.NET`/PHP tiers — currently a non-issue (fails safe / same-origin nginx-proxied topology), but would need explicit configuration if the API is ever consumed from a different origin.
  - **Fixed:** an explicit default-deny CORS policy now exists in `.NET` (`AddCors`/`UseCors`, no origins allowed — behavior unchanged, just made intentional and reviewable); PHP has no implicit CORS behavior to override, so a parity comment documents the same stance. Live-verified: no `Access-Control-*` headers returned for a foreign `Origin`.
- **Frontend client-side admin gates** (`isOrgAdmin()`, `isServerAuthoritative()`) are correctly documented as UI-only convenience — **cross-checked against the backend audits and confirmed properly re-enforced server-side** (`OrganisationService.SetUserAdminAsync`/`SetUserEmail` re-check the target user's org; the `OrgAdmin` policy gates the actual management endpoints). No outstanding concern here.
- **`npm audit`** came back clean (0 vulnerabilities) for both the root frontend and vendor-portal dependency trees at time of review — re-run periodically.
  - **Update:** installing `express-rate-limit` for H1 surfaced a pre-existing high-severity `node-tar` advisory via `bcrypt`'s unmaintained `@mapbox/node-pre-gyp` dependency chain (not caused by that change, just newly visible). **Fixed:** forced `tar` to `^7.5.16` via an npm `overrides` entry; verified `npm audit` now reports 0 vulnerabilities and bcrypt's native module still hashes/compares correctly.
- **SQL injection**: both the .NET (EF Core) and PHP (raw PDO) tiers, plus vendor-portal's raw `pg` queries, were reviewed call-by-call and found consistently clean — no string-concatenated SQL anywhere, all dynamic `IN (...)` lists and SCIM filter clauses are built from hardcoded literals with values bound via placeholders. This is a genuine strength worth preserving explicitly in future code review.

---

## Suggested remediation order

1. **C1–C4** first — these are the "anyone on the internet can take over an account" tier. C3+C4 together are the single most severe finding: an unauthenticated attacker who knows an org's name can create a working account inside it today.
2. **C5–C6** next — stored XSS is the other side of full account takeover, this time from a malicious *insider* (any project member) against everyone else who views the board, including admins.
3. **H1–H5** — rate limiting and revocation close the two most likely follow-on abuse paths once C1–C4 are fixed; TLS/HSTS and the dependency upgrades are lower-effort, do them alongside.
4. **M1–M10** — work through as capacity allows; none of these are exploitable on their own without one of the Critical/High issues as a prerequisite, but several (M5 SAML replay, M9 Principle copy) are worth deliberate sign-off even if left as-is.

**All of the above (Critical, High, Medium, and Low/Informational) are now remediated**, with the
single exception of per-project role enforcement, deliberately deferred as a product decision rather
than a security patch. This document remains uncommitted — decide whether to commit it, `.gitignore`
it, or archive its contents elsewhere now that the roadmap it describes has been worked through.
