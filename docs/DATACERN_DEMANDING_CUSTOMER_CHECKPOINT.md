# Checkpoint — production requirements through the most demanding customer's eyes

Date: 2026-08-04 · Method: every claim below is graded against the repository
and the recorded evidence trail (`DATACERN_STATUS_CHECKPOINT.md`, initiative
docs, CI runs), using the ledger's own vocabulary — **PROVEN** (exercised on
the real stack, recorded), **TESTED** (unit/integration green, never live),
**BUILT** (compiles, unproven), plus **MISSING**. Where this document and the
codebase disagree, the codebase is right.

## The customer this checkpoint simulates

A national health payer: 5M members, ~100k claims/day, 4 departments
(workspaces) with strict separation, Epic + Facets as systems of record,
200 concurrent users at peak, SOC 2 + HITRUST demanded before PHI moves,
99.9 % availability expectation, a named DR requirement (RPO ≤ 15 min,
RTO ≤ 4 h), and a procurement team that reads evidence, not brochures.
Every section below is a workflow this customer runs in week one and what
actually happens.

## 1 · Day-one workflows — what holds

These are the paths the customer exercises first, and they are the
platform's strongest ground. All were PROVEN on the real stack (CI run
30780099971, corroborated by 30777994816):

| Workflow | Verdict |
|---|---|
| Ingest a claims file → dataset → case triggers open cases | **PROVEN** (`make e2e` steps A–C; delta-trigger path now TESTED on top, removing the two recorded race bugs) |
| AI triage proposes → human approves → the row actually changes | **PROVEN** (`journey`: written for the exact silent-drop defect it now gates) |
| Realtime case streams: SKU gate, watermark pull, department isolation | **PROVEN** (`journey-streams`, incl. department B gets `[]` and 404s) |
| Learn flywheel: 24 corrections → retrain → four-eyes promote → score | **PROVEN** (`journey-learn`; self-approval rejected server-side) |
| Schema-driven intake forms; refusals write nothing | **PROVEN** (`journey-forms`) |
| Vertical pack install / drift / uninstall with honest tombstones | **PROVEN** once (`journey-packs` — one green run, after three real fixes) |
| The UI on the real stack | **43/65 PROVEN** on the first-ever live run; 4 failures were one cross-journey state leak (fix merged, not yet re-run); 18 tests (~28 %) remain hard-disabled |
| Cross-tenant isolation attack | **PROVEN 18/18** by the black-box probe — but across only 4 of 24 services; the 2026-08-02 extension has never re-run |

The governance spine — propose→approve, four-eyes, forged-grant rejection,
RLS everywhere, WORM audit — is the part of this platform a demanding
customer can already watch work end to end. That is rarer than it sounds.

## 2 · Week-one collisions — where this customer breaks it

Ordered by how soon they hit, each with the evidence pointer.

1. **200 concurrent users: nobody knows.** `load_test.py` exists and has
   never touched a running stack — zero p95/throughput/error-rate numbers
   for any surface (`production-readiness-stack-gated-handoff.md`).
   `WHAT_DATACERN_IS.md` says it plainly: "we do not know what happens with
   50 concurrent users."
2. **100k claims/day through one Kafka partition.** Partition key =
   `tenant_id` (MASTER rule 031): all of this customer's events serialize
   through a single partition, consumed one message at a time
   (scalability-audit RISK tier). A per-tenant throughput ceiling that no
   document currently states to the customer.
3. **Scheduled ingestion cannot scale.** `InProcessScheduler` is
   single-instance by design; ~9 of 33 deployables are pinned `replicas: 1`
   (double-fire/double-publish races named inline in `values.yaml`), and the
   HPA template is dead code — no values file ever sets `autoscale`.
4. **The read path is proven to ~100k rows, sold at millions.** 1M rows are
   PROVEN only for Iceberg commit (25 MB peak) and case reindex
   (13,187 cases/s) — both local, one run. Dataset browse's global
   `row_number()` window and the in-process pandas profiler are unaddressed
   RISK items at this customer's volumes.
5. **First `helm install` fails its own boot guard.** The chart ships
   `POSTGRES_*`/`KAFKA_BOOTSTRAP` while services read
   `DATABASE_URL`/`KAFKA_BROKERS` — a documented mismatch (`values.yaml`
   L26–30) never caught because the chart has never been installed anywhere.
   Every hardening feature (external secrets, ClickHouse HA, alert rules) is
   off by default; the EKS example leaves the API server open to 0.0.0.0/0.
6. **99.9 % availability, zero HA evidence.** ClickHouse HA is
   lint-verified IaC only; every dev-tier store runs `replicas: 1`; no DR
   drill, no restore test, no RPO/RTO, no incident-response plan — BRD 59
   WS4's three checkboxes are all empty. One of ten alert rules has ever
   fired, and alert *routing* has never been tested.
7. **SOC 2 / HITRUST: not started.** The scaffold is real (12 criteria:
   1 implemented, 8 partial, 3 gap; 25 evidence items open) but no
   observation window is open — a 6–12 month clock that starts only when
   started. No third-party pen test. No SAML.
8. **Epic connectivity is one slice old.** fhir-bridge is TESTED (36 unit
   tests incl. SMART RS384) and its `journey-fhir` evidence script exists —
   but it is not yet in CI, has never run against the live stack, and the
   whole feature currently sits reverted off main awaiting the re-land PR.
   FHIR-decode of bulk files is real; the connector transport half
   (`_since` incremental sync) remains explicitly unbuilt.
9. **Dashboards are demo-ware at e2e level.** The entire analytics domain —
   builder, cross-filter, drill-through-to-case, scheduled reports — has
   smoke-render coverage only. A payer's ops leadership lives in these.
10. **Leaving is harder than arriving.** Tenant delete flips status without
    purging state; no data-export-on-offboard, no verified erasure path.
    Billing is unit-tested against a fake Stripe; no live push has occurred.
    Procurement will ask about both before signing, not after.

## 3 · Structural findings a diligence reader will raise

- **No machine-generated evidence artifacts exist in the repo** — every
  execution claim is prose citing a CI run. Honest prose, but a diligence
  team wants retained reports (Playwright HTML, probe JSON, load CSVs).
- **The ledger itself drifted in three places** (corrected as of this
  checkpoint): the soaks *have* each run once locally (never in CI) — the
  restart soak PASS and the 1M-row numbers were recorded in initiative
  docs while the ledger said "never"; there are now 7 journeys, not 6; and
  `value-journeys.spec.ts` carried a stale "never executed" header despite
  having no skip markers on the 2026-08-03 run.
- **Forward-only migrations are policy (rule 060) while 56 `.down.sql`
  files exist**, with no destructive-migration lint and no expand/contract
  guideline across a 273-migration surface.
- **No edge rate limiter.** Every 429 in the system is a downstream
  concurrency cap or budget freeze; nothing throttles an abusive or
  misconfigured client at ingress.

## 4 · The acceptance gate — what must be true before this customer signs

In dependency order, smallest-first where leverage allows:

1. **Numbers or nothing:** run `load_test.py` against `make up` at 50/100/200
   VUs; record p95s; size the resource tiers from data. Run both soaks in CI
   by moving them ahead of the Playwright gate. *(days)*
2. **Install the chart once.** Fix the env-name mismatch, `helm install`
   into any cluster, and keep the rendered evidence. Turn external secrets,
   alert rules, and ClickHouse HA on by default in a new `values-prod.yaml`;
   delete the dead HPA guard or wire it. *(days)*
3. **Unpin the 9 `replicas: 1` services** (leader election / row locking —
   each fix is already named inline), and document the per-tenant Kafka
   partition ceiling honestly while designing past it. *(weeks)*
4. **Re-land the health-case branch** (delta triggers + fhir-bridge), wire
   `journey-fhir` into CI, un-fixme the agent-fleet journey, and unblock the
   demo journey's fixture. Coverage that has never executed is not coverage.
   *(days, mostly done on the branch)*
5. **DR drill + restore test + RPO/RTO on paper**, one alert-routing test to
   a real channel, and an incident-response one-pager. *(week)*
6. **Start SOC 2 now** — nothing else opens the regulated door, and the
   clock runs regardless. Commission the pen test in the same window.
   *(6–12 months, calendar-bound)*
7. **Close the analytics e2e hole** (dashboard build → cross-filter →
   drill-through journey) and the offboarding story (export + purge +
   erasure verification). *(weeks)*

## 5 · One-sentence verdict

For the workflows this platform was built around — governed agentic
decisioning over cases, with isolation and audit — a demanding customer
watches real evidence, not claims; for the *operational* envelope that same
customer assumes (concurrency, HA, DR, compliance, deployment), the honest
answer is that the platform has never been asked the question, and every
line of section 4 exists to change that.
