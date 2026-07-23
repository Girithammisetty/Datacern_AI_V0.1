# BRD 60 — External-agent toolset allow-list closure

**Status:** done — 2026-07-23
**Commits:** `<pending>`  ·  **Related:** [BRD 60](../brd/60_external_agent_governance_BRD.md) (external agent governance), BRD 53 (custom agents / per-agent guardrail envelope), memory `project_datacern_external_agent_governance`, `project_windrose_custom_agents`

---

## 1. Analysis

### 1a. Platform / product

BRD 60's thesis is that a customer's *own* agent must pass every regulated write
through Datacern's governed rails: propose-only, four-eyes, WORM audit, tier
ceiling, and — critically — **the agent's own declared toolset as an enforced
allow-list**. The allow-list is the promise "this external bot may only ever
touch these tools." During WS5 SDK live-verify that promise did not hold for the
external demo agent `acme-ext-bot`: a propose for a tool NOT on its allow-list
was accepted as a pending proposal. The other controls still bound (tier
ceiling, propose-only, four-eyes), but the allow-list — the control a buyer's
risk team most wants to see — was silently inert.

### 1b. Technical

The enforcement code is correct. The allow-list check in
`ProposalService._enforce_guardrail`
([services/agent-runtime/app/proposals/service.py:156](../../services/agent-runtime/app/proposals/service.py))
is `if allowed and intent.tool_id not in allowed: raise GuardrailViolation`. The
guard on `allowed` is deliberate: for internal seeded agents an empty toolset
means "no write surface declared," so there is no allow-list to be outside of.

The root cause was **data, not code**: `acme-ext-bot` was minted a signed agent
token and could reach the ingress, but was never *registered* — it had no
`agent_versions` row at all, so `get_agent_version(...)` returned `None`,
`allowed` resolved to the empty set, and the allow-list check was skipped. The
external ingress (`POST /external/v1/intents`,
[services/agent-runtime/app/api/routes/external.py](../../services/agent-runtime/app/api/routes/external.py))
took `agent_id`/`agent_version` from the (signed) token and built a `WriteIntent`
without ever requiring the agent to have a registered, non-empty toolset.

Evidence (pre-fix, real Postgres `agent_runtime.proposals`): `acme-ext-bot` had
**no** `agent_versions` / `agent_definitions` row, yet a `tool.not_on_allowlist`
proposal sat `pending` — an off-allow-list write accepted.

---

## 2. Architecture & Design

Two parts: register the agent (closes it for the demo), and harden the ingress
(closes the *class* of bug for every external caller).

**Registration.** External agents register an **identity + toolset allow-list**
but do NOT run an internal graph — the ingress reads their declared toolset and
routes the write through `ProposalService`; it never executes an agent graph.
So the generic graph-backed operator registry route
(`POST /api/v1/registry/agents/{k}/versions`) does not apply: it computes
`graph_digest(graph_ref)` from the registered graph module's source and 500s on
a graph-less `graph_ref="external"`. Instead the agent's control-plane record is
written through the platform's own store (`SqlStore.upsert_agent_definition` +
`create_agent_version`) with `graph_ref="external"` and a sentinel digest —
exactly the shape the WS1 unit test fixtures already use. The running
agent-runtime reads `agent_versions` fresh per request
([sql.py:156](../../services/agent-runtime/app/store/sql.py)), so the allow-list
binds immediately with no restart. This is captured as a repeatable operator
script, [deploy/demo/brd60_external_agent.py](../../deploy/demo/brd60_external_agent.py).

**Ingress hardening (defense-in-depth).** Registering one agent fixes one agent;
it does not close the gap. For the strictly-less-trusted external boundary, an
absent/empty allow-list must mean **deny-all**, not allow-all — the opposite of
the internal default. `external.py` now resolves the agent version up front and
fails closed with `GUARDRAIL_VIOLATION` when there is no registered, non-empty
toolset, *before* any run/proposal row exists. This asymmetry is intentional and
lives only at the external boundary; internal agents keep the existing
"empty = no write surface" semantics in `_enforce_guardrail`.

**Invariants preserved.** The tier ceiling, propose-only (empty auto-execute
policy), four-eyes distinct-approver, anti-laundering server-derived effect, and
the `ai.proposal.v1` WORM emit all bind unchanged.

**Out of scope.** WS2 self-service external-agent registration as a product
surface (an operator/tenant API for `origin=external` agents). This initiative
registers the demo agent via the store and hardens the boundary; the
first-class registration UX remains BRD 60 WS2.

---

## 3. Implementation & Test

**Built.**
- [services/agent-runtime/app/api/routes/external.py](../../services/agent-runtime/app/api/routes/external.py)
  — fail-closed check: an external agent with no registered non-empty toolset is
  refused `403 GUARDRAIL_VIOLATION` before any row is created.
- [deploy/demo/brd60_external_agent.py](../../deploy/demo/brd60_external_agent.py)
  — idempotent operator registration of `acme-ext-bot`
  (`toolset=[case.apply_disposition]`, `graph_ref=external`, published) via the
  platform store, followed by an end-to-end live-verify through the real
  `datacern-agent` SDK.
- [services/agent-runtime/tests/unit/test_external_intents.py](../../services/agent-runtime/tests/unit/test_external_intents.py)
  — two new tests: an unregistered external agent and a registered-but-empty
  toolset agent are both refused `403 GUARDRAIL_VIOLATION`.

**Verified.**
- Unit: agent-runtime suite **300 passed** (external-intents file 9/9, incl. the
  two new fail-closed tests).
- Live (running stack, no restart), via the real `datacern-agent` SDK against
  agent-runtime :8306:
  - OFF-allow-list propose (`case.delete_everything`) → **403 GUARDRAIL_VIOLATION**,
    no proposal row created.
  - ON-allow-list propose (`case.apply_disposition`) → **200 pending** governed
    proposal (`executed=false`), landed in the four-eyes inbox.
  - Real Postgres confirms `agent_versions(acme-ext-bot, v1, graph_ref=external,
    toolset=[case.apply_disposition], published)`.
- Stale pre-fix bug-artifact proposals (`tool.not_on_allowlist`,
  `case.delete_everything`) were removed from the demo tenant's inbox.

**Deferred / honest.** The new fail-closed branch in `external.py` is
unit-verified; live-verifying it (an *unregistered* external token → 403) needs
the running agent-runtime reloaded, since it is not started with `--reload`. The
allow-list closure itself (the task's deliverable) is fully live-verified against
the running service because that path runs through the unchanged
`_enforce_guardrail`.
