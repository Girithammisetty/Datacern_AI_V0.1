# Deep-pack authoring addendum — the 9 artifact kinds the original guide left deferred

**Read `PACK_AUTHORING_GUIDE.md` first; this extends it.** Since that guide was
written, packctl's `SUPPORTED_KINDS` (packctl/manifest.py) grew from 13 to 22
kinds. The original guide's instruction "`deferred:` all 9 kinds" is **stale**:
today the ONLY honestly-deferred kind is `agent_recipes` (needs real LangGraph
module code, not config). Everything else installs against a real Core API.

Every schema below is pinned from the actual materialization code — the
`ensure_*` calls in `packctl/client.py`, the dispatch in
`services/pack-service/app/domain/installer.py`, the lint contract in
`packctl/lint.py` (`REQUIRED_FIELDS`/`NAME_FIELD`), and each Core service's own
validator. Do not invent fields.

## Install path — pack-service, NOT the packctl CLI

`packctl/installer.py` (the CLI) has **no dispatch branch** for `case_fields`,
`case_schemas`, `guardrails`, `display_labels`, `eval_sets`,
`model_archetypes` — the CLI would silently no-op them. Deep packs must install
through **pack-service**, which covers all 22 kinds with governed phasing:

1. Config kinds first (dispositions → case_fields → case_schemas →
   display_labels → guardrails → agent_configs → eval_sets → model_archetypes →
   ontology → write_adapters → connection_templates → roles → decision_models).
2. Data chain (datasets → semantic/verified as governed DRAFTS → saved queries
   → cases → pipelines → memories).
3. Dashboards materialize only in `POST /installs/{id}/complete`, **after a
   distinct human steward approves the semantic model** (four-eyes is never
   bypassed).

Calls (pack-service reads the on-disk `packs/` tree directly — no upload):

```
GET  /api/v1/packs/{name}/lint                    # author-time gate
POST /api/v1/installs {pack, version, workspace_id, dry_run:true}   # plan
POST /api/v1/installs {pack, version, workspace_id}                 # apply
POST /api/v1/installs/{id}/complete               # phase-2 dashboards, post-approval
POST /api/v1/installs/{id}/upgrade                # version bump of an installed pack
POST /api/v1/installs/{id}/rollback               # revert an upgrade
GET  /api/v1/installs/{id}/drift                  # live-vs-ledger drift report
```

Caller needs `pack.install.execute`; every write runs AS the caller's JWT.

## Manifest changes for a deep pack

- Bump `version` (e.g. `1.0.0` → `2.0.0`) — pack-service upgrade/rollback keys
  off it, and the ledger snapshot preserves the old bundle.
- Move each newly-authored kind from `deferred:` into `components:`. Leave ONLY
  `agent_recipes` in `deferred` (with its honest reason).
- Identities still match `^[a-z][a-z0-9_]{0,62}$`.

## Per-kind file schemas (exact, code-pinned)

### decision_models — `decisions/<name>.yaml` (agent-runtime, BRD 54)
List of tables. Lint requires `name`, `rules`; dedup key = `name`.
```yaml
- identity: reg_e_triage            # optional; falls back to component identity
  name: "Reg E dispute triage table"
  rules:
    - when:                          # ALL conditions must hold (AND)
        - { column: deadline_days_left, op: between, value: [0, 2] }
      then: { disposition_code: escalate_fraud_review, severity: critical }
      note: "why this rule exists — shown in the trace"
  default_outcome: { disposition_code: deny_no_error_found, severity: low }
```
- `op` ∈ `eq ne gt gte lt lte in not_in between contains starts_with ends_with
  matches exists is_empty` (agent-runtime `decisions.py` OPERATORS).
- `between` value MUST be a 2-element `[low, high]` (inclusive); `in`/`not_in`
  take a list; `matches` a regex.
- `severity` ∈ `low medium high critical`.
- Every `disposition_code` is validated against the workspace disposition
  catalog at install — dispositions install first; a code not in
  `cases/dispositions.yaml` (or Core's built-ins) fails the install.
- `column` refers to the case's `display_projection` columns — use ONLY columns
  your `cases/queue.yaml` rows actually project.

### case_fields — `cases/fields.yaml` (case-service, CASE-FR-022)
List. Lint requires `name`, `data_type`. Idempotent by `name`.
```yaml
- name: reason_code
  data_type: enum        # string | text | integer | float | boolean | date | enum
  purpose: both          # optional; default both
  field_meta: { label: "Network reason code", options: ["10.4","13.1"], required: false }
```
`data_type` enum is closed (case-service `validDataType`). `data_type` is
immutable after creation — pick correctly the first time.

### case_schemas — `cases/schemas.yaml` (case-service, typed case types)
List. Lint requires `schema_key`, `name`.
```yaml
- schema_key: chargeback_representment
  name: "Chargeback representment"
  description: "Merchant-side representment work item"
  fields:                           # embedded defs: {name, data_type, label, required}
    - { name: reason_code, data_type: enum, label: "Reason code", required: true }
    - { name: liability_amount, data_type: float, label: "Liability at stake", required: true }
```

### ontology — `ontology/entities.yaml` (dataset-service, inc11)
List. Lint requires `entity_key`, `name`.
```yaml
- entity_key: cardholder
  name: Cardholder
  description: "The disputing account holder"
  attributes:                       # [{name, data_type, description?}]
    - { name: card_last4, data_type: string }
  relationships:                    # [{name, target, cardinality}]
    - { name: disputes, target: dispute, cardinality: has_many }
```
`target` should be another `entity_key` in the same file (type-level graph).

### guardrails — `agents/guardrails.yaml` (agent-runtime, BRD 53 inc2)
List. Lint requires `agent_key`. Applied as a partial upsert — does NOT disturb
the agent's `prompt_params` from `agents/configs.yaml`.
```yaml
- agent_key: case-triage
  budget: { max_tokens_per_session: 60000 }  # clamped DOWN to operator ceiling server-side
  pii: { block_pii_egress: false, redact: true }
  bind_workspace: true                       # installer injects the install workspace as data_scope
```
Field names are validated by agent-runtime `_validate_guardrail_policy`
(registry.py): `budget.max_tokens_per_session` (int, floor + ceiling clamped)
and `pii.{block_pii_egress, redact}` (booleans) — exactly these keys.
Guardrail applies to agents that exist in the tenant registry — ship an
`agent_configs` entry for the same `agent_key`.

### eval_sets — `evals/golden.yaml` (eval-service, inc8)
List. Lint requires `dataset_key`, `agent_key`. Installer creates the eval
dataset, its cases (`source: manual`, `source_ref: pack:<dataset_key>:<key>`),
then **freezes** the version — frozen = immutable golden set. Needs ≥1 case.
```yaml
- dataset_key: cd_triage_golden
  agent_key: case-triage
  description: "Golden triage decisions for the dispute queue"
  cases:
    - key: reg_e_clock_expiry
      input:    { dispute_type: fraud_unauthorized, amount: "742.10", deadline_days_left: 1 }
      expected: { disposition_code: escalate_fraud_review, severity: critical }
      tags: [reg_e, clock]
      weight: 2.0                    # optional, default 1.0
```

### model_archetypes — `models/archetypes.yaml` (experiment-service, inc9)
List. Lint requires `archetype_key`, `name`, `task_type`.
```yaml
- archetype_key: dispute_fraud_scorer
  name: "Dispute first-party-fraud scorer"
  task_type: classification
  target: disposition
  description: "Intended model: probability a dispute is first-party misuse"
  expected_metrics: { f1: 0.85 }
  governance_notes: "Adverse-action relevant; four-eyes promotion required"
```

### write_adapters — `connections/write_adapters.yaml` (ingestion-service, inc12)
List. Lint requires `name`, `connector_type`. Materialized as a real OUTGOING
connection with `skip_test: true` + EMPTY secrets — the tenant completes
credentials in Data → Connections; every write is proposal-mode four-eyes.
```yaml
- name: "Core banking dispute status sync"
  connector_type: http_api          # postgres | s3 | sftp | http_api (connectors.py CONNECTOR_TYPES)
  direction: outgoing               # optional; default outgoing
  config: { base_url: "https://example-core-banking.invalid/api", method: POST }
```
`config` is validated per connector_type by ingestion-service
`connectors.validate_config` — mirror an existing outgoing connection's config
shape for that type (see `docs/initiatives` decision write-back or an existing
tenant connection) rather than guessing keys.

### connection_templates — `connections/sources.yaml` (ingestion-service, inc13)
Identical shape to write_adapters with `direction: incoming`. Use for the
vertical's expected source feeds (e.g. an SFTP drop for X12 837 files, an S3
bucket of ISO 20022 pacs.008 XML).

### display_labels — `labels/overrides.yaml` (identity-service, inc3)
List. Lint requires `key`, `value`. Requires tenant-admin (`identity.user.admin`).
```yaml
- { key: cases.title, value: "Disputes" }
```

## Deep-pack content bar (beyond schema validity)

1. Decision tables encode REAL regulatory/network logic with citations in
   `note`s, over columns the seeded queue actually projects.
2. Eval golden cases are derived from the seeded closed rows (the 20 closed
   CSV rows with real dispositions ARE the labels) — never invented outcomes.
3. Case schema + fields match the vertical's actual work item; ontology models
   the parties the data references.
4. Seed data: do NOT rewrite the existing CSVs for a deep upgrade —
   `ensure_dataset` is idempotent by name (noop when the dataset exists), so an
   upgraded pack's bigger CSV would never reach an already-installed tenant.
   The existing pattern-rich seed rows stay; deep value comes from the new
   governed kinds, which all materialize additively on upgrade. (Only a
   brand-new pack should ship bigger seed data.) Likewise seeded cases dedup
   server-side on (dataset_urn, row_pk) — an upgrade cannot change an existing
   case's display_projection, so decision-table columns must be ones the v1
   projections already carry.
5. Grounding memories: only well-established facts; qualitative when unsure
   (Rule 1). Note: SR 11-7 was rescinded 2026-04-17 (superseded by SR 26-2) —
   do not cite it as current in banking packs.
6. Verified queries: 5+ real domain questions, `{{dataset('<kebab>')}}` macros only.
7. Everything installable twice (idempotent) and lint-clean:
   `GET /api/v1/packs/<name>/lint` → zero errors.
