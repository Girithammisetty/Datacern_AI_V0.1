# Platform status checkpoint — 2026-08-03

**Method:** every number below was measured against the repository or read from a named CI run. Nothing is quoted from an older document. Where a capability is built but unproven, it says so on the same line. Where a fix is merged but has not executed against the real stack, it says that too — the distinction matters more than usual here, because three separate fixes in the last day looked correct and were not.

**Three states are used throughout, and they are not interchangeable:**

| | Meaning |
|---|---|
| **PROVEN** | Exercised against the real stack in a recorded CI run — real Postgres, Kafka, Iceberg, OpenSearch, MLflow, a real LLM |
| **TESTED** | Unit/integration tests pass; never exercised end to end on live infrastructure |
| **BUILT** | Code exists and compiles; no test proves the behaviour |

---

## 1 · Headline

The platform is **demo-ready on one machine and not production-ready anywhere.** All six end-to-end journeys now pass against the real stack — the first time that has been true. Nothing has ever run outside a developer machine and CI.

**What changed on 2026-08-03.** `journey-packs` went green after a third drift defect was found and fixed, and passing it unblocked the live Playwright suite, which then executed **for the first time in this repository's history**: 43 of 65 tests passed, 4 failed, 18 skipped. The four failures were one defect — `journey-forms` declaring a *required* custom case field and never removing it, which made every later case write in that tenant fail validation. That leak had existed for as long as the journey had; nothing downstream had ever run to notice it.

That is the shape of this checkpoint: the platform got measurably more proven, and the newly-run suites immediately found real bugs. Both facts are load-bearing.

| | |
|---|---|
| Deployable services | **24** (11 Go · 11 Python · 2 Node) |
| Capability packs | **28** — 27 verticals at v2.1.0 + 1 shared library; **9 healthcare / life sciences** |
| Built-in agents | **9** |
| BRDs | **72** |
| Test functions | **~2,560** strict count — 985 Go, 996 TypeScript, 578 Python |
| E2E journeys | **6**, all **6 PROVEN green** on the last complete run |
| Live UI tests (`pnpm e2e:live`) | **43 passed · 4 failed · 18 skipped** — first execution ever |
| Packs with a seeded demo scenario | **4 of 28** |
| Production cloud deployments | **0** |

---

## 2 · What is PROVEN — the last complete `e2e-live` run

`main`, commit `6f996fd`, 2026-08-03. Full stack booted, real infrastructure, no mocks anywhere in the path.

| Step | Result |
|---|---|
| Boot the real platform (24 services + infra) | ✅ |
| Health gate (`make doctor`) | ✅ |
| **Governed write loop** — AI proposes → human approves → the row changes | ✅ |
| **Realtime case streams** — entitlement gate, watermark pull, department isolation | ✅ |
| **Learn flywheel** — 24 governed resolutions → labels → real training run → four-eyes promotion → batch scoring → cases for exactly the flagged rows | ✅ |
| **Schema-driven forms** — typed intake, refusals write nothing, AI drafting, human submit stored exactly | ✅ |
| **Pack conformance** — 30 checks: install, materialization, layout, drift, uninstall, tombstoning | ✅ |
| **Live Playwright suite** (`pnpm e2e:live`, 65 tests) | ❌ 4 failed · 43 passed · 18 skipped |
| Restart soak · volume soak | ⏭ skipped behind the Playwright failure — **still never executed** |

**What that run actually establishes.** Self-approval is rejected server-side. A forged authorisation grant is rejected. A pack refuses to install against a tenant with no data, naming every missing field; installing it materializes 8 case fields, 7 dispositions and 5 roles as real rows, and uninstalling reverses 47 objects while tombstoning 21 it cannot reverse. A model is trained, promoted through a distinct approver, and scores new work. The AI drafts and writes nothing until a named human signs.

**New in this run — the live UI.** 43 browser tests passed against the running stack: every module renders through the real auth path, the pipeline create → run → schedule → delete lifecycle, model-version promotion, experiment lifecycle, run notes, dataset rename surfacing a real 409 conflict, and the human-correction → learning-loop hero path. That is the first time any of it has been exercised outside a developer's machine.

The 4 failures were all in `cases-journeys.spec.ts` and all one cause (§5.1). Two independent runs (`680d318`, `cef8e25`) confirm the five non-pack journeys pass repeatably; `journey-packs` has one green run so far.

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

**The UI itself is now evidenced, not just the APIs.** As of `6f996fd`, 43 Playwright tests drive the real browser against the running stack: the admin persona authenticates through the real auth path, and `/cases`, `/inbox`, `/copilot`, `/data/ingestions`, `/data/connections`, `/data/pipelines` and `/data/pipelines/runs` all render live. Before this run, "the UI works" rested on a hermetic contract-server stand-in. Four specs still fail (§5.1) — all in case creation, one cause, fix merged and awaiting its first live run — so **rehearse case creation specifically before presenting it.**

**Ready with a caveat:** `packs/demo_sandbox.sh load <pack>` gives a seeded worklist for **4 packs only** — card-disputes (8 cases), banking-aml, insurance-claims-payer, payer-fwa-siu. It does not install the pack, so you get cases without that pack's dispositions.

**Not demo-ready:**
- `make demo-load <pack>` for the other 24 packs — installs config, creates zero cases by design
- Any pack install demo for an arbitrary vertical — rehearse the specific one first
- Anything requiring a hosted URL — there is no deployed environment

---

## 5 · Open items

| # | Item | State |
|---|---|---|
| 1 | **`e2e:live` — 4 failing specs**, all `cases-journeys.spec.ts` (`:216 :269 :375 :507`), all one cause: `journey-forms` declared `siu_referral_<RUN>` as a **required** custom field and never removed it, so every later case write failed `VALIDATION_FAILED`. Fixed in #74 (the journey now deletes its own fields, asserted on the happy path plus a `finally` over all 14 exit paths) | Fix merged, **not yet verified live** |
| 2 | **Restart soak + volume soak** — skipped behind `e2e:live` on every run to date. **Neither has ever executed, once.** | Never run |
| 3 | **Databricks connector** — real, SDK-backed, dependency-declared, **never pointed at a live workspace**. The single most load-bearing unverified claim in any customer conversation | Unproven |
| 4 | **`land_pack_data.py`** — the recommended unblock for `make demo-load`. Compiled and linted, **never executed** | Unrun |
| 5 | **Partner-briefing §2 capability claims** — counts were re-verified 2026-08-01, the ~15 capability assertions were not | Unre-verified |

### 5.1 · Why `journey-packs` took three fixes, and what that says

The drift check reported a bare count, and each wrong count cost a full 35-minute e2e cycle to diagnose. Three distinct defects hid behind the same number:

| Symptom | Actual cause |
|---|---|
| `drifted=11 missing=11` | Components deliberately never materialized (awaiting a dataset binding) counted as deleted |
| `drifted=11` again | The real 11 were **`submitted` governed drafts** — real objects awaiting a steward's four-eyes approval, absent from the *published* listing drift reads |
| `drifted=4 missing=4` | Bound datasets recorded under the **pack's** declared name, looked up among the **tenant's** dataset names |

Each fix was correct and none of them was sufficient. The assertion now **names** every offending row (`status kind/identity detail`) instead of counting them — the standard the adjacent edit-detection check was already held to. A detector that says a number is only marginally better than one that says nothing.

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

1. **Get `e2e:live` green and let the two soaks run.** #74 fixes the known cause. The soaks — restart survival and volume/load — have never executed once, so they are the largest block of completely unmeasured behaviour left in CI. Expect them to find things; that is the point.
2. **Point the Databricks connector at one real workspace, once.** Converts the strongest technical claim from written to demonstrated. Hours, not weeks.
3. **Apply the existing Terraform to one cloud account.** Turns "IaC written, never applied" — the most damaging line in every conversation — into a deployed environment, and gives the demo a URL.
4. **Start SOC 2.** Nothing else unblocks a regulated customer, and the clock is 6–12 months regardless of when it starts.

**A note on what tonight's evidence is worth.** Between 2026-08-02 and 2026-08-03, four CI defects were fixed — a lint error that gated every live journey, an RBAC catalog entry that stopped a service booting, and two separate semgrep surfaces — and three drift defects behind one assertion. Every one of them was found by running something that had not been run before. The lesson is not that the platform is fragile; the five non-pack journeys pass repeatably on independent runners. It is that **coverage that has never executed is not coverage**, and this repository still has two such suites.

---

*Refreshed 2026-08-03 from CI run `30780099971` (`main` @ `6f996fd`) — the first run in which all six journeys passed and `pnpm e2e:live` executed. Corroborated against run `30777994816` (`cef8e25`), which reproduced the same five-journey result on a different runner. Earlier figures came from `30755491928` (PR #45) on 2026-08-02. If this document and the codebase ever disagree, the codebase is right and this is a defect.*
