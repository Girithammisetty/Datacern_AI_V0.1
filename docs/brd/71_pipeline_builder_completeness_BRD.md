# BRD 71 — Pipeline builder completeness (resources, schema propagation, operator parity)

**Status:** inc1–inc4 DONE (unit-verified) — 2026-08-05 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `pipeline-orchestrator` · `bff-graphql` · `ui-web` · `agent-runtime`
**Gaps closed:** U1 (per-component resource config), U2 (DAG schema propagation), P6 (`drop-columns`)

---

## Analysis

Wave 1 made the pipeline **engine** real. This BRD makes the pipeline **builder** real.
Three defects, found by diffing V1's component packaging against Datacern's catalog +
`ui-web` builder.

### U1 — the UI never lets you size a step

V1 injects four **constant parameters** into every component's form
(`pipeline_manager/constants/constant_parameters.json`):

| param | type | default | min | max | flags |
|---|---|---|---|---|---|
| `timeout` | int (minutes) | 90 | 10 | 720 | `global_attribute`, group `Resource Parameters` |
| `ram` | number (GB) | 4 | 2 | 6.0 | `global_attribute`, group `Resource Parameters` |
| `cpus` | number (cores) | 1 | 1 | 1.0 | `global_attribute`, group `Resource Parameters` |
| `mlflow_run_id` | string | — | — | — | hidden (`display:false`) |

`global_attribute:true` is what makes them settable **once for the whole pipeline** and
overridable per node; `group` renders them as a separate collapsible section on every
component form.

Datacern's **backend is ahead of V1 here** — `app/domain/resources.py` has `DEFAULTS`,
a `FLOOR`, a `PLATFORM_CEILING`, per-tenant `quota.resource_ceiling`, predecessor
inheritance (element-wise `max` over a node's predecessors, matching V1's
`set_missing_resources`), and a RAM-derived `training_row_budget` V1 has no equivalent
for. `compiler.py` turns the resolved values into real Argo pod limits.

But **nothing reaches the user.** Three concrete breaks:

1. `serializeDefinition` (`ui-web/src/lib/pipelines/canvas.ts`) emits
   `{alias, component, parameters, outputs}` per node — **never `resources`**. So a
   saved definition always has `resources` absent, and `resolve_resources` always falls
   through to `DEFAULTS` (1 CPU / 2 GB / 30 min) for every node in every pipeline.
2. `NodeConfigPanel` renders `node.params` only. There is no resources section, and no
   pipeline-level default control anywhere in the builder.
3. `ValidationReport.to_dict()` (`app/domain/dag.py:35`) returns `{status, items}` and
   **drops `effective_resources`**, which `validate_definition` already computed. So
   even the inherited/clamped values the engine will actually use are invisible.

A user who needs a 16 GB node for a wide join has no way to ask for one, and the run
either OOMs or gets refused by `training_row_budget` with no way to act on it.

### U2 — column pickers are bound to the wrong schema

V1 ships a `component.js` beside 33 of its components exporting
`process_header(header[, header2], component_parameters) -> string[]`: the **output
column list** of that step given its input column list(s) and its configured params.
The builder walks the DAG in topological order applying these, so a column picker three
steps downstream of a `select-columns` offers exactly the columns that will exist there.
Examples: `select-columns` returns the chosen list; `drop-columns` removes them;
`pca` appends `principal_component_0..n` unless `replace_columns`; `join-data`
reproduces the full pandas merge column order including the `_0`/`_1` suffixing when
`drop_duplicates` is false.

Datacern binds **every** `column`/`columns` widget to one schema:

```ts
// ui-web/src/components/pipelines/NodeConfigPanel.tsx:25
const datasetId = resolveInputDatasetId(nodes);          // prefers a read-from-warehouse node
const { data: schema } = useDatasetSchema(datasetId, …);
const availableColumns = (schema ?? []).map((c) => c.name);
```

`resolveInputDatasetId` walks to the **source** read node regardless of where the
selected node sits. So after a `select-columns` the picker still offers dropped columns;
after a `rename-columns` it offers the old names; after a `join-data` it offers neither
side's suffixed names. Every one of those choices then fails at validate or run time —
the failure is real, only the feedback is late.

This is not cosmetic: it is the difference between a no-code builder and a form that
happens to be next to a canvas.

### P6 — `drop-columns` is missing

`app/executor/operators.py` registers 34 operators; V1 has 35 data-prep components. The
missing one is `drop-columns`, and `select-columns` has no exclude mode
(`operators.py:54` requires an explicit `columns` keep-list), so "drop the two PII
columns" means enumerating the other 200.

V1's implementation also carries a behavior worth keeping: it reads `label_column` from
the MLflow run and **refuses to drop the label** during training (and force-includes it
during inference), because dropping the label is always an error and the failure surfaces
deep inside the fit. It also silently ignores unknown columns rather than erroring.

> Note for whoever ports the header function: V1's `drop_columns/component.js` is
> **buggy** — it filters with `indexOf(element) !== -1`, i.e. it *keeps* the dropped
> columns. The Python component (`src/component.py`) is authoritative and does
> `input_df.drop(columns=columns_to_drop)`. Port the Python semantics.

---

## Design

### 1. Resource policy is served, not hardcoded (`pipeline-orchestrator`)

New `GET /api/v1/resource-policy` → `{data: {defaults, floor, ceiling}}` where `ceiling`
is the caller's **tenant-effective** ceiling (`_ceiling(quota)` in `services.py:111`),
not `PLATFORM_CEILING`. One source of truth: the form cannot offer a value the compiler
will clamp, and the numbers move with the tenant's quota without a UI deploy.

`ValidationReport.to_dict()` gains `effective_resources` so `POST /pipelines/validate`
tells the builder what each node resolved to — the inherited values included. This is
what makes inheritance legible rather than surprising.

### 2. `resources` survives the round trip (`ui-web`)

- `CanvasNode` gains `resources?: NodeResources` (`{cpus, ram_gb, timeout_minutes}`,
  all optional — absent means "inherit", exactly the backend's contract).
- `serializeDefinition` emits `resources` on a node **only when explicitly set**, so an
  untouched pipeline serializes byte-identically to today and inheritance still applies.
- `hydrateFromDefinition` reads it back.
- A pipeline-level **default resources** control (V1's `global_attribute`) writes to the
  read node, which every other node inherits from through the existing predecessor
  `max` — no new backend concept needed, which is the point of doing it this way.
- `ResourceFields` in `NodeConfigPanel`: a "Resource Parameters" section (V1's group
  name, deliberately) showing the three fields, each with the served floor/ceiling as
  `min`/`max`, and — when the field is empty — the **inherited effective value** as
  placeholder text, so a user can see what they'd get before overriding it.

### 3. Schema propagation (`ui-web`, pure module)

New `src/lib/pipelines/schema-propagation.ts`, framework-free and unit-testable:

```ts
propagateSchema(nodes, edges, sourceColumns): Map<nodeId, string[]>
```

Topological walk; per component a pure `HeaderFn(inputs: string[][], params) => string[]`
in a `HEADER_FNS` registry — the `process_header` equivalent, ported from the V1 Python
component semantics (not the JS, per the note above). Unknown component → pass through
input 1 unchanged (V1's own default). `NodeConfigPanel` then binds
`availableColumns` to `propagated.get(selectedId)` instead of the source schema.

Coverage target: every operator that **changes** the column set —
`select-columns`, `drop-columns`, `rename-columns`, `join-data`, `merge-data`, `union`,
`group-by`, `pca`, `one-hot-encoder`, `long-to-wide-converter`, `wide-to-long-converter`,
`add-guid-column`, `linear-combination`, `quantization`, `transform-data`,
`python-expression`, `split-data`, `clone-input`, `model-input`. Operators that only
change **rows** (`filter-data`, `sample-data`, `sort-data`, `remove-outliers`,
`remove-duplicate-rows`, …) are pass-through by construction and need no entry.

### 4. `drop-columns` (`pipeline-orchestrator`)

Catalog entry in `_DATA_PREP_NAMES` + an `_OVERRIDES` schema (`columns`, required,
`format: columns`), and a real executor operator: drop the intersection with the frame's
columns (silently ignore unknown, per V1), and **refuse to drop the label column** when
the run carries one. `select-columns` additionally accepts `exclude: true` to invert.

### 5. Agent

Extend `data_pipeline_builder`: (a) propose per-step `resources` grounded in the input
dataset's row count × column width against the served ceiling, and (b) use
`propagateSchema`'s server-side twin when grounding column choices for steps that follow
a projection or join, so a proposed DAG doesn't reference columns its own earlier step
removed. Proposal-mode through `create_from_intent` as always.

### Increment plan

- **inc1** — backend: `drop-columns` operator + catalog, `select-columns` exclude mode,
  `GET /resource-policy`, `effective_resources` in the validation report. Unit tests.
- **inc2** — UI: `resources` round trip, `ResourceFields`, pipeline default control.
- **inc3** — UI: `schema-propagation.ts` + `NodeConfigPanel` binding. Unit tests.
- **inc4** — agent extension + live-verify against the running stack.

## Acceptance criteria

| AC | Statement |
|----|-----------|
| AC-1 | `drop-columns` appears in `GET /components`, validates, compiles, and executes — dropping exactly the named columns, ignoring unknown ones. |
| AC-2 | `drop-columns` refuses to drop the run's label column; `select-columns` with `exclude:true` inverts. |
| AC-3 | `GET /resource-policy` returns the caller's tenant-effective ceiling, not the platform ceiling. |
| AC-4 | `POST /pipelines/validate` returns `effective_resources` per alias, including inherited values. |
| AC-5 | A node with explicit `resources` round-trips through serialize → save → hydrate unchanged. |
| AC-6 | A node **without** explicit resources serializes with no `resources` key (inheritance preserved; no behavior change for existing pipelines). |
| AC-7 | `ResourceFields` clamps to the served floor/ceiling and shows the inherited effective value as placeholder. |
| AC-8 | `propagateSchema` returns, for each node, the column list that node's step will actually see — verified per header function against the operator's real pandas behavior. |
| AC-9 | A `columns` widget on a node downstream of `select-columns` / `rename-columns` / `join-data` offers the propagated columns, not the source dataset's. |
| AC-10 | `data_pipeline_builder` can propose per-step resources within the ceiling, in proposal-mode. |

## Implement & Test log

### inc1 — backend: `drop-columns`, exclude mode, resource policy, effective resources — DONE

- **`app/domain/catalog.py`** — `drop-columns` added to `_DATA_PREP_NAMES` (32 now) with
  a `columns` schema (`format: columns`, required); `select-columns` gains
  `exclude: boolean`.
- **`app/executor/operators.py`** — real `drop-columns`: drops the intersection with the
  frame's columns, **ignores unknown columns** (a drop list that outlives a schema change
  must not fail a run — the intent is already satisfied), refuses to drop every column,
  and **never drops the label**. `select-columns(exclude)` inverts the projection while
  preserving *frame* column order. New `LABEL_AWARE_OPERATORS` export.
- **`app/executor/local_pipeline.py`** — `run(definition, run_parameters=None)` injects
  the run's `label_column` into label-aware operators (V1 reads it off the MLflow run;
  the node definition should not restate what the training step declares). An explicit
  node param wins.
- **`app/domain/services.py`** — `_drive_data_prep` passes `run.run_parameters`;
  new `TemplateService.resource_policy` returning defaults / floor / **tenant-effective**
  ceiling.
- **`app/domain/dag.py`** — `ValidationReport.to_dict()` now carries `effective_resources`
  (it was computed and discarded).
- **`app/api/routes/pipelines.py`** — `GET /api/v1/resource-policy`.

**Test:** `tests/unit/test_builder_completeness.py` (22) — catalog + executor presence,
drop semantics, unknown-column tolerance, drop-everything guard, label protection via
both the run parameter and an explicit node param, no-run-parameters regression,
exclude-mode order preservation, authoring-path validation, `effective_resources`
present / inherited / clamped to ceiling / clamped to floor / existing keys intact, and
the policy endpoint reflecting a **tenant** ceiling set through the quota admin API.
`test_operator_authoring.py` +1 case. Full suite **220 green**, ruff clean.

### inc2 — BFF + UI: resources round trip and the "Resource Parameters" group — DONE

- **`bff-graphql`** — `PipelineResourcePolicy` type + `pipelineResourcePolicy` query
  (passthrough to the new REST endpoint, tenant ceiling untouched);
  `PipelineValidationResult.effectiveResources`; `ValidationReportDTO.effective_resources`;
  SDL snapshot regenerated.
- **`ui-web/src/lib/pipelines/canvas.ts`** — `NodeResources` (every field optional —
  **absent means inherit**), `RESOURCE_KEYS`, `pruneResources`, `resources` on
  `CanvasNode`, emitted by `serializeDefinition` **only when explicitly set**, read back
  by `hydrateFromDefinition`; store gains `setResource`, `effectiveResources` and
  `aliasOf`.
- **`ui-web/src/components/pipelines/ResourceFields.tsx`** — the group, carrying V1's own
  name. min/max come from the served policy (never constants), a blank field means
  inherit and shows the resolved value as placeholder, and a typed over-ceiling value is
  clamped client-side too (a number input's `max` is advisory for typed values).
- **`PipelineBuilder`** stores `effectiveResources` from each validate.

**Test:** `src/lib/pipelines/resources.test.ts` (12) — the load-bearing negative
(an untouched node serializes with **no** `resources` key, so existing pipelines keep
inheriting instead of silently pinning at defaults), partial overrides staying partial,
round trip, legacy definitions, and `setResource` clearing back to `undefined` rather
than leaving `{}`.

### inc3 — UI: DAG schema propagation — DONE

- **`ui-web/src/lib/pipelines/schema-propagation.ts`** — `propagateSchema(nodes, edges,
  sourceColumns)` plus a `HEADER_FNS` registry: the `process_header` equivalent, ported
  from **`app/executor/operators.py`** (authoritative) rather than from V1's JS. Covers
  every operator that changes the column set; row-shaping operators are pass-through by
  construction. Unknown components pass input 1 through; a half-typed param can never
  break a picker.
- **`NodeConfigPanel`** binds `availableColumns` to the propagated schema instead of
  `resolveInputDatasetId`'s source dataset.

Three executor details the port had to get right, each a silent-wrong-answer if missed:
`join-data` pins `suffixes=("", "_r")` (not pandas' `_x`/`_y`); PCA emits `pc_1..pc_n`
with a `keep_original` flag (not V1's `principal_component_*`/`replace_columns`); and
`group-by` with `join_with_original` keeps every original column with an `_agg` suffix on
collisions. `one-hot-encoder` and `long-to-wide-converter` produce **data-dependent**
names, so they report only what is knowable (the encoded columns are gone / the index
survives) rather than inventing names.

**Test:** `schema-propagation.test.ts` (26) — the core defect (a step after
`select-columns` no longer offers dropped columns), rename/chain propagation,
disconnected + unknown + malformed-param degradation, and one case per header function
written against the executor's semantics. `NodeConfigPanel.test.tsx` (6) — the group
renders with the served floor/ceiling, placeholder-not-value for inherited, type→store
→clear→inherit, ceiling clamp, and AC-9 both ways (a downstream node must not offer
`pii`; the projecting node itself still must). ui-web **876 green** (128 files), `tsc`
clean, no new lint warnings. bff-graphql **450 green** incl. 4 new.

### inc4 — agent: `data_pipeline_builder` proposes an envelope — DONE

- **`app/adapters/pipeline.py`** — `resource_policy()` against the new endpoint.
- **`app/graphs/data_pipeline_builder.py`** — grounds on the policy, and
  `_clamp_resources` coerces + clamps a proposed envelope to the served floor/ceiling.
  Clamping rather than rejecting is deliberate: a model asking for 64 GB on a 24 GB
  tenant *meant* "this step is memory-hungry", and the useful outcome is a proposal at
  the tenant maximum a reviewer can see — not a dropped field that reverts to 2 GB.
  With **no** served policy nothing is proposed (an unbounded guess is worse than
  inheriting). The envelope lands on the **read node only**, which a linear DAG inherits
  from throughout — V1's `global_attribute` affordance with no second concept.
- Prompt bumped to **v2** with the optional `resources` contract.

**Test:** `test_data_pipeline_builder_graph.py` (+8) — envelope on the read node with
downstream un-pinned, reviewer summary, over-ceiling clamped, below-floor raised,
junk/non-numeric fields ignored, no-proposal → byte-identical definition, no-policy →
no proposal, and the policy actually fetched during grounding. agent-runtime
**409 green**, ruff clean.

_Remaining: live-verify inc1–inc4 against the running stack (MLflow + Ollama), as
BRD 63/64 did._
