# MCP & data-source connectivity — validated state

**Validated:** 2026-08-01, by reading the code paths cited below. **Audience:** their CTO, and you before the meeting.
**Question answered:** *can all existing agents connect to data sources via any protocol, e.g. MCP?*

**Short answer:** MCP is real and it is the single chokepoint for every agent tool call — **inbound**. Anyone can drive the platform as an MCP client today. **Outbound** federation is a proprietary facade contract, not MCP, so the platform cannot today call a third-party MCP server. And most agent *reads* don't traverse MCP at all.

Say it in that order. The half that works is the half that matters for a voice-platform partner.

---

## 1 · Northbound — the platform IS an MCP server ✅

| Fact | Evidence |
|---|---|
| Single `/mcp` Streamable-HTTP JSON-RPC endpoint | `tool-plane/internal/api/gateway.go:52` |
| Methods: `initialize`, `tools/list`, `tools/call` | `gateway.go:111-119` |
| MCP spec version **pinned** to `2025-06-18` | `tool-plane/internal/mcp/backend.go` — `SpecVersion` |
| **All 9 agents** call tools only through it — JSON-RPC 2.0, `tools/call` | `agent-runtime/app/adapters/tools.py:3,47-49` |
| One chokepoint, no bypass: every gate passes before a backend is reached | `tool-plane/internal/enforce/pipeline.go:123,324` |
| Per-call controls: kill switch, tier, authz, signed proposal grant, 1 MB response cap, timeout classification, health accounting | `enforce/{pipeline,killswitch,health}.go`, `mcp/backend.go` |

The nine agents, all with declared tool capabilities: `case-triage`, `governance`, `analytics`, `onboarding`, `dashboard-designer`, `model-training`, `ml-engineer`, `inference`, `meta-router`.

**What this means commercially:** their voice agent — or any third-party MCP client — can call this platform over standard MCP today, and every call is authorised, tiered, rate-limited, kill-switchable and audited. **That is the integration direction the partnership actually needs.**

---

## 2 · Southbound — outbound federation is NOT MCP ⚠️

The gateway federates to backends over real HTTP, but the body it sends is Datacern's own contract, not JSON-RPC:

```go
// tool-plane/internal/mcp/backend.go:127
body, _ := json.Marshal(map[string]any{
    "tool_id": in.ToolID, "version": in.Version, "args": in.Args,
    "tenant":  in.Tenant, "obo_sub": in.OboSub,  "agent_id": in.AgentID,
})
```

Backends implement `POST /internal/v1/mcp/invoke`. Seven services do today: **case, ingestion, inference, chart, experiment, dataset, bff-graphql**.

`bff-graphql` is the exception that proves the rule. Every other facade answers out of its OWN store, so the body above (attribution, no credential) is all it needs — it re-authorizes `obo_sub` against its own OPA sidecar. `bff-graphql` hosts exactly one tool, `search.query`, which owns no store and can only answer by reading eight other services AS THE CALLER. For that case, and only that case, the gateway ALSO forwards `Authorization: Bearer <the verified caller token>` — gated on the tool's registered version declaring the downstream actions it will exercise, and on the caller's token being narrowed to exactly that declaration (`tool-plane/internal/domain/delegation.go`, BRD 74 AC-10). A tool that declares nothing receives no `Authorization` header, exactly as before.

**Consequence, stated plainly:** the platform is an MCP *server*, not an MCP *client*. It cannot point at an off-the-shelf third-party MCP server (a Snowflake / Salesforce / EHR MCP server, say) and consume its tools. Closing that means adding an MCP client adapter alongside `HTTPBackend`.

The groundwork is there — `mcp_backends` already models `kind: internal | external`, `egress_allowlist`, `vault_auth_ref`, `spiffe_id` (`tool-plane/migrations/000001_init.up.sql:69`) — so this is an adapter behind an existing interface (`BackendInvoker`), not a re-architecture. **Do not quote a delivery estimate you haven't scoped.**

---

## 3 · Agent reads mostly bypass MCP entirely ⚠️

Only *tool calls* traverse MCP. Evidence-gathering and reads go through ~20 direct internal service clients in `agent-runtime/app/adapters/`:

`case · dataset · memory · semantic · evidence · ingestion · experiment · pipeline · rbac · chartcatalog · realtime · authz · killswitch · llm · trainer · eval_gate · sessionproj · vkeys …`

This is a deliberate split — **reads are direct, writes are governed** — and it's defensible. But it means "all agent data access is MCP" is **false**. Say "all agent *tool calls* are MCP" instead. It's true and it's the claim that matters.

---

## 4 · BYO external tools — workflow built, wiring missing ⚠️

| Built | Evidence |
|---|---|
| BYO submit / list / approve / reject workflow | `tool-plane/internal/api/handlers_admin.go:185-300` |
| External tools can **never** hold write-direct or admin tier — enforced at *both* submit and approve (TPL-FR-040) | `handlers_admin.go:212, 289` |
| Approval emits an auditable domain event | `handlers_admin.go:294` |

**Not built:** approving a BYO submission does **not** create a callable backend. `decideBYO` flips status and emits an event; that's all. `CreateBackend` exists in the store (`store/backend.go:26`) but is reached **only from a test fixture** — there is no API route to it.

In practice, backends are wired by **direct SQL INSERT** from the e2e seed script (`deploy/e2e/lib/seed.py:314`), run at `make up`. Fine for a demo; not a customer-facing capability.

---

## 5 · How you answer in the room

**If asked "can your agents talk to our systems over MCP?"**

> "Both directions are worth separating. Inbound — yes, today. We're an MCP server: `/mcp`, spec 2025-06-18, `initialize`/`tools/list`/`tools/call`. Your voice agent can call us as a standard MCP client, and every call is authorised, tiered, kill-switchable and audited. That's the direction your integration needs.
>
> Outbound — not yet. Our federation to backends uses our own facade contract rather than MCP, so we can't point at a third-party MCP server today. The backend model already carries external kind, egress allow-list and vault auth, so it's an adapter behind an existing interface — but I haven't scoped it and I won't quote you a date."

**If asked "so all your agents' data access is MCP?"**

> "All their *tool calls* are — one chokepoint, no bypass. Reads go direct to internal services. That's deliberate: reads are cheap and read-only, writes are governed. I'd rather tell you that than let your team find it."

**Say this once, unprompted.** Volunteering §2-§4 before their CTO discovers them is worth more than any claim in §1.

---

## Do-not-say

- ❌ "We support any protocol" → one protocol inbound (MCP), one proprietary contract outbound.
- ❌ "We can plug into any MCP server" → **no MCP client exists.** Inbound only.
- ❌ "All agent data access goes through MCP" → tool calls only; reads are direct.
- ❌ "BYO external tools are supported end to end" → submission and approval only; approval creates no callable backend.
- ❌ Any delivery estimate for the MCP client adapter that you have not scoped in writing.

---

## Open items this raises (engineering backlog, not pitch material)

1. **MCP client adapter** — a second `BackendInvoker` speaking JSON-RPC outward, so `kind=external` backends can be genuine MCP servers.
2. **Wire BYO approval to `CreateBackend`** — today approval is a status flip with no effect on callability.
3. **An API route for backend registration** — replace the seed script's direct SQL.
