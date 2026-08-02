# Reports hub — extend Insights › Reports from a subscription list into a report catalog

**Status:** design + slice 1 implemented — 2026-08-02
**Surface:** `services/ui-web` · `/dashboards/reports` (nav: Insights › Reports)

---

## 1. Analysis

### 1a. The gap

The **Reports** entry under Insights (`NAV_ITEMS` key `reports`, gate
`notification.report.read`) points at `/dashboards/reports`, which today is a
single thing: **scheduled dashboard-email subscriptions** (NOTIF-FR-060 — a
list of cadence rules that email a dashboard). That is *delivery*, not
*reporting*.

Meanwhile the platform already produces a spread of real, business-meaningful
reports — but every one of them lives on an admin or data page a line-of-business
user (the person who wants a report) would never navigate to:

| Report | Lives on | Format | Capability |
|---|---|---|---|
| Chargeback / spend showback | `/admin/usage` (Chargeback card) | CSV | `usage.report.read` |
| ROI / value report | `/admin/value` | CSV + JSON (signed artifact) | `usage.report.read` |
| Agent inventory (EU AI Act Annex IV) | Control Tower `/admin/agents` | CSV | `ai.agent.read` |
| Decision evidence pack | Approval inbox `/inbox` | JSON | `audit.compliance.read` |
| Compliance / audit pack | `/admin/audit/export` | artifact | `audit.compliance.read` |
| Case export | `/cases` | CSV (async) | `case.case.export` |
| Chart export | any dashboard | CSV (async) | `chart.chart.export` |
| Decision outcomes | `/decisions` | (view) | `case.disposition.read` |

So the answer to "what reports can I get, and where?" is **undiscoverable**:
there is no index. This is the same theme as the just-fixed "chargeback rendered
but couldn't be downloaded" — reporting exists but isn't surfaced *as* reporting.

### 1b. What's reusable

- **Nav + gating:** `NAV_ITEMS`/`cap()`/`useCapabilities().can(gate)` already
  drive per-capability visibility; the hub filters the catalog the same way.
- **Client export layer:** `lib/export/csv.ts` (`buildCsv`/`downloadCsv`) +
  `lib/export/{agentInventory,chargeback}.ts` already turn in-hand rows into
  downloads with no round-trip — the pattern any hub-native download follows.
- **The subscriptions UI** (`/dashboards/reports`) already works and stays — it
  becomes one section ("scheduled delivery") of the hub, not the whole page.

---

## 2. Design

**Turn Reports into a hub with two parts:**

1. **Report catalog** (new) — a capability-filtered index of every report the
   platform can produce, grouped by domain, each card carrying: what question it
   answers, its formats, whether it can be scheduled, an honesty note where one
   applies (e.g. "finalized months only"), and a deep link to where it runs
   (`Open report →`). The catalog is the discovery layer that was missing.
2. **Scheduled delivery** (existing) — the current subscription list, unchanged
   in behaviour, framed as the delivery half of reporting.

### 2.1 A pure catalog registry

`src/lib/reports/catalog.ts` holds `REPORT_CATALOG: ReportDefinition[]` — static
metadata (no data fetch), each entry a real report that exists today with its
capability `Gate` (via `cap(...)`), formats, domain, target `href`, and note.
`visibleReports(can)` filters to the caller's capabilities; `reportsByDomain()`
groups for render. Pure and unit-tested — the catalog can't drift into listing a
report the viewer can't reach, and a report with no honest home is never added.

**Why a registry, not hard-coded JSX:** the same list drives the hub today and
is the natural place a future "run this report inline" or "schedule this report"
action attaches per entry — one source of truth for "what reports exist".

### 2.2 Deep-link, don't re-implement

Slice 1 links each catalog entry to the page that already runs/downloads it
(`/admin/usage`, `/admin/value`, `/admin/agents`, …) rather than duplicating
each report's fetch + export inside the hub. This ships the discovery value
immediately and keeps each report's real permission/enforcement on its owning
page. Hub-native inline run/download (starting with chargeback, whose builder
already exists) is the slice-2 follow-on.

### 2.3 Scope / honesty

- **In scope (slice 1):** the catalog registry + tests, and the hub page
  rendering the catalog above the existing subscriptions. No backend change.
- **Deferred:** inline run+download in the hub (slice 2), a "schedule any report"
  action beyond dashboards, PDF/board-pack rendering, and a saved-view /
  parameterized-report concept. Listed so the hub reads as a foundation, not a
  finished product.
- The catalog lists **only reports that exist and are reachable today** — no
  aspirational entries.

---

## 3. Implementation & test (slice 1)

**Built (2026-08-02):**
- `src/lib/reports/catalog.ts` — `ReportDefinition`, `REPORT_CATALOG` (8 real
  reports), `REPORT_DOMAINS`, `visibleReports(can)`, `reportsByDomain(list)`.
- `src/lib/reports/catalog.test.ts` — every entry has a valid domain/gate/href;
  capability filtering hides what the viewer can't reach; grouping is stable.
- `src/app/(app)/dashboards/reports/page.tsx` — a "Report catalog" section
  (domain-grouped, capability-filtered cards with format chips + `Open report →`)
  above the existing "Scheduled delivery" subscription list.

**Verified:** `tsc --noEmit` clean, `next lint` clean, full ui-web vitest suite
green.

### Slice 2 — hub-native inline run + download (2026-08-02)

For the reports whose data the client can fetch AND whose CSV builder already
exists, the hub now runs the report and downloads it in place instead of only
deep-linking:

- `src/components/reports/InlineReportDownload.tsx` (new) — `INLINE_RUNNERS`
  (report id → run control) + `hasInlineRunner(id)`. Two runners: **chargeback**
  (month picker defaulting to the previous finalized month + Download CSV) and
  **agent inventory** (Download CSV). Both fetch **on click** via
  `queryClient.fetchQuery` (never eager — opening the hub pulls no report data),
  build the CSV with the existing `lib/export/{chargeback,agentInventory}.ts`
  builders, and toast honestly on an empty result or an error. The agent
  inventory export is the system-inventory view (no spend); the spend-inclusive
  export stays on the Control Tower page behind its own gate.
- `dashboards/reports/page.tsx` — a catalog card renders its inline runner when
  one exists (with a small "Open full report →" link to the owning page for
  filtering); every other report keeps its "Open report →" deep link.
- `InlineReportDownload.test.tsx` — the runner registry, chargeback fetch →
  build → download (right filename + CSV content) and its empty-month no-download
  path, and the agent-fleet fetch + empty path. `tsc`/lint clean, full ui-web
  suite green.

### Slice 3 — inline run for value/ROI + case export (2026-08-02)

Two more inline runners, plus an honest exclusion:

- **ROI / value** — a new client-side CSV builder (`lib/export/value.ts`,
  `buildValueReportCsv`) flattens the `ValueSummary` the hub fetches into a file,
  preserving /admin/value's honesty: measured figures are exact, estimates
  disclose their `assumptionVersion`, and an unset assumption exports the literal
  `not available` (never a fabricated 0). A month-picker runner fetches the
  summary on click and downloads it.
- **Case export** — reuses the existing `CaseExportButton` (the same async
  export operation the `/cases` page uses: kick off → poll → download via the
  authed proxy), run unfiltered from the hub. No re-implementation.
- **Chart export — intentionally NOT inline.** A chart export needs a specific
  chart selected, so there's no meaningful "run all charts" hub action; it stays
  a deep link to the dashboard the chart lives on. Recorded so the omission
  reads as a decision, not a gap.

`InlineReportDownload.tsx` now has four runners (chargeback, agent inventory,
value/ROI, case export); tests cover the value builder + the value runner
fetch→build→download. `tsc`/lint clean, full ui-web suite green.

### Slice 4 — billing periods, full-stack (2026-08-02)

The B2 close pipeline produces closed billing periods (gross + net-billable
totals, export/push status behind each invoice) but that finance-close view had
**no read path** off the platform — the last reporting gap. Wired end-to-end:

- **BFF** — `UsageClient.billingPeriods(period?, first?)` → usage-service
  `GET /api/v1/billing/periods` (gated `usage.report.read`), `BillingPeriodDTO`
  + `mapBillingPeriod` (nullable export; empty rate card → null), a
  `type BillingPeriod implements Node` + `type BillingExport` in the schema, a
  `billingPeriods(period, first)` query + resolver, and a **billing-periods**
  entry in the server-authoritative `REPORT_CATALOG` (capability-filtered like
  the rest). Schema snapshot regenerated; resolver tests cover the newest-first
  list, verbatim push status, the closed-but-not-exported row, and param
  pass-through.
- **UI** — `useBillingPeriods` hook + `BillingPeriod`/`BillingExport` types, a
  `buildBillingPeriodsCsv` builder (measured totals exact; a period with no
  export yet exports the literal `not exported`, never an implied success), and
  an inline runner registered in `INLINE_RUNNERS` so the hub card runs +
  downloads it in place. Builder + runner tests green; `tsc`/lint clean, full
  ui-web suite green.

Push status is surfaced verbatim (pushed / billing_push_not_configured /
push_failed) — a not-configured push is never read as a success. The report is
empty for a tenant until the monthly close job runs — no period is fabricated.

**Still deferred:** scheduling arbitrary reports beyond dashboards; PDF board
packs; an entitlement-gated catalog (the capability filter is server-side
today); a signed download endpoint for the B2 billing-periods **artifacts**
(the object-store CSV/JSONL keys are surfaced, but streaming them through an
authed proxy is a separate slice).
