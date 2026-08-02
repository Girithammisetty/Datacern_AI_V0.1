# Platform status checkpoint — 2026-08-02

**Method:** every number below was measured against the repository or read from a CI run on this date. Nothing is quoted from an older document. Where a capability is built but unproven, it says so on the same line.

**Three states are used throughout, and they are not interchangeable:**

| | Meaning |
|---|---|
| **PROVEN** | Exercised against the real stack in a recorded CI run — real Postgres, Kafka, Iceberg, OpenSearch, MLflow, a real LLM |
| **TESTED** | Unit/integration tests pass; never exercised end to end on live infrastructure |
| **BUILT** | Code exists and compiles; no test proves the behaviour |

---

## 1 · Headline

The platform is **demo-ready on one machine and not production-ready anywhere.** Five of six end-to-end journeys pass against the real stack. The sixth has a fix that is written, unit-tested and negative-controlled, but has never executed live. Nothing has ever run outside a developer machine and CI.

**`main` is red right now**, and not for a platform reason: `ruff` reports one `I001` import-sort error in `services/agent-runtime/tests/unit/test_outcome_monitoring.py`, introduced by PR #46. That single lint failure gates `e2e-live` (`if: !contains(... needs.test-python.result)`), so **no live journey has run on `main` since PR #45 merged.** Fixed on this branch.

| | |
|---|---|
| Deployable services | **24** (11 Go · 11 Python · 2 Node) |
| Capability packs | **28** — 27 verticals at v2.1.0 + 1 shared library; **9 healthcare / life sciences** |
| Built-in agents | **9** |
| BRDs | **72** |
| Test functions | **~2,560** strict count — 985 Go, 996 TypeScript, 578 Python |
| E2E journeys | **6**, of which **5 PROVEN green** on the last complete run |
| Packs with a seeded demo scenario | **4 of 28** |
| Production cloud deployments | **0** |

---

## 2 · What is PROVEN — the last complete `e2e-live` run

PR #45, commit `499714a`, 2026-08-02. Full stack booted, real infrastructure, no mocks anywhere in the path. This is still the most recent complete `e2e-live` result: the run on the #45 merge commit (`bd6472c`) produced no `e2e-live` job at all, and the run after it (`0d786dd`) was gated out by the lint failure above.

| Step | Result |
|---|---|
| Boot the real platform (24 services + infra) | ✅ |
| Health gate (`make doctor`) | ✅ |
| **Governed write loop** — AI proposes → human approves → the row changes | ✅ |
| **Realtime case streams** — entitlement gate, watermark pull, department isolation | ✅ |
| **Learn flywheel** — 24 governed resolutions → labels → real training run → four-eyes promotion → batch scoring → cases for exactly the flagged rows | ✅ |
| **Schema-driven forms** — typed intake, refusals write nothing, AI drafting, human submit stored exactly | ✅ |
| **Pack conformance** | ❌ one check — see §5 |
| Live Playwright suite · restart soak · volume soak | ⏭ skipped behind the failure |

**What that run actually establishes.** Self-approval is rejected server-side. A forged authorisation grant is rejected. A pack refuses to install against a tenant with no data, naming every missing field. A model is trained, promoted through a distinct approver, and scores new work. The AI drafts and writes nothing until a named human signs.

Those are the load-bearing claims, and they are the ones with live evidence behind them.

---

## 3 · Capability inventory

### Governance and identity — PROVEN
- Multi-tenant isolation: Postgres RLS with `FORCE ROW LEVEL SECURITY`, tenant pinned from the verified JWT only
- Four-eyes approval: default on AI-proposed writes; **mandatory with no tenant opt-out** for high-risk, destructive and admin actions. Tenants *may* policy-enable auto-execution for low-risk non-destructive writes — the distinction is real and should never be flattened
- RBAC action catalog + OPA per-request authorization; canonical `<service>.<resource>.<verb>` grammar enforced by a CI gate
- Agent tool calls carry signed on-behalf-of grants through a governed tool plane
- Hash-chained audit log per tenant (ClickHouse) + S3 Object-Lock COMPLIANCE-mode WORM export

### Agentic plane — PROVEN
- 9 agents: `case-triage` · `governance` · `analytics` · `onboarding` · `dashboard-designer` · `model-training` · `ml-engineer` · `inference` · `meta-router`
- MCP **server**: one `/mcp` JSON-RPC endpoint, spec `2025-06-18`, `initialize`/`tools/list`/`tools/call`. Every agent tool call passes through it — one chokepoint, no bypass
- Hard budget caps that fail closed: platform → tenant → workspace → principal → key
- Prompt-injection defence: evidence fencing, injection signatures, untrusted input forces a human approval leg

⚠️ **Outbound federation is NOT MCP** — it uses a proprietary facade contract, so the platform cannot consume a third-party MCP server. Inbound only. See `DATACERN_MCP_CONNECTIVITY.md`.

### Data plane — mixed
- **19 connector types**: `databricks` `snowflake` `redshift` `bigquery` `synapse` `presto` `postgres` `mysql` `mariadb` `oracle` `sqlserver` `spanner` `s3` `azure_blob` `gcs` `sftp` `ftp` `http_api` `salesforce` — 17 driver modules. **TESTED, credential-gated: not one has pulled from a live external warehouse**
- 5 ingestion modes: `file_upload` `query` `file_poll` `scheduled_run` `webhook_batch` — file upload PROVEN; webhook ingestion BUILT
- Healthcare wire formats: X12 **270 271 276 277 834 835 837 999 TA1**, FHIR, HL7v2 — TESTED
- Iceberg lakehouse on S3-compatible storage; Trino + DuckDB with size-based routing — PROVEN

### ML plane — PROVEN
Experiments → real MLflow runs → registered models → four-eyes promotion → batch inference → auto-created cases. The full loop runs in `journey-learn`.

### Packs — PROVEN except drift
28 packs, ~20 component kinds each. Install / upgrade / rollback / drift API, C1–C11 coherence checker, fail-closed data-binding contract. Install, materialization, layout, uninstall and tombstoning are all green; the drift check is the open item.

### Commercial — TESTED
Plans, seat/quota enforcement, metering by tenant/workspace/user/agent, governed-decision counter, ROI reporting that **refuses to compute rather than estimate** when assumptions are missing.
⚠️ Per-**decision** cost attribution is ROADMAP — no join key exists.

---

## 4 · Demo readiness

**Ready to demo today — this is the rehearsed path:**

```bash
make up          # full platform + claims vertical, ~15 min
make doctor      # confirm green before you present
```

Gives 8 open triage cases (including a duplicate-invoice pair), 2 pending proposals in the approval inbox, a published semantic model, a dashboard, and a promoted model. Four personas, password `demo`.

The five beats all have live evidence: the pack refusal, copilot triage, approval with self-approval rejected, the learning loop, the audit trail.

**Ready with a caveat:** `packs/demo_sandbox.sh load <pack>` gives a seeded worklist for **4 packs only** — card-disputes (8 cases), banking-aml, insurance-claims-payer, payer-fwa-siu. It does not install the pack, so you get cases without that pack's dispositions.

**Not demo-ready:**
- `make demo-load <pack>` for the other 24 packs — installs config, creates zero cases by design
- Any pack install demo for an arbitrary vertical — rehearse the specific one first
- Anything requiring a hosted URL — there is no deployed environment

---

## 5 · Open items

| # | Item | State |
|---|---|---|
| 0 | **`main` is red on a lint error** — one `ruff I001` in `agent-runtime`, from PR #46. It gates `e2e-live`, so it is currently the reason no journey runs on `main` at all | Fixed here, unmerged |
| 1 | **`journey-packs` drift check** — `submitted` governed drafts counted as `missing`, so a healthy install reads drifted=11. PR #45 **merged at `499714a`, one commit before the correction**; `main` still carries the earlier fix, which addressed the wrong set. Carried here | Fix never executed live |
| 2 | **`land_pack_data.py`** — the recommended unblock for `make demo-load`. Compiled and linted, **never executed** | Unrun |
| 3 | **Databricks connector** — real, SDK-backed, dependency-declared, **never pointed at a live workspace**. The single most load-bearing unverified claim in any customer conversation | Unproven |
| 4 | **Live Playwright suite + both soaks** — skipped behind the journey-packs failure; unrun since before the current fixes | Unrun |
| 5 | **Partner-briefing §2 capability claims** — counts were re-verified 2026-08-01, the ~15 capability assertions were not | Unre-verified |

---

## 6 · Production readiness — the honest answer

**Not production-ready.** Not close, and the gaps are organisational as much as technical.

| Blocker | State |
|---|---|
| Customers, pilots, revenue | **Zero.** Never run outside development machines and CI |
| Production cloud deployment | **Zero.** Terraform for 4 clouds and 1 Helm chart exist and build in CI; **never applied** |
| SOC 2 / HITRUST / ISO 27001 | **Not started.** Self-identified as the #1 blocker to a first regulated customer; 6–12 months |
| Third-party penetration test | **None.** Internal cross-tenant probes exist and pass, covering a minority of services |
| SAML | **None.** Zero implementation across all services |
| Load / scale testing | **None run.** A written bottleneck audit exists; scale is proven at demo volume only |
| Incident-response plan | Not documented |
| Bus factor | **One engineer.** Mitigated by 72 BRDs and ~2,560 tests; not eliminated |

**The one-sentence version:** this is a deep, genuinely tested platform that has never met a customer, a production cloud, or an auditor — and the distance between those two facts is exactly what a first partner or design customer would be funding.

---

## 7 · What would most change this picture

In order of leverage per unit of effort:

1. **Land this branch** — the lint fix and the drift correction — and confirm all six journeys green. Cheap, and it is the only thing standing between "5 of 6 PROVEN" and "6 of 6". Until the lint error clears, `e2e-live` cannot run on `main` at all, so every other journey is also unmeasured right now.
2. **Point the Databricks connector at one real workspace, once.** Converts the strongest technical claim from written to demonstrated. Hours, not weeks.
3. **Apply the existing Terraform to one cloud account.** Turns "IaC written, never applied" — the most damaging line in every conversation — into a deployed environment, and gives the demo a URL.
4. **Start SOC 2.** Nothing else unblocks a regulated customer, and the clock is 6–12 months regardless of when it starts.

---

*Generated by measuring the repository and reading CI runs `30755491928` (PR #45, the last complete `e2e-live`), `30755528767` (the #45 merge) and `30756366095` (`main` @ `0d786dd`) on 2026-08-02. If this document and the codebase ever disagree, the codebase is right and this is a defect.*
