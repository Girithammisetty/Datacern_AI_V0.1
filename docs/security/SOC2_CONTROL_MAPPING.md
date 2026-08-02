# Datacern SOC 2 Control Mapping — readiness scaffold

**Status:** readiness map, **not** an attestation. SOC 2 is **not started** with an
auditor and **no observation window is open**. This document maps the 2017 Trust
Services Criteria to the controls **actually implemented in this repository**, each
cited to a real file, with an honest status — so a Vanta/Drata onboarding or an
auditor's readiness assessment starts from verified ground, not a wish list.

**This is not a SOC 2 report, a Statement of Applicability, or a third-party
attestation, and must not be represented as one.** SOC 2 remains the stated #1
revenue blocker (`docs/DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §B10).

- **Machine-readable source of truth:** [`soc2_control_register.yaml`](./soc2_control_register.yaml)
- **Validator (keeps every citation from rotting):** `tools/compliance/check_soc2_evidence.py`
- **Underlying code-verified controls:** [`SECURITY_POSTURE.md`](./SECURITY_POSTURE.md)
- **Collection checklist (what to gather next):** [`SOC2_EVIDENCE_CHECKLIST.md`](./SOC2_EVIDENCE_CHECKLIST.md)

> The register and this document are kept in sync by CI: every evidence path below
> is validated to exist. If a control moves, the validator turns red rather than
> letting the citation silently rot — the same discipline as
> `tools/docs/check_doc_facts.py` applied to compliance evidence.

## Readiness at a glance

| | Count |
|---|---|
| Criteria mapped | 12 (CC1–CC9 + A1, C1, PI1) |
| ✅ Implemented (technical control in code, cited) | 1 |
| 🟡 Partial (exists but scoped / missing policy or observation half) | 8 |
| ⛔ Gap (no implementation — typically organizational) | 3 |
| Distinct evidence items still to collect | 25 |

**Read this honestly:** the platform is **technically strong on access control and
processing integrity** and **organizationally empty** (no policies, risk program,
vendor management, or incident-response plan). SOC 2 is roughly half policy/process —
that half is unwritten. The gaps below are the real work, and none of it is faked to
look further along than it is.

## Status legend

- ✅ **Implemented** — a technical control exists in code/config and is cited to a file.
- 🟡 **Partial** — the control exists but is scoped, default-off, or missing its
  written-policy / operating-evidence half.
- ⛔ **Gap** — no implementation; typically an organizational control a codebase
  cannot provide (HR, board oversight, vendor management, formal policy).

---

## Common Criteria (CC1–CC9)

### CC1 — Control Environment ⛔ Gap
Integrity/ethics, board oversight, org structure, background checks — people-and-policy
controls a codebase cannot evidence. **None exist as artifacts here.**
**To collect:** code of conduct, org chart + security roles, background-check policy,
board/advisor security-oversight cadence. *(Owner: Founders / People ops)*

### CC2 — Communication & Information 🟡 Partial
Engineering-facing security information is documented and code-verified
(`docs/security/SECURITY_POSTURE.md`). Missing: a **public trust center + security
whitepaper** (GTM B10) and internal policy-acknowledgement records. *(Owner: Security / GTM)*

### CC3 — Risk Assessment ⛔ Gap
No formal risk-assessment process or risk register. Threat modeling exists informally
in code comments (e.g. the BYO-OIDC forged-`iss` model) but isn't a maintained artifact.
**To collect:** documented annual risk assessment + register, fraud-risk consideration.
*(Owner: Security)*

### CC4 — Monitoring Activities 🟡 Partial
Automated, **gating** security scanning runs on every PR + weekly, and an immutable
audit log records security events.
- `.github/workflows/security-scan.yml` — semgrep/gosec/bandit/trivy/gitleaks, gates merges at HIGH.
- `security/run_baseline_scan.sh` — local equivalent for pre-push.
- `services/audit-service/internal/api/handlers.go` — `handleSOC2Pack` evidence-pack endpoint.

Missing: a **continuous-controls-monitoring vendor** (Vanta/Drata) and periodic
management review. *(Owner: Security / Platform)*

### CC5 — Control Activities 🟡 Partial
Technology control activities are codified — RLS, OPA/RBAC authorization, four-eyes
proposals — but the **written policies** governing them are not documented.
- `services/usage-service/internal/api/middleware.go` — `RequireAction` (OPA authorize before proceeding).
- `services/case-service/migrations/000002_rls.up.sql` — FORCE RLS `tenant_isolation` (12+ services).

**To collect:** access-control policy, SDLC policy, data-handling policy. *(Owner: Security / Engineering)*

### CC6 — Logical & Physical Access Controls ✅ Implemented
The strongest area — technical access control is real and cross-verified.
- `services/case-service/migrations/000002_rls.up.sql` — **FORCE** RLS binds the table owner too.
- `services/usage-service/internal/store/pg.go` — `withTenant` pins `app.tenant_id` from the **verified JWT**, never request input.
- `services/usage-service/internal/api/middleware.go` — JWT verify + OPA authorize + audited denial.
- `services/identity-service/internal/domain/idp_config.go` — per-tenant BYO-OIDC, rejects non-HTTPS issuers (forged-`iss` safe).
- `services/rbac-service/internal/integration/opa_parity_test.go` — in-process authorizer and real OPA sidecar proven to agree.
- `deploy/terraform/aws/rds.tf`, `deploy/terraform/aws/s3.tf` — encryption at rest (KMS) in the AWS reference.

Physical controls **inherit from the cloud provider** — in a real report these are a
subservice organization with complementary user-entity controls (CUECs), not
Datacern's own controls. **Still missing:** SAML SSO (only OIDC today) and SCIM
provisioning (currently a `501` stub). *(Owner: Security / Platform)*

### CC7 — System Operations 🟡 Partial
Detection (CI scans, immutable audit chain with re-verification) and per-service
runbooks exist, including a documented **P1 audit-chain-integrity** procedure.
- `services/audit-service/RUNBOOK.md` — integrity-violation incident-response P1.
- `services/audit-service/internal/compliance/evidence.go` — re-verifies the SHA-256 chain + sealed WORM manifest.

Missing: a **company-wide security incident-response policy** (breach notification,
customer-comms SLAs, regulatory escalation). *(Owner: Security / Platform)*

### CC8 — Change Management 🟡 Partial
Changes flow through PRs with CI gates and versioned, forward-only migrations.
- `.github/workflows/security-scan.yml` — scans gate merges to `main`.
- `services/usage-service/migrations` — numbered forward/rollback migrations.

Missing: a written **change-management policy** and exported branch-protection /
required-review settings as evidence. *(Owner: Engineering)*

### CC9 — Risk Mitigation ⛔ Gap
No vendor/subprocessor risk-management process or BC/DR plan documented. HA building
blocks exist technically (see A1) but a BC/DR **program** does not.
**To collect:** subprocessor inventory + vendor-review process, BC/DR plan with
RTO/RPO, vendor DPAs/BAAs. *(Owner: Security / Legal)*

---

## Additional categories (in scope for Datacern's regulated posture)

### A1 — Availability 🟡 Partial
- `deploy/local/load_test.py` — concurrent-VU load harness (capacity evidence).
- `deploy/terraform/aws/rds.tf` — managed RDS (automated backups configurable).

Missing: tested backup/restore drills, RTO/RPO targets, monitored production SLOs.
*(Owner: Platform)*

### C1 — Confidentiality 🟡 Partial
- `services/case-service/migrations/000002_rls.up.sql` — tenant isolation on confidential data.
- `deploy/helm/datacern/values.yaml` — ingress TLS supported but **default-off** (operator must enable).

Missing: data-classification + retention/disposal policy; ingress TLS on by default.
*(Owner: Security / Platform)*

### PI1 — Processing Integrity 🟡 Partial
Strong technical integrity: four-eyes governed proposals (a **distinct** human
approves; no self-approval), an immutable SHA-256 audit chain with WORM export and
independent re-verification, and usage/billing reconciliation.
- `services/audit-service/internal/compliance/evidence.go` — proposer + distinct approver + chain proof.
- `services/audit-service/migrations/000002_rls.up.sql` — audit store tenant isolation.

Missing: a documented processing-integrity control narrative + data-quality monitoring
policy. *(Owner: Security / Engineering)*

---

## Recommended sequence (matches roadmap B10)

1. **Onboard a continuous-controls-monitoring tool** (Vanta/Drata) — it inventories,
   collects, and time-stamps the technical evidence above automatically and opens the
   Type II observation window. The strong CC6/PI1 controls make this the cheapest early win.
2. **Write the organizational policy set** — the CC1/CC3/CC9 gaps and the policy halves
   of CC5/CC7/CC8. These are documents, not code; use the tool's templates.
3. **Ship the public trust center** (CC2 / GTM B10) — security whitepaper, subprocessors,
   pen-test summary, SIG/CAIQ, BAA/DPA templates.
4. **Commission an independent penetration test** — the internal cross-tenant probe is a
   head start but is not third-party and covers only 4 of 20+ services
   (`SECURITY_POSTURE.md`).
5. **Close the default-off technical gaps** — ingress TLS on by default (C1), SCIM
   beyond the `501` stub, tested backup/restore drills (A1).

Everything in steps 2–4 is **organizational work outside this repository**; this
scaffold exists to make step 1 fast and to keep the technical evidence in steps 1/5
honest and non-rotting via the validator.
