# Enklr Task — Systems Integrator Guide

**Audience**: platform/infrastructure engineers, security architects, and IT administrators
responsible for deploying, integrating, and operating Enklr Task within an enterprise environment.
This is not an end-user document — see `USER-GUIDE.md` for that. This document assumes familiarity
with containers, relational databases, TLS/PKI, and identity federation protocols; acronyms are
expanded on first use and collected in the [Glossary](#16-glossary) for reference.

**Scope**: this guide is deployment- and integration-focused. It does not restate every line of the
per-tier deployment guides already in this repository (`DEPLOYMENT-NET-DOCKER.md`,
`DEPLOYMENT-PHP.md`, `DEPLOYMENT-MARIADB.md`, `DEPLOYMENT-AWS.md`) — it synthesises them into a
single integrator-oriented reference, with pointers back to the source documents for exact commands.
Where this guide and a per-tier document disagree on a specific command or value, the per-tier
document is authoritative; file an issue against this guide.

**A note on the AWS case study in §12**: it describes the *idealised*, reusable reference
architecture (ECS Fargate + Application Load Balancer), not any specific running deployment. No
account IDs, resource identifiers, IP addresses, hostnames, or credentials from any real environment
appear anywhere in this document. Every value shown is either a placeholder (`<account-id>`,
`your-domain.example.org`) or a generic default drawn from the public, prescriptive deployment guide
this repository already ships.

---

## Table of contents

1. [System overview and integration surface](#1-system-overview-and-integration-surface)
2. [Deployment models](#2-deployment-models)
3. [Backend tier selection](#3-backend-tier-selection)
4. [Identity and access management overview](#4-identity-and-access-management-overview)
5. [Single Sign-On via SAML 2.0](#5-single-sign-on-via-saml-20)
6. [Automated provisioning via SCIM 2.0](#6-automated-provisioning-via-scim-20)
7. [Authentication tokens and session security](#7-authentication-tokens-and-session-security)
8. [Network security architecture](#8-network-security-architecture)
9. [Database accounts and data protection](#9-database-accounts-and-data-protection)
10. [Web application protections](#10-web-application-protections)
11. [Certificates and TLS](#11-certificates-and-tls)
12. [Case study: idealised containerised AWS deployment](#12-case-study-idealised-containerised-aws-deployment)
13. [Logging, monitoring, and incident response hooks](#13-logging-monitoring-and-incident-response-hooks)
14. [Backup, recovery, and business continuity](#14-backup-recovery-and-business-continuity)
15. [Integration checklist (pre-go-live)](#15-integration-checklist-pre-go-live)
16. [Glossary](#16-glossary)
17. [References](#17-references)

---

## 1. System overview and integration surface

Enklr Task is a board-based project and portfolio management application composed of:

- A **single-page frontend** — one self-contained, static HTML document with no required external
  network dependency, servable from any static file host or `file://` with no backend at all.
- A **backend API**, available in three parity-ported implementations that expose an identical HTTP
  contract: a .NET 10 / ASP.NET Core tier (the reference implementation), a PHP 8.2+ / Slim 4 tier
  against PostgreSQL, and a third PHP/Slim tier against MariaDB. An integrator chooses **exactly one**
  tier per deployment.
- A **relational database** (PostgreSQL 13+, or MariaDB 11.4+ depending on tier).
- Optional **identity federation** via SAML 2.0 (inbound SSO) and SCIM 2.0 (inbound user
  provisioning/deprovisioning), described in §5–§6.

There is no message queue, no cache tier, no object storage dependency, and no outbound calls to
third-party services from the backend at runtime (SSO/SCIM are inbound-only integrations initiated by
the customer's own Identity Provider). This significantly narrows the integration and firewall
surface compared to a typical enterprise SaaS application: the entire footprint is "reverse proxy →
application server → database," with SAML/SCIM as the only externally-initiated identity traffic.

---

## 2. Deployment models

Three deployment models are supported, differing only in *who operates the infrastructure* — the
application and its security posture are identical across all three.

| Model | Data residency | Who operates it | Typical adopter |
|---|---|---|---|
| **Local / offline** | Browser `localStorage` on the end-user's device only | End user | Evaluation, single-user use, air-gapped environments |
| **Self-hosted** | Customer's own infrastructure (on-prem, private cloud, or the customer's own public cloud account) | Customer's IT/platform team | Regulated industries, data-sovereignty requirements, existing container/Kubernetes estates |
| **Hosted (SaaS-style)** | A shared multi-tenant backend, each `Organisation` entity data-isolated by tenant, operated by a third party on the customer's behalf | The hosting operator | Customers who want the self-hosted feature set without operating infrastructure themselves |

The **Local** model has no server-side integration surface at all — it is out of scope for the
remainder of this document. **Self-hosted** and **Hosted** run the identical backend code; the
distinction is purely operational (who holds the infrastructure credentials, who is accountable for
patching and backups). Everything from §4 onward applies equally to both.

Multi-tenancy is native to the data model even in a self-hosted deployment: every server-connected
project belongs to exactly one `Organisation` row, and every cross-organisation query path is
explicitly re-validated server-side (never trusting a client-supplied identifier) — see §9.3. A
self-hosted customer typically runs a single-tenant instance (one Organisation) by convention, but
nothing in the architecture prevents hosting multiple tenants on one self-hosted instance if that
suits the customer's own consolidation strategy.

---

## 3. Backend tier selection

| Tier | Language / framework | Database | ORM / data access | Reference doc |
|---|---|---|---|---|
| `api/Enkl.Api` | .NET 10, ASP.NET Core | PostgreSQL 13+ (16 recommended) | Entity Framework Core (Npgsql) | `DEPLOYMENT-NET-DOCKER.md`, `DEPLOYMENT-AWS.md` |
| `php-api` | PHP 8.2+, Slim 4 | PostgreSQL 13+ | Raw PDO | `DEPLOYMENT-PHP.md` |
| `mariadb-api` | PHP 8.2+, Slim 4 | MariaDB 11.4+ | Raw PDO | `DEPLOYMENT-MARIADB.md` |

All three tiers expose the same REST/JSON contract, the same JWT claim shape, the same SAML/SCIM
integration points, and the same security control set (§7–§10) — the frontend requires no
configuration change to point at whichever tier is deployed. Choose based on the operating team's
existing platform expertise (.NET vs. PHP) and database standardisation (PostgreSQL vs. MariaDB/MySQL
family), not on any functional difference; there is none from an integrator's perspective. **Do not
run two tiers against the same database concurrently** — pick one tier per deployment and per
database instance.

A fourth, structurally-identical PHP/MariaDB variant exists specifically to accommodate
commercial shared-hosting environments where the connecting database account cannot itself create
database roles or system accounts — see `DEPLOYMENT-MARIADB.md` §7.1 for the resulting manual,
one-time account-provisioning step that model requires.

---

## 4. Identity and access management overview

Three authorisation scopes exist, enforced **server-side on every request**, independent of what any
client displays:

- **Member** — standard access to the project(s) they are added to.
- **Project Admin** — administrative rights scoped to one project (team membership, workflow
  configuration, column management). Set per project, per user.
- **Org Admin** — administrative rights across the entire Organisation, including implicit Project
  Admin rights on every project within it, plus the Organisation-wide screens: user management, SSO
  and provisioning configuration, and cross-project portfolio reporting.

Authentication is **JWT-based** (bearer token, `Authorization: Bearer <token>` header), not
cookie/session-based. This has one direct security consequence worth calling out to any integrator
performing a threat model: **there is no CSRF exposure** in this application, because nothing is ever
sent automatically by the browser on a cross-site request — the token must be explicitly attached by
the frontend's own JavaScript on every call. The corollary is that the token is held in browser
`localStorage`, so the application's XSS-hardening posture (§10) is the primary control protecting
session integrity, not a cookie flag.

User accounts can be sourced three ways, all coexisting within one Organisation:

1. **Directly created** by an Org Admin through the application's own user-management screen.
2. **Federated authentication** via SAML 2.0 — the user's identity is asserted by the customer's own
   IdP at login time; see §5.
3. **Automated provisioning** via SCIM 2.0 — the customer's IdP pushes account create/update/deactivate
   operations directly to the application's API; see §6.

SAML and SCIM are independent integrations and may be deployed together (the common enterprise
pattern: SCIM provisions the account ahead of time, SAML authenticates the session) or separately.

---

## 5. Single Sign-On via SAML 2.0

**Protocol role**: Enklr Task acts as the **Service Provider (SP)**. The customer's own IdP (Okta,
Entra ID / Azure AD, PingFederate, ADFS, or any SAML 2.0–compliant IdP) acts as the **Identity
Provider (IdP)**.

**Per-Organisation configuration.** SAML is configured once per Organisation, by that
Organisation's Org Admin, through the application's SSO configuration screen — there is no global,
cross-tenant SAML configuration. Required inputs from the IdP side:

- **IdP Entity ID** — the IdP's own SAML issuer identifier.
- **IdP SSO URL** — the endpoint the SP redirects the browser to for authentication.
- **IdP signing certificate** — the X.509 certificate used to verify the IdP's signed assertions.

**SP metadata exposed by the application**, per Organisation:

- **SP Entity ID**: `{PublicBaseUrl}/api/saml/{organisationId}/metadata`
- **Assertion Consumer Service (ACS) URL**: derived from the same `PublicBaseUrl` value.

The `PublicBaseUrl` configuration value (the externally-visible scheme and hostname of the
deployment) is load-bearing for SAML correctness: it is used to construct both the SP entity ID and
the ACS URL the IdP redirects back to. A misconfigured or incorrect `PublicBaseUrl` is the single
most common SAML integration failure mode observed in this class of deployment; verify it matches the
exact public-facing domain before configuring the IdP side.

**Security controls already implemented in the SP:**

- **Replay protection** — every outbound `AuthnRequest` is assigned a single-use identifier;
  a response correlating to an already-consumed request identifier is rejected.
- **Signing certificate validation** — the configured IdP certificate is checked for expiry and for a
  minimum RSA key strength of 2048 bits at the time it is saved into the Organisation's configuration,
  not only at assertion-verification time.
- **Audience and issuer restriction** — the SP validates that an incoming assertion's audience
  matches its own entity ID and that the issuer matches the configured IdP Entity ID exactly.

**Just-in-time (JIT) provisioning**: a successful first-time SAML login for a username not already
present in the target Organisation creates the account at login time, using attributes from the
assertion. Combine with SCIM (§6) if the enterprise requirement is that accounts must exist
*before* a login is attempted (e.g., to support pre-provisioned licence/seat governance) — SAML JIT
alone does not enforce that ordering.

**Integrator responsibility**: exchanging IdP/SP metadata, mapping assertion attributes to the
fields the application expects (username, display name, email), and, if the IdP supports it,
configuring an IdP-initiated vs. SP-initiated flow (SP-initiated is the default and recommended
flow for this application).

---

## 6. Automated provisioning via SCIM 2.0

**Protocol role**: Enklr Task exposes a SCIM 2.0 **Service Provider** endpoint per Organisation. The
customer's IdP (or a dedicated identity governance platform) acts as the **SCIM Client**, pushing
provisioning operations to the application rather than the application pulling them.

**Authentication**: SCIM requests authenticate via a **static bearer token**, distinct from the
application's own end-user JWT authentication chain entirely. The token is generated once (per
Organisation) and displayed exactly once at generation time; only its bcrypt hash is retained
server-side, matching the treatment given to user passwords elsewhere in the application. Losing the
token means generating a new one and reconfiguring the IdP side — there is no recovery of a lost
token.

**Supported operations**: user resource create, read, update (`PATCH`/`PUT`), and deactivate, plus
group resource support for group-based role assignment where the IdP supports pushing group
membership. Filtering (SCIM's `filter=` query parameter) is supported for the common
`userName eq "..."` lookup pattern IdPs use to check for an existing account before creating a
duplicate. An unsupported filter attribute or syntax degrades gracefully to "no matches" rather than
erroring, matching SCIM clients' typical expectation of that response shape.

**What SCIM does and does not touch**: SCIM's Users resource maps onto the application's own `User`
entity (account existence, active/inactive status, display name, email) — the same accounts SAML and
direct creation also produce. It deliberately does **not** manage project membership or team/committee
assignment; those remain the application's own project-level administrative concern, not something a
SCIM push can affect. An account deactivated via SCIM is immediately unable to authenticate — its
existing session tokens are also revoked at that moment (see §7's `SecurityStamp` mechanism), not
merely blocked from new logins.

**Deployment note**: enabling SCIM for an Organisation is a configuration action taken by that
Organisation's own Org Admin (bearer token generation, endpoint URL) — no infrastructure-level change
is required on the integrator's part beyond ensuring the application's API is reachable from the
IdP's provisioning connector (typically a public HTTPS endpoint, since most cloud IdPs provision
outbound-only from their own infrastructure).

**Deprovisioning is not exclusively a SCIM concern.** An Org Admin can also deactivate a user
directly from the application's own Manage Users screen — the identical `IsActive`-flip-plus-
`SecurityStamp`-rotation path SCIM's deactivate operation triggers, just initiated in-app rather than
pushed from the IdP. This matters for a deployment integration decision: a customer who has **not**
configured SCIM is not left without any offboarding mechanism — manual deactivation is a first-class,
always-available path, independent of whether identity federation is in scope for that customer at
all. Deactivating a user (by either path) does not remove them from any project, task assignment, or
governance-item ownership they already held — those references are left intact and rendered with an
explicit inactive indicator in the UI, so historical accountability stays visible; reassigning that
work to an active user is a separate, manual administrative action.

---

## 7. Authentication tokens and session security

- **Token format**: JWT, HS256-signed, containing standard claims (subject, issuer, audience,
  expiry) plus application claims: organisation ID, organisation name, an org-admin flag, a
  `securityStamp` value, and a snapshot of the caller's project memberships at issuance time.
- **Expiry**: approximately 8 hours from issuance, with a 1-minute clock-skew allowance on
  validation.
- **Revocation via `SecurityStamp`**: every JWT carries a `securityStamp` GUID that is re-validated
  against the live database value on **every** authenticated request. This value is rotated on
  password change, on an account's Org Admin status changing, and on deactivation — whether that
  deactivation was pushed by SCIM or triggered manually by an Org Admin from Manage Users (§6) — the
  practical effect is that a previously issued token becomes unusable **immediately** upon any of
  those events, not merely at its natural expiry. This is the primary mitigation against the standard
  "stolen long-lived bearer token stays valid until it expires" weakness of bearer-token
  authentication generally.
- **Forced password change enforcement**: an account flagged as requiring a password change (fresh
  accounts, administrator-triggered resets) is server-side blocked from every mutating API call
  except the change-password endpoint itself — read access continues to function so the client
  application isn't left completely broken mid-flow, but no data can be written until the password is
  changed. This enforcement happens in request middleware, not merely as a client-side prompt.
- **Rate limiting**: authentication-adjacent endpoints (login, password change, SSO
  lookup/exchange, and initial-organisation bootstrap) are limited to 10 requests per 60-second
  sliding window, keyed by client IP, with requests over the limit rejected outright (HTTP 429, no
  queuing). **This control's correctness depends entirely on network topology** — see §8's note on
  `X-Forwarded-For` trust boundaries; misconfiguring the reverse-proxy chain silently defeats this
  control rather than failing loudly.
- **No CORS surface by default**: the application registers an empty default CORS policy — no
  origin is permitted cross-origin access unless explicitly configured otherwise. In the standard
  reverse-proxy topology (§8), the frontend and API are same-origin, so this default requires no
  change; widening it should be a deliberate, reviewed decision, not a default.

---

## 8. Network security architecture

The reference network topology places exactly one component in a network position reachable from
outside the deployment: the web/reverse-proxy tier. Everything else — the application server and the
database — is reachable only from within the deployment's own private network segment.

```svg
<svg viewBox="0 0 620 450" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Network segmentation diagram: a browser reaches a TLS-terminating layer over HTTPS in the public network/DMZ; from there, plain HTTP within the private network segment only reaches the web/reverse-proxy tier, then the application server, then the database.">
  <defs>
    <marker id="netArrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" style="fill: var(--kf-blue)"/>
    </marker>
  </defs>
  <text x="10" y="34" font-size="13" style="fill: var(--kf-text)">HTTPS</text>
  <text x="10" y="50" font-size="12" style="fill: var(--kf-text-secondary)">(browser)</text>
  <line x1="90" y1="42" x2="170" y2="42" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#netArrow)"/>
  <rect x="175" y="10" width="330" height="64" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="340" y="36" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">TLS-terminating layer</text>
  <text x="340" y="54" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">(load balancer / ingress / reverse proxy)</text>
  <text x="520" y="46" font-size="11" font-style="italic" style="fill: var(--kf-text-secondary)">public network / DMZ</text>
  <line x1="340" y1="74" x2="340" y2="130" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#netArrow)"/>
  <text x="350" y="106" font-size="11" style="fill: var(--kf-text-secondary)">plain HTTP, private network segment only</text>
  <rect x="175" y="136" width="330" height="64" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="340" y="162" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">Web / static asset + reverse proxy tier</text>
  <text x="340" y="180" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">the only component with any public-facing listener</text>
  <line x1="340" y1="200" x2="340" y2="256" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#netArrow)"/>
  <text x="350" y="228" font-size="11" style="fill: var(--kf-text-secondary)">private network segment only,</text>
  <text x="350" y="242" font-size="11" style="fill: var(--kf-text-secondary)">no public listener</text>
  <rect x="175" y="262" width="330" height="54" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="340" y="294" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">Application server (API)</text>
  <line x1="340" y1="316" x2="340" y2="372" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#netArrow)"/>
  <text x="350" y="344" font-size="11" style="fill: var(--kf-text-secondary)">private network segment only,</text>
  <text x="350" y="358" font-size="11" style="fill: var(--kf-text-secondary)">no public listener</text>
  <rect x="175" y="378" width="330" height="54" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="340" y="410" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">Relational database</text>
</svg>
```

**Mandatory network segmentation rules**, enforced at the infrastructure layer (security groups,
network security groups, VPC/VNet firewall rules, or Kubernetes `NetworkPolicy` — the application
itself has no ability to enforce this):

1. The application server accepts inbound traffic **only** from the web/reverse-proxy tier's network
   identity — never a public IP, public DNS record, or public load-balancer listener of its own.
2. The database accepts inbound traffic **only** from the application server's network identity —
   never a public endpoint, and never a database connection pooler/proxy interposed (see the
   explicit warning below).
3. The web/reverse-proxy tier is the sole component with a public listener, and that listener should
   terminate TLS (§11) with no plaintext fallback beyond a redirect.

**Do not place a connection-pooling proxy (e.g., RDS Proxy, PgBouncer in transaction-pooling mode)
between the application server and the database.** The application's real-time update mechanism
depends on PostgreSQL's session-scoped `LISTEN`/`NOTIFY` mechanism (or, on the MariaDB tier, an
equivalent polling outbox — see `mariadb-api/CLAUDE.md`), and a pooling/multiplexing proxy can hand a
pooled connection to a different logical client mid-stream, silently dropping live-update
notifications without any error surfacing. This is a functional-correctness issue with security
relevance: silent data-delivery failure is a worse failure mode than a loud one.

**`X-Forwarded-For` trust boundary** — a specific, non-obvious point worth an integrator's direct
attention: the application's rate-limiting (§7) and IP-based logging derive the client's IP address
from the `X-Forwarded-For` header, and the reference configuration trusts that header
**unconditionally** — this is safe *only* because the application server is architecturally
unreachable except through the deployment's own reverse-proxy tier (rule 1, above). If this
invariant is ever violated — the application server exposed directly, even temporarily for
troubleshooting — every client behind that direct path shares a single rate-limit bucket, and the
header becomes trivially forgeable by any caller. Treat "is the application server still
unreachable except via the proxy" as a standing, periodically-re-verified control, not a one-time
setup check.

---

## 9. Database accounts and data protection

### 9.1 Connection account

The application connects to its database using a single service account per deployment. That
account requires, at minimum:

- Full DML (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) on the application's own schema.
- DDL rights sufficient to apply the application's own forward-only schema migrations
  automatically at startup (`CREATE TABLE`/`ALTER TABLE` and equivalent).
- On PostgreSQL specifically: the ability to `CREATE ROLE` and `CREATE VIEW` — the Public Query API
  feature (an optional, per-project, saved-SQL-query exposure capability, disabled unless explicitly
  configured) provisions a narrowly-scoped, isolated database role for that purpose. On a managed
  PostgreSQL service, this generally requires the connecting account to hold the platform's own
  bounded superuser-equivalent (e.g., AWS RDS's `rds_superuser`, which the RDS master user holds by
  default). On database platforms where the connecting account cannot be granted that (notably
  commercial shared MySQL/MariaDB hosting), this step becomes a manual, one-time, out-of-band
  provisioning action — see `DEPLOYMENT-MARIADB.md` §7.1.

### 9.2 Credential handling

- Database credentials, the JWT signing key, and the SCIM bearer token hash are the deployment's
  three categories of secret material. None of them ship with a usable default in a production
  configuration — the reference container images and configuration schemas fail to start rather than
  falling back to a placeholder value when these are unset.
- Credentials should be sourced from the target platform's secrets management facility (a cloud
  secrets manager, HashiCorp Vault, a Kubernetes `Secret` backed by an external secrets operator, or
  equivalent) and injected as environment variables at container start — never baked into a container
  image, never committed to source control, never present in plain text in an orchestrator manifest
  checked into version control.
- Encryption in transit between the application server and the database should be enabled and, where
  the database platform supports it, required (`sslmode=require` or equivalent) rather than merely
  offered.

### 9.3 Tenant data isolation

Every entity that is Organisation-scoped rather than Project-scoped (user accounts, org-wide
settings, cross-project portfolio data) carries an explicit foreign key to its owning Organisation.
Every server-side code path that accepts a client-supplied identifier for such an entity — most
notably any Org-Admin-scoped, cross-project reporting or management endpoint — independently
re-derives which of the supplied identifiers actually belong to the caller's own Organisation before
touching any data, rather than trusting the client's claim. An identifier belonging to a different
Organisation is treated identically to a nonexistent identifier (a uniform not-found response) —
deliberately, so that no error response can be used to enumerate the existence of another tenant's
data. This pattern is applied consistently across every cross-tenant-capable endpoint and is the
primary architectural control against tenant data leakage in a multi-tenant (Hosted, or
multi-Organisation self-hosted) deployment.

### 9.4 At-rest protection

The application itself performs no database-level encryption of its own beyond what the underlying
database platform provides (transparent data encryption / storage-level encryption is a database
platform configuration concern, not something this application manages). One feature is a partial
exception worth noting for a data-protection review: the application's "Private Task" feature
performs **client-side** encryption (Web Crypto API, PBKDF2 key derivation into AES-GCM) of a task's
content *before* it is ever transmitted or stored — the passphrase is never transmitted to or held by
the server, meaning the server (and by extension, any database administrator) cannot recover the
plaintext of a private task without the end user's passphrase. This is an end-user convenience
feature, not a substitute for platform-level encryption at rest, and it has a genuine, irreversible
data-loss mode: a forgotten passphrase permanently forfeits that task's content, by design.

### 9.5 No CHECK constraints as a security control

By deliberate, consistent convention across every tier and every schema, string fields with a
bounded set of valid values (priority levels, statuses, and similar) are **not** enforced via
database-level `CHECK` constraints — validation of these fields is an application-layer concern only.
An integrator auditing the schema directly (rather than through the application) should not expect
to find, and should not add, ad hoc `CHECK` constraints as a defence-in-depth measure without
coordinating with the application's own maintainers first — an inconsistently-applied constraint on
one column reads as accidental, not deliberate hardening.

---

## 10. Web application protections

- **Output encoding**: all user-supplied content rendered into HTML is passed through a shared,
  centrally-defined escaping function that encodes the full set of characters relevant to both HTML
  body and HTML attribute contexts (not only `&`/`<`/`>`, but also the quote characters relevant to
  attribute-value breakout). This is implemented once and imported everywhere it's needed, rather
  than reimplemented per call site — a deliberate architectural choice specifically to prevent the
  class of bug where one of several independent reimplementations quietly falls behind the others.
- **URL scheme allowlisting**: any user-supplied value that is later rendered as a hyperlink or
  passed to a browser navigation API is parsed with the platform's own URL parser and checked against
  an explicit scheme allowlist (`http:`, `https:`, `mailto:`) — schemes capable of script execution in
  a browser context (`javascript:`, `data:`, and similar) are rejected rather than passed through.
- **Content Security Policy**: the reference reverse-proxy configuration sets a restrictive CSP —
  `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, and
  `form-action 'self'` — narrowing the impact of any script-injection weakness that does occur.
  `script-src`/`style-src` require `'unsafe-inline'` (and `script-src` currently also requires
  `'unsafe-eval'`) as a direct consequence of the frontend's architecture as a single, fully inlined
  HTML document with no build-time bundler-driven nonce/hash mechanism in front of it — an integrator
  performing a strict CSP audit should treat this as a known, architecturally-driven relaxation
  specific to this application's single-file design, not an oversight to silently "fix" by stripping
  it (doing so breaks the application outright).
- **Additional response headers**: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and (once TLS is terminated — see §11)
  `Strict-Transport-Security` with a long max-age and `includeSubDomains`. The application server
  itself also sets a subset of these headers directly, as defence-in-depth for any deployment
  topology where the application server is somehow reached without passing through the reverse-proxy
  tier first.
- **CSRF**: not applicable, by architecture — see §4's note on bearer-token authentication carrying
  no ambient browser credential.
- **Enumeration resistance**: authentication failure responses (an unknown username vs. a correct
  username with a wrong password) and cross-tenant lookups (§9.3) are both designed to return
  indistinguishable responses for the "doesn't exist" and "exists but you can't have it" cases.
- **File upload surface**: minimal — the application's only binary-upload path is an optional,
  client-side-only board background image, stored in the requesting user's own browser storage and
  never transmitted to or processed by the server. There is no server-side file upload processing,
  and consequently no server-side file-upload attack surface (virus scanning, path traversal, content-
  type sniffing) to account for in an integration review.

---

## 11. Certificates and TLS

**TLS termination is explicitly out of scope of the application and its reference container images**
— the reference web/reverse-proxy configuration listens on plain HTTP only, by design, on the
expectation that a TLS-terminating layer (a cloud load balancer, an on-prem reverse proxy, or a
Kubernetes Ingress controller) sits in front of it. This is a deliberate separation of concerns, not
an oversight — but it means **no deployment of this application is complete, from a security
standpoint, until that TLS-terminating layer has been added.** The application ships defence-in-depth
headers (`Strict-Transport-Security`, §10) that only take effect once TLS actually terminates
somewhere in the chain; they do nothing on their own.

Acceptable TLS termination points, in order of typical enterprise preference:

1. **A managed cloud load balancer** (e.g., an Application Load Balancer with an ACM-issued or
   ACM-imported certificate) — the pattern used in §12's case study.
2. **An enterprise-standard reverse proxy or API gateway** already operated by the integrator's
   organisation, terminating TLS with a certificate issued by the organisation's own internal or
   commercial CA.
3. **A self-managed reverse proxy** (nginx, Caddy, HAProxy, Traefik) with a certificate obtained via
   an automated CA (Let's Encrypt / ACME) or manually provisioned.

**Certificate requirements**, regardless of termination point:

- A valid certificate for the exact public hostname configured as the deployment's `PublicBaseUrl` —
  a mismatch here breaks SAML SSO specifically (§5), in addition to the general browser trust
  warning it produces for every other feature.
- Automated renewal wherever practical (ACME-based issuance renews well ahead of a typical 90-day
  lifetime; commercial/internal-CA certificates should have renewal tracked against whatever lifetime
  the issuing CA assigns — internal CAs often issue considerably longer-lived certificates, which
  shifts the operational risk from "renewal automation failure" to "a long-forgotten expiry date,"
  and should be tracked accordingly).
- A minimum TLS protocol version of TLS 1.2, with TLS 1.3 preferred where the termination point
  supports it — this is a general current best practice recommendation, not a hard requirement
  enforced by the application itself, since the application has no visibility into the negotiated
  TLS parameters occurring at a layer in front of it.

**In-transit encryption beyond the browser leg**: where the deployment's compliance requirements
extend to internal traffic (proxy↔application server, application server↔database), TLS can be
layered onto both of those hops independently — the application server accepts a plain-HTTP listener
by reference default (on the expectation that hop is already within a trusted private network
segment, §8), and the database connection string supports TLS/`sslmode=require` where the database
platform offers it (§9.2). Neither is enabled by default in the reference configuration; both are
additive hardening an integrator can layer on for a higher assurance requirement.

---

## 12. Case study: idealised containerised AWS deployment

This section walks through a complete, production-grade AWS reference architecture using containers
throughout. It is the architecture this repository's own `DEPLOYMENT-AWS.md` documents in full
command-by-command detail — this section summarises the *design decisions and rationale* an
integrator needs to evaluate before adapting it to their own AWS account; consult `DEPLOYMENT-AWS.md`
directly for exact, current `aws` CLI invocations. **All identifiers below are illustrative
placeholders.**

### 12.1 Target architecture

```svg
<svg viewBox="0 0 620 410" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AWS target architecture diagram: Route 53 and an ACM certificate reach an Application Load Balancer in public subnets, which forwards plain HTTP within private subnets to an ECS Fargate service running web and api containers in one task, which reaches RDS for PostgreSQL over port 5432, also private-subnets only.">
  <defs>
    <marker id="awsArrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" style="fill: var(--kf-blue)"/>
    </marker>
  </defs>
  <text x="310" y="24" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">Route 53 (customer's own domain)</text>
  <line x1="310" y1="32" x2="310" y2="66" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#awsArrow)"/>
  <text x="320" y="54" font-size="11" style="fill: var(--kf-text-secondary)">ACM certificate (443)</text>
  <rect x="130" y="72" width="360" height="60" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="310" y="98" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">Application Load Balancer</text>
  <text x="310" y="116" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">443 &#8594; target group &quot;web&quot;</text>
  <text x="500" y="106" font-size="11" font-style="italic" style="fill: var(--kf-text-secondary)">public subnets</text>
  <line x1="310" y1="132" x2="310" y2="186" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#awsArrow)"/>
  <text x="320" y="164" font-size="11" style="fill: var(--kf-text-secondary)">plain HTTP, private subnets only</text>
  <rect x="110" y="192" width="400" height="80" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="310" y="216" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">ECS Fargate service</text>
  <text x="310" y="234" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">one task, two containers:</text>
  <text x="310" y="250" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">web (nginx) &#8594; api (Kestrel)</text>
  <text x="310" y="266" font-size="10.5" font-style="italic" text-anchor="middle" style="fill: var(--kf-text-secondary)">same task = same network namespace</text>
  <line x1="310" y1="272" x2="310" y2="326" stroke-width="2" style="stroke: var(--kf-blue)" marker-end="url(#awsArrow)"/>
  <text x="320" y="304" font-size="11" style="fill: var(--kf-text-secondary)">port 5432, private subnets only</text>
  <rect x="130" y="332" width="360" height="60" rx="6" fill="none" stroke-width="1.5" style="stroke: var(--kf-border)"/>
  <text x="310" y="358" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--kf-text)">RDS for PostgreSQL 16</text>
  <text x="310" y="376" font-size="11.5" text-anchor="middle" style="fill: var(--kf-text-secondary)">Multi-AZ, no RDS Proxy</text>
</svg>
```

**Design rationale — one ECS task, two sidecar containers, not two ECS services**: this maps 1:1
onto the reference Docker Compose topology (web + api as two containers of one logical unit) and
minimises new infrastructure. The trade-off an integrator should weigh: the two containers then scale
together (identical task count for both), and containers within one Fargate task communicate over
`localhost` rather than by service-discovery name — the reverse-proxy configuration's upstream target
requires a one-line adjustment (`http://api:8080` → `http://localhost:8080`) to account for this,
applied to an AWS-specific copy of that configuration file, leaving the reference configuration
unmodified for non-AWS deployments. If independent scaling of the two components later becomes a
requirement, splitting them into two ECS services behind ECS Service Connect restores
service-discovery-by-name and removes this constraint.

### 12.2 Networking

A minimal two-Availability-Zone VPC: two public subnets (hosting only the load balancer) and two
private subnets (hosting the ECS tasks and the RDS instance). Three security groups, each permitting
traffic **only** from the specific security group one layer up the chain — never a CIDR range wider
than necessary, and never a rule admitting inbound traffic to the application container's port from
anywhere except the load balancer's own security group. No security group in this design ever admits
inbound traffic to the database from anything other than the ECS task's security group, and no
security group admits inbound traffic to the ECS task's application-server port from anything other
than the load balancer's security group. A NAT gateway provides the private-subnet ECS tasks
outbound-only connectivity (for image pulls and any future outbound integration need); the database
itself requires no outbound internet route at all.

### 12.3 Database

Amazon RDS for PostgreSQL, engine version 16, `--no-publicly-accessible`, provisioned into the
private subnets only, with automated backups enabled and a Multi-AZ deployment for production
workloads (a single-AZ instance is an acceptable cost reduction for a non-production environment
only). Two AWS-specific considerations beyond generic RDS guidance, both already noted in §8/§9:

- **No RDS Proxy** in front of this database, for the `LISTEN`/`NOTIFY` reason given in §8.
- The database's master user (or an app-dedicated user granted the platform's bounded
  superuser-equivalent role) is used as the application's connecting account specifically because the
  optional Public Query API feature's role-provisioning step requires that privilege level on this
  platform — see §9.1.

### 12.4 Secrets

The database connection string, the JWT signing key, and (if SCIM is enabled) the SCIM bearer token
are stored in a managed secrets store (AWS Secrets Manager, or SSM Parameter Store as a
lower-cost alternative) and referenced directly by ARN in the container orchestration platform's task
definition — the actual secret values never appear in the task definition JSON itself, in the
container orchestration platform's console, or in the application's log output. The execution role
permitted to read these secrets is scoped to exactly the specific secret ARNs required, never a
wildcard grant across the account's entire secrets store. The application container's own runtime
role (as opposed to the execution role that merely starts it) requires no AWS API permissions at all,
since the application makes no calls to AWS services itself — that runtime role should remain empty
or minimal, and an integrator reviewing this deployment should treat any broader grant on it as
unjustified by the application's own needs.

### 12.5 Compute and load balancing

Two container images (reverse-proxy/frontend tier, application-server tier) are pushed to a private
container registry and deployed as one Fargate task definition, run behind an Application Load
Balancer terminating TLS with a certificate issued by the platform's managed certificate service,
validated via DNS. The load balancer's health check targets the application's own `/health` endpoint,
which itself confirms the full request chain — proxy through to the application server through to a
live database connectivity check performed as part of the application's own startup sequence. A
production-appropriate desired task count (two or more) gives baseline high availability, with one
noted, accepted trade-off: an in-process rate limiter becomes per-instance once more than one task is
running, proportionally weakening (not eliminating) that specific control at scale — an integrator
requiring a stronger guarantee at high task counts should layer a web-application-firewall rate rule
in front of the load balancer as an additional control, rather than relying on the in-process limiter
alone at that scale.

**A load-balancer-specific gotcha worth flagging explicitly**: the default idle-timeout on most
managed load balancers (commonly 60 seconds) is far shorter than the multi-hour duration the
application's live-update streaming connection is designed to stay open for. Failing to raise the
load balancer's own idle-timeout setting to match or exceed the application's own long-read-timeout
configuration does not produce a visible error — the frontend simply reconnects every ~60 seconds
instead of maintaining one continuous connection, a behaviour easy to miss without deliberately
watching for it during a validation pass.

### 12.6 Validation

A complete deployment validation should confirm, at minimum: the public health endpoint returns a
healthy response through the full chain (load balancer → reverse-proxy tier → application server →
its own database connectivity check); the application's schema migrations applied successfully on
first boot (visible in the centralised log destination); and — the most commonly missed check — that
the live-update mechanism functions correctly across two independent browser sessions, which is the
definitive end-to-end proof that the load-balancer idle-timeout adjustment above actually took
effect.

---

## 13. Logging, monitoring, and incident response hooks

- **Structured logging**: both the .NET and PHP tiers emit structured JSON log lines to standard
  output — no application-managed log file, no built-in log-shipping agent. Route container stdout to
  the platform's log aggregation service (CloudWatch Logs, an ELK/Loki stack, or equivalent);
  retention should be set deliberately rather than left at whatever the platform's own default is
  (several platforms default to unlimited retention, which is a cost and data-governance decision, not
  a technical default that should go unexamined).
- **Correlation IDs**: every request is tagged with a correlation identifier (sourced from the
  reverse-proxy tier's own per-request ID where available, generated by the application otherwise) and
  echoed back in the response and into every log line produced while handling that request — this is
  the mechanism to use when correlating a user-reported issue against server-side logs, rather than
  attempting to correlate on timestamp alone. The application deliberately never logs
  request/response bodies, the `Authorization` header, or raw token values.
- **Audit surface**: task-level changes are recorded in a per-task audit trail visible within the
  application itself. This is an application-data-level audit trail (what changed on a given task),
  not a security/access-log audit trail (who authenticated when, from where) — an integrator with a
  formal security-audit-logging requirement should treat the correlation-ID-tagged structured request
  logs (above) as the source for the latter, not the in-application task audit trail.
- **No built-in external error-tracking (e.g., Sentry-class) integration** ships by default — this is
  a deliberate, currently-open decision point for an integrator with an existing error-tracking
  platform to wire in via the structured log stream, rather than an assumed gap to fill.

---

## 14. Backup, recovery, and business continuity

- **The application manages no backup process of its own.** All durable state lives in the relational
  database; backup and point-in-time recovery are entirely the responsibility of the database
  platform (managed-service automated backups, or the integrator's own `pg_dump`/WAL-archiving or
  equivalent discipline for a self-managed database).
- **Local/offline deployments (§2)** have no server-side backup at all by definition — the
  application provides a manual project export function as the only backup mechanism available at
  that tier; this is a user-initiated, user-education concern rather than an infrastructure one.
- **Restore testing**: a configured backup that has never been exercised through an actual restore is
  not a verified control. This applies with particular force to any Multi-AZ/HA configuration, where
  failover behaviour and backup-restore behaviour are frequently conflated but are not the same
  guarantee.
- **Recovery Time/Point Objectives**: neither is defined by the application itself — both are a
  function of the chosen database platform's backup cadence and the integrator's own tested restore
  procedure. Document both explicitly as part of any production go-live, rather than assuming a
  managed database service's default backup window meets an unstated internal requirement.

---

## 15. Integration checklist (pre-go-live)

- [ ] Exactly one backend tier selected and deployed against its own dedicated database — no two
      tiers pointed at the same database.
- [ ] TLS terminated in front of the reverse-proxy/frontend tier, with a certificate valid for the
      exact `PublicBaseUrl` hostname, and HTTP either fully absent or redirecting to HTTPS only (never
      forwarding).
- [ ] Network segmentation confirmed at the infrastructure layer: application server unreachable
      except from the reverse-proxy tier; database unreachable except from the application server; no
      temporary "debug" exception left in place afterward.
- [ ] No connection-pooling/multiplexing proxy interposed between the application server and the
      database.
- [ ] All secrets (database credentials, JWT signing key, SCIM bearer token) sourced from a managed
      secrets facility, not plain environment values in a committed manifest.
- [ ] `PublicBaseUrl` set to the exact production hostname before configuring SAML on the IdP side.
- [ ] If SAML is in scope: IdP metadata exchanged, signing certificate validated (expiry, key
      strength), and a test login performed end-to-end before rollout to the full user population.
- [ ] If SCIM is in scope: bearer token generated and securely handed off to the IdP's provisioning
      connector exactly once (it cannot be retrieved again later), and a test provisioning/
      deprovisioning cycle performed before relying on it operationally.
- [ ] Database backups enabled and at least one restore actually tested.
- [ ] Centralised log destination configured with a deliberately chosen retention period.
- [ ] Live-update (real-time) functionality validated across two independent sessions post-deployment
      — the definitive check that the reverse-proxy/load-balancer chain's timeout settings are
      correctly configured for the application's long-lived streaming connection.
- [ ] CSP, `X-Frame-Options`, `Strict-Transport-Security`, and the other reference security headers
      confirmed present on responses actually served through the production TLS-terminating layer,
      not only observed against a local/dev environment.

---

## 16. Glossary

| Term | Definition |
|---|---|
| **ACM** | AWS Certificate Manager — AWS's managed service for provisioning and renewing TLS certificates. |
| **ACS** | Assertion Consumer Service — the SAML Service Provider endpoint that receives and processes an IdP's authentication assertion. |
| **ALB** | Application Load Balancer — AWS's Layer 7 (HTTP/HTTPS-aware) managed load balancer. |
| **AZ** | Availability Zone — an isolated data-centre location within a cloud region. |
| **CA** | Certificate Authority — an entity that issues digital certificates. |
| **CIDR** | Classless Inter-Domain Routing — the notation used to express an IP address range (e.g., `10.0.0.0/16`). |
| **CORS** | Cross-Origin Resource Sharing — the browser mechanism controlling whether a script on one origin may call an API on another. |
| **CSP** | Content Security Policy — an HTTP response header restricting which sources of script, style, and other content a browser will load for a page. |
| **CSRF** | Cross-Site Request Forgery — an attack tricking a browser into making an unwanted authenticated request. |
| **DDL** | Data Definition Language — SQL statements that define or alter schema structure (`CREATE TABLE`, `ALTER TABLE`). |
| **DML** | Data Manipulation Language — SQL statements that read or modify data (`SELECT`, `INSERT`, `UPDATE`, `DELETE`). |
| **DMZ** | Demilitarised Zone — a network segment exposed to untrusted traffic, isolated from internal networks. |
| **DNS** | Domain Name System. |
| **ECR** | Elastic Container Registry — AWS's managed container image registry. |
| **ECS** | Elastic Container Service — AWS's managed container orchestration service. |
| **Fargate** | AWS's serverless compute engine for containers, used with ECS or EKS, requiring no underlying EC2 instance management. |
| **HA** | High Availability. |
| **HS256** | HMAC-SHA256 — a symmetric-key message authentication code algorithm, used here to sign JWTs. |
| **HSTS** | HTTP Strict Transport Security — a response header instructing browsers to only ever connect to a site over HTTPS. |
| **HTTP / HTTPS** | Hypertext Transfer Protocol (Secure). |
| **IdP** | Identity Provider — the system that authenticates a user and asserts their identity to a Service Provider (see SP), in SAML terminology. |
| **JIT (provisioning)** | Just-In-Time provisioning — creating a user account automatically at the moment of their first successful federated login, rather than in advance. |
| **JWT** | JSON Web Token — a compact, signed token format used here for API authentication. |
| **NAT** | Network Address Translation — here, an AWS NAT Gateway providing outbound-only internet access for resources in a private subnet. |
| **ORM** | Object-Relational Mapper — a library translating between application objects and relational database rows (e.g., Entity Framework Core). |
| **PDO** | PHP Data Objects — PHP's built-in database access abstraction layer. |
| **PKI** | Public Key Infrastructure — the systems and processes underpinning certificate issuance and trust. |
| **RDS** | Relational Database Service — AWS's managed relational database offering. |
| **RPO** | Recovery Point Objective — the maximum acceptable amount of data loss, measured in time, in a recovery scenario. |
| **RTO** | Recovery Time Objective — the maximum acceptable time to restore service after an outage. |
| **SAML** | Security Assertion Markup Language — an XML-based standard for exchanging authentication and authorisation assertions between an IdP and an SP. |
| **SCIM** | System for Cross-domain Identity Management — a REST/JSON standard for automating user provisioning and deprovisioning between systems. |
| **SP** | Service Provider — the application relying on an IdP's assertions to authenticate a user, in SAML terminology. Enklr Task is always the SP, never the IdP. |
| **SSM** | (AWS Systems Manager) Parameter Store — a managed key-value configuration/secret storage service, a lighter-weight alternative to Secrets Manager. |
| **SSO** | Single Sign-On. |
| **TLS** | Transport Layer Security — the cryptographic protocol securing HTTP traffic as HTTPS (the modern successor to SSL). |
| **VNet** | Virtual Network — Azure's term for an isolated private network (the equivalent of an AWS VPC). |
| **VPC** | Virtual Private Cloud — AWS's term for an isolated private network. |
| **WAF** | Web Application Firewall — a filtering layer inspecting HTTP traffic for known attack patterns, typically deployed in front of a load balancer. |
| **X.509** | The standard format for public-key certificates, including the SAML IdP signing certificates referenced in §5. |
| **XSS** | Cross-Site Scripting — an attack class in which untrusted input is rendered as executable script in a victim's browser. |

---

## 17. References

This document synthesises and reorganises material already published within this repository, for an
integrator audience. Where a specific command, configuration value, or procedural detail is required,
consult the following source documents directly — they are the maintained, authoritative source, and
this guide should be treated as a derived summary of them rather than a replacement:

1. `DEPLOYMENT-NET-DOCKER.md` — .NET tier container deployment guide, including the per-cloud mapping
   tables and the full application-level security checklist this guide's §7/§10 summarise.
2. `DEPLOYMENT-AWS.md` — the complete, command-by-command AWS ECS Fargate + ALB reference deployment
   this guide's §12 case study is derived from.
3. `DEPLOYMENT-PHP.md` — the PHP/PostgreSQL tier's bare-metal deployment guide.
4. `DEPLOYMENT-MARIADB.md` — the PHP/MariaDB tier's deployment guide, including the shared-hosting
   account-provisioning procedure referenced in this guide's §3 and §9.1.
5. `CLAUDE.md` (this repository's own architecture reference) §4–§5 — the canonical description of
   this application's authentication, authorisation, and cross-tenant isolation implementation.
6. OASIS, *Security Assertion Markup Language (SAML) V2.0*, technical specification —
   <https://docs.oasis-open.org/security/saml/v2.0/>.
7. IETF RFC 7644, *System for Cross-domain Identity Management: Protocol (SCIM)* —
   <https://datatracker.ietf.org/doc/html/rfc7644>.
8. IETF RFC 7519, *JSON Web Token (JWT)* — <https://datatracker.ietf.org/doc/html/rfc7519>.
9. OWASP Foundation, *OWASP Secure Headers Project* (reference for the header set discussed in §10) —
   <https://owasp.org/www-project-secure-headers/>.

---

*This document, like `USER-GUIDE.md`, is intended to evolve alongside the application. It reflects
the architecture and controls in place as of this writing; re-verify any specific claim against the
source documents in §17 before relying on it for a compliance attestation or formal security review,
since those source documents — not this summary — are updated first when the underlying
implementation changes.*
