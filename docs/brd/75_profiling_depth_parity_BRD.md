# BRD 75 — Profiling depth parity

**Status:** OPEN — 2026-08-04 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
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

_(pending)_
