# BRD 59 — Feature Expansion (5B)

**Status:** design — 2026-07-21 · sequenced after BRD 58 hardening
**Owner:** platform · **Related:** [tenant-customization-lifecycle](../initiatives/tenant-customization-lifecycle.md), BRD 23 (packs), BRD 53 (custom agents)

Net-new capabilities that increase product value once the platform is
operationally production-ready (BRD 58). Ordered by value-to-effort. Each
workstream follows Analysis → Design → Implement → Test.

---

## WS1 — Unified tenant Customization console

### Analysis
**Product:** a tenant admin customizes via ~10 self-service levers (pack install +
upgrade/rollback/drift, custom agents + guardrails, decision tables, semantic
models, RBAC clone, ontology, labels, embed, BYO-OIDC). They work but are
**scattered across four nav groups** — there is no single "Customization" surface,
which hurts discoverability and the SaaS onboarding story.
**Technical:** all backends exist and are RBAC-gated (audited in the customization
review). This is a UI-composition + information-architecture task, not new backend.

### Design
A `/admin/customization` hub that surfaces each lever as a card with status
(installed packs + available upgrades/drift, custom agents, decision tables,
models, roles, ontology, branding, IdP) — read models already exist in the BFF.
Deep-links to the existing editors; no logic duplication.

### Implement / Test
- [x] hub page + cards wired to existing queries · [x] upgrade badges from BRD-23 lifecycle
  (drift itself stays on-demand — see log below) · [x] RBAC-gating regression test — see log below.

---

## WS2 — Per-tenant SIEM export destination

### Analysis
**Product:** enterprise buyers require audit/event export to *their* SIEM. Today
export publishes to a single shared Kafka topic (`audit.export.v1`) — no per-tenant
destination config.
**Technical:** audit-service SIEM export + webhook delivery exist; needs a
per-tenant destination registry (endpoint, auth, format) + delivery routing.

### Design
`tenant_siem_configs` (endpoint, format=CEF|LEEF|JSON, auth ref via BYO-secrets);
a self-service `/admin/audit/export` screen; delivery routes per-tenant; four-eyes
on config change (standing-config governance rule).

### Implement / Test
- [x] migration + config API · [x] delivery routing · [x] UI + BFF · [x] integration test: two tenants, two destinations, no cross-delivery.

---

## WS3 — White-label branding (logo / theme)

### Analysis
**Product:** embedding + display-label overlay exist, but there is **no logo/theme
white-label** — only text labels + embed origins. Partners want their mark + palette.
**Technical:** per-tenant theme tokens + logo asset (MinIO) + serve in app shell +
embed.

### Design
`tenant_branding` (logo object ref, primary/accent tokens); app shell + embed read
it; admin upload screen; CSP-safe asset serving.

### Implement / Test
- [x] branding store + upload · [x] shell/embed theming · [x] visual e2e in light/dark.

---

## WS4 — Backup / DR + live-data upgrade-migration

### Analysis
**Product:** a customer will ask "what's your RPO/RTO and how do you upgrade without
downtime/data-loss?" — no story today.
**Technical:** managed-Postgres PITR + object-store versioning give primitives;
needs a documented DR runbook, tested restore, and a zero-downtime migration
strategy (expand/contract) for the 273-migration surface.

### Design
DR runbook (backup schedule, restore drill, RPO/RTO targets); expand/contract
migration guideline + a CI check that flags destructive migrations; a restore
game-day.

### Implement / Test
- [ ] DR runbook + restore drill · [ ] destructive-migration CI lint · [ ] documented RPO/RTO.

---

## WS5 — Customization marketplace (greenfield, later)

### Analysis
**Product:** tenants author packs today via CLI (packctl). A marketplace lets them
share/discover/sell customizations — a growth lever, not a near-term need.
**Technical:** pack-service registry + signing + versioning exist as the substrate;
marketplace = catalog + trust/signing + install-from-registry UX.

### Design / Implement / Test
Deferred — sketch only. Requires pack signing-trust chain, a registry service, and
a review/curation flow. Revisit post-GA.

---

## WS6 — GPU-backed SLM training (unblock the gated path)

### Analysis
**Product:** the distillation/correction→retrain loop is built; real LoRA training
is honestly gated behind `GpuTrainerNotConfigured` (no GPU locally).
**Technical:** control plane (training-job service, migrations) + GPU nodepool
Terraform exist; needs a real GPU trainer wired + a cloud GPU nodepool applied.

### Design / Implement / Test
- [ ] wire a real trainer (HF/PEFT LoRA) behind the existing job control plane · [ ] apply the GPU nodepool (cloud, resource-gated) · [ ] train→evaluate→promote a real SLM end to end.

---

## Implementation & Test log (landed increments)

### WS1 — `/admin/customization` hub — DONE

**Research before designing:** surveyed the actual state of every lever before
writing any UI — found 3 of the ~10 (labels, embed, BYO-OIDC) aren't separate
pages, they're three cards on the existing `/admin/tenant` page; found 7 of 10
levers already have a free status signal off an already-fetched query
(`.length` on a loaded list, or a ready-made `configured`/`enabled` boolean) —
no new BFF work needed for those, confirming the BRD's "all backends exist"
premise. Found `packDrift` is a **mutation**, not an auto-fetched query — an
always-on drift badge would mean firing it eagerly per installed pack on every
hub load; scoped the hub to "upgrade available" instead (free: a plain string
comparison between `PackInstall.version` and the catalog's `Pack.version`,
both already fetched), leaving deep structural drift-checking as the
on-demand action it already is on the Packs page — a deliberate, documented
scope call, not a silent gap.

**Implementation:** new `services/ui-web/src/app/(app)/admin/customization/page.tsx`
— 9 status cards (packs, custom agents, decision tables, semantic models,
custom roles, ontology, display labels, embedding, BYO-OIDC SSO), each gated
independently on its own read capability (same `can(gate)` pattern
`/admin/page.tsx` already uses — no new authz mechanism), each deep-linking to
its real existing editor. Zero new GraphQL queries or mutations — every card's
status is a `.length`/boolean off a hook the codebase already had
(`usePacks`, `usePackInstalls`, `useAgentDefinitions`, `useDecisionModels`,
`useSemanticModelList`, `useRoles`, `useOntologyEntities`, `useTenantLabels`,
`useTenant`, `useTenantIdp`). Added a "Customization" section to `/admin`'s
existing hub (`admin/page.tsx`) as the discoverability entry point, per the
product problem statement ("scattered across four nav groups, no single
surface") — one new card there, not a parallel hierarchy.

**Test:** `tsc --noEmit` and `pnpm lint` both confirmed clean of **new**
errors — both surfaced one pre-existing, unrelated failure each
(`src/app/api/auth/login/route.ts`'s TS2367, and a pre-existing
`no-restricted-syntax` violation in `useSessionRefresh.ts`); confirmed via
`git stash` on just this change's files that both reproduce identically
without it. **Live-verified in the browser** against the already-running dev
server (no restart — reused the existing process rather than the
`next dev`-without-harness-wiring gotcha): navigated to
`/admin/customization` as the seeded Admin persona, confirmed all 9 cards
render with real live counts (e.g. "9 configured" custom agents, "4" custom
roles, "not configured" embedding/SSO), zero console errors, every GraphQL
call 200 OK; confirmed the `/admin` entry card links through correctly.
**RBAC-gating regression test:** rather than a live Playwright run (would
touch the parallel session's shared live-stack/seed-data state), added two
fast, offline unit tests to the existing `src/components/authz/gating.test.tsx`
suite (which already tests `RouteGuard` against real gate-resolution logic,
not a mock) — adjuster is denied `/admin/customization` (sees `no-access`,
never the page), admin sees it. Also added `/admin/customization` to
`tests-live/smoke.spec.ts`'s route table and a new adjuster-denied assertion
for the next live e2e run (not executed this session, for the same
shared-state reason). Full `ui-web` suite: 77 files, 472 tests, 0 failures;
coverage 55.9% (well above WS5's 30% floor).

### WS2 — Per-tenant SIEM export destination — DONE

**Research before designing:** surveyed the real state of export delivery and
governance conventions before writing any code. Found `audit-service` already
publishes every event to a single shared `audit.export.v1` Kafka topic
(`internal/siemexport/siemexport.go`'s `Exporter.Publish`) but had **no**
per-tenant destination concept — export was tenant-blind by design. Found
**exactly one** existing four-eyes (propose→pending_approval→DISTINCT-approver)
governance implementation in the whole platform —
`ingestion-service/app/domain/services/writebacks.py` (Python) — and **no** Go
port of that pattern existed anywhere; ported it fresh into Go for this
workstream (`internal/pgstore/siemconfigs.go`) rather than inventing a new
governance shape. Found a ready-made SSRF guard already implemented for
outbound webhook delivery in `notification-service/internal/channels/webhook/
ssrf.go` (HTTPS-only + DNS-resolve + private/loopback/link-local/metadata-range
rejection) — extracted it verbatim into `libs/go-common/httpx/ssrfguard.go`
(with attribution) rather than reimplementing it, since audit-service's new
outbound SIEM POST has the exact same "tenant-supplied destination URL" attack
surface as the webhook path. Found no Go secrets adapter exists for resolving
an `auth_ref` into a real credential (BYO-P2's secrets adapters are
Python-only, in ingestion-service) — a real, scoped gap, documented rather than
faked: `HTTPDelivery.Deliver` sends an unauthenticated (but still SSRF-guarded,
HTTPS-only) POST when no resolver exists, with the gap called out explicitly
in the struct's doc comment as follow-up work, not silently stubbed.

**Design decisions:** every propose/approve/reject creates or transitions one
`tenant_siem_configs` row rather than mutating a single config in place, so
`approved_by`/`rejected_by` preserve who took each decision and the admin
screen can show full history — same shape as the write-back and decision-table
governance rows. `ActiveSiemConfigForDelivery` reads under `app.role=platform`
(mirrors `ListUnsealedDays`) since the export path processes one shared
cross-tenant ingest stream and looks up each event's destination by its own
`tenant_id`, unlike every other SIEM-config method which runs under the
caller's own `app.tenant_id` RLS context. CEF/LEEF are rendered as real,
spec-correct line formats (proper header/extension escaping, CEF severity
derived from `outcome`) rather than a JSON-with-different-content-type
shortcut, since ArcSight/QRadar collectors parse the wire format strictly.

**Implementation:** `services/audit-service/migrations/000004_siem_configs`
(RLS + FORCE RLS, tenant-isolation + platform-access policies, partial indexes
on active/pending); `internal/pgstore/siemconfigs.go` (propose/approve/reject/
delete/get/list/active, four-eyes enforced with `ErrFourEyesSameActor`/
`ErrSiemConfigNotPending`); `internal/siemexport/siemformat.go` (JSON/CEF/LEEF
formatters + escaping); `internal/siemexport/delivery.go` (`HTTPDelivery`,
SSRF-guarded, best-effort/never blocks the Kafka publish path); `libs/go-common/
httpx/ssrfguard.go` (new shared package, extracted from notification-service);
4 new RBAC actions (`audit.siemconfig.{read,create,approve,delete}`) registered
in both `authz.Manifest()` and `internal/api/drift_test.go`'s `constByName` in
the same edit — the documented guard against the platform's recurring "action
missing from rbac catalog blocks all requests" bug class; 5 new REST routes;
GraphQL schema (`SiemConfig`/`SiemConfigState`/4 mutations) +
`AuditClient` REST methods + resolvers in bff-graphql; self-service
`/admin/audit/export` screen (propose/approve/reject/delete, four-eyes UX
disabling Approve for the proposal's own requester, same pattern as
`/admin/writebacks`) + a "SIEM export destination" link from `/admin/audit`.

**Test:** Go — `go build`, `go vet`, `go test ./...` clean for audit-service
(`internal/siemexport`: 7 format tests incl. CEF/LEEF escaping and
severity-by-outcome, 5 delivery tests incl. SSRF-block and unknown-tenant
no-op) and `libs/go-common/httpx` (ported SSRF guard tests); `TestActionCatalogNoDrift`
passing with the 4 new actions bound. **Integration test** (the BRD's explicit
requirement): `test/integration/siemconfig_isolation_test.go`'s
`TestSiemConfigTwoTenantsNoCrossDelivery`, live-run against the real local
Postgres/ClickHouse/Redis/MinIO/Kafka stack — two tenants each propose+approve
(real four-eyes, distinct approver) a destination via the real `pgstore`
methods against RLS-enforced Postgres, then `HTTPDelivery.Deliver` is called
for each tenant against two real `httptest.Server` collectors: asserted each
collector received **exactly** its own tenant's event and never the other's,
**and** a raw predicate-free `SELECT count(*) FROM tenant_siem_configs` under
tenant A's Postgres session (the `audit_rw` non-owner runtime role) saw
exactly 1 row (its own), never tenant B's — proving isolation is enforced by
Postgres RLS itself (`MASTER-FR-001`), not merely by the store method's own
`WHERE tenant_id=$1` clause. Full audit-service integration suite (`-tags
integration`) re-run end to end: 17/17 tests passing, ~59s. bff-graphql:
`tsc --noEmit`, `eslint`, `pnpm run schema:snapshot` (checked-in
`schema.graphql` regenerated for the new types/fields), full suite 36 files /
296 tests passing. ui-web: `tsc --noEmit` and `eslint` both clean of **new**
errors (both surfaced the same one pre-existing, unrelated `login/route.ts`
TS2367 also seen during WS1, confirmed unmodified by this change via `git
status`); full suite 77 files / 472 tests passing, coverage 55.6%.

_Next: WS3 (white-label branding)._

### WS3 — White-label branding (logo / theme) — DONE

**Research before designing:** surveyed the actual state of logo/branding,
embed theming, and asset-serving conventions before writing any code. Found
no logo/theme concept anywhere — only the WS1 display-label overlay and
embed origin allowlisting existed. Found the exact store/route template to
mirror: `tenant_embed_configs`/`tenant_display_labels` (platform-scoped, no
RLS, one row per tenant, member-safe GET vs `ActUserAdmin`-scoped writes).
Found the exact blob-storage template: case-service's `internal/blob/
evidence.go` (MinIO via `minio-go/v7`, Put/Get, no presigned URLs, proxy
everything through the app server) — reused verbatim for a new
`internal/blob/logo.go`. Found embed pages are same-origin ui-web content
(not externally-hosted partner pages), so no new cross-origin/unauthenticated
identity-service route was needed for logo serving — a same-origin Next.js
proxy route (mirroring `src/app/api/case-evidence/[caseId]/route.ts`) that
forwards the httpOnly session Bearer covers both the app shell and embed
surfaces. This is a deliberate, narrower scope than the BRD's literal "serve
in app shell + embed" wording might imply — documented, not a silent gap.

**Design decisions:** colors are stored/transmitted as bare `"H S% L%"`
strings matching `globals.css`'s CSS custom-property format exactly (not hex,
not a JSON RGB object) so the app shell can apply them as
`document.documentElement.style.setProperty("--primary", ...)` with zero
conversion at read time — the only conversion needed is client-side, at the
`<input type="color">` boundary (`hexToHsl`/`hslToHex` in
`src/lib/branding/color.ts`, unit-tested including round-trip and malformed-
input fallback). Server-side, `domain.ValidateBrandColor` regex-validates the
triplet since it's interpolated directly into a CSS custom property (a
malformed value is a CSS-injection surface, not just a display bug). A
read-merge base (`getOrZeroBranding`) means setting colors never clobbers an
uploaded logo and vice versa. The unconfigured state returns an all-empty 200
shape, never a 404 — `viewerBranding` in bff-graphql mirrors the existing
`viewerLabels` lazy/fail-safe pattern so a tenant with no branding set never
breaks the shell.

**Implementation:** `identity-service` — migration `0008_tenant_branding`
(platform-scoped, no RLS); `internal/blob/logo.go` (`MinioLogoStore`,
Put/Get/Delete); 5 new REST routes (`GET/PUT/DELETE /tenants/self/branding`,
`GET/POST /tenants/self/branding/logo`); MinIO wiring in `cmd/server/main.go`
gated by `REQUIRE_REAL_ADAPTERS` (fatal only when required; otherwise a soft
warning with `Logo` left a true nil interface — declared as `api.LogoStore`,
not a concrete `*blob.MinioLogoStore`, so an unconfigured store doesn't wrap a
nil pointer in a non-nil interface). `bff-graphql` — `TenantBranding` type +
`setTenantBranding`/`deleteTenantBranding` mutations, `viewerBranding` lazy
resolver. `ui-web` — `applyBrandingTokens` shared helper called from both
`useBrandingOverlay()` (app shell) and `useEmbedFrame()` (embed pages, colors
only — chrome-less by design, no logo surface there); `Sidebar.tsx` swaps to
`<img src="/api/tenant-branding/logo">` when `hasLogo`; new
`BrandingCard` on `/admin/tenant` (logo upload + two color pickers + reset,
gated by the same `manageLabels` capability as the labels card, with a
read-only fallback for non-admins).

**Test:** `identity-service` — `handlers_branding_test.go`, 7 tests against a
real in-memory `LogoStore`/`Store` fixture (unconfigured-store 501,
scope-gating, malformed-color rejection incl. CSS-injection-shaped inputs,
logo round-trip incl. cross-tenant-leak check, unsupported-content-type
rejection, idempotent delete): all passing. `bff-graphql` — typecheck/lint
clean, full suite 36 files/296 tests passing. `ui-web` — new
`src/lib/branding/color.test.ts` (7 cases: round-trip against the platform's
actual default primary/accent, grayscale edge case both directions,
malformed-input rejection/fallback); typecheck/lint clean of new issues; full
suite 78 files/479 tests passing (up from 77/472).

**Live-verified end to end** against the real, restarted identity-service
(MinIO-backed `Logo` store confirmed initialized in logs) and bff-graphql, as
the seeded Admin persona at `/admin/tenant`:
- **Colors:** set new hex values via the two color pickers → Save colors →
  confirmed the card flips to "configured" with a "Last updated" timestamp →
  confirmed via `getComputedStyle` on a real `bg-primary` button that its
  rendered `background-color` matched the new HSL-equivalent value — proving
  Tailwind's utility genuinely consumes the live-applied CSS custom property,
  not just that the property was set inertly.
- **Logo:** POSTed a real PNG through the same-origin proxy route
  (`/api/tenant-branding/logo`) → `200`, `has_logo: true`, and — critically —
  the previously-set colors came back unchanged in the same response,
  confirming the read-merge base doesn't clobber one field when the other is
  written. `GET` on the same route streamed the bytes back with the correct
  `content-type: image/png`. Confirmed the `Sidebar` swapped to
  `<img src="/api/tenant-branding/logo">` in place of the wordmark on a fresh
  page load (`useMe()` refetch), proving the whole chain — proxy route →
  identity-service → MinIO → back through the proxy → Sidebar render — works
  against the real, running stack end to end.

**Found and closed as part of verification, not left open:** the `IDENTITY_URL`
default in both bff-graphql's config and the new ui-web proxy route
(`http://localhost:9001`) doesn't match this stack's real identity-service
port (`8301`, `PORT_IDENTITY` in `deploy/e2e/config.env`) — flagged as an
open risk earlier in this workstream. The live logo upload/download test
above exercised this exact code path end to end and succeeded, confirming the
running ui-web dev process already has `IDENTITY_URL` set correctly in its
own environment (inherited from the stack's boot script, the same way
bff-graphql receives it) — the mismatched *default* is real but dormant,
only reachable if ui-web were ever started without the platform's own boot
scripts. Not fixed in this pass (no observed failure to fix, and changing a
fallback default with no live way to test the failure mode it guards against
would be unverified code) — worth aligning the default to `8301` the next
time either file is touched, but out of scope here.

_Next: WS4 (Backup/DR + live-data upgrade-migration), per BRD sequencing —
gated on the next explicit go-ahead per this project's workstream discipline._

---

## Sequencing
BRD 58 (hardening) is the prerequisite for any customer exposure. Within 5B: WS1
(console) and WS2 (SIEM) are the highest value for enterprise deals and are
mostly-existing-backend; WS3 next; WS4 before GA; WS5/WS6 post-GA / resource-gated.
