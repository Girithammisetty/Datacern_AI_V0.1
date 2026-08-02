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

**Deferred (slice 2+):** hub-native inline chargeback run+download (the
`lib/export/chargeback.ts` builder already exists); scheduling arbitrary reports;
PDF board packs.
