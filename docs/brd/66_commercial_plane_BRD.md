# BRD 66 — Commercial Plane (plans, entitlements, trials)

**Service:** identity-service (owner) + rbac-service/bff-graphql/ui-web (consumers) · **Language:** Go (+TS surfaces) · **Phase:** GTM-1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply). Origin: `../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §6 item B1.

---

## 1. Overview

**Purpose.** Introduce a commercial layer — **plans, entitlements, and trials** — distinct from RBAC. Today nothing in the platform distinguishes a paying tenant from any other: gating is purely capability-based (`ui-web/src/lib/authz/registry.ts` FEATURE_GATES = permissions), the tenant state machine has no trial state, and `Tenant.Modules []string` (IDN-FR-005) is the only proto-entitlement. Every downstream GTM feature (billing, pack SKUs, POC mode, marketplace, expansion prompts) depends on this object model existing.

**Business value.** Enables: design-partner/pilot/enterprise plan differentiation, time-boxed trials with expiry and conversion, pack add-on SKUs (packs as separately priced modules — the briefing's pricing model §6.4), meter allowances that feed billing (BRD 67), and visible-but-locked upsell surfaces. Without it, revenue capture and self-serve motions are structurally impossible.

**In scope.** Plan catalog (platform-defined); tenant→plan assignment with effective entitlements; entitlement kinds: `pack_sku`, `meter_allowance`, `seat_cap`, `workspace_cap`, `feature`; trial lifecycle (start/expiry/extension/conversion) on the tenant state machine; enforcement hooks (pack-service install gate, usage-service allowance surfaces, BFF/ui gating); entitlement-change events; admin APIs + platform-operator UI surface.

**Out of scope.** Payment collection and invoicing (BRD 67 exports to an external billing system); self-serve signup (separate initiative — this BRD makes trials *representable*, not self-provisionable); per-user licensing/seat assignment mechanics beyond a numeric cap; marketplace listing/publishing (roadmap B13).

## 2. Actors & user stories

Personas: **Platform Operator** (Datacern commercial admin), **Tenant Admin**, **Pack-service / usage-service / BFF** (system consumers), **Sales/Partner** (via operator tooling).

- **US-1** As a Platform Operator, I want to define plans (`internal-demo`, `design-partner`, `pilot`, `enterprise`) with default entitlements, so tenant provisioning attaches a commercial identity.
- **US-2** As a Platform Operator, I want to assign a plan to a tenant with per-tenant entitlement overrides, so negotiated contracts are representable.
- **US-3** As a Platform Operator, I want to start a 60-day trial on a pilot tenant, so the POC has an expiry and a conversion path.
- **US-4** As a Tenant Admin, I want to see my plan, included packs, allowances, and trial end date in the admin console, so there are no surprises.
- **US-5** As pack-service, I want to check `pack_sku` entitlement before install, so uninstalled-but-visible packs drive expansion instead of silent failure.
- **US-6** As usage-service, I want to read meter allowances per tenant, so budget defaults and billing exports reflect the contract.
- **US-7** As the BFF/UI, I want an effective-entitlements query, so locked features render as previews with an upgrade path, not blank screens.
- **US-8** As a Platform Operator, I want trial expiry to move the tenant to a `suspended_commercial` state (data intact, read-only) rather than deletion, so conversion after expiry is one API call.

## 3. Functional requirements

### Plan catalog
- **CPL-FR-001 (Must)** Platform-defined plan catalog (no tenant-defined plans): `plan{key, name, description, default_entitlements[], trial_days_default?, status(active|deprecated)}`. Seeded plans: `internal-demo`, `design-partner`, `pilot`, `enterprise`. CRUD is platform-operator scope only (`platform.plan.manage`).
- **CPL-FR-002 (Must)** Plans are versioned; changing defaults never mutates existing tenant assignments (assignment snapshots defaults at attach time; re-sync is an explicit operator action).

### Entitlements
- **CPL-FR-010 (Must)** Entitlement kinds v1: `pack_sku{pack_name}`, `meter_allowance{meter_key, included_qty, period(calendar_month)}`, `seat_cap{n}`, `workspace_cap{n}`, `feature{key}`. Stored per tenant as (plan defaults ⊕ overrides); effective set = overrides win by kind+key.
- **CPL-FR-011 (Must)** `GET /tenants/{id}/entitlements` returns the effective set with provenance (`plan_default|override`) — consumed by BFF, pack-service, usage-service. Cached in Redis with the same projection/invalidations discipline as `permissions_flat` (event-driven, ≤60s staleness).
- **CPL-FR-012 (Must)** Entitlements are **commercial** gates layered *before* RBAC, never replacing it: a user must pass entitlement AND capability checks. Absence of a `pack_sku` entitlement blocks install with `403 ENTITLEMENT_REQUIRED` (stable error code per MASTER-FR-024), listing the missing SKU.
- **CPL-FR-013 (Should)** `feature` entitlements map to a registry consumed by ui-web FEATURE_GATES so locked surfaces render preview/upsell states (visible-but-locked), not hidden.
- **CPL-FR-014 (Must)** Entitlement changes emit `commercial.entitlement_changed.v1` (outbox, MASTER-FR-031) with before/after diff; audit-service consumes it (dual attribution).

### Trials & commercial state
- **CPL-FR-020 (Must)** Tenant gains commercial fields: `plan_key`, `commercial_state(none|trial|active|suspended_commercial|churned)`, `trial_ends_at?`. State transitions are guarded on the existing tenant state machine (`internal/domain/tenant.go`) and never interfere with provisioning states.
- **CPL-FR-021 (Must)** `POST /tenants/{id}/trial` starts a trial (`trial_days` from plan default, operator-overridable); `POST .../trial/extend` extends with reason (audited); `POST .../convert` moves `trial→active` with target plan.
- **CPL-FR-022 (Must)** A scheduled sweep (idempotent, leader-elected like existing reapers) transitions expired trials to `suspended_commercial` and emits `commercial.trial_expired.v1`. Suspension semantics: platform JWTs still mint; a `commercial_state` claim lets services degrade to read-only (writes → `403 TRIAL_EXPIRED`); data retained per retention policy.
- **CPL-FR-023 (Should)** Trial threshold events at T-14/T-7/T-1 days (`commercial.trial_ending.v1`) for notification-service fan-out.
- **CPL-FR-024 (Could)** Conversion snapshot: on convert, persist a record of trial usage totals (from usage-service rollups) for sales evidence.

### Enforcement hooks (consumers)
- **CPL-FR-030 (Must)** pack-service: install/upgrade check `pack_sku` (dry-run plan reports `blocked: entitlement` per object; UI shows locked pack card with SKU name).
- **CPL-FR-031 (Must)** identity-service: user-invite path enforces `seat_cap`; workspace-create (rbac-service) enforces `workspace_cap` — both with stable `403 CAP_EXCEEDED` + current/limit in the error envelope.
- **CPL-FR-032 (Should)** usage-service: expose `included_qty` remaining per meter allowance in the cost panel (read from CPL-FR-011; no billing math here — BRD 67).
- **CPL-FR-033 (Must)** BFF exposes `tenantCommercial` (plan, state, trialEndsAt, entitlements) to ui-web, capability-gated to tenant admins for detail, with a minimal public shape (state + locked-feature keys) for gating.

## 4. Non-functional requirements

- **CPL-NFR-001** Entitlement check adds ≤5ms p99 to gated paths (Redis projection, no sync identity-service call at request time).
- **CPL-NFR-002** RLS per MASTER-FR-001 on all new tables; commercial state is tenant-scoped data readable by tenant admins, writable only by platform-operator scope.
- **CPL-NFR-003** All transitions idempotent (`Idempotency-Key`, MASTER-FR-023); sweep is exactly-once per tenant/day.
- **CPL-NFR-004** Fail-open policy is explicit and narrow: if the entitlement projection is unavailable, *reads* proceed, *entitlement-gated writes* (pack install, invite over cap) fail closed with `503 ENTITLEMENT_UNAVAILABLE`.

## 5. Acceptance criteria (selection)

- **AC-1** Given tenant on plan `pilot` without `pack_sku:banking-aml`, when installing that pack, then dry-run plan marks the root object `blocked: entitlement` and execute returns `403 ENTITLEMENT_REQUIRED`; after operator adds an override, install proceeds.
- **AC-2** Given a trial started with 60 days, when the sweep runs past `trial_ends_at`, then tenant `commercial_state=suspended_commercial`, `commercial.trial_expired.v1` is on the bus exactly once, and a proposal-approval attempt returns `403 TRIAL_EXPIRED` while case reads still succeed.
- **AC-3** Given `seat_cap{n:5}` and 5 active users, when inviting a 6th, then `403 CAP_EXCEEDED` with `{current:5, limit:5}`; after cap raised to 10, the same idempotent invite succeeds.
- **AC-4** Entitlement change → projection updated ≤60s → `commercial.entitlement_changed.v1` audited with actor attribution.
- **AC-5** Cross-tenant: tenant A admin querying tenant B's entitlements → 404 (MASTER-FR-002) + `security.cross_tenant_denied`.

## 6. Events & data

Topics: `commercial.events.v1` carrying `entitlement_changed|trial_started|trial_ending|trial_expired|converted|plan_assigned` (Avro, envelope per MASTER-FR-030, outbox). Tables (identity-service DB, RLS): `plans`, `plan_entitlements`, `tenant_plan` (assignment + snapshot), `tenant_entitlement_overrides`, `tenant_commercial_state` (or columns on `tenants`), `trial_events`. Redis projection: `entitlements_flat:<tenant>`.
