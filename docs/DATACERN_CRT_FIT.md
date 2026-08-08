# Datacern × CRT — Full BRD Analysis, Design & Architecture, Implementation, and Testing

**Date:** 2026-08-08 · **Status:** proposal (no engagement exists; nothing here has run against the payer's systems)
**Subject:** the payer's **Clinical Review Tool (CRT)** — their own future-state architecture for an AI-assisted UM clinical review application — and how Datacern replaces the build.

## 0. Evidence discipline (read first)

Every claim in this document carries one of four tags:

- **[CRT-PDF]** — read directly from the payer's own architecture document, `UM_Payer/Architecture documents/CRT 2025 future.pdf` (2 pages, extracted in full).
- **[CORPUS]** — read from other documents in the payer's UM_Payer knowledge repository (source file named at point of use).
- **[CODE]** — verified in the Datacern codebase by opening the cited file in this repo.
- **[TBC]** — *to be confirmed*: not verifiable from available material. These are discovery items, not assumptions to build on.

Datacern platform-status honesty carries over from `docs/WHAT_DATACERN_IS.md` [CODE]: zero customers, never load-tested, no independent security audit. Those gaps appear in §5 and §6 as work items, not footnotes.

---

## 1. BRD analysis — what the payer's CRT actually specifies

### 1.1 The two documented options [CRT-PDF]

**Option 1 (their recommended shape):** a decoupled build — custom React UI on the enterprise "MNSEA/MNSight" frameworks, Experience/Process APIs through their API Hub, and a separate **"Clinical Review AI Engine… built using Sagemaker"**, trained in Stage by the Enterprise Analytics (EA) team. Their stated advantage: *"Decouples CRT tool from the AI Engine implementation. Provides flexibility to switch to a different engine or UI. Extensible to add LOBs — add a call to Predictal."* Their stated disadvantages: *"a lot of moving parts; dependencies on multiple teams"* (the diagram color-codes four teams: UI, API, Data Science, Doc Mgmt).

**Option 2:** a React UI built by the EA team in its AWS Analytical Account, tightly coupled to the AI engine. Their own caveat: *"Tightly couples CRT tool and the AI Engine. Doesn't provide flexibility to switch to a different engine or UI."*

### 1.2 Functional requirements extracted from the diagrammed process steps [CRT-PDF]

| # | CRT capability (their numbered steps) | Requirement restated |
|---|---|---|
| FR-1 | "Case Search by Case #" (Member-ID search flagged "?") | Look up an existing UM case; user manually keys the case number (no SSO — assumption 5) |
| FR-2 | "Get Active Cases / Get Case Detail by Case # from Helios" — "Helios has an existing API that returns all case details by Member ID or Case # in FHIR format" | Retrieve case detail from Helios via its existing FHIR API |
| FR-3 | "Trigger Clinical Review Engine — Recommend a list of appropriate policies based on case details" | AI proposes the applicable medical policies for the case |
| FR-4 | "Policy Selection — Display list of policies" | Human selects the governing policy |
| FR-5 | "Trigger Review Summary Engine for selected policy — Summarize selected Policy" | AI drafts the case-vs-policy review summary |
| FR-6 | "Display Final Summary… Store Generated Case Summary" | Reviewer sees the summary; it is persisted |
| FR-7 | "Get Attachments for case" via Alfresco's "Document Management API"; "may need to go through an OCR" | Retrieve medical records for the case; OCR unstructured documents |
| FR-8 | "BCBSMN Policies are accessible to the Clinical Review AI Engine" | Policy corpus available to the engine |
| FR-9 | "Only specific roles will have access to CRT" / "Custom Roles… Security Framework & Audit Logging" | Role-restricted access with audit logging |
| FR-10 | "Integration between the AI Engine and CRT should be near real time… Trained AI Models run in seconds from UI" | Interactive latency (seconds), including the API calls for case, documents, policies |
| FR-11 | "AI Model will be trained before moving to Production. Training… in Stage. Done by the EA team" / "NOT IN PROD ENVIRONMENT" | Model lifecycle separated from production |
| FR-12 | Option 2 adds "Adjust summary" | Reviewer can edit the AI output before storing |

### 1.3 Constraints and stated unknowns [CRT-PDF]

- **Scope:** "Initially only Medicaid is in scope. In the future, extension to other lines of business."
- **No SSO** between CRT and Helios; users re-key case numbers.
- **Open questions in their own document:** "Will this impact Helios performance??"; "Should Member ID be enabled?"; "OCR maybe needed"; "OCR for Documents are needed for multiple projects as an enterprise solution"; "The workflow depicted here is for estimation purposes only."

### 1.4 Business context the CRT document doesn't restate (why this tool matters) [CORPUS]

- Medicaid is their **least-automated LOB** — automated approvals ~19.6% vs 67–68% for Commercial/Medicare (`UM Product Slides - Roadmaps and Results.pptx`), with the largest MD-review budget line ($2.67M of $6.76M; `2026 UM Staffing Workbook`).
- Appeals overturn predominantly on **information missing at initial determination**: "In most cases, appeals are overturned due to new information that was not made available at the time of the initial determination" (`2024 UM Program Evaluation Report`).
- The org's standing objective: "Imbed technology and AI solutions that create efficient use of resources (FTE)" (`2026 Team Objective Options.docx`).
- A CMS Medicaid program-integrity extract of **81,676 PA rows × 77 columns** was rebuilt by hand ("REPULL…final_Clean" workbook) — evidence the audit trail CRT would feed is currently manual.

### 1.5 Gap analysis of their design (what the CRT BRD is missing)

Stated against their own document, not invented:

1. **No human-decision governance layer.** The flow stores an AI summary; nothing in either option describes proposal/approval separation, who signs, or how an adverse recommendation is prevented from becoming a determination without a clinician. (Their broader corpus commits to clinician review of denials; the CRT diagram itself carries no mechanism.)
2. **No evaluation/calibration step.** "Training… in Stage" has no measurement gate: no agreement metric against decided history, no promotion criteria, no canary.
3. **No correction capture.** Option 2's "Adjust summary" edit is discarded as far as the diagram shows — the labeled training signal their model needs is not collected.
4. **OCR is everyone's dependency and no one's deliverable** — flagged "needed for multiple projects as an enterprise solution," owned by no component in the diagram.
5. **Audit is a UI-framework line item** ("Security Framework & Audit Logging" inside MNSEA), not a tamper-evident decision record.
6. **Multi-LOB is a rebuild risk** — "add a call to Predictal" gets case data, but nothing in the design carries per-LOB criteria hierarchies, turnaround clocks, or role differences.
7. **Manual case entry** (no SSO, re-keyed case numbers) builds a swivel-chair step into a tool whose purpose is speed.

---

## 2. Design & architecture — CRT delivered on Datacern

### 2.1 Fit thesis

Their Option 1 exists to keep the AI engine swappable. Datacern **is the swapped-in engine plus the governance their BRD is missing**, consuming the same payer APIs their own design names. Nothing in their "no changes" legend (Helios, Alfresco, policies storage, Member 360) is touched.

### 2.2 Payer data sources & APIs (the integration surface)

Everything known about each source, and what discovery must confirm:

| Source | What their documents establish | Datacern integration | To confirm [TBC] |
|---|---|---|---|
| **Helios** (Medicaid UM core; SQL Server transactional DB, replica mentioned in Option 2) [CRT-PDF] | "Existing API that returns all case details by Member ID or Case # in FHIR format" [CRT-PDF]; platform also gaining "ability to accept 3rd party determination for PAs – change to API" and "Auth Update capability: API" [CORPUS: `Medicad Auth AI 2025 future.pdf`] | Register as a tenant FHIR backend in **fhir-bridge** [CODE: `services/fhir-bridge/README.md` — admin plane `/api/v1/fhir-backends` with `/test` connectivity probe (`GET {base_url}/metadata`), upstream auth `none|bearer|basic|oauth2_client_credentials|smart_backend_services`, secrets in Vault, OPA-checked reads, no PHI stored]. Write-back of the human-approved determination via the pack's governed `http_api` adapter [CODE: `packs/um-clinical-review/connections/write_adapters.yaml`] | Exact FHIR resource shapes & version; auth method; rate limits (their own "Will this impact Helios performance??"); whether the replica DB is exposed; the determination write-back endpoint contract |
| **Alfresco** (medical records, S3) [CRT-PDF] | "Documents can only be accessed using an API — Document Management API currently exists"; "has medical records for every Medicaid case — will be in Production shortly" [CRT-PDF]; also receives Availity PA attachments [CORPUS: `MN-Predictal-PriorAuthv1.0 1.pdf`] | HTTP connector via the governed tool-plane (connector types `postgres|s3|sftp|http_api` [CODE: DEEP_PACK_AUTHORING_ADDENDUM — ingestion `connectors.validate_config`]); retrieved documents feed the review case as evidence | Document Management API contract (auth, search-by-case semantics, formats); volume/size profile; whether direct S3 access is permitted as an alternative |
| **BCBSMN policy corpus** ("BCBSMN Public Storage — Policies Documents") [CRT-PDF] | "Policies are accessible to the Clinical Review AI Engine" [CRT-PDF]; ~400 internally maintained policies [CORPUS: `UM Talking Points - Value Story.docx`]; policy-to-code mappings exported from Itiliti (609 policies, 7,506 codes) [CORPUS: Itiliti CSVs] | Ingested into **memory-service** as tenant-scoped, versioned grounding for the policy-recommendation step (FR-3); the `um-policy-catalog` binding contract tracks digitization state [CODE: `packs/um-clinical-review/data/datasets.yaml`] | Authoritative source of truth (public site vs Itiliti vs SharePoint); update cadence; Medicaid-specific criteria (state manuals) access |
| **Member 360 API** (Enterprise Integration Services, AWS) [CRT-PDF] | Named as the service-layer path for case detail / "Transform FHIR into AI CRT format" | Called through the governed tool-plane (mcp-gateway) like any external API; the FHIR transform their diagram hand-builds is unnecessary — Datacern consumes FHIR natively via fhir-bridge | API contract, auth, whether it fronts Helios (one hop) or must be bypassed |
| **API Hub (Kong)** [CORPUS: `MN-Predictal-PriorAuthv1.0 1.pdf` names "BCBSMN apihub Kong API Gateway"] | Option 1 routes integrations through it; Option 2 keeps it only for Alfresco | Datacern's outbound calls can route via the Hub if the payer requires; inbound, the payer's UI (if retained) calls Datacern's API | Network path, mTLS/gateway policy for a vendor SaaS or in-VPC deploy |
| **Decided-case history** (for calibration) | 2024 Medicaid pre-service non-BH volume 26,917 reviews [CORPUS: `2024 UM Program Evaluation Report`]; a Medicaid PA extract with decision fields exists at 81,676 rows [CORPUS: Blue Plus claims template] | S3/SFTP incoming connector → `um-determinations` binding contract → shadow-mode replay [CODE: pack `connections/sources.yaml`, eval-service] | Extract format, refresh cadence, de-identification terms |

### 2.3 Component mapping (CRT block → Datacern)

| CRT block [CRT-PDF] | Datacern component [CODE] | Delta |
|---|---|---|
| Clinical Review AI Engine (SageMaker; recommend policies + summarize) | agent-runtime (review-prep agent, proposal emission) + ai-gateway (single LLM choke point) + memory-service (policy retrieval) | Engine replaced; output becomes a **cited proposal**, not a stored blob |
| "Store Generated Case Summary" | case-service + audit-service (hash-chained events [CODE: `services/audit-service/internal/chain/chain.go`], WORM export [CODE: `internal/worm/worm.go`]) | Summary persists **with provenance**: inputs, sources, editor, approver |
| "Adjust summary" (Option 2) | Correction capture → consent-gated, PII-redacted transcript/SFT curation [CODE: `services/agent-runtime/app/domain/{transcripts,sft_curation}.py`] | The edit becomes a labeled training example instead of vanishing |
| "Training the model… in Stage" | pipeline-orchestrator + experiment-service with eval-gates and canaries [CODE: `services/eval-service/app/api/routes/{gates,canaries}.py`], four-eyes promotion [CODE: `services/agent-runtime/app/proposals/service.py:_check_eligibility`] | Ungoverned Stage training → gated, approved promotion |
| "Custom Roles" | rbac-service + the pack's six-role catalog [CODE: `packs/um-clinical-review/rbac/roles.yaml`] | Only the Medical Director approves dispositions/bulk/promotions |
| "Security Framework & Audit Logging" (UI-layer) | audit-service (append-only, tamper-evident, exportable) | Audit moves from UI framework to decision-record spine |
| Case Search UI (MNSEA React) | Either: their UI calls Datacern's API (Option-1 decoupling working as intended), or Datacern ui-web worklist | Payer's choice; both preserve their "flexibility to switch UI" requirement |
| "Near real time… runs in seconds" | realtime-hub (SSE push) [CODE: services table, `README.md`]; agent triage in seconds [CODE: `docs/WHAT_DATACERN_IS.md` — 9 agents ~20s verified 2026-07-24] | Latency requirement met at the platform level; formal SLO in §6 |
| OCR ("maybe needed… enterprise solution") | **Does not exist in Datacern either** — honest BUILD item (§5 Phase 4). Until then, `ocr_status`/`contains_clinicals` arrive from the tenant's pipeline per the binding contract | The one genuinely new engineering component on either side |

### 2.4 Target flow (their FR numbering preserved)

```mermaid
sequenceDiagram
    participant N as Nurse (their UI or ui-web)
    participant D as Datacern (case-service/agent-runtime)
    participant FB as fhir-bridge
    participant H as Helios FHIR API
    participant A as Alfresco Doc Mgmt API
    participant M as memory-service (policy corpus)
    participant MD as Clinician (four-eyes)

    N->>D: open case (FR-1; SSO or event-created case, no re-keying)
    D->>FB: get case detail (FR-2)
    FB->>H: FHIR read (Vault-held creds, OPA-checked)
    D->>A: get attachments (FR-7, via tool-plane)
    D->>M: retrieve candidate policies (FR-3, FR-8)
    D-->>N: proposed policy list + evidence (FR-4: human selects)
    N->>D: policy selected
    D-->>N: drafted criteria-by-criteria summary, cited (FR-5)
    N->>D: edit/accept (FR-12 — captured as correction)
    D->>MD: proposal for sign-off (governance the CRT BRD lacks)
    MD->>D: approve (distinct human; self-approval rejected)
    D->>D: audit event chained + stored (FR-6, FR-9)
    D->>H: human-approved determination write-back (governed adapter)
```

Multi-LOB extension (their assumption 2) becomes: register Predictal's API as a second backend + LOB config already in the pack (`lob` domain: `commercial_fi|commercial_aso|medicare|medicaid`; LOB clock table shipped) — no rebuild [CODE: `packs/um-clinical-review/decisions/um_lob_clock_escalation.yaml`].

### 2.5 Deployment shape [TBC]

Datacern is built multi-tenant with RLS tenancy and per-cloud Terraform/Helm (AWS/GCP/Azure) [CODE: `README.md`, `deploy/terraform,helm`]. For a payer PHI workload the realistic options are a dedicated single-tenant cell in the vendor cloud or in-VPC deployment in the payer's AWS — selection, network path (their Kong hub, PrivateLink, or VPN), and BAA terms are commercial/discovery items, not settled here.

---

## 3. What the payer keeps, what Datacern replaces, what is net-new

| Category | Items |
|---|---|
| **Keep untouched** (their "no changes" legend) | Helios, Alfresco, BCBSMN policy storage, Member 360, API Hub; optionally the MNSEA UI team building the front end against Datacern's API |
| **Replaced (never built)** | SageMaker engine; Stage training pipeline; hand-rolled Experience/Process API glue for AI calls; FHIR→"AI CRT format" transform; summary storage; custom audit |
| **Added (missing from their BRD)** | Four-eyes proposal gating; hash-chained audit; correction capture; eval-gated promotion; shadow-mode calibration; PII-redaction guardrails; LOB-aware criteria hierarchy + clock config; role catalog |
| **Net-new build (honest)** | Document-intelligence/OCR service (both sides lack it); Alfresco + Helios write-back connectors; SSO integration; production LoRA/GPU training if a distilled tenant model is wanted [CODE: `docs/DATACERN_COMMERCIAL_WEDGE.md` §5.3 — CPU path proven, GPU path requires customer GPU account] |

---

## 4. Requirements traceability (CRT FR → Datacern mechanism)

| CRT FR | Datacern mechanism | Status |
|---|---|---|
| FR-1 case lookup | case-service + (SSO or event-created cases) | REAL platform; SSO integration per-tenant work |
| FR-2 Helios case detail | fhir-bridge registered backend | REAL mechanism; Helios specifics [TBC] |
| FR-3 policy recommendation | review-prep agent + memory-service grounding | REAL mechanism; corpus load is onboarding work |
| FR-4 human policy selection | workbench interaction; selection recorded | REAL |
| FR-5 summary drafting | agent drafting with citations, proposal-mode | REAL mechanism (existing case-triage agent specialization [CODE: pack `agents/configs.yaml`]); bespoke chart-reader recipe deferred honestly [CODE: pack.yaml `deferred`] |
| FR-6 display/store summary | case-service + audit-service | REAL |
| FR-7 attachments + OCR | tool-plane connector (REAL mechanism, contract [TBC]); OCR = BUILD | Split status — see §5 Phase 4 |
| FR-8 policy corpus access | memory-service tenant grounding | REAL |
| FR-9 roles + audit | rbac roles (shipped in pack) + audit chain | REAL |
| FR-10 seconds-latency interactive | SSE + agent latency; formal SLO to be published | REAL behavior observed in dev [CODE: WHAT_DATACERN_IS §5]; **no load test yet** — §6 |
| FR-11 train outside prod | eval-gated pipeline + four-eyes promotion | REAL |
| FR-12 adjust summary | correction capture → SFT curation | REAL |

---

## 5. Implementation plan

Phases gate on evidence, not calendar promises. Effort ranges deliberately omitted where discovery drives them.

**Phase 0 — Discovery (with the payer).** Resolve every [TBC] in §2.2: Helios FHIR contract + auth + rate limits (their own performance question), Alfresco API contract, Member 360 contract, policy source-of-truth, network/deployment shape, BAA/de-identification terms for the decided-case extract. Exit: signed integration spec per source.

**Phase 1 — Foundation (REAL, config-only).** Deploy the minimal service footprint (identity, rbac, audit, case, agent-runtime, ai-gateway, tool-plane, fhir-bridge, ingestion, pack-service, memory, eval, notification, realtime-hub, BFF/UI). Install `um-clinical-review` via pack-service's governed phases [CODE: DEEP_PACK_AUTHORING_ADDENDUM — `POST /api/v1/installs` dry-run → apply → `/complete` after a distinct human approves the semantic model]. Register Helios in fhir-bridge; run its `/test` metadata probe. Exit: pack install ledger clean against a dev tenant; probe green.

**Phase 2 — Shadow mode (ASSEMBLE).** Bind the four dataset contracts to real extracts (install fails closed naming missing columns — by design). Load the policy corpus into memory-service. Replay decided Medicaid cases; measure agreement per queue (policy-recommendation hit rate, summary quality rubric, recommendation-vs-actual-outcome agreement). Tenant curates eval golden sets from its own decided history; freeze via eval-service [CODE: addendum `eval_sets` — frozen = immutable]. Exit: published per-queue agreement report; go/no-go thresholds agreed with the payer's medical leadership.

**Phase 3 — Assisted-live pilot (one queue).** Nurses work prepared cases; MDs sign referrals; corrections accumulate. UI decision executed (their MNSEA UI on Datacern's API, or ui-web). SSO integration lands here (removes their manual case-number re-keying). Exit: pilot queue KPIs vs baseline (prep time per case, clock breaches, records-request latency).

**Phase 4 — BUILD items.** (a) **Document-intelligence service**: OCR + page-anchored clinical extraction — the one substantial new Core service; until shipped, the tenant's existing OCR feeds `ocr_status`/`contains_clinicals` per the binding contract. (b) Alfresco connector productionization. (c) Helios determination write-back against the API their Medicaid Auth-AI plan already commissions ("add ability to accept 3rd party determination… change to API" [CORPUS]). (d) Optional: X12 278 real-time / Da Vinci rails per the platform roadmap [CODE: `docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md` R1/R5].

**Phase 5 — Hardening (honest platform gaps, pre-scale).** Load testing (currently absent), independent security audit (currently absent), HIPAA/BAA operational posture, DR/retention runbooks. These are entry criteria for expanding beyond the pilot queue, stated as such.

**LOB expansion (post-pilot).** Commercial/Medicare: register Predictal backend, extend pack config — the pack already carries all four LOBs' fields, clocks, and hierarchy grounding.

---

## 6. Testing strategy

### 6.1 Already-executed (authoring-time) — results, not plans
- `packctl validate um-clinical-review` → **manifest ok (22 components, 1 deferred)**; `packctl lint` → **0 errors / 0 warnings**; pack coherence C1–C11 → **0 findings**; fleet coherence across all packs → **0 errors**. (Run 2026-08-08 in this repo.)

### 6.2 Platform test tiers that exist today [CODE: files verified in `deploy/e2e/`]
- **Governance e2e:** `test_governed_write_loop.py` — asserts on system-of-record bytes that ungranted and forged-grant writes are refused and only a legitimately-signed, human-approved grant lands exactly one change.
- **FHIR journey:** `test_fhir_journey.py` — the fhir-bridge read/write path under governance.
- **Learning loop:** `test_learn_journey.py` — governed resolutions → real training run → self-approval rejected (403) → distinct-human promotion → scoring.
- **Pack install journey:** `make journey-packs` (`test_packs_journey.py`) — installs a pack into a fresh tenant and asserts on Core rows (fields/layout arrive, drift detection goes red on human edits, uninstall deletes/retains as promised). Extend the fixture matrix to `um-clinical-review`.
- Per-service unit/integration suites (`make test`) and fhir-bridge's own unit tier [CODE: `services/fhir-bridge/test/`].

### 6.3 CRT-specific test plan (to execute per phase)
- **Integration (Phase 1–2):** Helios FHIR contract tests against recorded fixtures from discovery; fail-closed tests (fhir-bridge refuses on missing Vault material and empty SPIFFE allowlist — behavior documented in its README [CODE]); binding-contract negative test (install must fail naming missing columns).
- **Shadow-mode calibration (Phase 2):** agreement metrics on the decided-case replay with per-queue thresholds; golden-set regression via eval-service gates on every agent/prompt change thereafter.
- **Governance UAT (Phase 3):** (a) no path — agent, decision table, or API — can emit `adverse_determination_md` without a human clinician actor (C2/C3 static checks + runtime negative tests); (b) self-approval rejected; (c) proposer ≠ approver enforced for MD sign-offs; (d) audit export reproduces a full determination file for a sampled case (the NCQA file-review drill).
- **PHI tests:** guardrail redaction on agent egress (pack ships `pii.redact: true` [CODE]); verify no PHI in fhir-bridge logs (its stated design: resource type/id/status/latency only [CODE: README]).
- **Performance (Phase 3/5):** publish a p95 SLO for case-open → prepared-proposal (target: seconds-grade per their FR-10; the platform roadmap names p95 < 60s event→triage as the target metric [CODE: REALTIME doc R4]) — measured, then load-tested at projected Medicaid concurrency (staffing workbook: ~50–65 Medicaid RN/MD FTE [CORPUS]) before scale-out. **Until Phase 5 runs, no concurrency claim is made.**
- **Regression cadence:** golden-set evals + journey suites on every release; drift report (`GET /installs/{id}/drift`) monitored for pack-config drift.

### 6.4 Acceptance criteria (pilot exit)
1. Shadow-mode agreement at or above the thresholds the payer's medical leadership set per queue.
2. Zero governance-test failures (self-approval, forged grant, adverse-determination path).
3. Audit export accepted by the payer's compliance reviewer as file-review-ready for a sampled month.
4. Pilot-queue operational KPIs reported against baseline (prep time, clock breaches, records-request latency) — reported as measured, whatever they show.
5. All Phase-0 [TBC] items closed with signed integration specs.

---

## 7. Open questions register (nothing here is assumed)

| # | Question | Owner | Source of the question |
|---|---|---|---|
| 1 | Helios FHIR API: resource shapes, auth, rate limits, replica availability | Payer integration team | [CRT-PDF] (their own "Helios performance??") |
| 2 | Member-ID search enablement | Payer | [CRT-PDF] ("Should Member ID be enabled?") |
| 3 | Alfresco Document Management API contract + volumes | Payer Doc Mgmt | [CRT-PDF] |
| 4 | Policy corpus source-of-truth and update feed | Payer UM Product | [CORPUS] (AEM→Itiliti migration in flight) |
| 5 | Deployment shape (dedicated cell vs in-VPC) + network path via Kong hub | Joint | [TBC] |
| 6 | De-identified decided-case extract terms for shadow mode | Joint (BAA) | [TBC] |
| 7 | Determination write-back endpoint (the API their Medicaid plan commissions) | Payer / Helios vendor | [CORPUS: `Medicad Auth AI 2025 future.pdf`] |
| 8 | OCR: build order for the document-intelligence service vs tenant's interim OCR | Datacern | [CRT-PDF] + this doc §5 Phase 4 |
