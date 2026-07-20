# Deployment Guide — .NET API + PostgreSQL + Web, as Docker Containers

This guide covers deploying the repo's **Docker Compose stack** — three containers (`db`, `api`,
`web`) built from `docker-compose.yml` — to infrastructure you control, and to AWS, Azure, or GCP.
This is the **.NET API tier**; the PHP tier has its own non-containerized guide,
[`DEPLOYMENT-PHP.md`](DEPLOYMENT-PHP.md). Pick one tier per deployment — don't run both against the
same database.

```
                    ┌───────────────────────────────────────┐
   HTTPS            │        TLS-terminating layer          │
  (browser) ───────► │  (LB / ingress / reverse proxy —      │
                    │   NOT provided by this compose file)  │
                    └───────────────┬───────────────────────┘
                                    │ plain HTTP, private network only
                            ┌───────▼────────┐   image: web/Dockerfile
                            │  web (nginx)    │   static index.html +
                            │  port 80        │   /api/*, /health proxy
                            └───────┬────────┘
                                    │ container-network only, no host port published
                            ┌───────▼────────┐   image: api/Enkl.Api/Dockerfile
                            │  api (.NET)     │   Kestrel :8080, runs as non-root "app" user
                            └───────┬────────┘
                                    │ container-network only, no host port published
                            ┌───────▼────────┐   image: postgres:16-alpine
                            │  db (Postgres)  │   named volume db-data
                            └────────────────┘
```

The three services and what each `Dockerfile`/`docker-compose.yml` actually does:

| Service | Image | Exposed | Notes |
|---|---|---|---|
| `db` | `postgres:16-alpine` | `127.0.0.1:5432` (host-loopback only, dev convenience) | Named volume `db-data`; healthcheck via `pg_isready` |
| `api` | built from `api/Enkl.Api/Dockerfile` (multi-stage: SDK build → `aspnet:10.0` runtime) | not published to the host at all | Runs as the image's built-in non-root `app` user; healthcheck hits its own `/health` |
| `web` | built from `web/Dockerfile` (multi-stage: `node:20-alpine` build → `nginx:alpine`) | `80:80` | Runs `npm run build`'s output (`dist/index.html`) + `web/nginx.conf`; only this service ever needs to be reachable from outside the deployment |

**`api` and `db` are never published to the host or any external network in the reference
compose file — only `web` is.** Preserve this in every environment below: `api`/`db` reachable only
from `web` (and from each other), never directly from the internet or from any other workload.

---

## 1. Configuration

All configuration is environment variables passed into the containers — no config files to edit.
`docker-compose.yml` reads these from a `.env` file in the repo root (standard Compose behavior) or
your shell environment.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `DB_PASSWORD` | **yes** | `db`, `api` | Compose fails to start with a clear error (`DB_PASSWORD must be set in .env`) if unset — there is no insecure default. Generate a long random value. |
| `JWT_SIGNING_KEY` | **yes** | `api` | Same hard-fail-if-unset guard. 32+ random characters — `openssl rand -base64 48`. |
| `PUBLIC_BASE_URL` | recommended | `api` | The browser-facing scheme+host (no trailing slash), e.g. `https://enkl.example.org`. Defaults to `http://localhost` if unset — **wrong for anything but local dev**, and required to be correct if you use SAML SSO (it's how the SP entity id/ACS URL and redirect URLs are built; `api`'s `Request.Scheme` can't be trusted since `web`'s nginx always proxies to it over plain HTTP internally regardless of what the browser used). |
| `ASPNETCORE_ENVIRONMENT` | | `api` | Defaults to `Production` in compose already — leave it. `Development` disables the exception-detail-hiding behavior and is for local `dotnet run` only. |

Never commit a real `.env` to version control (it's already the standard `.gitignore`'d pattern for
Compose projects — confirm your own copy stays out of git too). In every cloud target below, these
same four values move into that platform's secrets mechanism instead of a `.env` file.

`RunMigrationsOnStartup` (hardcoded `"true"` in the compose file) is not something you need to
change — see §6.

---

## 2. Build the images

```bash
docker compose build
```

Builds `enklapp-api` and `enklapp-web` from their Dockerfiles (`db` uses the public
`postgres:16-alpine` image directly, nothing to build). For any deployment beyond a single Docker
host, push both built images to a registry your target platform can pull from:

```bash
docker tag enklapp-api  <registry>/<namespace>/enkl-api:<tag>
docker tag enklapp-web  <registry>/<namespace>/enkl-web:<tag>
docker push <registry>/<namespace>/enkl-api:<tag>
docker push <registry>/<namespace>/enkl-web:<tag>
```

Rebuild and re-push both images after any application code change — there's no separate artifact
step; the image *is* the deployable unit for both the API and the frontend (`web`'s image bakes in
`dist/index.html` at build time, so a frontend-only change still requires rebuilding the `web`
image, not just editing a file on a running container).

---

## 3. Private / on-prem container environment

If you're deploying to infrastructure you fully control (your own Docker host, Swarm, or
Kubernetes cluster, on-prem or in a private cloud), the reference `docker-compose.yml` is close to
deployable as-is. The one thing it deliberately does **not** provide is TLS termination or a
`web` service reachable from anywhere but a trusted internal network — you must add one of:

- **Simplest**: put a reverse proxy (nginx, Caddy, Traefik, HAProxy) or your organisation's existing
  internal load balancer in front of the `web` container's port 80, terminating TLS there and
  forwarding plain HTTP to `web`. Caddy is worth considering here specifically for automatic
  certificate management if you have a real internal/public DNS name to issue a cert for.
- **On Kubernetes**: run the same three images as a Deployment (or separate Deployments) with a
  `Service`/`Ingress` in front of `web` only, and either an Ingress controller with TLS (cert-manager
  + Let's Encrypt, or your org's internal CA) or a TLS-terminating load balancer upstream of the
  Ingress. Keep `api` and `db` as `ClusterIP` services (never `NodePort`/`LoadBalancer`) so they stay
  unreachable from outside the cluster network, matching the compose file's own model exactly.
- **On Swarm**: an overlay network with `web` as the only service publishing a port (via an ingress
  network or a dedicated reverse-proxy service), `api`/`db` on an internal-only overlay network.

Postgres: the reference `db-data` named volume is fine for a single Docker host, but for anything
you actually depend on, either point `db` at an existing PostgreSQL instance your organisation
already operates and backs up (swap the `db` service for a plain connection string via
`ConnectionStrings__Default`, dropping the `db` service and its `depends_on` entries entirely), or
put the named volume on backed-up, redundant storage and set up your own `pg_dump`/WAL-archiving
schedule — nothing in this stack backs up the volume for you.

---

## 4. Public cloud deployment — common pattern

The same shape applies across AWS, Azure, and GCP; only the specific managed-service names differ.
Map the three Compose services onto:

1. **A container registry** (push the two built images here — see §2).
2. **A managed container runtime** for `api` and `web` (ECS Fargate, Azure Container Apps/AKS, Cloud
   Run/GKE — pick whichever your organisation already standardizes on; all three work).
3. **A managed PostgreSQL service** instead of the `db` container (RDS, Azure Database for
   PostgreSQL, Cloud SQL) — strongly recommended over running Postgres yourself in a container for
   anything beyond a dev/test environment: automated backups, point-in-time recovery, patching, and
   HA/failover come for free.
4. **A managed secrets store** for `DB_PASSWORD`/`JWT_SIGNING_KEY`/`PUBLIC_BASE_URL` (Secrets
   Manager/SSM Parameter Store, Key Vault, Secret Manager) injected as environment variables at
   container start — never baked into the image, never in plain task-definition/manifest text.
5. **A public-facing load balancer with TLS termination** in front of `web` only — `api` gets no
   public listener, no public IP, no public DNS record. Put it in a private subnet/VPC with no
   route to the internet gateway; the load balancer/ingress reaches it over the private network.
6. **Health checks wired to `GET /health`** on the `api` container/service (already exposed, already
   what the compose file's own healthcheck uses) and to `web`'s `/health` (proxied through to `api`)
   for the load balancer's own target-health checks.

### AWS

**A full step-by-step guide (actual `aws` CLI commands, not just this summary table) lives in
[`DEPLOYMENT-AWS.md`](DEPLOYMENT-AWS.md)** — read that instead of trying to derive the specifics from
this table alone. It also covers two AWS-specific gotchas not obvious from the table below: RDS Proxy
breaks this app's `LISTEN`/`NOTIFY`-based SSE stream (don't put one in front of the database), and
`web/nginx.conf` needs a `localhost`-vs-container-name edit if `web`/`api` run as sidecar containers
in one ECS task.

| Compose piece | AWS equivalent |
|---|---|
| Images | Amazon ECR (one repo per image) |
| `api`, `web` runtime | ECS Fargate (one service each), or EKS if you already run Kubernetes elsewhere |
| `db` | RDS for PostgreSQL (engine version 13+, 16 recommended) — Multi-AZ if you need HA |
| Secrets | AWS Secrets Manager or SSM Parameter Store (SecureString), referenced directly in the ECS task definition's `secrets` block so values never appear in plain task-definition JSON or CloudWatch logs |
| TLS + public entry | Application Load Balancer with an ACM certificate, listener on 443 forwarding to `web`'s target group only |
| Networking | `api`/`db` in private subnets with no route to an Internet Gateway (a NAT gateway is fine for outbound-only needs, e.g. pulling images); `web`'s ECS tasks in subnets reachable from the ALB; RDS security group allows inbound 5432 **only** from the `api` service's security group |
| Logs | CloudWatch Logs (ECS's default log driver) — route both `api` and `web` container stdout/stderr here |

### Azure

| Compose piece | Azure equivalent |
|---|---|
| Images | Azure Container Registry |
| `api`, `web` runtime | Azure Container Apps (simplest — built-in ingress, scaling, secret references) or AKS if you already run Kubernetes elsewhere |
| `db` | Azure Database for PostgreSQL – Flexible Server (version 13+, 16 recommended) |
| Secrets | Azure Key Vault, referenced via Container Apps' secret references / AKS's Secrets Store CSI driver — not plain environment values in the app manifest |
| TLS + public entry | Container Apps' built-in ingress (automatic TLS) if using Container Apps, or Application Gateway/Azure Front Door + AKS ingress-nginx otherwise |
| Networking | Put `api` and the database on an internal-only Container Apps environment / AKS private cluster; only `web`'s Container App has external ingress enabled. Flexible Server's firewall/VNet integration should allow inbound only from `api`'s subnet |
| Logs | Log Analytics / Container Apps' built-in log stream |

### Google Cloud Platform

| Compose piece | GCP equivalent |
|---|---|
| Images | Artifact Registry |
| `api`, `web` runtime | Cloud Run (two services) if you want a fully managed, scale-to-zero-capable option, or GKE if you already run Kubernetes elsewhere |
| `db` | Cloud SQL for PostgreSQL (version 13+, 16 recommended) |
| Secrets | Secret Manager, mounted as environment variables via Cloud Run's/GKE's native secret-injection — not plain env vars in the service YAML |
| TLS + public entry | Cloud Run's own HTTPS endpoint (automatic TLS) for `web`, or an external HTTP(S) Load Balancer in front if you need a custom domain with more control; `api`'s Cloud Run service should have **no** public ingress (`--ingress internal` / VPC-internal only) — reachable only from `web` via a serverless VPC connector |
| Networking | Cloud SQL reachable only via a private IP / VPC connector from `api`, never a public IP with an open authorized-network rule |
| Logs | Cloud Logging (automatic for both Cloud Run services) |

For any of the three, if you'd rather run Kubernetes than the serverless container options, the
shape is identical: `api`/`db` (or a managed DB, skipping the `db` Pod entirely) on internal-only
Services, `web` behind an Ingress with TLS, secrets via each cloud's Kubernetes-native secret
integration rather than plain `Secret` manifests checked into git.

---

## 5. Verify a fresh deployment

```bash
curl https://your-domain/health
# {"status":"ok"}
```

That's `web`'s nginx proxying through to `api`'s own `/health` — confirms the whole chain (LB → web
→ api → its DB connection check via the startup migration succeeding) is actually working, not just
that `web` itself is up.

In the browser: confirm the app loads, sign in or migrate a project in, and open two tabs to confirm
the SSE live-update stream works across them (edit a task in one, watch it appear in the other) —
this is the best end-to-end proof that your load balancer/ingress isn't buffering or timing out the
long-lived `/api/events/stream` connection. If it doesn't work, check that your LB/ingress config
carries over the same buffering-off + long-read-timeout settings `web/nginx.conf` already applies
internally (most managed load balancers need an explicit idle-timeout override for this path — the
default is usually far shorter than the hours this connection is meant to stay open).

---

## 6. Security best practices checklist

### Already built in (verify you haven't disabled or bypassed it)
- [ ] **Non-root containers**: `api` runs as the aspnet base image's built-in `app` user (not root)
      — don't override this with `USER root` or an unrestricted `securityContext` in any
      orchestrator manifest. `web` intentionally stays root at the *master* process only (needed to
      bind port 80); its worker processes still drop privilege internally the same way upstream
      nginx always does — this is expected, not a gap to "fix."
- [ ] **`api`/`db` never exposed externally**: nothing about the reference compose file, or any of
      the cloud mappings above, gives either a public IP, public DNS name, or LB listener. Don't add
      one for convenience during troubleshooting and forget to remove it.
- [ ] **JWTs**: HS256, issuer/audience checked, 1-minute clock-skew leeway, and a live
      **SecurityStamp** check on every authenticated request — a password change, org-admin toggle,
      or deactivation immediately invalidates that user's previously issued tokens, not just at the
      8-hour expiry. Don't put a caching/edge layer in front that could serve a stale auth decision.
- [ ] **MustChangePassword enforcement**: a fresh/reset account can only call the change-password
      endpoint until its password is changed; every other mutating request is rejected (reads still
      work). Nothing to configure — just don't build a workaround for it elsewhere.
- [ ] **Rate limiting**: a sliding-window limiter (10 requests/60s per client IP, `QueueLimit: 0` so
      it rejects outright rather than queuing) on login, SSO lookup/exchange, change-password, and
      anonymous-migration endpoints. **This is exactly why the networking rule above matters**: the
      partition key is `HttpContext.Connection.RemoteIpAddress`, recovered from `X-Forwarded-For`
      via `ForwardedHeadersMiddleware` — and this app's `Program.cs` deliberately clears
      `KnownProxies`/`KnownIPNetworks`, meaning it trusts *any* `X-Forwarded-For`/`X-Forwarded-Proto`
      header unconditionally. That's safe **only** because `api` is unreachable except through
      `web`'s nginx in the reference setup. If you ever expose `api` directly (skip this — see
      above), every client behind it would share one rate-limit bucket, or an attacker could forge
      the header entirely and dodge the limit outright.
- [ ] **CORS**: an empty default policy is registered (`AddCors(... AddDefaultPolicy(policy => {}))`)
      — no origin, method, or header is allowed by default, which is a safe no-op given the app is
      only ever called same-origin through `web`. Don't widen this to `AllowAnyOrigin()` without a
      specific reason and a matching review.
- [ ] **SAML replay protection & certificate validation**: every outgoing `AuthnRequest` ID is
      single-use; IdP signing certificates are validated for expiry and RSA key strength (≥2048
      bits) when saved. Nothing to configure beyond making sure `PUBLIC_BASE_URL` is correct.

### Your responsibility to configure correctly
- [ ] **TLS termination in front of `web`** — nothing in this stack does it (see the diagram note).
      Confirm your load balancer/ingress sets `X-Forwarded-Proto: https` and that nothing except it
      can reach `web` directly on plain HTTP from outside your trusted network.
- [ ] **Real, unique `DB_PASSWORD`/`JWT_SIGNING_KEY`**, sourced from your platform's secrets manager,
      never checked into the image or a manifest in git.
- [ ] **Managed database over a containerized one** for anything beyond dev/test — see §4's
      per-cloud tables. If you do run Postgres in a container anyway, put its volume on
      backed-up, redundant storage and script your own backup/restore testing.
- [ ] **Network segmentation** enforced at the platform level (private subnets/VNets, security
      groups/NSGs, VPC firewall rules) restricting the database to accept connections only from
      `api`, and `api` to accept connections only from `web` — don't rely on the application alone.
- [ ] **`PUBLIC_BASE_URL` set correctly** for your real domain if you use SAML SSO — a mismatch
      breaks the SP entity id/ACS URL your IdP expects.
- [ ] **Image provenance**: pull `postgres:16-alpine`/base .NET/nginx/node images from a source you
      trust and keep them patched — rebuild and redeploy on a schedule even without an app code
      change, to pick up base-image security patches (there's no auto-update mechanism here).
- [ ] **Log aggregation**: route both containers' stdout/stderr to your platform's log service (all
      three cloud mappings above do this by default) — `api` logs migration application and
      unhandled-exception details (redacted of message content in production) that you'll want
      during an incident.
- [ ] **Don't run this tier and the PHP tier against the same database simultaneously** in
      production unless you've deliberately verified every request path stays in lockstep between
      them — treat it as one tier or the other per deployment, not a mixed pool.

### Explicitly out of scope for this application (handle at your layer if needed)
- CSRF protection — not applicable; bearer JWTs only, no cookies or server-side sessions.
- File upload virus scanning / storage — not applicable; no binary uploads anywhere in the app.
