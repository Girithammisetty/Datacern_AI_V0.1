# Insight surfacing — telling the user what changed, not just where to click

**Status:** slice 1 in progress
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
| 2 | Rank + route: severity-weighted ordering, each insight deep-links to the filtered worklist that proves it | designed |
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
