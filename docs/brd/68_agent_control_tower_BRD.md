# BRD 68 — Agent Control Tower & Compliance Inventory

**Service:** bff-graphql + ui-web (surface), agent-runtime/audit-service (data) · **Language:** TS (+Py/Go read APIs) · **Phase:** GTM-1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`. Builds on BRDs 14 (agent-runtime), 16 (eval), 17 (usage), 18 (audit), 53 (custom agents), 60 (external agents). Origin: `../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §5 A1 + A6 (inventory slice).

---

## 1. Overview

**Purpose.** Package existing fleet-governance capabilities — agent catalog + versions + A2A cards, kill switches, canary/shadow/pin/rollback, eval gates, guardrail envelopes, per-agent spend, external-agent registry — into **one fleet surface** (`/admin/agents` evolution) plus an **exportable agent inventory report** shaped for EU AI Act system-inventory and SR 26-2-style validation evidence. ~90% of the data exists; this BRD is aggregation + presentation + export, not new enforcement.

**Business value.** ServiceNow's AI Control Tower made fleet-level agent governance an *expected* enterprise surface; Microsoft normalized "agents as managed identities." For Datacern this is the highest demo-value-per-effort item: it makes the invisible governance fabric visible in one screen, and the inventory export is a compliance artifact the buyer's risk team budget pays for.

**In scope.** A fleet dashboard aggregating per agent (internal, tenant-custom BRD 53, external BRD 60): identity + lifecycle state, active version + rollout state (canary/shadow/pin), guardrail envelope summary, toolset, eval gate status + last eval run, spend (period + trend, from usage-service), proposal stats (proposed/approved/edited/rejected, from BRD 67 meters when present, else existing counts), kill-switch state + one-click kill (existing capability, existing authz), last incident/quarantine. Inventory export (CSV + PDF-ready JSON) with versioned schema. BFF aggregation query with dataloaders. No new write paths except none — kill switch and rollout actions reuse existing mutations.

**Out of scope.** New enforcement mechanics (kill/rollout/eval gates all exist); cross-tenant fleet views beyond the existing platform-admin read-only pattern (`/admin/tenants` discipline — no RLS drill-through); EU AI Act Annex IV full technical documentation generation (roadmap A6 continuation — this BRD ships the *inventory* slice only); agent marketplace.

## 2. Actors & user stories

Personas: **Tenant Admin / AI Risk Officer**, **Platform Operator**, **Auditor** (read-only), **Compliance consumer** (export).

- **US-1** As an AI Risk Officer, I want one screen listing every agent that can act in my tenant — including tenant-custom and external agents — with state, guardrails, and spend, so "what AI is running here" has a live answer.
- **US-2** As a Tenant Admin, I want kill-switch state and eval-gate status visible per agent with one-click kill (existing authz), so incident response is seconds, not a runbook.
- **US-3** As an Auditor, I want an exported inventory (agent, version, purpose, guardrails, toolset, eval evidence, human-oversight mechanism, spend) with a generation timestamp and stable schema version, so it files as evidence.
- **US-4** As a Platform Operator, I want fleet totals (agents by state, spend by agent, decisions by agent) per tenant, so account reviews are data-driven.
- **US-5** As an AI Risk Officer, I want external agents (BRD 60) clearly badged with their allow-list scope and "auto-execute: never" posture, so third-party AI is visibly fenced.

## 3. Functional requirements

### Fleet aggregation
- **ACT-FR-001 (Must)** BFF query `agentFleet(workspace?)` returning per agent: `{key, kind(platform|custom|external), display, lifecycle(active|killed|quarantined|deprecated), activeVersion{id, graph_digest, rollout(stable|canary|shadow|pinned)}, guardrails{data_scope, token_budget, pii_egress, rule_of_two}, toolset[], evalGate{status(pass|fail|stale|none), lastRunAt, suiteKey}, killSwitch{state, updatedAt, actor}, spend{periodUsd, trend7d}, decisions{proposed, approved, edited, rejected, period}, lastIncidentAt?}`. Sources: agent-runtime registry/catalog + rollout + kill state; eval-service latest gate runs; usage-service per-agent rollups; audit-service last quarantine/kill events. Dataloaders batch per-service calls; partial-source failure degrades that column with an explicit `unavailable` marker, never fabricated zeros.
- **ACT-FR-002 (Must)** All rows RBAC-scoped: fleet view requires `agent.registry.read`; spend column additionally `usage.report.read`; kill action reuses existing `agent.kill.execute` capability — the surface adds no new authz semantics.
- **ACT-FR-003 (Must)** External agents (BRD 60) appear with `kind=external`, their allow-list scope, SDK principal, and a fixed "auto-execute: denied" badge; tenant-custom agents (BRD 53) show their persona + allow-listed propose tool.
- **ACT-FR-004 (Should)** Realtime: kill-switch flips and eval-gate transitions patch the fleet list via the existing `list:` topic bridge (no polling — UI-FR-012 stands).

### UI surface
- **ACT-FR-010 (Must)** `/admin/agents` becomes the Control Tower: fleet table (sortable by spend/decisions/state), state chips, guardrail summary popover, drill-in to existing agent detail. Empty/degraded states per AsyncBoundary convention.
- **ACT-FR-011 (Must)** Fleet header tiles: total agents by kind, active/killed/quarantined counts, period spend, period governed decisions. Tiles link to filtered views.
- **ACT-FR-012 (Should)** A "governance posture" panel: four-eyes on (always), auto-execute matrix summary, Rule-of-Two status — static truths rendered from live config, demo-oriented.

### Inventory export
- **ACT-FR-020 (Must)** `POST /exports/agent-inventory` (BFF → agent-runtime coordination) produces a versioned artifact: CSV + JSON (schema `agent-inventory.v1`) containing per agent: identity (key, kind, version, graph_digest, A2A card URL), purpose (from catalog description), model config + ladder class, guardrail envelope, toolset with tiers, memory scopes, eval evidence (suite, last pass, score summary), human-oversight mechanism (proposal mode / four-eyes — constant, stated explicitly), spend + decision counts for the requested period, kill/quarantine history count. Stored via the existing audit-export path (object storage, checksummed, listed under `/admin/audit` exports); generation is audited.
- **ACT-FR-021 (Must)** Export schema is versioned and documented in-repo (`docs/design/` or service README); fields map to EU AI Act system-inventory expectations (system identity, purpose, oversight, logging) — mapping table included in the doc, no legal claims in-product.
- **ACT-FR-022 (Could)** Scheduled export (monthly) via existing notification/webhook rails.

## 4. Non-functional requirements

- **ACT-NFR-001** Fleet query p95 ≤ 1.5s for 50 agents (batched dataloaders, cached per-source ≤60s).
- **ACT-NFR-002** Export generation ≤ 60s for 100 agents; artifact immutable + checksummed.
- **ACT-NFR-003** No new write authz: every action button maps to a pre-existing mutation + capability.
- **ACT-NFR-004** Degraded sources render honestly (`unavailable`), matching the repo's no-fabrication convention.

## 5. Acceptance criteria (selection)

- **AC-1** Tenant with 9 platform agents, 1 custom, 1 external → fleet lists 11 rows with correct kinds; external row shows auto-execute denied badge.
- **AC-2** Kill an agent from the fleet table → existing kill mutation fires, row chip flips via SSE ≤5s without refetch.
- **AC-3** usage-service down → spend column shows `unavailable`, all other columns render; no zeros fabricated.
- **AC-4** Inventory export → CSV+JSON with schema `agent-inventory.v1`, checksummed, visible in audit exports, generation event in audit log with actor.
- **AC-5** User without `usage.report.read` sees fleet without spend column; user without `agent.registry.read` gets 403 on the query.
