# Commercial Plane — plans, entitlements, trials

**Status:** design — 2026-07-25
**Related:** BRD 66, DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md §6 B1

---

## 1. Analysis

### 1a. Platform / product

Datacern currently has no object model that distinguishes a paying customer from any other tenant. Every gate in the platform — UI feature visibility, pack install, workspace/seat limits — is capability-based (RBAC), which answers "is this user allowed to do X" but never "does this tenant's contract include X". That collapses two orthogonal questions into one, and it blocks every revenue-facing motion the GTM roadmap depends on:

- **Plan differentiation** (design-partner vs pilot vs enterprise) has nowhere to live — `Tenant.Modules` is the only proto-entitlement, and it is a flat list of platform modules (`data`, `train`, `ui`, …), not a priced/plan-scoped set.
- **Trials** are not representable. A POC tenant looks identical to a paid one in the state machine; there is no expiry, no read-only degrade, no conversion event. Sales cannot start a clock, and the platform cannot enforce one.
- **Pack SKUs as an add-on pricing surface** (the roadmap's §6.4 pricing model) have no gate: pack-service authorizes install purely by RBAC capability (`pack.install.execute`), so a tenant without banking-aml entitlement can install it exactly like one that paid for it.
- **Upsell surfaces** (visible-but-locked features, "you're on trial — N days left") have no data source in ui-web today; FEATURE_GATES answers only "can this role do this", never "does this plan include this".

Without this object model, self-serve motions, billing exports (BRD 67), and the GTM roadmap's design-partner → pilot → enterprise expansion path are structurally impossible — there's nothing to check against. This initiative introduces that missing layer: a plan catalog, tenant plan assignment with effective entitlements, a trial lifecycle on the tenant state machine, and enforcement hooks in the three places that already gate today (pack-service install, BFF/ui-web, identity/rbac cap checks) so entitlements sit *before* RBAC as a commercial pre-check, never replacing it.

### 1b. Technical — current state in code

**Tenant state today.** The tenant lifecycle lives in `services/identity-service/internal/domain/tenant.go`. `TenantStatus` (`tenant.go:13-23`) has 7 states (`draft`, `provisioning`, `provision_failed`, `active`, `suspended`, `deleting`, `deleted`); `tenantTransitions` (`tenant.go:27-34`) is the guarded transition table, enforced by `CanTransition` (`tenant.go:37-44`) and applied via `Tenant.Transition` (`tenant.go:91-98`), which rejects invalid moves with `409 CONFLICT` (`EConflict`, `errors.go:61-63`). The `Tenant` struct (`tenant.go:65-86`) has no commercial fields today — no plan, no trial, no commercial state. This state machine is orthogonal to provisioning lifecycle by design (`provisioning.go` drives `draft→provisioning→active|provision_failed` via the 7-step engine at `provisioning.go:109-133`), which is exactly why CPL-FR-020 asks for commercial state as a **parallel** axis rather than new values threaded into `TenantStatus`.

**`Modules` today.** `Tenant.Modules []string` (`tenant.go:80`) is IDN-FR-005's resolved module set — platform-level services (`data`, `config`, `ui`, `train`, `infer`, `visualize`, `triage`), not commercial SKUs. It is computed by `ModuleGraph.Resolve` (`tenant.go:159-205`), a dependency-closure resolver over a small fixed graph (`DefaultModuleGraph`, `tenant.go:143-155`), and persisted separately from the `tenants` row via dedicated store methods `SetTenantModules` / `GetTenantModules` / `DeleteTenantModules` (`internal/domain/store.go:43-45`) into a `tenant_modules` table (RLS-enabled per `migrations/0002_rls.up.sql:13`). It answers "which platform capabilities are technically wired up for this tenant's namespace", not "which packs/allowances did this tenant buy" — confirming the BRD's framing that it's only a proto-entitlement. The `SetTenantModules`/`GetTenantModules` pair is the closest existing precedent for a small, independently-versioned per-tenant attribute set and is the pattern the new entitlement-override store methods should mirror.

**RBAC `permissions_flat` Redis projection** (the pattern CPL-FR-011 must reuse). Key scheme is documented and implemented in `services/rbac-service/internal/projection/keys.go:5-16`: `perm:{tenant}:{user}:actions`, `:ws:{ws}`, `:res:{h}`, `:flags`, `:index`, tenant-level `perm:{tenant}:archived_ws` / `:meta`, and a global `perm:catalog:actions` — all plain Redis strings holding versioned JSON (`{"v": <version>, "computed_at": <ts>, ...}`), not hashes. Writes go through a CAS Lua script (`redis.go:21-29`) for versioned last-writer-wins; `DefaultTTL` is 24h with a 1h refresh-on-read self-heal window (`redis.go:12-17`). Recompute is **not** a direct pub/sub reaction to permission-change events — it's an outbox-fed dirty queue: `Worker.ProcessOnce` claims dirty rows with `SKIP LOCKED` (`worker.go:16`, `worker.go:40-49`), recomputes per-user, writes to Redis, then publishes on `perm.invalidate` (`keys.go:21`) via `PublishInvalidate`. The worker's own staleness SLO is RBC-FR-042 ≤5s p99 (`worker.go:29-30`) — tighter than BRD 66's ≤60s target for `entitlements_flat`, so the commercial projection can reuse the identical claim/recompute/publish shape without needing the same tight budget. OPA reads the projection through the `projection.Reader` interface in `internal/authz/decide.go:90-224`, falling back to SQL on a projection miss.

**pack-service install authorization.** `services/pack-service/app/api/routes/installs.py` gates every install-family endpoint (lines 38, 101, 209, 248, 271) with `Depends(require("pack.install.execute"))` — a pure RBAC capability check, no commercial concept exists. The dry-run planner, `services/pack-service/app/domain/installer.py:97-142` (`plan()`), walks manifest components and emits one of `create` / `exists` / `deferred` / `after_approval` / `bind` / `reuse` / `requires_binding` per object (`installer.py:113-141`) — there is no `blocked` action today. CPL-FR-030's "dry-run plan marks the root object `blocked: entitlement`" requires a new branch, most naturally inserted right where `plan()` starts iterating manifest components (`installer.py:109`), checking `pack_sku` entitlement for the pack root before any other per-component branch, and a matching check earlier in the route handler (`installs.py:38-45`, immediately after `manifest = catalog.load_manifest(...)` at `installs.py:45`) so `execute` fails closed with `403 ENTITLEMENT_REQUIRED` before any materialization.

**bff-graphql tenant surface.** The existing pattern for exposing identity-service tenant data through the BFF is client method → resolver → DTO mapper: `services/bff-graphql/src/clients/identity.ts:216` (`tenant(id)`, a thin `GET /api/v1/tenants/{id}` wrapper) feeds `services/bff-graphql/src/resolvers/index.ts:452-453` (`tenant: (_p, a, ctx) => nullOn404(ctx.clients.identity.tenant(a.id).then(d => mapTenant(ctx, d)))`). A `tenantCommercial` query follows the identical three-layer shape.

**ui-web FEATURE_GATES.** `services/ui-web/src/lib/authz/registry.ts:23-28` defines a closed `Gate` union: `public | capability | role | platform | anyOf`, evaluated by `allows()` (`registry.ts:70-83`) against a `CapabilitySet` sourced from the BFF's `viewer.roles/capabilities` (itself sourced from `permissions_flat`, per the file's own header comment at `registry.ts:6-7`). `FEATURE_GATES` (`registry.ts:246`) maps named UI features to a `Gate`, e.g. `installPack: cap("pack.install.execute")` (`registry.ts:306`). The module explicitly states it makes **no security decision** — UI-only, fail-safe-hide (`registry.ts:9-10`). CPL-FR-013's `feature` entitlement needs a new `Gate` variant (e.g. `{kind: "entitlement"; key: string}`) alongside the existing four, evaluated against a viewer-scoped `entitlements` set the BFF adds next to `capabilities`/`roles` — this preserves the "UI-only, real enforcement stays server-side" invariant already documented in this file.

**Outbox mechanics.** `services/identity-service/internal/domain/events.go:22-53` defines `OutboxEvent` (matching the MASTER-FR-031 envelope) and `NewEvent(...)`, and every mutating `Store` method takes trailing `evs ...domain.OutboxEvent` (`internal/domain/store.go:14-15`, e.g. `TransitionTenant` at `store.go:26`). `provisioning.go:131-132` shows the call-site pattern: build the event with `NewEvent(EvTenantProvisioned, ...)` and pass it into the same store call that persists the state change, so write + event are one transaction. Persistence is `insertOutbox` (`internal/store/postgres/postgres.go:63`), called inside the same `tx` from `CreateTenant` (`postgres.go:112,123`), `UpdateTenant` (`postgres.go:450,466`), `TransitionTenant` (`postgres.go:470,488`), etc. New `commercial.events.v1` event types should extend the `Ev*` const block (`events.go:68-90`) and follow this exact call shape.

**Leader election for scheduled sweeps.** The outbox `Pruner` (`libs/go-common/outbox/pruner.go`) deliberately runs **without** leader election — it's safe to run redundantly on every replica because deletes are idempotent (comment at `pruner.go:17`). That is *not* a safe pattern for a trial-expiry sweep, since a naive implementation could double-transition a tenant or double-emit `commercial.trial_expired.v1` if it raced across replicas without care. The codebase's actual leader-election primitive is `services/realtime-hub/internal/fanout/lease.go`: a Redis `SET NX PX` lease (`lease.go:55`) renewed on a ticker at half the TTL via a Lua CAS script guarding on value match (`lease.go:70-75, 84-86`), released with a matching Lua `DEL`-if-owner (`lease.go:61-66, 77-82`), wired up with `NewLease(rdb, resource, holder)` + `go lease.Run(ctx)` (mirrors `services/realtime-hub/cmd/server/main.go`'s usage). This is the pattern the trial sweep should reuse — a 5s-TTL lease named e.g. `commercial:trial-sweep` — rather than inventing a Postgres-advisory-lock variant.

**Error envelope.** `services/identity-service/internal/domain/errors.go:14-28` defines the stable `Code*` constants and `errors.go:32-39` the `Error{Code, HTTP, Message, Details, RetryAfterSeconds}` struct, with constructors (`EValidation`, `ENotFound`, `EConflict`, `EPermissionDenied`, …, `errors.go:49-99`). The API layer renders it via `internal/api/respond.go:37-46` (`errorBody{Error: errorInner{Code, Message, Details, TraceID}}`) and `writeErr` (`respond.go:54-65`), which pulls `TraceIDFrom(ctx)` (`respond.go:20-26`). New commercial codes (`ENTITLEMENT_REQUIRED`, `TRIAL_EXPIRED`, `CAP_EXCEEDED`, `ENTITLEMENT_UNAVAILABLE`) extend the same const block and get the same `E*` constructor treatment — no new envelope mechanism needed.

**Platform-operator gating precedent.** CPL-FR-001's "platform-operator scope only" maps directly onto the existing `requireSuperAdmin` middleware (`services/identity-service/internal/api/middleware.go:109`) already used to gate `/platform/admins*` (`internal/api/server.go:160,172-174`, IDN-FR-025) — the plan-catalog CRUD and trial-override endpoints should mount under the same `/platform/...` sub-router with the same middleware, rather than inventing a new RBAC action string that duplicates it.

**RLS / migration convention.** identity-service migrations are `NNNN_description.{up,down}.sql`, sequential (currently through `0009_external_agent_keys`). Tenant-scoped tables get RLS via the loop pattern in `migrations/0002_rls.up.sql:10-21` (`ENABLE`+`FORCE ROW LEVEL SECURITY` plus a `tenant_isolation` policy on `current_setting('app.tenant_id', true)`); platform-scoped tables (like `tenants` itself) are explicitly RLS-exempt (`0002_rls.up.sql:7-8`). `0009_external_agent_keys.up.sql:14-28` is a representative recent example: plain `CREATE TABLE` with `id`, `tenant_id ... REFERENCES tenants(id)`, timestamps, one supporting index — no RLS in that migration because the table is platform-scoped like `tenant_branding`. New commercial tables will need to pick per-table which convention applies (see §2).

---

## 2. Architecture & Design

### Data model

Two tables are platform-scoped (mirror `tenants`, `tenant_modules`, `signing_keys` — no RLS, `requireSuperAdmin`-gated writes); the rest are tenant-scoped with RLS. All get `id uuid PRIMARY KEY` (uuidv7), `created_at`/`updated_at` per MASTER-FR-060; tenant-scoped tables add `tenant_id uuid NOT NULL REFERENCES tenants(id)`.

**`plans`** (platform-scoped, no RLS — mirrors `tenant_modules`'s platform ownership):
`key text PRIMARY KEY` (`internal-demo|design-partner|pilot|enterprise`, extensible), `name text`, `description text`, `trial_days_default int`, `status text CHECK (status IN ('active','deprecated'))`, `version int NOT NULL DEFAULT 1`, `created_at`, `updated_at`. Versioned per CPL-FR-002: any update to defaults increments `version`; existing `tenant_plan` assignment rows are untouched (they snapshotted at attach time — see below), so nothing mutates silently.

**`plan_entitlements`** (platform-scoped, child of `plans`): `id`, `plan_key text REFERENCES plans(key)`, `plan_version int` (the version this row belongs to — supports keeping old plan-version defaults queryable for audit), `kind text CHECK (kind IN ('pack_sku','meter_allowance','seat_cap','workspace_cap','feature'))`, `entitlement_key text` (pack name / meter key / `'seats'` / `'workspaces'` / feature key), `value_json jsonb` (small, ≤64KB per MASTER-FR-061 — holds `{included_qty, period}` for meter_allowance or `{n}` for caps; `pack_sku`/`feature` need no value beyond the key). Unique on `(plan_key, plan_version, kind, entitlement_key)`.

**`tenant_plan`** (tenant-scoped, RLS): one active row per tenant — `tenant_id PRIMARY KEY REFERENCES tenants(id)`, `plan_key text REFERENCES plans(key)`, `plan_version_snapshot int NOT NULL` (CPL-FR-002: pins the plan version at attach time), `assigned_at`, `assigned_by text`. Re-sync to a newer plan version is an explicit operator action (`POST /platform/tenants/{id}/plan/resync`) that bumps `plan_version_snapshot`, never an implicit background effect.

**`tenant_entitlement_overrides`** (tenant-scoped, RLS): `id`, `tenant_id`, `kind`, `entitlement_key`, `value_json jsonb`, `granted_by`, `granted_at`, `reason text`. Same `(tenant_id, kind, entitlement_key)` unique constraint as the plan defaults it can shadow. Effective-set resolution (CPL-FR-010) is: `overrides` LEFT JOIN-replaces `plan_entitlements` for the tenant's `plan_version_snapshot`, keyed by `(kind, entitlement_key)` — override wins.

**Commercial state — columns on `tenants`, not a new table.** CPL-FR-020 asks for `plan_key`, `commercial_state`, `trial_ends_at?` on the tenant. Two options were weighed:

- *(A, chosen)* Add `commercial_state text`, `trial_ends_at timestamptz`, `trial_started_at timestamptz` directly to the `tenants` table (a new migration, platform-scoped, no RLS — same table `tenants` already lives in). `plan_key` is *not* duplicated onto `tenants`; it's read from `tenant_plan` (single source of truth, avoids two places disagreeing about the current plan).
- *(B, rejected)* A separate `tenant_commercial_state` table (as the BRD's §6 alternative phrasing allows).

**Why A wins:** `commercial_state` is a single small enum column that every tenant read already touches (`GetTenant`), exactly like `Status` — splitting it into a joined table adds a mandatory join to the single hottest read path in identity-service for no isolation benefit (both live in the same platform-scoped, RLS-exempt, single-row-per-tenant space as `tenants` itself). This mirrors how `Tier`/`Cloud`/`Status` already sit directly on `Tenant` (`tenant.go:65-86`) rather than in side tables. `tenant_plan` and `tenant_entitlement_overrides` *do* get their own tables because they're 1:N-shaped (assignment history / override list) or naturally tenant-scoped RLS data, unlike the three commercial-state scalars.

`commercial_state` values: `none | trial | active | suspended_commercial | churned` (CPL-FR-020). **This is a second, independent state machine from `TenantStatus`** (`tenant.go:13-23`), not new values threaded into it — same reasoning the BRD gives (never interfere with provisioning states) and the same shape the codebase already uses for orthogonal per-tenant axes (`Tier`, provisioning `Status`, and now commercial state, each with their own transition guard). A `commercialTransitions` table alongside `tenantTransitions` (`tenant.go:27-34`) enforces: `none→trial`, `none→active` (direct plan assignment, no trial), `trial→active` (convert), `trial→suspended_commercial` (sweep expiry), `suspended_commercial→active` (late conversion), `suspended_commercial→churned`, `active→churned`. Any tenant `TenantStatus` (deleting, suspended, etc.) still transitions independently — a `commercial_state=trial` tenant can still be ops-`suspended` for abuse, and the two states compose via AND at enforcement time (see below), not via shared transition rules.

**`trial_events`** (tenant-scoped, RLS, MASTER-FR-062 partitioned by month — high-volume-ish audit trail): `id`, `tenant_id`, `event_type text` (`started|extended|expired|converted`), `trial_days int`, `reason text`, `actor text`, `occurred_at`. Populated on every trial state-machine call; gives Tenant Admin / operator UI a full history (US-4) without re-deriving it from the outbox.

### API endpoints

All under `/api/v1`, all POSTs accept `Idempotency-Key` (MASTER-FR-025, same middleware as `internal/api/idempotency.go`). Plan CRUD mounts under `/platform/...` gated by `requireSuperAdmin` (`middleware.go:109`), matching the existing `/platform/admins` precedent (`server.go:160,172-174`) — action name `platform.plan.manage` is the documented scope label but enforcement is the existing middleware, not a new RBAC action.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/platform/plans` | `requireSuperAdmin` | list plan catalog (paginated, MASTER-FR-022) |
| `POST` | `/platform/plans` | `requireSuperAdmin` | create plan (CPL-FR-001) |
| `PATCH` | `/platform/plans/{key}` | `requireSuperAdmin` | update defaults → bumps `version` (CPL-FR-002) |
| `POST` | `/platform/tenants/{id}/plan` | `requireSuperAdmin` | assign plan; snapshots `plan_version_snapshot` (US-2) |
| `POST` | `/platform/tenants/{id}/plan/resync` | `requireSuperAdmin` | explicit re-snapshot to current plan version |
| `POST` | `/platform/tenants/{id}/entitlements/overrides` | `requireSuperAdmin` | upsert one override (US-2) |
| `DELETE` | `/platform/tenants/{id}/entitlements/overrides/{kind}/{key}` | `requireSuperAdmin` | remove override |
| `GET` | `/tenants/{id}/entitlements` | tenant admin (own tenant) or platform | effective set + provenance (CPL-FR-011) |
| `POST` | `/tenants/{id}/trial` | `requireSuperAdmin` | start trial (US-3, CPL-FR-021) |
| `POST` | `/tenants/{id}/trial/extend` | `requireSuperAdmin` | extend, reason required+audited |
| `POST` | `/tenants/{id}/convert` | `requireSuperAdmin` | trial→active with target plan (CPL-FR-021) |

`GET /tenants/{id}/entitlements` response: `{data: [{kind, key, value, provenance: "plan_default"|"override"}], plan: {key, version}, commercial_state, trial_ends_at}`. Cross-tenant access returns `404` per MASTER-FR-002/003 (same as every other tenant-scoped identity-service read), never `403`.

### `entitlements_flat` Redis projection

Mirrors `permissions_flat` exactly (CPL-FR-011 says so explicitly):

- **Key:** `ent:{tenant}:flat` → one JSON string `{"v": <version>, "computed_at": ts, "plan_key", "plan_version", "commercial_state", "trial_ends_at", "entitlements": [{kind, key, value, provenance}]}`. A single per-tenant key (not per-kind like `permissions_flat`'s per-user fan-out) because entitlements are tenant-scoped, not user-scoped — there's no per-user dimension to shard on, so one key suffices; this is a deliberate simplification versus `perm:*`'s multi-key scheme, not a divergence for its own sake.
- **Write path:** CAS Lua script, same shape as `redis.go:21-29`, versioned last-writer-wins.
- **Invalidation / rebuild:** a `commercial_dirty` outbox-fed queue (same `ClaimDirtyRows`/`SKIP LOCKED` shape as `worker.go:16,40-49`) is enqueued by every mutation to `tenant_plan`, `tenant_entitlement_overrides`, or the three commercial-state columns on `tenants`. A `commercial.Worker` (structurally identical to `rbac-service`'s `Worker`) claims, recomputes the effective set, writes Redis, and publishes on a new pub/sub channel `ent.invalidate` (mirrors `perm.invalidate`, `keys.go:21`). Target ≤60s staleness (CPL-FR-011) is looser than rbac's 5s p99 SLO, so the same worker shape can run at a longer poll interval.
- **Readers:** pack-service, BFF, identity-service seat/workspace-cap checks all read `ent:{tenant}:flat` directly via a thin Redis client — no synchronous identity-service call in the request path (CPL-NFR-001, mirrors OPA's `permissions_flat` read in `decide.go:90-224`).
- **TTL:** 24h with refresh-on-read, matching `redis.go:12-17`'s `DefaultTTL`/`RefreshWindow`.

### Trial sweep job

A single-writer scheduled job, run on every identity-service replica but gated by a Redis leader lease copying `services/realtime-hub/internal/fanout/lease.go` verbatim in shape: `NewLease(rdb, "commercial:trial-sweep", podID)`, 5s TTL renewed every 2.5s, `SET NX PX` acquire + Lua CAS renew/release. Only the leader runs `SweepOnce`, on a 1-minute ticker (tight enough that CPL-NFR-003's "exactly-once per tenant/day" holds even with `≤60s` projection staleness budgets elsewhere). `SweepOnce`:

1. `SELECT` tenants where `commercial_state = 'trial' AND trial_ends_at <= now()` (indexed on `(commercial_state, trial_ends_at)`).
2. For each, in one transaction: `commercialTransitions` guard `trial→suspended_commercial`, write `trial_events` row (`expired`), emit `commercial.trial_expired.v1` via the same `insertOutbox`-in-same-tx pattern as `postgres.go:63,450,470`.
3. Idempotency: the state guard itself is the exactly-once mechanism — a re-run (e.g. after a leader handoff mid-batch) finds `commercial_state` already `suspended_commercial` and the guarded transition simply no-ops (same `CanTransition`-false → skip, not error, unlike the 409 path used for user-driven calls).

This is a **new pattern** relative to `outbox/pruner.go`'s deliberately-leaderless design — justified because prune deletes are naturally idempotent/order-independent, while trial sweep performs a state transition + exactly-once event emission where duplicate concurrent runs would only be "mostly" safe (double emission of `commercial.trial_expired.v1` violates CPL-NFR-003 even though the state transition itself is a safe no-op the second time). Leader election removes the race instead of relying on transition idempotency alone.

Trial threshold events (CPL-FR-023, T-14/T-7/T-1) are emitted by the same leader's sweep tick via a second query (`trial_ends_at` within the next 14/7/1 days AND no `trial_events` row of type `ending_T14`/etc already exists for this tenant) — same transaction shape, no separate job.

### Commercial-state claim + fail-open/fail-closed (CPL-NFR-004)

`commercial_state` is added to the JWT claim set (alongside the existing claims in MASTER-FR-011) at token mint time, read from the tenant row (not the projection — token mint already loads the tenant). Downstream services that need a fast, request-local check (e.g. "is this tenant suspended_commercial") read the claim directly, no round trip. Services that need entitlement *values* (pack SKUs, allowances, caps) read `entitlements_flat`.

| Path | Projection available | Projection unavailable |
|---|---|---|
| Reads (dashboards, case list, entitlements display) | serve normally | **fail open** — serve normally, no entitlement re-check on reads (CPL-NFR-004) |
| Entitlement-gated writes (pack install, invite over cap, workspace create over cap) | enforce (`403 ENTITLEMENT_REQUIRED` / `403 CAP_EXCEEDED`) | **fail closed** — `503 ENTITLEMENT_UNAVAILABLE` |
| `commercial_state` claim check (trial expired → read-only) | n/a (claim, not projection) | claim is always present once minted; a stale claim past `trial_ends_at` is caught by the sweep having already flipped `commercial_state` before the next token mint — no fail-open/closed ambiguity here since it's not projection-dependent |

### Enforcement hook contracts

**pack-service** (`installer.py:97-142`, `installs.py:38-45`): before `plan()` iterates components, a new step checks `pack_sku:{manifest.pack_name}` against `entitlements_flat`. Dry-run: prepend `{"kind": "root", "identity": manifest.pack_name, "action": "blocked", "detail": "entitlement"}` to the ops list instead of proceeding into the existing per-component loop (CPL-FR-030's exact phrasing). Execute (`installs.py` handler): same check, return
```json
{"error": {"code": "ENTITLEMENT_REQUIRED", "message": "pack_sku:banking-aml is not entitled for this tenant", "details": {"missing_sku": "banking-aml"}, "trace_id": "..."}}
```
HTTP 403 — same `errorBody`/`errorInner` shape as `respond.go:37-46` (pack-service's Python side already mirrors this envelope; details TBD by installs.py's own error module, out of this doc's scope to re-derive).

**identity-service invite / rbac-service workspace-create** (CPL-FR-031): both check `seat_cap`/`workspace_cap` against `entitlements_flat` before the write. Envelope:
```json
{"error": {"code": "CAP_EXCEEDED", "message": "seat cap reached", "details": {"current": 5, "limit": 5}, "trace_id": "..."}}
```
HTTP 403, built via a new `ECapExceeded(current, limit int)` constructor following the `errors.go:49-99` constructor pattern, with `CodeCapExceeded` added to the const block (`errors.go:14-28`).

**BFF** (CPL-FR-033): a new `services/bff-graphql/src/clients/identity.ts` method `tenantCommercial(id)` → `GET /tenants/{id}/entitlements`, resolver `tenantCommercial` in `resolvers/index.ts` following the exact `tenant` resolver shape (`resolvers/index.ts:452-453`), capability-gated: full detail (entitlements list, trial end date) requires tenant-admin capability; a minimal public shape (`{commercial_state, locked_feature_keys}`) is exposed unauthenticated-within-tenant for gating locked UI regardless of role, per CPL-FR-033's "minimal public shape... for gating".

**ui-web** (CPL-FR-013): new `Gate` variant `{kind: "entitlement"; key: string}` added to the union at `registry.ts:23-28`, handled in `allows()` (`registry.ts:70-83`) against a new `entitlements: ReadonlySet<string>` field on `CapabilitySet` (`registry.ts:41-47`), populated from `tenantCommercial`'s `locked_feature_keys`. Locked features render the existing pack-service "locked card" pattern generalized to any `feature` entitlement — preview + upsell CTA, never hidden (distinct from `capability` gates, which fail-hide per `registry.ts:9-10`).

### Options considered and rejected

- **Threading commercial states into `TenantStatus` directly** (e.g. `trial`, `suspended_commercial` as new `TenantStatus` values) — rejected: `tenantTransitions` (`tenant.go:27-34`) is a small, exhaustively-tested guard table already coupled to provisioning; commercial states have independent transition rules (trial can start/extend/convert regardless of provisioning outcome) and mixing them risks illegal cross-products (e.g. `provisioning` + `trial` simultaneously) that a single enum can't express cleanly. Two independent guarded state machines (matching how `Tier`/`Cloud` already sit as independent scalars) keeps both simple and testable in isolation, at the cost of enforcement needing to check both.
- **RBAC action for plan/trial CRUD instead of `requireSuperAdmin`** — rejected: duplicates a middleware and platform-admin registry (`internal/domain/store.go:28-33`) that already exists and is already the enforcement point for the structurally identical "/platform/admins" surface.
- **Per-kind Redis keys for `entitlements_flat`** (mirroring `permissions_flat`'s `:actions`/`:ws`/`:res` split) — rejected: that split exists in rbac because permissions vary by user and resource; entitlements vary only by tenant, so a single JSON blob per tenant is both simpler and sufficient at CPL-NFR-001's ≤5ms budget.
- **Leaderless trial sweep (pruner-style)** — rejected per CPL-NFR-003's exactly-once requirement; see sweep design above.

### Explicitly out of scope

Payment collection/invoicing (BRD 67); self-serve signup/trial creation by an unauthenticated user (a future initiative — this BRD only makes trials operator-startable); per-user seat *assignment* UI beyond the numeric cap; marketplace listing/publishing (roadmap B13); usage-service meter *rollup* computation (CPL-FR-032 only reads `included_qty` from the entitlement, no billing math); conversion-snapshot sales evidence (CPL-FR-024, Could-priority, deferred past slice 1-3).

---

## 3. Implementation & Test

**Status: Slice 1 built and unit/API-tested. Slice 2 (trials + sweep) built and unit/API-tested this pass. The identity-service half of slice 3 (seat_cap invite gate, CPL-FR-031) also built and tested this pass. Integration tier written but not executed (no Docker in this environment, confirmed via `docker info` each pass). The REST of slice 3 — pack-service's `pack_sku` gate, rbac-service's `workspace_cap` gate, the BFF `tenantCommercial` resolver, and ui-web's `entitlement` Gate — is a separate, concurrently-run agent's scope (file-ownership split: this pass owned `services/identity-service/**` exclusively) and is not verified here.**

### Pre-implementation verification: the lease.go citation

Before writing code, the design's citation of `services/realtime-hub/internal/fanout/lease.go` as an existing Redis `SET NX PX` leader-election lease was checked directly against another design agent's report that no leader election exists in the codebase. **The design doc is correct; the other report was wrong (or stale).** `lease.go` exists (2247 bytes, last modified with the rest of `realtime-hub/internal/fanout/`) and matches the design's description exactly: `NewLease(rdb, resource, holder)` builds a lease keyed `rt:leader:<resource>`, `Run` acquires via `SetNX` and renews on a ticker at half the 5s TTL via a Lua CAS script (`renewScript`, value-match `GET`+`PEXPIRE`), and releases via a matching Lua `GET`+`DEL` (`releaseScript`). This is the exact shape the design proposes reusing for the slice-2 trial sweep (`commercial:trial-sweep`, 5s TTL). Since leader election is only needed for the trial sweep (slice 2), this finding doesn't block slice 1, but it's recorded here as requested: **no fix needed, the primitive is real and ready to reuse.**

### Slice plan (unchanged from the design; slices 1-2 + identity-service's slice-3 piece are built)

- **Slice 1 — schema + plan catalog + assignment + effective-entitlements API + projection.** ✅ Built (prior pass). Migrations for `plans`, `plan_entitlements`, `tenant_plan`, `tenant_entitlement_overrides`, and the three commercial columns on `tenants`; plan CRUD + assignment + override endpoints; `GET /tenants/{id}/entitlements`; the `entitlements_flat` projection worker + `ent.invalidate` channel.
- **Slice 2 — trials + sweep.** ✅ **Built this pass.** `POST /tenants/{id}/trial` (start), `POST .../trial/extend` (reason required + audited), `POST .../convert` (trial→active with target plan) — all `requireSuperAdmin`, all participate in the existing `Idempotency-Key` middleware automatically (mounted in the same middleware group). A new `trial_events` table (migration `0013_trial_events`, RLS, dual tenant-isolation/platform-bypass policy mirroring `commercial_dirty`) records `started|extended|expired|converted|ending_t14|ending_t7|ending_t1`. A leader-elected `TrialSweep` (1-minute ticker, `leaderlease.Lease` reused verbatim — see below) runs `SweepOnce`: expires trials past `trial_ends_at` (`trial→suspended_commercial`, `commercial.trial_expired.v1`, exactly-once via the state-guard-as-no-op mechanism) and emits T-14/T-7/T-1 threshold events (`commercial.trial_ending.v1`) deduplicated by a `NOT EXISTS` query against `trial_events`. `commercial_state` was added to the JWT `Claims` struct and is now minted at every `typ=user`/`agent_obo`/`agent_autonomous`/`service` token-issuance site that already loads the tenant row (`token_oidc.go`, `token_embed.go`, `token_embed_oidc.go`, `token_service.go`'s three sites) — always present on the wire (unlike the `profile` claim), since `CommercialNone` ("none") is itself a meaningful value.
- **Slice 3 — enforcement hooks.** 🟡 **Partially built this pass (identity-service's piece only).** identity-service's own user-invite path now enforces `seat_cap` against `entitlements_flat` (CPL-FR-031): `UserService.Invite` calls a new `EntitlementReader` port (nil-safe, mirrors the Logo/Demo/Lease "honest optional adapter" convention) before creating the invite, returning `403 CAP_EXCEEDED {current, limit}` (the `ECapExceeded`/`CodeCapExceeded` constructor+code already existed from slice 1 — confirmed present in `errors.go` before starting, so nothing needed adding there) or, per CPL-NFR-004's fail-closed table, `503 ENTITLEMENT_UNAVAILABLE` when the projection read itself fails (as opposed to a clean "no cap configured" miss, which is unenforced by design). `main.go` wires a real `projection.ReadSet`-backed reader whenever `REDIS_ADDR` is set, and `mustReal`-fails boot in strict/production mode otherwise (this is a live enforcement point, unlike the projection worker which is allowed to ship dark). **NOT built here** (owned by the concurrently-run other agent, per this pass's file-ownership split to `services/identity-service/**`): pack-service's `pack_sku` install gate, rbac-service's `workspace_cap` gate, the BFF `tenantCommercial` resolver, and ui-web's `entitlement` Gate variant.

### Files touched (slice 1)

30 files across identity-service (the only service this slice touches — rbac-service/bff-graphql/ui-web are slice 3):

**Migrations** (new): `services/identity-service/migrations/0010_commercial_plans.{up,down}.sql` (plans, plan_entitlements, seeds the four plans + starter seat/workspace caps), `0011_commercial_tenant.{up,down}.sql` (tenants.commercial_state/trial_started_at/trial_ends_at, tenant_plan, tenant_entitlement_overrides, commercial_dirty — all with RLS per MASTER-FR-001, mirroring `0002_rls.up.sql`'s policy shape).

**Domain** (new): `internal/domain/commercial.go` (EntitlementKind, Plan, PlanEntitlement, TenantPlan, TenantEntitlementOverride, `ResolveEffectiveEntitlements`), `internal/domain/commercial_service.go` (`PlanService`, `CommercialService`). **Edited**: `internal/domain/tenant.go` (`CommercialState` + `commercialTransitions` guard table + `Tenant.TransitionCommercial`, new `Tenant` fields), `internal/domain/tenant_service.go` (new tenants start `CommercialState: CommercialNone`), `internal/domain/errors.go` (`ENTITLEMENT_REQUIRED`/`TRIAL_EXPIRED`/`CAP_EXCEEDED`/`ENTITLEMENT_UNAVAILABLE` codes + constructors), `internal/domain/events.go` (`commercial.plan_assigned`/`commercial.entitlement_changed` event types), `internal/domain/store.go` (`Store` interface: plan CRUD, tenant plan/override CRUD, `TransitionTenantCommercial`, commercial-dirty claim/delete).

**Store**: `internal/store/memory/memory.go` and `internal/store/postgres/postgres.go` both implement every new `Store` method (plan catalog, tenant_plan, tenant_entitlement_overrides, commercial_state CAS transition, `commercial_dirty` SKIP-LOCKED claim queue mirroring rbac-service's `projection_dirty`).

**Projection** (new package): `internal/projection/{keys,redis,worker}.go` — `ent:{tenant}:flat` key, versioned-CAS Redis writer (byte-identical script to rbac's `permissions_flat` CAS), `ent.invalidate` pub/sub, and a `Worker`/`Loader`/`Writer`-interface recompute loop structurally identical to `rbac-service/internal/projection/worker.go`.

**API**: `internal/api/handlers_commercial.go` (new — plan CRUD, assign/resync, override upsert/delete, `GET /tenants/{id}/entitlements`), `internal/api/server.go` (routes: plan CRUD + assignment under the existing `requireSuperAdmin` group at `/platform/...`; entitlements read under the existing `ActUserAdmin`-gated `/tenants/{id}/...` group with the same cross-tenant-404 pattern as `handleGetTenant`), `internal/api/fixture_test.go` (wired `Plans`/`Commercial` into the shared test fixture).

**Events**: `internal/events/kafka.go` (routes `commercial.`-prefixed event types to a new `commercial.events.v1` topic, separate from `identity.events.v1`, per CPL-FR-014/BRD §6), `events/commercial_event.avsc` (new — same envelope shape as `identity_event.avsc`, documents the new topic).

**Wiring**: `cmd/server/main.go` (`PlanService`/`CommercialService` construction, `Server.Plans`/`Commercial` fields, projection worker started when `REDIS_ADDR` is set — dark/no-op otherwise since nothing reads the projection synchronously until slice 3).

**Docs**: `services/identity-service/api/openapi.yaml` (new paths + schemas for every slice-1 endpoint), `services/identity-service/README.md` (layout note for `internal/projection/`, new "BRD 66 — Commercial plane" FR-traceability table), this file.

**Tests** (new): `internal/domain/commercial_test.go`, `internal/domain/commercial_service_test.go`, `internal/api/handlers_commercial_test.go`, `internal/projection/worker_test.go`, `internal/events/kafka_test.go`, `test/integration/commercial_pg_test.go`.

**Dependency added**: `github.com/testcontainers/testcontainers-go/modules/redis` (identity-service's `go.mod`/`go.sum`) — needed for the integration-tier Redis round-trip test; identity-service's integration suite previously only stood up Postgres.

### Test commands + results

```
cd services/identity-service

make build            # go build -o bin/identity-service ./cmd/server  → PASS (no errors)
make vet               # go vet ./... && go vet -tags integration ./...  → PASS (no findings)
make lint              # → environment error, NOT a code issue: the installed golangci-lint
                       #   binary (go1.25) is older than the module's go1.26.5 toolchain and
                       #   refuses to load config. Pre-existing environment mismatch, unrelated
                       #   to this change; `go vet` (the Makefile's own fallback path) is clean.
make test-unit         # go test ./internal/... ./migrations/...  → PASS, all packages ok
go test -count=1 ./...  → PASS, 94 test functions across internal/domain, internal/api,
                          internal/projection, internal/events (21 new, 73 pre-existing,
                          0 failures, 0 broken by this change)

make test-integration  # go test -tags integration -timeout 600s ./test/integration/...
                        # → the `integration` package itself: ok, 1.7s, every test SKIPs
                        #   cleanly with "Docker unavailable" (this sandbox has no Docker
                        #   daemon: `docker ps` → "dial unix /var/run/docker.sock: connect:
                        #   no such file or directory"). This includes every new commercial
                        #   test (TestCommercialMigrationSeedsPlans, TestCommercialRLSIsolation,
                        #   TestCommercialAPI_Authz, TestCommercialProjection_RedisRoundTrip)
                        #   and the pre-existing pg_test.go/api_pg_test.go/restart_test.go suite.
                        # → the Makefile target as a WHOLE exits non-zero because a SEPARATE,
                        #   PRE-EXISTING subpackage (test/integration/secretsigner) panics
                        #   instead of skipping when Docker is entirely absent (its TestMain
                        #   calls testcontainers' MustExtractDockerSocket directly, which
                        #   panics rather than returning an error the way tcpg.Run does).
                        #   Confirmed pre-existing via `git log -- .../secretsigner/signer_
                        #   contract_test.go` (untouched by this change, last touched in an
                        #   unrelated pack-wave commit). Not fixed here — out of BRD 66 scope.
```

### Verified vs written-but-not-run vs deferred

- **Verified (executed, green):** state-machine guards (`TestCommercialTransitionMatrix`, exhaustive over all 25 `(from,to)` pairs, matching `TestTenantTransitionMatrix`'s style); effective-entitlement resolution incl. override-wins-by-kind+key and additive overrides (`TestResolveEffectiveEntitlements_*`); plan create/patch/version-bump-only-on-entitlements-change (`TestPlanService_*`); assignment snapshot semantics — a plan-default change after assignment does NOT alter the already-resolved effective set until an explicit resync (`TestCommercialService_AssignPlan_SnapshotSemantics`); override upsert/remove round-trip; the four new error constructors; the projection worker's claim→snapshot→write→delete→publish orchestration against fake `Loader`/`Writer` seams, including the "leave dirty rows claimed on snapshot/write failure" at-least-once behavior (`TestWorker_ProcessOnce_*`); the `commercial.events.v1` topic-routing decision (`TestKafkaPublisher_TopicFor`); full API-layer authz — plan CRUD requires super-admin (tenant-admin token → 403, unauthenticated → 401), plan assign/override/resync round-trip through the real chi router + in-memory store, and `GET /tenants/{id}/entitlements` authz matrix (own-tenant admin → 200, cross-tenant admin → 404 + `security.cross_tenant_denied` audited, super-admin → 200 for any tenant, unassigned tenant → 200 with an empty effective set) (`handlers_commercial_test.go`).
- **Written but not executed (no Docker in this environment):** `TestCommercialMigrationSeedsPlans` (0010/0011 apply cleanly, all four plans + their seed entitlements present), `TestCommercialRLSIsolation` (tenant_plan/tenant_entitlement_overrides cross-tenant reads blocked at both the store and raw-SQL level, mirroring the existing `TestRLSIsolation`), `TestCommercialAPI_Authz` (the same authz matrix as above, but against real Postgres/RLS instead of the in-memory store), `TestCommercialProjection_RedisRoundTrip` (a real Redis testcontainer: `AssignTenantPlan` enqueues a `commercial_dirty` row in the same transaction, the worker claims and writes `ent:{tenant}:flat`, `ent.invalidate` is observed on a live subscription, and a second pass is a no-op). All four compile clean under `go vet -tags integration ./...` and are wired into the existing `requirePG`/Docker-unavailable auto-skip convention — they simply haven't been able to run end-to-end here.
- **Deferred / explicitly out of slice 1 (per the task's scope, not a gap):** trial start/extend/convert, the leader-elected sweep, `trial_events`, and the T-14/T-7/T-1 threshold events (slice 2); pack-service's `pack_sku` install gate, identity-service's `seat_cap` invite gate, rbac-service's `workspace_cap` gate, the BFF `tenantCommercial` resolver, and ui-web's `entitlement` Gate variant (slice 3, all consumers of the codes/projection this slice defines but doesn't wire up); contract tests for `commercial.events.v1` beyond the schema file itself (no consumer exists yet to contract-test against); the E2E journey in `deploy/e2e` (requires the full compose stack; not run here per the task's "do not run the full stack" instruction — noted as pending live verification, hook is `GET /tenants/{id}/entitlements` returning the assigned plan's entitlements after `POST /platform/tenants/{id}/plan`, both of which exist and are unit/API-tested above).

### A note on git state

While this work was in progress, the environment auto-created two intermediate "wip" commits (`fe34803`, `eabadc7`) capturing snapshots of the in-flight implementation — these were not `git commit` calls made by this agent (no commit was issued at any point in this session; the task explicitly says not to commit). Flagging this for the orchestrator's awareness since it affects what "uncommitted diff" means when reviewing this change: the full slice-1 diff is best viewed as `git diff fe34803^..HEAD -- services/identity-service` plus the working tree (which additionally has this documentation update, the `commercial.events.v1` Avro schema, `internal/events/kafka_test.go`, and OpenAPI/README polish).
