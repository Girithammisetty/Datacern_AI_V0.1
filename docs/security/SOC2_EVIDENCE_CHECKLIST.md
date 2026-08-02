# Datacern SOC 2 Evidence Collection Checklist

**Status:** pre-audit readiness. SOC 2 is **not started**; no observation window is
open; no auditor engaged. This checklist is the operational companion to
[`SOC2_CONTROL_MAPPING.md`](./SOC2_CONTROL_MAPPING.md) and the machine-readable
[`soc2_control_register.yaml`](./soc2_control_register.yaml) — it lists **what evidence
to gather**, split into what the repository can already produce vs. what must be
**created outside the codebase**. Nothing here is a claim of compliance.

Two honest truths shape this list:
1. **The technical evidence is real and mostly automatable** — a monitoring tool
   (Vanta/Drata) can pull most of Part A on a schedule once connected.
2. **The organizational evidence does not exist yet** — Part B is documents and
   processes (policies, risk program, vendor management, IR plan) that a codebase
   cannot provide. This is the bulk of the remaining work.

> Keep this file in sync with the register. The validator
> (`python3 tools/compliance/check_soc2_evidence.py`) fails CI if any evidence path in
> the register stops existing — so Part A citations can't rot. Part B items are
> tracked here as `manual` and are never faked as present.

---

## Part A — Technical evidence (in-repo; automatable)

Each item is already produced by the codebase and cited in the register. An auditor
or a monitoring tool collects these directly.

### Access control (CC6) — ✅ strongest area
- [x] **Tenant isolation (FORCE RLS)** — `services/*/migrations/*_rls.up.sql` across 12+ services; boundary set from the verified JWT (`services/usage-service/internal/store/pg.go` `withTenant`).
- [x] **Authorization (OPA/RBAC)** — `RequireAction` gates every action (`services/usage-service/internal/api/middleware.go`); in-process vs sidecar parity proven (`services/rbac-service/internal/integration/opa_parity_test.go`).
- [x] **Authentication (JWT + BYO-OIDC)** — per-tenant OIDC, forged-`iss` safe (`services/identity-service/internal/domain/idp_config.go`).
- [x] **Encryption at rest** — RDS/S3/MSK KMS in the AWS reference (`deploy/terraform/aws/{rds,s3,msk}.tf`).
- [ ] **Cross-tenant probe run for ALL services** — currently covers only 4 of 20+ (`SECURITY_POSTURE.md`). *Expand coverage, then this becomes evidence-complete.*

### Monitoring & change management (CC4, CC8)
- [x] **CI security scanning** — `.github/workflows/security-scan.yml` (semgrep/gosec/bandit/trivy/gitleaks), gates merges at HIGH, weekly sweep; SARIF in the GitHub Security tab.
- [x] **Local baseline scan** — `security/run_baseline_scan.sh`.
- [x] **Controlled schema change** — numbered forward/rollback migrations (`services/*/migrations`).
- [ ] **Export branch-protection / required-review settings** — screenshot or API export of the repo's merge protections (evidence that review is *enforced*, not just customary).

### System operations & processing integrity (CC7, PI1)
- [x] **Immutable audit hash chain + WORM export** — `services/audit-service/internal/compliance/evidence.go` (SHA-256 chain + sealed Object-Lock manifest, independently re-verifiable).
- [x] **SOC 2 evidence-pack endpoint** — `services/audit-service/internal/api/handlers.go` `handleSOC2Pack` (tenant + range).
- [x] **Four-eyes governed decisions** — proposer + a *distinct* approver captured per decision.
- [x] **Audit-chain-integrity incident runbook** — `services/audit-service/RUNBOOK.md` (P1 procedure).

### Availability & confidentiality (A1, C1)
- [x] **Load/capacity harness** — `deploy/local/load_test.py` (self-testable).
- [x] **Confidential-data isolation** — tenant RLS on case/audit stores.
- [ ] **Ingress TLS on by default** — supported but ships `tls: []` (`deploy/helm/datacern/values.yaml`); enable by default.
- [ ] **Tested backup/restore drill** — record a restore from RDS automated backups with timing (RTO/RPO evidence).

---

## Part B — Organizational evidence (NOT in the codebase — must be created)

None of these exist in the repository today. They are the real remaining work and
roughly half of a SOC 2 report. Group them under a monitoring tool's policy templates.

### Governance & risk (CC1, CC3, CC9)
- [ ] Code of conduct / acceptable-use policy
- [ ] Org chart + defined security roles & responsibilities
- [ ] Background-check policy + records (HR)
- [ ] Board / advisor security-oversight cadence (meeting records)
- [ ] Annual **risk assessment** + maintained risk register
- [ ] Vendor/subprocessor inventory + security-review process
- [ ] Business-continuity + disaster-recovery plan (RTO/RPO), with a tested drill

### Policies (the written halves of CC5, CC7, CC8, C1)
- [ ] Access-control policy (provisioning/deprovisioning + periodic access review)
- [ ] Secure SDLC / change-management policy
- [ ] Data-classification + retention + secure-disposal policy
- [ ] **Security incident-response plan** — breach notification, customer-comms SLAs, regulatory escalation (today only per-service operational runbooks exist)
- [ ] Employee policy-acknowledgement records

### External attestations & customer-facing (CC2 / GTM B10)
- [ ] Independent **penetration test** (the internal cross-tenant probe is not third-party)
- [ ] Public **trust center**: security whitepaper, subprocessors list, pen-test summary, SIG/CAIQ answers
- [ ] BAA / DPA templates (promised in pack BRDs — write them)
- [ ] SAML SSO + working SCIM (currently OIDC only; SCIM is a `501` stub)

---

## Suggested first three moves

1. **Connect a continuous-controls-monitoring tool** (Vanta/Drata). It auto-collects
   most of Part A and **opens the Type II observation window** — the clock SOC 2 Type II
   requires. Datacern's strong CC6/PI1 posture makes this the cheapest early win.
2. **Draft the policy set from the tool's templates** — closes CC1/CC3/CC9 and the
   policy halves of CC5/CC7/CC8. Documents, not code.
3. **Commission an independent pen test** and **stand up the public trust center**.

When any real attestation, pen-test report, or third-party audit exists, it
**supersedes** this scaffold — this file and the register are a readiness aid, never a
substitute for the real thing.
