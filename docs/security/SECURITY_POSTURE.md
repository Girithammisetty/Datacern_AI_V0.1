# Datacern Security Posture — Engineering Snapshot

**Purpose:** a factual, code-verified summary of security controls actually implemented
in this repository today, for use in technical POC conversations. Every claim below
cites the specific file(s) that implement it, so a technical buyer's engineer can
verify it directly against the source. Nothing here is asserted from a design doc or
roadmap — only from code, migrations, CI config, or a live-run test result.

**This is not a compliance attestation.** See "What's not yet true" below before
using this document with a regulated prospect.

---

## What's true today

### 1. Multi-tenant isolation — Postgres Row-Level Security

Every tenant-scoped table across the platform's services is protected by Postgres RLS
with `FORCE ROW LEVEL SECURITY`, which binds the table owner too (not just
non-superuser roles) — so even a misconfigured connection using an elevated role
cannot bypass the tenant policy. Confirmed via migrations in 12+ services, including:

- `services/case-service/migrations/000002_rls.up.sql` — `ENABLE`/`FORCE ROW LEVEL
  SECURITY` + `tenant_isolation` policy on `cases`, `case_events`, `outbox`, etc.
- `services/audit-service/migrations/000002_rls.up.sql`
- `services/identity-service/migrations/0002_rls.up.sql`
- `services/dataset-service/migrations/versions/0002_force_rls.py`
- `services/agent-runtime/migrations/versions/0001_initial.py` (line 234)
- `services/ai-gateway/migrations/versions/0002_force_rls_app_login.py`
- `services/chart-service/migrations/000002_rls.up.sql`
- `services/experiment-service/migrations/versions/0002_force_rls.py`
- `services/eval-service/migrations/versions/0001_initial.py` (line 235)
- `services/inference-service/migrations/versions/0001_initial.py` (line 237)
- `services/ingestion-service/migrations/versions/0001_initial.py` (line 224)
- `services/memory-service/migrations/versions/0002_force_rls_app_login.py`

The tenant boundary is set from the **verified JWT only, never from request input**:
each store layer opens a transaction and pins `app.tenant_id` via
`SELECT set_config('app.tenant_id', $1, true)` before any query runs — e.g.
`services/usage-service/internal/store/pg.go:34-42` (`withTenant`), with the same
pattern in `case-service`, `chart-service`, `notification-service`, `query-service`,
`rbac-service`, `realtime-hub`, and `tool-plane` stores. Cross-tenant admin paths
(outbox relay, reconciliation) explicitly switch to an audited `app.role='platform'`
context rather than silently bypassing RLS (`pg.go:44-53`).

### 2. Authorization — RBAC + OPA policy enforcement

Routes are gated by an `Authz.Allow()` call against an OPA sidecar, not by ad hoc
role checks in handler code. Pattern confirmed in
`services/usage-service/internal/api/middleware.go:113-140` (`RequireAction`):
every guarded action builds an `authz.Input{Subject, Action, Tenant}`, calls OPA, and
on denial emits a `security.permission_denied` audit event (`auditDenial`, line 142)
before returning 403. The same `RequireAction`/`authz.go` pattern exists independently
in `case-service`, `audit-service`, `notification-service`, `query-service`,
`rbac-service`, `identity-service`, `chart-service`, `realtime-hub`, and `tool-plane`
(each has its own `internal/authz/authz.go` + `authz_test.go`).
`deploy/services.yaml` shows every one of these services declares `opa` as a hard
dependency (`needs: [..., opa, ...]`), and `rbac-service/internal/integration/
opa_parity_test.go` tests that the in-process authorizer and the real OPA sidecar
agree. A 404 returned for a resource that exists under a different tenant is treated
as security-relevant and explicitly audited as `security.cross_tenant_denied`
(`middleware.go:154-167`), because RLS makes "doesn't exist" and "not yours"
indistinguishable by design.

### 3. Audit trail — immutable log + WORM export

`audit-service` maintains a per-tenant/per-day hash chain in ClickHouse
(`chain_hash`, `chain_seq` columns — `services/audit-service/internal/chstore/
chstore.go:114,169,300-307`) plus a real S3/MinIO WORM export path:
`services/audit-service/internal/worm/worm.go` writes sealed export batches under
**Object-Lock COMPLIANCE mode** with a configurable retention (default 7 years,
`worm.go:34,74-80`) — objects cannot be altered or deleted for the retention window,
even by the bucket root user. This is a real S3-API adapter against MinIO
(`worm.go:1-6` states explicitly "There is no in-memory mode in the runtime path").
Re-exports never overwrite an original; they write a new numbered revision
(`services/audit-service/RUNBOOK.md`, "Re-export / supplement" section). A documented
P1 procedure exists for chain-integrity violations (`POST /api/v1/audit/verify`
returning `valid:false`) in the same RUNBOOK.

### 4. Cross-tenant isolation — externally verified, not just asserted

A black-box HTTP probe (not a code-reading exercise) was run against a live stack
using real, narrow-scoped JWTs for two distinct pre-existing tenants:
`deploy/security/cross_tenant_authz_probe.py` (305 lines), documented in
`docs/initiatives/cross-tenant-authz-probe.md`. Live run result, 2026-07-23:
**18/18 probes passed, 0 failed**, across GET-by-id, LIST, and WRITE for
**case-service, dataset-service, and pipeline-orchestrator**, plus GET-by-id/LIST for
**audit-service** (no write probe — it's an immutable log). No tenant-B credential
could read, list, or write tenant-A's resources; a post-write regression check
confirmed rejected writes did not silently apply. This is repeatable on demand via
`make security-probe`.

**Coverage caveat (see also "not yet true" below):** the probe explicitly covers
**4 of 20+ tenant-scoped services** — case-service, dataset-service,
pipeline-orchestrator, audit-service — chosen as one representative of each of the
two service-implementation patterns (Go REST, Python/FastAPI). The remaining
16+ services (rbac-service, usage-service, notification-service, pack-service,
experiment-service, inference-service, memory-service, chart-service, etc.) are
**not yet covered** by this external probe, per the doc's own "Known limits /
deferred" section.

### 5. Encryption

- **At rest (AWS reference deployment):** RDS Postgres has `storage_encrypted = true`
  (`deploy/terraform/aws/rds.tf:72`); S3 buckets have default SSE-KMS encryption
  (`deploy/terraform/aws/s3.tf:40-49`, `sse_algorithm = "aws:kms"`); MSK/Kafka has a
  dedicated KMS key for SCRAM secrets (`deploy/terraform/aws/msk.tf:15-29`).
- **In transit / ingress TLS:** the Helm chart supports TLS termination at ingress
  (`deploy/helm/datacern/templates/ingress.yaml:28-31`, `tls:` block driven by
  `Values.ingress.tls`), but it is **empty/disabled by default** in
  `deploy/helm/datacern/values.yaml:240` (`tls: []`) — a deploying operator must
  supply a cert/secret to turn it on; it is not on out of the box.
- **Secrets management:** default backend is Vault (`deploy/terraform/aws/
  secrets_backend.tf:9-13`, "the default"), with optional AWS Secrets Manager + KMS
  asymmetric signing key adapters available per-cloud
  (`secrets_backend.tf`, mirrored in the `gcp`/`azure` variants) — off by default,
  opt-in via `SECRETS_BACKEND=aws`.

### 6. Authentication — JWT + real per-tenant BYO-OIDC

Every service verifies a bearer JWT before granting access
(`services/usage-service/internal/api/middleware.go:66-82`, `AuthMiddleware`, same
pattern platform-wide). Beyond a single shared IdP, tenants can register their own
OIDC provider: `services/identity-service/internal/domain/idp_config.go` defines
`TenantIdpConfig` (issuer, client ID, discovery URL) with validation that rejects
non-HTTPS issuers except localhost (lines 24-53). `token_oidc.go` implements the real
login flow: it reads the (unverified) `iss` claim only to **route** to the tenant's
registered config, then verifies signature/issuer/audience against that IdP's own
JWKS — a forged `iss` cannot bypass this because the forged token still won't
validate against the real IdP's keys (`token_oidc.go:19-36`, comments explicit about
this threat model). This is real, working code, not a stub — confirmed no `TODO`/stub
markers in either file.

### 7. Automated security scanning in CI

`.github/workflows/security-scan.yml` runs on every PR to `main`, every push to
`main`, and a weekly full sweep (Monday 05:00 UTC), with findings gating merges at
HIGH severity and landing as SARIF in the GitHub Security tab:
- **semgrep** — Go/Python/TS security rulesets + secrets detection (`p/security-audit`, `p/secrets`)
- **gosec** — every Go module, `-severity high`, SQLi/weak-crypto/command-injection rules enforced (some integer-conversion/SSRF-taint rules excluded, each individually justified in the workflow's comments)
- **bandit** — all Python sources, `--severity-level high`
- **trivy** — dependency/CVE scan, HIGH/CRITICAL, fails the build on any finding
- **gitleaks** — full-history secrets scan on every PR

A local equivalent (`security/run_baseline_scan.sh`) runs the same tools for
pre-push checks, per the workflow's header comment.

---

## What's not yet true — do not claim these

- **No SOC 2, HITRUST, or ISO 27001 certification.** Not started. Internal docs
  (`docs/DATACERN_PARTNER_BRIEFING.md:57,88`, `docs/DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md:46`)
  explicitly flag SOC 2 as the #1 blocker to signing the first regulated customer,
  with a stated 6-12 month lead time not yet begun.
- **No third-party penetration test report exists.** The only pen-test-like
  artifact is the internal, engineering-run cross-tenant probe described above — it
  is not conducted by an independent third party and does not substitute for one.
- **No SAML support.** Grep across all services finds zero SAML implementation.
  Only OIDC (BYO-IdP) is supported for SSO.
- **SCIM provisioning is a stub, not a working feature.** Every route under
  `/scim/v2/*` returns `501 Not Implemented`
  (`services/identity-service/internal/api/server.go:254`,
  `handleNotImplementedF("SCIM 2.0 provisioning (IDN-FR-024)")`). Do not claim
  automated user provisioning/deprovisioning via SCIM.
- **The cross-tenant authorization probe covers only 4 of 20+ tenant-scoped
  services** (case-service, dataset-service, pipeline-orchestrator, audit-service).
  It has not been run against rbac-service, usage-service, notification-service,
  pack-service, experiment-service, inference-service, memory-service,
  chart-service, ai-gateway, ingestion-service, semantic-service, or the others.
  "Cross-tenant isolation holds" is verified for those 4 services specifically, not
  the platform as a whole.
- **No formal, company-wide incident-response plan is publicly documented.**
  What exists is narrower: per-service operational `RUNBOOK.md` files (5 found,
  in rbac-service, usage-service, chart-service, ai-gateway, audit-service) with
  failure-mode procedures, including one documented P1 procedure specifically for
  audit-chain integrity violations (`services/audit-service/RUNBOOK.md`,
  "Integrity-violation incident response" section). This is operational runbook
  material, not a security incident-response policy (breach notification, customer
  communication SLAs, legal/regulatory escalation) — no such policy document was
  found in this repository.
- **Ingress TLS is not enabled by default.** The Helm chart supports it but ships
  with an empty `tls: []` (`deploy/helm/datacern/values.yaml:240`); an operator must
  configure it per deployment.
- **No production cloud deployment has been run at customer scale.** Terraform for
  AWS/GCP/Azure exists and is referenced above for its encryption configuration, but
  the competitive-landscape doc (`docs/DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md:46`)
  states this IaC has not yet been applied to a live production environment; scale
  has been proven at demo volume only. Encryption-at-rest settings above describe
  what the Terraform *would* provision, not a currently running, audited production
  environment.

---

**This document is an internal engineering-verified snapshot of the codebase as of
2026-07-26** — every claim above was checked against source files, migrations, CI
config, or a specific live test-run result at the cited path. It is **not** a SOC 2
report, a penetration-test deliverable, an ISO 27001 statement of applicability, or
any other third-party compliance attestation, and must not be represented as one. It
should be refreshed whenever a cited control changes, and superseded the moment any
real certification or third-party audit exists.
