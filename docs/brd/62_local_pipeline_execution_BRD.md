# BRD 62 — Local pipeline execution engine + operator parity

**Status:** in-progress — 2026-07-23 · part of the [Nemesis→Datacern parity initiative](62_nemesis_parity_index.md)
**Owner:** platform · **Service:** `pipeline-orchestrator`
**Gaps closed:** P1 (data-prep operators don't execute without Argo), P3 (right join),
P4 (missing-value methods), P5 (stratified split).

---

## Analysis

Datacern's `pipeline-orchestrator` catalogs 31 data-prep operators
(`app/domain/catalog.py`) with real JSON-schema params, validates them into a typed
DAG (`app/domain/dag.py`), and deterministically compiles a version to an Argo
`WorkflowTemplate` (`app/domain/compiler.py`). But **execution** of those operators
only happens inside Argo containers — the inline `LocalTrainingExecutor`
(`app/executor/local.py`) implements *only* the `*-train` algorithm components. So on
any deployment without a K8s+Argo cluster (the default Mac/dev deployment, and any
BYO-infra customer that hasn't wired Argo), a `data_prep` / `feature_engineering` /
`profiling` pipeline **cannot run end to end** — the whole classic data-pipeline
surface is dark. Legacy Nemesis runs all of these as first-class pandas components in
production. This is the single highest-leverage parity gap: it unblocks the entire
classic-pipeline domain locally and makes it e2e-testable on a Mac with no infra.

Three small operator deltas ride along (same files, same test): Nemesis `join-data`
supports a **right** join, `handle-missing-values` supports **linear_interpolation /
expression / previous_existing / next_existing** beyond mean/median/most_frequent/
constant/drop, and `split-data` supports **stratified** splits with a `random_state`.

## Design

A real, in-process, pandas-based execution path parallel to the Argo path — chosen by
the **same swappable `WORKFLOW_BACKENDS` registry** already in the codebase, so this
is not a new architectural concept, just the missing `local` implementation for
non-training pipeline types.

1. **Operator library — `app/executor/operators.py`.** One pure pandas function per
   catalog operator, signature `op(inputs: list[pd.DataFrame], params: dict) ->
   list[pd.DataFrame]`. Registered in an `OPERATORS: dict[str, Operator]` table keyed
   by the exact catalog `name`. Pure, deterministic, no IO — trivially unit-testable.
   Covers all 31 `_DATA_PREP_NAMES` + the injected `clone-input` / `model-input`
   passthroughs. Fails closed on a malformed param (raises, surfaced as a component
   error) — never silently passes bad data downstream.

2. **Local DAG executor — `app/executor/local_pipeline.py`.** `LocalPipelineExecutor`
   topologically orders the compiled definition's nodes (reusing
   `app/domain/resources.py:topological_order`), threads DataFrames along
   `alias.port` edges, invokes each operator from the registry, and returns the
   terminal outputs. IO nodes (`read-from-warehouse` / `write-to-warehouse` and their
   batch variants) call **injected reader/writer ports** — the reader is the existing
   dataset row source (real rows from dataset-service), the writer persists a new
   dataset version — so the executor itself stays pure and the IO is swappable/faked
   in tests. `data-profiler` / `comment` nodes are no-op passthroughs at execution
   time (profiling is computed by dataset-service). Records per-node
   `components_status`; a node exception fails the run with a precise
   `record_component_error`, never a silent success.

3. **Parity param extensions (`catalog.py`).** `join-data` enum gains `right`;
   `handle-missing-values` strategy enum gains `linear_interpolation`, `expression`
   (with an `expression` param), `previous_existing`, `next_existing`; `split-data`
   gains optional `stratify_columns` (array) + `random_state` (int). The operator
   implementations honor all of them.

4. **Agent support (increment 2) — NEW `data_pipeline_builder` graph** in
   `agent-runtime/app/graphs/`. Grounds on the live operator catalog + a dataset's
   inferred schema, composes a data-prep DAG from an NL request, and PROPOSES it as a
   governed pipeline create (proposal-mode WriteIntent → four-eyes → tool-plane
   executes the create). `model_training` builds *training* pipelines; nothing builds
   *data-prep* pipelines today, so this is a genuinely new task type.

**Increment plan:** inc1 = operator library + local executor + parity params + unit
tests (pure, no infra). inc2 = wire the executor into `drive_run` for the non-training
pipeline types + `data_pipeline_builder` agent + live end-to-end run. inc1 is the
foundation and is fully local-testable on its own.

## Implement & Test log

### inc1 — operator library + local DAG executor + parity params — DONE

- **`app/executor/operators.py`** — real pandas implementations for **all 31**
  data-prep operators + `clone-input`/`model-input`/`data-profiler` passthroughs,
  in an `OPERATORS` registry keyed by catalog name. Pure `op(inputs, params) ->
  outputs`; fails closed (`OperatorError`) on a missing column / bad param / unknown
  op. Includes the parity deltas: `join-data` right join (P3), `handle-missing-values`
  linear_interpolation/expression/previous_existing/next_existing (P4), `split-data`
  stratified split + random_state (P5).
- **`app/executor/local_pipeline.py`** — `LocalPipelineExecutor.run(definition)`
  topologically orders nodes (reusing `resources.topo_order`), threads DataFrames
  along `alias.port` edges in authoring order (so join left/right map to
  input[0]/input[1]), runs each operator, and returns terminal outputs +
  per-node `NodeStatus`. Warehouse read/write delegate to **injected reader/writer
  ports** (pure + unit-testable; real dataset-service IO wired in inc2). A node
  exception raises `PipelineExecutionError(alias, component, cause)` — never a
  silent success.
- **`app/domain/catalog.py`** — extended the `join-data` / `handle-missing-values` /
  `split-data` param schemas for P3/P4/P5 so the authoring/validation surface matches
  the new operator behavior.

**Test:** `tests/unit/test_operators.py` (27 tests) — a catalog-coverage guard
asserting **every** DATA_PREP operator has a local impl; per-operator behavior incl.
all four join types (right included), all missing-value strategies (+ directional
fill + expression), stratified split preserving the label ratio, encoders, filters,
scaling/PCA/expressions; fail-closed on bad params; and **three end-to-end local DAG
runs** (read→filter→group-by→write with injected IO, fan-out split, and node-failure
surfacing) proving a data-prep pipeline executes with **no Argo/infra**. Full
pipeline-orchestrator suite green (**125 passed**), no regression.

_inc2 (next): wire `LocalPipelineExecutor` into `drive_run` for the non-training
pipeline types (real dataset-service reader/writer) + the `data_pipeline_builder`
agent + a live end-to-end run._
