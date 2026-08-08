# BRD 77 — document-intelligence service (OCR, classification, page-anchored extraction, completeness)

**Date:** 2026-08-08 · **Status:** authored, build pending · **Lang:** Python · **Port:** 8326 (next free after fhir-bridge 8325)
**Inherits:** `00_MASTER_BRD.md` in full (RLS tenancy, JWT/OPA authz, URNs, outbox events, pagination/idempotency, OTel, testing gates).
**Demand source:** BRD 76 (`um-clinical-review` pack) §9 names this service as the highest-leverage Core gap; `docs/DATACERN_CRT_FIT.md` §5 Phase 4 carries it as the one substantial net-new build.

Evidence tags as in DATACERN_CRT_FIT.md: **[CRT-PDF]** payer's CRT architecture document · **[CORPUS]** payer UM corpus file · **[CODE]** verified in this repo · **[TBC]** unknown, discovery item.

---

## Analysis

### Why this service exists

The platform can decode structured healthcare wire formats (X12, FHIR, HL7v2 — ingestion-service [CODE: `docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md` §2]) but has **no capability for unstructured documents**: scanned charts, faxed clinical records, PDF attachments. Every regulated-casework vertical hits this wall, and the payer evidence is unusually direct:

- Their own CRT architecture flags it twice and owns it nowhere: "Alfresco documents can only be accessed using an API… may need to go through an OCR to translate the data for AI. **OCR for Documents are needed for multiple projects as an enterprise solution.**" [CRT-PDF]
- Their #1 recurring operational defect class is attachment integrity — clinical attachments failing to SFTP with manual recovery, and an open change request to their portal vendor asking for exactly this service's job: "**Availity to scan attachments to verify actual clinicals**" [CORPUS: `Availity RTB Tickets/2026_MASTER Payer Support Tickets_AUTH only.xlsx`; CR list 7.27.26].
- Appeals overturn "due to new information that was not made available at the time of the initial determination" [CORPUS: `2024 UM Program Evaluation Report`] — completeness detection at intake is the countermeasure.
- Fax remains a live intake channel ("Submit request with medical records via fax to …" [CORPUS: P61R1-25 bulletin]); size limits force degraded paths ("file size in base64 binary > 15MB, then SFTP File"; 10MB provider upload limit [CORPUS: `MN-Predictal-PriorAuthv1.0 1.pdf`]).
- The `um-clinical-review` pack already declares the consuming contract: `um-case-documents` requires `ocr_status`, `contains_clinicals`, `classification_confidence`, `doc_type`, `page_count` [CODE: `packs/um-clinical-review/data/datasets.yaml`] — today those columns must come from the tenant's own pipeline; this service is what fills them natively.

### What it must NOT be

- Not a decoder for structured wire formats (stays in ingestion-service).
- Not a decision-maker: extractions and completeness scores are **evidence with provenance**, consumed by agents whose outputs are proposals under four-eyes [CODE: `services/agent-runtime/app/proposals/service.py:_check_eligibility`]. This service never dispositions anything.
- Not a PHI sieve: document bytes live in object storage under per-tenant prefixes; the relational store holds metadata and anchored extractions; logs carry identifiers and status only (fhir-bridge's "no response bodies logged" discipline [CODE: `services/fhir-bridge/README.md`] applies here to page text).

### Scope (v1)

1. **Register & store** documents (upload, object-store pointer, or governed connection fetch) with lifecycle status.
2. **OCR/normalize** PDFs and images into per-page text + layout, via pluggable adapters (local OSS engine for dev; tenant-credentialed cloud OCR for production — BYO, secrets in Vault, mirroring fhir-bridge's adapter posture [CODE]).
3. **Classify** each document: `doc_type`, `contains_clinicals` (the "actual clinicals?" verdict), `classification_confidence`.
4. **Extract** typed clinical facts/entities with **page-anchored provenance** (page number + text span; bounding boxes when the OCR adapter provides them) — the citation substrate BRD 76's review-preparation agent needs.
5. **Assess completeness** against versioned, tenant-scoped **question sets** (e.g., the AHIP-style standardized documentation question sets the payer corpus carries [CORPUS: `Standardized Documentation AHIP BCBSA/Proposed Question Sets/` waves 1–5]): which required items are present (with anchors), which are missing (named).
6. **Publish events** so packs/case triggers can react (`document.classified`, `document.completeness_assessed`, …) and **expose an MCP tool facade** so agents read extractions through the governed tool-plane.

Out of scope v1: handwriting-specialized OCR models, fax *transport* (telephony/RightFax integration — documents arrive as files v1), document *generation*, redaction-as-a-service, embedding/vector search over corpora (memory-service owns retrieval), OCR of formats beyond PDF/TIFF/PNG/JPEG.

---

## Design

### 1. Aggregates & data model (Postgres, RLS per MASTER-FR-001)

- `documents` — id (uuidv7), tenant_id, workspace_id, case_urn (nullable), source (`upload|connection|api`), source_ref, object_key, content_type, byte_size, page_count, status (`received|ocr_running|ocr_ok|ocr_failed|classified|extracted|assessed|failed`), checksum, created/updated/deleted_at. Partitioned by month (MASTER-FR-062).
- `document_pages` — document_id FK, page_no, text_object_key (page text lives in object storage; the row holds the pointer + char_count + ocr_confidence). Partitioned by month.
- `classifications` — document_id FK, doc_type, contains_clinicals (`yes|no|uncertain`), confidence, model_ref, created_at. `uncertain` routes to a human — the service never silently coerces.
- `extractions` — document_id FK, extraction_key (e.g., `diagnosis`, `prior_therapy`, `imaging_finding`), value_text, page_no, span_start, span_end, bbox (nullable JSONB ≤ 64KB per MASTER-FR-061), confidence, model_ref.
- `question_sets` — tenant-scoped, versioned: key, version, title, items[] (item_key, prompt, required, evidence_hint). Immutable once a completeness assessment references a version.
- `completeness_assessments` — document_id or case_urn scope, question_set_key+version, per-item verdict (`present|missing|uncertain`) with anchor refs for `present`, summary counts, created_at.
- `operations` — long-running job rows backing MASTER-FR-027 (202 + operation_id + SSE via realtime-hub).
- `outbox` — transactional outbox (MASTER-FR-034).

Document bytes and page text: object storage under `tenants/<tenant_id>/documents/…` (per-tenant prefix isolation; MinIO in dev per `deploy/docker-compose.dev.yml` [CODE: README dev-infra list]).

### 2. Processing pipeline (async, event-driven)

`register → fetch bytes → OCR (adapter) → classify → extract → (on demand) assess completeness`, each stage a consumer off the service's own topic with DLQ per MASTER-FR-033. Every stage transition updates `documents.status` and emits an event. Failures are terminal states with reasons, never silent (`ocr_failed` is a first-class outcome — the um pack's `ocr_status` column consumes it [CODE: pack datasets]).

**OCR adapters** (`DI_OCR_BACKEND`): `local` (OSS engine, dev/demo grade — e.g., Tesseract-class; accuracy limits documented, never marketed as production-clinical), `aws_textract` / `azure_docintel` / `gcp_docai` (tenant-credentialed BYO; credentials in Vault KV under `secret/data/tenants/<tenant>/ocr-backends/<id>`, never in Postgres — the fhir-bridge secret pattern [CODE]). `REQUIRE_REAL_ADAPTERS=true` refuses to boot with a missing configured adapter [CODE: platform convention, fhir-bridge README]. Which cloud adapters ship in v1 vs later is an increment decision, not a promise — see inc6.

**Classification & extraction** call LLM/vision models **exclusively through ai-gateway** (single choke point [CODE: README services table]; GenAI semconv spans per MASTER-FR-052). Extraction prompts are versioned per question-set/extraction-key; `model_ref` recorded on every row for audit.

**Prompt-injection posture:** page text is untrusted input. When extractions/page text are served to agents as evidence, the existing XPIA screen applies at agent-runtime (`evidence_guard` [CODE: `services/agent-runtime/app/graphs/evidence_guard.py`]); this service additionally tags pages whose text matches injection signatures so the workbench can surface the flag to the human reviewer (detection surfaced, never silently swallowed — the platform's stated posture [CODE: pack control_mappings, NIST measure entry]).

### 3. API surface (`/api/v1`, MASTER-FR-020..028 throughout)

- `POST /documents` — register: multipart upload OR `{object_key}` pointer OR `{connection_id, remote_ref}` fetch-via-governed-connection. Idempotency-Key honored; returns the document.
- `POST /documents/{id}/analyze` — kick OCR→classify→extract; `202 {operation_id}`.
- `GET /documents` / `GET /documents/{id}` — status + metadata (filter: `case_urn`, `status`, `doc_type`).
- `GET /documents/{id}/pages` / `GET /documents/{id}/pages/{n}/text` — paged text access (OPA-gated; access audited).
- `GET /documents/{id}/classification` · `GET /documents/{id}/extractions?filter[extraction_key]=…`
- `POST /completeness-assessments` — `{case_urn | document_ids[], question_set_key, version?}`; `202 {operation_id}`.
- `GET /completeness-assessments/{id}` — verdicts with anchors.
- `POST/GET /question-sets` — tenant-scoped authoring + versioning.
- OPA actions registered at deploy (platform action-catalog registration pattern [CODE: fhir-bridge README `REGISTER_*` envs]): `document.document.create|read|list`, `document.page.read`, `document.extraction.read`, `document.question_set.create|read|update`, `document.assessment.create|read`.

### 4. MCP tool facade (agent access)

`POST /internal/v1/mcp/invoke` federated from the tool-plane dispatcher, mirroring fhir-bridge's facade contract [CODE: README — SPIFFE allowlist via env, **empty = fail closed 403**, per-call OPA re-check of the effective human (`obo_sub`)]. Tools: `document.get_classification`, `document.list_extractions`, `document.get_page_text`, `document.assess_completeness`. This is how BRD 76's review-preparation agent cites "page 12, span …" without ever holding object-store credentials.

### 5. Events (`document.events.v1`, envelope per MASTER-FR-031)

`document.received`, `document.ocr_completed` (payload: page_count, mean confidence, status), `document.ocr_failed`, `document.classified` (doc_type, contains_clinicals, confidence), `document.extraction_completed`, `document.completeness_assessed` (present/missing counts, question_set ref). No page text or PHI in payloads (MASTER-FR-042) — URN references only.

### 6. Consumers wired at launch

- **um-clinical-review pack** [CODE: BRD 76]: events populate the `um-case-documents` shape (`ocr_status`, `contains_clinicals`, `classification_confidence`); `document.completeness_assessed` with missing items is the trigger evidence for the pack's `info_requested` flow (the records-request letter names exactly the missing items).
- **agent-runtime**: evidence reads via the MCP facade (§4).
- **case-service**: documents attach to cases by `case_urn`; workbench renders classification + anchors.
- Sibling verticals (healthcare-provider-rcm, insurance-claims-payer, benefits-appeals [CODE: packs/]) consume the same events for their attachment-bearing workflows — nothing in this service is UM-specific.

### Increment plan

- **inc1** — service skeleton: RLS schema + migrations, object-store integration, `POST/GET /documents`, upload + pointer registration, healthz/readyz, isolation tests. No OCR yet: documents land as `received`.
- **inc2** — pipeline spine: operations, outbox + events, `local` OCR adapter, page storage, `ocr_ok/ocr_failed` lifecycle, DLQ. Exit: a scanned PDF in → per-page text rows + `document.ocr_completed` out.
- **inc3** — classification + extraction through ai-gateway with page anchors + `model_ref` audit; injection-signature tagging. Exit: `contains_clinicals` verdicts with confidence on real sample documents.
- **inc4** — question sets + completeness assessments with anchored present/missing verdicts. Exit: an assessment against a wave-style question set naming missing items.
- **inc5** — MCP facade (SPIFFE fail-closed + OPA re-check) + um-clinical-review integration test: agent cites a page anchor end-to-end; pack columns populated from events.
- **inc6** — first BYO cloud OCR adapter (selection driven by the pilot tenant's cloud [TBC]); `REQUIRE_REAL_ADAPTERS` enforcement; accuracy comparison local-vs-cloud published honestly.

## Acceptance criteria

1. **Isolation:** tenant-A token against tenant-B documents/pages/extractions → 404 on every endpoint (MASTER-FR-004 suite).
2. **Lifecycle honesty:** a corrupt/unreadable file ends `ocr_failed` with a reason and an event — never a silent success or a fabricated empty page set.
3. **Anchored provenance:** every extraction row and every `present` completeness verdict resolves to a real page + span whose text contains the cited evidence (property-tested on fixtures).
4. **Uncertainty routes to humans:** `contains_clinicals=uncertain` and `verdict=uncertain` are legal terminal states surfaced in the workbench; no threshold silently converts uncertain to yes/no.
5. **Governed model access:** zero direct model calls — all classification/extraction traffic transits ai-gateway (asserted by netpol + contract test).
6. **Facade fail-closed:** empty SPIFFE allowlist → 403 on `/internal/v1/mcp/invoke`; missing Vault material with `REQUIRE_REAL_ADAPTERS=true` → refuse to boot (fhir-bridge parity).
7. **No PHI leakage:** logs and event payloads carry no page text/PHI (log-scrub test + event schema review); page-text reads are OPA-gated and audited.
8. **Pack integration:** `um-case-documents` columns populated from this service's events in a journey test extending `test_packs_journey.py` [CODE: `deploy/e2e/`].
9. **Coverage gates per MASTER-FR-070** (≥80% business logic; contract tests on every published event schema).

## NFRs beyond master defaults

| Concern | Requirement |
|---|---|
| Payload sizes | Accept ≥ 25MB documents (the payer's degraded path starts at 15MB base64 [CORPUS] — this service must not inherit that ceiling); stream, never buffer whole files in memory |
| Latency | OCR/extraction is async by design (202 + SSE); the *read* paths hold master p95 targets. No synchronous OCR endpoint exists |
| Throughput sizing | Pilot sizing input: tens of thousands of review cases/year at the reference payer with multi-document cases [CORPUS: program eval volumes]; per-page throughput target set after inc2 benchmarks — **no number promised before measurement** |
| Retention | Document bytes + page text: tenant-configured retention; metadata rows soft-delete; deletion job purges object storage (right-to-delete runbook in RUNBOOK.md) |
| Accuracy claims | None hardcoded. Per-tenant accuracy is measured on the tenant's own fixtures in shadow mode (BRD 76 Phase 2) and reported as measured |

## Deferred, honestly

- **Fax transport** (MLLP-style telephony/RightFax listeners): documents arrive as files/API in v1; transport connectors ride the platform's R1 streaming-connector roadmap [CODE: REALTIME doc].
- **Handwriting/clinical-notes-specialized models** and layout-aware table extraction beyond what the chosen OCR adapter provides.
- **Redaction service** (produce a redacted rendition for downstream sharing) — natural follow-on, separate BRD.
- **Embedding/semantic search over document corpora** — memory-service territory; this service emits, it does not retrieve.
- **Distilled per-tenant extraction models** — rides the existing governed training loop once correction volume exists [CODE: `docs/DATACERN_COMMERCIAL_WEDGE.md` §5.3].
