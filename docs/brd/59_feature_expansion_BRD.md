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
- [ ] migration + config API · [ ] delivery routing · [ ] UI + BFF · [ ] integration test: two tenants, two destinations, no cross-delivery.

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
- [ ] branding store + upload · [ ] shell/embed theming · [ ] visual e2e in light/dark.

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

_Next: WS2 (per-tenant SIEM export destination)._

---

## Sequencing
BRD 58 (hardening) is the prerequisite for any customer exposure. Within 5B: WS1
(console) and WS2 (SIEM) are the highest value for enterprise deals and are
mostly-existing-backend; WS3 next; WS4 before GA; WS5/WS6 post-GA / resource-gated.
