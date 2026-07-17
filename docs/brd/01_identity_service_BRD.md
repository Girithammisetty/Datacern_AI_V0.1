# BRD 01 — identity-service

**Service:** identity-service · **Language:** Go · **Phase:** 0–1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply).
**V1 sources mined:** `platform-service` (Rails) — tenant lifecycle, GitLab/Terraform provisioning, service accounts, RSA key distribution, Cognito IdP handling.

---

## 1. Overview

### 1.1 Purpose
identity-service is the platform root of trust. It owns: tenant lifecycle and provisioning, user identities and invitations, service accounts, **agent principals and on-behalf-of (OBO) token issuance**, JWT signing-key distribution (JWKS), and cell/cloud assignment. It fronts Keycloak (OIDC) for human authentication and issues all platform JWTs.

### 1.2 Business value
Every other service trusts identity-service's tokens and tenant registry. Tenant onboarding time (target < 30 min fully automated) directly gates sales; provisioning reliability failures in V1 (tenants stuck `in_progress` with no retry/compensation) caused manual ops interventions — this rebuild makes provisioning a durable, compensable workflow.

### 1.3 In scope
Tenant CRUD + provisioning/deprovisioning workflows; user directory + invite flow; service accounts; agent principals + OBO token exchange; JWKS publication + key rotation; Keycloak realm management; cell assignment; platform-version registry for tenant deployments.

### 1.4 Out of scope
Authorization decisions (rbac-service); per-workspace membership (rbac-service); billing (usage-service); Keycloak itself (deployed infra); Terraform module contents (infra repo).

---

## 2. Actors & user stories

| Actor | Description |
|---|---|
| Platform Admin | Windrose operator; manages tenants, versions, cells |
| Tenant Owner | Customer admin named at tenant creation (`owner_email`) |
| Tenant User | Human user within a tenant |
| Service (workload) | Platform service authenticating via SPIFFE mTLS |
| Agent | AI agent principal acting OBO a user or autonomously |

- **US-1** As a Platform Admin, I create a tenant with a name, owner email, tier, cloud/cell preference, and resource quotas, and track provisioning progress in real time.
- **US-2** As a Platform Admin, I can retry a failed provisioning from the failed step without re-running completed steps, or roll it back cleanly.
- **US-3** As a Tenant Owner, I invite users by email; invitees activate via emailed link and SSO login.
- **US-4** As a Tenant Owner, I deactivate a user and their sessions/tokens become invalid within 5 minutes.
- **US-5** As a Service, I verify any platform JWT offline using published JWKS.
- **US-6** As the agent-runtime, I exchange a user JWT + agent version for a scoped-down OBO token whose permissions are the intersection of the user's grants and the agent's toolset.
- **US-7** As a Platform Admin, I suspend a tenant (infra retained, access blocked) and later reactivate or delete it, with an explicit grace period before destructive deletion.
- **US-8** As a Compliance Officer, I can list every active credential (users, service accounts, agent principals, API keys) per tenant with last-used timestamps.

---

## 3. Functional requirements

### Tenants — IDN-FR-001..019
- **001 (M)** Tenant entity: `id (uuidv7), name, display_name, owner_email, tier (pool|bridge|silo), cell_id, cloud (aws|azure|gcp), status, quotas {cpu, memory, processing_cpu, processing_memory}, platform_version, subdomain, k8s_namespace, schema_prefix, auto_upgrade (bool), created_by, timestamps`.
- **002 (M)** Name rules (V1-compatible): lowercased on create; `^[a-z][a-z0-9-]{2,38}$`; globally unique. `subdomain`, `k8s_namespace`, `schema_prefix` derive from sanitized name (`-`→`_` for schema) and are unique. Reserved names list (`admin`, `api`, `www`, `internal`, cell names) rejected with `VALIDATION_FAILED`.
- **003 (M)** Status enum and allowed transitions (state machine — **guards enforced**, unlike V1's unguarded enum bangs):

| From | To | Trigger |
|---|---|---|
| `draft` | `provisioning` | admin publishes |
| `provisioning` | `active` | workflow success |
| `provisioning` | `provision_failed` | workflow exhausted retries |
| `provision_failed` | `provisioning` | admin retry (resumes from failed step) |
| `provision_failed` | `deleting` | admin abort (runs compensation) |
| `active` | `suspended` | admin suspend (access blocked, infra retained — V1 `deactivated` semantics) |
| `suspended` | `active` | admin reactivate |
| `active`/`suspended` | `deleting` | admin delete (grace period, then destroy workflow) |
| `deleting` | `deleted` | destroy workflow success (record retained, soft-deleted) |

  Any other transition → `409 CONFLICT`.
- **004 (M)** Quotas default `cpu=4, memory=16Gi, processing_cpu=4, processing_memory=16Gi` (V1 defaults); admin-editable; validated against cell capacity before provisioning.
- **005 (M)** Default module set per tenant configurable at platform level (V1 mandatory services: data/config/UI equivalents). Module dependency graph (V1 `service_dependencies`) is honored: enabling a module auto-enables dependencies; the resolved set is recorded on the tenant.
- **006 (M)** **Provisioning is a Temporal workflow** with the following activities, each idempotent with per-step retry policy (max 5, exponential backoff, 30-min step timeout) and a **registered compensation**:
  1. `AssignCell` — pick cell by cloud+capacity; reserve quota. *Comp:* release reservation.
  2. `CreateKeycloakRealm` — realm-per-tenant, default clients, OIDC config. *Comp:* delete realm.
  3. `ProvisionInfra` — invoke Terraform runner (per-cloud module: namespace, DB schemas/roles, buckets, warehouse, DNS, per-tenant MLflow DB) and **await completion via callback/poll inside the activity**. *Comp:* terraform destroy.
  4. `CreateDatabases` — service schemas + RLS policies + seed rows. *Comp:* drop schemas.
  5. `RegisterServices` — register enabled modules + versions. *Comp:* deregister.
  6. `SeedDefaults` — owner user, default workspace request to rbac-service (event), notification templates. *Comp:* none (idempotent re-run safe).
  7. `Verify` — synthetic health probe of tenant endpoints. No comp; failure → workflow fails.
- **007 (M)** Workflow failure after retries → status `provision_failed`, all step results and errors queryable via `GET /tenants/:id/provisioning`. **No partial infra without a recorded compensation path** (designs out V1's abandoned-on-failure behavior).
- **008 (M)** Deletion: `DELETE /tenants/:id?mode=archive|destroy`. `archive` = suspend + retain (V1 `backup=true`); `destroy` starts a destroy workflow that (a) waits for Terraform destroy success **before** marking `deleted` (V1 fired-and-forgot), (b) enforces a 7-day grace period unless `force=true` by super-admin, (c) cascades: Keycloak realm, service accounts, agent principals, API keys, and emits `tenant.deleted` for downstream purge (memory-service right-to-erasure, audit retention exempt).
- **009 (S)** Platform version registry: versions listed from release system; tenants pin a version; `auto_upgrade` tenants are upgraded by a scheduled workflow honoring a maintenance window (V1 auto-devops, now with per-tenant window instead of global cron).
- **010 (M)** Provisioning progress events (`tenant.provision_step_completed`) stream to UI via realtime-hub.
- **011 (C)** Tenant export: metadata bundle (JSON) for migration/support.

### Users — IDN-FR-020..029
- **020 (M)** User entity: `id (uuid), tenant_id, email (unique per tenant, RFC 5322-validated — V1 had no validation), full_name, status (invited|active|deactivated), idp_subject (Keycloak sub, unique), last_login_at, timestamps`.
- **021 (M)** Invite flow: `POST /users/invite {email, full_name?, groups?}` → creates `invited` user + Keycloak user (temp-password/passwordless flow) → emits `user.invited` (notification-service sends email with activation link, 7-day expiry, resendable). First successful SSO login flips to `active`, links `idp_subject`, emits `user.activated`.
- **022 (M)** Deactivation: sets status, disables Keycloak user, revokes refresh sessions; access tokens expire naturally within 5 min (JWT TTL). Deactivated users are excluded from OBO issuance immediately (issuer check).
- **023 (M)** No hard user deletion while referenced; `DELETE` soft-deletes and emits `user.deleted` (memory/RAG erasure cascade — see memory-service BRD).
- **024 (S)** SCIM 2.0 provisioning endpoint for enterprise IdP sync (silo tier).
- **025 (M)** Super-admin (platform staff) users live in a dedicated `platform` realm; they are distinct from tenant users; every super-admin action on a tenant is audited with `actor.scope=platform`.

### Service accounts & API keys — IDN-FR-030..036
- **030 (M)** Intra-platform service identity is **SPIFFE mTLS** (mesh-issued) — no DB records, no distributed private-key secrets (designs out V1's K8s-Secret RSA distribution).
- **031 (M)** Tenant-facing **API keys** (for customer integrations): `POST /service-accounts {name, scopes[]}` → returns key **once** (`wr_sa_<id>.<secret>`; secret stored as argon2id hash). Keys carry explicit scopes (action names per master §2.2-016) and optional expiry; max 20 per tenant.
- **032 (M)** API-key authentication is exchanged at the edge for a short-lived JWT (`typ=service`) — downstream services see only JWTs.
- **033 (M)** Key rotation: create-new + deprecate-old with overlap; revocation immediate (Redis denylist checked at edge, ≤5s propagation). Last-used tracking per key.
- **034 (M)** V1 bypasses are banned: no `IGNORE_SERVICE_TOKEN`-style env switch may exist; unauthenticated internal endpoints are prohibited (CI policy check).

### Agent principals & OBO tokens — IDN-FR-040..047
- **040 (M)** AgentPrincipal: `id, agent_id, agent_version, tenant_enablement, scopes[] (toolset-derived, synced from agent-registry via events), status`. Created/updated by agent-registry events, never manually.
- **041 (M)** **OBO exchange** `POST /token/obo {subject_token (user JWT), agent_id, agent_version, session_id}` → validates user active + agent version enabled for tenant → issues JWT: `typ=agent_obo`, `sub=agent:<id>@<version>`, `obo_sub=<user_id>`, `tenant_id`, `scopes = agent scopes` (final authorization = OPA intersects these with user grants at call time), TTL 5 min, `session_id` claim for trace correlation.
- **042 (M)** Autonomous token `POST /token/agent {agent_id, version, tenant_id}` — only callable by agent-runtime (SPIFFE-verified); `typ=agent_autonomous`; requires the agent version to have `autonomous_allowed=true` for that tenant.
- **043 (M)** OBO issuance is refused when: user deactivated, tenant suspended, agent version killed (kill-switch), or agent version's eval gate failing (flag from eval-service events). Refusal code `AGENT_DISABLED` / `PERMISSION_DENIED`.
- **044 (M)** Every issuance emits `token.obo_issued` (audit) with user, agent, session. Token issuance rate limit: 60/min per (user, agent).
- **045 (M)** **`alg=none` is rejected everywhere**; only RS256/ES256 accepted; CI lint bans unverified `jwt.decode` calls (this codifies the V1 chat-agent-service and platform-service defects out of existence).

### Keys & JWKS — IDN-FR-050..054
- **050 (M)** Platform signing keys: RSA-2048 minimum (prefer EC P-256), generated in Vault transit; private keys never leave Vault; identity-service signs via Vault API.
- **051 (M)** `GET /.well-known/jwks.json` (per tenant realm and platform) — cacheable, `Cache-Control: max-age=300`.
- **052 (M)** Rotation: new key published in JWKS ≥ 10 minutes before use (V1's overlap-window rule, formalized); old key retired only after `max token TTL + clock skew (60s)`. Scheduled quarterly + on-demand.
- **053 (M)** External IdP federation (silo tenants): per-tenant IdP configured in Keycloak; JWKS refresh handled by Keycloak (V1's hand-rolled Cognito/ELB fetchers are retired).

## 4. Domain model & data

Tables (`identity` DB; all with `tenant_id` where tenant-scoped, RLS per master §2.1; identity's own registry tables `tenants`, `cells`, `platform_versions` are platform-scoped — RLS exempt, super-admin only):

| Table | Key columns | Notes / indexes |
|---|---|---|
| `tenants` | name uq, subdomain uq, k8s_namespace uq, schema_prefix uq, status, cell_id FK, quotas jsonb(≤4KB), platform_version | idx: status, cell_id |
| `cells` | id, cloud, region, capacity jsonb, tenant_count | capacity checked on AssignCell |
| `tenant_modules` | tenant_id, module, version, enabled | uq (tenant_id, module) |
| `provisioning_runs` | tenant_id, workflow_id, step, status, error, started/finished | idx (tenant_id, started_at desc) |
| `users` | tenant_id, email, status, idp_subject uq, last_login_at | uq (tenant_id, lower(email)) |
| `invitations` | user_id, token_hash, expires_at, accepted_at | TTL cleanup job 30d |
| `service_accounts` | tenant_id, name, secret_hash, scopes[], expires_at, last_used_at, revoked_at | uq (tenant_id, name) |
| `agent_principals` | tenant_id, agent_id, agent_version, scopes[], autonomous_allowed, status | uq (tenant_id, agent_id, agent_version) |
| `signing_keys` | kid, vault_ref, alg, not_before, retired_at | platform-scoped |
| `outbox` | standard outbox (master §2.4-034) | |

Retention: `provisioning_runs` 2y; `invitations` 30d post-expiry; deleted tenants retained (soft) 7y for audit joins.

## 5. API specification

Base `/api/v1`. All per master §2.3. Representative set:

| Method & path | Auth | Notes |
|---|---|---|
| `POST /tenants` | super-admin | 202 + operation_id; body: name, owner_email, tier, cloud, quotas?, modules?, publish? |
| `GET /tenants` / `GET /tenants/:id` | super-admin | filters: status, cell, cloud |
| `PATCH /tenants/:id` | super-admin | quotas, display_name, auto_upgrade; quota change → resize workflow |
| `POST /tenants/:id/publish` `/suspend` `/reactivate` | super-admin | state-machine guarded |
| `POST /tenants/:id/provisioning/retry` | super-admin | resumes Temporal workflow from failed step |
| `GET /tenants/:id/provisioning` | super-admin | step-by-step status |
| `DELETE /tenants/:id?mode=` | super-admin | §IDN-FR-008 |
| `POST /users/invite`, `POST /invitations/:token/accept` | tenant admin / public+token | |
| `GET/PATCH /users`, `POST /users/:id/deactivate` | tenant admin | |
| `POST /service-accounts`, `POST /service-accounts/:id/rotate`, `DELETE …` | tenant admin | secret shown once |
| `POST /token/obo` | any authenticated user context | §IDN-FR-041 |
| `POST /token/agent` | agent-runtime (SPIFFE) | §IDN-FR-042 |
| `GET /.well-known/jwks.json` | public | per-realm |
| `GET /credentials?tenant=` | tenant admin | US-8 inventory |

Example — OBO exchange:
```json
POST /api/v1/token/obo
{ "subject_token": "<user JWT>", "agent_id": "analytics", "agent_version": "v14", "session_id": "s-01H..." }
→ 200 { "access_token": "<JWT typ=agent_obo>", "expires_in": 300 }
→ 403 { "error": { "code": "AGENT_DISABLED", "message": "agent version killed for tenant", "trace_id": "..." } }
```

## 6. Events

**Emits** (`identity.events.v1`): `tenant.created|published|provision_step_completed|provisioned|provision_failed|suspended|reactivated|deletion_started|deleted`, `user.invited|activated|updated|deactivated|deleted`, `service_account.created|rotated|revoked`, `agent_principal.synced`, `token.obo_issued` (high-volume; sampled to audit at 100%, to metrics at 1%), `signing_key.rotated`.

**Consumes:** `agent.events.v1: agent_version.published|killed|eval_gate_changed` → sync `agent_principals`; `rbac.events.v1: workspace.default_created` (provisioning step 6 confirmation); `usage.events.v1: budget.exhausted (scope=tenant, meter=llm_*)` → no action here (ai-gateway enforces) but recorded on tenant health.

## 7. Business rules & edge cases

- **BR-1** Tenant name collision (incl. derived namespace/schema/subdomain) → reject at validation; no partial creation (single transaction, V1 parity).
- **BR-2** Concurrent provisioning attempts for one tenant: Temporal workflow ID = `provision-<tenant_id>` → duplicate starts rejected (`409`).
- **BR-3** Cell capacity insufficient at AssignCell → workflow fails fast with `CELL_CAPACITY`; admin may target another cell explicitly.
- **BR-4** Suspend blocks all token issuance (user login, API key exchange, OBO) within 5 min; in-flight JWTs die at TTL. Data and infra untouched.
- **BR-5** Reactivation after suspend does not re-run provisioning; a `Verify` probe runs first and reports drift.
- **BR-6** Terraform destroy failure during deletion → tenant stays `deleting`, alert raised, retry available; record never flips to `deleted` on failure (fixes V1 destroy-without-confirmation).
- **BR-7** Owner email must belong to an invited-or-active user before tenant flips `active` (seed step creates the invite).
- **BR-8** Clock skew tolerance 60s on all token validation.
- **BR-9** A tenant's last admin user cannot be deactivated (checked via rbac-service projection; overridable only by super-admin with reason, audited). *(V1 had no such guard.)*
- **BR-10** OBO tokens are never refreshable; agents re-exchange per session window.
- **BR-11** API-key secrets: shown once; regeneration = new key; lost = rotate.
- **BR-12** All identity mutations emit outbox events in the same transaction (master §2.4-034); JWKS changes additionally bust the edge cache via pub/sub.

## 8. Dependencies
Keycloak (realms, OIDC), Vault (transit signing, secrets), Temporal (provisioning/deletion/upgrade workflows), Terraform runner (per-cloud modules — contract: input vars per V1 pipeline-variable list: identifier, schema, namespace, subdomain, quotas, cloud, version; output: state + endpoints), rbac-service (default workspace seed, last-admin check), notification-service (invites), agent-registry (principal sync), realtime-hub (provision progress), Redis (revocation denylist).

## 9. NFRs (deltas)
Token endpoints: p99 < 80ms, 99.99% availability (auth SLO). JWKS: p99 < 20ms (cached). Provisioning wall-clock target < 30 min p90. OBO issuance ≥ 500 rps/cell.

## 10. Acceptance criteria

- **AC-1** Given a valid tenant creation with `publish=true`, when the workflow completes, then status is `active`, all 7 steps show `succeeded`, and a synthetic login to the tenant succeeds.
- **AC-2** Given step 3 (ProvisionInfra) fails 5 times, when the workflow exhausts retries, then status is `provision_failed`, steps 1–2 remain recorded, and no unmanaged infra exists (compensation log verified).
- **AC-3** Given a `provision_failed` tenant, when admin retries, then execution resumes at step 3 and steps 1–2 are not re-executed (idempotency markers).
- **AC-4** Given a duplicate tenant name differing only by case, when created, then `422 VALIDATION_FAILED` and no records exist.
- **AC-5** Given an invited user with an expired invitation, when they accept, then `410` with a resend hint; when re-invited, the old token is invalidated.
- **AC-6** Given a deactivated user, when an OBO exchange names them as subject, then `403 PERMISSION_DENIED` within 5 min of deactivation.
- **AC-7** Given an agent version kill-switch event, when OBO exchange is attempted for it, then `403 AGENT_DISABLED` within 5 s of the event.
- **AC-8** Given a signing-key rotation, when tokens signed with the old key are presented during the overlap window, then they verify; after retirement, they fail with `401`.
- **AC-9** Given tenant deletion with `mode=destroy`, when Terraform destroy has not succeeded, then tenant remains `deleting` and is never reported `deleted`.
- **AC-10** Given a suspended tenant, when any user or API key attempts login/exchange, then `403 TENANT_SUSPENDED` and an audit event exists.
- **AC-11** Given an API key presented after revocation, when used at the edge, then rejected within 5 s (denylist propagation).
- **AC-12** Given tenant A's admin token, when calling `GET /tenants/:idB` (tenant B), then `404` and `security.cross_tenant_denied` audit event (master §2.1-003).
- **AC-13** Given a token with `alg=none` or an unsigned context header, when presented to any endpoint, then `401` — verified by contract test.
- **AC-14** Given 60 OBO exchanges in one minute for one (user, agent), when the 61st arrives, then `429 RATE_LIMITED` with `Retry-After`.

## 11. Out of scope / future
SCIM (S, silo tier follow-up); multi-cell tenant mobility (cell migration tooling — Phase 5 program); passwordless/WebAuthn policies (Keycloak config, not service logic); customer-managed encryption keys; per-tenant token TTL overrides.
