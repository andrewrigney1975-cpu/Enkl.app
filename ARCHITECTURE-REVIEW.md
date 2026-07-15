# Enkl — Architecture Review

**Date:** 2026-07-15
**Scope:** `api/Enkl.Api` (.NET tier), `php-api` (PHP tier), `src/js` (frontend), infrastructure/CI/deployment, on `main`.
**Method:** Static review only — no code changes were made. Four focused passes (one per area below) plus manual synthesis. Findings are cross-referenced against `CLAUDE.md`'s documented conventions rather than repeating them; this document exists to surface what CLAUDE.md doesn't already say.

## How to read this

Each finding has an effort tag: **S** (hours–2 days), **M** (a few days–2 weeks), **L** (2–4 weeks), **XL** (a month+, or an open-ended program of work). These are rough sizing signals for a single engineer familiar with the codebase, not committed estimates.

Overall verdict up front: **this is a well-built codebase for its stage** — layering is consistent, the one security-hardening pass that's already happened (H1–H5/C1–C4/M6 etc., referenced throughout both backend tiers) was done properly and is visible in the code, not just in commit messages. The issues below are mostly *second-order* risk (missing safety nets, accumulating duplication, scaling limits of chosen patterns) rather than fundamental design flaws. The single highest-leverage gap, by a wide margin, is **the complete absence of CI and automated backend tests**, made more urgent than usual by the two-tier hand-duplicated backend architecture.

---

## 1. Top 5 priorities (read this section first)

| # | Finding | Why it matters | Effort |
|---|---|---|---|
| 1 | **No CI pipeline exists anywhere in the repo** | Nothing gates a broken build, failing test, leaked secret, or vulnerable dependency from reaching `main`. Given two hand-duplicated backend tiers, this is the biggest lever available. | S (basic build+lint gate) |
| 2 | **Zero automated test coverage for both backend tiers** | `Enkl.Api` has no test project at all; `php-api` has no PHPUnit, no `require-dev`, nothing. The only tests in the repo are ~130 jsdom black-box tests against the *frontend* bundle. Security-sensitive logic (JWT revocation, cross-org isolation, migration import) is unverified by anything except manual curl checks. | L/XL per tier |
| 3 | **No contract-parity test between the .NET and PHP tiers** | The two backends must independently reimplement every endpoint, every bugfix, every security patch. `SECURITY-REVIEW-FINDINGS.md` itself documents real drift already caught this way (a clock-skew mismatch, a fail-open gap, a check missing on one tier) — found by a human, not a machine. This doesn't scale as either tier grows. | M (OpenAPI-diff harness) |
| 4 | **`views/board.js` (1,022 lines) and full-tree `renderBoard()` re-render (48 call sites) are approaching their scaling limit** | Every mutation — even a single inline edit — tears down and rebuilds every column and card via `innerHTML` string concatenation with no diffing. Fine today; a real cost once boards grow. | M–L depending on fix chosen |
| 5 | **No structured logging, correlation IDs, or error tracking in either backend tier** | An unhandled exception in production has no automatic alerting path and no way to trace a request across nginx → api → db. The only "observability" feature is the client-side RUM page-load beacon, which is a different thing. | M |

---

## 2. .NET API tier (`api/Enkl.Api`)

**Overall**: unusually mature for its size. Controllers are consistently thin (~68 lines avg) and delegate cleanly to services — no god-controllers found. The global exception handler, `[Authorize(Policy=...)]` usage, and middleware ordering in `Program.cs` are all textbook-correct. Issues are duplication/coverage gaps, not design flaws.

### 2.1 Structure
- No shared `BaseApiController` — identical `CallerOrgId()`/`CallerUserId()` claim-parsing boilerplate is copy-pasted across 5+ controllers (`OrganisationPrinciplesController.cs:57`, `OrganisationsController.cs:55`, `OrganisationSsoConfigController.cs:40`, `PortfolioController.cs:182`, `TemplatesController.cs:62`, plus inline repeats in `TasksController.cs`, `ProjectsController.cs`, `AuthController.cs`, `EventsController.cs`, `MigrationController.cs`, `ToDoController.cs`).
  - **Best practice**: `ClaimsPrincipal` extension methods (`User.OrgId()`, `User.UserId()`) in one static class. — **Effort S**
- `Services/MigrationService.cs` (683 lines) and `Services/PortfolioService.cs` (486 lines) each mix several distinct responsibilities in one class (import dedup/wiring/cycle-detection; categories/resourcing/activation/placeholders respectively).
  - **Best practice**: split along the natural seams (e.g. `MigrationOrganisationResolver`/`MigrationEntityBuilder`/`MigrationHierarchyValidator`). — **Effort M each**

### 2.2 Data access
- **`AsNoTracking()` is used exactly once in the entire codebase** (`Auth/ScimAuthFilter.cs:49`). Every other read path — including list endpoints across ~22 services and the large `GetProjectDetailAsync` graph fetch below — tracks entities it never mutates, adding unnecessary change-tracker overhead.
  - **Best practice**: add `.AsNoTracking()` to all read-only query paths as a matter of course. — **Effort S per service, M in total**
- `ProjectService.cs:47-69` (`GetProjectDetailAsync`) loads the entire project graph in one call — 19 `Include`/`ThenInclude` chains. A prior cartesian-explosion/30s-timeout bug was correctly fixed with `.AsSplitQuery()`, but the underlying "fetch everything to build one DTO" pattern remains a scalability ceiling for projects with many tasks/documents (still ~19 round-trips per request).
  - **Best practice**: targeted, paginated per-resource endpoints instead of one all-in-one detail call. — **Effort M/L**
- Only one explicit transaction in the whole tier (`MigrationService.cs:33`), appropriately scoped. Other multi-`SaveChangesAsync` services (`PortfolioService.cs` has 11 call sites, `RetrospectiveService.cs` has 10) haven't been audited line-by-line for whether any sequence of calls should be atomic but isn't.
  - **Effort S** to audit; fix effort depends on findings.

### 2.3 Service layer / DI
- No interface abstractions anywhere — DI registers concrete classes directly (`Program.cs:66-91`). Fine for a single-implementation monolith today; makes pure unit testing harder without a real/InMemory DbContext, and leaves no seam for a future decorator (e.g. caching).
  - **Effort L** if retrofitted broadly — low priority absent current pain, but worth doing incrementally alongside item 2 below (test project) since interfaces make mocking trivial.
- Business logic does **not** leak into controllers anywhere sampled — a genuine strength worth preserving as new endpoints are added.

### 2.4 AuthN/AuthZ
- Project membership is baked into the JWT's `"projects"` claim at login and never re-queried; `Auth/ProjectMemberAuthorizationHandler.cs:21-44` authorizes purely from that claim. **Removing a user from a project does not take effect until token expiry/re-login** — the `SecurityStamp` revocation mechanism covers account-level deactivation/password changes but not per-project membership removal specifically. For a governance tool where access changes are sometimes urgent (e.g. offboarding), this is a real staleness window worth naming explicitly even though it's a known, documented trade-off.
  - **Best practice**: either shorten token lifetime + add silent refresh, or add a live membership check for project-scoped actions specifically. — **Effort M**
- Middleware ordering in `Program.cs` (ForwardedHeaders → HSTS → security headers → exception handler → CORS → rate limiter → AuthN → AuthZ → revocation/must-change-password → MapControllers) is correct and well-commented.

### 2.5 Validation
- Zero use of Data Annotations or FluentValidation across all `Dtos/*.cs` — validation is 100% manual, ad hoc, inside services, throwing a single `ApiValidationException` (27 throw sites across 12 services). Internally consistent, but coverage is uneven and there's no compile-time or centralized enforcement that every field is actually checked.
  - **Best practice**: adopt FluentValidation with one validator per DTO for consistency and testability (cross-entity rules like uniqueness/cycle-detection still need to stay in services). — **Effort M**

### 2.6 Testing — the big one
- **No `.NET` test project exists anywhere in the repo.** No `Enkl.Api.Tests`, no second `.csproj`, no `WebApplicationFactory` integration harness. Given the complexity of `MigrationService.cs` (cycle detection, org/user dedup heuristics) and the security-sensitivity of the auth middleware chain, this is the largest concrete gap found in this tier.
  - **Best practice**: stand up `Enkl.Api.Tests` — integration tests via Testcontainers (real Postgres) or SQLite for service/repository behavior, plus focused unit tests for JWT/revocation logic and the migration importer. — **Effort L/XL**

### 2.7 Configuration & migrations
- `Program.cs:22-41` fails startup outside `Development` if placeholder secrets (dev JWT key, dev DB password) are still present — genuinely good defense-in-depth, already in place.
- 18 migrations, incrementally and sensibly named, no evidence of hand-editing or squashing. No issues found.

---

## 3. PHP API tier (`php-api`)

**Overall**: mirrors the .NET tier's layering well — `Controllers/` → `Services/` → `Auth/` → `Db/`, with a shared `BaseController` (unlike the .NET side) already centralizing claim-parsing. `strict_types=1` is present in all 78 source files. No SQL injection found anywhere (fully parameterized PDO). The tier's real risks are concurrency/atomicity gaps and — like the .NET tier — a complete absence of tests, which is more serious here given this tier's entire purpose is staying in lockstep with another codebase.

### 3.1 Data access & transactions
- **No explicit transactions anywhere in `Services/`** (only in `Migrator.php`/`MigrationService.php`). Multi-statement writes like `ProjectService::create()` (`php-api/src/Services/ProjectService.php:96-190`) run INSERT → INSERT → several INSERTs → UPDATE as separately auto-committed statements under PDO's default autocommit mode. A mid-sequence failure leaves a partially-created project (e.g. no columns/task types) with no rollback. The .NET side batches related writes into `SaveChangesAsync()` calls giving at least partial atomicity; this PHP port is more granular and has more partial-failure windows as a direct consequence of the port, not a deliberate choice.
  - **Best practice**: wrap each multi-insert operation in `beginTransaction()/commit()/rollBack()`. — **Effort M** (touches most Services with >1 write)

### 3.2 Rate limiting — real concurrency bug
- `php-api/src/Auth/RateLimitMiddleware.php:46-61` has a **TOCTOU race**: count-then-insert is not atomic, so two concurrent requests from the same partition key can both read `count < limit` before either inserts, letting the effective limit be exceeded under concurrency — exactly the multi-worker PHP-FPM scenario this table exists to handle.
  - **Best practice**: a single atomic statement (`INSERT ... WHERE (SELECT COUNT...) < limit RETURNING`) or a Postgres advisory lock per partition key. — **Effort S**
- Every rate-limited request also runs an unconditional `DELETE FROM "RateLimitHits" WHERE "OccurredAt" < ...` before the count query (line 46-47) — full prune on every hit, not probabilistic/periodic, i.e. wasted write amplification on a hot path.
  - **Best practice**: prune probabilistically (1-in-N) or on a scheduled job instead of inline. — **Effort S**

### 3.3 Code quality / duplication risk
- The `MEMBER_PALETTE` color constant is defined identically in three separate places (`MemberService.php:23-26`, `TeamCommitteeService.php:19-22`, and a hardcoded literal in `ProjectService.php:20-21`), each carrying a comment reminding the reader to keep it in sync with `src/js/config.js` — i.e. **four** copies of the same constant across two languages, enforced only by comment discipline. All four currently match; nothing stops the next edit from missing one.
  - **Best practice**: extract to a single `Support/MemberPalette.php` constant referenced by all three PHP call sites, and consider a smoke test asserting parity with the JS constant. — **Effort S**
- Data-integrity clamps (e.g. member allocated-fraction, column caps) live only in application code per the project's documented "no CHECK constraints" convention — reasonable, but it means these clamps must be correctly re-implemented and kept in sync in **both** language tiers with no DB-level backstop at all. Worth flagging as an accepted risk, not a bug.

### 3.4 Testing — the big one
- **No test suite exists for this tier at all**: no `phpunit.xml`, no `tests/` directory, no `require-dev` block in `composer.json` (there isn't one), no static analysis (no PHPStan/Psalm). Given this tier's stated purpose is hand-ported parity with the .NET contract, this is arguably the single largest risk in the whole review — drift can currently only be caught by a human manually diffing commits across two languages, which is exactly what already happened and already missed things (see §5).
  - **Best practice**: PHPUnit suite with DB fixtures, covering at minimum the auth middleware chain (JWT, SecurityStamp revocation, MustChangePassword) and one CRUD path per service. — **Effort L/XL**

### 3.5 What's already good here
- Zero string-concatenated SQL with user input anywhere — fully parameterized.
- Centralized error handling in `bootstrap.php:60-81` — no controller/service leaks a raw exception or stack trace to the client.
- Migration naming is fully consistent (18 files, `NNN_snake_case.sql`), zero `DROP`/`TRUNCATE`, zero CHECK constraints — the documented convention is genuinely followed, not just claimed.
- Spot-checked drift against the .NET tier on 3 non-trivial commits (an org-scoping bug fix, the security-audit hardening pass, CORS/SAML hardening) — all correctly mirrored, including subtle behavioral fixes. This is a positive signal about current discipline, but a spot check is not a substitute for the automated parity test recommended in §5.

---

## 4. Frontend (`src/js`)

**Overall**: ~20,900 lines across ~60 files, hand-rolled `innerHTML` template-string rendering, no framework, no TypeScript. Module coupling discipline is genuinely good (zero modal→modal imports, zero view→modal imports found). The real risks are scale-related: one large view file trending toward unmanageable, an injection pattern that fails silently, no compiler safety net at all, and a real (if narrow) accessibility gap.

### 4.1 Scale & the board.js concern
- `views/board.js` is 1,022 lines and the largest view; `renderColumn()` alone is ~195 lines mixing header rendering, three kinds of filter-chip logic, column rendering, and drag/drop wiring. `renderBoard()` is called from **48 sites** across `app.js`, 7 modals, and itself — meaning essentially every mutation (moving one task, renaming one column) tears down and rebuilds every column and card via string concatenation, with no diffing. Not broken today; a real cost as board size grows, and the file's multi-concern structure makes it the riskiest file in the frontend to touch.
  - **Best practice**: split into `board-render.js`/`board-filters.js` (~350 of the 1,022 lines are filter-chip rendering alone)/`board-layout.js`; separately, consider targeted re-render (patch only the changed column/card) or a small diffing library (e.g. morphdom) instead of full-tree `innerHTML` replacement. — **Effort M** for the split, **L** for real diffing, **M** for a morphdom-style drop-in as a lower-risk middle ground.

### 4.2 State management & the `setXDeps()` pattern
- `state.db` is a genuine single source of truth for domain data, but **58 module-level `let`/`var` singletons** across 20 modal/view files hold private per-modal UI state outside it — defensible for transient state, but means there's no single place to answer "what is Enkl's state," and no way to uniformly inspect/reset/serialize it.
- More concerning: the lazy-injection convention (`setBoardDeps`, `setXDeps` — 10 occurrences) exists specifically to route around circular-import problems. Functions default to a no-op (`function(){}`) if never wired up — a missing or misordered wire-up in `app.js` **fails silently** at runtime with no compiler or test catching it.
  - **Best practice**: an explicit `AppContext` object passed into init functions, or a tiny typed event bus, so a wiring gap throws instead of silently no-opping. — **Effort M** (touches every view/modal init call — do incrementally, not as a big-bang rewrite)

### 4.3 Rendering performance
- 271 `innerHTML =` assignments, 554 `addEventListener` calls, event delegation used in only 7 files. Per-row listeners are wired fresh inside render loops in several places (`board.js:356,435,451,535,551`) instead of one delegated listener on the container — real, avoidable churn on every re-render of filter chips.
  - **Best practice**: delegated listeners for repeated-row patterns. — **Effort S** (mechanical, 2-3 days)

### 4.4 Type safety — no compiler backing anywhere
- Pure JS, no `jsconfig.json`/`tsconfig.json`, no JSDoc type-checking anywhere. `state.db`'s shape (projects → columns → tasks, dozens of optional fields) is read via plain string-keyed property access from nearly every one of the ~60 files, with zero static verification that a field name is spelled correctly or the right type. A renamed/mistyped field is a silent `undefined` at runtime, caught only if a test happens to assert on that exact field.
  - **Best practice**: incrementally adopt JSDoc + `"checkJs": true` in a `jsconfig.json`, starting with `storage.js`'s DB shape and `mutations.js` — no build-step change required, gets IDE/tsc-grade checking for free without introducing an actual TypeScript compile step (which would conflict with the "no bundler-at-dev-time" philosophy less than JSDoc does). — **Effort M** for meaningful core-shape coverage, ongoing after that.

### 4.5 Build process
- `build.js` uses esbuild for actual JS/CSS minification (better than it first appears) — the regex fragility CLAUDE.md documents is narrower than "the whole bundler," limited to splicing the bundled output into `index.html`, and the `$`-substitution bug is genuinely fixed.
- `sourcemap: false` — any production bug is debugged against fully minified, unmapped code, compounding the lack of a type-checking safety net (§4.4). — **Best practice**: `sourcemap: 'inline'` behind a staging-only flag. — **Effort S**
- The version-bump step mutates `config.js` via a hand-rolled regex on every build — fragile if `APP_VERSION`'s literal format ever changes, low current risk.
- Single-entry-point bundling means the entire feature surface ships to every user regardless of role/plan — an accepted, deliberate cost of the single-file/offline philosophy, worth naming explicitly as a trade-off rather than an oversight.

### 4.6 Testing
- No unit-test tooling at the source-module level (root `package.json`'s only script is `build`). There **is** a substantial `tests/` suite (~130 jsdom black-box tests driving the *built* `dist/index.html`, 3-6 min full run) — genuinely good behavioral coverage, but it only catches bugs after `npm run build` succeeds, with no fast/isolated unit-level feedback loop for pure-logic modules.
  - **Best practice**: add Vitest for pure-logic modules (`date-utils.js`, `utils.js`, `workflow-engine.js`, `mutations.js`) as a complement, not a replacement. — **Effort S/M**

### 4.7 Accessibility — a real, broad gap
- Only 10 of 27 modal files contain any `aria-*` attribute; **zero `tabindex` usage anywhere**; Escape-key handling exists in only 6 of 27 modals; no evidence of a real focus trap (focus return to trigger element, Tab containment) anywhere. For a tool used daily as a primary work surface, this is a genuine, broad gap rather than a nitpick.
  - **Best practice**: one shared modal-overlay helper (focus trap, Escape-to-close, restored focus, `aria-modal`/`role="dialog"`) retrofitted across all 27 modals. — **Effort L** (3-4 weeks given the number of call sites), high value, low technical risk since it's purely additive.

### 4.8 CSS & duplication
- `styles.css` is 5,408 lines, reasonably disciplined `.kf-` BEM-ish naming — but the documented "no generic `.hidden` class" gotcha has produced **77 separate compound `.hidden` selector rules**, each an identical `{ display: none }` copy tied to a different qualifier. This is duplication actively baked in to work around a missing utility, and (per CLAUDE.md) has already caused two real bugs when a new feature forgot to add its compound rule.
  - **Best practice**: add one real `.hidden { display: none !important; }` utility class and migrate the 77 compound rules opportunistically as files are touched. — **Effort S** to add (with verification no existing `!important` conflicts), cleanup is free/incremental thereafter.
- Roughly 20+ modal files hand-roll their own "No X yet" empty-state markup with no shared helper, unlike `icons.js`/`svg-export.js`/`portfolio-bars.js` which are properly centralized per the project's own stated convention.
  - **Best practice**: extract a shared `renderEmptyState(iconName, message)` helper. — **Effort S**

---

## 5. Infrastructure, security posture, CI/CD

### 5.1 CI/CD — critical gap
- **No `.github/workflows/`, no CI config of any kind, anywhere in the repo.** `build.js` and the jsdom `tests/` suite both exist and both work, but nothing invokes either automatically on push/PR. Nothing stops a broken build, a failing test, a leaked secret, or a newly-vulnerable dependency from landing on `main`.
  - **Best practice**: a minimal pipeline that runs `dotnet build`, `composer install --no-dev && php -l` across changed files, `node build.js`, and `node tests/run_all_tests.js` on every PR. — **Effort S** for this baseline; natural place to add the parity test below once it exists.

### 5.2 The two-tier architecture's sustainability — the central strategic question
- `php-api/composer.json` itself describes the tier as "a parity port ... runnable in parallel ... Same HTTP contract." Every feature, bugfix, and security patch must be independently implemented and verified **twice**, by hand, in two different languages. `SECURITY-REVIEW-FINDINGS.md` documents real drift already caught this way (a clock-skew mismatch between tiers, a fail-open gap present on one tier only, a check not explicitly verified on the PHP side) — found by a human during a one-off review pass, not by any recurring automated gate. **No contract/parity test exists anywhere** that fires identical requests at both tiers and diffs the results.
  - This is the architecture's core risk, not a peripheral one: it is unsustainable as either tier's surface area grows, because the *only* thing currently catching drift is human diligence during periodic manual reviews.
  - **Best practice options, increasing in effort**:
    - **S/M**: generate an OpenAPI spec from the .NET tier (already wired via `Microsoft.AspNetCore.OpenApi`/`MapOpenApi()`) and run a scripted harness in CI firing identical requests at both tiers, diffing status/JSON shape.
    - **M/L**: a Postman/Newman or Dredd contract suite validated against both backends on every PR.
    - **L/XL**: consolidate to one canonical backend long-term with a documented sunset plan for the other, if there's no longer a concrete business reason (e.g. a customer requiring pure-PHP shared hosting) to maintain two full independent implementations indefinitely. This is a strategic decision, not a "just do it" fix — flagging it as a decision point worth making deliberately while the codebase is still small enough that consolidation is cheap, not a recommendation to act on unilaterally.

### 5.3 Database — shared instance, no isolation, asymmetric rollback capability
- One Postgres database serves both backend tiers (mutually exclusive at runtime) plus, per `CLAUDE.md`, the vendor-portal on its branch. No schema-per-tenant, no per-tier namespace. The .NET tier's EF Core migrations have proper `Up`/`Down` pairs (real rollback capability); the PHP tier's forward-only numbered `.sql` files have **no rollback scripts at all** — only a mid-apply transaction rollback on failure, not a schema revert. The two migration histories are kept in sync only by naming convention (18 EF migrations ↔ 18 PHP files), not enforced by anything.
  - **Best practice**: a CI check asserting migration-count/shape parity between the two migration directories (cheap, catches an obvious class of drift). Real schema isolation is a larger, more disruptive change not clearly justified at current scale. — **Effort S** for the parity check, **L** for actual isolation if ever pursued.

### 5.4 Observability
- No structured logging (no Serilog, no equivalent PHP structured logger), no correlation/request-ID propagation, no OpenTelemetry/APM, no error tracker (Sentry etc.) anywhere in either backend tier. The only observability feature is the custom client-side RUM page-load beacon — useful for its stated purpose (frontend responsiveness) but not a substitute for backend error visibility. An unhandled exception in production today has no automatic alerting path at all.
  - **Best practice**: Serilog (or equivalent) + a correlation-ID middleware in both tiers, plus a lightweight error tracker (Sentry has adequate free-tier SDKs for both ASP.NET Core and PHP). — **Effort M**

### 5.5 What's already good here
- Docker images are version-pinned (not `:latest`-floating), multi-stage builds are used correctly, health checks exist for `db`/`api` (missing for `web` — **Effort S** to add), secrets are required via fail-closed `${VAR:?must be set}` rather than defaulted, non-root execution where practical, `api`/`db` are correctly not exposed to the host network.
- No hardcoded production secrets found anywhere in source; `.env` and `SECURITY-REVIEW-FINDINGS.md` are both correctly gitignored and confirmed untracked.
- nginx CSP/security headers are close to best practice; the two gaps found are a missing `Permissions-Policy` header and no request-size/rate limiting at the edge (both **Effort S**).
- Backup/DR: honestly documented as an operator responsibility (`DEPLOYMENT-NET-DOCKER.md` explicitly states the stack has no automated backup/PITR out of the box) rather than silently unaddressed — good documentation hygiene even though the underlying capability doesn't exist.

---

## 6. Suggested sequencing

This is a suggested order of attack, not a plan to execute — sequencing should account for team size and current roadmap pressure, which this review doesn't have visibility into.

1. **CI baseline** (§5.1, S) — build+lint gate on every PR. Immediate payoff, low risk, no design decisions required.
2. **Cross-tier contract-parity test** (§5.2, M) — layer onto the new CI. This is the single highest-leverage item given the two-tier architecture's inherent drift risk.
3. **Backend test projects** (§2.6, §3.4, L/XL each) — start with the security-sensitive surface (auth middleware, JWT revocation, migration import) rather than aiming for broad coverage immediately.
4. **Structured logging + error tracking** (§5.4, M) — cheap relative to its value once something in items 1-3 surfaces a production issue that needs to be debugged.
5. **Frontend `.hidden` utility class + `board.js` split** (§4.8, §4.1, S then M) — low-risk, high-clarity wins that reduce the standing "silent bug" traps CLAUDE.md already documents having bitten the team twice.
6. **Accessibility retrofit** (§4.7, L) — broad but purely additive; a good fit for steady incremental work rather than a dedicated sprint.
7. **Two-tier architecture strategic review** (§5.2) — a decision point to revisit deliberately, not a task to execute reactively.

---

*This document was generated by static review (four parallel investigative passes plus synthesis) with no code changes made. File/line references reflect the state of `main` as reviewed on 2026-07-15 and will drift as the codebase changes.*
