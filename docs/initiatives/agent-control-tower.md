# Agent Control Tower & Compliance Inventory

**Status:** design — 2026-07-25
**Related:** [BRD 68](../brd/68_agent_control_tower_BRD.md) (this initiative's spec) · BRD 14 (agent-runtime) · BRD 16 (eval-service) · BRD 17 (usage-service) · BRD 18 (audit-service) · BRD 53 (persona/custom agents + guardrail envelope) · BRD 60 (external agent governance) · [`DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md`](../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md) §5 A1 ("Ship the Agent Control Tower surface") + A6 ("Compliance artifacts as product output")

---

## 1. Analysis

### 1a. Platform / product

Datacern already built every control a fleet-governance buyer asks for — agent
catalog + immutable versions + signed A2A cards (BRD 14), canary/shadow/pin/
rollback (BRD 14 ART-FR-060..063), kill switches (BRD 14 ART-FR-063), eval
gates that block publish (BRD 16), per-agent guardrail envelopes (BRD 53), and
external-agent governance with a hardened allow-list (BRD 60, done
2026-07-23). None of it is visible as *one screen*. `/admin/agents` today
shows kill switches and the raw agent catalog side by side — an operator has
to already know which of four other services to check for eval status, spend,
or decision history. There is no "what AI is running here, is it healthy, and
what did it cost" answer in one place, and no exportable artifact a risk team
can file as EU AI Act system-inventory evidence.

This matters commercially, not just operationally. ServiceNow's AI Control
Tower and Microsoft's "agents as managed identities" framing made fleet-level
agent governance an *expected* enterprise surface (roadmap §3.2). For
Datacern this is unusually high value-per-effort: the roadmap classifies it
S–M effort because ~90% of the underlying data already exists (roadmap §8
row 5) — the work is aggregation, presentation, and one export, not new
enforcement. The buyer's risk/compliance team is a second, distinct budget
holder from the buyer's platform team, and the inventory export is the
artifact that budget pays for (roadmap A6).

Once built: a Tenant Admin / AI Risk Officer sees every agent that can act in
their tenant — internal, tenant-custom (BRD 53), external (BRD 60) — with
lifecycle state, guardrails, spend, and eval status in one table, with
one-click kill reusing existing authz; an Auditor exports a versioned,
checksummed inventory that files as evidence without a bespoke query.

### 1b. Technical

#### What `/admin/agents` renders today

`services/ui-web/src/app/(app)/admin/agents/page.tsx:25` (`AdminAgentsPage`)
renders four independent cards, each backed by its own single-source GraphQL
query — there is no cross-service aggregation and no fleet-wide row today:

- `AgentKillSwitchesCard` (`page.tsx:65`) — a `DataTable` of kill switches
  (`killSwitchColumns`, `page.tsx:47`: target/scope/version/tenant/reason/
  set-by/since) wrapped in `AsyncBoundary`, with a master-detail
  `KillSwitchDetail` side panel (`page.tsx:124`) exposing a gated "Lift"
  action (`page.tsx:165`, `FEATURE_GATES.liftAgentKillSwitch`) behind
  `ConfirmDialog`. Backed by `useAgentKillSwitches`
  (`src/lib/graphql/hooks.ts:3636`) → GraphQL `agentKillSwitches` →
  agent-runtime `GET /api/v1/registry/kill-switches`
  (`services/agent-runtime/app/api/routes/registry.py:622-638`).
- `ToolKillSwitchesCard` (`page.tsx:252`) — the tool-plane mirror of the above.
- `AgentCatalogCard` (`src/components/admin/AgentCatalogCard.tsx:27`) — browses
  `Query.agentDefinitions`, a single-source passthrough
  (`services/bff-graphql/src/resolvers/index.ts:1661-1662`) of agent-runtime
  `GET /api/v1/registry/agents` (`registry.py:82-99`).
- `OperatorCeilingsCard` — reads/writes the platform guardrail ceilings
  (`registry.py:468-503`), operator-only.

No stat tiles, no per-row drill-in (no `/admin/agents/[key]` route exists —
confirmed by search), and no realtime subscription in this file today (no
`useHubTopics` call in `page.tsx`).

#### What each source service already exposes, exactly

**agent-runtime** (`services/agent-runtime`):
- Catalog seed: `app/agents/catalog.py:14` — module-level `CATALOG` dict
  (`key -> (display, description, write_mode, graph_ref, skills)`) for the 9
  platform agents. `_publish_agent_version` (`catalog.py:99-115`) is where
  `model_config = {"request_class": "chat", "max_rung": 1, "temperature": 0.2}`
  and `memory_policy = {"scopes_readable": [...], "scopes_writable": []}` are
  set per version.
- `AgentDefinition` (`app/domain/entities.py:38-48`) carries `owner_tenant:
  str | None` — `None` = platform agent, set = a tenant-custom agent
  (BRD 53), visible/runnable only in that tenant. **There is no `kind` field
  distinguishing `external`** — the only signal an external agent's
  `AgentVersion` carries is `graph_ref = "external"`, a convention introduced
  only in the operator demo script
  (`deploy/demo/brd60_external_agent.py:90`), never formalized as an enum or
  documented discriminator in the domain model.
- `GET /api/v1/registry/agents` (`registry.py:82-99`, `_definition_view` at
  `registry.py:53-57`) → `{agent_key, display_name, description, owner_team,
  default_write_mode, status, latest_published_version}`. Thin — no
  toolset/guardrails/version detail.
- `GET /api/v1/registry/agents/{agent_key}/versions` (`registry.py:102-112`,
  `_version_view` at `registry.py:60-65`) → `{agent_key, version, status,
  graph_ref, graph_digest, guardrail_profile, eval_gate_result_id, toolset,
  model_config}`. Does **not** surface `memory_policy`, `prompt_refs`,
  `a2a_card`, or `principal_ref`, which exist on `AgentVersion`
  (`entities.py:52-67`) but aren't in this view.
- Kill switches: `KillSwitch` (`entities.py:306-317`) has `kill_id, scope,
  agent_key, version, tenant_id, active, reason, set_by, created_at` — **no
  `updated_at`**; lifting a kill deactivates the row rather than timestamping
  a change, so `killSwitch.updatedAt` in ACT-FR-001 has no durable backing
  field, only `created_at` of whichever row is currently active/inactive.
  Fleet-wide read: `GET /api/v1/registry/kill-switches`
  (`registry.py:622-638`) lists every active kill visible to the caller (all
  tenants for operators) — one row per `kill_id`, requiring a client-side
  join on `agent_key`/`version`/`tenant_id` to derive one state per agent.
  Hot-path state lives in Redis (`app/adapters/killswitch.py:31-55`,
  `RedisKillRegistry`, keys `ar:kill:set` + pub/sub `ar:kill`), not exposed
  over HTTP.
- Rollout: `Rollout` (`entities.py:109-119`) has `mode: direct|canary|shadow`
  — **no "pinned" mode**; pin lives separately on
  `TenantAgentConfig.pinned_version` (`entities.py:75`). "Stable" is not a
  stored literal anywhere — it is the aggregator-derived label for "no active
  rollout, no pin, running latest published." Routes exist only to *write*
  rollout state: `POST /registry/rollouts` (`registry.py:582-593`),
  `.../rollback` (`596-606`), `.../promote` (`609-619`). **There is no `GET`
  route** — `store.active_rollout(agent_key, cell)`
  (`app/store/sql.py:411-416`) exists at the store layer but is never
  exposed over HTTP. This is a genuine gap the fleet query cannot work
  around without a new backend route.
- Guardrail envelope: `app/domain/guardrail.py:16-20` (docstring) —
  `{data_scope: {workspaces, dataset_urns}, budget: {max_tokens_per_session},
  pii: {block_pii_egress, redact}}`, stored on
  `TenantAgentConfig.guardrail_policy` (`entities.py:71-84`), validated by
  `_validate_guardrail_policy` (`registry.py:260-310`), read via `GET
  /registry/tenants/self/agents/{agent_key}` (`registry.py:192-202`,
  `_tenant_config_view` at `68-79`). **No `rule_of_two` field exists
  anywhere** in the data model (confirmed by repo-wide search — the only hit
  is a test name testing four-eyes approval, not a stored field); ACT-FR-001's
  `guardrails.rule_of_two` and ACT-FR-012's "Rule-of-Two status" panel must be
  a synthesized constant, not a live query, exactly as the BRD itself
  anticipates ("static truths rendered from live config, demo-oriented").
- External agents (`app/api/routes/external.py`): exactly one route,
  `POST /external/v1/intents` (`external.py:44-139`) — a write-ingress, not a
  registry-read endpoint. It resolves the caller's declared toolset via the
  **same** `AgentVersion.toolset` used by internal/custom agents
  (`external.py:78-95`); there is no separate "ExternalAgent" entity with
  first-class `allow_list_scope`/`sdk_principal` columns — those are JWT
  claims (`principal.agent_id`, `.agent_version`, `.typ`, `.obo_sub`) plus the
  ordinary `AgentVersion.toolset`. So `kind=external` badging in ACT-FR-003
  has no dedicated read path either — it reuses the same
  `GET /registry/agents`/`.../versions` routes as everything else.
- Decision counts: **no aggregate endpoint exists.**
  `GET /api/v1/proposals?filter[status]=&filter[agent_key]=`
  (`app/api/routes/proposals.py:19-36`) returns row lists (max 200/page), not
  counts. The one aggregate that exists, `count_corrections`
  (`app/store/sql.py:283-293`, `(corrections, total)` for rejected +
  edited_approved vs all decided), is internal-only (consumed by
  `app/runtime/retrain_scheduler.py:74`), not HTTP-exposed, and doesn't
  break out `{proposed, approved, edited, rejected}` separately.

**eval-service** (`services/eval-service`):
- No "latest gate for this agent" endpoint. `GET /api/v1/gates/{gate_run_id}`
  (`app/api/routes/gates.py:16-24`) needs the exact id; `GET
  /gates?agent_key=&content_digest=` (`gates.py:27-36`, backed by
  `_GateRepo.find_by_digest`, `app/store/sql.py:478-491`) requires **both**
  `agent_key` and `content_digest` — no `ORDER BY`/`LIMIT`, and no way to ask
  "the newest one." The only path to "latest" is two round trips: `GET
  /api/v1/runs?agent_key=X&limit=1` (`app/api/routes/runs.py:37-47`, ordered
  newest-first, `app/store/sql.py:386-395`) to get the latest
  `candidate.content_digest`, then `GET /gates?agent_key=&content_digest=`
  with that digest. **There is no FK from `EvalRun` to `GateResult`**
  (`EvalRunRow`, `app/store/orm.py:97-114`, has no `gate_run_id` column), so
  this chain is unavoidable per agent. `GateResult` (`app/domain/entities.py:
  180-195`) has `gate_passed: bool` with no `stale`/`none` status value —
  "stale" and "none" in ACT-FR-001's `evalGate.status` enum must be derived
  (e.g. age of the row, or its absence), not read.
- **No batch/fleet-wide gate endpoint** — confirmed by inspecting every route
  file under `app/api/routes/`; every gate lookup is single-`agent_key`. An
  `agentFleet` resolver querying eval status is inherently N calls for N
  agents (mitigated by dataloader batching of the *runs* half only — gate
  lookups still fan out per distinct digest).

**usage-service** (`services/usage-service`, Go):
- `GET /api/v1/reports/usage` (registered `internal/api/server.go:89`,
  handler `internal/api/handlers_reports.go:28-98`) with `group_by` including
  `agent` returns **every** agent's spend in one paginated call — no
  `agent_id` filter param exists, only `group_by=agent` bucketing
  (`internal/store/rollups.go:96-143`). This is materially better than
  eval-service's per-agent-only gate lookup: fleet spend is a single fetch.
  Response rows (`domain.RollupRow`, `internal/domain/types.go:244-267`):
  `{day?, month?, meter_key, agent_id?, unit, quantity, usd?}` — **no
  `trend`/period-over-period field**; ACT-FR-001's `spend.trend7d` requires
  two calls (current + prior 7d) diffed client-side, not a server-computed
  value.
- `governed_decision` / `case_resolved` / `auto_executed_action` meters
  **do not exist yet**. The live meter catalog
  (`internal/domain/types.go:47-86`) has exactly 7 meters (`api_calls,
  query_bytes_scanned, pipeline_minutes, storage_gb_month, llm_input_tokens,
  llm_output_tokens, agent_tasks_completed`) — none are decision-shaped.
  BRD 67 (`docs/brd/67_value_metering_billing_export_BRD.md:32-38`,
  "Approved for build") specifies exactly the meter this BRD's
  `decisions{proposed,approved,edited,rejected}` field wants, but it is not
  yet implemented. This confirms BRD 68's own fallback language (ACT-FR-001:
  "from BRD 67 meters when present, else existing counts") is currently
  forced onto the "else" branch — and, per the agent-runtime findings above,
  "existing counts" for a full proposed/approved/edited/rejected breakdown
  don't exist as an aggregate either; a new store-layer query is needed
  regardless of which side of the fallback fires today.

**audit-service** (`services/audit-service`, Go) — export machinery:
Three distinct, non-unified export mechanisms exist; none is a drop-in fit
for a fresh, structured `agent-inventory.v1` artifact:
1. **Daily WORM seal** (`internal/export/export.go`) — ticker-driven, not
   request-triggered, exports each tenant's *own ingested audit events* to
   `s3://.../tenant=<id>/date=<d>/events-NNNN.parquet` under Object-Lock
   (`internal/worm/worm.go:74-86`, `PutWORM`), sealed by a `manifest-rNNNN.json`
   whose per-file/manifest SHA-256 (`internal/domain/domain.go:168-172`,
   `SHA256Hex`) lands in Postgres `export_manifests.manifest_sha256`
   (`migrations/000001_init.up.sql:21-38`). Not a fit — this pipeline only
   ever exports audit-service's own event stream, never externally-supplied
   content.
2. **Compliance packs** (`internal/compliance/compliance.go` +
   `handlePack`, `internal/api/handlers.go:447-483`) — the closer structural
   analog: `POST /compliance/soc2-pack` / `.../ai-decision-log` create a
   Postgres `async_jobs` row, run a goroutine that builds a zip and writes it
   via **non-locked** `PutObject` (`worm.go:90-97`) under
   `compliance/tenant=<id>/<kind>/<from>_<to>_<uuid>.zip`
   (`compliance.go:227-228`), with per-file SHA-256 embedded in
   `pack_manifest.json` *inside* the zip (not a Postgres column). Polled via
   `GET /api/v1/operations/{id}` (`handlers.go:485-510`). **Gap found**:
   `handlePack` never calls the meta-event emitter — compliance-pack
   generation is **not currently audited** (contrast the daily seal, which
   calls `Meta.ExportSealed`, `internal/meta/meta.go:61-66`, on every seal).
3. **Ad-hoc streamed export** (`GET /audit/export`,
   `internal/api/handlers.go:194-211`) — synchronous CSV/NDJSON of a search
   filter, never stored, audited only as `audit.searched`
   (`meta.go:55-59`), not as a distinct export.

**Listing gap (important for ACT-FR-020's "listed under `/admin/audit`
exports")**: `GET /api/v1/exports?date=` (`handlers.go:357-382`,
`ListSealedManifests`, `internal/pgstore/pgstore.go:179-207`) exists and
lists sealed daily-seal manifests — but it is **not wired through the BFF**
(`services/bff-graphql/src/clients/audit.ts` has no list method; only
`generateSoc2Pack`, `generateAiDecisionLog`, `operation`, `evidencePack`) nor
through the UI (`services/ui-web/src/components/admin/AuditComplianceCard.tsx`
only *generates* packs and polls `operations/{id}` — it never lists past
exports). "Listed under `/admin/audit`" is therefore not a reuse of existing
plumbing; it is new BFF + UI wiring regardless of which backend storage path
the new export uses.

**BFF ↔ audit-service today**: direct HTTP, no intermediary. `AuditClient`
(`services/bff-graphql/src/clients/audit.ts:145-235`) is documented as "pure
passthrough — the caller's JWT is forwarded verbatim" (`audit.ts:3-5`);
resolvers call it directly (`resolvers/index.ts:2251-2261`,
`resolvers/index.ts:577-578` for the operation-poll).

#### The realtime list-patch bridge

Two cooperating pieces in ui-web:
- `useHubTopics(topics: string[])`
  (`services/ui-web/src/lib/realtime/useHubTopics.ts:15`) opens an SSE stream
  to realtime-hub and, per frame, dispatches on the frame's **`event_type`**
  field (`useHubTopics.ts:39-53`) — *not* the literal subscription topic
  string.
- The patcher registry (`services/ui-web/src/lib/realtime/patchers.ts`) —
  `Patcher{match, apply}` (`patchers.ts:19-30`); `dispatchEvent`
  (`patchers.ts:240`) runs every patcher whose `match` is a prefix of the
  event's `event_type` against `REGISTRY` (`patchers.ts:228-237`, currently
  covering `case.`, `run.`, `ingestion.`, `inference.`, `pipeline.run.`,
  `dataset.`, `proposal.`, `usage.` — **no `agent.` entry**), patching a
  TanStack Query cache row in place via `client.setQueriesData` — no
  refetch.
- Callers subscribe to a `list:<entity>` string as the *hub-side fan-in
  topic name* (e.g. `useHubTopics(["list:case"])`,
  `src/app/(app)/cases/page.tsx:52`) — this name only controls what the hub
  fans into the stream; the client-side match/patch logic is keyed on
  `event_type`, a separate mechanism. **Both halves are missing for
  agents**: no `list:agent`-shaped hub fan-in is known to exist for
  `agent.killed`/`eval.gate.completed`-class events (unverified in this pass
  — realtime-hub's topic-scheme registry was out of scope for this research
  round and must be confirmed before slice 2), and no `agentPatcher` exists
  in `REGISTRY`.

#### Summary of what's missing

| Need (BRD 68) | Exists today | Gap |
|---|---|---|
| One fleet-wide agent list w/ full state | Thin `GET /registry/agents` only | New BFF aggregation (this doc's core deliverable) |
| Current rollout state per agent version | Store method only, no route | New agent-runtime `GET` route |
| `kind` (platform\|custom\|external) | Implicit (`owner_tenant` + `graph_ref=="external"` convention) | Formalize as a derivable/stored discriminator |
| Decision counts (proposed/approved/edited/rejected) | Nothing aggregate; BRD 67 meter not yet built | New agent-runtime store query (interim), swap to BRD 67 meter later |
| Latest eval-gate status per agent | 2-hop chain, no run→gate FK, no fleet-batch | Compose in BFF; accept N calls, cache |
| Spend + trend per agent | Fleet-wide in one call; no trend | Diff two periods client-side in BFF |
| `unavailable` degradation marker | `capsDegraded: Boolean!` precedent (Viewer) + `UNAVAILABLE` in `AsyncBoundary`'s `ERROR_COPY` | Extend the same pattern per fleet-row field group |
| Realtime row patch for agents | `list:`/patcher mechanism exists generically | No `agent.` patcher, hub fan-in unverified |
| Inventory export storage + listing | Compliance-pack pattern closest, but ungated by audit and unlisted in UI/BFF | New narrow storage endpoint + BFF/UI listing wiring |

---

## 2. Architecture & Design

### 2.1 `agentFleet` — BFF aggregation, not a new backend endpoint

**Decision: BFF-side aggregation via dataloaders for the live fleet view;
backend (agent-runtime) coordination only for the export.** Two different
workloads, two different owners:

- The **live fleet query** (`agentFleet`) is read-mostly, per-request,
  needs per-column partial-failure isolation, and is exactly the shape
  bff-graphql's dataloader infrastructure already exists for (BFF-FR-030:
  "every entity `__resolveReference` and every nested list resolver MUST go
  through a loader," `docs/brd/21_bff_graphql_BRD.md:61`). All four upstream
  clients (`agent`, `eval`, `usage`, `audit`) already exist in
  `services/bff-graphql/src/clients/` — nothing new to stand up there. This
  matches the established `Case` object-type pattern
  (`resolvers/index.ts:4875-4905`), which resolves `assignee`/
  `sourceDataset`/`proposals` as independent per-field dataloader hydrations
  off one root row, not an eager join.
- The **inventory export** (`generateAgentInventoryExport`) has a hard ≤60s/
  100-agent NFR (ACT-NFR-002) and produces a structured artifact whose
  content (which fields, what "purpose" means, how toolset tiers resolve) is
  domain logic — exactly what the BFF is chartered *not* to own
  (`services/bff-graphql/src/schema/typeDefs.ts:6-7`: "No business logic and
  no authz live here"; `services/bff-graphql/src/errors/errors.ts:1-9`
  makes the same claim for authz). ACT-FR-020 itself specifies the shape:
  "BFF → agent-runtime coordination." Rejected alternative: have the BFF
  assemble the CSV/JSON directly and simply hand bytes to audit-service for
  storage — this would work mechanically (the BFF already holds all four
  clients) but breaks the "BFF has no business logic" boundary that every
  other BFF surface in the repo honors, and it would mean re-deriving the
  exact same field-by-field aggregation logic twice (once for `agentFleet`,
  once for the export) instead of once, in agent-runtime, parameterized by
  period. Rejected alternative: have audit-service build the pack itself
  (mirroring its own SOC2/AI-decision-log packs) — rejected because
  audit-service today has **zero outbound HTTP dependency** on agent-runtime/
  eval-service/usage-service; giving the tamper-evident WORM service new,
  synchronous fan-out dependencies on three other services to build an
  artifact that isn't even sourced from its own ingested events is the wrong
  place to add that coupling, and none of the existing evidence/compliance
  builders in `internal/compliance/` need it for anything else they produce.

### 2.2 `agentFleet` GraphQL type + query — SDL

```graphql
enum AgentFleetKind { PLATFORM CUSTOM EXTERNAL }
enum AgentFleetLifecycle { ACTIVE KILLED QUARANTINED DEPRECATED }
enum AgentFleetRollout { STABLE CANARY SHADOW PINNED }
enum EvalGateStatusValue { PASS FAIL STALE NONE }

"""One row in the fleet aggregation (BRD 68 ACT-FR-001). Every non-identity
field GROUP carries its own `unavailable: Boolean!` sibling so one downed
source degrades exactly that column, never the whole row or the whole query
(ACT-NFR-004 / AC-3) — the same convention as Viewer.capsDegraded
(typeDefs.ts:73-79) and the UNAVAILABLE code already in ui-web's
AsyncBoundary ERROR_COPY (AsyncBoundary.tsx:14)."""
type AgentFleetRow {
  key: ID!
  kind: AgentFleetKind!
  display: String!
  lifecycle: AgentFleetLifecycle!
  activeVersion: AgentFleetVersion!
  guardrails: AgentFleetGuardrails!
  toolset: [String!]!
  evalGate: AgentFleetEvalGate!
  killSwitch: AgentFleetKillSwitch!
  spend: AgentFleetSpend
  decisions: AgentFleetDecisions!
  lastIncidentAt: String
  external: AgentFleetExternalInfo
  """Pointer at realtime-hub (reuses the existing StreamHandle mechanism,
  typeDefs.ts:30-37 / AgentRun.tokenStream, typeDefs.ts:2100) — the client
  connects directly with its own JWT; the BFF never proxies the stream."""
  liveUpdates: StreamHandle!
}

type AgentFleetVersion { id: Int! graphDigest: String! rollout: AgentFleetRollout! }

type AgentFleetGuardrails {
  dataScope: JSON
  tokenBudget: Int
  piiEgress: String        # "blocked" | "redact" | "off", derived from pii.{block_pii_egress,redact}
  """Static platform truth (four-eyes is always on) — not a live query;
  see 1b, no `rule_of_two` field exists in agent-runtime's data model."""
  ruleOfTwo: Boolean!
}

type AgentFleetEvalGate {
  status: EvalGateStatusValue!
  lastRunAt: String
  suiteKey: String
  unavailable: Boolean!
}

type AgentFleetKillSwitch { state: String! updatedAt: String actor: String }

"""Absent (null) when the caller lacks usage.report.read — see 2.4. Present
with unavailable:true when the caller HAS the capability but usage-service
could not be reached."""
type AgentFleetSpend { periodUsd: Float trend7dPct: Float unavailable: Boolean! }

type AgentFleetDecisions {
  proposed: Int
  approved: Int
  edited: Int
  rejected: Int
  period: String!
  unavailable: Boolean!
}

type AgentFleetExternalInfo {
  allowListScope: [String!]!
  sdkPrincipal: String!
  autoExecute: String!   # constant "denied" (BRD 60)
}

type AgentFleetSummary {
  totalByKind: JSON!            # {platform: N, custom: N, external: N}
  activeCount: Int!
  killedCount: Int!
  quarantinedCount: Int!
  periodSpendUsd: Float
  periodDecisions: Int
}

extend type Query {
  """ACT-FR-001. Requires agent.registry.read (see 2.4 on the agent.registry.read
  vs code's ai.agent.read naming). workspace filters to one workspace's
  tenant-custom + external agents; platform agents are always tenant-wide."""
  agentFleet(workspace: ID, periodFrom: String, periodTo: String): [AgentFleetRow!]!
  agentFleetSummary(workspace: ID, periodFrom: String, periodTo: String): AgentFleetSummary!
}

extend type Mutation {
  """ACT-FR-020. Synchronous — agent-runtime already bounds this to <=60s/100
  agents (ACT-NFR-002), so this is the evidence-pack pattern (audit-service
  handleEvidencePack, handlers.go:408-437), not the async operations/{id} poll
  pattern used for SOC2/AI-decision-log packs."""
  generateAgentInventoryExport(periodFrom: String!, periodTo: String!): AgentInventoryExportResult!
}

type AgentInventoryExportResult {
  uri: String!
  sha256: String!
  generatedAt: String!
  downloadUrl: String!
  rowCount: Int!
}
```

### 2.3 BFF aggregation + dataloaders + degradation contract

New dataloaders in `services/bff-graphql/src/loaders/index.ts`, following
the existing `profileByDatasetId` precedent (`loaders/index.ts:90-105`) for
the outage-vs-absence distinction:

```ts
// Pattern: 5xx/transport failure rejects the key (surfaces as a field error
// via AsyncBoundary's UNAVAILABLE code); a clean "not found" resolves null.
// Fleet-scale calls (usage report grouped by agent, eval runs per agent) are
// fetched ONCE per request and bucketed client-side, not looped per agent.
evalGateByAgentKey: new DataLoader<string, EvalGateResultDTO | null>(...)
usageByAgentKey:    new DataLoader<string, RollupRow | null>(...)   // one grouped call, bucketed
killSwitchByAgentKey: new DataLoader<string, KillSwitchDTO | null>(...)
rolloutByAgentKey:  new DataLoader<string, RolloutDTO | null>(...)  // needs new backend route, 2.6
decisionsByAgentKey: new DataLoader<string, DecisionCountsDTO | null>(...) // needs new backend route, 2.6
```

**Degradation contract**: each field-group resolver wraps its client call in
a `try/catch` identical in shape to `profileByDatasetId`
(`loaders/index.ts:90-105`): a `DownstreamError` with `httpStatus >= 500 ||
httpStatus === 0` sets `unavailable: true` on that field group with all
sibling data fields `null` — never a fabricated `0` or empty array (this is
the literal wording of ACT-FR-001 and matches `AsyncBoundary`'s own
`UNAVAILABLE` copy, `AsyncBoundary.tsx:14`, so the UI's existing error-state
vocabulary already has the right word). A `404`/logical-absence (e.g., an
agent with no eval runs yet) resolves the field group with real
zero/empty values and `unavailable: false` — "never ran" is not the same
fact as "can't tell."

**Caching relaxation (ACT-NFR-001, "cached per-source ≤60s")**: bff-graphql's
loaders are explicitly documented as having "no cross-request cache in v1 —
tenant safety first" (`loaders/index.ts:1-10`). The fleet query is the one
deliberate, narrow exception: `evalGateByAgentKey` and `usageByAgentKey`
results are cached for 60s keyed by `(tenant_id, source, period)` — tenant-
scoped, so the existing "tenant safety first" invariant holds; only the
*cross-request* reuse window is new, and only for these two read-heavy,
slow-changing sources.

### 2.4 Authz gating per column

The BFF adds **no new authz decision layer** — this is deliberate,
consistent house policy (`typeDefs.ts:6-7`, `errors/errors.ts:1-9`): every
resolver forwards the caller's JWT verbatim and lets the downstream service
decide. Two mechanisms combine to satisfy ACT-FR-002/AC-5:

1. **Column visibility is a ui-web concern**, exactly like every other
   capability-gated surface: a new `FEATURE_GATES` entry,
   `viewAgentFleetSpend: cap("usage.report.read")` (alongside the existing
   `viewCostPanel: cap("usage.report.read")` at
   `services/ui-web/src/lib/authz/registry.ts:257`), hides the spend column
   from the query selection set entirely for a caller who lacks it — so
   `AgentFleetSpend` genuinely resolves `null` for that caller (not an
   error), satisfying AC-5's "sees fleet without spend column."
2. If a caller **without** `usage.report.read` somehow still requests the
   field (e.g. a hand-built query), the resolver still forwards the JWT to
   usage-service, which 403s; `mapDownstreamError`
   (`services/bff-graphql/src/errors/errors.ts:115-127`) turns that into
   `PERMISSION_DENIED`, and `AsyncBoundary`'s existing `PERMISSION_DENIED`
   special-case (`AsyncBoundary.tsx:10`, non-leaking Lock icon) renders it —
   no new error vocabulary needed.

**Naming note (flag, not fixed here)**: ACT-FR-002 names the capability
`agent.registry.read`; the actual seeded capability enforced in
`registry.py` (`_require_agent_cap(..., "ai.agent.read")`,
`registry.py:87`) is `ai.agent.read`. Implementation must reconcile this —
most likely keep `ai.agent.read` as canonical (already wired end-to-end
through `rbac-service/seed/roles_actions.yaml` and every existing
`FEATURE_GATES` entry) and treat the BRD's name as descriptive shorthand,
not a literal new capability to seed.

The top-level query gate: `FEATURE_GATES.viewAgentFleet: cap("ai.agent.read")`.

### 2.5 Realtime patch topics

Reuse the existing `list:`/patcher mechanism (`patchers.ts`), adding what's
missing per the 1b gap table:
- New hub fan-in topic `list:agent`, subscribed via
  `useHubTopics(["list:agent"])` on the Control Tower page, following the
  exact convention at `src/app/(app)/cases/page.tsx:52`.
- New `agentPatcher` entry in `REGISTRY` (`patchers.ts:228-237`), `match:
  "agent."`, patching `killSwitch`/`lifecycle` on the matching
  `AgentFleetRow` cache entry when an `agent.killed`/`agent.unkilled` event
  arrives (`agent.events.v1` per BRD 14 §6), and a second match on
  `eval.gate.` for gate-status flips.
- **Open item, must be confirmed before slice 2 ships**: whether
  realtime-hub already fans `agent.events.v1`/`eval.events.v1` into a
  subscribable hub topic at all. This research pass did not inspect
  realtime-hub's topic-scheme registry (out of scope for the services listed
  in the task); AC-2 ("row chip flips via SSE ≤5s without refetch") depends
  on it. If the bridge doesn't exist, slice 2 must add a realtime-hub
  consumer for these two Kafka topics before the UI patcher has anything to
  receive.

### 2.6 New backend surface required (agent-runtime)

Two additive routes, no changes to existing ones:
- `GET /api/v1/registry/rollouts?agent_key=&cell=` → wraps
  `store.active_rollout(agent_key, cell)` (`app/store/sql.py:411-416`,
  already implemented, just unexposed) plus the tenant's `pinned_version`
  (`registry.py:192-202`) to emit the `stable|canary|shadow|pinned` union.
- `GET /api/v1/registry/agents/{agent_key}/decisions?period_from=&period_to=`
  → a new SQL aggregate modeled directly on the existing
  `count_corrections` pattern (`app/store/sql.py:283-293`), but broken out
  by status (`GROUP BY status`) instead of collapsed into corrections/total.
  This is the "existing counts" fallback path named in ACT-FR-001; when
  BRD 67's `governed_decision` meter ships, the BFF resolver switches its
  source to usage-service's `GET /api/v1/decisions/costs` (VMB-FR-011)
  without a schema change on `AgentFleetDecisions`.

### 2.7 UI component structure — Control Tower page

Additive to `services/ui-web/src/app/(app)/admin/agents/page.tsx`, keeping
every existing card (`AgentKillSwitchesCard`, `ToolKillSwitchesCard`,
`AgentCatalogCard`, `OperatorCeilingsCard`) below the new surface — the BRD
frames this as `/admin/agents` *evolving*, not replacing:

- **Header tiles** (ACT-FR-011): reuse the numeric 2-up stat-grid pattern
  from `LearningLoopCard` (`src/app/(app)/page.tsx:122-134`,
  `text-2xl font-bold tabular-nums` + label), sourced from
  `agentFleetSummary`. No dedicated `StatCard` component exists yet in
  `src/components` — this is the first consumer that would justify
  extracting one; kept inline for slice 2 to match the ad hoc convention
  every other page uses today.
- **Fleet table** (ACT-FR-010): a `DataTable` following the
  `killSwitchColumns(kind)` column-def convention (`page.tsx:47`), sortable
  by spend/decisions/state, wrapped in the existing `AsyncBoundary` — no new
  loading/error/empty primitive needed.
- **Drill-in**: reuse the existing master-detail side-panel convention
  (`KillSwitchDetail`, `page.tsx:124`) rather than a new `/admin/agents/
  [key]` route — no agent detail route exists today (confirmed), and a side
  panel is strictly less net-new surface for slice 1. A dedicated route is
  explicitly deferred (see Out of scope).
- **Guardrail summary popover** (ACT-FR-010): reuse the raw Radix
  `Popover.Root/Trigger/Portal/Content/Arrow` composition from
  `ProvenanceBadge.tsx:40-78` (the only existing popover precedent in the
  codebase; `@radix-ui/react-popover` is already a dependency) — a
  badge/button trigger opening a small `dl`-based fact panel listing
  `dataScope`/`tokenBudget`/`piiEgress`/`ruleOfTwo`.
- **Kill action**: reuse the existing `useCreateAgentKillSwitch`/
  `useDeleteAgentKillSwitch` mutations and `ConfirmDialog` wiring
  (`page.tsx:164-179`, `src/lib/graphql/hooks.ts:3650-3669`) — triggered
  inline from a fleet row action instead of only from the side panel; same
  mutation, same authz (`FEATURE_GATES.liftAgentKillSwitch`), no new write
  path (ACT-NFR-003).
- **External badge**: a fixed "auto-execute: denied" chip driven by
  `AgentFleetExternalInfo.autoExecute` (ACT-FR-003) — data, not styling
  logic, so the badge can never silently drift if the constant changes.

### 2.8 `agent-inventory.v1` export

**Generation flow.** `POST /exports/agent-inventory` (BFF mutation
`generateAgentInventoryExport`) → agent-runtime `POST
/api/v1/registry/exports/agent-inventory {period_from, period_to}`
(operator or `ai.agent.admin`-equivalent scope). Agent-runtime is the
coordinator because it already owns the catalog/version/guardrail data (the
majority of the field list below) and already depends on eval-service for
gate results (BRD 14 §8: "Calls: ... eval-service (gate results, canary
scoring)" — an existing dependency direction, not new); it gains one **new**
outbound dependency on usage-service for spend + decision totals (called out
honestly — this is new coupling, smaller and more natural than the rejected
alternative of audit-service depending on three services). Agent-runtime
renders CSV + JSON in-process (bounded to ≤100 agents, ACT-NFR-002), computes
a SHA-256 digest per file, then calls one new, narrow audit-service endpoint:

```
POST /api/v1/compliance/artifacts
{tenant_id, kind: "agent_inventory.v1", period_from, period_to,
 files: [{name, content_base64, sha256}]}
→ 200 {uri, sha256, generated_at, download_url}
```

This endpoint does exactly what `handlePack`'s storage step already does —
`worm.PutObject` (non-WORM prefix; this is a point-in-time snapshot, not a
7-year-retention legal artifact) under a new key convention
`compliance/tenant=<id>/agent_inventory/<from>_<to>_<uuid>.zip`, mirroring
`compliance.go:227-228` — plus two closures of gaps found in 1b, scoped
narrowly to the new kind (not retrofitted onto SOC2/AI-decision-log in this
BRD):
1. **Audits its own creation** — calls the meta emitter
   (mirroring `ExportSealed`, `meta.go:61-66`) so "generation is audited"
   (ACT-FR-020) is real, not aspirational, for this export kind.
2. **Is listed**: `export_manifests` gains a `kind` column (defaulting
   existing rows to `audit_daily_seal`); `GET /api/v1/exports?kind=` is
   extended to filter by it; the BFF gains `AuditClient.listExports(kind)` +
   a `Query.auditExports(kind: String)` field (net-new — no such BFF method
   exists today per 1b); `AuditComplianceCard.tsx` gains a "Past exports"
   list section. This closes the "listed under `/admin/audit`" requirement
   for real, and demonstrates the wiring the pre-existing daily-seal listing
   gap could reuse later (not fixed for that kind in this BRD — see Out of
   scope).

**Schema `agent-inventory.v1`** — top-level: `{schema_version:
"agent-inventory.v1", tenant_id, generated_at, period: {from, to}, rows:
[...]}`. Per-row fields:

| Field | Source |
|---|---|
| `key`, `kind`, `version`, `graph_digest`, `a2a_card_url` | agent-runtime `AgentDefinition`/`AgentVersion` + `GET /a2a/cards/:agent_key` (BRD 14 ART-FR-050) |
| `purpose` (description) | `AgentDefinition.description` |
| `model_config` (`request_class`, `max_rung`, `temperature`) | `AgentVersion.model_config` |
| `guardrail_envelope` (`data_scope`, `budget`, `pii`, `max_tier`) | `TenantAgentConfig.guardrail_policy` + platform ceiling |
| `toolset` (`tool_id`, `version_range`) with tier | `AgentVersion.toolset`; **tier requires a tool-plane lookup (BRD 13)** — a fifth source, batched once for the export only, best-effort (tier omitted, not fabricated, if tool-plane is unreachable) |
| `memory_scopes` (`readable`, `writable`) | `AgentVersion.memory_policy` |
| `eval_evidence` (`suite_key`, `last_gate_passed`, `last_run_at`, `score_summary`) | eval-service `GateResult`/`EvalRun` chain (2.3) |
| `human_oversight_mechanism` | constant: `"four-eyes approval; propose-only for write-tier tools; no self-approval"` (BRD 14 ART-FR-042/044) + the agent's `auto_execute_policy` summary from `TenantAgentConfig` |
| `spend_period_usd`, `decisions` (`proposed/approved/edited/rejected`) | usage-service report (fallback: agent-runtime aggregate, 2.6) |
| `kill_quarantine_history_count` | audit-service `GET /audit/search` filtered by `resource_urn` prefix + `action` in `{agent.killed, agent.unkilled}`, one broad per-tenant search grouped client-side by `agent_key` — **not** N per-agent calls |

**EU AI Act mapping table** (ACT-FR-021 — informational mapping, no legal
claims in-product):

| `agent-inventory.v1` field | EU AI Act concept | Basis |
|---|---|---|
| `key`, `kind`, `version`, `graph_digest`, `a2a_card_url` | System identity (Annex IV §1) | agent-runtime catalog/registry |
| `purpose` | Intended purpose (Annex IV §1(b)) | `AgentDefinition.description` |
| `model_config`, `toolset`, `memory_scopes` | System architecture/capabilities (Annex IV §2) | `AgentVersion` |
| `guardrail_envelope` | Risk-mitigation measures (Art. 9, Annex IV §4) | `TenantAgentConfig.guardrail_policy` |
| `eval_evidence` | Accuracy/robustness testing (Art. 15, Annex IV §9) | eval-service gate results |
| `human_oversight_mechanism` | Human oversight (Art. 14) | constant + auto-execute policy (BRD 14 proposal framework) |
| `spend_period_usd`, `decisions` | Post-market monitoring input (Art. 72) | usage-service / agent-runtime fallback |
| `kill_quarantine_history_count` | Incident record-keeping (Art. 73, Annex IV §9) | audit-service search |
| `schema_version`, `generated_at`, artifact checksum | Logging/record-keeping integrity (Art. 12, Art. 19) | this export's own storage + audit event |

### 2.9 Out of scope

Everything BRD 68 itself excludes (new enforcement mechanics, cross-tenant
fleet views beyond the `/admin/tenants` read-only pattern, full EU AI Act
Annex IV technical-documentation generation, agent marketplace), plus,
specific to this design:
- A dedicated `/admin/agents/[agentKey]` drill-in route (side-panel reuse
  chosen instead for slice 1/2).
- Retrofitting audit-event emission and BFF/UI listing onto the *existing*
  SOC2/AI-decision-log compliance packs (the gap is closed only for the new
  `agent_inventory.v1` kind).
- A `StatCard`/`StatTile` shared component extraction (tiles stay inline,
  matching every other page's current convention).
- A real GraphQL `Subscription` transport (the existing `StreamHandle`
  pointer-to-hub mechanism is reused, not replaced).
- Tool-tier enrichment (tool-plane join) for the *live* fleet table — only
  the export needs it, and only best-effort.
- Switching `decisions` to the BRD 67 `governed_decision` meter — the field
  shape is designed to accept it later without a schema change, but wiring
  it is BRD 67's own delivery.

---

## 3. Implementation & Test

**pending — implementation next.**

### Slice plan

- **Slice 1 — BFF `agentFleet` query + fleet table UI.** New agent-runtime
  rollout-read route (2.6) and decision-count aggregate route (2.6); new BFF
  dataloaders + `agentFleet` resolver with the `unavailable` degradation
  contract (2.3); ui-web fleet `DataTable` + `AsyncBoundary`, additive above
  the existing cards (2.7), guardrail popover, `FEATURE_GATES.viewAgentFleet`
  / `.viewAgentFleetSpend`. No realtime, no export yet.
- **Slice 2 — tiles + realtime.** `agentFleetSummary` query + header tiles
  (2.7); confirm (or build) the realtime-hub bridge for `agent.events.v1`/
  `eval.events.v1` (2.5 open item); `list:agent` topic + `agentPatcher`;
  AC-2 (SSE row flip ≤5s).
- **Slice 3 — inventory export.** New agent-runtime export-coordination
  route + usage-service dependency (2.8); new audit-service
  `POST /compliance/artifacts` + `kind` column + `GET /exports?kind=`
  extension + audit-event emission; BFF `generateAgentInventoryExport`
  mutation + `auditExports` listing query; `AuditComplianceCard.tsx` "past
  exports" section + a "Generate inventory export" action on the Control
  Tower page; EU AI Act mapping table ships as this doc (2.8), referenced
  from the export UI's help text.

### Test plan

- **BFF unit tests**: new resolver/dataloader tests extending the existing
  `services/bff-graphql` unit suite (observed at 296-304 tests across recent
  initiative logs, e.g. `docs/initiatives/brd60-external-agent-allowlist-
  closure.md`) — cover per-column degradation (mocked `DownstreamError` with
  `httpStatus>=500` sets `unavailable:true`, data null; a 404-shaped absence
  sets real zeros), dataloader batching (fleet spend fetched once, not per
  agent), and the capability-gated column omission (2.4).
- **ui-web component tests**: co-located `*.test.tsx` per the existing
  convention (measured at this scan: 78 test files, ~468-469 `it`/`test`
  call sites — close to, but not exactly, the "467" figure quoted in the
  brief; worth re-verifying with a live `vitest run` before slice 1 lands
  rather than trusting either static count). New: `AgentFleetTable.test.tsx`,
  fleet-tiles test, guardrail-popover test, kill-from-fleet-row test
  (asserting the existing `useCreateAgentKillSwitch`/`useDeleteAgentKillSwitch`
  mutations fire unchanged).
- **Live Playwright**: add `/admin/agents` to `tests-live/smoke.spec.ts`'s
  `MODULE_ROUTES` (`smoke.spec.ts:13-38`) — currently absent; add a
  dedicated `tests-live/agent-fleet-journeys.spec.ts` covering AC-1 (mixed
  platform/custom/external fleet rendering), AC-2 (kill → SSE flip ≤5s), and
  AC-3 (usage-service down → spend column shows unavailable, other columns
  render) against the real running stack.
- **Integration test for export**: an agent-runtime + audit-service
  integration test (mirroring the Docker-backed pattern already used for the
  evidence-pack endpoint, per `docs/brd/60_external_agent_governance_BRD.md`
  WS5) asserting checksum match, `schema_version` field presence, the new
  audit event fires, and the artifact is retrievable via `GET
  /exports?kind=agent_inventory.v1` end to end — this is the concrete
  evidence for AC-4.
