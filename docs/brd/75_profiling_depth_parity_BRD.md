# BRD 75 — Profiling depth parity

**Status:** DONE (inc1–inc3) — 2026-08-05 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Service:** `dataset-service`
**Gaps closed:** F1 (profiling depth)

---

## Analysis

V1's `profiling-service` wraps `pandas_profiling.ProfileReport` and stores **both** an
HTML report and the full JSON description set. That gives, per column: entropy, skewness,
kurtosis, MAD, variance, monotonicity, top-K common values, memory size; and per dataset:
interactions (pairwise scatter matrix), a missing-value matrix, duplicate-row samples,
and **four** correlation measures (pearson, spearman, kendall, and a categorical
association).

Datacern's `app/domain/profiling/engine.py` computes a genuinely good core — row/column
counts, per-column logical type, null count/pct, distinct count/pct, uniqueness, min/max/
mean/median/stddev, p5/p25/p75/p95, histogram bins, duplicate-row pct, quality flags and
alerts, with a `profiler_version` and a seed for reproducibility. It is faster and more
honest than pandas-profiling for the browse path.

What it does not have:

- **`_correlations` is spearman only** (`engine.py:234` — `numeric_df.rank().corr()`,
  documented as "spearman via rank+pearson (no scipy dependency)"). No pearson, no
  categorical association, so a categorical driver of a numeric target is invisible.
- **Skewness is computed and thrown away** — `engine.py:169` uses `values.skew()` solely
  to raise an `alert`, and never exposes the number.
- No kurtosis, MAD, entropy, or monotonicity.
- No top-K common values — the single most-asked question about a categorical column.
- No rendered report artifact; nothing to hand a reviewer or attach to evidence.

This matters beyond feature-ticking: the profile is the **grounding data** every agent
reads before proposing a pipeline or a chart. "This column is 94% one value" and "these
two columns are 0.97 correlated" are the facts that make a proposal good, and neither is
currently available.

No new infrastructure — the engine already has the frame in pandas. The cost is CPU on
the profile path, which is why the expensive additions go behind the existing
sampling/`minimal` discipline rather than always-on.

---

## Design

### 1. Richer per-column statistics

Extend `ColumnProfile` with `skewness`, `kurtosis`, `mad`, `variance`, `entropy`,
`monotonic` (`none | increasing | decreasing | strictly_*`), and
`top_values: [{value, count, pct}]` (K default 10, capped). Numeric-only fields stay
absent — not zero — for non-numeric columns, so consumers can tell "not applicable" from
"actually zero".

### 2. Correlations

`_correlations` returns a list of matrices rather than one:
`{method: "pearson"|"spearman"|"cramers_v", pairs: [...]}`. Pearson and spearman from
pandas as today; **Cramér's V** for categorical×categorical over a bias-corrected
contingency table, computed only for columns under a cardinality cap (default 50) since
it is O(k₁·k₂). Pair count stays bounded by the existing `MAX_CORRELATION_PAIRS`.

### 3. Report artifact

Render the profile document to a self-contained HTML artifact stored beside the JSON
blob in the existing object store, with a pointer on the profile row — same storage,
same retention, same signed access as every other artifact. Deliberately **not**
pandas-profiling: the document is already computed, so this is a template over it, and it
keeps the dependency surface flat.

### 4. Schema + consumers

`schema_version` bumps; the new fields are additive and optional so older stored profiles
keep deserializing. `app/mcp/facade.py` exposes the new fields so agents ground on them.

### Increment plan

- **inc1** — per-column stats (skew/kurtosis/MAD/variance/entropy/monotonic/top_values)
  + schema bump + tests.
- **inc2** — pearson + Cramér's V, with the cardinality cap + tests.
- **inc3** — HTML report artifact + pointer + MCP exposure.

## Acceptance criteria

| AC | Statement |
|----|-----------|
| AC-1 | Numeric columns carry skewness, kurtosis, MAD and variance; non-numeric columns omit them entirely. |
| AC-2 | Every column carries entropy and `top_values` (≤ K, with counts and pcts summing correctly). |
| AC-3 | `monotonic` is correct for increasing, decreasing, strictly-monotonic and unordered columns. |
| AC-4 | Correlations include pearson **and** spearman; both are bounded by `MAX_CORRELATION_PAIRS`. |
| AC-5 | Cramér's V is computed for categorical pairs under the cardinality cap and skipped (not faked) above it. |
| AC-6 | Profiles remain reproducible under the existing seed. |
| AC-7 | Old stored profiles (previous `schema_version`) still deserialize. |
| AC-8 | The HTML artifact renders standalone and is fetched through the existing signed-artifact path. |
| AC-9 | Profiling a wide frame stays within its existing time/memory budget (sampling discipline unchanged). |
| AC-10 | The dataset MCP facade returns the new fields. |

## Implement & Test log

### Two premises of the Analysis above were WRONG when checked against the code

Recorded here rather than silently corrected, because both changed what inc3 had to be:

1. **"No rendered report artifact; nothing to hand a reviewer."** False. `engine.py`
   already had `render_html_report(doc)`, `InProcessProfilerRunner._run` already wrote
   `{output_prefix}/profile.html` beside `profile.json` in the object store,
   `ProfileService.complete` already verified that object exists and persisted
   `profiles.object_key_html`, and `get_summary` already returned a signed
   `html_report_url` next to `full_json_url` (with `retention` GC'ing both keys). So the
   storage / pointer / signed-access legs of inc3 were **already done before this BRD**.
   What was actually missing was content: the template rendered name/type/semantic/
   null%/distinct/flags and the alert list, and nothing else. inc3 below is therefore
   "render the depth into the existing artifact", not "build an artifact".
2. **"No top-K common values — the single most-asked question about a categorical
   column."** Half false. `top_values` existed for **string/categorical** columns
   (`[{value, count}]`, K=20, values truncated at 128 chars) and is load-bearing
   downstream: semantic-service reads it through `GET /internal/v1/datasets/{id}/profile`
   → `ProfileService.internal_top_values` for metric sample values (SEM-FR-002/080).
   What was genuinely missing was the **pct**, and coverage of numeric / boolean /
   temporal columns.

The rest of the Analysis held up exactly: `_correlations` really was spearman-only
(`numeric_df.rank().corr()`), skewness really was computed only to raise the `SKEWED`
alert and then discarded, and there was no kurtosis / MAD / entropy / monotonicity.

### inc1 — richer per-column statistics — DONE

- **`app/domain/profiling/engine.py`** — `SCHEMA_VERSION = 2`. Every column now carries
  `entropy` (Shannon, base 2, over the non-null value distribution) and
  `top_values: [{value, count, pct}]` computed once from the **raw** non-null values, so
  the `value` keeps its natural JSON type (int stays int, timestamp renders ISO) with
  strings still truncated at 128 chars. Numeric columns additionally carry `skewness`,
  `kurtosis` (**excess**, pandas `Series.kurt`), `variance` (sample, ddof=1) and `mad`
  (**mean** absolute deviation about the mean — the definition of the pandas ≤1.x
  `Series.mad()` V1's pandas-profiling reported; removed in pandas 2, so it is computed
  directly). Numeric + temporal columns carry `monotonic`
  (`none|increasing|decreasing|strictly_increasing|strictly_decreasing`; a constant
  column is neither, matching pandas-profiling). The `SKEWED` quality flag now reads the
  exposed `skewness` instead of recomputing it.
- **Absent, not zero.** Numeric-only fields are simply not written on non-numeric
  columns, and a statistic that is undefined on the rows at hand (sample variance / skew
  / kurtosis of a single row) is omitted rather than null-filled — so a consumer can
  always tell "not applicable" from "actually zero".
- **K.** `TOP_VALUES_K = 10` is the default and `profile_dataframe(..., top_k=)` is
  clamped to `MAX_TOP_VALUES = 20`. This **lowers** the effective K for string columns
  from 20 to 10 (the design says K=10); semantic-service slices `sample_values[:10]`
  anyway, so nothing downstream loses information. One existing assertion in
  `test_internal_detail_api.py` was updated accordingly.

### inc2 — correlations: pearson + spearman + Cramér's V — DONE

- `_correlations` returns a **list** of matrices: `{method: pearson, pairs}`,
  `{method: spearman, pairs}` (still rank+pearson — no scipy dependency), and
  `{method: cramers_v, pairs, max_cardinality, columns, skipped_high_cardinality}`.
  All three entries are always present, so a consumer never has to guess whether a
  method ran. Each matrix keeps the existing `|r| ≥ 0.5` reporting threshold and the
  `MAX_CORRELATION_PAIRS = 200` bound, sorted by descending |value| with a deterministic
  tie-break on the column names.
- **Cramér's V** is bias-corrected (Bergsma 2013) over a `pd.crosstab` contingency table,
  computed with numpy only. It runs for `string|categorical|boolean` columns with
  `2 ≤ distinct_count ≤ CRAMERS_V_MAX_CARDINALITY (50)`; columns above the cap are listed
  in `skipped_high_cardinality` and **not computed** — no fabricated value. Because the
  measure is O(k₁·k₂) per pair and O(rows) per pair, the pass is additionally bounded by
  `CRAMERS_V_MAX_COLUMNS = 25` and `CRAMERS_V_MAX_PAIRS = 100`, and returns `None`
  (→ pair omitted) when the association is undefined.
- **Shape change, called out:** `doc["correlations"]` was a dict in schema_version 1 and
  is a list in 2. No in-repo consumer read the key (verified by grep across every
  service, the BFF and the UI); `render_html_report` accepts **both** shapes so a stored
  v1 document still renders.

### inc3 — report artifact — DONE (content only; storage already existed)

`render_html_report` now renders a **Distribution statistics** table (entropy / skewness /
kurtosis / mad / variance / monotonic, with `—` where a statistic does not apply), a
**Top values** section (value / count / pct, bounded to the first
`REPORT_MAX_TOP_COLUMNS = 100` columns so a 3000-column frame does not produce a megabyte
of tables), and a **Correlations** section per method including the skipped
high-cardinality note. Still self-contained: inline CSS only, no script/font/image/CDN
reference, and it is stored and served through the object-store + signed-URL path that
already existed.

### Schema + consumers

`schema_version` 2; every addition is optional, so a stored v1 document still flows
through `build_summary`, `render_html_report`, `internal_top_values` and the profile read
API unchanged. The ≤64KB Postgres summary was deliberately **left lean** (BR-4 no-blob
rule — adding per-column entropy/monotonic to a 3000-column summary would push it over
the cap and start dropping columns). Instead, **AC-10** is served by a new read-tier MCP
tool `get_dataset_column_stats(urn, version?, columns?)` →
`ProfileService.column_stats`, which reads `profile.json` from the object store and
returns the full per-column statistics (histogram bins dropped) plus the correlation
matrices — audited as `ai.tool_invoked.v1` like every other tool, and still never a
signed URL.

**Test:** `tests/unit/test_profiler_engine.py` 25 → **56** (+31: shape statistics and
their absence on string/boolean/date/categorical columns; undefined statistics omitted
not zeroed; entropy of a uniform vs constant column; top-value counts/pcts, pct-of-
non-null, K bound and cap, presence for every column type; monotonicity across six
ordered/unordered/constant cases plus temporal; pearson vs spearman separated by a
monotonic non-linear relation; pair bound at 200; Cramér's V ≈ 1 for a perfect
association and absent for an independent pair; high-cardinality columns skipped and
reported; column budget on a wide frame; byte-identical profiles under the seed;
schema-v1 fixture still loads and renders; artifact self-contained and carrying the new
sections; wide-frame timing guard). `test_mcp_and_events.py` +2 (AC-10 tool returns the
depth fields, omits numeric-only fields on the non-numeric column, no signed URLs,
audited; column selection). `test_profiles_api.py` +1 (a schema-v1 blob written back
into the object store still serves through `GET /profile` and `column_stats`), plus the
`schema_version == 2` assertion. **Unit suite 270 → 304, green; `make lint` clean;
integration tier 19 green** (`test_full_profile_pipeline_persists` extended to assert the
persisted blob is v2 with the depth fields and that the stored HTML carries the new
sections).

### Live-verified (2026-08-05)

A scratchpad script (`live_verify_brd75.py`, not committed — same convention as the
wave-1 parity live-verifies) drove the REAL dev stack, Iceberg REST (:8181) + MinIO
(:9000): it wrote a 240-row bronze table through the real `IcebergTableWriter`, read
the snapshot back with `IcebergRestCatalog.read_snapshot_head` (all-string bronze, as in
production), profiled it, and stored `profile.json` + `profile.html` in real object
storage. `order_total` came back `logical_type=double, entropy=7.906891,
skewness=0.645131, kurtosis=-0.847386, mad=4907.15, variance=32647859.23,
monotonic=strictly_increasing`; `region` carried none of the numeric-only fields and real
top values with pcts; correlations gave **pearson 0.968 vs spearman 1.0** on the
quadratic `order_id`/`order_total` relation (exactly the discrimination the single
spearman matrix could not express) and **Cramér's V 0.9979** for `region`×`channel`. The
HTML artifact was then fetched back over a **real presigned MinIO URL** (200, 4632 bytes)
with every new section present.

### Deferred (honestly)

- **Interactions (pairwise scatter matrix), the missing-value matrix and duplicate-row
  samples** — named in the Analysis as V1 pandas-profiling features but deliberately not
  in the Design or the acceptance criteria, and not implemented. They are per-pair
  *sample data*, not statistics: they would put row-level data into a profile blob that
  is currently statistics-only, which is a governance question (PII in an artifact with
  a 24h signed URL), not a compute one.
- **Kendall's τ** — V1's fourth correlation measure. Skipped: it is O(n²) without scipy,
  and on a profile path already producing pearson + spearman it adds cost without adding
  a decision.
- **Enriching the ≤64KB Postgres summary** — deliberately not done (see above); the depth
  reaches agents through `get_dataset_column_stats` instead.
- **No agent-graph change.** The wave's "must be drivable by an agent" criterion is met
  the way this BRD's own agent plan states it — "the richer profile is grounding data;
  surface the new fields through the existing dataset MCP facade" — which
  `get_dataset_column_stats` does. No new proposal path was in scope.
