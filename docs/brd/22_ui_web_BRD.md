# BRD 22 — ui-web

**Service:** ui-web · **Stack:** Next.js (App Router) + React 19 + TypeScript, TanStack Query v5, Zustand, Tailwind + design tokens · **Phase:** 0–5 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`. Architecture: `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §11, §8.5; `../../WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.11 (feedback loop), §5.13 (EU AI Act Article 50). Domain mining source: `ui-core/` (V1 React SPA).

---

## 1. Overview

**Purpose.** ui-web is the single web frontend for the rebuilt platform: data management, ML building, insights/dashboards, case management, administration, and the cross-cutting agentic surfaces (copilot, approval inbox, traces, cost). It talks to bff-graphql for all request/response data and directly to realtime-hub for streams.

**Business value.** V1's ui-core is a React 16 SPA with structural performance and maintainability debt. This rebuild preserves its proven screen flows (mined below) while designing out its measured anti-patterns, and adds the agentic UX that V1 has no place for — including EU AI Act Article 50 labeling that becomes legally mandatory 2026-08-02.

**Anti-patterns inherited from ui-core that this BRD explicitly designs out** (verified in the V1 codebase): (1) `useInterval` polling hooks driving job/dataset status (`ido/show/DatasetInfo.tsx`, `ido/downloads/DatasetDownloads.tsx`) → SSE; (2) full-list normalized Redux stores via `record-store` (`core/recordStore.js`) + container components holding entire collections client-side → TanStack Query + cursor pagination; (3) client-side pagination of fully-fetched lists (`insights/dashboard/show/LocalPagination.tsx`) → server cursors; (4) no list virtualization anywhere → virtualized tables; (5) single webpack bundle per app (`webpack.common.js`, no route splitting) → per-module code splitting; (6) React 16 class containers + ducks → React 19 function components.

**In scope.** All module screens (§5), global UX standards, agentic surfaces, state-management rules, accessibility, i18n readiness, performance budgets, Playwright e2e suite. **Out of scope.** Native mobile apps; the V1 `provision` app (tenant provisioning becomes an `/admin` flow); embedded-analytics SDK for customers; offline mode; Slack approval surface (V2 of approval inbox).

## 2. Actors & user stories

Personas: **Data Engineer**, **Data Scientist**, **Analyst**, **Case Investigator**, **Workspace Owner**, **Tenant Admin**, **Approver** (any user with proposal-decision rights).

- **US-1** As a Data Engineer, I want to create a connection, upload a 10GB file with streaming progress, and watch ingestion status update live, so I never refresh or poll.
- **US-2** As a Data Engineer, I want dataset profile and lineage views that render instantly even for wide tables, so exploration is fluid.
- **US-3** As a Data Scientist, I want to build a training pipeline from the component catalog, launch it, and watch node-by-node run status stream in, so I catch failures immediately.
- **US-4** As a Data Scientist, I want to compare experiment runs (metrics, ROC, confusion matrix) side by side, so model selection is evidence-based.
- **US-5** As an Analyst, I want to compose charts from the semantic model and assemble dashboards with global filters and drilldowns, so insights ship without SQL.
- **US-6** As a Case Investigator, I want a virtualized, filterable case list over millions of cases with bulk assign/disposition, so triage scales.
- **US-7** As any user, I want a copilot drawer on every page that already knows what I'm looking at, so I can ask "why did this run fail?" in context.
- **US-8** As an Approver, I want an approval inbox showing each agent proposal as a diff with rationale and affected resources, and bulk approve for low-risk items, so oversight is fast and defensible.
- **US-9** As a Workspace Owner, I want a per-workspace AI cost panel with live budget state, so spend is visible before it's exhausted.
- **US-10** As any user, I want AI-generated content clearly and persistently labeled, and AI-authored artifacts to carry a provenance badge, so I always know when I'm interacting with or reading machine output (EU AI Act Art. 50).
- **US-11** As a Tenant Admin, I want user/group/workspace/RBAC administration screens, so access management is self-service.
- **US-12** As a Case Investigator using a screen reader, I want every workflow operable by keyboard with correct semantics, so the product is accessible (WCAG 2.1 AA).

## 3. Functional requirements

### Application shell & modules
- **UI-FR-001 (Must)** Next.js App Router with six route modules: `/data`, `/ml`, `/dashboards`, `/cases`, `/admin`, `/copilot`, plus `/inbox` (approval inbox) surfaced globally. Each module is an independent route group, code-split (own chunk graph); navigating module A never loads module B's code.
- **UI-FR-002 (Must)** Global shell: tenant/workspace switcher, module nav, notification tray (realtime-hub-fed), global search (URN/name), user menu, copilot toggle, approval-inbox badge with live pending count.
- **UI-FR-003 (Must)** All data via bff-graphql persisted operations; all streams via direct realtime-hub SSE/WebSocket using the user JWT (stream endpoints discovered via `StreamHandle` fields). **Zero REST calls to domain services from the browser.**
- **UI-FR-004 (Must)** Auth: OIDC code + PKCE against identity-service (Keycloak); silent refresh; route guards per RBAC permissions fetched once per session (`me` query) and cached; unauthorized routes render 404-equivalent (no existence leak).

### Global UX standards
- **UI-FR-010 (Must)** **Virtualized tables everywhere**: every table/list that can exceed 100 rows uses TanStack Virtual (windowed rows, sticky header, keyboard row navigation). No component may render an unbounded DOM list; CI lint blocks `.map` over query data into table rows outside the shared `<DataTable>` primitive.
- **UI-FR-011 (Must)** **Cursor pagination** on every collection: infinite scroll (tables) or "load more" (cards) driven by `pageInfo.nextCursor`; page size defaults 50. No offset pagination, no client-side pagination of a fully fetched list (kills V1 `LocalPagination` pattern).
- **UI-FR-012 (Must)** **SSE-driven status — no polling**: job/run/ingestion/agent statuses subscribe to realtime-hub topics and patch TanStack Query caches on events. `setInterval`/`setTimeout`-based refetch loops are banned by ESLint rule (`no-restricted-syntax` on interval-driven fetch); the only permitted timer usage is UI animation/debounce.
- **UI-FR-013 (Must)** **Optimistic updates** for low-risk mutations (rename, assign, tag, favorite, case status) with rollback on error; destructive or long-running mutations use explicit pending states instead.
- **UI-FR-014 (Must)** Standardized async states per view: skeleton loaders (list/detail variants), typed error panel (maps master error codes to user messages + trace_id + retry), and designed empty states with primary CTA (e.g., empty datasets → "Create connection"). No spinner-only screens; no raw error strings.
- **UI-FR-015 (Must)** WCAG 2.1 AA: full keyboard operability, focus management on route/dialog changes, ARIA per APG patterns, 4.5:1 contrast, visible focus, `prefers-reduced-motion` respected. Axe checks in CI on every Playwright page visit; violations fail the build.
- **UI-FR-016 (Must)** Dark mode: token-based theming (light/dark/system), user-persisted; every screen and chart palette supports both; charts meet contrast in both themes.
- **UI-FR-017 (Must)** i18n-ready: all user-visible strings through the message catalog (ICU MessageFormat via `next-intl` or equivalent), locale-aware dates/numbers, RTL-safe layout primitives. Ship `en` only; hardcoded JSX strings fail lint.
- **UI-FR-018 (Should)** Unsaved-changes guard on all editors (chart, pipeline, semantic form, admin forms); autosave drafts where the domain supports it.
- **UI-FR-019 (Must)** Shared primitive library (`packages/ui`) is the only way to build these patterns — screens may not hand-roll them:

| Primitive | Contract |
|---|---|
| `<DataTable>` | virtualization, cursor infinite-load, column prefs, selection, sticky header, ARIA grid |
| `<StatusChip>` | lifecycle states + SSE-live indicator + "updates paused" degradation |
| `<AsyncBoundary>` | skeleton/error/empty triad wired to query state; error panel with code map + trace_id |
| `<UrnLink>` | renders any URN as a typed deep link with icon + copy action |
| `<ProvenanceBadge>` | UI-FR-032; non-suppressible when provenance is non-null |
| `<AiLabel>` | UI-FR-031 Article 50 disclosure; central legal-reviewed copy |
| `<DiffView>` | JSON-aware semantic diff, side-by-side/unified, a11y annotations |
| `<ConfirmDialog>` | destructive-action confirmation with typed-name gate for irreversible ops |
| `<CronBuilder>`, `<DagCanvas>`, `<SqlEditor>` | lazy-loaded heavy editors (UI-FR-051) |

- **UI-FR-020 (Should)** Responsive: full support ≥ 1280px; functional read-and-approve experience 768–1280px (tables collapse to card lists, inbox and copilot fully usable); below 768px, read-only with a "best on desktop" notice. No horizontal page scroll at any width.

### Agentic surfaces (cross-cutting)
- **UI-FR-030 (Must)** **Copilot drawer** on every page: right-side drawer (resizable 360–640px, state in Zustand), opens with context = current resource URN (+ route metadata: module, screen, active filters) sent with the first message; token streaming from realtime-hub; renders citations (each a `<UrnLink>`), tool-call summaries (expandable to the trace visualizer), and suggested actions (deep-link or open proposals — a suggested write action always routes through the proposal flow, never executes directly from chat). Conversation is workspace-scoped and resumable; switching resource context offers "new thread here" vs "continue".
- **UI-FR-031 (Must)** **Persistent AI labels (EU AI Act Art. 50)**: the copilot drawer and any chat/generation surface carry an always-visible "AI" disclosure label (not dismissible, not hover-only) stating the user is interacting with an AI system; label copy is centrally managed for legal review. Streaming assistant messages are visually distinct from human/system content.
- **UI-FR-032 (Must)** **Provenance badge**: every artifact with non-null `provenance` (charts, dashboards, triage notes, pipeline configs, saved queries authored via agent) renders an "AI-generated" badge; clicking opens provenance details (agent, version, source run, approving user, timestamp) with a deep link to the agent-run trace. Badges appear in lists, detail headers, and exports.
- **UI-FR-033 (Must)** **Approval inbox** (`/inbox`): virtualized list of pending proposals (filter by agent, tool, risk tier, affected module, age); detail pane shows rationale, predicted effect, affected URNs, and an **args diff view** (side-by-side + unified toggle; JSON-aware semantic diff). Actions: approve, reject (reason mandatory — feeds eval datasets per V3 §5.11), edit-args (schema-validated form seeded with proposed args; edited diff is highlighted), respond (ask agent for clarification). **Bulk approve** only for proposals flagged low-risk tier, capped at 50 per action, with a confirmation summarizing counts by tool; destructive-tool proposals are excluded from bulk selection by construction.
- **UI-FR-034 (Must)** **Agent-run trace visualizer**: for any AgentRun, render the `trace` tool-call tree — collapsible hierarchy (agent → steps → tool calls → sub-agents), per-node status/duration/token cost, citations panel linking to source resources, and error nodes expanded by default. Virtualized for traces > 500 nodes; sharable deep link per span.
- **UI-FR-035 (Must)** **AI cost panel**: per-workspace panel (embedded in workspace home + `/admin/usage`): spend by meter over time, top consumers (user/agent/model), live budget states with threshold indicators (80/95/100), updated via `usage.events.v1` fan-out through realtime-hub — no polling. Budget-exhausted state renders a prominent banner on copilot surfaces in that scope.
- **UI-FR-036 (Should)** Feedback affordances on all AI outputs (thumbs + structured reason picker) wired to eval-service ingestion (V3 §5.11 flywheel).
- **UI-FR-037 (Should)** Per-agent kill-switch visibility: when an agent is disabled for the tenant, its surfaces render a disabled state with explanation rather than errors.

### Simple UX charter operationalization (MASTER-FR-090..099 concrete)

The FRs below turn each master charter rule into concrete screens and primitives. Every UI-FR-06x/07x maps 1:1 to a MASTER-FR-09x rule; the mapping is normative and enforced by the Simplicity Acceptance Suite (§SAS below).

**Chat as primary interface — MASTER-FR-090**
- **UI-FR-060 (Must)** Workspace home route `/` opens on a full-height **`CopilotHome`** conversational surface — a single input accepting NL questions, file drops (chunked upload path shared with `/data/upload`), URL paste (interpreted as a lookup), and pasted structured payloads. Configuration surfaces (`/data`, `/ml`, `/admin`) are secondary tabs on the workspace nav. A first-time user never lands on a config screen. Workspace picker + module nav are collapsible; `CopilotHome` expands to fill.
- **UI-FR-061 (Must)** `CopilotHome` state is durable per user + workspace: last N messages restored on return; "start new thread" is a single action. Uploaded artifacts stream into ingestion-service and land in the current chat as inline cards offering dataset creation via one CTA — no forced navigation.
- **UI-FR-062 (Must)** Every module screen carries the copilot drawer (§UI-FR-030) sharing Zustand thread state with `CopilotHome`; opening the drawer from any route surfaces the same active thread. Route context (current URN + filters) is attached to each drawer message per §UI-FR-030.

**Zero-config new-object flow — MASTER-FR-091**
- **UI-FR-063 (Must)** Every creation flow (connection, dataset, chart, dashboard, case, budget, agent recipe, pack install, workspace, service account) exposes a `<CreateForm>` with **≤ 3 required fields** at the top level (typically: name + primary input source + one policy choice). All other fields are defaulted from pack presets, workspace policy, or upstream service defaults. An "Advanced" chevron reveals the full schema and starts **collapsed**. CI lint audits every `<CreateForm>` — > 3 required top-level fields fails build with the form name.
- **UI-FR-064 (Must)** **Setup wizards are forbidden.** Onboarding, tenant provisioning surfaces, and new-workspace flows are replaced by one screen with sensible defaults + one Undo (§UI-FR-073). Multi-step flows are permitted only for genuinely branching choices (e.g., pipeline template selection with > 4 unrelated branches) and must offer a "Skip — I'll customize later" step landing on defaults.

**Progressive disclosure & expert mode — MASTER-FR-092**
- **UI-FR-065 (Must)** Detail screens default to a **Summary view** rendering **≤ 6 attributes** chosen per resource type (mined per BRD; documented in `packages/ui/summaryContracts.ts`). "More details" toggles to full schema; state persisted per user + resource type. An **Expert mode** toggle (`me.preferences.expertMode`, persisted via identity-service) reveals platform primitives site-wide: URNs, `sourceCallsCount`, JSON payloads, event ids, span attributes, `provenance` raw fields. Default: `false`. When off, URNs are hidden entirely from the DOM except when `?debug=1` is set.
- **UI-FR-066 (Should)** Expert mode is per-user, not per-workspace — synced across devices via identity-service. Toggling from a screen that has expert-only content triggers instant re-render without navigation.

**One primary CTA per screen — MASTER-FR-093**
- **UI-FR-067 (Must)** Every route renders exactly ONE **primary CTA** (design token `--action-primary`) with a domain verb label sourced from the pack's `display_labels` map via `<Label>` (§UI-FR-070). Secondary actions render as text/icon buttons. Equal-weight primary buttons on the same screen are a lint error (`<Button variant="primary">` count ≤ 1 per route render, enforced by react-lint rule). Empty states render one primary CTA + one link (e.g., "Install a claims pack →").
- **UI-FR-068 (Should)** List screens' primary CTA is the create action for that resource type, localized ("New claim" via pack labels, not "New case"). Detail screens' primary CTA is the next state-machine step (e.g., a `PENDING` proposal → "Approve"; an `IN_PROGRESS` case → "Resolve"). Absence of a primary CTA on any non-empty route is a lint error.

**Plain English via display_labels — MASTER-FR-094**
- **UI-FR-070 (Must)** All user-visible copy — labels, headers, empty-state text, error-panel titles, notification bodies, toast text — renders through the shared `<Label>` primitive (`packages/ui`) which fetches keys from the BFF `DisplayLabels` resolver (BRD 21 §BFF-FR-080..088). `<Label>` accepts `key` (semantic identifier like `case.singular`, `dashboard.action.publish`) and renders the workspace-scoped pack-provided string, falling back to the platform default. Hardcoded JSX strings not passing through `<Label>` or `next-intl` fail CI lint (extension of UI-FR-017).
- **UI-FR-071 (Must)** URNs are never rendered in default mode. `<UrnLink>` (§UI-FR-019) resolves URNs to a **human label** via `DisplayLabels` (`<kind>.singular` + object's `displayName` — see BFF-FR-081), rendering as `<Label>`. Expert mode reveals the URN as a small monospace subtitle under the human label.
- **UI-FR-072 (Should)** Terminology switches live: a `packInstallation.completed` / `pack.uninstall_completed` / `displayLabels.updated` event via realtime-hub triggers TanStack Query refetch of `displayLabels` and rewrites active labels **within 5s without page reload** (`EventBridge` patcher on `pack.*` topics).

**Undo & typed-confirmation — MASTER-FR-095, MASTER-FR-096**
- **UI-FR-073 (Must)** Reversible actions (delete, archive, install-pack, assign/unassign, status transitions, favorite toggle) surface an inline **Undo toast** (Sonner-style, `<UndoToast>` primitive) valid for **≥ 30s**, calling the domain service's compensating action (`restoreCase(id)`, `unarchiveDataset(id)`, etc.). Toasts stack; the last 3 visible; navigating away does NOT dismiss. Undo tokens persist to sessionStorage so a browser reload within 30s can still undo.
- **UI-FR-074 (Must)** Irreversible actions (purge uninstall, model deregistration, credential revocation, tenant deletion, hard delete) use `<ConfirmDialog>` (§UI-FR-019) with a **typed-name gate**: the user types the object's exact name to enable the confirm button (case-insensitive, whitespace-trimmed). A plain OK button on an irreversible action fails CI (`<ConfirmDialog typedName={false}>` on a route flagged `destructive` is a lint error). The list of destructive routes lives in `packages/ui/destructive-routes.ts` and requires code review to extend.
- **UI-FR-075 (Must)** **No modals for reversible actions.** Reversible decisions use inline chips, toggles, autosave. Autosave is the default for editors (chart, pipeline, semantic form, agent recipe, budget); an explicit "Save" button appears only when the step is transactional (submit-for-approval, publish, install). CI enumerates existing modals; new modals on non-destructive routes require an ADR.

**Cost + provenance inline — MASTER-FR-097**
- **UI-FR-076 (Must)** Every AI-touched surface renders a **`<DecisionFooter>`** primitive (new in `packages/ui`) as a small footer joining: `<ProvenanceBadge>` (§UI-FR-032 data) + `<CostChip>` (from `Query.decisionCost(urn)` federating usage-service `usage.get_decision_cost` — BRD 17 §USG-FR-083) + optional `<ConfidenceChip>` (from eval-service score if present). Presence is a **release blocker**: any AI-touched artifact rendered without a `<DecisionFooter>` fails the `ai-surface-audit` Playwright suite. AI-touched = artifact has non-null `provenance` OR was viewed after being served by ai-gateway (`x-windrose-request-class` observed in the fetching call chain, recorded via BFF response header).
- **UI-FR-077 (Should)** `<CostChip>` shows `$X.XX` in default mode (2-decimal USD, rounded up); hover expands to a card with model version, `input_tokens/output_tokens`, `cached`, `handler`, `savings_usd_est`, `sourceCallsCount`, and the list of contributing model calls with per-call cost. Expert mode surfaces the card inline (no hover required).
- **UI-FR-078 (Should)** Case detail and proposal detail additionally render `<RoiChip>` showing `total_value_usd / cost_usd_total` when both known; null value shows a subtle "value not set" chip inviting entry (calls `case-service` `PATCH /cases/:id/value_usd`). ROI is **never** used as a ranking key in default lists (prevents Goodhart's-law optimization pressure); may be used as an explicit sort in expert mode only.

**Search is navigation — MASTER-FR-099**
- **UI-FR-079 (Must)** Global **command palette** (Cmd/Ctrl-K, primitive `<CommandPalette>`) available on every route. Content sections in priority order: (a) recent items (`me.recentItems`, workspace-scoped), (b) NL-searchable objects via `Query.globalSearch(q, workspaceId)` (BFF federates over per-service search endpoints — case-service, dashboard-service, dataset-service, agent-registry, pack-service marketplace), (c) commands ("open", "assign to me", "share", "install pack", "create budget"), (d) navigation destinations. Results are server-side permission-filtered. Enter triggers the top-ranked action inline or opens the resource. Keyboard-only operable, screen-reader-labelled (WCAG AA, §UI-FR-015). Empty state offers "Ask copilot instead" — routes the query to `CopilotHome` with the text pre-filled.
- **UI-FR-080 (Should)** The palette exposes a "New…" subgroup listing all creation actions available in the current workspace (leveraging §UI-FR-063). "Cmd-K → 'new claim' → Enter" reaches creation in two keystrokes. Localized via `<Label>` — the pack terminology appears in the palette.

**Simplicity Acceptance Suite (SAS) — release gate**
- **UI-FR-090 (Must)** ui-web ships three Playwright suites implementing the master SAS journeys (MASTER-FR §Simplicity Acceptance Suite):
  - `sas-a-pack-install` — new tenant admin installs an insurance-claims pack from marketplace in ≤ 5 min.
  - `sas-b-first-case` — new tenant admin resolves their first case (created by the installed pack's ingestion recipe) in ≤ 5 min.
  - `sas-c-nl-chart` — new tenant admin publishes a chart from an NL question ("monthly claim severity by region") in ≤ 5 min.
- **UI-FR-091 (Must)** SAS runs in CI against a fresh cell + fresh tenant, with only tenant-provisioning credentials, and no documentation link opened (Playwright monitors external navigation). Each individual suite must complete under 5 min; the full journey (A+B+C) under 15 min. Failure is a P0 release blocker.
- **UI-FR-092 (Should)** SAS video artifacts stored per release; time-to-completion tracked as a KPI (`sas.p50_completion_seconds` per module) and shown on the platform's internal quality dashboard.

### State management rules
- **UI-FR-040 (Must)** **TanStack Query owns all server state.** Query keys namespaced `[module, resource, id|filters]`; normalized updates via `setQueryData` from SSE events; staleTime defaults 30s (list) / 5min (immutable artifacts). No server data may be copied into any global store.
- **UI-FR-041 (Must)** **Zustand only for UI state**: drawer/panel open state, table column prefs, editor draft state, selection sets. Stores are per-module, ≤ ~200 lines each; persisting to localStorage only for prefs. **No Redux, no full-list stores** (the V1 `record-store` pattern is banned by ADR; dependency addition of redux/mobx fails CI).
- **UI-FR-042 (Must)** Forms via React Hook Form + Zod schemas generated from GraphQL input types; validation messages localized.
- **UI-FR-043 (Must)** URL is the source of truth for shareable view state (filters, sort, selected tab, trace span) via typed search-param helpers; browser back/forward always works.
- **UI-FR-044 (Must)** SSE→cache patching is centralized: one `EventBridge` module maps realtime-hub topics to query-key patch functions (`{topic, match, apply}` registry). Screens never handle raw SSE events; adding a live surface = registering a patcher. Patch functions must be pure and covered by unit tests.
- **UI-FR-045 (Should)** Selection sets for bulk operations live in Zustand keyed by filter signature; changing the filter clears selection (prevents acting on rows the user can no longer see).
- **UI-FR-046 (Must)** GraphQL client uses persisted operations exclusively in production builds (hash manifest emitted at build, BRD 21 contract); dev builds may use ad-hoc documents.

### Performance
- **UI-FR-050 (Must)** Budgets, enforced in CI (Lighthouse CI + bundle-size gates) and monitored via RUM (web-vitals → OTel): **LCP < 2.5s** (p75, cold, dashboard and case-list routes), **route-change interaction < 300ms** (p75, soft nav), **initial JS ≤ 250KB gzip per route** (shared framework chunk counted once; per-route delta budget 150KB). Regressions > 5% block merge.
- **UI-FR-051 (Must)** Heavy libraries (chart engine, diff viewer, DAG editor, code editor) load lazily on first use; charts render into placeholders sized to prevent CLS (> 0.1 fails CI).
- **UI-FR-052 (Should)** Server Components for static shells and first-page list payloads where auth context permits; streaming SSR for dashboard shells.
- **UI-FR-053 (Must)** RUM: web-vitals (LCP/INP/CLS/TTFB) + route-change timing + SSE health reported per route to the OTel collector with `{tenant_id, route, release}` dimensions (no user content); client errors captured with componentStack + trace_id of the failing operation.
- **UI-FR-054 (Should)** Release safety: canary deploy (5% traffic) with automatic rollback on web-vitals or JS-error-rate regression; source maps uploaded per release for symbolication.

## 4. Domain model & data (client-side)

ui-web owns no backend database. Client-persisted state (adapting master §4): **localStorage** — theme, locale, table column prefs, dismissed hints (no tenant data); **sessionStorage** — OIDC state/nonce; **memory** — TanStack Query cache (cleared on tenant/workspace switch — hard requirement, prevents cross-workspace bleed), Zustand stores, SSE connection manager (single multiplexed realtime-hub connection per tab, topic-subscription refcounting). **State machines:** proposal card `pending → (approve|reject|edit|respond) → decided|responded` mirroring server; SSE connection `connecting → open → degraded(retry backoff 1s→30s, jittered) → open`, with cache invalidation-on-reconnect (refetch active queries) as the recovery guard; upload `selecting → chunk-uploading(n/m, resumable) → server-processing(SSE) → complete|failed`.

## 5. Screen specifications (adapted "API specification")

Screens mined from ui-core (V1 component named per screen) and extended for V2. Every list screen implies: virtualized table, cursor pagination, filter/sort synced to URL, bulk-select where actions exist, empty/error/skeleton states, SSE status where rows have lifecycle.

### `/data` (V1 `ido` module)
| Screen | Route | V1 source | Spec |
|---|---|---|---|
| Connections list | `/data/connections` | `ido/connections/index` | Table: name, type, status (SSE), last used; test-connection action; create button |
| Create connection | `/data/connections/new/:type` | `ido/connections/add`, `data-sourcing/db-connection` | Type gallery (JDBC/warehouse/object-store) → typed credential form (secrets write-only), test + save |
| File upload | `/data/upload` | `data-sourcing/UploadFile.tsx` | Chunked resumable upload (10GB, no browser memory buffering), per-chunk progress, server-side ingest progress via SSE |
| Ingestions list | `/data/ingestions` | `ido/batch-processing/index` | Runs with live status, schedule column; retry/cancel |
| Ingestion schedule | `/data/ingestions/schedule` | `batch-processing/schedule` | Cron-builder UI + preview of next runs |
| Datasets list | `/data/datasets` | `ido/index/DataSourcingIndex` | Search, tags, provenance badges; row → detail |
| Dataset detail — Overview | `/data/datasets/:id` | `ido/show/DatasetInfo` (V1 polled via `useInterval` — now SSE) | Schema, stats, versions (Iceberg snapshots), status |
| Dataset detail — Profile | `/data/datasets/:id/profile` | `ido/profiling/Profiling`, `SelectColumnsStep`, `RegeneratePopover` | Column-level profile viz (virtualized column list), regenerate (async op + SSE), column selection step |
| Dataset detail — Lineage | `/data/datasets/:id/lineage` | `ido/show/Linage.tsx` | Interactive lineage graph (URN nodes, depth expand), pan/zoom, keyboard navigable |
| Dataset detail — Query | `/data/datasets/:id/query` | `ido/show/DatasetQuery` | Embedded query editor scoped to dataset |
| Query editor | `/data/queries`, `/data/queries/:id` | `ido/show/DatasetQuery` (generalized) | Monaco SQL editor (lazy), schema tree, dry-run cost estimate, paginated streamed results (virtualized grid), save/verified-query flag |
| Data-prep pipeline builder | `/data/pipelines`, `…/new`, `…/:id` | `ido/pipeline/create/CreatePipeline`, `pipeline/show/PipelineInfo`+`PipelineRuns` | DAG canvas from component catalog (`component.json` metadata), param forms per node, validate → run; runs tab with live node statuses |
| Downloads/exports | `/data/exports` | `ido/downloads/DatasetDownloads` (V1 polled — now SSE) | Async export jobs, signed-URL downloads |

### `/ml` (V1 `model` module)
| Screen | Route | V1 source | Spec |
|---|---|---|---|
| Experiments list | `/ml/experiments` | `model/index/Experiments` | Filter by status/algorithm/owner; provenance badge on agent-created experiments |
| New experiment wizard | `/ml/experiments/new` | `new_experiment/*` (`UseCases`, `Algorithm`, `ChoosePipeline`, `ChoosePipelineConfig`, `Parameters`, `ExperimentForm`, `ShowPipeline`) | Steps: use case → algorithm → pipeline template (train/tune/CV variants) → parameters (schema-driven form) → dataset/split → review DAG → launch |
| Experiment detail / runs | `/ml/experiments/:id` | `model/show/ExperimentInfo`+`ExperimentRuns` | Runs table (live status), metrics sparkcolumns, promote-model action (Temporal approval flow) |
| Run inspector | `/ml/runs/:id` | `model/inspector/index` + chart wrappers (`ROCLineChartWrapper`, `ConfusionMatrixWrapper`, `TreeMapWrapper`, `GridChartWrapper`) | Metrics/params/artifacts tabs; ROC, confusion matrix, feature importance; notes (`ViewNote`/`AddTag`) |
| Run comparison | `/ml/runs/compare?ids=` | `model/inspector/compare` | 2–8 runs side by side: param diff table + overlaid metric charts |
| Model registry | `/ml/models` | `model/show/EditModelName` (promoted runs) | Registered models, versions, stage transitions with approval state |
| Inference jobs | `/ml/inference`, `…/new` | `model/inference`, `model/index/CreateInference` | Batch inference: model + dataset → job; output dataset link + lineage |

### `/dashboards` (V1 `insights` module)
| Screen | Route | V1 source | Spec |
|---|---|---|---|
| Dashboards list | `/dashboards` | `insights/dashboard/Dashboards` + `DashboardsTableHeader` | Cards/table toggle, favorites, provenance badges |
| Create dashboard | `/dashboards/new` | `CreateDashboard`, `CreateDashboardWithGlobalFilters` | Title, layout grid, global filter definitions |
| Dashboard view | `/dashboards/:id` | `dashboard/show/Dashboard` + `GlobalDashboardFilter` | Grid of charts (each independently loaded/cached, ETag-aware), global filters, drilldown (server-paginated — replaces V1 `LocalPagination`), investigate flow (`Investigate.tsx`) linking rows → case creation |
| Chart editor | `/dashboards/:id/charts/new`, `…/charts/:chartId/edit` | `ChartForm`, `CreateChart`, `EditChart`, `DataSection`, `DataSeriesSection`, `DrilldownSection`, `KeysRelationshipsSection` | Semantic-model-driven: pick measures/dimensions/filters (no raw SQL), series config, drilldown config, key relationships; live preview; column management (`ColumnManagementModal`) |
| Team reports | `/dashboards/reports` | `insights/teamreports/*` (`TeamReportList`, `TeamReportItem`, modals) | Scheduled report subscriptions per team |

### `/cases` (V1: embedded in `insights/dashboard/show` — `CaseSection`, `CaseForm`, `CaseFormModal`, `Investigate`; now a first-class module over case-service)
| Screen | Route | Spec |
|---|---|---|
| Case list | `/cases` | OpenSearch-backed: virtualized table over millions of rows, saved filters, full-text search, severity/status/assignee facets, live updates via SSE |
| Case detail | `/cases/:id` | Row-reference data panel (fetch-on-view), timeline (audit-fed), disposition form (V1 `CaseForm`), linked dataset/chart context, proposals tab (triage-copilot suggestions with provenance), SLA timer chip |
| Bulk operations | `/cases` selection mode | Bulk assign/disposition/status across filtered selection (server-side bulk endpoint, batched, progress via SSE); cap + confirmation summary |
| Case creation from investigation | modal from dashboards | V1 `Investigate` flow: selected rows → case with row references |

### `/admin` (V1 `config` module + `archive` + provision app)
| Screen | Route | V1 source | Spec |
|---|---|---|---|
| Users | `/admin/users`, `…/new` | `config/users/Users`, `CreateUser` | List, invite, deactivate; role summary per user |
| Groups | `/admin/groups` | `config/groups/content`, `groups/permission`, `config/assign-groups` | Group CRUD, permission matrix editor, content grants, user assignment |
| Teams | `/admin/teams` | `config/teams/*` (`Teams`, `create`, `assign`) | Team CRUD + membership |
| Workspaces | `/admin/workspaces` | `config/workspace/*` (`Workspace`, `create`, `custom-fields`) | Workspace CRUD, custom fields, member roles |
| Service accounts & agent principals | `/admin/service-accounts` | `config/service-accounts/*` (`ServiceAccounts`, `ServiceInfo`, `EndpointsTable`, `VisibilityKey`) | SA CRUD, endpoint visibility, key display-once; extended with agent principals + per-agent kill switch |
| Tenant settings | `/admin/tenant` | `config/TenantHeader`, `TenantRouter` | Tenant profile, provisioning status (from V1 `provision` app), isolation tier |
| Usage & budgets | `/admin/usage` | new | Cost panel (UI-FR-035) + budget CRUD + rate-card view (read) |
| Audit search | `/admin/audit` | new | Admin search over audit-service (actor, agent, URN, range), dual-attribution view, export |
| Archive | `/admin/archive` | `archive/Archive` | Soft-deleted resources, restore |

### `/copilot` + `/inbox` + global surfaces
| Screen | Route | Spec |
|---|---|---|
| Copilot full page | `/copilot` | Full-height chat with thread history, workspace context picker, AI label (UI-FR-031), citations, feedback controls |
| Copilot drawer | overlay, all routes | UI-FR-030; persistent AI label; suggested actions → proposals only (BR-13) |
| Approval inbox | `/inbox` | UI-FR-033; global badge count in shell (SSE-fed) |
| Agent runs | `/copilot/runs`, `…/runs/:id` | Run list (status, cost, agent version) + trace visualizer (UI-FR-034) |
| Notification tray | shell overlay | realtime-hub-fed; mark-read; deep links via `<UrnLink>` |
| Global search | shell (cmd-k) | URN/name search across modules; recent + permission-filtered results |
| Welcome / module home | `/` | V1 `welcome/Modules.tsx` + `UseCases.tsx` reimagined: module tiles, recents, pending approvals, workspace cost snapshot |

## 6. Events (client contract)

**Consumed via realtime-hub** (SSE; topics from `StreamHandle` fields): `ingestion.*`, `pipeline.*`, `experiment.*`, `inference.*`, `case.*` (list-scope), `usage.events.v1` budget events, `ai.agent_run.*` token/step streams, `ai.proposal.*` (inbox badge + list), notification fan-out. Handler contract: every event patches the relevant TanStack Query cache key (append/update/invalidate) — never triggers a blind refetch storm; reconnect invalidates active queries once. **Emitted:** none to Kafka; user telemetry (web-vitals, UI errors with trace_id) to the OTel collector endpoint; AI feedback via `submitFeedback` mutation.

## 7. Business rules & edge cases

- **BR-1** Tenant/workspace switch clears query cache, Zustand selection state, and SSE subscriptions atomically before navigation completes — no stale cross-workspace frame may render.
- **BR-2** AI labels (UI-FR-031) and provenance badges (UI-FR-032) cannot be disabled by any tenant setting or theme; they render before content (no label-less flash during streaming).
- **BR-3** Bulk approve is disabled whenever the selection contains a destructive-tool or high-risk proposal; the disable reason is shown inline.
- **BR-4** Concurrent decision conflict: if a proposal was decided elsewhere, the inbox card resolves to its final state on `CONFLICT` and shows who decided — never a raw error.
- **BR-5** SSE degradation: after 60s disconnected, affected status cells show a "live updates paused" indicator with manual refresh; the app never silently shows stale "running" states.
- **BR-6** Optimistic updates roll back with a toast naming the failed action; retries are user-initiated (no auto-retry of mutations).
- **BR-7** Uploads are resumable across page reloads within 24h (chunk manifest in IndexedDB); leaving mid-upload prompts.
- **BR-8** Tables cap client-side selection at 1,000 rows; "select all matching filter" delegates to server-side bulk with count confirmation.
- **BR-9** All timestamps render in user-local time with UTC on hover; exports are UTC ISO-8601.
- **BR-10** Error panels always show `trace_id`; a "report issue" action copies route + trace_id + operation hash.
- **BR-11** Route guards fail closed: unknown permission state renders skeleton, then 404-equivalent — never a flash of restricted content.
- **BR-12** The chart grid renders at most 12 concurrently-fetching charts; further charts load on viewport entry (intersection observer).
- **BR-13** Copilot suggested actions never mutate directly: every write path from chat materializes as a proposal (or a prefilled form the user submits) — enforced by the copilot surface having no mutation capability except `decideProposal` and `submitFeedback`.
- **BR-14** Multi-tab consistency: a second tab shares the SSE connection semantics independently; decisions made in one tab reconcile in others via proposal events (no tab-to-tab custom channel in v1).
- **BR-15** Feature-flagged screens render a consistent "not enabled" state (not 404) when the flag is off for the tenant, so navigation is stable across tenants.
- **BR-16** Export/download actions stream from signed URLs directly (never through the Next.js server); the UI shows async-export progress via the operation's SSE topic.
- **BR-17** `CopilotHome` (§UI-FR-060) is the default workspace home. A tenant admin may enable a per-user preference `me.preferences.homeView: chat | modules` allowing the legacy module-tile home for users who prefer it; charter compliance and SAS journeys are measured on the `chat` default only.
- **BR-18** Undo tokens (§UI-FR-073) persist to sessionStorage keyed by `(user, action_id, expires_at)`; browser reload within 30s replays the token so undo still works. Cross-tab undo is not supported in v1 (the toast is per tab).
- **BR-19** Typed-name gate (§UI-FR-074) comparison is case-insensitive but whitespace-strict — leading/trailing whitespace is trimmed before comparison; internal whitespace must match. Pasted values are trimmed identically to typed values.
- **BR-20** Expert-mode preference (§UI-FR-065) is per-user and cross-device; toggling emits `me.preferences.updated` which triggers a full-app re-render without navigation (no route reload).
- **BR-21** `<DecisionFooter>` (§UI-FR-076) renders even when `Query.decisionCost` returns `NOT_FOUND` (decision URN unmapped) — the cost chip shows "cost not tracked" (via `<Label>` key `cost.not_tracked`). NEVER shows `$0.00` for an unmapped decision (would misinform).
- **BR-22** Command palette (§UI-FR-079) results are workspace-scoped by hard filter server-side; a "Search all workspaces" toggle exists but requires expert mode + explicit user consent per workspace switch.
- **BR-23** `<Label>` resolution (§UI-FR-070) fallback chain: pack override → platform default in locale → key name (dev-only warning). Falling back to the key name never occurs in production because the label-key registry (§BFF-FR-088) is CI-validated against `<Label>` calls.
- **BR-24** `<DecisionFooter>` (§UI-FR-076) renders the provenance badge even if the cost fetch fails — provenance is the legal disclosure (EU AI Act Article 50) and cannot be suppressed by a downstream outage.
- **BR-25** SAS journeys (§UI-FR-090) run without any admin help documentation opened. If a Playwright step requires navigating to `/docs` or opening an in-app help panel, the SAS run fails — the platform is not simple enough yet.

## 8. Dependencies

**Upstream:** bff-graphql (all data; persisted-operation manifest published at build), realtime-hub (streams), identity-service (OIDC), OTel collector (RUM). **Contracts imposed on peers:** BFF `StreamHandle`/provenance/proposal schema (BRD 21 §5); realtime-hub JWT-authenticated multiplexed SSE with topic subscribe protocol; usage budget events fan-out. **Build/infra:** Node 22, Next.js standalone output in distroless image behind CDN; feature flags via OpenFeature web SDK; design-token package shared with email templates.

**Testing & delivery specifics (adapts MASTER-FR-070..072 for a frontend):** unit (Vitest + Testing Library) on hooks/primitives ≥ 80%; GraphQL operations typed + validated against the supergraph in CI (codegen fails on drift); Playwright suites above as the release gate; visual regression (Chromatic or Playwright snapshots) on the primitive library; axe + Lighthouse CI budgets; bundle-analysis gate per route; RUNBOOK.md covers CDN cache purge, canary rollback, persisted-manifest mismatch triage, and realtime-hub outage comms pattern.

## 9. NFRs (deltas from master)

- LCP < 2.5s p75 cold on dashboard and case-list routes; route-change < 300ms p75; per-route JS ≤ 250KB gzip (UI-FR-050); CLS ≤ 0.1; INP < 200ms p75.
- Case list sustains 60fps scroll over 1M-row result sets (windowed); memory ceiling 500MB heap for an 8-hour session (leak test in CI).
- Availability: static assets 99.99% (CDN); app functions read-only-degraded when realtime-hub is down (BR-5).
- Accessibility: zero serious/critical axe violations (release gate); full keyboard e2e pass.

## 10. Acceptance criteria

- **AC-1** Given a running pipeline, when a node completes, then its status cell updates within 5s via SSE and a network inspection over 10 minutes shows zero interval-driven refetch requests from status views.
- **AC-2** Given a case list of 1M matches, when scrolled continuously, then the DOM holds < 100 row nodes, frame rate stays ≥ 55fps (CI perf test), and pages load via `nextCursor` only.
- **AC-3** Given the copilot drawer opened on `/data/datasets/ds-9f2`, when the first message is sent, then the request context contains `wr:<tenant>:dataset:dataset/ds-9f2`, and the drawer displays the persistent AI disclosure label before, during, and after streaming.
- **AC-4** Given a dashboard chart created via an approved agent proposal, when viewed in the dashboards list and detail header, then an "AI-generated" provenance badge is visible, and clicking it shows agent id/version, approver, timestamp, and a working link to the agent-run trace.
- **AC-5** Given an inbox with 3 low-risk and 1 destructive-tool proposal selected—, when bulk approve is attempted, then the destructive proposal is excluded by construction (unselectable) and the confirmation lists exactly 3 items by tool; on confirm, all 3 resolve and the badge count decrements without refresh.
- **AC-6** Given a proposal rejected in the inbox, when submitting, then a rejection reason is required, and the `decideProposal` mutation payload contains it (asserted in e2e via network capture).
- **AC-7** Given an agent run with 800 trace nodes including one failed tool call, when the trace visualizer opens, then it renders virtualized within 1s, the failed node is auto-expanded with its error, and a span deep-link reproduces the exact expanded state.
- **AC-8** Given a workspace whose LLM budget crosses 95%, when the `budget.threshold` event arrives, then the AI cost panel indicator updates within 60s without user action, and at 100% the copilot drawer in that workspace shows the budget-exhausted banner.
- **AC-9** Given a case rename with optimistic update and a downstream `PERMISSION_DENIED`, when the error returns, then the UI rolls back to the previous name and shows a toast with the mapped message and trace_id.
- **AC-10** Given a route-level bundle analysis in CI, when any route's initial JS exceeds 250KB gzip or LCP regresses > 5% vs baseline, then the merge is blocked with the offending chunks named.
- **AC-11** Given keyboard-only navigation, when a user completes: create connection → upload file → open dataset profile → create chart → approve a proposal, then every step is operable without a pointer and axe reports zero serious/critical violations on each screen (Playwright + axe run).
- **AC-12** Given a tenant switch, when the new tenant's first screen renders, then no request, cached datum, or DOM content from the prior tenant is present (asserted via network + DOM snapshot in e2e).
- **AC-13** Given dark mode enabled, when visiting each module's primary screens, then all text and chart series meet WCAG contrast (automated token audit + axe).
- **AC-14** Given the copilot suggests a write action (e.g., "assign these 4 cases"), when the user accepts it, then a proposal is created and surfaced (inbox or inline decision card) — no domain mutation occurs before an explicit human decision (asserted via network capture: only `decideProposal` mutates).
- **AC-15** Given realtime-hub is unreachable for 90 seconds, when viewing a running pipeline, then status cells show the "live updates paused" indicator within 60s, manual refresh works, and on reconnect the statuses reconcile without a full page reload.
- **AC-16** Given a chunked upload interrupted by a page reload at 40%, when the user returns within 24h and reselects the same file, then the upload resumes from the last acknowledged chunk (verified by server-side received-bytes) rather than restarting.
- **AC-17** Given a new workspace with no prior threads, When a user opens `/`, Then `CopilotHome` renders as the primary surface with workspace picker and module nav collapsed; the primary CTA is the chat submit; no configuration screen is auto-navigated; no destination modal appears.
- **AC-18** Given a "Create dataset" flow, When the form renders, Then the top-level required fields count ≤ 3, "Advanced" is collapsed by default, and unfolding "Advanced" reveals the full schema without submitting.
- **AC-19** Given `me.preferences.expertMode=false`, When any primary screen renders, Then no URN string appears in the DOM (asserted by a regex sweep over each screen in Playwright); when `expertMode=true`, Then URNs appear as monospace subtitles under human labels.
- **AC-20** Given an installed insurance-claims pack in workspace W, When the case list renders, Then the primary CTA reads "New claim" (not "New case"), the resource-name column header reads "Claim ID", and after uninstalling the pack the labels revert to defaults ("Case", "Case ID") within 5s via the `displayLabels.updated` event — no page reload.
- **AC-21** Given a soft-delete of a dataset, When executed, Then an inline Undo toast appears with a 30s timer; clicking Undo restores the dataset within 30s (assertion: subsequent `dataset(id)` returns the entity); after 30s the toast disappears and retention proceeds.
- **AC-22** Given a pack purge-uninstall confirmation dialog, When the user types the pack name in mixed case with matching internal whitespace, Then the confirm button enables; typing any other value or leading/trailing whitespace variation keeps it disabled; the mutation payload carries the typed name verbatim.
- **AC-23** Given a chart backed by an approved agent proposal, When rendered, Then `<DecisionFooter>` displays the provenance badge, a `<CostChip>` showing the amount from `Query.decisionCost` (e.g., `$0.008`), and no `$0.00` fallback for unmapped decisions (instead: "cost not tracked" chip when 404).
- **AC-24** Given Cmd/Ctrl-K anywhere, When the user types "assign claim c-9 to me", Then the top result is the assignment command showing the case's `displayName` and executes on Enter without navigating away; When results are empty, "Ask copilot" is the last entry and pressing Enter opens `CopilotHome` with the query pre-filled.
- **AC-25** Given expert mode is toggled, When toggled from any route, Then all URN subtitles + expert cards appear or disappear within one render frame (no navigation, no full-page reload) and the preference persists after logout/login.
- **AC-26** SAS release-gate: Given a fresh cell + fresh tenant + tenant-provisioning credentials only, When the `sas-a-pack-install` + `sas-b-first-case` + `sas-c-nl-chart` suites run in sequence, Then each completes ≤ 5 min individually, the full journey completes ≤ 15 min end-to-end, no external documentation is navigated, and the release is otherwise not promoted (P0 gate).

**Playwright e2e coverage list (release-gating suites; run against a seeded staging cell with mock LLM):**

| Suite | Scenarios |
|---|---|
| `auth` | OIDC login, silent refresh, logout, expired-session recovery, route guards fail-closed |
| `data-connections` | connection CRUD, test-connection success/failure, secret write-only behavior |
| `data-upload` | chunked upload happy path, pause/resume, resume-after-reload, server-processing SSE to completion |
| `data-datasets` | dataset list filter/sort URL sync, detail tabs, profile regenerate (SSE), lineage graph expand + keyboard nav |
| `data-query` | editor run, dry-run cost estimate, paginated streamed results, save + verified flag |
| `data-pipelines` | DAG build from catalog, validate errors, run with live node statuses, failure surfaced on the failing node |
| `ml` | experiment wizard end-to-end, runs live status, run compare (param diff + overlaid metrics), model promote approval, inference job to output-dataset link |
| `dashboards` | create dashboard, global filter propagation, chart editor semantic flow with live preview, drilldown server pagination, investigate → case creation |
| `cases` | list over large seed (virtualization assertions), facet filters, bulk assign with progress, detail disposition, SLA chip |
| `agentic` | copilot drawer context URN + persistent AI label through streaming, citations deep-link, feedback submission; inbox approve/reject-with-reason/edit-args/bulk (destructive exclusion), conflict resolution; trace visualizer 800-node render + span deep link; cost panel threshold banner on live event |
| `admin` | users/groups/teams/workspaces/service-accounts CRUD, permission matrix edit, kill-switch toggle state, audit search + export, archive restore |
| `platform` | tenant-switch isolation (AC-12), dark-mode sweep + axe on every primary screen, i18n pseudo-locale render, performance budgets (Lighthouse CI), SSE-degradation banner on hub outage |
| `simplicity` | AC-17..25: chat-home default, ≤3-field create forms, expert-mode URN visibility toggle, pack terminology switch, undo toasts + typed-confirmation gates, decision-footer presence on AI-touched surfaces, command palette + "Ask copilot" fallback |
| `sas-journey` | **P0 release gate.** SAS-A pack install ≤5min · SAS-B first case ≤5min · SAS-C NL chart ≤5min · full journey ≤15min · no docs opened |
| `ai-surface-audit` | Regex sweep across every AI-touched artifact assert `<DecisionFooter>` + `<ProvenanceBadge>` + persistent AI label render before content (no label-less flash during streaming) |

## 11. Out of scope / future

Slack/Teams approval surface; embedded analytics SDK for customer sites; natural-language dashboard authoring UI (agent-side capability lands first, UI follows); offline/PWA support; real-time co-editing of dashboards; mobile-native apps; customer-facing white-labeling beyond theme tokens; locale packs beyond `en` (i18n structure ships day one, translations later); in-app guided onboarding tours; a V1 `provision` standalone app replacement beyond the `/admin/tenant` provisioning-status screen.
