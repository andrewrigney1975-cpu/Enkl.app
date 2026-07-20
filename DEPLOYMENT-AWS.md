# Deployment Guide — .NET API + PostgreSQL on AWS

This is the **AWS-specific, step-by-step** companion to
[`DEPLOYMENT-NET-DOCKER.md`](DEPLOYMENT-NET-DOCKER.md), which covers the .NET tier's Docker Compose
stack (`db`+`api`+`web`) in general/multi-cloud terms. That doc's §4 "AWS" table is the summary;
this doc is the actual `aws` CLI commands to get there. Read `DEPLOYMENT-NET-DOCKER.md` first for the
*why* behind the architecture (non-root containers, `api`/`db` never public, rate-limiter/JWT
security notes) — this doc assumes that context and doesn't repeat it.

**Scope**: the .NET API tier (`api/Enkl.Api`) + PostgreSQL only — not the PHP or MariaDB tiers (they
have their own bare-metal `DEPLOYMENT-PHP.md`/`DEPLOYMENT-MARIADB.md` guides, not AWS-specific).

```
                          Route 53 (your domain)
                                  │
                          ACM certificate (443)
                                  │
                    ┌─────────────▼──────────────┐
                    │   Application Load Balancer │  public subnets
                    │   443 → target group "web"  │
                    └─────────────┬──────────────┘
                                  │ plain HTTP, private subnets only
                    ┌─────────────▼──────────────┐
                    │   ECS Fargate service        │
                    │   one task, two containers:  │
                    │   ┌──────────┐ ┌───────────┐ │
                    │   │ web:80   │→│ api:8080  │ │  same task = same
                    │   │ (nginx)  │ │ (Kestrel) │ │  network namespace,
                    │   └──────────┘ └───────────┘ │  talk via localhost
                    └─────────────┬───────────────┘
                                  │ port 5432, private subnets only
                    ┌─────────────▼──────────────┐
                    │   RDS for PostgreSQL 16      │
                    │   (no RDS Proxy — see §2)    │
                    └──────────────────────────────┘
```

**Why one task with two sidecar containers, not two separate ECS services**: it's the closest
1:1 mapping to the reference `docker-compose.yml` (same two containers, same relationship), and it's
the least new infrastructure to stand up. The real trade-off: `web` and `api` then scale together
(same task count), and — the one genuine code-level adaptation this guide requires — **containers in
the same Fargate task talk to each other over `localhost`, not by container/service name**, unlike
Compose's bridge-network DNS. `web/nginx.conf`'s `proxy_pass http://api:8080/...` lines need an
AWS-specific variant pointed at `http://localhost:8080/...` instead — see §3. If you later need `web`
and `api` to scale independently, split them into two ECS services behind ECS Service Connect (gives
you `api`-by-name DNS again) and drop the localhost variant; not needed for a first deployment.

All commands below assume the AWS CLI v2, already `aws configure`d against the target account, and
`REGION`/`ACCOUNT_ID` shell variables set once:

```bash
export REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

---

## 1. Networking (VPC, subnets, security groups)

If your account already has a suitable VPC, skip to the security groups. Otherwise, a minimal
2-AZ setup (2 public subnets for the ALB, 2 private subnets for ECS tasks and RDS):

```bash
VPC_ID=$(aws ec2 create-vpc --cidr-block 10.20.0.0/16 \
  --query 'Vpc.VpcId' --output text)
aws ec2 create-tags --resources $VPC_ID --tags Key=Name,Value=enkl-vpc

# Two public subnets (ALB) + two private subnets (ECS, RDS) across two AZs
AZ1=${REGION}a; AZ2=${REGION}b
PUB1=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.20.0.0/24 --availability-zone $AZ1 --query 'Subnet.SubnetId' --output text)
PUB2=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.20.1.0/24 --availability-zone $AZ2 --query 'Subnet.SubnetId' --output text)
PRIV1=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.20.10.0/24 --availability-zone $AZ1 --query 'Subnet.SubnetId' --output text)
PRIV2=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.20.11.0/24 --availability-zone $AZ2 --query 'Subnet.SubnetId' --output text)

IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID

RTB_PUB=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id $RTB_PUB --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID >/dev/null
aws ec2 associate-route-table --route-table-id $RTB_PUB --subnet-id $PUB1 >/dev/null
aws ec2 associate-route-table --route-table-id $RTB_PUB --subnet-id $PUB2 >/dev/null
aws ec2 modify-subnet-attribute --subnet-id $PUB1 --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id $PUB2 --map-public-ip-on-launch

# NAT gateway so private-subnet ECS tasks can still pull images / call out (RDS itself needs no
# internet route at all — this is purely for the ECS tasks' own outbound needs).
EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
NAT_ID=$(aws ec2 create-nat-gateway --subnet-id $PUB1 --allocation-id $EIP_ALLOC --query 'NatGateway.NatGatewayId' --output text)
aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT_ID
RTB_PRIV=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id $RTB_PRIV --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT_ID >/dev/null
aws ec2 associate-route-table --route-table-id $RTB_PRIV --subnet-id $PRIV1 >/dev/null
aws ec2 associate-route-table --route-table-id $RTB_PRIV --subnet-id $PRIV2 >/dev/null
```

Security groups — three, matching the compose file's own "only `web` is reachable" model exactly:

```bash
SG_ALB=$(aws ec2 create-security-group --group-name enkl-alb-sg --description "ALB - public 443" --vpc-id $VPC_ID --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ALB --protocol tcp --port 443 --cidr 0.0.0.0/0

SG_ECS=$(aws ec2 create-security-group --group-name enkl-ecs-sg --description "ECS task (web+api sidecar)" --vpc-id $VPC_ID --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ECS --protocol tcp --port 80 --source-group $SG_ALB

SG_RDS=$(aws ec2 create-security-group --group-name enkl-rds-sg --description "RDS Postgres" --vpc-id $VPC_ID --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_RDS --protocol tcp --port 5432 --source-group $SG_ECS
```

Note there is **no rule anywhere admitting inbound traffic to port 8080** (the `api` container) from
outside the task itself — the ECS security group only opens port 80 (nginx), matching
`docker-compose.yml`'s own "`api` publishes no host port at all" model.

---

## 2. RDS for PostgreSQL

```bash
DB_SUBNET_GROUP=enkl-db-subnets
aws rds create-db-subnet-group --db-subnet-group-name $DB_SUBNET_GROUP \
  --subnet-ids $PRIV1 $PRIV2 --db-subnet-group-description "Enkl RDS - private subnets only"

DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
aws rds create-db-instance \
  --db-instance-identifier enkl-postgres \
  --engine postgres --engine-version 16 \
  --db-instance-class db.t4g.medium \
  --allocated-storage 50 --storage-type gp3 \
  --master-username enkl_app --master-user-password "$DB_PASSWORD" \
  --db-name enkl \
  --vpc-security-group-ids $SG_RDS \
  --db-subnet-group-name $DB_SUBNET_GROUP \
  --no-publicly-accessible \
  --backup-retention-period 7 \
  --multi-az   # drop this flag for a cheaper single-AZ dev/staging instance

aws rds wait db-instance-available --db-instance-identifier enkl-postgres
DB_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier enkl-postgres \
  --query 'DBInstances[0].Endpoint.Address' --output text)
```

Two genuine gotchas specific to this app, not generic RDS advice:

- **Do not put RDS Proxy in front of this database.** `Services/SseBroadcaster.cs` uses Postgres's
  `LISTEN`/`NOTIFY` for the live-update SSE stream — RDS Proxy's connection pooling/multiplexing
  breaks `LISTEN`/`NOTIFY` semantics (a pooled connection can be handed to a different logical client
  mid-stream, silently dropping notifications). Connect the `api` container directly to the RDS
  endpoint.
- **Use the RDS master user directly as `api`'s DB user** (or grant a dedicated app user the
  `rds_superuser` role) rather than a narrowly-scoped user. Migration `20260717221238_AddSavedQueryApiExposure`
  runs `CREATE ROLE enkl_public_query ...` for the Public Query API feature — on RDS, `CREATE ROLE`
  requires the connecting user to hold `rds_superuser` (RDS's own bounded equivalent of Postgres
  superuser; the RDS master user has it by default). This is different from the `mariadb-api` tier's
  own shared-hosting story (see `DEPLOYMENT-MARIADB.md` §7.1) — RDS's master user having
  `rds_superuser` by default means this "just works" here with no migration split needed, unlike a
  commercial shared-hosting MySQL account.

---

## 3. Build and push images to ECR

```bash
aws ecr create-repository --repository-name enkl-api
aws ecr create-repository --repository-name enkl-web-aws

aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker build -t enkl-api ./api/Enkl.Api
docker tag enkl-api:latest $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/enkl-api:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/enkl-api:latest
```

**The `web` image needs one AWS-specific edit before building** — per this guide's own top-of-file
note, `web/nginx.conf`'s three `proxy_pass` directives target `http://api:8080/...`, which resolves
via Compose's bridge-network DNS and does **not** work for two containers sharing one Fargate task's
network namespace. Make an AWS variant (don't edit the original — it's still correct for Compose/
on-prem deployments per `DEPLOYMENT-NET-DOCKER.md`):

```bash
cp web/nginx.conf web/nginx.aws.conf
sed -i 's#http://api:8080#http://localhost:8080#g' web/nginx.aws.conf
```

```dockerfile
# web/Dockerfile.aws — identical to web/Dockerfile except the nginx.conf source file
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY build.js .
COPY src ./src
RUN mkdir -p dist && node build.js

FROM nginx:alpine
COPY --from=build /src/dist/index.html /usr/share/nginx/html/index.html
COPY web/nginx.aws.conf /etc/nginx/conf.d/default.conf
```

```bash
docker build -f web/Dockerfile.aws -t enkl-web-aws .
docker tag enkl-web-aws:latest $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/enkl-web-aws:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/enkl-web-aws:latest
```

Rebuild and re-push both images (the `api` one unchanged from the reference Dockerfile, the `web-aws`
one with this variant) after every application code change — same "the image is the deployable unit"
rule `DEPLOYMENT-NET-DOCKER.md` §2 already states.

---

## 4. Secrets in AWS Secrets Manager

```bash
JWT_SIGNING_KEY=$(openssl rand -base64 48)

aws secretsmanager create-secret --name enkl/db-password --secret-string "$DB_PASSWORD"
aws secretsmanager create-secret --name enkl/jwt-signing-key --secret-string "$JWT_SIGNING_KEY"

DB_PASSWORD_ARN=$(aws secretsmanager describe-secret --secret-id enkl/db-password --query ARN --output text)
JWT_ARN=$(aws secretsmanager describe-secret --secret-id enkl/jwt-signing-key --query ARN --output text)
```

These get referenced directly in the task definition's `secrets` block below — the actual values
never appear in the task definition JSON, CloudWatch Logs, or the ECS console.

---

## 5. ECS cluster, task definition, and service

```bash
aws ecs create-cluster --cluster-name enkl-cluster

# Execution role (pulls images, reads the two secrets above, writes logs) and task role (the
# container's own AWS permissions at runtime — this app calls no AWS APIs itself, so an empty/
# minimal task role is correct; don't over-grant it).
aws iam create-role --role-name enklEcsExecutionRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name enklEcsExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name enklEcsExecutionRole --policy-name enkl-secrets-read \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":[\"$DB_PASSWORD_ARN\",\"$JWT_ARN\"]}]}"
EXEC_ROLE_ARN=$(aws iam get-role --role-name enklEcsExecutionRole --query 'Role.Arn' --output text)

aws logs create-log-group --log-group-name /ecs/enkl
```

Task definition — the two-container sidecar pair. `api` needs no `portMappings` reachable from
outside the task (only `web`'s port 80 does, via the ALB), but Fargate's `awsvpc` mode still requires
declaring the container port so ECS's own health-check/log plumbing can see it; it is **not**
published anywhere external.

```json
{
  "family": "enkl-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "EXEC_ROLE_ARN_HERE",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/enkl-api:latest",
      "portMappings": [{ "containerPort": 8080 }],
      "essential": true,
      "environment": [
        { "name": "ConnectionStrings__PublicQuery", "value": "Host=DB_ENDPOINT_HERE;Database=enkl;Username=enkl_public_query;Password=enkl_public_query_dev_password" },
        { "name": "App__PublicBaseUrl", "value": "https://your-domain.example.org" },
        { "name": "RunMigrationsOnStartup", "value": "true" },
        { "name": "ASPNETCORE_URLS", "value": "http://+:8080" },
        { "name": "ASPNETCORE_ENVIRONMENT", "value": "Production" }
      ],
      "secrets": [
        { "name": "ConnectionStrings__Default", "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:enkl/db-connection-string" },
        { "name": "Jwt__SigningKey", "valueFrom": "JWT_ARN_HERE" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"],
        "interval": 15, "timeout": 5, "retries": 3, "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/enkl", "awslogs-region": "REGION_HERE", "awslogs-stream-prefix": "api" }
      }
    },
    {
      "name": "web",
      "image": "ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/enkl-web-aws:latest",
      "portMappings": [{ "containerPort": 80 }],
      "essential": true,
      "dependsOn": [{ "containerName": "api", "condition": "HEALTHY" }],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/enkl", "awslogs-region": "REGION_HERE", "awslogs-stream-prefix": "web" }
      }
    }
  ]
}
```

`ConnectionStrings__Default` is stored as its own secret (a full connection string, not just the
password) so the `DB_ENDPOINT`/username/database name never appear in plain task-definition JSON
either:

```bash
aws secretsmanager create-secret --name enkl/db-connection-string \
  --secret-string "Host=$DB_ENDPOINT;Database=enkl;Username=enkl_app;Password=$DB_PASSWORD"
aws iam put-role-policy --role-name enklEcsExecutionRole --policy-name enkl-secrets-read-2 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:enkl/db-connection-string*\"}]}"
```

`ConnectionStrings__PublicQuery`'s password is intentionally a literal baked into the migration's own
SQL (see `docker-compose.yml`'s own comment on this — it's not an independently-rotatable secret like
`DB_PASSWORD`), so it's fine as a plain environment value above, matching the reference compose file.

Register and run it:

```bash
aws ecs register-task-definition --cli-input-json file://task-def.json

aws elbv2 create-target-group --name enkl-web-tg --protocol HTTP --port 80 \
  --vpc-id $VPC_ID --target-type ip --health-check-path /health \
  --health-check-interval-seconds 15 --healthy-threshold-count 2
TG_ARN=$(aws elbv2 describe-target-groups --names enkl-web-tg --query 'TargetGroups[0].TargetGroupArn' --output text)

aws ecs create-service \
  --cluster enkl-cluster --service-name enkl-service \
  --task-definition enkl-api \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV1,$PRIV2],securityGroups=[$SG_ECS],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=web,containerPort=80" \
  --health-check-grace-period-seconds 60
```

`desired-count 2` gives you basic HA out of the box — recall from the earlier recommendation that
the ASP.NET Core in-memory rate limiter (`AddRateLimiter`, IP-partitioned) becomes per-instance once
you run more than one task, weakening (not breaking) that specific protection; that's a known,
accepted trade-off of horizontal scaling here, not a bug to fix in this guide.

---

## 6. Application Load Balancer, ACM, Route 53

```bash
ALB_ARN=$(aws elbv2 create-load-balancer --name enkl-alb --type application \
  --subnets $PUB1 $PUB2 --security-groups $SG_ALB \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

# ACM cert — request, then validate via DNS (add the returned CNAME to your zone) before it issues.
CERT_ARN=$(aws acm request-certificate --domain-name your-domain.example.org \
  --validation-method DNS --query CertificateArn --output text)
# ... add the DNS validation record, then: aws acm wait certificate-validated --certificate-arn $CERT_ARN

aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTPS --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN

# Bump the ALB's idle timeout well past nginx's own already-generous 1h SSE read-timeout setting
# (web/nginx.conf's /api/events/ location) — the ALB's own default (60s) would otherwise kill the
# live-update stream out from under nginx regardless of nginx's own config.
aws elbv2 modify-load-balancer-attributes --load-balancer-arn $ALB_ARN \
  --attributes Key=idle_timeout.timeout_seconds,Value=3600
```

Point your domain (Route 53 or wherever it's hosted) at the ALB's DNS name via an alias/CNAME record.
`App__PublicBaseUrl` in the task definition above must match this exact domain — it's how the SAML SP
entity id/ACS URL is built (see `DEPLOYMENT-NET-DOCKER.md`'s own note on why `api` can't infer this
from the request itself).

---

## 7. Verify a fresh deployment

```bash
curl https://your-domain.example.org/health
# {"status":"ok"}
```

Confirms ALB → `web` (nginx) → `api` (over `localhost:8080` inside the task) → its own DB connection
check via the startup migration having already succeeded (`RunMigrationsOnStartup=true`).

In the browser: load the app, sign in or migrate a project in, and open two tabs to confirm the SSE
live-update stream works across them — the single best end-to-end proof that the ALB's idle-timeout
override (§6) actually took effect, since a too-short timeout here silently drops the stream and
`live-updates.js` just reconnects every ~60s instead of staying open, which is easy to miss without
explicitly watching for it in the Network tab.

Also confirm in CloudWatch Logs (`/ecs/enkl`, both `api` and `web` log streams) that migrations
applied cleanly on first boot — look for the `api` container's own startup log line listing each
applied migration.

---

## 8. Security checklist (AWS-specific; see `DEPLOYMENT-NET-DOCKER.md` §6 for the application-level checklist)

- [ ] **No security group admits inbound traffic to the `api` container's port 8080 from outside its
      own task** — only `SG_ECS` (port 80, from `SG_ALB` only) and `SG_RDS` (port 5432, from
      `SG_ECS` only) exist. Don't add a rule opening 8080 for "quick debugging" and forget to remove
      it.
- [ ] **RDS is `--no-publicly-accessible`**, in private subnets, with **no** route to an Internet
      Gateway — confirmed via `DB_SUBNET_GROUP` using `$PRIV1`/`$PRIV2` only.
- [ ] **No RDS Proxy** in front of this database (§2) — it would silently break the SSE stream, not
      loudly fail.
- [ ] **Secrets Manager, not plain task-definition environment values**, for `DB_PASSWORD`/the full
      connection string/`JWT_SIGNING_KEY` — confirmed via the `secrets` block, not `environment`, in
      the task definition.
- [ ] **ECS execution role scoped to exactly the two/three secrets it needs** (`iam put-role-policy`
      above lists specific secret ARNs, not `secretsmanager:GetSecretValue` on `*`) — don't widen this
      for convenience.
- [ ] **ALB listener is HTTPS-only (443) with a real ACM certificate** — no plain HTTP listener was
      created in §6; if you want to redirect bare HTTP for user convenience, add a port-80 listener
      whose *only* action is an HTTPS redirect, never a forward.
- [ ] **Task role stays minimal/empty** — this app calls no AWS APIs from within the container itself
      (no S3, no SES, nothing), so don't attach a broad task role "just in case."
- [ ] **CloudWatch Logs retention configured** — `aws logs create-log-group` above has no retention
      policy by default (logs kept forever); set one deliberately (`aws logs
      put-retention-policy --log-group-name /ecs/enkl --retention-in-days 90`, or whatever your
      compliance requirement is) rather than accumulating cost/data indefinitely by omission.
- [ ] **RDS automated backups enabled** (`--backup-retention-period 7` above) and actually test a
      restore at least once — a configured backup you've never restored from is unverified, not a
      real safety net.
- [ ] **Multi-AZ RDS for production** (`--multi-az` above) — the single-AZ shortcut is for
      dev/staging cost savings only.

### Explicitly out of scope for this application (handle at your layer if needed)
- CSRF protection — not applicable; bearer JWTs only, no cookies or server-side sessions.
- WAF / DDoS protection — nothing in this guide adds AWS WAF or Shield; consider attaching a WAF
  web ACL to the ALB if you expect to be a target, especially given the login/rate-limited endpoints'
  reliance on `X-Forwarded-For` (see `DEPLOYMENT-NET-DOCKER.md` §6's rate-limiting note) — a WAF rate
  rule in front is a reasonable defense-in-depth addition, not a replacement for the app's own limiter.

---

## 9. Cost-conscious variant for dev/staging

If this is a non-production environment, the cheapest path that still matches this architecture:
- `db.t4g.micro`, single-AZ (drop `--multi-az`), 20GB `gp3` — RDS's smallest Postgres-16-capable tier.
- `desired-count 1` on the ECS service (accept the rate-limiter/HA trade-offs noted above).
- Skip the NAT gateway (§1) if your account's default VPC already has one, or accept that ECS tasks
  in private subnets without one can't pull images/reach the internet at all — you'd then need
  `assignPublicIp=ENABLED` with public subnets for the ECS tasks instead (a real reduction in the
  "api never reachable from the internet" guarantee if the security group rules are ever loosened
  later, so only do this for a genuinely throwaway environment, not a long-lived staging environment
  treated as quasi-production).
