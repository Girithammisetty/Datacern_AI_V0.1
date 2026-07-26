# BRD 70 — Demo Sandbox & POC Mode

**Service:** identity-service + pack-service (tenant profiles), deploy tooling, ui-web · **Language:** Go/Py/TS · **Phase:** GTM-2 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`. Depends on BRD 66 (plans/trials), BRD 69 (POC success dashboard). Origin: `../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §6 B6/B7. Respects the no-dummy-data rule (`packs/PACK_AUTHORING_GUIDE.md`, 2026-07-22).

---

## 1. Overview

**Purpose.** Productize the existing demo machinery (`make demo-load PACK=…`, `deploy/local/seed_claims_demo.py`, `packs/demo.sh`, `packs/MULTITENANT_LOGINS.md`) into two first-class tenant profiles: **`demo` sandbox tenants** (synthetic data, resettable, cloneable per prospect, visibly watermarked) and **`poc` tenants** (time-boxed, success metrics captured at creation, live success dashboard, expiry + conversion flow). Regulated prospects cannot upload real data pre-contract — the sandbox is the aha-moment vehicle; POC mode attacks the industry's ~5% pilot→production conversion with the 90-day playbook already defined in the partner briefing (shadow → proposal → ROI report).

**No-dummy-data reconciliation.** The 2026-07-22 rule stands for **product** packs: packs ship zero seed data. Demo data lives in a separate, clearly-labeled **demo-profile seeding layer** (per-pack synthetic datasets under `deploy/demo/` lineage, applied only to `profile=demo` tenants). Structural enforcement, not policy: demo tenants are watermarked in the UI, excluded from billing export (BRD 67), and **non-convertible** — promotion to trial/active requires a fresh tenant (data does not migrate), so synthetic data can never leak into a production tenant.

**In scope.** Tenant `profile(standard|demo|poc)` on identity-service; demo lifecycle (create-from-template ≤10 min, reset-to-snapshot, clone-per-prospect, TTL auto-reap); per-pack demo seed bundles (separate from pack manifests) + seeding runner; UI watermark + demo-persona switcher; POC lifecycle (create with `success_criteria[]`, window, sponsor; live success dashboard scoping BRD 69 to the window; expiry via BRD 66 trial machinery; conversion checklist); operator APIs + minimal operator UI. Hosted-environment wiring (which cluster) is deploy config, not new services.

**Out of scope.** Public self-serve signup (demo/POC tenants are operator/partner-created in v1; self-serve is a later initiative on top of this substrate); marketing-site interactive tour; synthetic-data *generation* tooling beyond the curated per-pack bundles; production-data POCs (that's just a trial tenant, BRD 66).

## 2. Actors & user stories

Personas: **Sales/SE**, **Prospect** (invited user), **Platform Operator**, **POC sponsor** (customer exec), **Partner SE**.

- **US-1** As an SE, I want to clone a fresh claims sandbox for a prospect in minutes, pre-seeded and walkable end-to-end (worklist → copilot triage → approval → audit), so demos don't depend on my laptop.
- **US-2** As a Prospect, I want demo personas (admin/approver/analyst/auditor) one click apart, so I experience four-eyes from both sides.
- **US-3** As an SE, I want reset-to-snapshot after each demo, so the environment is always clean.
- **US-4** As a Platform Operator, I want demo tenants TTL-reaped and excluded from billing/metrics-of-record, so sandboxes never pollute commercial data.
- **US-5** As a POC sponsor, I want success criteria agreed at kickoff visible on a live dashboard through the POC, so the decision meeting reads results, not anecdotes.
- **US-6** As an SE, I want POC expiry to trigger the conversion checklist (results export, proposed plan, fresh-tenant provisioning), so momentum survives the end date.
- **US-7** As a Partner SE, I want to create demo tenants under my partner scope, so partner-led demos don't require Datacern staff.

## 3. Functional requirements

### Tenant profiles
- **DSP-FR-001 (Must)** `Tenant.profile ∈ {standard, demo, poc}` set at creation, immutable thereafter. Demo tenants: forced `plan=internal-demo` (BRD 66), `ttl_days` (default 14, operator-overridable), watermark flag in session claims.
- **DSP-FR-002 (Must)** Demo tenants are excluded from billing-period close (VMB-FR-020 skips `profile=demo`) and flagged in usage rollups (`profile` dim) so commercial reporting filters them.
- **DSP-FR-003 (Must)** Demo tenants cannot transition to `trial|active` (CPL state machine rejects); the conversion path is "provision fresh standard tenant" — enforced in the state machine, not convention.

### Demo lifecycle
- **DSP-FR-010 (Must)** `POST /demo-tenants {pack, template?}` → provisioning saga (existing 7-step) + demo-seed step: applies the pack's demo bundle (datasets, cases, memories, personas) through real APIs (the `seed_claims_demo.py` pattern generalized), completing ≤10 min p95.
- **DSP-FR-011 (Must)** Demo seed bundles live per pack under `deploy/demo/<pack>/` (curated synthetic data + persona set + walkthrough script reference), versioned, linted by `packctl` demo-lint (schema-validated against the pack's dataset contracts). Product pack manifests remain zero-seed (no-dummy-data rule intact).
- **DSP-FR-012 (Must)** `POST /demo-tenants/{id}/reset` restores the post-seed snapshot (implementation choice in design: re-run seed idempotently vs storage-level snapshot — must complete ≤5 min); `POST .../clone` creates a sibling from the same template with fresh persona credentials.
- **DSP-FR-013 (Must)** TTL reaper (leader-elected, idempotent) tears down expired demo tenants via the existing deprovision path; `demo.tenant_reaped.v1` audited.
- **DSP-FR-014 (Must)** UI: persistent "DEMO — synthetic data" watermark banner (from session claim, not tenant lookup); demo-persona switcher (the `MULTITENANT_LOGINS.md` cheat-sheet as a product surface, demo profile only).
- **DSP-FR-015 (Should)** Guided walkthrough overlay for the 5-minute demo script (worklist → triage → approve → learning loop → audit), content per pack from the demo bundle.

### POC mode
- **DSP-FR-020 (Must)** `POST /poc-tenants {pack?, window_days, sponsor, success_criteria[]}` where each criterion is `{key, description, metric_ref (BRD 69 metric or manual), target, direction}`. POC tenants are `profile=poc`, `commercial_state=trial` with `trial_ends_at = window end` (reuses CPL-FR-020..023 machinery: expiry, T-14/7/1 events, suspension).
- **DSP-FR-021 (Must)** POC success dashboard: BRD 69 value view scoped to the POC window with a criteria panel (live value vs target per criterion, manual criteria updatable by sponsor with audit); visible to sponsor role + SE.
- **DSP-FR-022 (Must)** On expiry/conversion: results export (`poc-report.v1`: criteria outcomes + value summary + assumptions), stored/checksummed like other exports; conversion follows DSP-FR-003 semantics if data was synthetic, or CPL convert if the POC ran on the customer's real data as a standard-profile trial (both paths explicit in the API).
- **DSP-FR-023 (Could)** Design-partner variant: `poc` tenant + early-access `feature` entitlements + feedback-tagged notifications channel.

## 4. Non-functional requirements

- **DSP-NFR-001** Demo create ≤10 min p95; reset ≤5 min p95; clone ≤10 min.
- **DSP-NFR-002** Demo/POC tenants are full RLS tenants (no shared-tenant shortcuts) — isolation identical to production tenants.
- **DSP-NFR-003** Synthetic-data leakage is structurally impossible: profile immutability + non-convertibility + billing exclusion are state-machine/enforcement-level, test-covered.
- **DSP-NFR-004** Demo bundles contain no real PII (lint-enforced deny-list + provenance note per bundle).

## 5. Acceptance criteria (selection)

- **AC-1** `POST /demo-tenants {pack: insurance-claims-payer}` → tenant walkable end-to-end (seeded worklist, copilot triage with real local LLM, approval inbox, audit trail) in ≤10 min; UI shows the demo watermark for every persona.
- **AC-2** Reset after mutating cases → environment matches post-seed snapshot; clone yields an independent sibling (mutations don't cross).
- **AC-3** Attempt `demo→trial` transition → rejected by state machine with stable error; billing close for the period contains no demo-tenant rows.
- **AC-4** TTL expiry → tenant reaped via deprovision saga, audited; re-running the reaper is a no-op.
- **AC-5** POC with criterion `{cost_per_decision, target ≤ $0.40}` → dashboard shows live value vs target through the window; at expiry a `poc-report.v1` export exists and the tenant follows CPL suspension semantics.
- **AC-6** `packctl demo-lint` fails a bundle whose dataset violates the pack's contract or trips the PII deny-list.
