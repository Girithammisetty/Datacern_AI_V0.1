# BRD 60 — External Agent Governance

**Status:** in-progress — 2026-07-22 · inc-1 landed
**Owner:** platform · **Related:** BRD 53 (custom agents), tool-plane MCP gateway, ProposalService four-eyes, audit WORM chain, memories `project_windrose_custom_agents`, `project_windrose_ml_engineer_agent`, `project_windrose_decision_writeback`

---

## Problem / Strategic framing

Every hyperscaler and framework is shipping an **agent runtime** — loops, tools,
memory, orchestration (Bedrock Agents, Agentforce, Copilot Studio, LangGraph,
CrewAI). That layer is commoditizing fast. Competing there means losing on
distribution to the clouds and on velocity to frameworks.

What almost none of them have is what Datacern already built: a **governance
fabric** (typed four-eyes proposals, risk tiering, anti-laundering, kill
switches, per-agent guardrails, workspace-scoped data access) and a
**tamper-evident audit chain** (hash-chained WORM). As companies deploy more
agents, the acute questions become exactly the three Datacern was built to
answer: *who approved this action, can we prove it, and is it actually
working?*

**The repositioning:** stop competing as "another agentic platform"; become
**the governed decision layer that other people's agents must pass through**. A
customer builds their own agent however they like — LangGraph, Claude, a
Copilot — but when that agent needs to act on regulated case/SoR data, it does
so ONLY through Datacern's governed tools, so every write becomes a four-eyes
proposal in the WORM chain, subject to kill switches, guardrails, and
per-resource workspace grants. This turns competitors' agent-platform teams
into Datacern's funnel: their platform team builds the bot, their risk/
compliance team mandates this layer.

## What already exists (researched, not assumed)

The entire enforcement spine is already built and already fires — for internal
agents. Confirmed seams:

- **The MCP gateway** (`tool-plane`, real MCP JSON-RPC at `POST /mcp`) runs the
  full per-call pipeline on every `tools/call`: authN → kill/enablement → OPA
  obo-grant → rate-limit → schema → tier → grant-verify → invoke → audit, and
  emits `ai.tool_invoked.v1`. A **write-tier call without a signed grant already
  returns `PROPOSAL_REQUIRED` and never executes.**
- **`ProposalService.create_from_intent`** (`agent-runtime`) is the single
  proposal-minting chokepoint: caller-permission gate (`_authorize_caller`),
  toolset allow-list + `write-proposal` tier ceiling (`_enforce_guardrail`),
  server-derived `predicted_effect` (anti-laundering), and the `ai.proposal.v1`
  WORM emit carrying `via_agent` (which agent acted) distinct from `actor` (on
  whose behalf).
- **Four-eyes** (`decide` → distinct-approver check → self-approve block →
  signed execution grant → apply) is enforced and reused by the existing
  `/inbox` approval UI.
- **The signed proposal-execution grant** (RS256, bound to tenant/tool/tier/
  args-digest) is the cryptographic guarantee that only a human-approved write
  executes; the gateway refuses forged/expired/mismatched grants.
- **The backend MCP facade** (case-service `POST /internal/v1/mcp/invoke`,
  SPIFFE-allowlisted, fail-closed, re-checks OPA independently) is the second,
  in-cluster gate on the actual SoR mutation.

**The gap** is narrow and specific: all of the above is reachable only by an
internal `typ=agent_*` principal minted by the platform, and only from inside
the cluster. There is no external, tenant-owned agent principal, no ingress
that turns an external agent's proposed write into a governed proposal, and the
`data_scope/budget/pii` guardrail slice lives inside the internal graph (so it
doesn't cover an external caller).

---

## WS1 — Governed external-intent ingress (inc-1) — the spine

### Analysis
The highest-leverage, smallest build: a customer's agent must be able to
*propose* a write and have it ride the exact same four-eyes + WORM rails as an
internal agent, with the agent's own declared toolset enforced. Everything
downstream of `create_from_intent` already delivers this — it just has no
external ingress.

### Design
A new authenticated endpoint on agent-runtime, `POST /external/v1/intents`,
that:
- authenticates the caller as an **agent principal** (`typ` starts with
  `agent`) — i.e. a registered agent identity, never a raw user;
- builds a `WriteIntent` from the request and routes it through
  `ProposalService.create_from_intent` with an **empty auto-execute policy**, so
  an external agent's write can ONLY ever become a *pending* proposal — never an
  inline write, regardless of tenant auto-execute config. This is a deliberate
  governance stance: external callers are strictly less trusted than the
  platform's own graphs, so the auto-execute fast-path is denied to them
  entirely.

All existing controls apply unchanged: the agent's `AgentVersion.toolset`
allow-list and the `write-proposal` tier ceiling (`_enforce_guardrail`), the
on-behalf-of caller-permission gate (`_authorize_caller`, which for
workspace-scoped actions already enforces workspace containment via the
per-resource RBAC grant), the server-derived effect, the `ai.proposal.v1` WORM
emit with `via_agent`, and the existing `/inbox` four-eyes decide→apply.

### Implement / Test
- [x] `POST /external/v1/intents` ingress + `Run` shell + propose-only routing —
  see Implementation & Test log below (unit + live-verified to the WORM store).

---

## WS2 — External-agent identity (self-service credential) — planned

A dedicated per-agent credential so a tenant can onboard its own agent without
the platform minting the token. `/token/agent/external` exchange (template:
`/token/embed/oidc` — already mints short-lived, workspace-scoped, per-end-user
tokens from a tenant IdP) → a `typ=agent_obo` token bound to `{tenant,
agent_key, agent_version, obo_sub?, scopes=read-toolset}`. Read tools are in the
token scope; write tools never are, so a gateway write `tools/call` still yields
`PROPOSAL_REQUIRED`. External agents register as custom agents (BRD 53) with an
`origin=external` marker.

## WS3 — Public governed edge — planned

Expose the read/list-tools + propose surface at the one public ingress
(bff-graphql), forwarding to the internal gateway/ingress with the external
token. No change to the gateway pipeline itself.

## WS4 — Guardrail lift (data_scope / budget / PII) — planned

Lift the `data_scope refusal / budget cap / PII-egress redaction` envelope out
of the internal `persona_copilot` graph to a request-scoped enforcement point
that also covers the external-intent ingress, closing the one control that does
not automatically transfer to external callers today.

## WS5 — SDK + compliance-evidence export — planned

A thin client SDK (the customer's agent calls "propose(tool, args)") and an
auditor-facing evidence export ("here is the WORM audit pack for this decision")
— the tangible artifacts that make the differentiation demoable.

---

## Sequencing
WS1 (spine) first — it proves the whole external-write→four-eyes→WORM thesis
with the smallest build. WS2/WS3 (identity + public edge) make it a real
self-service product surface. WS4 closes the last guardrail gap. WS5 is the
go-to-market polish. Each is independently shippable.

---

## Implementation & Test log (landed increments)

### WS1 — governed external-intent ingress — DONE

**Research before building** (a dedicated read-only survey, not assumed from
the strategic framing): confirmed the entire enforcement spine already exists
and already fires for internal agents — the MCP gateway's per-call pipeline, the
`ProposalService.create_from_intent` chokepoint (caller-gate + toolset/tier
`_enforce_guardrail` + server-derived effect + `ai.proposal.v1` WORM emit), the
four-eyes `decide`, the signed execution grant, and the SPIFFE-fail-closed
backend facade. The gap was narrow: no external agent principal, no ingress
turning an external agent's proposed write into a governed proposal.

**Implementation:** one new route, `POST /external/v1/intents`
(`services/agent-runtime/app/api/routes/external.py`), wired into `main.py`.
It authenticates the caller as an **agent principal** (`typ` starts with
`agent` — a registered agent identity, never a raw user), builds a
`WriteIntent`, persists a lightweight `Run` shell (no graph session — runs has
no FK to sessions), and routes through `ProposalService.create_from_intent`
with an **empty auto-execute policy** so an external agent's write can ONLY ever
become a *pending* proposal, never an inline write, regardless of tenant
config. Zero change to any downstream control: the agent's `AgentVersion.toolset`
allow-list + `write-proposal` tier ceiling, the on-behalf-of caller-gate, the
anti-laundering `derive_effect`, the `ai.proposal.v1` WORM emit with
`via_agent`, and the existing `/inbox` four-eyes decide→apply all apply unchanged.

**Test:** `tests/unit/test_external_intents.py` — 7 tests driving the REAL route
through the REAL `ProposalService` (in-memory container, no mocks): a valid
intent becomes a pending proposal with `via_agent` attribution and a
server-derived (agent-claim-demoted) effect; a tool off the agent's registered
allow-list → `GUARDRAIL_VIOLATION`; `write-direct` tier → `GUARDRAIL_VIOLATION`
(external agents can never get a direct write); a raw user token → 403; a
high-risk external proposal cannot be self-approved by its own on-behalf-of user
(four-eyes binds external proposals exactly as internal ones); body validation.
Full agent-runtime unit suite: 296 passed (up from 289).

**Live-verified end to end** against the real running stack (user-approved
agent-runtime restart): minted a real RS256 agent token with the harness signing
key (kid `e2e-harness-key-1`, the same key identity-service's OBO exchange signs
with, so it verifies against the real JWKS), POSTed a `write-proposal` intent →
`200`, `status: pending`, `executed: false`. Confirmed the row landed in **real
Postgres** (`agent_runtime.proposals`: `acme-ext-bot`/`write-proposal`/`pending`/
`obo_user=u-ext-smoke`); confirmed the `ai.proposal.v1` / `proposal.created`
event was emitted with `via_agent={acme-ext-bot,1}` distinct from `actor`; and
confirmed it reached the **WORM store** (ClickHouse `audit_events`,
`event_type=proposal.created`, `via_agent_id=acme-ext-bot`). A live
`write-direct` attempt was refused with `403 GUARDRAIL_VIOLATION`, and the
agent's own `predicted_effect.summary` ("external claimed effect") was demoted
to `agent_summary` while the server derived the `authoritative_summary` +
`args_digest` + `risk` — anti-laundering working live for an external caller.

**Known limitation, flagged not hidden (WS4):** the `data_scope/budget/pii`
guardrail slice is enforced inside the internal `persona_copilot` graph, which
an external caller bypasses; the toolset + tier ceiling + on-behalf-of caller-
gate (which for workspace-scoped actions already enforces workspace containment
via the per-resource RBAC grant) DO bind external agents today. Lifting the
data_scope/budget/PII envelope to the ingress is WS4.

_Next: WS2 (dedicated external-agent self-service credential + `/token/agent/
external` exchange) — gated on the next explicit go-ahead._
