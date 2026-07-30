# Initiative: customer-customizable case forms with AI autofill

Status: **analysis + design + slice 1**. Follows the streams-addon template
(Analysis → Architecture → Implementation & Test, with a per-slice status
table and a live journey as the merge gate).

## The ask, in the customer's words

*"Can customers customize the UI with a templated approach — build their own
pages where they enter case evidence details etc, with AI auto-filling
capabilities?"*

## 1. Analysis — what already exists (verified in code)

The **definition layer is largely built**; a customer can already declare, per
workspace, *what a case type collects* — no code, all governed:

| Capability | Where | State |
|---|---|---|
| Typed case **schemas** (a named case TYPE binding an embedded field set) | `case-service` inc10; `POST/GET/DELETE /case-schemas`; cases carry `schema_key` | shipped; CRUD'd in the **Case types** settings tab |
| Custom **case fields** (per-workspace, typed, `field_meta` JSON, purpose create/update/both) | `POST/GET/PATCH/DELETE /case-fields` | shipped; CRUD'd in the **Case fields** settings tab |
| A **form model** endpoint (defaults + custom fields for a mode) | `GET /cases/form?mode=create` | shipped (server-side) |
| Evidence attachments on a case | `POST/GET /cases/{id}/evidence` | shipped |
| A governed **copilot** that drafts and streams, and whose writes route through **proposals** (four-eyes, never a direct mutation) | agent-runtime + realtime-hub; `useCopilotThread` | shipped |
| OpenAI-compatible **chat** for structured extraction, virtual-key gated + budgeted | ai-gateway `/v1/chat/completions` | shipped |

**What is NOT built** — the two runtime layers this initiative adds:

1. **A schema-driven form renderer.** Nothing turns a case type's field set
   into an actual data-entry form. The only create UI (`CreateCasesDialog`)
   is a hard-coded severity/due/assignee/description form — it ignores case
   types and custom fields entirely.
2. **AI autofill.** The copilot exists but is not wired to *populate a form's
   fields* from attached evidence for a human to review and submit.

So the honest framing for the customer: **defining** a custom form is already
possible (case type + fields, via settings); **rendering** that definition as
a working data-entry page, and **AI-drafting** its values, are the build.

## 2. UI/UX options explored

**Option A — full drag-and-drop page/form builder** (Typeform/Retool-style).
Maximum flexibility; the customer lays out arbitrary pages. Rejected as the
core: it introduces an ungoverned UI surface (a customer could build a form
that bypasses validation, required-evidence, or the four-eyes update path),
it's a large maintenance surface, and it inverts the platform's whole value —
governance through configuration, not free-form code.

**Option B — schema-driven governed forms (RECOMMENDED core).** The customer
customizes by *defining the case type and its fields* (already possible in
settings), and the platform **renders** those definitions as a form that is
governed by construction: types enforce input widgets, `required` enforces
submit-gating, updates still route through proposals, every submit is audited.
Customization is **configuration, not code** — the same principle that makes
28 packs safe on one UI. Layout control comes from lightweight **hints in
`field_meta`** (`label`, `help`, `placeholder`, `group`, `order`, `widget`) —
enough to shape a real intake page without opening a code surface.

**Option C — pack-shipped form templates** (complements B). A pack ships case
types + field sets as part of its bundle, so "build your own page" for a whole
vertical is a pack the customer installs or forks. This is the distribution
channel for B, not a separate mechanism.

**Recommendation: B as the core, C as the distribution channel, A explicitly
declined.** The customer gets "their own pages" through governed definitions +
a renderer that honors them, plus `field_meta` layout hints for look-and-feel
— without a code/eval surface the platform would then have to secure.

### AI autofill, the governed way

The autofill affordance is a **"Fill with AI"** action on the form. It calls
the copilot/extraction path with the case's **attached evidence** (the intake
snapshot, uploaded documents) and the **target field schema**, and returns a
`{field → suggested value}` draft with per-field provenance. Critically:

- **AI fills; the human still signs.** Suggestions land in the form as
  editable, visibly AI-marked values (the existing `AiLabel`/`ProvenanceBadge`
  primitives). The human reviews, corrects, and **submits** — the submit is
  the signed action. AI never auto-submits. This is *exactly* the platform's
  "AI does the work, a named human signs it" ethos applied to data entry, and
  for a *case update* the submit still routes through the proposal/four-eyes
  path, unchanged.
- **Every suggestion is attributable.** Each AI-filled field carries which
  evidence it came from, so a reviewer (and an auditor) can trace it — no
  opaque autofill.

## 3. Architecture (layers)

```
UI/UX   SchemaForm renderer (typed widgets from field defs + field_meta hints)
          └─ "Fill with AI" → AiFillPanel (per-field suggestions + provenance)
  │
BFF     caseForm(schemaKey, mode) query  → case-service GET /cases/form (+ schema)
        draftCaseFields(schemaKey, evidenceRefs) mutation → agent-runtime/ai-gateway
  │
Services  case-service: schemas + fields + form model (EXISTS)
          ai-gateway/agent-runtime: structured extraction over evidence (EXISTS;
            wire a field-drafting prompt/route)
          — governance unchanged: create = signed submit; update = proposal
```

Nothing new in the data plane; the work is one renderer, one autofill panel,
one bff form query, and one drafting route.

## 4. Slices

| # | Slice | State |
|---|---|---|
| 1 | `SchemaForm` renderer — pure, typed widgets from a field set + `field_meta` layout hints + required-validation; unit-tested | **this commit** |
| 2 | Wire `SchemaForm` into a typed **New case** flow (pick a case type → render its fields → submit through the existing create path) + bff `caseForm` query | designed |
| 3 | **AI autofill** — `draftCaseFields` route (evidence + schema → per-field suggestions w/ provenance) + `AiFillPanel`; suggestions are editable, AI-marked, never auto-submitted | designed |
| 4 | `field_meta` layout hints end-to-end (group/order/widget/help) + a pack shipping a custom case-type form as its template | designed |
| 5 | Live journey (`make journey-forms`): define a case type with custom fields → render → AI-draft from a seeded evidence doc → human edits one field → submit → the case row carries exactly the submitted custom_fields, and the audit trail shows a human actor | designed |

## Slice 1 (this commit) — the schema-driven form renderer

`SchemaForm` (ui-web) is a **pure** component: given a normalized field set it
renders one typed widget per field — string→Input, text→Textarea,
integer/float→number Input, boolean→checkbox, date→date Input, enum→select
(options from `field_meta.options`) — honoring `field_meta` layout hints
(`label`, `help`, `placeholder`). It is controlled (`values` + `onChange`) and
ships a `validate()` that enforces `required` and numeric coercion, returning
per-field errors rendered inline. No data fetching lives in it, so it is
trivially unit-testable and reusable by both the create flow (slice 2) and the
AI-autofill panel (slice 3) — the autofill simply calls `onChange` with drafted
values, and the human edits from there.

Verification: unit tests cover every data type's widget + value round-trip,
enum options from `field_meta`, required-field validation (empty vs filled),
numeric coercion/rejection, and the layout-hint label/help rendering.
