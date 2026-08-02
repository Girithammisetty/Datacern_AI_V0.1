<!-- converted from wellstar-rcm-demo-runbook.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

Datacern AI

Demo Environment Runbook

Cold-start a wiped local stack → provision a tenant → demo governed decision intelligence and agentic AI features

Provider Revenue Cycle vertical — Wellstar prospect demo Local macOS development stack

# What this runbook does

This is a complete, copy-paste runbook for standing the Datacern AI platform back up from a clean state (no Docker containers, no images, no data) and running a live product demo, ending with the AI agentic features. Every command is the same one used in the actual development workflow — nothing here is a mock or a shortcut path; the platform seeds itself, provisions real tenants through real APIs, and every governed action still requires a human approval.

Phases

Phase 0 — Prerequisites (Docker Desktop memory, Ollama)

Phase 1 — Bring up the whole platform from a clean Docker state

Phase 1b — Restart agent-runtime in multi-tenant mode (required for Copilot)

Phase 2 — Provision the demo tenant (tenant, users, datasets, dashboards, cases)

Phase 3 — Logins

Phase 4 — Deterministic decision-intelligence demo arc (governed rules + four-eyes approval)

Phase 5 — Agentic AI (LLM) demo beat — case Copilot

Phase 6 — Optional: autonomous ML-engineer agent showcase

Phase 7 — Fully manual, no-seeder walkthrough — click every step yourself, no scripts

Appendix — Troubleshooting, resetting again, and command reference

# Phase 0 — Prerequisites (once)

Run these before opening the terminal session you'll demo from. Docker Desktop must be running (the app, not just installed) and Ollama must be serving locally — the platform pulls its own models automatically.

cd /Users/girithammisetty/Projects/practice/Datacern_AI_V0.1 # Docker Desktop must be running (you deleted containers/images, not the app) open -a Docker # wait until Docker Desktop shows "running" in the menu bar # Ollama must be serving — the bring-up script auto-pulls the models it # needs (llama3.2, qwen2.5:0.5b, nomic-embed-text) but the daemon itself # must already be up brew services start ollama # or, in a separate terminal: ollama serve

Note: Docker Desktop needs a few seconds to finish starting after “open -a Docker” before its socket is ready — check the whale icon in the menu bar before proceeding.

### Give Docker Desktop enough memory

22 services plus a full infra stack (Postgres, OpenSearch, ClickHouse, Redpanda, Trino, MLflow, Keycloak, Vault) genuinely needs headroom. Docker Desktop → gear icon (Settings) → Resources → Memory.

Verified: Verified live at 14GB on a 24GB Mac — comfortable, with room left for macOS and other apps. The default 8GB is NOT enough: it OOM-crashes the Docker VM mid-boot, silently wiping every container that was already up (Postgres included) with no warning beyond a generic “connection refused.” If you ever see that, this is almost certainly why — bump the memory before retrying, don't just retry.

# Phase 1 — Bring up the whole platform from scratch

One command does everything:

deploy/local/up.sh --platform-only

What this actually does, in order:

Preflight-checks Docker, Ollama, and required ports

Infra: brings up Postgres, Redis, OpenSearch, MinIO, and ClickHouse via docker compose -f deploy/docker-compose.dev.yml

Creates every service's own database and runs its migrations

Builds and boots all ~22 backend services plus the ui-web frontend, wired to each other

Health-checks every service before continuing — nothing is assumed up

Seeds only the base platform tenant (demo.datacern) and its 4 RBAC-gated personas — the --platform-only flag is exactly “no demo/vertical data”

Timing: Because you deleted the Docker containers and images, this first run rebuilds everything from scratch (Go/Python builds, Postgres image pull, etc.) and will take noticeably longer than a normal restart — several minutes is expected, not stuck.

### If it FATALs with “postgres not reachable”

Seen live once: right after changing Docker Desktop's memory setting (which restarts its VM), the very next docker compose up can race the VM before it's fully settled and fail. It is NOT the 8GB OOM-crash above if you already bumped the memory — it's a one-off timing race. Recover in two commands, then resume the bring-up:

docker compose -f deploy/docker-compose.dev.yml up -d # wait for it to report every container Healthy/Started, THEN: deploy/local/up.sh --platform-only --skip-build

Tip: --skip-build reuses already-compiled service binaries so the retry is fast (seconds to reach PHASE 2, not minutes) — safe here because the failure was purely infra timing, not a bad build.

### Verify the platform is actually healthy

deploy/local/doctor.sh

This checks the two failure modes that actually happen after a cold start: a durable-storage volume missing, or a projection (RBAC permissions in Redis, the OpenSearch case index) not rebuilt from Postgres. Green across the board means it's safe to move on; run doctor.sh HEAL=1 to self-heal anything red.

# Phase 1b — Restart agent-runtime in multi-tenant mode

One required step, easy to miss: the platform bring-up boots agent-runtime with a single LLM credential scoped to whichever tenant it seeds first (the base platform tenant). Any OTHER tenant's Copilot/agent calls — including your wellstar-live demo tenant — silently 401 (“the copilot didn't return a response” in the UI) until this is run once:

deploy/local/restart_agent_runtime.sh

Verified: Verified live: without this, Copilot on the demo tenant fails every time with no useful UI error. With it, agent-runtime mints a fresh, correctly-scoped credential per tenant automatically on each call. One-time per platform boot — not needed again until you run up.sh from scratch again.

# Phase 2 — Provision the demo tenant

This is the step that creates everything the audience will see: the tenant itself, the three demo users, four uploaded synthetic datasets, the installed product pack (decision tables, dashboards, semantic models), and the open case worklist.

export DEMO_TENANT_SLUG=wellstar-live export DEMO_TENANT_DISPLAY="Wellstar Health — Live Demo" deploy/e2e/.venv/bin/python deploy/demo/wellstar_rcm_demo.py

This single script narrates each real step as it runs:

Tenant provisioned (real identity-service tenant, real RBAC seed)

3 users made ACTIVE (admin, director, specialist — see Phase 3 table)

4 synthetic RCM datasets uploaded: claims, remits, denials, A/R aging

healthcare-provider-rcm pack installed

Both semantic models four-eyes-published (a second user must approve the author's own model)

3 dashboards built against the real uploaded data (12 charts total)

The apply-disposition tool registered in the global catalog (idempotent — only does real work the first time ever on a fresh platform) and enabled for this tenant

A 9-case open denial worklist created from the real denial rows

Fixed: The tool-catalog registration step was added after we hit it live on a freshly wiped platform: a from-scratch tool-plane database has no tools registered at all, so enabling apply-disposition for the tenant 404'd. It's now built into the script itself — nothing manual required here anymore.

deploy/local/restart_ui.sh

Important: Required, not optional — the new demo logins were just written to personas.json, and ui-web only reads that file at boot. Skipping this step means the new logins simply won't exist yet.

Want a completely independent second run later? Just pick a new DEMO_TENANT_SLUG (e.g. wellstar-live-2) and re-run Phase 2. No teardown is needed — each slug is a fully separate tenant with its own users, and your earlier tenant is left untouched as a fallback.

# Phase 3 — Logins

| Tenant | Email | Password | Role |
|---|---|---|---|
| Base platform (demo.datacern) | admin@demo.datacern | demo | Everything, cross-cutting |
| wellstar-live (your demo tenant) | admin@wellstar-live | (any text) | Admin — drives the demo |
| wellstar-live (your demo tenant) | director@wellstar-live | (any text) | Case Manager — the four-eyes approver |

Reminder: Login page is http://localhost:3000/login — dev-mode login accepts any password for a known email. Use director@wellstar-live to approve a proposal that admin@wellstar-live created — four-eyes governance blocks a user from approving their own proposal, by design.

# Phase 4 — Deterministic decision-intelligence demo arc

This arc is instant — no LLM involved — and shows the governed, rule-based backbone of the platform: deterministic logic that only ever proposes an action, never executes one, until a second named human approves it.

Dashboards — log in as admin@wellstar-live, open RCM Command Center, Denial Analytics, A/R Aging Actions. Every chart is on the real synthetic data just uploaded.

Cases worklist — open the “Denials & A/R Worklist,” pick an open claim, click Start (moves it in_progress).

Decision Tables — open “Denial worklist triage,” click Preview batch on the case (dry-run: shows the exact rule that fired and a plain-English trace, no side effect yet).

Propose for matches — run it for real: mints one governed proposal per matched case. Nothing has executed — it's a proposal awaiting approval.

Switch seats — sign out, sign in as director@wellstar-live, open the Approvals inbox. The proposal shows the full rationale, the predicted effect, and the exact proposed field changes.

Approve — the disposition is applied. Back on the case: status resolved, the resolution note carries the exact rule trace that fired it.

Talk track: Try approving your own proposal as a live aside — the platform blocks it server-side. This is the single best line to say out loud: “every consequential action needs a second, different person, and that's enforced by the backend, not a UI convention.”

# Phase 5 — Agentic AI (LLM) demo beat

This is the part that is genuinely LLM-driven rather than rule-based. Start it early — a local Ollama model on a laptop answers in minutes, not seconds.

Kick it off first, as early in the meeting as you can: open a case, click Copilot (top right), ask something like “summarize this denial and the appeal history for this payer.” Let it work in the background while you run Phase 4.

Return to it later to show the answer — this is the agent reasoning over the case's real attached evidence and rows, governed by the same per-tenant guardrails (data-scope limits, a token budget, PII-egress redaction) that apply to every agent action on the platform, not a special case for chat.

# Phase 6 — Optional: autonomous ML-engineer agent showcase

If the audience specifically wants to see “does it get smarter over time,” there's a separate, pre-built showcase of a fully autonomous train → evaluate → propose-promote agent loop. It seeds into the base demo.datacern tenant, not wellstar-live — it's a different vertical (claims triage) and a different story (model lifecycle, not case governance).

deploy/e2e/.venv/bin/python deploy/local/seed_claims_demo.py

Then, logged in as admin@demo.datacern: Cases → open the duplicate-invoice claim → Copilot triages it → approve the proposal in the Inbox → the correction feeds the learning loop → ML → Experiments shows the retrained, promoted model.

Recommendation: Only add this if the room specifically asks “does it improve itself” — otherwise it splits focus across two tenants and two stories. Most demos are stronger staying entirely inside wellstar-live.

# Phase 7 — Fully manual, no-seeder walkthrough

Everything above uses deploy/demo/wellstar_rcm_demo.py to provision the tenant's data in one shot. This section is the opposite: every artifact — the file, the dataset, the case type, the trigger, the semantic model, the dashboard — created by clicking through the product exactly as a real customer would on day one, with zero seeding scripts. Verified live, click-by-click, end to end; every gotcha below was hit for real.

When to use this track: This is a genuinely different narrative from the rest of this runbook: instead of showing a pre-built tenant, you show the audience *how a new customer actually onboards* — upload a file, watch it become governed data, turn it into automation. Strong opener for a technical buyer; the other phases are the better choice for a business-stakeholder demo.

## The order that actually works

Case Triggers fire on ingestion-COMPLETE events — forward-looking only, never retroactive. A trigger created after a file is already uploaded will never fire for that upload's rows. Build the automation first, then feed it data — which is also the more natural “set up the workflow, then go live” story for an audience:

Data Sources — upload a file (creates the dataset)

Case settings — Case type (defines the fields a case captures)

Case settings — Trigger (defines which dataset + which rows become cases)

Semantic Model + Dashboard (can happen anytime — not order-dependent)

Now upload the REAL data file — cases materialize automatically

Case detail — Copilot analyzes the real, grounded case

Recovered from live testing: If you upload first the way we did while verifying this (upload, then realize you want automation, then build the trigger), it's NOT broken — just re-run the file upload once the trigger exists, or use a fresh dataset name for the real take. Don't discover this live; rehearse the order once.

## 1 — Data Sources: upload a file

Data Sources → New data source → File upload:

Choose file — drop a CSV/JSON/Parquet/Avro/XML/X12/FHIR/HL7v2/ISO 20022/ACORD file, or click to browse. Format auto-detects from the extension; dataset name auto-suggests from the filename (editable).

Upload — chunked, resumable (8MB parts); a progress bar tracks confirmed parts.

Review — the completed dataset, profiled on arrival.

Behind that wizard: Ingestions shows the run (mode file_upload, status completed, real row count) and Datasets shows the new dataset status ready — the exact same pipeline whether a human clicks through the wizard or a script calls the same chunked-upload API.

## 2 — Case settings: Case type

Cases → Settings → Case types → New case type. Key = the stable id (duplicates rejected), Name = what analysts see, Fields = the typed inputs this case type collects (string / text / integer / float / boolean / date / enum, each with a label and optional required flag).

Verified live: Without at least one installed pack or a manually-created case type, the page says outright: “Install a capability pack that ships case types, or add one above.” Add every field you want Copilot or a decision table to reason over later — we only added denial_id/payer_name/denied_amount and Copilot correctly (and honestly) said it had no denial-reason data, because we hadn't captured that field. Add denial_reason_text, appeal_deadline_days, etc. for a richer live answer.

## 3 — Case settings: Trigger (this IS "create a case")

Cases → Settings → Triggers → New trigger. This is the mechanism — there is no manual “New case” button anywhere in the product; cases exist because either a pack materializes them or a trigger does. Fields: Name; Dataset name (as ingested) or an exact dataset URN; Row ID column (defaults to the first column); Severity; Due (hours); Worklist columns (comma-separated projection — what shows as Evidence on the case); Row conditions (column / eq·neq·contains·gt·gte·lt·lte / value — filters server-side before a case opens; no conditions = every ingested row opens a case).

Verified live — real gotcha: Match by dataset NAME for the real flow — a genuine first-time upload (the “new_dataset” path) populates the event's dataset_name correctly, so name-matching just works. We hit one edge case worth knowing: re-appending to an EXISTING dataset by its URN (deploy scripts and re-ingest tooling do this) does NOT populate dataset_name in that completion event — only dataset_urn. If you ever need to force a second ingestion into the same dataset for a rehearsal, match the trigger by the exact dataset URN instead of by name.

Verified live: Confirmed end-to-end: a trigger matching a 22-row denials file materialized 22 real cases within ~2 seconds of the ingestion completing (case-service log: “case trigger created cases … created: 22”), each with real Evidence from the trigger's projection columns, each Unassigned/high exactly as configured.

## 4 — Dashboards: a Semantic Model is required first

Confirmed live: Dashboards → Add chart shows “No semantic models available in this workspace — pick a semantic model to choose fields” when none exist. A dashboard cannot chart a raw dataset directly; author a Semantic Model first.

Data → Semantic Models → New model — name it, e.g. rcm_denials.

Add entity — name, pick the real Dataset from a dropdown (every dataset you've uploaded appears here), physical table auto-fills, set the primary-key column.

Auto-draft from datasets — reads the entity's real dataset schema and bootstraps the model (“Draft definition bootstrapped from dataset schemas”). In our run it correctly wired the entity/table/PK but left dimensions and measures empty — add those next.

Add dimension / Add measure — every column picker is populated live from the dataset's actual ingested schema (we saw claim_id, denial_id, payer_name, denied_amount, appeal_status, etc. — the real CSV headers, not a fixture). A measure needs a name, an aggregation (sum/avg/min/max/count/count_distinct/first), and — unless count — a column expression; an optional filter and a display format (currency/percent/number) are also available.

Submit for review — then a second user (four-eyes, same governance pattern as everywhere else on the platform) approves it from the model's page before charts can use it.

Dashboards → Add chart — pick the now-published model, a chart type, and field encodings; live preview updates as you configure it.

## 5 — Analyze the case with Copilot

Open a case the trigger created → Copilot (top right) → ask a real question, e.g. “Summarize this denial and recommend next steps for the appeal.” The answer is grounded on the case's actual Evidence fields — cites the real denied amount, real payer name, real appeal status — and is honest about any field it wasn't given (see the Case type note above).

# Appendix — Troubleshooting & reference

## Re-running the whole thing again

No teardown is required or recommended. Just pick a new DEMO_TENANT_SLUG and repeat Phase 2 — each slug is a fully independent tenant, so your previous run stays intact as a fallback if anything misbehaves live.

## If something looks broken after a boot

Blank / 403 pages everywhere: run deploy/local/doctor.sh HEAL=1 — this self-heals RBAC and case-search projections that didn't rebuild from Postgres.

New personas not appearing on the login page: you skipped deploy/local/restart_ui.sh after Phase 2 — run it now.

up.sh FATALs with “postgres not reachable”: see the box under Phase 1 — docker compose up -d directly, wait for Healthy, then up.sh --platform-only --skip-build.

Copilot says “the copilot didn't return a response”: you skipped Phase 1b (deploy/local/restart_agent_runtime.sh) — run it now, then retry in the UI. If that's not it, confirm ollama serve is actually running (curl http://localhost:11434/api/tags) and that the models finished pulling during Phase 1's preflight.

Want to fully stop everything: deploy/local/down.sh

## Command quick-reference

| Command | Purpose |
|---|---|
| deploy/local/up.sh --platform-only | Bring up the whole platform, no vertical demo data |
| deploy/local/up.sh --platform-only --skip-build | Same, reusing already-built binaries (fast retry) |
| deploy/local/doctor.sh [HEAL=1] | Health-check (and optionally self-heal) after a boot |
| deploy/local/restart_agent_runtime.sh | Required once per boot — enables Copilot for any non-base tenant |
| deploy/demo/wellstar_rcm_demo.py | Provision the wellstar-live demo tenant end-to-end |
| deploy/local/restart_ui.sh | Restart ui-web only, to pick up new dev-login personas |
| deploy/local/seed_claims_demo.py | Optional: seed the autonomous ML-engineer showcase |
| deploy/local/down.sh | Stop the whole local stack |
