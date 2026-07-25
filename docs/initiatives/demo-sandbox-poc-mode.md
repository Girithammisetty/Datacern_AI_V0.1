# Demo Sandbox & POC Mode

**Status:** design — 2026-07-25
**Commits:** — · **Related:** BRD 70 (`docs/brd/70_demo_sandbox_poc_mode_BRD.md`), BRD 66 (`docs/brd/66_commercial_plane_BRD.md`), BRD 69 (`docs/brd/69_value_roi_reporting_BRD.md`), no-dummy-data initiative (`docs/initiatives/deep-packs-no-dummy-data.md`), roadmap `docs/DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §6 B6/B7

---

## 1. Analysis

### 1a. Platform / product

Regulated prospects (payer claims, banking AML, healthcare RCM) cannot upload
real data before a signed contract — legal/compliance blocks it. Today the
only way to show the product is `make demo-load PACK=<pack>` on someone's
laptop against a local dev stack: it works, but it is a developer tool wearing
a sales hat. It has no hosted form, no TTL, no reset button an SE can press
mid-demo, no visible "this is synthetic" signal for the prospect, and nothing
stops a demo tenant from silently becoming a production tenant with fake data
baked in. The roadmap (`DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md`
§6 B6, line 148) puts a number on the pain: sandbox demos cut SE time ~30%
when self-service; today every demo consumes an engineer's laptop and
attention.

The second half of the problem is POC→production conversion. Industry
pilot→production conversion for this category runs ~5% (roadmap §6 B7, line
150). The partner briefing's answer is a 90-day playbook — shadow mode →
proposal mode → ROI report — but nothing today captures success criteria at
POC kickoff or gives the sponsor a live dashboard through the window, so the
decision meeting runs on anecdotes instead of the product's own instrumented
value story (which BRD 69 is separately building).

Both problems are made harder, not easier, by the 2026-07-22 no-dummy-data
rule (`packs/PACK_AUTHORING_GUIDE.md:3-13`): product packs now ship zero seed
data by design — no CSVs, no seeded case queue (see
`docs/initiatives/deep-packs-no-dummy-data.md`). That is correct for paying
tenants but it deletes the very machinery the old demo path leaned on (every
pack used to ship ~26-row seed CSVs and a 6-case queue). This initiative's
job is to put demo data back, but confined to a structurally separate layer
that can never leak into a product pack or a production tenant — the tension
the roadmap calls out explicitly (line 221: "resolved by profile separation
... enforcement should be structural").

Outcome once solved: an SE clones a fresh, walkable sandbox for a prospect in
minutes without touching a laptop; a prospect self-drives four personas
one click apart; a POC sponsor sees the agreed success metrics update live
through the window; and no synthetic byte or demo-tenant row ever appears in
a billing close, a usage rollup, or a converted production tenant.

### 1b. Technical

**What "demo machinery" means today, end-to-end.** `make demo-load
PACK=<pack>` (`Makefile:69-71`) calls `packs/demo.sh load <pack>`
(`packs/demo.sh:79-90`), which shells out to `packs/onboard_pack_tenant.py`
(`packs/onboard_pack_tenant.py:37-72`), a thin CLI wrapper over
`packs/install_packs_multitenant.py`. That script:

1. Provisions a tenant through identity-service's real API —
   `POST /api/v1/tenants` with `publish: true`
   (`packs/install_packs_multitenant.py:168-175`) — then polls
   `GET /api/v1/tenants/{id}/provisioning` until the 7-step saga
   (`services/identity-service/internal/domain/engine_steps.go:41-166`,
   `ProvisionSteps`) reports every step `succeeded`
   (`packs/install_packs_multitenant.py:176-186`).
2. Seeds rbac (`ensure_rbac_seeded`, `packs/install_packs_multitenant.py:191-206`)
   and bootstraps two real Admin members for four-eyes
   (`bootstrap_admins`, `:209-220`).
3. Installs the pack through pack-service over real Core APIs (per-pack
   dataset binding contracts, decision tables, roles, agent configs —
   the deep-pack v2.0.0 shape described in
   `docs/initiatives/deep-packs-no-dummy-data.md` §2).
4. Creates one login per pack role and merges them into ui-web's dev-login
   map, then documents the tenant in `packs/MULTITENANT_LOGINS.md`
   (a hand-maintained ops cheat sheet, not a product surface).

For the flagship claims vertical specifically, `deploy/local/seed_claims_demo.py`
is the richer, hand-tuned version of step 3+4: it drives real APIs to ingest
a claims CSV, author+publish a semantic model, build a dashboard, create 8
OPEN triage cases with realistic duplicate-invoice/high-value patterns
(`deploy/local/seed_claims_demo.py:59-76`), run the triage copilot so a
PENDING proposal sits in the approval inbox
(`:115-130`), and best-effort drive one retrain
(`:133-159`). It explicitly documents itself as "what an Admin would instead
do by hand through the product UI" (`:18-24`) — i.e., a hardcoded stand-in
for a human, not a reusable per-pack contract. `deploy/local/seed_platform.py`
is the underlying platform-only layer (tenant + 4 RBAC personas, no vertical
content, `:1-17`). `deploy/demo/wellstar_rcm_demo.py` is a third, independent
pattern one layer up: a bespoke, single-prospect (`wellstar-demo`) script
that provisions a tenant, uploads synthetic RCM CSVs *as tenant data* through
the real ingestion API (`:1-20`), installs `healthcare-provider-rcm`, and can
`--rehearse` a full governed decision arc. All three scripts are hand-written
Python, not a declarative bundle format — there is no `deploy/demo/<pack>/`
manifest schema today, only ad hoc CSVs plus a bespoke driver script per
prospect (`deploy/demo/wellstar-rcm/*.csv` + `deploy/demo/wellstar_rcm_data.py`
+ `deploy/demo/wellstar_rcm_demo.py`).

**Teardown — the honest gap.** Two different teardown paths exist today and
they are NOT the same mechanism:

- The *real* deprovision saga exists and is wired to the tenant state
  machine: `DELETE /tenants/{id}?mode=destroy`
  (`services/identity-service/internal/api/handlers_tenants.go:443-459`) calls
  `TenantService.Delete` (`services/identity-service/internal/domain/tenant_service.go:175-222`),
  which transitions `* → deleting`, and either runs the destroy workflow
  immediately (force / prior `provision_failed`) or schedules it after a
  7-day grace period (`DeletionGracePeriod`, `tenant_service.go:12`). A
  minute-interval ticker in `main.go` (`services/identity-service/cmd/server/main.go:390,398`)
  calls `RunScheduledDeletions` (`tenant_service.go:226-240`), which invokes
  `Engine.Deprovision` (`services/identity-service/internal/domain/provisioning.go:232-257`)
  — Terraform destroy → Keycloak realm delete → credential revocation → cell
  release (`engine_steps.go:170-215`), only flipping the tenant to `deleted`
  after Terraform destroy succeeds (`provisioning.go:249-256`, honoring BR-6).
  This path is real, tested, and state-machine-driven. **But it is not
  leader-elected** — `main.go:390` is a plain `time.NewTicker`, single-process;
  fine for one identity-service replica today, a gap for DSP-FR-013's
  "leader-elected" requirement once there is more than one replica.
- The teardown path `packs/demo.sh clean` and `make demo-clean` actually use
  is a *different*, ad hoc mechanism: `packs/cleanup_pack_tenants.py`. It
  never calls the deprovision saga at all — it resolves the tenant row
  directly in identity's Postgres (`resolve_tenant`,
  `packs/cleanup_pack_tenants.py:96-104`), then hand-deletes every
  `tenant_id`-keyed row across every service database by introspecting
  `information_schema` (`purge_postgres`, `:141-176`), purges Redis keys by
  substring scan (`purge_redis`, `:179-187`), best-effort deletes OpenSearch
  docs (`purge_opensearch`, `:190-201`), and removes dev-login entries
  (`purge_logins`, `:204-220`). Its own docstring is honest about the limits:
  "physical dataset files in MinIO and Iceberg tables ... are NOT
  garbage-collected" (`:16-18`) — real infra debris is left behind. This is a
  local-dev/CI harness tool (raw `psycopg`/`redis` connections to
  `localhost`), not something that could run against a hosted multi-cell
  deployment with real Terraform-provisioned infra per tenant. **There is no
  TTL reaper anywhere in the codebase today** — no scheduled job expires a
  demo tenant automatically; teardown is always operator-invoked.

**Tenant profile / commercial fields — do not exist yet.** `Tenant`
(`services/identity-service/internal/domain/tenant.go:65-86`) has no
`Profile`, `PlanKey`, `CommercialState`, or `TrialEndsAt` field. A
repo-wide search confirms BRD 66's `commercial_state`/`trial_ends_at`
vocabulary appears only in the two BRD files
(`docs/brd/66_commercial_plane_BRD.md`,
`docs/brd/70_demo_sandbox_poc_mode_BRD.md`) — it is not implemented anywhere
in Go, TypeScript, or GraphQL. This means BRD 70's profile field (DSP-FR-001)
and BRD 66's commercial fields (CPL-FR-020) are **both greenfield on the same
struct**; they should land together or in a coordinated order (§2 below
addresses sequencing).

**JWT claim surface.** The platform claim struct is
`services/identity-service/internal/domain/token.go:25-54` (`Claims`) — carries
`Subject, TenantID, Typ, Scopes, PlatformAdmin, SessionID, WorkspaceID, Embed,
Surface, FrameAncestors`, and standard registered claims. No `profile` or
watermark-shaped field exists. On the ui-web side, the parsed session shape
is `services/ui-web/src/lib/auth/session.ts` (`SessionClaims`: `sub, tenantId,
workspaceId, scopes, type, exp`) and the client-side context is
`services/ui-web/src/lib/session/SessionContext.tsx` (`SessionInfo` +
`useSession()`), provided by `SessionProvider` inside
`services/ui-web/src/components/shell/AppShell.tsx:110`. There is no
persistent app-shell banner component anywhere in ui-web today — the closest
analog is a budget-exhausted notice scoped to the Copilot drawer only
(`AppShell.tsx:83-85` threading `budgetExhausted` into
`services/ui-web/src/components/copilot/CopilotDrawer.tsx:120-123`). bff-graphql's
`Viewer` and `Tenant` GraphQL types (`schema.graphql:95-149`, `:517-540`)
expose `tenantId`, `roles`, `capabilities`, `tier`, `status` — nothing
profile- or commercial-state-shaped. A demo watermark banner is a clean
greenfield build on both ends, not a wire-up to something half-built.

**No-dummy-data rule — stated and enforced.** The rule is stated in
`packs/PACK_AUTHORING_GUIDE.md:3-13` (superseded-in-part banner) and in
`docs/initiatives/deep-packs-no-dummy-data.md:40-44` ("the platform must not
add dummy data ... as part of service packs"). Enforcement today is
**lint-warning only, not blocking**: `packs/packctl/lint.py:238-252`
(`_kind_specific`, `datasets` kind) emits `SEED_DATA_SHIPPED` (warning) when
a dataset entry carries `file`, and `NO_BINDING_CONTRACT` (warning) when a
file-less entry lacks `required_columns`. Neither is an `error` — `lint
--strict` (`packs/packctl/cli.py:36`) is the only way to make it block, and
nothing in CI is confirmed to run `--strict` by default from what this
research covered. This matters for BRD 70: DSP-FR-011's `packctl demo-lint`
must be a genuinely new, separate lint pass over `deploy/demo/<pack>/`
bundles (which by design *do* ship seed data — that's their entire purpose),
not a relaxation of the product-pack lint. The two must stay structurally
distinct so an author can never accidentally point a product pack's
`components.datasets` at a demo bundle's CSVs.

`packctl`'s CLI today has exactly three subcommands —`validate`, `lint`,
`install`(`packs/packctl/cli.py:39-76`) — all of which resolve a
`SUPPORTED_KINDS` tuple of 18 kinds owned by product-pack materialization
(`packs/packctl/manifest.py:34-59`). A `demo-lint` subcommand does not fit
naturally into `lint_pack`'s pack-directory assumptions (`lint.py:110-192`
assumes `pack.yaml` + `manifest.load_manifest`); it needs its own entry
point and its own manifest shape for `deploy/demo/<pack>/`, addressed in §2.

---

## 2. Architecture & Design

### 2.1 `Tenant.Profile` and non-convertibility

**Design.** Add `Profile TenantProfile` to `Tenant`
(`services/identity-service/internal/domain/tenant.go:65-86`), enum
`{standard, demo, poc}`, set once at `Create` time
(`tenant_service.go:46-97`) and never mutated by any subsequent handler —
there is deliberately no `PATCH` path for it (unlike `DisplayName`/`Quotas`/
`AutoUpgrade` in `PatchTenantRequest`, `tenant_service.go:251-255`, which the
patch handler already keeps as an explicit allow-list; `Profile` is simply
never added to that struct). Immutability is therefore enforced by *absence
from the mutable surface*, the same pattern the codebase already uses for
`ID`/`CreatedBy`.

Non-convertibility (DSP-FR-003: demo/poc cannot become `trial|active`) is a
different axis from `TenantStatus` (`tenant.go:12-44`, the
provisioning/lifecycle state machine) — BRD 66's `commercial_state` is the
axis that actually carries `trial`/`active`. The guard therefore belongs in
BRD 66's transition function, wherever `commercial_state` transitions are
validated (that function does not exist yet — see 1b). The design commits to:
a `CanTransitionCommercial(profile, from, to)` guard co-located with BRD 66's
state machine, called before any `commercial_state` write, checked in the
same place `tenantTransitions` is checked (`tenant.go:27-44` is the pattern to
mirror: a map-driven allow-list, not scattered `if` statements). Concretely:
`profile=demo|poc` tenants have `commercial_state` initialized to
`none`/`trial` at creation and the transition table simply never lists
`trial|none → active` as reachable for those profiles — the same "absent
transition ⇒ 409 CONFLICT" idiom `CanTransition` already gives free
(`tenant.go:36-44`). This makes the rule structural (a missing map entry, not
a runtime `if profile == "demo" { reject }` scattered across call sites) and
keeps BRD 66 and BRD 70 sharing one enforcement point instead of two.

**Sequencing dependency, stated plainly.** BRD 70 cannot land its
non-convertibility guard, billing exclusion, or `commercial_state=trial`
reuse for POC tenants (DSP-FR-020) before BRD 66's `plan_key`/
`commercial_state`/`trial_ends_at` fields and trial sweep exist on `Tenant`.
Slice 1 of this initiative (§3) can ship `Profile` + demo create/seed +
watermark entirely independent of BRD 66. Slice 2 (TTL reaper) does not need
BRD 66 either — a demo tenant's own `ttl_days` is a separate, simpler
countdown. Slice 3 (POC mode) is hard-blocked on BRD 66 landing first; it is
sequenced last for exactly that reason.

**Options weighed.**
- *Option A (chosen): `profile` as its own column/enum on `Tenant`, orthogonal
  to `TenantStatus` and to BRD 66's `commercial_state`.* Three independent
  small enums compose more simply than one combined state machine, and each
  BRD owns migrations to its own axis without touching the others' tables.
- *Option B: fold demo/poc into `TenantStatus` itself* (e.g. `demo_active`,
  `poc_active`). Rejected — `TenantStatus` is the provisioning/infra
  lifecycle (draft→provisioning→active→...); conflating a commercial/content
  dimension into it would double the transition table's size for orthogonal
  concerns and break every existing `CanTransition` call site's assumptions.
- *Option C: represent `profile` as a `plan_key` value under BRD 66 alone
  (e.g. `plan=internal-demo` already exists as a BRD 66 seeded plan name,
  per `66_commercial_plane_BRD.md:22`).* Rejected as the sole mechanism —
  DSP-FR-001 needs `profile` decidable *before* any plan/entitlement
  assignment exists (demo tenants may have no BRD 66 machinery wired yet,
  per the sequencing note above), and "plan" is a commercial/billing
  concept while "profile" gates content (seed bundles, lint, watermark) —
  conflating them would force every seeding/lint code path to depend on
  BRD 66 landing first. `plan=internal-demo` remains the *forced default
  plan* a demo-profile tenant is assigned once BRD 66 exists (DSP-FR-001
  says exactly this), not a replacement for the profile field.

### 2.2 Demo-seed bundle layout (`deploy/demo/<pack>/`)

**Design.** A bundle is a new top-level manifest, parallel to but distinct
from `pack.yaml`, so a demo bundle can never be mistaken for pack content by
`packctl validate|lint|install` (which only ever look inside
`packs/<pack-name>/`, per `manifest.py`'s existing path assumptions):

```
deploy/demo/<pack>/
  demo.yaml                 # manifest: demo_manifest: 1, pack: <pack-name>,
                             #   pack_version (pins the installed pack version),
                             #   version, provenance note (no-real-PII attestation)
  data/<dataset-identity>.csv   # one CSV per dataset the pack's binding
                             #   contracts declare (satisfies required_columns
                             #   from packs/<pack>/data/datasets.yaml)
  personas.yaml              # {email_local_part, role, display_name} list —
                             #   generalizes packs/MULTITENANT_LOGINS.md's
                             #   per-pack role rows into a seedable object
  cases.yaml                 # open-row seed cases: {dataset, row_pk,
                             #   severity, display_projection, note} —
                             #   same shape as packs/card-disputes/cases/
                             #   queue.yaml, but this is legal HERE (a demo
                             #   bundle), never inside a product pack
  walkthrough.yaml            # ordered steps {title, target_route, narration}
                             #   feeding DSP-FR-015's guided-overlay content
```

`demo.yaml` binds explicitly to `pack: <pack-name>` + `pack_version` (not
"whatever's currently installed") so a bundle is reproducible independent of
what the product pack has moved on to since — the same discipline
`dataset_bindings` already uses at pack-install time
(`docs/initiatives/deep-packs-no-dummy-data.md` §2, "Dataset binding
contract").

**Options weighed.**
- *Option A (chosen): bundles live under `deploy/demo/<pack>/`, versioned
  and lintable, separate tree from `packs/<pack>/`.* Keeps the "packs ship
  zero seed data" invariant physically true — nothing under `packs/` ever
  contains a demo CSV — and matches the precedent already set by
  `deploy/demo/wellstar-rcm/*.csv` (an existing, if ad hoc, sibling
  directory under the same `deploy/demo/` root).
  DSP-FR-011 names this path explicitly.
- *Option B: a `demo/` subdirectory inside each `packs/<pack>/` tree,
  excluded from the pack manifest.* Rejected — the physical proximity alone
  invites accidental inclusion (an author copy-pastes a `datasets:` entry
  with `file:` pointing one directory over) and defeats the intent of the
  no-dummy-data initiative's directory-level guarantee.
- *Option C: demo data stored as rows in a database/admin UI rather than
  files in git.* Rejected for v1 — git-versioned bundles get code review,
  diffability, and the same CI lint gate as packs for free; a DB-backed
  authoring UI is a reasonable v2 once there are enough packs/prospects to
  justify one (noted under Out of scope).

### 2.3 The seeding-runner: saga step vs operator job

**Decision: a provisioning-saga step, not a standalone operator job.**
DSP-FR-010 requires `POST /demo-tenants {pack, template?}` to complete
end-to-end ≤10 min p95 including seed content — i.e., seeding is not
optional post-processing, it is part of what "the tenant exists" means for a
demo profile. The existing 7-step engine (`engine_steps.go:41-166`,
`ProvisionSteps`) already has exactly the right shape for this: each step is
idempotent, individually retried with backoff
(`provisioning.go:163-194`), and resumable from the first non-succeeded step
on any resume (`provisioning.go:136-161`, `AC-3`). The design adds one
step, `SeedDemoContent`, inserted after `SeedDefaults` and before `Verify`
in `StepDeps.ProvisionSteps` (`engine_steps.go:113-164`), gated to run only
when `t.Profile == ProfileDemo` (a no-op `Run` returning `nil` immediately
otherwise — the same "idempotent re-run: already done" pattern
`AssignCell`'s `Run` already uses at `engine_steps.go:46-48`). The step's
`Run` loads `deploy/demo/<pack>/demo.yaml`, drives it through the same
generalization `seed_claims_demo.py` already proves works — real API calls
to ingestion/semantic/chart/case-service under the tenant's own owner
credentials, no direct DB writes — packaged as a reusable Go (or a
subprocess-invoked Python, see below) component rather than one script per
prospect.

This is a deliberate change from how demo tenants are built *today*
(`onboard_pack_tenant.py` runs pack-service install as a step separate from,
and after, tenant provisioning succeeds — see 1b). Folding seeding into the
saga makes partial failure visible and retryable the same way every other
provisioning step already is (`ProvisioningStatus`,
`tenant_service.go:243-248`, surfaces per-step status to callers) instead of
leaving a half-seeded tenant with no saga-tracked state, which is what
happens if `onboard_pack_tenant.py` dies partway through today.

**Why not an operator job (rejected).** An async operator/batch job
(triggered post-provisioning, tracked separately) was considered because it
would let seeding run longer without threatening the provisioning workflow's
retry budget. Rejected because: (a) DSP-FR-010's ≤10 min p95 is scoped to
the whole `POST /demo-tenants` call, so a detached job still has to be
awaited by *something* with the same latency budget — deferring it to a
second workflow only adds a hand-off boundary where failure state can be
lost; (b) the saga's compensation stack (`Engine.Abort`,
`provisioning.go:198-228`) already gives seeding a free "roll back cleanly if
a later step fails" story that a bolted-on job would have to reinvent; (c)
pack install itself already goes through pack-service's own real
install/plan machinery (`services/pack-service/app/domain/installer.py`,
per `deep-packs-no-dummy-data.md` §3) — the saga step's job is orchestration
(call pack-service install, then call the seeding API calls), not
reimplementing installation.

**Language boundary, honestly scoped.** The existing 7-step engine is Go;
`seed_claims_demo.py`'s API-driving logic is Python (reusing
`deploy/e2e/driver.py` helpers). Two sub-options for `SeedDemoContent`'s
`Run`:
- *(a) Go step that shells out to a packaged Python seeding runner* (a
  `packs/demo_seed_runner.py` generalized from `seed_claims_demo.py`'s
  patterns, parameterized by `demo.yaml` instead of hardcoded claims logic),
  with the Go step capturing exit code + stdout into the `ProvisioningStep`
  record's error field on failure.
- *(b) Full Go reimplementation of the API-driving logic.*
Chosen: **(a)**. The e2e driver machinery
(`deploy/e2e/driver.py`, `deploy/e2e/lib/common.py`) that
`seed_claims_demo.py` already leans on is Python and substantial; a Go
reimplementation duplicates real, working, already-tested logic for no
functional gain, and the saga step interface (`Step.Run func(ctx, *Tenant)
error`, `provisioning.go:41-43`) does not care what language does the work
as long as it is idempotent and returns an error. This does mean
identity-service's server process needs a sanctioned way to invoke a
sandboxed subprocess with network access to other services — a real
operational cost flagged explicitly, not hidden (see NFR discussion below).

### 2.4 Reset / clone: re-seed idempotent, not storage snapshot

**Decision: re-seed idempotently (Option A), not a storage-level snapshot
(Option B), for `reset`; `clone` is "provision a fresh demo tenant from the
same bundle."**

- *Option A — re-run the seeding step idempotently.* `POST
  /demo-tenants/{id}/reset` re-invokes `SeedDemoContent` (and, if the
  prospect mutated things the seeding step doesn't own — e.g. approved a
  proposal, created a new case — separately purges tenant-owned mutable
  rows first: cases created after seeding, proposal decisions, retrain
  artifacts). Every downstream call in `seed_claims_demo.py`'s pattern is
  already written idempotently ("skip if exists by name" — see
  `_find_model_by_name`/`_find_dashboard_by_name`/`_find_saved_query_by_name`,
  `seed_claims_demo.py:231-238, 257-263, 477-483`) specifically so repeated
  runs converge rather than duplicate. Reset ≤5 min p95 (DSP-FR-012) is
  achievable because most of the ≤10 min creation budget is infra
  provisioning (Terraform/Keycloak/DB schemas), which reset skips entirely
  — it only re-runs the content layer.
- *Option B — storage-level snapshot (e.g. Postgres schema snapshot/restore
  per tenant schema, or a `pg_dump`/`pg_restore` cycle scoped to
  `t.SchemaPrefix`).* Rejected for v1: the platform is one-Postgres-DB-
  per-service with RLS-scoped tenant rows (MASTER-FR-001,
  `00_MASTER_BRD.md:15`), not schema-per-tenant, so there is no single
  schema boundary to snapshot — a true storage snapshot would need to
  coordinate point-in-time state across every service's DB (identity,
  case, dataset, semantic, chart, query, ...) plus OpenSearch plus any
  MinIO/Iceberg objects the tenant's ingestion wrote, which is a
  distributed-snapshot problem this initiative should not take on to hit
  a ≤5 min reset SLA. Re-seed idempotently sidesteps this because it never
  needs a consistent point-in-time view — it converges the *current* state
  toward the seeded state through the same real APIs used to create it.

Trade-off acknowledged: idempotent re-seed only converges what the seeding
step itself manages (bundle content). It does not automatically undo every
possible prospect action (e.g. a persona who deleted a dashboard the bundle
created needs the seeding step to re-create it — fine, it does — but a
persona who uploaded an *extra* unrelated dataset needs an explicit purge
pass, not just re-seed). The design accepts this and scopes `reset` to purge
tenant-owned rows created after the last successful seed run (tracked via
`ProvisioningStep`'s existing `FinishedAt` timestamp for the `SeedDemoContent`
step) before re-seeding, rather than promising byte-for-byt snapshot parity.

`clone` (DSP-FR-012) is simpler: `POST /demo-tenants/{id}/clone` is
`TenantService.Create` + `Publish` against the same `pack`/`template`
inputs the source tenant was created with, with fresh persona credentials —
i.e., it is not a data copy of the source tenant at all, it is "provision
another one from the same recipe." This avoids ever needing cross-tenant
data copying (which RLS makes deliberately hard, MASTER-FR-001..004) and
guarantees siblings are truly independent (AC-2's "mutations don't cross"
falls out for free — they were never shared).

### 2.5 TTL reaper

**Design.** A new leader-elected scheduled sweep, structurally mirroring
BRD 66's described trial-expiry sweep (CPL-FR-022, "idempotent, leader-elected
like existing reapers") and BRD 67's month-end close job (VMB-FR-020,
"leader-elected") — both *describe* leader election as a pattern but, per
1b, the one sweep that actually exists today
(`RunScheduledDeletions`/`main.go:390-398`) is a plain single-process ticker,
not actually leader-elected. This initiative's reaper should not repeat that
gap: it needs real leader election (e.g. a Postgres advisory lock or a K8s
Lease, whichever pattern the platform standardizes on first — no such
pattern exists yet in this codebase, so this is a shared prerequisite worth
raising once, not re-solving per-BRD). Mechanically: a minute-or-coarser
sweep lists `profile=demo` tenants past `created_at + ttl_days`, and for each
calls exactly the same path a human operator's `DELETE
/tenants/{id}?mode=destroy&force=true` would — i.e., the *real* deprovision
saga (`TenantService.Delete` → `Engine.Deprovision`,
`tenant_service.go:187-210`), not `cleanup_pack_tenants.py`'s raw-SQL purge.
This is the one place this design deliberately does NOT generalize existing
demo tooling: `cleanup_pack_tenants.py` is a local-dev/CI harness (raw
`psycopg`/`redis` against `localhost`, explicit product-pack-tenant
allowlist guard at `cleanup_pack_tenants.py:107-113`) that leaves MinIO/
Iceberg debris by its own admission (`:16-18`); a hosted reaper tearing down
real per-tenant cloud infra must go through Terraform destroy or it leaks
infrastructure cost silently, which is precisely the kind of thing DSP-NFR-003
("structurally impossible" leakage) is trying to prevent on the *data* side
and should equally apply on the *infra* side. `demo.tenant_reaped.v1`
(DSP-FR-013) is emitted from the same outbox-pattern point
`EvTenantDeleted` already is (`provisioning.go:253-256`), just with an
additional demo-specific event alongside it.

### 2.6 Watermark claim flow

**Design.** Add `Profile string` (or a small `TenantProfile` claim, mirroring
`Embed`/`Surface`'s boolean+allowlist pattern) to
`services/identity-service/internal/domain/token.go:25-54`'s `Claims` struct,
populated at token-mint time from `Tenant.Profile` (already resident in the
issuing context — no extra DB round-trip per DSP-FR-014's "from session
claim, not tenant lookup"). Threaded through to ui-web exactly like every
other claim already is: `services/ui-web/src/lib/auth/session.ts`'s
`SessionClaims` interface gains `profile`, `parseClaims()` decodes it same as
`tenantId`/`scopes` today; `SessionContext.tsx`'s `SessionInfo` + `useSession()`
carry it into React. A new `DemoWatermarkBanner` component mounts inside
`AppShell.tsx`'s `ShellInner` between `TopBar` and `<main>`
(`AppShell.tsx:96-97`, the same insertion point the research identified as
the natural slot), rendering only when `session.profile === "demo"` — no
GraphQL round-trip needed for the banner itself, satisfying "not tenant
lookup." Where the demo persona switcher and other UI need richer tenant
detail (e.g. TTL countdown for an "expires in N days" sub-label), a new
`profile`/`demoMeta {ttlDaysRemaining}` field is added to bff-graphql's
`Viewer` type (`schema.graphql:95-149`) resolved from the same claim — this
is the one place a resolver is genuinely new plumbing, not a reuse of
existing fields (per the research: neither `Viewer` nor `Tenant` carry
anything profile-shaped today).

### 2.7 Demo-persona switcher

**Design.** Productizes the same information `packs/MULTITENANT_LOGINS.md`
hand-documents today (`packs/onboard_pack_tenant.py` already creates one
login per pack role and merges it into ui-web's dev-login personas map,
`services/ui-web/src/lib/auth/personas.ts:16-54` `resolveLogin`/
`DATACERN_PERSONAS`). The switcher is a demo-profile-only UI affordance
(gated the same way as the watermark, `session.profile === "demo"`) exposing
the bundle's `personas.yaml` (§2.2) as one-click "become this persona"
actions. Two implementation options:
- *(a) Real session-switch via short-lived scoped tokens* the switcher
  requests server-side (analogous to how embed tokens already scope a
  session via `Embed`/`Surface`/`WorkspaceID`, `token.go:38-47`) —
  no separate login flow, one click swaps the active persona's claims.
- *(b) Logout + dev-login redirect per persona* (closer to today's manual
  `personas.ts` flow, just automated).
Chosen: **(a)** for the shipped product surface — (b)'s logout round-trip
breaks the "one click apart" requirement (US-2) and is a worse experience
than embed tokens already prove is achievable for scoped re-authentication.
This needs identity-service to mint a persona-switch token scoped to the
target persona's own real user record (the same "must be a real,
assignable identity-service user" lesson `seed_platform.py:62-73` already
learned the hard way for case assignment) — i.e., persona switching is not
a UI-only trick, it needs a real per-persona identity behind each switcher
entry, which the seeding step (§2.3) must create as real invited users, not
synthetic strings.

### 2.8 `packctl demo-lint`

**Design.** A new `demo-lint` subcommand
(`packs/packctl/cli.py:39-76`'s `argparse` subparser list gains a fourth
entry) pointed at a `deploy/demo/<pack>/` bundle directory rather than a
`packs/<pack-name>/` directory — it needs its own manifest loader (a
`demo_manifest.py` sibling to `manifest.py`, since `load_manifest` assumes
`pack.yaml`'s shape and `SUPPORTED_KINDS`, `manifest.py:34-59`, which does
not include a bundle-only concept like `personas` or `walkthrough`). Two
check families, both blocking (`error`, not `warning` — deliberately
stricter than the current product-pack lint's advisory-only
`SEED_DATA_SHIPPED`/`NO_BINDING_CONTRACT`, per 1b's finding that those are
warnings today):
1. **Contract validation**: every CSV under `data/` satisfies the
   `required_columns` its target pack declares in
   `packs/<pack>/data/datasets.yaml` (reusing the same column-check logic
   `packs/packctl/client.py`'s `dataset_columns`/`bind_dataset` already
   implements for live installs, per `deep-packs-no-dummy-data.md` §3, just
   run offline against a CSV header instead of a live dataset-service call);
   every `cases.yaml` `row_pk` resolves to an actual row in the bundle's
   CSVs (mirroring `lint.py:222-234`'s existing `cases` kind check, reused
   rather than reinvented).
2. **PII deny-list** (DSP-NFR-004): a pattern-based scan (SSN-shaped
   digit-groups, email-shaped strings not matching the bundle's own
   fictional-domain convention, credit-card-shaped digit runs) over every
   CSV cell, plus a required `provenance` note in `demo.yaml` attesting the
   data is synthetic — same spirit as `PACK_AUTHORING_GUIDE.md`'s existing
   "no real PII... realistic but invented names" rule (`PACK_AUTHORING_GUIDE.md:29-30`),
   made mechanically checked here instead of author-honor-system only.

`AC-6` (BRD 70) requires this to fail on a contract violation or a PII hit —
both are designed as blocking errors, matching that acceptance criterion
literally (unlike the existing pack lint, where the closest analog is only
ever a warning today).

### 2.9 POC mode objects

**`success_criteria` schema** (DSP-FR-020): `{key, description, metric_ref,
target, direction}` per BRD 70 §3. `metric_ref` is a union — either a BRD 69
metric identifier (from ROI-FR's `value_assumptions`/metrics API, BRD 69 §3,
once built) or `manual` (sponsor-updated by hand, audited per DSP-FR-021).
This union is unavoidable at v1 because BRD 69's metrics API does not exist
yet either (only the BRD is written) — the schema is designed so a criterion
authored today against `manual` can be repointed to a real `metric_ref` once
BRD 69 ships, without a schema migration (the field already accepts either
shape).

**Dashboard scoping contract to BRD 69**: BRD 69 §2 US-6 already anticipates
this exact consumer ("scoped to the POC window with agreed success metrics
highlighted (BRD 70 consumes)", `69_value_roi_reporting_BRD.md:25`) — the
contract is BRD 69's metrics API accepting a `{from, to}` window (the POC's
`window_days` translated to absolute dates from `POST /poc-tenants`) plus a
criteria overlay panel that BRD 70 owns (rendering `target` vs BRD 69's
returned live value per criterion) rather than BRD 69 needing to know
anything about POC criteria itself. This keeps BRD 69 a general-purpose
value dashboard and BRD 70 the criteria-specific layer on top, matching BRD
69's own explicit scoping in its Out-of-scope section
(`69_value_roi_reporting_BRD.md:16`, "any pricing/billing math (BRD 67)" —
same separation-of-concerns instinct extends here).

**`poc-report.v1` export schema** (DSP-FR-022): `{tenant_id, window
{start, end}, criteria: [{key, target, direction, final_value,
outcome(met|missed|inconclusive), metric_source(brd69|manual)}],
value_summary (BRD 69's assumption-labeled figures, carried through
verbatim — never re-derived, to preserve BRD 69's "every derived figure
displays its inputs" honesty rule, `69_value_roi_reporting_BRD.md:12`),
assumptions_snapshot, generated_at, checksum}`. Stored/checksummed the same
way other audited exports already are per BRD 70 §3 (no existing export
storage path was located in this research pass to cite directly — flagged
as an integration point to confirm at implementation time, not assumed).

**Billing exclusion contract to BRD 67**: today VMB-FR-020's month-end close
(`67_value_metering_billing_export_BRD.md:49`) has no `profile` dimension at
all — "profile" and "demo" do not appear anywhere else in BRD 67's text.
DSP-FR-002 ("VMB-FR-020 skips `profile=demo`") is therefore a contract this
initiative must land *into* BRD 67's close job, not something BRD 67 already
supports: the close job's tenant enumeration needs a `WHERE profile !=
'demo'` (or equivalent) filter, and usage rollups need `profile` added as a
dimension so commercial reporting can filter it out explicitly rather than
relying on the close job's filter alone (defense in depth, matching
DSP-NFR-003's "structurally impossible... test-covered" bar). This is called
out as a two-BRD coordination point, not a design BRD 70 can complete
unilaterally — implementation must touch usage-service's rollup schema and
BRD 67's close job together.

### Out of scope (this design)

- Public self-serve demo signup (BRD 70 §Out of scope carries this already;
  this design does not revisit it).
- A DB-backed / admin-UI-authored demo bundle format (Option C in §2.2) —
  git-file bundles only for v1.
- Cross-region/cross-cell hosted demo routing (which cell a demo tenant
  lands in) — deploy config per BRD 70's own scoping, not a new service.
- Solving leader election generally for the platform — this design flags
  that no reaper in the codebase is actually leader-elected today (§2.5)
  but does not invent the platform-wide leader-election primitive; that is
  a shared prerequisite this initiative depends on rather than delivers.
- Byte-for-byte storage snapshot/restore for reset (Option B, §2.4) —
  explicitly rejected for v1, not merely deferred without reason.
- Synthetic-data *generation* tooling (BRD 70 §Out of scope) — bundles are
  curated/hand-authored, same as packs' own seed CSVs were before the
  no-dummy-data migration.

---

## 3. Implementation & Test

**Status: Slices 1 and 2 built and unit/API-tested; Go integration tier
written but not executed (no Docker in this environment); ui-web watermark
banner built and unit-tested; `packctl demo-lint` built and unit-tested
against both synthetic fixtures and the real shipped bundle; one live-stack
Playwright spec written and explicitly gated off (`test.skip`) pending a
credential prerequisite `tests-live/fixtures.ts` doesn't yet provide. Slice 3
(POC mode) is NOT started — confirmed still hard-blocked, see below.**

### Slice plan (unchanged from the design; slices 1-2 are this build)

- **Slice 1 — profile field + demo create/seed + watermark.** ✅ **Built.**
  `Tenant.Profile` (§2.1) + immutability; `POST /demo-tenants` (DSP-FR-010)
  wired into the existing provisioning saga via a new `SeedDemoContent` step
  (§2.3); `deploy/demo/<pack>/` bundle format + loader (§2.2) for one pack
  (`insurance-claims-payer`, chosen over the wellstar-rcm precedent — see
  "Bundle choice" below); watermark claim end-to-end (§2.6); `packctl
  demo-lint` (§2.8, AC-6).
- **Slice 2 — reset/clone/TTL.** ✅ **Built.** `POST .../reset` (idempotent
  re-seed, §2.4), `POST .../clone` (fresh sibling, §2.4), TTL reaper (§2.5)
  including a real leader-election adapter resolving the prerequisite the
  design flagged as missing.
- **Slice 3 — POC mode.** ❌ **Not started — confirmed still hard-blocked.**
  Re-verified against the current repo state before writing any code: BRD 66
  slice 1 (plan catalog, `commercial_state` guard table, `internal-demo` plan
  seed — `services/identity-service/README.md`'s "BRD 66 — Commercial plane"
  table) is shipped, but BRD 66 slice 2 (trial start/extend/convert, the
  T-14/T-7/T-1 threshold events, the leader-elected trial sweep) is **still
  not built** — `docs/initiatives/commercial-plane.md` §3 confirms "Slice
  2 — trials + sweep. ❌ Not started." DSP-FR-020's `POST /poc-tenants`
  needs exactly that machinery (`commercial_state=trial` + `trial_ends_at`
  reusing CPL-FR-020..023) to exist first, per §2.1's sequencing note. This
  slice is untouched: no `poc-tenants` route, no `success_criteria` schema,
  no `poc-report.v1` export, no BRD 67 billing-exclusion coordination.

### Files touched

**identity-service — domain** (new): `internal/domain/demo.go`
(`DemoBundle`/`DemoPersona`/`DemoCase`/`DemoDataset`, `DemoBundleLoader`/
`DemoSeedRunner` ports), `internal/domain/demo_service.go` (`DemoService`:
`Create`/`Reset`/`Clone`), `internal/domain/demo_reaper.go` (`DemoReaper`,
`LeaseChecker` port). **Edited**: `internal/domain/tenant.go` (`TenantProfile`
enum + `ValidTenantProfiles`; `Tenant.Profile`/`DemoPack`/`TTLDays` fields;
`commercialTransitionsStandard` vs `commercialTransitionsNonConvertible` —
`CanTransitionCommercial` now takes a `TenantProfile` param, DSP-FR-003),
`internal/domain/tenant_service.go` (`CreateTenantRequest` gains Go-only
`Profile`/`DemoPack`/`TTLDays` fields, `json:"-"` so the public `POST
/tenants` wire body can never set them — only `DemoService.Create` does),
`internal/domain/commercial_service.go` (`AssignPlan` skips the
none→active edge for non-convertible profiles instead of erroring — a demo
tenant's forced plan assignment is a silent no-op on `commercial_state`),
`internal/domain/store.go` (`TenantFilter.Profile`,
`TransitionTenantCommercial` gains a `profile` param), `internal/domain/
engine_steps.go` (new `SeedDemoContent` step — 8th step, inserted before
`Verify`; `StepDeps` gains `DemoBundles`/`DemoSeed`), `internal/domain/
events.go` (`demo.tenant_reaped.v1`/`demo.tenant_reset`/`demo.tenant_cloned`),
`internal/domain/token.go` (`Claims.Profile` + `profileClaim` helper, §2.6),
`internal/domain/token_oidc.go` (mints the `profile` claim from
`Tenant.Profile` at real-OIDC login).

**identity-service — store**: `internal/store/memory/memory.go` and
`internal/store/postgres/postgres.go` both updated for the new `Tenant`
columns/filter and the `TransitionTenantCommercial` signature change.
`migrations/0012_tenant_profile.{up,down}.sql` (new: `tenants.profile`
CHECK'd enum, `demo_pack`, `ttl_days`, a partial index for the reaper's
sweep query).

**identity-service — adapters** (new): `internal/adapters/demobundle/
loader.go` (`FSLoader`: real filesystem/YAML bundle parser),
`internal/adapters/demoseed/runner.go` (`SubprocessRunner`: shells out to
`packs/demo_seed_runner.py`, minting a real short-lived service token
in-process for it — §2.3's "operational cost flagged explicitly"),
`internal/adapters/leaderlease/lease.go` (`Lease`: Redis `SET NX PX` +
Lua-CAS leader election, mirroring `services/realtime-hub/internal/fanout/
lease.go` — confirmed real, as the task briefing stated, and reused as the
precedent §2.5 calls for).

**identity-service — API**: `internal/api/handlers_demo.go` (new:
`handleCreateDemoTenant`/`handleResetDemoTenant`/`handleCloneDemoTenant`),
`internal/api/server.go` (`Server.Demo` field; `POST /demo-tenants[/{id}/
reset|clone]` routes inside the existing `requireSuperAdmin` group — no new
action label, same gate as `POST /tenants`).

**identity-service — wiring**: `cmd/server/main.go` (`demobundle.FSLoader`/
`demoseed.SubprocessRunner`/`domain.DemoService`/`domain.DemoReaper`
construction; a 5-minute TTL-sweep ticker; `leaderlease.Lease` wired when
`REDIS_ADDR` is set, loud-warned single-replica otherwise — same
`REQUIRE_REAL_ADAPTERS` gate pattern as the denylist/projection adapters).

**identity-service — tests** (new): `internal/domain/demo_test.go` (9 unit
tests), `internal/domain/token_oidc_pertenant_test.go` (+1: profile-claim
propagation), `internal/adapters/demobundle/loader_test.go` (4 unit tests,
incl. one that validates the actual shipped bundle), `internal/api/
handlers_demo_test.go` (2 acceptance tests), `test/integration/demo_test.go`
(2 Testcontainers-Postgres tests, written/not run). **Edited** (mechanical,
8-step count): `internal/domain/commercial_test.go` (fixed the 2-arg→3-arg
`CanTransitionCommercial` call sites; added
`TestCommercialTransitionMatrix_NonConvertible`), `internal/domain/
provisioning_test.go`, `internal/api/acceptance_test.go`, `internal/api/
handlers_commercial_test.go` (plan-count assertion: the fixture now seeds
`internal-demo`, matching production), `internal/api/fixture_test.go` (wired
fake `DemoBundleLoader`/`DemoSeedRunner` + `Server.Demo` + the seeded
`internal-demo` plan into the shared acceptance-test fixture),
`test/integration/pg_test.go`.

**packs** (new): `packs/demo_seed_runner.py` (§2.3's generalized seeding
runner: real dataset ingestion, persona invitation, case-queue seeding —
see "Honest gaps" below for what it does NOT generalize),
`packs/packctl/demo_manifest.py` (bundle loader, Python side — deliberately
NOT `manifest.py` reused, per §2.2's "must never be mistaken for pack
content"), `packs/packctl/demo_lint.py` (the two blocking check families),
`packs/packctl/tests/test_demo_lint.py` (13 unit tests). **Edited**:
`packs/packctl/cli.py` (`demo-lint` subcommand, `--packs-root` override).

**deploy/demo/** (new): `insurance-claims-payer/{demo.yaml,personas.yaml,
cases.yaml,walkthrough.yaml,data/{payer_claims,payer_denials,payer_appeals,
prior_auth_requests}.csv}` — the one bundle DSP-FR-011 requires for slice 1.

**ui-web**: `src/lib/auth/session.ts` (`SessionClaims.profile` +
`parseClaims` decode), `src/lib/auth/personas.ts` (`Persona.profile`),
`src/lib/auth/keys.ts` (`DevClaims.profile`, threaded into the minted dev
JWT so the banner also renders under `AUTH_MODE=dev` without a real
identity-service login), `src/lib/auth/personas.test.ts` (+1 test),
`src/components/demo/DemoWatermarkBanner.{tsx,test.tsx}` (new: renders
purely from `session.profile === "demo"`, no GraphQL round-trip, no new
FEATURE_GATES entry or i18n key — self-contained per the task's stated
preference), `tests-live/demo-journeys.spec.ts` (new, written/skipped —
see "E2E" below).

**Outside this task's primary ownership list, touched anyway (flagged per
the task's instructions) — small, additive, necessary to complete the
watermark-claim plumbing end to end**: `src/lib/session/SessionContext.tsx`
(`SessionInfo.profile` field), `src/app/(app)/layout.tsx` (passes
`claims.profile` into `AppShell`'s session prop), `src/components/shell/
AppShell.tsx` (mounts `<DemoWatermarkBanner/>` between `TopBar` and
`<main>`, the exact insertion point §2.6 names), `src/app/api/auth/login/
route.ts` (passes a persona's optional `profile` through to
`mintUserToken`). None of these touch GraphQL schema, `FEATURE_GATES`, or
`src/lib/i18n/messages.ts` — the orchestrator should check them for
conflicts with the parallel BRD 69 session's admin/value + graphql-operations
work, but the diffs are each 1-4 lines and structurally unlikely to collide
(BRD 69 doesn't touch session claims or the app shell).
`packs/demo_seed_runner.py` is also technically outside the literal
`packs/packctl/**` grant (it lives directly under `packs/`) but is the exact
artifact §2.3 names by path.

**Bundle choice.** The design's slice-1 text says "reusing the richest
existing precedent" without naming one pack. Two candidates existed:
`wellstar_rcm_demo.py` (bespoke, single-prospect, hand-written driver script)
and the "deep pack v2.0.0" no-dummy-data packs (`insurance-claims-payer`,
`banking-aml`, `card-disputes`, `healthcare-provider-rcm`,
`chargeback-representment`). `insurance-claims-payer` was chosen: it already
declares dataset **binding contracts** (`packs/insurance-claims-payer/data/
datasets.yaml`) that a demo bundle's CSVs can be validated against
mechanically (exactly what `demo-lint`'s contract check needs), and its
`prior_auth_requests` dataset has a literal `pending` status value that maps
directly onto "OPEN case queue row" — a cleaner fit for §2.2's `cases.yaml`
than `payer_claims`' `denied`/`paid` binary. wellstar-rcm's bespoke script
has no dataset contract to lint against at all.

### Test commands + results

```
cd services/identity-service
go build ./...                                          → PASS
go vet ./... && go vet -tags integration ./...           → PASS (no findings)
make lint   # golangci-lint run --build-tags integration → environment error, NOT a code
            #   issue: the installed golangci-lint binary (go1.25) is older than the
            #   module's go1.26.5 toolchain and refuses to load config. Pre-existing,
            #   confirmed unrelated to this change (same failure on an untouched checkout).
go test ./internal/... ./migrations/... -count=1          → PASS, all packages ok
go test ./internal/... ./migrations/... -count=1 -v | grep -c '^--- PASS'
                                                            → 135 passing test functions
                                                              (0 failing, 0 broken by this change)
go test -tags integration -timeout 600s ./test/integration/...
                                                            → the `integration` package
            itself: ok, every test (incl. the 2 new demo ones) SKIPs cleanly with "Docker
            unavailable — skipping integration tier" (this sandbox has no Docker daemon:
            `docker info` → "dial unix /var/run/docker.sock: ... no such file or directory").
            The Makefile TARGET as a whole still exits non-zero because a SEPARATE,
            PRE-EXISTING subpackage (test/integration/secretsigner) panics instead of
            skipping when Docker is entirely absent (calls testcontainers'
            MustExtractDockerSocket directly, which panics rather than returning an error
            the way tcpg.Run does) — confirmed pre-existing and untouched by this change
            (same panic reproduces before any BRD 70 edit); not fixed here, out of scope.
            This is the SAME environment gap commercial-plane.md §3 already documented for
            BRD 66's own integration tier.

cd packs
python3 -m pytest packctl/tests/ -q                        → 36 passed (23 pre-existing +
                                                               13 new demo-lint tests, 0
                                                               failures, 0 broken)
python3 -m packctl.cli demo-lint ../deploy/demo/insurance-claims-payer
                                                            → "demo-lint insurance-claims-
                                                               payer@1.0.0: 0 error(s),
                                                               0 warning(s)" — AC-6's
                                                               positive case, run against
                                                               the ACTUAL shipped bundle.

cd services/ui-web
npx tsc --noEmit                                           → PASS, 0 errors
npx next lint                                               → PASS (2 pre-existing warnings
                                                               in files this change never
                                                               touched: decisions/page.tsx,
                                                               DatasetRowsGrid.tsx)
npx vitest run                                              → 81 test files, 501 tests
                                                               passed (5 new: 4 in
                                                               DemoWatermarkBanner.test.tsx,
                                                               1 added to personas.test.ts;
                                                               0 failures, 0 broken)
npx playwright test -c playwright.live.config.ts \
  tests-live/demo-journeys.spec.ts --list                   → parses cleanly, lists 2 tests
                                                               (both test.skip — see E2E below)
```

### Verified vs written-but-not-run vs deferred

- **Verified (executed, green):** `Tenant.Profile` immutability at the
  service layer (`TestTenantProfileImmutability` — Patch's full field
  surface cannot touch `Profile`; a plain `POST /tenants` defaults to
  `standard`); the non-convertibility guard exhaustively over every
  `(from,to)` pair for BOTH `demo` and `poc` profiles, plus the literal
  AC-3 assertions (`TestCommercialTransitionMatrix_NonConvertible`,
  `TestDemoTenantNonConvertible` — a demo tenant's forced plan assignment
  never moves `commercial_state` past `none`); `SeedDemoContent`'s profile
  gate (no-op for standard/poc, exactly-once `Seed` call for demo,
  `TestSeedDemoContent_GatedByProfile`); idempotent recovery from a
  transient seeding failure via the engine's own attempt/backoff loop
  (`TestSeedDemoContent_RetryAfterPartialFailureDoesNotDuplicate`) and a
  fail-loud unconfigured-adapter path
  (`TestSeedDemoContent_MissingAdapterFailsLoud`, CONVENTIONS.md's
  "no stub reachable from runtime"); the TTL reaper's sweep + AC-4 idempotent
  re-run + leader-election gate + "a standard tenant with no TTL is never
  swept" (`TestDemoReaper_*`, 2 tests); `Reset`/`Clone` at the domain layer
  (`TestDemoService_*`, 2 tests); the watermark claim minted at real-OIDC
  login for a demo tenant and OMITTED for a standard tenant
  (`TestOIDCLogin_CarriesDemoProfileClaim`); the full HTTP surface —
  `POST /demo-tenants` → 202 active with `plan.key=internal-demo` +
  `commercial_state=none`, `POST .../reset` (200, rejected on a standard
  tenant), `POST .../clone` (202, independent sibling id), and the
  `requireSuperAdmin` gate (`internal/api/handlers_demo_test.go`, 2 tests);
  the `FSLoader` against BOTH a synthetic fixture and the actual shipped
  `deploy/demo/insurance-claims-payer/` bundle (`TestFSLoader_
  LoadsTheShippedInsuranceClaimsPayerBundle` — if this bundle is ever
  broken, this test catches it, not just a lint pass); `packctl demo-lint`'s
  13 unit tests (contract violation, unresolved dataset ref, unresolved
  `row_pk`, missing provenance, SSN-shaped/credit-card-shaped/non-fictional-
  email PII, and the clean-bundle positive case) PLUS a direct CLI run
  against the real bundle (0 errors); the `DemoWatermarkBanner` renders
  only for `profile==="demo"` (not `undefined`, not `"standard"`, not
  `"poc"`) purely from the session claim, no network call
  (`DemoWatermarkBanner.test.tsx`, 4 tests); the dev-login persona
  `profile` field threads through `resolveLogin` (`personas.test.ts`).
- **Written but not executed (no Docker in this environment):**
  `TestDemoTenantSagaOnPostgres` (full provisioning saga incl.
  `SeedDemoContent` against real Postgres, profile round-trips through the
  new `tenants.profile`/`demo_pack`/`ttl_days` columns, a `profile=standard`
  sibling proves the no-op, and `UpdateTenant` never mutates `profile`) and
  `TestDemoTenantRLSIsolation` (DSP-NFR-002 literally — a demo tenant's own
  `users` rows get the identical RLS cross-tenant-404 + raw-SQL-invisibility
  treatment `TestRLSIsolation` already proves for standard tenants; the RLS
  policies themselves never branch on profile, so this demonstrates rather
  than merely asserts "no shortcut"). Both compile clean under
  `go vet -tags integration ./...` and auto-skip via the existing
  `requirePG` convention.
- **Deferred / explicitly out of slice 1-2 scope (per the task's scope, not
  a silent gap):** the demo-persona switcher (§2.7 — DSP-FR-014 bundles it
  with the watermark banner as one Must FR, but the task's slice-1
  description explicitly asked only for the watermark; the switcher needs
  real per-persona scoped-token minting on top of the real invited users
  `demo_seed_runner.py` already creates, which is real infrastructure this
  slice lays the groundwork for but does not finish); the guided-walkthrough
  overlay (DSP-FR-015, Should — `walkthrough.yaml` is authored and ships in
  the bundle per §2.2's format, but nothing in ui-web or the Go loader
  consumes it); semantic-model authoring, dashboard/chart creation,
  triage-copilot-driven PENDING proposals, and the best-effort retrain in
  `demo_seed_runner.py` — `seed_claims_demo.py`'s hardcoded claims-specific
  versions of these were NOT generalized into the bundle-driven contract
  (explicitly flagged in `demo_seed_runner.py`'s module docstring, not
  silently dropped); Slice 3 (POC mode) in full, confirmed still blocked
  above.

### Honest gaps (beyond the deferrals above)

- **The seeding runner's bearer-token scope is broad, not least-privilege,
  and UNVERIFIED against a live stack.** `demoseed.SubprocessRunner` mints
  a real, short-lived (5 min, `MASTER-FR-010`) service-typed token with a
  wildcard `["*"]` scope for `packs/demo_seed_runner.py` to drive
  ingestion-service/case-service/identity-service with — the SAME pattern
  `deploy/e2e`'s own harness already uses for its seed/admin operations
  (`c.user_token(MANAGER, TENANT, ["*"], ...)`), not an invented shortcut,
  but genuinely broader than the tightest per-call scope each downstream
  service would ideally check. Flagged in the adapter's own doc comment.
  Because no Docker/live stack is available in this build environment, this
  has never actually been exercised against real ingestion-service/
  case-service authz — it is a real, code-complete implementation, not a
  verified one.
- **Workspace resolution for the seeding runner is poll-based over rbac-
  service's public API, not proven live.** `demo_seed_runner.py`'s
  `resolve_default_workspace` mirrors identity-service's own
  `rbacclient.WorkspaceResolver.DefaultWorkspaceID` (same real HTTP call,
  same "best-effort, never block" contract) rather than the local e2e
  harness's direct-Postgres shortcut (which wouldn't work across service
  boundaries in a real deployment anyway) — but, again, unverified live.
- **`RunScheduledDeletions` (the pre-existing grace-period deletion sweep,
  `tenant_service.go`) remains a plain, non-leader-elected ticker.** This
  initiative's own new reaper (`DemoReaper`) IS real leader-elected; the
  design's §2.5 gap callout about the pre-existing sweep was about a
  DIFFERENT sweep this BRD does not own and does not fix here — noted so
  it isn't mistaken for having been addressed.
- **`poc-report.v1`'s "stored/checksummed like other audited exports"
  integration point** (§2.9) remains unconfirmed, as the design itself
  already flagged — moot for this build since slice 3 wasn't started, but
  restated here so it isn't lost before slice 3 begins.

### E2E

`services/ui-web/tests-live/demo-journeys.spec.ts` is written per this
document's test-plan description (create → poll to active → walk the
journey as all 4 seeded personas → assert the watermark → reset → mutate →
reset → reconverge) and parses/lists cleanly under Playwright, but both
tests are `test.skip`'d with an explicit reason: `tests-live/fixtures.ts`
has no super-admin/`platform.admin` credential helper today (every existing
live spec authenticates as a pre-seeded, non-admin `PERSONAS()` persona), and
`POST /demo-tenants` is `requireSuperAdmin`-gated by design (§In-scope,
"operator/partner-created in v1"). The spec documents exactly what that
helper needs to do (mirroring `hero-learning-loop.spec.ts`'s precedent of
calling a non-BFF service directly via an `E2E_LIVE_*_URL` env var) so it is
ready to enable once that prerequisite lands — not a placeholder. Per the
task's explicit instruction, the live stack was not booted or run.

### A note on git state

While this work was in progress, the environment auto-created intermediate
"wip" commits (`f8d15ae`, `b523ba1`) capturing snapshots of the in-flight
implementation shared with the concurrent BRD 69 session — these were not
`git commit` calls made by this agent (no commit was issued at any point in
this session; the task explicitly says not to commit). The same phenomenon
is independently documented in `docs/initiatives/commercial-plane.md` §3.
Flagging this again for the orchestrator's awareness since it affects what
"the diff" means when reviewing this change — the full BRD 70 slice 1-2 diff
is the union of those snapshot commits' BRD-70-scoped hunks plus the working
tree at hand-off.
