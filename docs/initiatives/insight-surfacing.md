# Insight surfacing — telling the user what changed, not just where to click

**Status:** slices 1–2 shipped
**Problem owner:** every persona in every vertical pack

## 1. The gap, stated precisely

The platform computes a great deal — SLA timers, model scores, drift, dispositions,
approval chains — and surfaces almost none of it *proactively*. `HomePage`
(`services/ui-web/src/app/(app)/page.tsx`) is role-aware and good at what it does:
a decision-queue card, a pending-approval count, an auditor card, and
capability-filtered navigation tiles.

What it answers is **"what is assigned to me and where do I go?"**

What no screen answers is **"what changed, and what should I care about first?"**

That is the difference between an operator console and a decision-intelligence
surface, and it is the cheapest large gap to close because the data already
exists — this is composition, not new plumbing.

## 2. What can be computed HONESTLY today

Slice 1 deliberately uses only fields the bff already serves on `Case`
(verified against `services/bff-graphql/schema.graphql`):

| Field | Used for |
|---|---|
| `status` (DRAFT/UNASSIGNED/IN_PROGRESS/RESOLVED/CLOSED) | which cases are still live |
| `dueDate` | overdue, due-soon |
| `createdAt` | stalled / aging |
| `assignee` | unassigned work |
| `reassignCount` | routing churn |
| `severity` | ranking |

### The constraint that shapes the whole design

**case-service exposes no aggregate.** Its only read route is
`GET /cases` (`internal/api/server.go:84`, `handleSearchCases`), and the bff's
`CaseConnection` carries `nodes` + `pageInfo{nextCursor,hasMore}` — **no
`totalCount`**. There is no facet or stats endpoint anywhere in that service.

So a tenant-wide exact count is not obtainable today, and any UI that implies
one would be lying. Slice 1 therefore:

- computes over a **bounded window** (one page of live cases, same 200-row cap
  the rest of the UI uses), and
- **says so in the copy**, rendering "at least N" with an explicit
  "across the N cases examined" note whenever `pageInfo.hasMore` is true.

A real aggregate (`GET /cases/stats` or OpenSearch facets, which the search
backend can already do) is slice 3. Until it exists, the number on screen is
honest about being a floor rather than a total.

## 3. Why not compute insights in an agent

Tempting, and wrong for this slice. These are deterministic threshold
questions ("is `dueDate` in the past?"). Routing them through an LLM would add
latency, cost, non-determinism and a hallucination surface to arithmetic that
is exactly correct in ~40 lines of TypeScript. The `analytics` agent earns its
place on *open-ended* questions — that is a separate item (contextual
ask-your-data), not this one.

## 4. Slices

| # | Slice | State |
|---|---|---|
| 1 | `computeInsights()` — a pure, unit-tested function over the live-case window + an `InsightsCard` on home, capability-gated, honest about bounds | **this commit** |
| 2 | Rank + route: severity-weighted ordering, each insight deep-links to the filtered worklist that proves it | **this commit** |
| 3 | A real aggregate (`/cases/stats` facets) so counts become exact and the window disappears | designed |
| 4 | Non-case signals on the same surface: model drift (experiment-service), failed ingestions, auto-cases opened since last visit | designed |
| 5 | `make journey-insight`: seed a tenant with known-shape cases → assert the home API returns exactly the expected insights (no UI screenshot assertions) | designed |

## 5. Slice 1 scope

Five generators, each a threshold over the fields above:

1. **Overdue** — live case whose `dueDate` has passed. Severity: critical.
2. **Due soon** — `dueDate` inside the next 24h. Severity: warning.
3. **Unassigned** — `UNASSIGNED` status, i.e. nobody owns it. Severity: warning.
4. **Stalled** — live, created >14 days ago, still not resolved. Severity: info.
5. **Routing churn** — `reassignCount >= 3`, a signal that assignment rules or
   skills routing are wrong. Severity: info.

Design rules, all enforced by tests:

- **An empty state is a real answer.** No insights = "Nothing needs attention"
  — never a spinner that resolves to blank, and never invented filler.
- **Every insight names its own evidence.** Count + the rule that produced it,
  so a user can disagree with it.
- **Capability-gated.** A persona without `case.case.read` sees no case
  insights at all rather than an empty card implying zero work.
- **Never blocks the page.** Insight failure degrades to silence with the
  existing decision-queue and approvals cards intact; it is additive.

## Slice 2 (this commit) — ranking, and links that are evidence

**One predicate, two consumers.** `INSIGHT_DEFS` now holds each insight's
`match(case, now)` and nothing else defines it. The home card counts with it;
`/cases?insight=<slug>` filters with it. A second copy of "what overdue means"
would drift, and the first symptom would be a count that disagrees with the page
it links to — which is worse than no link, because it looks like evidence.
`filterByInsight` returning exactly `count` cases is asserted for every insight
in the registry, so adding one cannot quietly break the contract.

**Ranking is urgency-weighted, not size-weighted.** Order is level → how many
matches are HIGH/CRITICAL → raw count. Two critical overdue cases outrank five
low ones; sorting by count alone buries exactly the work that matters. The card
shows "· N high or critical" so the ordering is legible rather than arbitrary.

### What the deep link can and cannot do

`CaseFilter` is `{status, severity, assignee}` — case-service can filter on
none of `dueDate`, `createdAt` or `reassignCount`. Three of the five insights
are therefore **impossible to push server-side today**, so the worklist narrows
the pages it has already loaded, client-side, and the banner says so:

> Showing: open case whose due date has passed — (2 of the 4 loaded — load more
> to widen the search)

That sentence is the honest version of a filter chip. Without it the page would
imply it had searched the tenant. Server-side predicates for these three fields
are the natural companion to slice 3's aggregate — the same case-service work
unlocks both.

An unknown slug (stale bookmark, hand-edited URL) narrows nothing rather than
showing an empty list, because "you have no work" is the most damaging thing
this surface could say incorrectly.

### A note on the tests

Row-level assertions are deliberately absent: `DataTable` is virtualized and
jsdom has no viewport height, so it renders zero rows regardless of data — a row
assertion would test the virtualizer. The banner's "N of the M loaded" is
computed from the same two arrays the table receives, so a broken predicate
surfaces there immediately. 6 wiring tests + 14 predicate tests.
