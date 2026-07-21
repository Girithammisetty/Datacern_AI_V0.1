# BRD 23 — pack-service (Capability Pack Registry & Installer)

**Service:** pack-service · **Language:** Python (FastAPI) · **Phase:** 3 (marketplace tier = Phase 5)
**Inherits:** `00_MASTER_BRD.md` · **Architecture:** `../../DATACERN_PLATFORM_ARCHITECTURE.md` §5, §6, §9, §13
**Strategy source:** cross-vertical scaling wedge — one platform, N verticals delivered as signed, versioned, installable bundles instead of platform forks.

---

## 1. Overview

**Purpose.** pack-service owns the lifecycle of **Capability Packs**: versioned, signed bundles that ship a vertical solution (ontology, semantic models, dashboards, case schemas, role catalogs, eval sets, guardrails, pipeline templates, model archetypes, agent recipes) as one installable artifact. The service registers packs, verifies signatures, plans installations into a workspace, executes those plans as batches of proposal-mode writes across downstream services, tracks what a pack materialized, and reverses those changes on uninstall — without ever overwriting a user's edits. It also runs a governed **Marketplace** for tenants to discover packs published by Datacern, partners, or their own SIs.

**Business value.** In V1, every deployment is a bespoke engagement: analytics engineers rebuild the same claims-fraud dashboards, the same AML case fields, the same underwriting role catalog, per tenant. pack-service converts that per-tenant labor into a versioned artifact reused across tenants and verticals. A new tenant onboards a vertical in minutes; a new vertical is added by writing one pack rather than forking the platform. Because the pack is the *only* place vertical logic lives, the Core stays vertical-neutral and every core improvement benefits every vertical simultaneously. The signing/provenance chain plus a materialization ledger make packs auditable end-to-end, satisfying regulatory (EU AI Act, SR 11-7, NAIC Model 90) and supply-chain (SLSA-style) requirements out of the box.

**In scope:** pack manifest schema (v1) + validation; publisher and signing-key registry; pack CRUD, version lifecycle (draft → published), semver compatibility rules; install planning (dry-run diff), execution as an idempotent orchestration across downstream services, materialization ledger; upgrade with schema diff, rollback, uninstall preserving user overrides; marketplace listing + license enforcement + review workflow; discovery and search; health tracking against platform/service version changes; multi-cloud template resolution; MCP read tools for the pack catalog.

**Out of scope:** *runtime* execution of pack contents (each downstream service continues to own its objects at runtime — pack-service is orchestrator, not runtime); federated cross-cell marketplaces; pack-authored agents that bypass agent-runtime's proposal-mode rules (agents delivered by a pack are still registered normally and subject to §2.2-015, §9.4 of the architecture); cross-pack runtime coupling beyond declared dependencies; billing/settlements for paid marketplace listings (usage-service tier, future).

## 2. Actors & user stories

Personas: **Pack Author (PA)** — Datacern engineer, SI, or ISV who writes a pack; **Pack Steward (PS)** — customer role that approves what enters a tenant; **Tenant Admin (TA)** — installs/uninstalls; **Marketplace Curator (MC)** — Datacern team that reviews public listings; **Analyst / End User (AN)** — sees pack-provided artifacts; **Coding Agent (CA)** — implements per BRD; **Auditor (AU)**.

- **US-1** As PA, I write a `pack.yaml` manifest describing an *insurance-claims* pack (ontology, three semantic models, six dashboards, a case schema, an SLA policy, a role catalog, eval sets, guardrails, two pipeline templates), lint it locally against the v1 schema, and get errors that name exact JSON pointers before I ever upload.
- **US-2** As PA, I publish version `2.3.1` from CI; my org's signing key signs the bundle, pack-service verifies the signature, records the SLSA provenance, and stores the artifact in the OCI registry.
- **US-3** As TA, I `POST /installs?dry_run=true insurance-claims@2.3.1 workspace=W` and get a preview: what will be created, what already exists, what conflicts with user edits — nothing has changed in the platform yet.
- **US-4** As PS, I review that preview like any other proposal, approve, and pack-service executes the install as a single logical operation with idempotency; individual per-service writes are outboxed and reconciled.
- **US-5** As TA, I upgrade `insurance-claims@2.3.1 → 2.4.0`; pack-service computes the diff, shows me changed measures/dashboards/case fields, and applies only the delta; my analysts' custom dashboards remain untouched.
- **US-6** As TA, a bad upgrade forces me to `rollback` — pack-service reverses only what `2.4.0` added or changed, restoring the exact `2.3.1` state without touching my analysts' custom work.
- **US-7** As TA, I `uninstall` the pack; every artifact tagged `origin: pack:<urn>` is soft-deleted after a confirmation of dependent objects; user-cloned copies are kept.
- **US-8** As MC, I review a new public listing from an ISV, run the pack's eval sets, verify signatures, and approve it for the marketplace tier `verified`.
- **US-9** As TA, I browse the Marketplace filtered by *category=insurance* + *regulatory=NAIC-Model-90* + *cloud=azure*, see verified vs. community packs, and see each pack's cost-per-decision baseline from prior installs (opt-in benchmarking).
- **US-10** As PA, I declare `depends_on: core-financial-utils ^1.0`; pack-service refuses install if the dependency is missing or incompatible, and offers to plan its install first.
- **US-11** As AN, when I open a dashboard installed by a pack, I see a small pack badge with version and publisher; I can view the exact object provenance.
- **US-12** As AU, I export the pack ledger for tenant T over date range D — every install/upgrade/uninstall/rollback, who approved, signature verification result, materialized objects, and diffs — as a signed archive.
- **US-13** As TA, when the platform ships a breaking change (semantic-service publishes a schema-incompatible major version), pack-service marks affected installed packs `broken_refs`, blocks upgrades that would compound the break, and surfaces a resolution path.
- **US-14** As CA implementing a new downstream service, I register it as a **materialization target** with a typed contract (kind, apply endpoint, delete endpoint, uniqueness key, health probe); packs can immediately ship that kind without a pack-service code change.

## 3. Functional requirements

### Pack manifest & versioning
- **PKG-FR-001 (Must)** Manifest file `pack.yaml` (JSON-schema-validated), envelope:
  ```yaml
  pack_manifest: 1
  name: insurance-claims                 # ^[a-z][a-z0-9-]{2,63}$
  version: 2.3.1                          # strict semver
  publisher: { id: pub-datacern, name: "Datacern Inc.", contact: "packs@datacern.ai" }
  license: { spdx_id: "Apache-2.0" | "Commercial", url }
  description: "Claims triage + fraud detection for P&C insurers."
  categories: [insurance, claims, fraud]
  regulatory: [naic_model_90, nydfs_500]  # controlled vocabulary
  platform:
    min_version: "1.4.0"                  # datacern platform semver
    clouds: [aws, azure, gcp]             # supported clouds; runtime pack-service picks templates matching the cell's cloud
  depends_on: [{ pack: core-financial-utils, version: "^1.0.0" }]
  components: { … }                       # see PKG-FR-003
  ```
  Every field validated at author time (`POST /packs/{id}/versions` with `?lint=true`) and at publish time. Errors are structured `{code, json_pointer, message}`.

- **PKG-FR-002 (Must)** Versions are immutable after publish; new content requires a new version. Semver semantics enforced: MAJOR = breaking (removes/renames a materialized-object identity, changes measure semantics, changes a role's granted permissions); MINOR = additive; PATCH = content-only. Publish-time validator computes semver-required-bump vs. the last published version and rejects mislabeled versions (`SEMVER_BUMP_REQUIRED`).

- **PKG-FR-003 (Must)** **Components** section — every entry references artifacts by manifest-relative path, and each `kind` corresponds to a **materialization target** (PKG-FR-030):
  ```yaml
  components:
    semantic_models:   [{ file: "semantic/claims.yaml", identity: "claims" }]
    dashboards:        [{ file: "dashboards/fraud_overview.json", identity: "fraud_overview" }]
    case_schemas:      [{ file: "cases/high_severity_claim.yaml", identity: "high_severity_claim" }]
    role_catalog:      [{ file: "rbac/roles.yaml" }]
    eval_sets:         [{ file: "evals/fraud_golden.jsonl", identity: "fraud_golden" }]
    guardrails:        [{ file: "guardrails/claims.rego", identity: "claims" }]
    pipeline_templates:[{ file: "pipelines/nightly_retrain.yaml", identity: "nightly_retrain" }]
    model_archetypes:  [{ file: "models/xgb_fraud.yaml", identity: "xgb_fraud_v1" }]
    agent_recipes:     [{ file: "agents/triage_copilot.yaml", identity: "triage_copilot" }]
    connection_templates:[{ file: "sources/guidewire.yaml", identity: "guidewire_v10" }]
    ontology:          [{ file: "ontology/claims.yaml" }]
  ```
  `identity` (stable ID within the pack) is what upgrades match on across versions — renames within a pack are handled by declaring `previous_identity` on the changed entry.

- **PKG-FR-004 (Must)** **Provenance & signing.** Publish requires a detached signature over the canonical pack tarball (cosign / Sigstore keyless allowed; long-lived publisher keys allowed for tenant-tier). pack-service verifies at publish, on install, and periodically for installed packs (rekeying detection). SLSA provenance (build system, source ref, materials) stored alongside; `provenance.level` recorded (1–3+).

- **PKG-FR-005 (Should)** Packs are stored as **OCI artifacts** in the platform's registry (multi-cloud: ECR/ACR/Artifact Registry) with `application/vnd.datacern.pack.v1+tar` media type; the OCI digest is the canonical version reference and appears in every install ledger row.

- **PKG-FR-006 (Must)** Version lifecycle `draft → in_review → published | rejected`; a rejected or superseded published version stays retrievable (`?version=`). Publish is atomic and gated by lint + signature verify + eval-set schema check + semver bump check.

- **PKG-FR-007 (Should)** `deprecated: true` on a version blocks new installs but preserves existing installs; deprecation reason and successor version required.

### Installation lifecycle
- **PKG-FR-020 (Must)** `POST /installs` request `{pack, version, workspace_id, params?: {…}, dry_run?: bool}` → for `dry_run=true`, returns an **install plan** without side effects: `{operations: [{kind, target_urn, action: create|update|noop|conflict, diff?, conflict_reason?}], warnings, estimated_duration_s}`. For `dry_run=false`, returns `202 {operation_id}` and executes asynchronously; progress via SSE from realtime-hub.

- **PKG-FR-021 (Must)** Execution is a **transactional saga** across downstream services: each operation is an idempotent call to a service's materialization endpoint tagged with `origin: pack:<pack_urn>@<version>:<identity>` and `install_id`. Successful operations are recorded to `materialized_objects` before the next operation runs. On non-retriable failure, pack-service invokes each already-applied operation's compensating action in reverse order (using the same materialization contract's `revert` verb) and marks the install `rolled_back` with the failing operation captured. Retriable failures use the master idempotency contract (§2.4-032) and exponential backoff up to 5 attempts before failing the whole install.

- **PKG-FR-022 (Must)** **Conflict handling.** An operation whose target already exists AND has `origin != pack:<same identity>` OR has `edited_since_install=true` is marked `conflict` in the plan; the caller must resolve via `conflict_policy` in the request: `skip` (default) | `overwrite_pack_created` (only overwrites objects still tagged `origin: pack` AND `edited_since_install=false`) | `abort`. **`overwrite_user_edits` is not a valid value** — packs never silently replace user work.

- **PKG-FR-023 (Must)** **Upgrade.** `POST /installs/{install_id}/upgrade {to_version}` computes the diff between the currently-installed manifest and the target version's manifest (by `identity`): added, removed, changed, renamed. Applies only the delta, again as a dry-run-then-execute flow. Removed items: soft-delete only if the object is still `origin: pack` AND `edited_since_install=false`; otherwise it is retained and marked `orphaned_from_pack` (visible in UI). Reversal of the whole upgrade is available for 30 days via a `rollback_snapshot` captured pre-apply.

- **PKG-FR-024 (Must)** **Rollback.** `POST /installs/{install_id}/rollback` reapplies the `rollback_snapshot` of the last upgrade. Same conflict rules apply. Only one level of rollback is guaranteed (per snapshot); multi-hop restoration is out of scope.

- **PKG-FR-025 (Must)** **Uninstall.** `POST /installs/{install_id}/uninstall {mode: soft|purge}` — `soft` deletes only objects still `origin: pack` AND `edited_since_install=false`, retaining edited or orphaned objects (they lose the `pack` origin marker); `purge` requires an additional `confirm_dependent_count` matching the ledger's dependent-object count and removes edited pack-origin objects too (never user-created objects). Both modes leave `materialized_objects` rows in a `tombstoned` state for audit.

- **PKG-FR-026 (Must)** **User-edit tracking.** Downstream services emit `<resource>.updated` events (already required by master); pack-service consumes those events for every URN in its `materialized_objects` table and sets `edited_since_install=true` whenever the updater is not pack-service itself and the diff touches fields the pack originally set. This is the sole source of truth for §PKG-FR-022, §PKG-FR-023, §PKG-FR-025 "user override" logic.

- **PKG-FR-027 (Must)** Every operation has a timeout matching the downstream service's write-p95 × 5; timed-out operations are marked `unknown` and reconciled by a background job that queries the downstream service for the URN's state before deciding retry vs. compensating action.

### Materialization contract (per-kind extensibility)
- **PKG-FR-030 (Must)** Each downstream service supporting pack materialization registers a **materialization target** with pack-service (config-driven, no pack-service code change):
  ```yaml
  kind: semantic_model
  service: semantic-service
  apply:  { method: POST,  path: "/api/v1/models/import",  body_template: "…" }
  revert: { method: DELETE, path: "/api/v1/models/{materialized_id}?origin={origin}&install_id={install_id}" }
  probe:  { method: GET,   path: "/api/v1/models/{materialized_id}" }
  identity_response_field: "id"    # what pack-service stores in materialized_objects
  supports_edited_flag: true       # target service tracks user edits
  ```
  pack-service ships a default registry covering: `semantic_model`, `dashboard`, `chart_template`, `case_schema`, `case_field`, `sla_policy`, `role_catalog_entry`, `permission_group_seed`, `eval_set`, `guardrail_policy`, `pipeline_template`, `model_archetype`, `agent_recipe`, `connection_template`, `ontology_concept`. New kinds are added by publishing a new target row + the downstream service exposing the endpoints; pack-service reloads at boot and on `POST /materialization-targets`.

- **PKG-FR-031 (Must)** Every apply request carries `Idempotency-Key: <install_id>:<component.identity>` (per master §2.3-025). Retries return the same materialized object.

- **PKG-FR-032 (Must)** Every materialization target must accept `origin=pack:<pack_urn>@<version>:<identity>` and expose it on the created object (URN metadata field). Downstream services must reject any `origin=pack:*` payload not called by pack-service's SPIFFE identity.

- **PKG-FR-033 (Should)** **Multi-cloud template resolution:** components may include per-cloud sub-files (`file: "sources/warehouse.{cloud}.yaml"`), resolved at install time against the cell's cloud; a pack advertising `clouds: [aws]` cannot install into an Azure cell (`INCOMPATIBLE_CLOUD`).

### Display labels (plain-English rendering, MASTER-FR-094 support)

- **PKG-FR-041 (Must)** New component kind `display_labels` — file: YAML/JSON referencing keys from the canonical label-key registry shipped with the platform (bff-graphql §BFF-FR-088):
  ```yaml
  display_labels:
    locale: en
    keys:
      case.singular:       "Claim"
      case.plural:         "Claims"
      case.action.resolve: "Close claim"
      case.column.id:      "Claim ID"
      case.status.resolved: "Closed"
      dashboard.action.publish: "Publish view"
      cost.not_tracked:    "Cost not tracked"
    entity_templates:
      case:      "Claim #{id}"
      dashboard: "{name}"
      dataset:   "{name}"
  ```
  Only registry keys accepted; unknown keys are rejected at publish time with `VALIDATION_FAILED` naming the offending keys. Multiple `display_labels` component entries per pack are allowed (one per locale). Materialization target: a workspace-scoped `display_labels_binding` row per pack install that pack-service owns; downstream services (bff-graphql, ui-web) read via §PKG-FR-042.
- **PKG-FR-042 (Must)** New endpoint `GET /packs/labels?workspace_id=&locale=` returning the merged label map for a workspace: platform baseline (from the shipped registry) overlaid with every installed pack's `display_labels` values in install order (latest install wins on collision, with `sourcePack` metadata attached per key). Response shape matches the contract in bff-graphql §BFF-FR-082 (`{workspace_id, locale, keys, entity_templates, source_packs, generated_at, platform_default_key_count}`). Response cache: BFF layer LRU (§BFF-FR-084) + this service memoizes per (workspace, locale) for 5 min; cache invalidation on install/uninstall/pack-version-publish events (emit `packs.labels_invalidated {workspace_id}` via `pack.events.v1` — consumed by realtime-hub for fan-out to ui-web).
- **PKG-FR-043 (Should)** Locale fallback contract: a pack ships one `display_labels` component per supported locale (`display_labels.en.yaml`, `display_labels.fr.yaml`); the endpoint's locale resolution falls back per key: requested → pack's declared fallback locale (`display_labels.fallback_locale`) → platform default `en`. Fallbacks logged in `source_packs` metadata for observability, never surfaced to end users.
- **PKG-FR-044 (Should)** Label-key registry validation at publish: pack-service loads the platform's canonical registry manifest (version-pinned per platform release) and rejects any pack whose `display_labels.keys` include keys not in the registry. This is the CI counterpart to bff-graphql §BFF-FR-088 preventing drift between UI primitives requesting keys and packs providing them.

### Marketplace, discovery, licensing
- **PKG-FR-050 (Must)** Three registry tiers: `private` (visible only to publisher tenant), `tenant-shared` (visible to tenants explicitly granted access by publisher), `marketplace` (public listing). Tier is per-version; a pack may have `2.3.0 private` and `2.4.0 marketplace`.
- **PKG-FR-051 (Must)** Marketplace tier requires MC approval; approval workflow like verified queries (author ≠ approver; decision note; audit trail). Approval verifies signature, runs pack eval sets, and reviews license terms. States: `submitted → in_review → approved | rejected`.
- **PKG-FR-052 (Must)** `GET /marketplace/packs` — search (pgvector over description + categories; facet filters: category, regulatory, cloud, publisher, tier, license type). Each result includes: latest published version, dependency graph, verified badge, install count, average install latency, publisher trust signal.
- **PKG-FR-053 (Should)** **License enforcement.** `license.type: commercial` packs require a valid `entitlement` per tenant (issued out-of-band, stored in `pack_entitlements`); install is refused without entitlement (`LICENSE_REQUIRED`). Trial entitlements carry expiry; expired entitlements block upgrades but not runtime use.
- **PKG-FR-054 (Should)** **Anonymized benchmarking.** Installers may opt in per-workspace to publish install duration, ingestion→first-case latency, override rate, and cost-per-decision aggregates (no row-level data) to the pack's marketplace page. Opt-out is the default.

### Health, MCP tools, discovery
- **PKG-FR-070 (Must)** Consuming `platform.events.v1 :: service.contract_version_changed` and `semantic.events.v1 :: model.health_changed` — pack-service marks affected `pack_installs` with `health.status = degraded | broken` and lists `broken_refs`. `pack.install_health_changed` event emitted.
- **PKG-FR-071 (Must)** MCP read tools (registered in tool-registry): `list_installed_packs(workspace?)`, `describe_pack(pack, version?)`, `search_marketplace(q, filters?)`, `get_install_health(install_id)`. Agents can *propose* an install as a case, but cannot execute one directly (proposal flows through `case-service` and requires human approval — mirrors §9 architecture).
- **PKG-FR-072 (Should)** `POST /packs/{id}/versions/{v}:preview_diff?against_version=` returns the semantic diff (added, removed, changed identities) used by UI and CI.

## 4. Domain model & data

### 4.1 Tables (Postgres, RLS)

- **publishers** — `id uuidv7 PK`, `tenant_id NULL` (`NULL` = platform-owned), `name`, `contact_email`, `verified bool`, `trust_signal jsonb`, timestamps. Publishers with `tenant_id = NULL` are managed by Datacern; tenant publishers scope pack visibility.
- **signing_keys** — `id`, `publisher_id FK`, `key_type text (cosign_keyless|cosign_key|sigstore_fulcio)`, `identity text` (issuer/subject or key fingerprint), `revoked_at NULL`, `notes`, timestamps. Unique per (publisher, identity).
- **packs** — `id uuidv7 PK`, `tenant_id NULL`, `publisher_id FK`, `name text` (^[a-z][a-z0-9-]{2,63}$), `description`, `latest_published_version_id NULL`, `default_tier text (private|tenant-shared|marketplace)`, `deleted_at`, timestamps. `UNIQUE (publisher_id, lower(name))`.
- **pack_versions** — `id`, `pack_id FK`, `semver text` (validated), `status text (draft|in_review|published|rejected|superseded|deprecated)`, `oci_digest text` (canonical artifact), `manifest jsonb ≤ 256KB` (or `manifest_ref` object-storage pointer above 64KB per master §2.7-061), `signatures jsonb`, `slsa_provenance jsonb`, `platform_min_version text`, `clouds text[]`, `depends_on jsonb`, `deprecated_reason text NULL`, `successor_version_id NULL`, timestamps. `UNIQUE (pack_id, semver)`. Immutable from `in_review` onward. Publish-time enforced constraint: cannot publish without a signature row.
- **materialization_targets** — `id`, `kind text UNIQUE`, `service_name`, `apply_spec jsonb`, `revert_spec jsonb`, `probe_spec jsonb`, `identity_response_field text`, `supports_edited_flag bool`, timestamps. Bootstrapped from a shipped defaults file; runtime-mutable via authenticated `POST /materialization-targets`.
- **pack_installs** — `id`, `tenant_id`, `workspace_id`, `pack_id FK`, `current_version_id FK`, `status text (planning|installing|installed|degraded|broken|uninstalled|rolled_back|failed)`, `entitlement_id NULL`, `installed_by`, `params jsonb`, `health jsonb (broken_refs[])`, `rollback_snapshot jsonb NULL`, timestamps. `UNIQUE (tenant_id, workspace_id, pack_id) WHERE status <> 'uninstalled'`.
- **install_operations** — `id`, `install_id FK`, `sequence int`, `kind text`, `target_urn text`, `action text (create|update|noop|revert|conflict)`, `status text (pending|applied|failed|reverted|tombstoned|unknown)`, `payload_digest text`, `error jsonb NULL`, `attempts int`, `duration_ms int`, timestamps. Indexed `(install_id, sequence)`, `(status)` for reconciliation.
- **materialized_objects** — `id`, `install_id FK`, `pack_version_id FK`, `component_identity text`, `kind text`, `urn text NOT NULL`, `materialized_id text NOT NULL`, `origin text` (`pack:<pack_urn>@<version>:<identity>`), `applied_fields jsonb` (what pack originally set), `edited_since_install bool DEFAULT false`, `last_edit_at timestamptz NULL`, `state text (live|orphaned_from_pack|tombstoned)`, timestamps. `UNIQUE (install_id, component_identity)`. Indexed `(tenant_id, urn)`, `(kind, edited_since_install)`.
- **marketplace_listings** — `id`, `pack_version_id FK UNIQUE`, `status text (submitted|in_review|approved|rejected|withdrawn)`, `submitted_by`, `reviewed_by NULL`, `decision_note`, `curator_evals jsonb`, `benchmarks jsonb`, timestamps.
- **pack_entitlements** — `id`, `tenant_id`, `pack_id FK`, `granted_versions text` (semver range or exact set), `expires_at NULL`, `metadata jsonb`, timestamps.
- **install_events_ledger** — append-only audit ledger: `id`, `install_id FK`, `event_type text`, `actor jsonb`, `via_agent jsonb NULL`, `payload jsonb`, `created_at`. Monthly partitions, 7-year retention (regulatory).
- Standard `outbox`, `idempotency_keys`.

### 4.2 State machines

**Pack version:**

| From | To | Trigger | Guard |
|---|---|---|---|
| draft | in_review | author submits | lint green, signature valid, semver bump matches diff class |
| in_review | published | curator/CI approves | approver ≠ author (marketplace tier); eval sets pass; provenance level ≥ 1 |
| in_review | rejected | approver rejects | decision note required |
| rejected | draft | author revises | manifest editable again; no new semver until re-submit |
| published | superseded | newer published | automatic |
| published | deprecated | publisher marks | `deprecated_reason` + optional `successor_version_id` required |

Content immutable from `in_review` onward. `oci_digest` immutable once written.

**Pack install:**

| From | To | Trigger | Guard |
|---|---|---|---|
| planning | installing | approver accepts plan | plan not stale (<15 min old), entitlement present if needed |
| installing | installed | all ops applied | zero unresolved ops |
| installing | failed | non-retriable failure | reverts applied ops first (transitions each op to `reverted`) |
| installed | installing | upgrade/rollback triggered | snapshot captured |
| installed | degraded | dependency broken (§PKG-FR-070) | health payload populated |
| degraded | broken | further break | additive |
| installed / degraded | uninstalled | uninstall applied | `soft` or `purge` semantics per §PKG-FR-025 |
| installed | rolled_back | rollback applied | snapshot present |

### 4.3 Error code catalog

`VALIDATION_FAILED` (422 manifest lint) · `SEMVER_BUMP_REQUIRED` (422) · `SIGNATURE_INVALID` (422) · `PROVENANCE_MISSING` (422) · `INCOMPATIBLE_PLATFORM_VERSION` / `INCOMPATIBLE_CLOUD` (409) · `DEPENDENCY_MISSING` / `DEPENDENCY_VERSION_CONFLICT` (409) · `LICENSE_REQUIRED` / `LICENSE_EXPIRED` (402/409) · `INSTALL_CONFLICT` (409, per-operation `conflict_reason`) · `PLAN_STALE` (409, replan required) · `MATERIALIZATION_TARGET_UNKNOWN` (422 unknown `kind`) · `UPSTREAM_UNAVAILABLE` (503 with retriable flag) · `PACK_NOT_FOUND` / `INSTALL_NOT_FOUND` (404, cross-tenant returns 404) · `ROLLBACK_NOT_AVAILABLE` (409, no snapshot) · `TIER_APPROVAL_REQUIRED` (403 marketplace).

## 5. API specification (base `/api/v1`)

| Method & path | Purpose | Notable errors |
|---|---|---|
| `POST /publishers` · `GET /publishers` · `PATCH /publishers/{id}` | publisher CRUD (platform admins for verified) | 409 name |
| `POST /publishers/{id}/signing-keys` · `GET /publishers/{id}/signing-keys` · `DELETE /publishers/{id}/signing-keys/{keyId}` | key registry | |
| `POST /packs` · `GET /packs` · `GET /packs/{id}` · `PATCH /packs/{id}` · `DELETE /packs/{id}` | pack CRUD | 409 name |
| `POST /packs/{id}/versions` (`?lint=true`) · `GET /packs/{id}/versions` · `GET /packs/{id}/versions/{v}` · `PATCH /packs/{id}/versions/{v}` (draft only) | version lifecycle | 422 lint, 409 not-draft |
| `POST /packs/{id}/versions/{v}/submit` · `/approve` · `/reject` | review workflow | 403, 409 |
| `POST /packs/{id}/versions/{v}:preview_diff?against_version=` | semantic diff | |
| `POST /installs?dry_run=true` | plan install | 422/409 |
| `POST /installs` · `GET /installs` · `GET /installs/{id}` | execute install, list, get | 202 operation |
| `POST /installs/{id}/upgrade` · `/rollback` · `/uninstall` | lifecycle actions | 409 state, 409 rollback |
| `GET /installs/{id}/operations` · `GET /installs/{id}/materialized-objects` · `GET /installs/{id}/ledger` | inspection | |
| `POST /marketplace/listings` · `GET /marketplace/packs` · `GET /marketplace/packs/{id}` · `POST /marketplace/listings/{id}/approve|reject|withdraw` | marketplace | 403 curator only |
| `POST /pack-entitlements` · `GET /pack-entitlements` · `DELETE /pack-entitlements/{id}` | licensing | |
| `POST /materialization-targets` · `GET /materialization-targets` | target registry | 409 kind |

Example — install plan (dry run):
```json
POST /api/v1/installs?dry_run=true
{"pack":"insurance-claims","version":"2.3.1","workspace_id":"018f-w-1","conflict_policy":"skip"}
→ 200 {"data":{
  "plan_id":"018f-plan-…","operations":[
    {"sequence":1,"kind":"semantic_model","identity":"claims","action":"create","target_urn":null,"payload_digest":"sha256-…"},
    {"sequence":2,"kind":"dashboard","identity":"fraud_overview","action":"create","target_urn":null},
    {"sequence":3,"kind":"case_schema","identity":"high_severity_claim","action":"update","target_urn":"wr:t-42:case:schema/hsc","diff":{"added_fields":["siu_flag"]}},
    {"sequence":4,"kind":"role_catalog_entry","identity":"claims_adjuster","action":"conflict","conflict_reason":"edited_since_install"}
  ],
  "warnings":["one component skipped due to conflict; use conflict_policy=overwrite_pack_created to force"],
  "estimated_duration_s": 22,
  "expires_at":"…+15min"}}
```

Example — execute install:
```json
POST /api/v1/installs
{"pack":"insurance-claims","version":"2.3.1","workspace_id":"018f-w-1","conflict_policy":"skip","plan_id":"018f-plan-…"}
→ 202 {"data":{"install_id":"018f-inst-…","operation_id":"018f-op-…","status":"installing"}}
```

Example — MCP tool `describe_pack`:
```json
{"name":"describe_pack","arguments":{"pack":"insurance-claims"}}
→ {"pack":"insurance-claims","publisher":"Datacern Inc.","verified":true,
   "versions":[{"semver":"2.4.0","status":"published","clouds":["aws","azure","gcp"],
                "components_summary":{"semantic_models":3,"dashboards":6,"case_schemas":2,
                                     "eval_sets":4,"pipeline_templates":2,"agent_recipes":1},
                "regulatory":["naic_model_90","nydfs_500"],"depends_on":[{"pack":"core-financial-utils","version":"^1.0.0"}]}],
   "install_count":214,"average_install_seconds":19,"license":"Apache-2.0"}
```

Example — install ledger row:
```json
{"event_id":"018f…","event_type":"install.completed","actor":{"type":"user","id":"u-77"},
 "via_agent":null,"payload":{"pack":"insurance-claims","version":"2.3.1",
 "oci_digest":"sha256:…","operations_applied":42,"warnings":1},"created_at":"…"}
```

## 6. Events

**Emitted → `pack.events.v1`:** `pack.version_submitted / published / rejected / deprecated {oci_digest, semver}`, `pack.install_planned {plan_id, operation_count}`, `pack.install_started`, `pack.install_completed {materialized_count}`, `pack.install_failed {failed_op_urn, error}`, `pack.install_rolled_back`, `pack.uninstall_completed {mode}`, `pack.install_health_changed {status, broken_refs[]}`, `pack.marketplace_listed / listing_approved / listing_rejected`, `pack.entitlement_granted / revoked`.

**Consumed:**
- `semantic.events.v1 :: model.health_changed` → recompute install health if the model is pack-materialized (§PKG-FR-070).
- `chart.events.v1 :: chart.updated`, `case.events.v1 :: schema.updated`, `rbac.events.v1 :: role.updated`, `eval.events.v1 :: dataset.updated`, `guardrail.events.v1 :: policy.updated`, `pipeline.events.v1 :: template.updated` → all URNs matched against `materialized_objects`; if updater is not pack-service and diff touches `applied_fields`, set `edited_since_install=true` and stamp `last_edit_at` (§PKG-FR-026).
- `rbac.events.v1 :: workspace.deleted` → cascade uninstall (soft) for that workspace's installs.
- `platform.events.v1 :: service.contract_version_changed` → mark affected installs `degraded` if breaking.

All consumers idempotent; DLQ per master §2.4-033.

## 7. Business rules & edge cases

- **BR-1** No pack write ever bypasses the materialization contract. pack-service never opens a downstream service's database — only its published `apply`/`revert`/`probe` endpoints. This keeps ownership of runtime schemas with the owning service.
- **BR-2** `origin: pack:<…>` is set by pack-service in the apply body; downstream services MUST reject `origin=pack:*` unless the caller is pack-service (SPIFFE identity check). This prevents a compromised agent from claiming pack provenance for its writes.
- **BR-3** User-edit detection is **field-scoped**: only edits that touch `applied_fields` (what the pack originally set) flip `edited_since_install`. Adding a new tile to a pack-installed dashboard does not mark the dashboard user-edited; changing a tile the pack originally set does.
- **BR-4** Install plan expiry: a plan is valid for 15 minutes; executing an expired plan → 409 `PLAN_STALE`, requiring replan. Prevents TOCTOU races against concurrent tenant edits.
- **BR-5** Two concurrent installs of the same pack into the same workspace are prevented by a per-`(tenant, workspace, pack)` advisory lock; the second returns 409 `CONFLICT`.
- **BR-6** Dependency install order: for `depends_on`, pack-service refuses install if the dependency is missing (`DEPENDENCY_MISSING`) and offers `?with_dependencies=true` to plan a dependency chain in one transaction; version conflicts across chained installs → 409 `DEPENDENCY_VERSION_CONFLICT` with the resolution set.
- **BR-7** Signature verification is repeated on every install regardless of prior verification; keys revoked between publish and install fail install (`SIGNATURE_INVALID`), preserving supply-chain integrity.
- **BR-8** Uninstall never deletes user-created objects, even if they reference pack-installed objects; instead, dependent user objects are surfaced in the response with URNs so the operator decides.
- **BR-9** Rollback snapshot is a *manifest* snapshot plus the pre-upgrade `materialized_objects` state, not a data snapshot; case rows, dashboard data, and model runs created during the upgrade window persist across rollback.
- **BR-10** A pack version supporting `clouds: [aws, azure]` installing into a `gcp` cell → 409 `INCOMPATIBLE_CLOUD`; `clouds: [any]` is disallowed by the manifest schema — cloud support must be explicit.
- **BR-11** `case_schema` components installed into a workspace that already has cases open on the same dataset: pack-service adds new fields (nullable), deprecates removed fields (does not drop columns while historical cases retain them). Actual DDL is case-service's responsibility per its BRD.
- **BR-12** Agent recipes installed by a pack register with `agent-runtime` as **proposal-mode** even if the recipe declares autonomous mode; overriding this requires tenant policy explicitly whitelisting the pack (defense against a malicious pack).
- **BR-13** Marketplace search results are strictly filtered by tenant entitlement + tier; `private` packs never leak into another tenant's results even by title.
- **BR-14** The materialized-objects ledger is authoritative for uninstall and audit; if a downstream service reports an object exists that the ledger does not know about, pack-service **does not** touch it.
- **BR-15** Manifest size caps: `pack.yaml` ≤ 512KB; total artifact ≤ 200MB; ≥ 200MB rejected at publish. Individual component files ≤ 64KB inline, larger goes to OCI-layered files referenced by digest.
- **BR-16** Cross-tenant access returns 404 + `security.cross_tenant_denied` audit event (per master §2.1-003). Marketplace listings visible to all tenants but their install requires tenant-scoped entitlement checks.

## 8. Dependencies

- **Upstream:** semantic-service, chart-service, case-service, rbac-service, eval-service, guardrail-service, pipeline-orchestrator, experiment-service, agent-runtime, ingestion-service (connection-templates), memory-service (agent-recipes), tool-registry (agent recipes register tools) — all as materialization targets. identity-service (JWT), rbac-service + OPA (authorization), realtime-hub (install progress SSE), audit-service (ledger consumer).
- **Infra:** OCI registry (ECR/ACR/AR) for pack artifacts; Sigstore/Fulcio for keyless signing; object storage for large `manifest_ref`; Kafka; Redis (plan cache, idempotency); pgvector (marketplace search).
- **Contracts:**
  - **Materialization target contract** (§PKG-FR-030): every service supporting packs must expose `apply`, `revert`, `probe` and honor the `origin` field. This is a hard release gate — new pack kinds require the target service to ship the contract first.
  - **Edit-detection contract:** downstream services emit `updated` events with `actor` and a stable field-set the update touched (already required by master §2.4-030). Without this, `edited_since_install` cannot be maintained; pack-service degrades to "assume edited" on ambiguous updates.

## 9. NFRs (deltas from master)

- Install execution p95 ≤ 60s for packs ≤ 50 operations; ≤ 5min for packs ≤ 500 operations (bounded by downstream apply latencies).
- Install plan generation p95 ≤ 2s (dry-run, no side effects).
- Marketplace search p95 ≤ 200ms at 10K listings.
- Signature verification p95 ≤ 500ms (Sigstore transparency log fetch cached ≤ 1h).
- Storage: OCI artifacts unbounded (registry-owned); Postgres `install_events_ledger` retention 7 years partitioned monthly; `materialized_objects` retention = lifetime of install + 90 days after uninstall for audit.
- Idempotency: installing the same `(pack, version, workspace, plan_id)` twice within 24h is a no-op returning the original result (per master §2.3-025).
- Availability of the install path is not on the auth critical path; SLO 99.9% (not 99.99%).

## 10. Acceptance criteria

- **AC-1** Given a valid `pack.yaml` for `insurance-claims@2.3.1` signed with a registered publisher key, when I `POST /packs/{id}/versions/2.3.1/submit` then `/approve` (curator ≠ author), then the version becomes `published`, `oci_digest` is populated, `slsa_provenance` is stored, and `pack.version_published` is emitted with the digest.
- **AC-2** Given `depends_on: core-financial-utils ^1.0.0` and no such pack installed in the workspace, when I `POST /installs?dry_run=true`, then the response is 409 `DEPENDENCY_MISSING` listing the missing dep; retrying with `?with_dependencies=true` produces a plan that installs the dependency first.
- **AC-3** Given a plan whose `case_schema` operation is marked `conflict` with `edited_since_install=true`, when I execute with `conflict_policy: skip`, then that operation is a `noop` and every other operation applies; when I execute with `conflict_policy: overwrite_pack_created`, the operation still skips because the target was user-edited; only if I first revert the user edit does it overwrite.
- **AC-4** Given a mid-install failure on operation 7 of 12, then pack-service invokes each already-applied operation's `revert` in reverse order, `install.failed` event carries `failed_op_urn`, and `install_operations` rows have `status ∈ {applied→reverted, failed, pending}` reflecting the sequence.
- **AC-5** Given `insurance-claims@2.3.1 → 2.4.0` upgrade where a measure was renamed via `previous_identity`, then the materialized measure is updated (not created + deleted), its URN is preserved, and the diff reports `renamed: 1`; then `POST /installs/{id}/rollback` restores the prior manifest and the measure's original identity, and dependent charts still resolve.
- **AC-6** Given a pack advertising `clouds: [aws, azure]` installed into a GCP cell, then install fails 409 `INCOMPATIBLE_CLOUD` before any operation runs; a per-cloud template file `sources/warehouse.gcp.yaml` referenced via `{cloud}` substitution correctly picks the AWS variant in an AWS cell.
- **AC-7** Given a soft uninstall of a pack whose `fraud_overview` dashboard the analyst added two tiles to, then the dashboard is retained with `origin` cleared and `orphaned_from_pack=true`, while a role catalog entry the pack fully owned (unedited) is soft-deleted; `install.uninstall_completed` payload lists 1 retained, 1 removed.
- **AC-8** Given a publisher whose signing key is revoked between publish and install, then install fails `SIGNATURE_INVALID` and no operations run; the existing installed version continues functioning but is marked `signature_stale` in health.
- **AC-9** Given tenant A's token requesting install of a `private` pack owned by tenant B's publisher, then 404 + `security.cross_tenant_denied` audit event.
- **AC-10** Given a `MAJOR` upgrade published as `PATCH` (removes a measure while carrying `2.3.1 → 2.3.2`), then publish fails `SEMVER_BUMP_REQUIRED` with the offending diff paths.
- **AC-11** Given an agent invoking MCP `list_installed_packs` under an OBO token for workspace W, then only that workspace's installs return; `describe_pack` for a marketplace pack returns publisher, versions, and dependency graph but not tenant-specific install detail; `ai.tool_invoked.v1` audit event is emitted.
- **AC-12** Given two concurrent `POST /installs` calls for the same `(pack, version, workspace)`, then the second returns 409 `CONFLICT` immediately (advisory lock), never producing duplicate materialized objects.
- **AC-13** Given a downstream service reports 503 on a materialization apply call, then pack-service retries with exponential backoff up to 5 attempts (per master idempotency contract), preserves `Idempotency-Key: <install_id>:<identity>`, and fails the install with `UPSTREAM_UNAVAILABLE` only after retries are exhausted.
- **AC-14** Given a `pack.updated` event for a dashboard whose actor is a user and whose diff touches a field in `applied_fields`, then `materialized_objects.edited_since_install` flips to `true` within 5s and appears in the next plan's conflict detection.
- **AC-15** Given a curator approving a marketplace listing, then `marketplace_listings.status=approved`, signature verification re-runs, eval sets execute and results are stored in `curator_evals`, and the pack becomes globally discoverable but installs still require entitlement for commercial licenses.
- **AC-16** Given a purge uninstall attempted without the expected `confirm_dependent_count`, then the request is rejected 409 with the current dependent count in the error `details`; supplying the correct count in a follow-up call succeeds and removes pack-origin objects even if user-edited (but not user-created).

## 11. Out of scope / future

- Federated / cross-cell marketplace synchronization (each cell hosts an independent Marketplace mirror initially).
- Cross-pack runtime coupling (packs share the *platform* at runtime, not each other; declared `depends_on` is install-time only).
- Automatic remediation of `broken_refs` (pack-service surfaces breakage; publishers ship patch versions to resolve).
- Paid marketplace settlements, billing, revenue share (usage-service tier will host this).
- Pack-authored *guardrail bypasses* — packs may add guardrails, never disable platform ones.
- NL-driven pack authoring (agents may draft manifests via the case/proposal flow later; the compiler remains a code-time tool).
- Multi-region pack replication SLAs (initially registry-native replication; per-cell caches).
- "Pack composition" (a pack that transcludes another pack's components) — for now the only reuse mechanism is `depends_on`, which shares nothing at runtime.
