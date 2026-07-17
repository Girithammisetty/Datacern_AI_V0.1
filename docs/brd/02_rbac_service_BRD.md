# BRD 02 — rbac-service

**Service:** rbac-service · **Language:** Go · **Phase:** 1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply).
**V1 sources mined:** `config-service` (Rails) — workspaces, permission/content groups, Group→Role→Permission→Activity chain, `/activities/authorize`, `workspace_group_accesses` content ACLs.

---

## 1. Overview

### 1.1 Purpose
rbac-service owns all authorization data: workspaces, groups, memberships, roles, the platform action catalog, and content grants. It **materializes flattened permissions into Redis** so that every other service authorizes locally via its OPA sidecar in O(1) — replacing V1's synchronous `POST /activities/authorize` call (a 4–5-table JOIN per request that was the platform-wide throughput ceiling, with zero caching).

### 1.2 Business value
V1's central authorize endpoint made config-service's DB the ceiling for the entire platform. The projection model removes rbac from the request path entirely (target authz p99 ≤ 10ms) while making permission semantics *stricter*: V1 shipped with its content-ACL integrity validation commented out, no last-admin protection, and a URL-pattern matcher with a known over-matching bug — all corrected here.

### 1.3 In scope
Workspaces (lifecycle, visibility); permission groups & content groups; memberships; roles (system + custom); action catalog; content grants with levels; the `permissions_flat` Redis projection + invalidation; OPA data contract; admin/introspection APIs ("why can user X do Y").

### 1.4 Out of scope
Authentication/tokens (identity-service); OPA sidecar deployment (infra); agent toolset scoping (agent-registry — OPA intersects at decision time); row-level data filters (services' RLS).

---

## 2. Actors & user stories

- **US-1** As a Tenant Admin, I create workspaces, mark them public or private, and archive/restore them.
- **US-2** As a Workspace Admin (Use-case Admin), I manage which content groups access my workspace and what roles members hold.
- **US-3** As a Tenant Admin, I create custom roles from the action catalog and assign them to groups.
- **US-4** As a user, I see only workspaces that are public or that I belong to via a content group.
- **US-5** As any service, I get an allow/deny decision from my local OPA sidecar in ≤ 10ms without calling rbac-service.
- **US-6** As a Tenant Admin, I share a specific dashboard/dataset/query with a group at viewer/editor/owner level.
- **US-7** As an auditor, I ask "why can user X perform action Y on resource Z?" and get the full grant chain.
- **US-8** As the platform, I guarantee a permission change takes effect everywhere within 5 seconds.

---

## 3. Functional requirements

### Workspaces — RBC-FR-001..008
- **001 (M)** Workspace: `id (uuid), tenant_id, name, description, public (bool, default false), created_by, archived_at, timestamps`. Name unique **per tenant** (V1 was globally unique — corrected for multi-tenancy), case-insensitive.
- **002 (M)** Visibility rule (V1 `viewable_by`, preserved): a workspace is visible to a user iff it is `public`, OR the user is a member of a content group linked to it, OR the user is tenant admin.
- **003 (M)** Membership rule (V1 `assigned_to_workspace?`, preserved): a user is *assigned* to a workspace iff it is public or they belong to a linked content group. Assignment is a precondition for any workspace-scoped action.
- **004 (M)** Archive/restore (V1 semantics): `archived_at` timestamp; archived workspaces excluded from listings by default (`?archived=only|with` filters); archived workspaces reject all writes (`409 WORKSPACE_ARCHIVED`) but allow reads by previously-assigned users.
- **005 (M)** No workspace hard-delete in v1 API (V1 parity); archive is the terminal user-facing state. Purge is a retention job (≥ 1y archived + admin confirmation), which cascades grants and links.
- **006 (M)** Default workspace: provisioning seeds one public workspace named `Default use case` (V1 name preserved for migration compatibility) per tenant.
- **007 (S)** Workspace metadata: icon/color, tags (searchable).
- **008 (M)** Every workspace change emits events (`workspace.created|updated|archived|restored`).

### Groups & membership — RBC-FR-010..017
- **010 (M)** Group: `id, tenant_id, name (unique per tenant per type — V1 had no uniqueness, corrected), description, group_type (permission|content), system (bool), meta {auto_generated}`. The two-kind model is preserved: **permission groups** carry roles; **content groups** carry workspace/data access.
- **011 (M)** Member: `(group_id, user_id)` **unique** (V1 allowed duplicates — corrected); users may belong to many groups of both kinds.
- **012 (M)** Content-group↔workspace links (`workspace_groups`): unique pair; deleting a group cascades links **and content grants** (V1 orphaned `workspace_group_accesses` rows — corrected with FK + cascade).
- **013 (M)** System groups: at tenant seed, one permission group per system role, named after the role (V1 seeding behavior preserved); system groups cannot be deleted or renamed; their role binding is immutable.
- **014 (M)** Auto-generated service groups (V1 `svc_auto_generated`): flagged, hidden from regular listings, manageable only via admin API.
- **015 (M)** **Last-admin protection** (new; V1 gap): removing the last member of the tenant-admin permission group, or the last owner-level grantee of a resource, is rejected `409 LAST_ADMIN` (super-admin override with reason, audited).
- **016 (M)** Bulk membership ops (add/remove ≤ 500 per call) with partial-failure report.
- **017 (S)** Group expiry: optional membership `expires_at` for temporary access.

### Roles & action catalog — RBC-FR-020..027
- **020 (M)** System roles (V1 catalog preserved, names kept for migration): `Admin` (tenant admin — bypasses action checks, still tenant-bound), `Use case Admin` (workspace admin), `IDO User`→`Data User`, `Model Builder`, `Data Integration User`, `Insights User`, `Insights Ad-Hoc User`, `Case Analyst`, `Case Manager`, `Case Executive`. Mapping table old→new names ships in the migration plan.
- **021 (M)** Custom roles: named sets of actions from the catalog; unique name per tenant; deletable only when unassigned.
- **022 (M)** **Action catalog** replaces V1's Activity URL+method rows. Actions are static, code-defined strings `<service>.<resource>.<verb>` registered by each service at deploy (idempotent registration API + CI-generated manifest). Verbs: `read, list, create, update, delete, execute, assign, approve, admin, export, share`. Canonical resources:
  - `identity`: tenant, user, service_account · `rbac`: workspace, group, role, grant
  - `ingestion`: connection, ingestion · `dataset`: dataset, profile, lineage
  - `query`: query, execution · `semantic`: model, measure, verified_query
  - `chart`: dashboard, chart · `case`: case, disposition, bulk
  - `pipeline`: template, run · `experiment`: experiment, run, model · `inference`: job, schedule
  - `ai`: agent_session, proposal, memory, budget · `usage`: report, budget · `audit`: log
  Each action declares `workspace_scoped (bool)` — preserving V1's `workspace_dependent` semantics: workspace-scoped actions require a workspace context and assignment (RBC-FR-003); tenant-scoped actions must not carry one. **This retires V1's `{param}` URL-pattern LIKE matching and its over-match bug entirely** — services check named actions, never URLs.
- **023 (M)** Role→action bindings versioned; changes emit `role.updated` with diff.
- **024 (M)** Default role→action matrix for system roles ships as reviewed seed data (derived from V1 role/permission intent; documented in `seed/roles_actions.yaml` with one row per binding).
- **025 (C)** Role templates cloneable across workspaces.

### Content grants — RBC-FR-030..035
- **030 (M)** ContentGrant: `id, tenant_id, workspace_id, resource_urn, subject {group|user}, level (viewer|editor|owner)`, unique (workspace, resource_urn, subject). **Levels are new** (V1 had none): `viewer` ⊂ `editor` ⊂ `owner`; level→verb mapping is fixed platform-wide (viewer: read/list/export; editor: +update/execute/share-viewer; owner: +delete/share-any/admin).
- **031 (M)** **Integrity rule enforced** (V1 had it commented out): a grant's group must be linked to the grant's workspace; violations `422 GROUP_NOT_IN_WORKSPACE`. Enforced at write AND by a nightly consistency sweep (repairs + alerts).
- **032 (M)** Resource creator gets an implicit `owner` grant at creation (services emit `*.created` events; rbac materializes the implicit grant).
- **033 (M)** Grants are URN-based (master §2.2-013) and service-agnostic; services never store their own ACL tables.
- **034 (M)** `GET /grants?resource_urn=` returns effective access list (direct + via groups + implicit) with provenance.
- **035 (S)** Public-link sharing (viewer, expiring token) — Could for v1, flag-gated.

### Projection: permissions_flat — RBC-FR-040..048
- **040 (M)** rbac-service maintains a **Redis projection** consumed by OPA sidecars:
  - `perm:{tenant}:{user}:actions` → SET of allowed tenant-scoped actions
  - `perm:{tenant}:{user}:ws:{workspace}` → SET of allowed workspace-scoped actions for that workspace (∅ ⇒ not assigned)
  - `perm:{tenant}:{user}:res:{urn_hash}` → grant level for explicitly-granted resources
  - `perm:{tenant}:{user}:flags` → `{admin: bool, ws_admin: [workspace_ids]}`
  Values carry `version` + `computed_at`.
- **041 (M)** Flattening algorithm (per user): union over permission-group memberships → roles → actions; intersect workspace-scoped actions with assigned workspaces (RBC-FR-003); overlay resource grants (level→verbs); admin flag short-circuits (tenant-bound). Deny-by-default; **no negative grants** (V1 parity — additive model only).
- **042 (M)** Invalidation: every mutation (membership, role binding, grant, workspace link, archive) marks affected users dirty (transactional outbox) → recompute worker rebuilds their keys → Redis pub/sub `perm.invalidate {tenant, users[]}` notifies OPA caches. **End-to-end staleness ≤ 5s p99**; measured and alerted.
- **043 (M)** Full rebuild: per-tenant rebuild command (admin API + scheduled weekly verification comparing sampled projection entries against SQL ground truth; drift > 0 alerts).
- **044 (M)** OPA decision contract (input → decision): `{subject {id, typ, obo_sub?, scopes?}, action, resource_urn, workspace_id?, tenant}` → OPA resolves: for `typ=agent_obo`, allow iff **user projection allows** AND **action ∈ token scopes** (intersection rule); for `typ=agent_autonomous`, allow iff action ∈ scopes AND tenant enablement flag present; else user path. Policy bundle is versioned and integration-tested in this repo.
- **045 (M)** Cold-start / Redis-miss behavior: OPA falls back to a synchronous `POST /authz/check` (this service, SQL ground truth, p99 100ms) and warms the key; sustained fallback rate > 0.1% alerts.
- **046 (M)** `POST /authz/explain {user, action, resource_urn?, workspace_id?}` → full decision chain (groups → roles → actions; grants; flags) for US-7.
- **047 (M)** Projection entries TTL 24h (self-healing) with refresh-on-read < 1h remaining.
- **048 (M)** Multi-instance recompute workers are idempotent and ordered per user (per-user mutex; last-writer-wins on version).

## 4. Domain model & data

| Table | Key columns | Notes |
|---|---|---|
| `workspaces` | tenant_id, name, public, archived_at | uq (tenant_id, lower(name)) |
| `groups` | tenant_id, name, group_type, system, meta jsonb(≤4KB) | uq (tenant_id, group_type, lower(name)) |
| `members` | group_id FK, user_id, expires_at | uq (group_id, user_id) |
| `workspace_groups` | workspace_id FK, group_id FK | uq pair; cascade from both |
| `roles` | tenant_id (null = system), name, system | uq (tenant_id, lower(name)) |
| `role_actions` | role_id FK, action | uq pair; action validated against catalog |
| `group_roles` | group_id FK, role_id FK | uq pair; permission groups only (check) |
| `actions` | action (pk), service, resource, verb, workspace_scoped, description | registered at deploy |
| `content_grants` | tenant_id, workspace_id FK, resource_urn, subject_type, subject_id, level, implicit | uq (workspace_id, resource_urn, subject_type, subject_id); idx resource_urn |
| `projection_dirty` | tenant_id, user_id, reason, enqueued_at | work queue |
| `outbox` | standard | |

State machines: workspace `active ⇄ archived → purged`; no other lifecycle states. Retention: grants/groups live with tenant; `projection_dirty` transient.

## 5. API specification

Base `/api/v1`. Representative:

| Method & path | Action required | Notes |
|---|---|---|
| `POST/GET/PATCH /workspaces`, `POST /workspaces/:id/archive|restore` | `rbac.workspace.*` | visibility filtering per RBC-FR-002 |
| `POST/GET/PATCH/DELETE /groups` (+ `?type=permission|content`) | `rbac.group.*` | system groups immutable |
| `PUT/DELETE /groups/:id/members/:user_id`, `POST /groups/:id/members:bulk` | `rbac.group.assign` | V1 route semantics kept |
| `PUT/DELETE /workspaces/:id/content-groups/:group_id` | `rbac.workspace.update` | link/unlink |
| `POST/GET/PATCH/DELETE /roles`, `PUT /roles/:id/actions` | `rbac.role.*` | custom roles |
| `GET /actions` | any authenticated | catalog + workspace_scoped flags |
| `POST/GET/DELETE /grants` | `rbac.grant.*` or resource owner | RBC-FR-030..034 |
| `GET /grants?resource_urn=` | resource read | effective-access list |
| `POST /authz/check` | services (SPIFFE) | fallback path only |
| `POST /authz/explain` | tenant admin / auditor | US-7 |
| `POST /admin/projection/rebuild?tenant=` | super-admin | RBC-FR-043 |

Example — explain:
```json
POST /api/v1/authz/explain
{ "user_id": "u-1", "action": "chart.dashboard.update", "resource_urn": "wr:t-1:chart:dashboard/d-9", "workspace_id": "w-3" }
→ 200 { "allowed": true, "chain": [
  {"type":"membership","group":"Insights Editors","group_type":"permission"},
  {"type":"role","role":"Insights User","action":"chart.dashboard.update","workspace_scoped":true},
  {"type":"workspace_assignment","via_group":"Marketing Content","workspace":"w-3"},
  {"type":"grant","level":"editor","subject":"group:Marketing Content"} ] }
```

## 6. Events

**Emits** (`rbac.events.v1`): `workspace.created|updated|archived|restored|default_created`, `group.created|updated|deleted`, `member.added|removed|expired`, `role.created|updated|deleted`, `grant.created|updated|deleted`, `projection.rebuilt`, plus internal `perm.invalidate` on Redis pub/sub (not Kafka).

**Consumes:** `identity.events.v1`: `tenant.provisioned` → seed system roles/groups/default workspace; `user.created|activated` → warm projection; `user.deactivated|deleted` → drop projection keys, remove memberships (grace: memberships retained 30d for restore). All `*.events.v1` `*.created` events (dataset, query, dashboard, case, model…) → implicit owner grant (RBC-FR-032).

## 7. Business rules & edge cases

- **BR-1** Public workspace ⇒ every tenant user is assigned (V1 rule); making a workspace private triggers projection recompute for all tenant users (bulk-dirty, ≤ 5s SLA still applies at p99 for ≤ 10k users; larger tenants degrade to ≤ 30s with progress event).
- **BR-2** Deleting a content group cascades workspace links and content grants atomically; affected users recomputed (fixes V1 orphan-ACL defect).
- **BR-3** A group may link to multiple workspaces (V1 behavior preserved deliberately — cross-workspace teams); the grant-integrity rule (RBC-FR-031) keeps ACLs consistent per workspace.
- **BR-4** Role deletion blocked while any group binds it (`409 ROLE_IN_USE`).
- **BR-5** Action catalog is append-only per version; removing an action requires a deprecation window (two releases) during which it evaluates but logs `deprecated_action_used`.
- **BR-6** Agent OBO decisions never widen user permissions (intersection only); an agent with `write` scopes acting for a viewer-level user gets viewer-level outcomes.
- **BR-7** Tenant admin (`Admin` role) bypasses action checks but NOT tenant boundary, archived-workspace write block, or last-admin rule.
- **BR-8** Projection recompute is per-user and idempotent; a crashed worker's dirty rows are reclaimed after visibility timeout (at-least-once, versioned last-writer-wins).
- **BR-9** Redis loss ⇒ OPA fallback path carries traffic (RBC-FR-045) while rebuild repopulates; authz availability target unaffected (99.99%).
- **BR-10** Grants on deleted resources are garbage-collected by the nightly sweep on `*.deleted` events + orphan scan.
- **BR-11** Membership `expires_at` passing flips within the 5s invalidation SLA (Temporal timer, not cron scanning).
- **BR-12** All list endpoints filter by visibility server-side; no endpoint ever returns a workspace/group/grant the caller cannot see (tested per master §2.8-071 authz matrix).

## 8. Dependencies
Redis (projection + pub/sub), OPA sidecars (policy bundle shipped from this repo), Kafka (events in/out), identity-service (users/tenants/JWT claims), Temporal (membership expiry timers, nightly sweeps, weekly verification), all services (action registration at deploy; `*.created|deleted` events).

## 9. NFRs (deltas)
Projection staleness ≤ 5s p99 (alerting SLI). OPA local decision p99 ≤ 10ms. Fallback `/authz/check` p99 ≤ 100ms, ≥ 500 rps burst. Projection memory budget ≈ ≤ 2KB/user/workspace (set encoding monitored). Weekly verification drift = 0.

## 10. Acceptance criteria

- **AC-1** Given a user in a content group linked to workspace W, when they list workspaces, then W appears; when the link is removed, W disappears from listings and workspace-scoped actions deny within 5s.
- **AC-2** Given a public workspace, when any tenant user requests a workspace-scoped read action they hold via role, then allow — with no content-group membership.
- **AC-3** Given a workspace-scoped action requested without workspace context (or vice versa), then deny with `WORKSPACE_CONTEXT_REQUIRED`/`_FORBIDDEN` (V1 `workspace_dependent` semantics).
- **AC-4** Given a role's action set is edited, when 5s elapse, then all affected users' OPA decisions reflect the change (measured via injected canary user).
- **AC-5** Given a dashboard grant `viewer` to group G in workspace W where G is NOT linked to W, when created, then `422 GROUP_NOT_IN_WORKSPACE` (the V1 disabled validation, now enforced).
- **AC-6** Given the last member of the tenant Admin group, when removal is attempted, then `409 LAST_ADMIN`; super-admin override succeeds and writes an audit event with reason.
- **AC-7** Given an OBO token whose agent scopes exclude `case.case.assign`, when the underlying user could assign, then deny (intersection rule) and the explain endpoint shows `scope_excluded`.
- **AC-8** Given Redis flushed, when authz requests arrive, then decisions still succeed via fallback within 100ms p99 and keys re-warm; fallback rate alarm fires.
- **AC-9** Given duplicate `POST /groups/:id/members` for the same user, when repeated, then second call is a no-op `200` (idempotent) and exactly one membership row exists.
- **AC-10** Given a group deletion, when it completes, then zero orphan `content_grants` reference it (verified by sweep query in test).
- **AC-11** Given tenant A admin, when reading tenant B's groups, then `404` + cross-tenant audit event.
- **AC-12** Given the weekly verification job, when projection matches SQL ground truth for sampled users, then drift metric = 0; injected drift is detected and repaired.
- **AC-13** Given resource creation by user U, when `GET /grants?resource_urn=` is called, then U appears with `owner` (implicit) and provenance `implicit_creator`.
- **AC-14** Given an archived workspace, when any write action targets it, then `409 WORKSPACE_ARCHIVED`; reads by previously-assigned users still allow.

## 11. Out of scope / future
Negative/deny grants (explicitly rejected — additive model only); ABAC attribute conditions beyond workspace/tenant (OPA policy hooks reserved); public-link sharing (flag-gated Could); cross-tenant sharing (not planned); UI (ui-web BRD 22, admin module).
