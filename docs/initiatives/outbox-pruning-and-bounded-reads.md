# Outbox/processed_events retention rollout (remaining 6 services) + two bounded-read fixes

**Status:** done — 2026-07-23
**Related:** [scalability-audit.md](scalability-audit.md) B6/B7 · BRD 58 · memory `feedback_windrose_engineering_rules` (rule 7, don't over-engineer)

---

## 0. Correction to the original brief

This work was originally briefed as "outbox pruning is completely missing —
build a Pruner from scratch." That premise was **wrong**. A prior agent
session (task `a74de5952c58e9e28`, "Implement outbox pruning") was checked via
`git status`/`git diff` in this repo before any work started here: it had made
**no** uncommitted changes and had **not** added a competing `Pruner`/
`prune_table` implementation anywhere. There was nothing to revert.

The corrected, verified state was:
- **Go**: `libs/go-common/outbox/pruner.go` is a real, already-wired `Pruner`
  (GUC-aware batched DELETE), live in 9 Go services. Out of scope here —
  no Go changes were made.
- **Python**: `libs/py-common/datacern_common/retention.py`'s `prune_table` +
  `RetentionSpec` is a real, already-wired helper, but only 3 of the Python
  services that own `outbox`/`processed_events` tables were calling it
  (`dataset-service`, `memory-service`, `ingestion-service`). This doc covers
  wiring the remaining 6.

While this work was in flight, a **separate concurrent session** in this same
working tree fixed a real bug in the shared
`libs/py-common/datacern_common/retention.py` helper (a `:retention_seconds::text`
bind-parameter the SQLAlchemy `text()` bind regex doesn't recognize because of
the immediately-following `::` cast — silently reached the driver as literal
text) and wired a 7th/10th Python service, `inference-service`, to the same
pattern. Neither change conflicts with or duplicates anything in this doc —
`RetentionSpec`/`prune_table`'s public signature is unchanged, so all 6
services wired here remain fully compatible. `inference-service` was outside
this task's assigned scope and is not otherwise touched by this doc.

---

## 1. Analysis

### 1a. Platform / product
Every `outbox` table (transactional-outbox pattern, MASTER-FR-034) and every
`processed_events` table (Kafka consumer dedup) grows without bound once rows
are written — outbox rows are marked `published_at` but never deleted;
`processed_events` rows never expire. Across a fleet of services this is slow,
silent disk/heap growth that eventually degrades or breaks the affected
service, with no operator-visible signal until it does. This is the B6/B7
item from the scalability audit ([scalability-audit.md](scalability-audit.md)),
previously "DONE (2 of 8 deferred)" — this closes the deferral.

Separately, two bounded-resource-consumption bugs in `dataset-service` shared
the same theme (a size cap that's applied too late to prevent the underlying
resource spike) and were bundled into this pass since they're small, contained,
single-call-site fixes using primitives that already exist in the codebase:
the profiler fully materializing a snapshot before sampling it down, and an
entity-resolution `row_limit` that could be forced to 0/negative to skip
bounding entirely.

### 1b. Technical — retention wiring

Reference pattern (already correct, used as the template): `services/dataset-service/app/main.py:85-117`
and `services/memory-service/app/main.py:94-127`. Both:
- import `RetentionSpec`/`prune_table` from `datacern_common.retention`,
- build one spec per table: `outbox` (`ts_col="published_at"`, `require_not_null=True`,
  30-day retention) and `processed_events` (`ts_col="created_at"`, 48h retention),
- pass `worker_guc="app.worker"` / `worker_val="true"` — the SAME GUC each
  service's own `OutboxDispatcher` sets to cross the RLS tenant wall,
- run an hourly loop, logging deletions, swallowing/logging errors per pass.

Critically, `processed_events` needed a **new RLS policy** in both reference
services (`dataset-service/migrations/versions/0005_processed_events_worker_policy.py`,
`memory-service/migrations/versions/0003_processed_events_worker_policy.py`):
it was created as a plain `TENANT_TABLES` member with only a
`tenant_isolation_processed_events` policy (`tenant_id = current_setting('app.tenant_id')`).
A background reaper runs with no tenant context, so under `FORCE ROW LEVEL
SECURITY` that policy alone silently matches zero rows — not an error, just a
permanent no-op, the exact failure mode `retention.py`'s own module docstring
(lines 16-29) warns about. `outbox` tables across the fleet already carry a
permissive `worker_outbox` policy (verified for all 6 target services before
writing any code — the existing outbox relay already depends on it to
cross-tenant-drain), so only `processed_events` needed a new policy.

Verified per-service, before writing any migration or wiring code:

| Service | outbox `worker_outbox` policy | `processed_events` worker policy (before) | New migration added |
|---|---|---|---|
| agent-runtime | `0002_run_final_text_outbox_worker.py` | *(no `processed_events` table exists)* | none needed |
| ai-gateway | `0001_initial.py:255` | missing | `0004_processed_events_worker_policy.py` |
| eval-service | `0001_initial.py:247` | missing | `0002_processed_events_worker_policy.py` |
| experiment-service | `0001_initial.py:298` | missing | `0004_processed_events_worker_policy.py` |
| pipeline-orchestrator | `0001_initial.py:199` | missing | `0003_processed_events_worker_policy.py` |
| semantic-service | `0001_initial.py:259` | missing | `0003_processed_events_worker_policy.py` |

Each new migration's `down_revision` was checked against that service's actual
current head (via `alembic heads`) before being written, to avoid an
accidental branch — confirmed single head per service after adding.

### 1c. Technical — bounded reads

- **`services/dataset-service/app/adapters/profiler_runner.py:65`** called
  `self.catalog.read_snapshot(...)` (unbounded — loads the whole Iceberg
  snapshot into a pandas DataFrame) and only afterward passed the result to
  `profile_dataframe(..., max_rows=self.max_rows)`
  (`app/domain/profiling/engine.py:276-282`), which samples down to
  `max_rows` — but only after the full table was already in memory. A
  10M-row snapshot means a 10M-row DataFrame gets materialized regardless of
  `max_rows`.
- **`services/dataset-service/app/api/routes/entity_resolution.py:36`** —
  `row_limit: int = 20000` had no lower-bound validation. `resolve_entities`
  passes it straight to `read_rows` (`app/domain/services.py:317-346`), whose
  `if limit and limit > 0:` check is **falsy for `limit=0`**, so `row_limit=0`
  (or any negative value) silently took the `else` branch — the fully
  unbounded `read_snapshot` — instead of the bounded `read_snapshot_head`.

Both fixes reuse a primitive that already exists and is already proven
correct elsewhere in the same file: `read_rows` itself
(`app/domain/services.py:337-342`) already calls
`catalog.read_snapshot_head(table, snapshot_id, limit)` when `limit > 0`, and
both `LocalCatalog` (`app/adapters/catalog.py:61-85`) and `IcebergRestCatalog`
(`app/adapters/catalog.py:191-194`) implement it.

---

## 2. Architecture & Design

**Retention wiring** — mirror the reference services exactly, adjusted only
for each service's own container/session-factory plumbing (which differs more
than expected between services — see below). Explicitly rejected: extracting
a single shared "run this loop" helper into `datacern_common` across all 6+2
call sites. The brief called for "small, near-identical, low-risk...not a
redesign," and a cross-service shared loop abstraction would be a bigger,
riskier change than six near-identical ~20-line additions for marginal DRY
benefit (rule 7 — don't over-engineer).

One deliberate, small deviation from a pure copy-paste, done for testability:
each service's retention loop was extracted from an anonymous nested closure
(`async def retention_loop(): ...` defined inline inside the lifespan
function, as the two reference services do) into a **named module-level
function**, `_run_retention_loop(session_factory, specs, *, interval_seconds=3600)`,
defined once near the top of each `app/main.py`. The call site
(`tasks.append(asyncio.create_task(_run_retention_loop(sf, specs)))`) is a
one-line, behavior-identical swap. This was necessary because none of the 6
services (nor, it turns out, the 2 reference services) had any prior test
harness for exercising lifespan-nested closures, and building a full fake
real-adapter container (Kafka producer/consumer, Temporal client, engine) per
service just to reach an anonymous closure was judged higher-risk/lower-value
than this small, local, non-shared refactor. `experiment-service` was left
alone: its `app/workers/loops.py` already defines loops
(`reconcile_loop`, `expiry_loop`, `inbox_loop`, `outbox_loop`) as named,
independently-importable `(container, stop)` functions, so `retention_loop`
was added there in the same shape with no extraction needed.

Per-service session-factory plumbing differences discovered while wiring (not
assumed from the reference services):
- `agent-runtime`, `pipeline-orchestrator`, `semantic-service`: `container.extras["session_factory"]`
  already populated by `build_container`.
- `ai-gateway`: `build_container` does **not** populate `extras["session_factory"]`
  (only `dataset-service`/`memory-service`/`pipeline-orchestrator`/`semantic-service`/
  `agent-runtime` do) — added one line in `build_runtime_container()` to store
  it, mirroring how `extras["engine"]`/`extras["redis"]` are already stored there.
- `eval-service`: never stores a session factory in `container.extras` at all;
  its outbox dispatcher builds one locally from `container.extras["engine"]`
  inside the lifespan closure. Reused that same local `sf` rather than adding
  a new container field.
- `experiment-service`: uses the `workers/loops.py` + `asyncio.Event stop`
  idiom instead of `while True` + task cancellation.

**Bounded reads** — both fixes are single-call-site swaps to an
already-existing, already-tested bounded primitive; no new abstraction.
Explicitly noted trade-off (documented inline in `profiler_runner.py`): after
the fix, the profiler always reads at most `max_rows` rows *in file order*
(a head slice) rather than materializing the whole table and then taking a
statistically random reservoir sample from it. This trades exact reservoir
randomness for a hard, unconditional memory bound — judged the correct
trade-off for the stated goal (never fully materialize an oversized table),
and consistent with the identical trade-off `read_rows`/`resolve_entities`
already made for the same catalog port.

**Out of scope / untouched, per constraints:** `deploy/helm`, `deploy/k8s`,
Terraform, `libs/go-common/outbox` (already fully wired — verified via
`grep -rn "type Pruner"` returning exactly one hit, no Go changes made).

---

## 3. Implementation & Test

### Files changed

**Retention wiring:**
- `services/agent-runtime/app/main.py` — `_run_retention_loop` + outbox-only spec (no `processed_events` table exists for this service)
- `services/ai-gateway/app/main.py` — `_run_retention_loop` + outbox/processed_events specs; `build_runtime_container()` now stores `extras["session_factory"]`
- `services/ai-gateway/migrations/versions/0004_processed_events_worker_policy.py` (new)
- `services/eval-service/app/main.py` — `_run_retention_loop` + outbox/processed_events specs, reusing the existing local `sf`
- `services/eval-service/migrations/versions/0002_processed_events_worker_policy.py` (new)
- `services/experiment-service/app/workers/loops.py` — new `retention_loop(container, stop)`
- `services/experiment-service/app/main.py` — wires `retention_loop` alongside the other named loops
- `services/experiment-service/migrations/versions/0004_processed_events_worker_policy.py` (new)
- `services/pipeline-orchestrator/app/main.py` — `_run_retention_loop` + outbox/processed_events specs, reusing the existing `sf`
- `services/pipeline-orchestrator/migrations/versions/0003_processed_events_worker_policy.py` (new)
- `services/semantic-service/app/main.py` — `_run_retention_loop` + outbox/processed_events specs
- `services/semantic-service/migrations/versions/0003_processed_events_worker_policy.py` (new)

**Bounded reads:**
- `services/dataset-service/app/adapters/profiler_runner.py` — `read_snapshot` → `read_snapshot_head(..., self.max_rows)`
- `services/dataset-service/app/api/routes/entity_resolution.py` — `row_limit: int = 20000` → `row_limit: int = Field(default=20000, ge=1)`

**Tests (new):**
- `services/agent-runtime/tests/unit/test_retention_wiring.py`
- `services/ai-gateway/tests/unit/test_retention_wiring.py`
- `services/eval-service/tests/unit/test_retention_wiring.py`
- `services/experiment-service/tests/unit/test_retention_wiring.py`
- `services/pipeline-orchestrator/tests/unit/test_retention_wiring.py`
- `services/semantic-service/tests/unit/test_retention_wiring.py`
- `services/dataset-service/tests/unit/test_profiler_bounded_read.py`
- `services/dataset-service/tests/unit/test_entity_resolution_persistence.py` — extended with `TestRowLimitValidation`

**Docs:**
- `docs/initiatives/scalability-audit.md` — B6/B7 line updated from "2 of 8 Python services deferred" to done, cross-linked here.

### Why these tests are meaningful, not just source-shape assertions
Neither reference service (`dataset-service`, `memory-service`) had *any* test
exercising their retention-loop wiring before this change — checked directly
(`grep -rln "prune_table\|retention_loop\|RetentionSpec"` across both
services' test dirs returned nothing). Rather than write the same kind of
untested pattern into 6 more services, each new `test_retention_wiring.py`:
1. Monkeypatches `datacern_common.retention.prune_table` (an `AsyncMock`) and
   `asyncio.sleep` (a fast fake that raises `CancelledError` on its 2nd call —
   `experiment-service`'s equivalent patches `_sleep_or_stop` the same way),
2. Actually calls the real `_run_retention_loop` (or, for `experiment-service`,
   the real `retention_loop(container, stop)`) — not a copy or a stub,
3. Asserts `prune_table` was awaited once per configured table, with the
   correct session_factory value and `worker_guc="app.worker"` on each spec.

This proves the exact code path that runs at startup actually invokes the
prune helper for the right tables under the right GUC — not just that the
source text contains the word "RetentionSpec".

For the profiler fix, `test_profiler_bounded_read.py` wraps `LocalCatalog` in
a spy that records which method was called, commits a 500-row snapshot with
`max_rows=50`, runs the real `InProcessProfilerRunner.launch`, and asserts
`read_snapshot` was **never** called while `read_snapshot_head` was called
with the correct `(table, snapshot_id, max_rows)` — a genuine regression test
for the exact bug described.

For entity-resolution, three new HTTP-level tests
(`TestRowLimitValidation` in `test_entity_resolution_persistence.py`) POST to
the real `/api/v1/datasets/{id}/entity-resolution` route with `row_limit=0`,
`row_limit=-5`, and the default (omitted) — asserting `422` for the first two
and confirming the third reaches the service layer (a `404` for "no readable
version," proving Pydantic validation passed rather than rejecting it).

### Test evidence (all commands run from each service's own `.venv`, this session, 2026-07-23)

```
cd services/dataset-service && .venv/bin/python -m pytest tests/unit -q
  → 225 passed in 17.32s   (includes the 2 new/extended files above)

cd services/agent-runtime && .venv/bin/python -m pytest tests/unit -q
  → 313 passed in 29.24s

cd services/ai-gateway && .venv/bin/python -m pytest tests/unit -q
  → 154 passed in 7.49s

cd services/eval-service && .venv/bin/python -m pytest tests/unit -q
  → 49 passed in 0.96s

cd services/experiment-service && .venv/bin/python -m pytest tests/unit -q
  → 62 passed in 1.69s

cd services/pipeline-orchestrator && .venv/bin/python -m pytest tests/unit -q
  → 156 passed in 20.89s

cd services/semantic-service && .venv/bin/python -m pytest tests/unit -q
  → 286 passed in 15.05s
```

Total: 1,245 unit tests green across the 7 touched services, zero
regressions, zero skips introduced.

Migration chain integrity (no branching) confirmed per service via:
```
cd services/<svc> && .venv/bin/python -m alembic heads
```
— exactly one head reported for `ai-gateway` (`0004`), `eval-service` (`0002`),
`experiment-service` (`0004`), `pipeline-orchestrator` (`0003`), and
`semantic-service` (`0003`) after adding the new migration.

### Honest caveats
- **Not live-Postgres-verified.** All tests above are unit-tier (in-memory
  containers, `use_real_adapters=False`) with `prune_table` mocked at the
  wiring layer, or exercising `LocalCatalog`/`read_snapshot_head` (real code,
  but a filesystem-backed dev catalog, not real Iceberg REST/Postgres RLS).
  Nobody in this session stood up real Postgres to confirm the new
  `worker_processed_events` migrations actually let the reaper cross the RLS
  wall in a live database — this mirrors exactly the level of verification
  the two reference services (`dataset-service`, `memory-service`) shipped
  with originally, per their own migration history, but it is still an
  assumption, not a live-verified fact, for the 6 services touched here.
- **The profiler fix changes reported metadata, not just memory use**: once a
  snapshot exceeds `max_rows`, `profile_dataframe`'s `sample` field will now
  report `{"strategy": "full", "fraction": 1.0}` for what is actually a
  head-truncated slice, because `read_snapshot_head` caps the row count
  *before* `profile_dataframe` ever sees a count that exceeds `max_rows` (so
  its own `total_rows > max_rows` reservoir-detection branch never fires).
  This is called out as an explicit, judged trade-off above, not silently
  introduced — but a profile document's `sample.fraction` field is no longer
  fully accurate for oversized tables post-fix. Flagged in code as a comment;
  no downstream consumer of that field was audited in this pass.
- **`inference-service`** was fixed by a concurrent session during this task
  (not by this doc's author) and is mentioned here only for completeness —
  it was not part of this task's assigned 6-service scope and its correctness
  was not independently verified in this session.
- Retention intervals (hourly sweep, 30-day outbox / 48h processed_events
  retention) were copied verbatim from the reference services, not
  independently re-derived or made configurable per service.
