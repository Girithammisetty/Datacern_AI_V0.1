# V1 parity wave 2 — review guide

**Range:** `b4353f5..e8daaf5` (`main`) · 23 commits · 172 files · **+19,010 / −414**
Regenerate the underlying artifacts at any time. They are derived from git and
deliberately NOT committed — the raw patch is ~1 MB and every byte of it already
lives in the object store:

```bash
git diff b4353f5..e8daaf5       > wave2.patch        # the full 19k-line diff
git log --stat b4353f5..e8daaf5 > wave2-commits.txt  # per-file stats
git log --merges b4353f5..e8daaf5                    # 7 increments + reasoning
```

`b4353f5` is the merge of PR #96 (BRD 71); everything after it is wave 2.

---

## Read it in this order

Each row is one merge commit. Reviewing by increment is far easier than by file,
because each increment is self-contained and its commit message carries the
reasoning — including where the BRD turned out to be wrong.

| # | Increment | Size | Reviewer focus |
|---|---|---|---|
| 1 | `4acee62` **BRD 75** profiling depth | 12 files, +1061 | **One schema break** — see Risk 1 |
| 2 | `506ca0b` **BRD 74** D1+D2 chart search + dataset export | 31 files, +2564 | New SQL under RLS; export delegates rather than duplicating |
| 3 | `52d2d0b` **BRD 72 inc3a** run-chart data path | 11 files, +1031 | New cross-service contract — see Risk 2 |
| 4 | `a19326c` **BRD 73** batch job orchestration | 29 files, +3797 | New aggregate + migration; two DB constraints carry semantics |
| 5 | `2d7d821` **BRD 74 D3** search fan-out | 42 files, +2727 | Design was **rejected and redesigned** — see Risk 3 |
| 6 | `3a18ed1` **BRD 73 inc3b** BFF + Batch Jobs page | 19 files, +3081 | Nullable `ingestions` is deliberate — see Risk 4 |
| 7 | `e8daaf5` **BRD 74 AC-10** governed MCP search tool | 30 files, +2557 | **Authorization change — review this hardest** |

Plus three non-merge commits on `main`: the no-fallback pass, the e2e
contract-server fix, and the LIKE-escaping fix.

---

## Risk register — the five things worth a careful look

### Risk 1 · A non-additive schema change (BRD 75) — **RESOLVED 2026-08-05**
`doc["correlations"]` had changed **dict → list**, which breaks any consumer doing
`doc["correlations"]["pairs"]` with a `TypeError` and says nothing about why.

**Fixed rather than accepted.** `correlations` keeps its v1 `{method, pairs}`
spearman shape and the multi-method matrices moved to a NEW `correlation_matrices`
key, so `schema_version` 2 is now additive throughout. A v1 reader is unaffected;
the renderer accepts v1, the interim list form, and v2. No open question remains —
including for consumers outside this repo, which was the part nobody here could
check.

### Risk 2 · Authorization change (BRD 74 AC-10) — the highest-risk item
tool-plane now forwards the verified caller bearer to a backend facade, gated on a
per-version `downstream_actions` declaration.

*Checked before merge:*
- rbac-service diff is **test-only** — two `_test.go` files, +245 lines, zero
  non-test changes. No policy rule moved.
- The guard: `forwardToken` stays empty unless the version declares actions, then
  requires read tier **and** a scope subset **and** a verified token. Every failure
  is a 403 `SCOPE_NOT_DELEGABLE`, never a silent skip.
- Delegation is **off by default** (column defaults `'{}'`), so every pre-existing
  tool's call is unchanged with no `Authorization` header.
- **Proved by mutation:** replacing the guard with `if true` fails
  `internal/enforce`. The tests are load-bearing, not merely passing.

**ACCEPTED 2026-08-05.** "A read-tier tool may carry a scope-subset of the
caller's own token to services it declared in advance" is the trust model this
platform runs. The audit gap that was attached as a condition is closed — a
delegated invocation now carries `delegated: true` + `delegated_actions`.
*Operational condition:* the seed registration should not run in production until
an internal caller exists; the tool is dormant today, so enablement should be
deliberate rather than a default.

### Risk 3 · A BRD design was rejected mid-flight (BRD 74 D3) — **PARKED**
The spec put a `search_entries` **projection inside bff-graphql**. That service has
CI-enforced bans on DB, event-consumer and cache access and makes no authz decision
in any resolver. Building it there would have meant deleting those bans.

Shipped instead: a **stateless fan-out** to the eight owning services, after adding
real text search to the three that had none. AC-6/AC-7 are dropped-as-redesigned.
**Parked 2026-08-05.** The fan-out is shipped and is what runs today; whether it
is the right long-term direction is an open question nobody is working on. Left
here so the shipped code is not mistaken for a ratified decision.

### Risk 4 · Deliberate nullability (BRD 73 inc3b)
`BatchJobRun.ingestions` is **nullable** in the SDL because
`GET /batch-jobs/{id}/runs` omits it — only the run-detail route serializes it.
Mapping absent → `[]` would render an *empty timeline* for a run that has two
bindings. Both cases are tested.

### Risk 5 · One untested branch, on purpose
The ECharts init-failure path is covered by `tests-e2e/chart-engine-failure.spec.ts`
(real Chromium). Everything else is unit-covered. The three failed attempts that
preceded it are documented in `EChartsChart.failure.test.tsx` so nobody repeats them.

---

## Test position at `e8daaf5`

| Service | Tests | Notes |
|---|---|---|
| ui-web | 965 unit + 5 e2e | `tsc` clean |
| pipeline-orchestrator | 290 unit | + integration vs real Postgres |
| bff-graphql | 500 | eslint + `tsc` clean, SDL regenerates to a no-op |
| dataset-service | 335 unit | + integration |
| agent-runtime | 437 | |
| experiment-service | 87 | |
| ingestion-service | 611 | |
| tool-plane | 8 pkgs (40 → 96 cases) | |
| rbac-service | 7 pkgs | |
| chart-service | 8 pkgs + integration | |

**33 new test files** vs 17 new source/doc files. Every suite was run in this
session rather than taken from a report.

One **pre-existing** integration failure:
`pipeline-orchestrator/tests/integration/test_real_training_mlflow.py::test_corrections_produce_a_real_model_in_mlflow`
— confirmed by stashing all changes and reproducing it on a clean tree.

---

## Ten BRD premises that did not survive contact with the code

The BRDs were written from a first-pass audit; implementation disproved ten of
their claims. All are corrected in the BRDs, and each mattered — several would
have produced wrong work.

1. **AC-10's second blocker was backwards.** The BRD said the OBO scope model
   needed *widening*. The run-level OBO token already carries `scopes=["*"]`; the
   real gap was that it is too **broad** to forward safely. Implementing as written
   would have widened an already-wide token.
2. `charts` has **no `tags` column** (it is on `dashboards`), and chart-service has
   **no write path** for `documentations` at all.
3. **`POST /queries/{id}/export` does not exist** — export hangs off an *execution*,
   is synchronous, and parquet returns 501.
4. **`POST /internal/ingestions` does not exist**, and the internal path had no
   idempotency key — so BRD 73's AC-4 was *unachievable as specified*.
5. `ingestion.events.v1` **cannot pin a dataset version** — the version does not
   exist when that event fires.
6. `BatchJobRun` has **no `ingestion_ids[]`**; per-binding rows are what make the
   timeline possible.
7. The **lease columns are on the run, not the job**.
8. dataset-service's **HTML report artifact already existed**; only its content was thin.
9. **`top_values` already existed** and is load-bearing for semantic-service.
10. sunburst/sankey/treemap/chord are **`FamilyHeatmap`** (`[x,y,value]` triples),
    not hierarchies; and the whole network family rendered **nothing** because
    ui-web never selected `graph`.

---

## Known gaps, deliberately not built

Each is recorded in its BRD with the reason, rather than faked:

- **Realtime push for the batch-job timeline** — the outbox emits
  `run.phase_changed` but no hub topic carries it; the page polls at 5s only while
  a loaded run is non-terminal.
- **Version-scoped dataset reads** (BRD 73 AC-3) — pinning is *recorded*, but the
  executor still reads a dataset's current version because dataset-service has no
  version-scoped rows API.
- **Parquet dataset export** — query-service returns 501; a real 422 with the
  reason is returned rather than building a second export path.
- **`geo_map_chart`** — renders a named unsupported state; a map needs GeoJSON
  basemaps that cannot be bundled under the deployment's CSP.
- **An MCP read-tool call path inside agent-runtime** — its graphs read via ~20
  direct REST adapters and never touch `ToolPlaneClient`; there is no call site to
  wire into.
- **Interactions / missing-value matrix / duplicate-row samples** in profiling —
  they put row-level data into a statistics-only artifact behind a 24h signed URL.
  A governance question, not a compute one.

---

## A latent bug found and fixed in passing

`pipeline-orchestrator`'s `filter[name]` built its ILIKE as `f"%{name}%"` with **no
`ESCAPE`**, so `100%` matched every template and `a_b` matched `axb` — wrong
results rather than a failure.

It survived because the two stores disagreed and the safe one is the one unit tests
use: the memory store does a literal Python substring match. The regression tests
therefore run against **real Postgres**.

Worth knowing: the first version of that test **passed without the fix**. `100%`
becomes `%100%%`, SQL collapses `%%` to one wildcard, and no other seeded row
matched. Reseeding made it fail for the right reason — verified by reverting the
fix (3 of 4 fail without it, 4 of 4 pass with it).
