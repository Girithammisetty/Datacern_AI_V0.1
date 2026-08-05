# UI ↔ BFF ↔ downstream wiring validation — 2026-08-05

**Question answered:** do all 91 UI pages have real BFF and downstream
integrations, and are their workflows exercised end-to-end?

**Method:** two halves, and they are not interchangeable.

1. **Static wiring audit** — `tools/wiring/audit_ui_wiring.py` (new, pure
   stdlib, ~3s, now a gating CI job). It cross-checks four layers that tsc
   cannot see across: every GraphQL field referenced by the UI's operations →
   declared in the BFF schema → implemented by a resolver → and every path the
   BFF's downstream clients call → registered by the target service (FastAPI
   router prefixes and chi `Route()` nesting reconstructed).
2. **Dynamic workflow evidence** — what the e2e suites actually drive, measured
   from the spec files, and the gaps closed where cheap (the smoke sweep now
   visits every static-path route).

This sandbox has no Docker daemon, so nothing here was newly executed against a
live stack. Static results are PROVEN-by-analysis; dynamic results cite the
CI runs that exist and the sweep that will run next.

---

## 1 · Static wiring: PASS on every blocking check

| Check | Result |
|---|---|
| Pages | **91** |
| UI GraphQL operations (operations.ts + inline server-route docs) | **527** |
| BFF root fields declared (Query+Mutation) | **552** |
| Root fields with a resolver | **552** |
| **A** — UI references a field missing from the schema | **0** |
| **B** — schema field without a resolver | **0** |
| **D** — resolver without a schema field | **0** |
| **G** — client hook unused by any page | **0** |
| **F** — BFF client path with no downstream route | **0** (after reconstructing chi nesting + APIRouter prefixes; every one of the 35 initial hits was a matcher deficiency, verified individually) |
| **E** — page with no data wiring at all | **1**: `/welcome/walkthrough` — an intentionally static public marketing page (per its own header comment) |
| **C** — schema fields unused by any UI operation | **26** (informational; served surface with no UI caller — legitimate for API-explorer/external consumers, candidates for pruning otherwise) |

The 26 unused fields: activateUser, aiBudget, bindCaseStreamTrigger, budget,
bulkCreateInferenceJobs, caseStream, chart, createAgentVersion, deleteTenant,
evalCase, evalDataset, evalGate, evalGatesByDigest, group, inferenceSchedule,
ingestionSchedule, patchTenant, pipelineRun, pocCriteria, pushCorpusDocument,
registerAgentDefinition, reportSubscription, verifiedQuery, workspace,
writeMemory, writeMemoryBatch.

**What this proves:** no page can send an operation the BFF doesn't declare; no
declared operation resolves to a silent null; no BFF client calls a downstream
path that doesn't exist. **What it cannot prove:** correct behaviour, data
shapes, or authz outcomes — that is the dynamic half's job.

Known tool limitation: per-page hook attribution saturates through the shared
app shell (every authed page transitively reaches the full hook set), so the
page-level signal is binary — wired vs unwired — which is all finding E needs.

## 2 · Dynamic workflow coverage: 27 / 14 / 50 → sweep completed

Measured from spec files (comment-aware literal extraction, mapped to routes):

| Tier | Routes | Meaning |
|---|---|---|
| Workflow-driven | **27** | a journey spec drives real interactions (create/approve/run/assert) |
| Render-only | **14** | the smoke sweep proves UI→BFF→service→DB composes for a real persona |
| Untouched | **50** | no e2e visits the route at all |

The 50 untouched routes clustered in: `/admin/*` depth (13), `/ml/eval/*` (7),
`/ml/*` (5), data-domain authoring (`/data/upload`, `/data/ontology`,
`/data/entity-resolution`, `connections/new|[id]`, `semantic-models/new|[id]`),
`/copilot/runs`, `/notifications`, `/packs`, `/dashboards/reports`, embed (3),
marketing (4), and dynamic-id detail pages.

**Closed this session:** `smoke.spec.ts` now sweeps **every static-path route**
— +27 tenant routes, +6 platform-operator routes (each asserted BOTH ways:
renders for a platform admin, denied to a tenant admin), +4 public marketing
pages asserted to serve without a session. After the next `e2e-live` run, the
"untouched" tier reduces to routes that genuinely need per-run fixture ids
(9 dynamic `[id]`/`[slug]` detail pages — owed by their module specs) and the
3 `/embed/*` routes (need an embed token, not a login session).

**Not closed, stated plainly:** render-smoke is not workflow validation. The
deep-workflow tier still covers 27 routes; the admin plane, eval suite, and
data-authoring flows render against real services but their write paths are
exercised only by unit tests (ui-web: 832) and service-level tests, not
end-to-end. Those are the next journeys worth writing, in this order:
ingestion upload→dataset (the front door), eval run lifecycle, connections/new.

## 3 · Standing evidence for the workflow tier

- `e2e-contract` (mocked services, real BFF): green on the current branch.
- `e2e-live` (25 real services): last run 54/60 passing; the 6 failures were
  diagnosed — five were spec defects (fixed on this branch), one produced a
  better failure message and awaits its next live run. Two soaks skipped.
- Backend journeys (7, including FHIR): all green on the last live run.

## 4 · Keeping it true

- `wiring-audit` is now a **CI job** — checks A/B gate every push; C–G print.
- The auditor is rerunnable locally: `python3 tools/wiring/audit_ui_wiring.py`.
- When the next e2e-live run completes, its smoke results supersede §2's
  "untouched" list; update the tiers from that run, not from this document.

*Written against branch `claude/datacern-ai-capabilities-p7q6a7` on
2026-08-05. If this document and the code disagree, the code is right.*
