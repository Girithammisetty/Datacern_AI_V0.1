# The Knowledge Spine — operationalizing DataCern's ontology

**Status:** analysis + design done · Increment 1 (WS1) built + unit-verified — 2026-07-23
**Commits:** `ac14fcc` (WS1 code — absorbed into a concurrent commit via a broad `git add`), `2a68815` (initiative doc + tests)  ·  **Related:** [BRD 56](../brd/56_entity_resolution_BRD.md) (entity resolution), semantic-service (semantic models), dataset-service ontology (inc11), [BRD 57](../brd/57_standards_native_interop_BRD.md) (standards), memories `project_windrose_ontology`, `project_windrose_pack_blueprint`
**Source of inspiration:** B. Ciric, "The Knowledge Spine: Why Your Ontology Needs to Grow a Backbone" (LinkedIn, 2025).

> This is a design/analysis initiative. Every "current state" claim is cited to
> real code (verified 2026-07-23 via three parallel read-only code surveys). The
> "proposed" sections are design, not yet built. Increment 1 is scoped to a
> buildable first slice.

---

## 1. Analysis

### 1a. Platform / product

The article's thesis: enterprise AI hallucinates because the ontology lives as
**static documentation** (PDFs, slide decks) that never informs systems *at query
time*. The fix is a **Knowledge Spine** — the ontology *operationalized*
(deployed, versioned, queryable) and *connected* at query time to the actual data
(lakehouses, domain graphs, unstructured sources) through **virtual mappings, not
data migration**, so every consumer, human or machine, "resolves meaning through
one governed backbone." Seven principles: ontology-first (OWL/RDF/SHACL);
virtualize by default; federate domain graphs; unstructured as first-class;
ground AI in the spine (explainable + auditable); version & govern like code;
grow incrementally.

Why this matters for DataCern specifically: our differentiation is a **governance
fabric + tamper-evident WORM audit** around agent decisions. The article's spine
is the missing connective tissue that would let that governance operate on
*business meaning*, not just rows — "who approved this action, can we prove it,
is it working?" becomes answerable in the customer's own domain terms. And
DataCern already owns the parts the article says most enterprises lack
(virtualized query, governed versioning, audit lineage, a correction→retrain
flywheel). The vertebrae exist; they are not strung together.

### 1b. Technical — current state (verified)

DataCern has **three overlapping domain layers that are deliberately not
code-linked**:

- **Ontology** (entity TYPES) — dataset-service. `OntologyEntity{entity_key,
  name, attributes[], relationships[]}` stored as JSONB, tenant+workspace
  RLS-scoped (`services/dataset-service/app/domain/entities.py:223-243`,
  migration `0004_ontology.py`). Relationships use three cardinalities
  (`belongs_to`/`has_many`/`has_one`). CRUD is create/list/get/delete only —
  **no update, no versioning** (`app/api/routes/ontology.py`). Not a semantic-web
  standard (no OWL/RDF/SHACL). Authored by **27 of 28 packs**
  (`packs/*/ontology/entities.yaml`).
- **Semantic models** (flat dataset bindings) — semantic-service.
  `Definition{entities, dimensions, measures, join_paths}` where each entity
  binds to one `dataset_urn` + physical table + version policy
  (`app/domain/definition.py:37-98`). **Fully governed**: draft→in_review→
  published→superseded, author≠approver enforced, machine diff on publish
  (`app/domain/services.py:348-396`). Validated against real dataset schema.
- **Entity resolution** (resolved INSTANCES / golden records) — dataset-service,
  BRD 56. Deterministic + probabilistic link layer over one dataset's real rows;
  golden records materialized to a governed Iceberg dataset; four-eyes merges;
  SoR never mutated (`app/domain/entity_resolution.py`, `services.py:515-607`).

**The gaps, cited:**

1. **The ontology is not consumed at reasoning time.** `grep -rin ontolog`
   across `services/agent-runtime` returns **zero** matches. Agents ground in:
   the case row + case fields + disposition catalog + memory-service RAG (real
   768-dim `nomic-embed-text` embeddings) + bounded case-evidence text
   (`app/graphs/triage.py:57-100`, `persona_copilot.py`). They do **not** see the
   ontology or semantic models. The ontology UI even claims "agents reason over
   the graph" (`services/ui-web/src/app/(app)/data/ontology/page.tsx:20-23`) —
   **the runtime does not do this.** (Honesty item: fix the claim or make it
   true; this initiative makes it true.)
2. **The three layers are not linked.** ER's `entity_type` is a free string,
   never validated against `OntologyEntity.entity_key`
   (`entity_resolution.py:34`); a semantic `Entity` references a `dataset_urn`
   but never an ontology type. No foreign key or lookup joins them.
3. **Ontology governance is asymmetric.** Semantic models have four-eyes
   versioning; the ontology has none — changing a type is delete+recreate.
4. **Relationships are inert.** BFF returns `relationship.target` as a bare
   `String!` (`services/bff-graphql/schema.graphql:5271-5316`); it is never
   resolved into a linked `OntologyEntity`, so the "graph" is not navigable.
5. **Unstructured/standards are not entity-linked.** X12/FHIR/HL7v2/ISO20022/
   ACORD decoders (ingestion-service) land documents as governed dataset
   rows/columns; case evidence attaches to a case. Neither is tied to an
   ontology entity (`app/domain/xml_standards.py:11-15`; EvidenceReader
   `app/adapters/evidence.py`).

**Scorecard vs the 7 principles** (✅ have · ⚠️ partial · ❌ gap):

| # | Principle | Status | Evidence |
|---|-----------|:---:|----------|
| 1 | Ontology-first, standards | ⚠️ | custom JSONB, no OWL/RDF/SHACL; relationships inert |
| 2 | Virtualize by default | ✅ | Trino direct-read over Iceberg-REST (`query-service/internal/engine/trino.go:18-27`) |
| 3 | Federate domain graphs | ❌ | per-tenant/workspace siloed; "federate" in code = MCP routing |
| 4 | Unstructured first-class | ⚠️ | decoders + EvidenceReader exist, not entity-linked |
| 5 | Ground AI in the spine | ❌ | ontology/semantic unused at reasoning time |
| 6 | Version & govern like code | ⚠️ | semantic ✅ / ontology ❌ (asymmetric) |
| 7 | Grow incrementally | ✅ | capability-only packs, late-bound to real data |

**Reframed problem:** DataCern doesn't need a new ontology product; it needs to
turn the ontology it *already ships in 27 packs* into the operational spine that
connects data → semantics → instances → unstructured → agents, under the
governance it already enforces elsewhere.

---

## 2. Architecture & Design

Make `OntologyEntity.entity_key` the **canonical domain type id** — the join key
every other layer references — and make the ontology **operational** (read at
query/reason time) and **governed like the semantic layer already is**. Five
workstreams, ordered by leverage; each preserves the no-dummy-data +
capability-only + four-eyes invariants.

- **WS1 — Operationalize (ground agents in the ontology).** Inject the relevant
  governed domain model into the agent `ground` node so reasoning resolves
  business meaning (attribute semantics, enums, relationships), not raw JSON.
  Delivers Principle 5 — the article's central anti-hallucination claim — and
  makes the existing UI claim true. **This is Increment 1 (scoped below).**
- **WS2 — Connect the vertebrae (link on `entity_key`).** Optional
  `ontology_entity_key` on the semantic `Entity`; validate ER `entity_type`
  against the registry; make the ontology-attribute → dataset-column mapping
  explicit (it is already *implicitly* "drawn from the dataset contract
  columns"). The ontology becomes the coherence anchor the pack-depth-audit
  checker can validate. Principle 3 ("connected").
- **WS3 — Govern the ontology like semantic models.** Add versioning + a
  four-eyes `update` (the deferred `dataset.ontology.update`), reusing the
  semantic-service state machine + author≠approver + diff pattern. Principle 6.
- **WS4 — Real graph + SHACL-style contracts.** Resolve `relationship.target`
  into a linked `OntologyEntity` in the BFF (navigable graph); add attribute
  constraints (required/enum/cardinality) that *validate bound data*, fusing the
  ontology with packctl's existing `required_columns` check into a data-contract
  enforcer. Offer an **OWL/JSON-LD export projection** for external interop —
  **do not** re-platform onto RDF/Stardog. Principle 1.
- **WS5 — Entity-link unstructured + close the steward loop.** Tag
  standards-decoded rows and extracted case evidence with the `entity_key` they
  instantiate; route the `missing_knowledge` signal transcripts **already
  capture** (`app/domain/transcripts.py:35-51`) into a governed steward queue
  that *proposes ontology updates* — a self-improving spine, matching DataCern's
  human-correction differentiator. Principles 4 & 7.

### Explicit non-goals (Rule 7 — don't over-engineer)
- No RDF/OWL/Stardog re-platform. Governed JSONB + Iceberg + Trino already give
  the "operationalized + virtualized" characteristics; adopt the standard as an
  export projection only.
- No cross-**tenant** federation. DataCern is multi-tenant SaaS; the valuable
  "federation" is intra-tenant cross-dataset reasoning via ontology join paths.

---

## 3. Implementation & Test

### Increment 1 (WS1) — ground agents in the workspace ontology — BUILT

**Design (grounded).** The agent grounding pipeline is `ground → reason →
propose` (`app/graphs/triage.py`, `persona_copilot.py`). `GraphDeps` carries
`obo_token` (`app/graphs/base.py:41`) and an existing `dataset_reader`
(`DatasetServiceClient`, wired to `settings.dataset_service_url`); the workspace
comes from the **case row**, which carries `workspace_id`
(`case-service/internal/domain/types.go`), read in the `ground` node. The
ontology list endpoint filters by workspace and is gated by `dataset.ontology.read`
(`services/dataset-service/app/api/routes/ontology.py:43-49`,
`GET /api/v1/ontology/entities?filter[workspace_id]=<ws>`). So the type graph is
fetched and injected with **no new `GraphDeps` field and no new links** — the
cleanest first slice.

**Built (this increment):**
1. `DatasetServiceClient.list_ontology_types(tenant_id, workspace_id, auth_token)`
   (`app/adapters/dataset.py`) → the workspace ontology; fail-soft (returns `[]`
   on any error/authz denial, logs WARN — mirrors the adapter's existing
   `list_datasets`/`get_schema` pattern). Reuses the existing `dataset_reader`;
   no new adapter/dep.
2. `_fetch_ontology(deps, state)` + `_format_ontology(types)` in `triage.py`
   (shared, imported by `persona_copilot.py` — same convention as the evidence
   helpers). `_fetch_ontology` resolves `ws = state["case"].get("workspace_id")`,
   fetches types into `state["ontology_types"]`, records an `ontology_grounded`
   trace event (or `ontology_grounding_failed` on error — best-effort, never
   raises, never forces human approval). `_format_ontology` renders a **bounded**
   governed-domain-model block (≤12 types, ≤20 attrs, ≤12 rels) — trusted
   metadata, so no XPIA frame.
3. Wired into the `ground` node of both `triage.py` and `persona_copilot.py`
   (after `state["case"]` and, in the copilot, after the data-scope refusal so an
   out-of-scope case never triggers a read); the block is injected into the
   `reason` prompt ahead of the raw case JSON.
4. RBAC: `dataset.ontology.read` + `dataset.ontology.list` granted to **Case
   Analyst** and **Case Manager** in `services/rbac-service/seed/roles_actions.yaml`
   — the exact roles that already carry `memory.memory.read` for OBO copilot
   grounding (same precedent + comment). Read-only domain metadata; authoring
   stays with Use case Admin. (Case Executive runs no copilot grounding, so it
   was correctly left unchanged.)

**Verified:**
- Unit (agent-runtime): `tests/unit/test_ontology_grounding.py` — 6 tests: both
  triage and copilot inject the governed domain model (types + attribute enums +
  typed relationships) fetched for the *case's* workspace; a reader error is
  surfaced in the trace, not swallowed, and the run still produces its governed
  proposal; no ontology source → unchanged prompt; `_format_ontology`
  render/empty. Full suite **318 passed**; ruff clean.
- **Deferred (honest):** live-verify (drive a real triage on a pack tenant and
  confirm the domain model in the run trace) needs the running agent-runtime
  reloaded (not started with `--reload`) **and** an rbac re-seed for the new
  grants to apply. Not run here; the wiring is unit-proven and fail-soft.

**Deliberately out of Increment 1:** per-case entity-TYPE resolution (inject only
the specific type for the case, not the whole workspace graph) — deferred to WS2
once the semantic/ER links exist; semantic-layer NL→SQL ontology wiring (WS2);
governance/versioning of the ontology (WS3).

### Increment 2 (WS3) — govern the ontology like semantic models — BUILT (backend)

Closes gap #3 (governance asymmetry: semantic models had four-eyes versioning;
the ontology had none — change = delete+recreate). The ontology now versions and
updates through a four-eyes flow that mirrors the semantic-service state machine.

**Built (dataset-service):**
- **Schema (`0006_ontology_versioning.py`).** `ontology_entities.version_no` (the
  live row's currently-published version) + a new `ontology_entity_versions`
  table (every revision + the review queue: `in_review | published | superseded |
  rejected`, definition snapshot, machine `diff`, submitter/approver/note),
  RLS-forced like the rest. Existing types are **backfilled** with a v1
  `published` version so history is complete from day one.
- **State machine (`OntologyService`).** `create` now seeds a v1 published
  version. `propose_update` opens an `in_review` revision (name/description/
  attributes/relationships overlaid on the live definition) **without touching
  the live type** — one open proposal at a time (409 otherwise), and the next
  version number is one past the highest ever used so a rejected/superseded
  number is never reused. `approve_update` publishes it — **author≠approver
  enforced** (403 on self-approve), supersedes the prior published version,
  updates the live row, and records a machine `diff` (name/description changed +
  attributes/relationships added/removed/changed). `reject_update` closes a
  proposal, live unchanged. Events: `update_proposed` / `updated` (with diff) /
  `update_rejected`.
- **API + RBAC.** `GET/POST /ontology/entities/{key}/versions`,
  `POST .../versions/{n}/approve`, `POST .../versions/{n}/reject`, gated on new
  actions `dataset.ontology.update` (propose) and `dataset.ontology.approve`
  (decide), both granted to the use-case admin so two distinct admins are needed
  to publish a change. Added to dataset-service's action MANIFEST.

**Verified:** `test_ontology_versioning.py` — 11 cases: create seeds v1;
propose leaves the live type unchanged; self-approve 403 (four-eyes); a distinct
approver publishes + supersedes + updates the live row + diffs; reject leaves it
unchanged; one-open-at-a-time 409; re-propose after reject bumps to v3 (no number
reuse). Existing `test_ontology_api.py` unchanged and green; `ruff` clean; full
dataset-service unit suite green (bar 3 pre-existing DuckDB-httpfs network-gated
failures unrelated to this change).

**BFF + UI (built).** The full stack is wired: BFF `ontologyVersions` query +
`proposeOntologyUpdate` / `approveOntologyUpdate` / `rejectOntologyUpdate`
mutations (schema snapshot regenerated; 4 resolver tests). On the ontology page
each type card shows its current `vN` and a **History & review** panel
(`OntologyVersionPanel`) that lazy-loads the history on expand, lets an author
**Propose update** (name/description), and lets a distinct reviewer
**Approve/Reject** an in-review proposal — a self-approve surfaces the real 403
honestly, a duplicate proposal the real 409. Published rows show a compact diff
summary. 3 component tests (lazy load + approve vars + propose vars). `tsc`/lint
clean; ui-web 700 + BFF 420 unit tests green.

### Increment 4 (WS4) — SHACL-style data contracts — BUILT

Attribute constraints that *validate bound data*, enforced through the WS2
attribute → column map (relationship navigability shipped earlier as the WS4
graph slice). Built 2026-08-03:

- **Constraint authoring (dataset-service).** Attributes may carry
  `required: bool` and `enum: [scalars]`, shape-validated at ontology create
  AND at a WS3 proposed update (`_validate_ontology_attributes`) — a malformed
  constraint can never silently disable enforcement. The internal lookup route
  additionally returns `attribute_specs` for the semantic layer.
- **Binding contract (semantic-service).** At submit/approve, a REQUIRED
  attribute of the linked ontology type must appear in the entity's
  `ontology_attribute_map` — an entity cannot claim to instantiate a type while
  leaving its required attributes invisible. Fail-soft on registry outage, as
  with every ontology check.
- **Data contract (dataset-service).** `check_ontology_contract` +
  `POST /api/v1/ontology/entities/{key}/contract-check` (gated
  `dataset.dataset.read` — it reads rows): enforces required/enum against a
  dataset's REAL rows through the map. Violations are honest and typed:
  `required_unmapped` (the contract cannot be satisfied invisibly),
  `column_missing`, `nulls_in_required` (count), `value_not_in_enum` (count +
  worst-offender examples, bounded). Blanks belong to the required check — the
  enum check skips them so one bad cell never double-counts. Read-only; an
  unmapped optional attribute is simply not checked.
- **BFF + UI.** `OntologyAttribute.required/enumValues`, a
  `checkOntologyContract` mutation mapping violations back typed; the ontology
  page marks required attributes (\*) and shows `enum(n)` with allowed values
  on hover; the builder's attribute-map editor flags required attributes so a
  steward sees what must be mapped before submit says so.

**Deferred:** the OWL/JSON-LD export projection (the other WS4 leg); a UI runner
for the contract check (BFF-exposed, not yet surfaced as a button).

### Increment 5 (WS5) — the missing-knowledge steward loop — BUILT (first slice)

The self-improving spine: humans already record "what knowledge was missing"
when deciding an agent proposal (the 4th Agent-in-the-Loop correction signal,
PII-redacted at capture, joined onto the transcript as `feedback.missing_knowledge`).
WS5 routes that signal into the governed ontology flow. Built 2026-08-03:

- **Steward queue (agent-runtime).** `GET /api/v1/knowledge-gaps` — decided
  transcripts carrying the signal, newest decisions first, projected to gap +
  provenance only (agent, decision, decider; never the transcript body).
  Store methods on both tiers (memory filter / SQL `feedback->>'missing_knowledge'`),
  tenant-scoped by RLS like the transcript corpus it subsets.
- **BFF.** `knowledgeGaps(limit): [KnowledgeGap!]!` (agent client + mapper +
  resolver; snapshot regenerated).
- **UI (ontology page).** A **Knowledge gaps** panel (renders only when there is
  real signal): each gap shows the missing-knowledge text + provenance, and a
  steward picks the domain type it belongs to and clicks **Propose update** —
  the gap lands as a knowledge note on the type's description as a WS3
  `in_review` proposal that a DISTINCT admin must publish (four-eyes). The gap
  never mutates the ontology directly.

**Deferred in WS5:** entity-linking standards-decoded rows + case evidence to
`entity_key` (the other WS5 leg); richer gap→proposal shapes (e.g. proposing a
new attribute or a new type instead of a description note); marking a gap as
handled/dismissed (the queue is read-only over the transcript corpus today, so
a proposed gap still lists).

### Increment 3 (WS2) — link the vertebrae on `entity_key` — BUILT (slices 1+2)

Closes gap #2 ("the three layers are not linked") on the canonical join key
(`OntologyEntity.entity_key`).

**Slice 1 (2026-08-02) — the joins:**

- **ER → ontology (dataset-service).** A resolution run resolves its
  `entity_type` against the governed ontology registry in the dataset's
  workspace and reports `ontology_linked` in the run summary + the
  `dataset.entity_resolution.run` event. A miss is honest metadata, never an
  error — free-string types and resolve-before-declare keep working; an
  unreadable dataset never claims a link. Tests: `test_ws2_ontology_links.py`.
- **Semantic → ontology (semantic-service).** The semantic `Entity` gains an
  optional `ontology_entity_key`, validated to the restricted name shape at
  authoring, round-tripping through the stored definition; absent stays valid.
  Tests: `test_ontology_entity_key.py`.
- **BFF + UI.** `ResolveEntitiesResult.ontologyLinked: Boolean!` (absent
  downstream → honest false); the ER page's run summary states the link or
  tells the steward exactly what to declare.

**Slice 2 (2026-08-03) — existence validation + builder UI:**

- **Registry lookup (dataset-service).** New internal route
  `GET /internal/v1/ontology/{workspace}/{key}` (SPIFFE-gated, tenant via the
  mesh header — same pattern as the SEM-FR-002 dataset-detail routes) returning
  `{exists, name}` with 200 either way, so a caller can tell a definitive miss
  from an unreachable registry. Tenant-scoped tests included.
- **Authoring validation (semantic-service).** `DatasetClient.get_ontology_type`
  (`True`/`False` from a definitive answer, `None` on transport error) +
  `validate_definition(..., ontology_lookup)` — a **definitive "not declared"
  fails submit/approve** with a problem naming the key (typo protection), while
  a registry outage **fails soft** (the link is optional metadata; an outage
  never blocks authoring). Wired through `_validate_full` with the model's
  workspace at both submit and approve. Tests: declared passes / typo'd key 422
  with the problem text / outage passes.
- **Builder UI (ui-web).** Each entity row in the semantic-model
  `EntitiesSection` gains an **Ontology type** select fed by the governed
  registry (`useOntologyEntities`), writing `ontology_entity_key` into the
  definition (clearing drops the key so unlinked entities stay byte-identical).
  Editor test covers linking + the saved definition carrying the key.

**Slice 3 (2026-08-03) — the explicit attribute → column mapping (closes WS2):**

- **Registry lookup grows attributes.** The internal ontology route now returns
  `{exists, name, attributes:[names]}`, so the semantic layer can validate a
  mapping against the governed type's real attribute list.
- **`Entity.ontology_attribute_map`** (semantic-service) — the explicit
  `{attribute_name: column_name}` map the initiative called for (the mapping was
  previously only *implicit* in "drawn from the dataset contract columns").
  Shape-checked at save (requires `ontology_entity_key`; string→string only).
  At submit/approve: **attribute names** are validated against the registry
  (fail-soft on outage, definitive miss fails naming the attribute), and
  **column names** are validated against the bound dataset schema — a
  definitive check that holds even during a registry outage. Tests cover the
  valid map, the undeclared attribute, and the bad-column-during-outage case.
- **Builder UI.** When an entity's ontology type carries attributes, the editor
  renders an **Attribute mapping** block — one picker per attribute over the
  entity's REAL dataset columns (never free text). "Not mapped" removes the
  entry; an empty map is dropped so unmapped entities stay byte-identical.
  Clearing the type also clears the map. Editor test covers map → autosave.
- **Published-model read view:** verified — published versions render through
  the same `DefinitionEditor` in read-only mode, so the ontology type (and its
  mapping) are visible on the read view with no extra surface.

With this, WS2 is **complete**: one `entity_key` joins ontology type →
resolution runs → semantic entity, and each governed attribute can name the
exact dataset column that carries it — the substrate for per-case typing,
"measures of this type" queries, data-contract enforcement (WS4's SHACL-style
checks now have a mapping to enforce), and an Entity-360 view.

### Phasing
WS1 (increment 1) proves the anti-hallucination thesis on the existing
pipeline with the smallest build. WS2 links the layers (unlocks per-case typing +
cross-dataset reasoning). WS3 (increment 2, backend built) closes the governance
asymmetry. WS4 makes it a navigable, contract-enforcing graph with standards
export. WS5 makes it self-improving. Each is independently shippable and
documented as its own increment here.

**Honest status:** analysis + design complete and code-grounded; **Increment 1
(WS1) is built and unit-verified** (adapter + shared grounding helpers + both
graphs wired + RBAC grants + 6 tests, full suite 318 green). Its live-verify is
deferred (needs an agent-runtime reload + rbac re-seed). WS2–WS5 remain design.
One correction vs the first draft of this doc: `workspace_id` lives on
`WriteIntent`, not `GraphDeps` — the ground node sources the workspace from the
case row instead (fixed in the design above).
