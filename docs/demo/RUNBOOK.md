# Datacern AI — demo runbook (platform → pack → copilot → approval)

**What this is:** every step a real person performs, from a cold laptop to a
closed governed decision, verified live on 2026-07-24 against the real stack
(24 services, real Postgres/Kafka/Iceberg/OpenSearch, real Ollama LLM — no
mocks, no stubs).

**Hero use case:** `card-disputes` — Reg E / Reg Z dispute operations.
Chosen because it is the only pack with on-disk proof that its current v2.1.0
shape installs end-to-end, and because the pain (a regulatory clock that
expires) is legible to any bank buyer in one sentence.

Everything below was executed and observed. Where something does **not** work,
it says so — read §7 before you stand in front of a customer.

---

## 0. Prerequisites (once per machine)

| Need | Check | Fix |
|---|---|---|
| Docker Desktop running, ≥10 GB | `docker info` | start Docker Desktop |
| Ollama + 3 models | `curl -s localhost:11434/api/tags` | `ollama pull llama3.2:latest && ollama pull qwen2.5:0.5b && ollama pull nomic-embed-text` |
| node@20 + corepack pnpm | `/opt/homebrew/opt/node@20/bin/node -v` | `corepack enable && corepack prepare pnpm@9.15.9 --activate` |
| Go toolchain, `uv`, `psql` | `go version && uv --version && psql --version` | brew install |
| Harness venv | `ls deploy/e2e/.venv/bin/python` | `cd deploy/e2e && uv venv && uv sync` |

> **PATH gotcha.** `deploy/e2e/config.env` prepends `/opt/homebrew/bin`, so any
> script that sources it must re-prepend node@20 *after*. The bare Homebrew
> pnpm (v11) requires node 22 and an nvm node16 can shadow both. Every
> `deploy/local/*.sh` already does this — don't hand-roll it.

### 0a. If the repo directory was moved or renamed

Two caches hard-code absolute paths and will break the boot in ways whose
error messages point at the wrong thing. Both were hit on 2026-07-24 after the
`Windrose_AI_V0.1` → `Datacern_AI_V0.1` rename:

```bash
# 1. Python venvs: console scripts keep a shebang to the OLD interpreter, so
#    `uv run alembic|uvicorn` dies with "Failed to spawn ... No such file or
#    directory" and up.sh aborts with "FATAL: ingestion not ready".
for s in agent-runtime ai-gateway dataset-service eval-service experiment-service \
         inference-service ingestion-service memory-service pack-service \
         pipeline-orchestrator semantic-service; do
  ( cd services/$s && rm -rf .venv && uv sync )
done

# 2. ui-web's Next build cache bakes the old path -> every route 500s and the
#    login page never hydrates (Sign in does a native GET /login? instead).
rm -rf services/ui-web/.next
```

Do **not** chase the `Cannot find module '@swc/helpers'` message this produces
— under pnpm's strict layout that transitive dep is legitimately absent from
the root `node_modules`; it resolves fine from inside `next`'s own directory.
The venv shebang is the real cause.

---

## 1. Start the platform

```bash
make up                    # full platform + claims demo data  (~6-10 min cold)
make up ARGS=--platform-only   # tenant + 5 personas only, no vertical data
make up ARGS=--core            # RAM-constrained profile
```

`up.sh` is honest by construction: every service is health-checked before the
next step, and anything that cannot boot is reported, never faked. Watch for
these lines — they are the ones that matter:

```
ok  Docker memory 13.6GB / Ollama has llama3.2:latest
ok  infra reachable
ok  tenant provisioned: 019f91e2-…
ok  <service> ready (/readyz 200)      x23
ok  ui-web serving at http://localhost:3000
```

If the banner ends with **"Degraded — these did not come up:"**, stop and read
`deploy/e2e/logs/<service>.log`. A clean run has no such line.

### 1a. Verify — never skip this

```bash
make doctor        # expect: "all healthy."
```

`doctor` checks the four things that actually break a demo: data volumes
present, tenant registry non-empty, the Redis RBAC projection rebuilt, and the
OpenSearch case index present. `make doctor HEAL=1` repairs the last two.

Health endpoints are **liveness-only** — a service answers `/healthz` 200 with
every datastore down. Use `/readyz` (503 when not ready) or `make doctor`.

### 1b. Log in

http://localhost:3000/login — email only, **any password**.

| Persona | Sees |
|---|---|
| `adjuster@demo.datacern` | Cases, Approvals, Dashboards |
| `manager@demo.datacern` | + Reports |
| `datascientist@demo.datacern` | Data, ML, Eval |
| `admin@demo.datacern` | everything + Admin |

The sidebar is **capability-filtered per persona** — that is a feature to show,
not a bug to explain. Sign in as the adjuster first and let them notice the
short nav; then sign in as admin and let them watch it grow.

---

## 2. Stand up the vertical (card-disputes)

### 2a. Create the tenant + install the pack — and let it fail

```bash
packs/demo.sh load card-disputes
```

The first run **fails on purpose**, and this is the single best 30 seconds of
the demo:

```
ok  tenant 'wr-demo-card-disputes' provisioned: 019f96b0-…
[failed] datasets/cd_cardholders — requires_binding: no dataset bound for
         'cd_cardholders' and no tenant dataset named 'cd-cardholders' exists
         (required columns: cardholder_id, cardholder_name, segment, …)
failed: 3 actions, 3 failed, 1 deferred
```

**Talk track:** *"The pack ships zero data — it ships a contract. It refuses to
install until this tenant supplies real data with the exact columns the
workflow needs, and it tells you precisely which columns are missing. Nothing
was half-created."*

### 2b. Supply the data

The contract is `packs/card-disputes/data/datasets.yaml` — 3 datasets, 41
columns. In a real deployment this arrives through the pack's governed
connectors; for a demo, upload three CSVs whose **dataset names match exactly**
(`cd-cardholders`, `cd-transactions`, `cd-disputes`) so the install binds by
same-name reuse.

Through the product: **Data → Upload**, one dataset per file.
Scripted (what this runbook used):

```bash
python scratchpad/gen_card_disputes_demo.py     # deterministic, fully fictional
deploy/e2e/.venv/bin/python3 scratchpad/upload_demo_data.py
#   ok cd-cardholders: rows=40
#   ok cd-transactions: rows=160
#   ok cd-disputes: rows=117
```

The generated book is shaped so every decision rule has live matches:
**117 disputes · 74 open · 6 already past the regulatory clock · $65.6K open ·
$34.5K recovered.**

### 2c. Re-run the install — it binds

```bash
packs/demo.sh load card-disputes     # idempotent
```

```
[ reuse] datasets/cd_cardholders — bound to tenant dataset 'cd-cardholders'
[ reuse] datasets/cd_transactions — bound to tenant dataset 'cd-transactions'
[ reuse] datasets/cd_disputes    — bound to tenant dataset 'cd-disputes'
installed: 51 actions, 0 failed, 1 deferred
```

(The 1 deferred is `agent_recipes`, a documented not-yet-implemented kind.)

Logins created — **use `personas.json`, not `MULTITENANT_LOGINS.md`**, which
goes stale after a rebuild:

```
admin@carddisputes.datacern                    (author)
approver@carddisputes.datacern                 (four-eyes approver)
dispute-intake-analyst@carddisputes.datacern
fraud-investigator@carddisputes.datacern
chargeback-specialist@carddisputes.datacern
dispute-operations-manager@carddisputes.datacern
dispute-compliance-auditor@carddisputes.datacern
```

---

## 3. The demo arc

Sign in as `admin@carddisputes.datacern`. The top bar reads **Card Disputes
Demo / Default use case** — tenant and use-case, not a generic shell.

### Step 1 — the money picture (Dashboards)

**Dashboards** → three boards installed by the pack, all on the real uploaded
data:

- **Dispute Command Center**
- **Regulatory Clock & Provisional Credit** ← lead with this one
- **Chargeback Recovery**

Open *Regulatory Clock & Provisional Credit*: open disputes split by regulatory
regime (reg_e vs reg_z) and the provisional-credit status mix
(not_required / due / issued / reversed).

*Talk track: "This is your dispute book as governed data. Reg E and Reg Z carry
different clocks, and provisional credit has its own 10-business-day clock
inside that. Right now you can see how much of the book is exposed."*

### Step 2 — the rules are the institution's, not a black box (Decisions)

**Decision Tables → Reg E dispute triage table.** Read rule #1 aloud:

> `deadline_days_left < 0` → `route_investigation_review`, severity **critical**
> *"Regulatory clock ALREADY BREACHED — overdue posture; route to investigation
> review for immediate human completion and documented findings."*

Then show the two things a compliance buyer is actually testing you on:

1. A clock breach routes to **investigation review, not the fraud track** — a
   deadline breach is a workflow emergency, not a fraud finding.
2. `default_outcome` for an unmatched dispute is **`route_investigation_review`,
   never a denial.** The table's own note says why: a Reg E denial requires a
   completed investigation with documented findings, and a default-deny posture
   is UDAAP / examination risk even when individual files look defensible.

*Talk track: "The thresholds are your configuration, in plain language, with the
citation next to them. And notice what it refuses to do — the system knows what
it is not allowed to decide."*

### Step 3 — the copilot reasons over one case

Open a case, then **Copilot** in the top bar. The drawer header shows the
context URN and the active agent — proof it is scoped to what you are looking
at, under your permissions.

Ask:

```
In one sentence, what is this dispute about?
What evidence is attached, and what does it show?
What is missing before this can be adjudicated?
```

**Expect 10–45 seconds of latency and then the whole answer at once** — the
runtime publishes the final text as a single event rather than token-by-token.
Warm the model before the demo (`ollama run llama3.2 "hi"`).

### Step 4 — a governed proposal, not an action

Ask the copilot to triage, or batch-run the decision table across the worklist.
Either way the result is the same shape: **a pending proposal**, never a write.

Verified live: 7 of 9 agents land their run in `awaiting_approval` rather than
executing.

### Step 5 — four-eyes approval (the close)

**Approvals** → open the proposal. Show, in this order:

- the rationale and the **server-recomputed** predicted effect — the model's own
  prose is demoted to `agent_summary`, so a persuasive description cannot
  launder a dangerous action
- the args diff, and **Approve with edits**
- **Reject requires a reason**
- the **"high-risk · needs a distinct approver"** badge
- bulk-approve exists, but destructive/high-risk proposals are **unselectable by
  construction**

Now switch to `approver@carddisputes.datacern` and approve. Then try approving
your *own* proposal as the author — the platform blocks it.

*Talk track: "A named human approved this. Execution authority is the approver's,
not the requester's, and it is enforced server-side with a signed grant bound to
this exact tenant, tool, and arguments — not a UI convention."*

> **Check these BEFORE you demo the approval — all three fail silently.**
> An approval whose write is refused still shows `approved`, and the case simply
> does not change. Found the hard way on 2026-07-26; each of these produced
> exactly that symptom:
>
> 1. **The tool must be registered.** `case.apply_disposition` was missing from
>    the registry on any ordinary `up.sh` bring-up (fixed — `seed.py
>    case_apply_tool` now runs at boot). Verify:
>    `psql -d tool_plane -c "select tool_id,version,status from tool_versions"`.
> 2. **The approver needs a grant on the case.** Execution runs as the *decider*,
>    and per-resource grants are minted by **assignment** — so an unassigned case
>    is refused with `permission denied: obo_grant`. Assign the case to whoever
>    will approve it.
> 3. **The case must be in progress.** case-service refuses to resolve a `draft`
>    case (`INVALID_TRANSITION`). Start it first.
>
> When a write is refused the reason lands in `tool_plane.invocation_log`
> (`decision`, `deny_reason`) and, since the execution-outcome fix, on the
> proposal itself as `decision.execution`. Check there before assuming the
> platform is broken.

### Step 6 — the receipt

The case carries the disposition and the rule trace. **Audit** shows the whole
chain — who proposed, who approved, what executed — hash-chained and
exportable to the customer's SIEM.

Confirm the write actually landed rather than trusting the `approved` badge —
the case's disposition and resolution note should now be the agent's proposed
ones. Verified end to end on 2026-07-26 with the three preconditions above met:
agent proposed → a different human approved → tool-plane `allowed` →
case-service applied it.

---

## 4. The agent roster (all live-tested)

Nine agents, all published, all exercised against real Ollama through the real
chat path on 2026-07-24 — **9/9 PASS in 27 s**:

| Agent | Result | Produces |
|---|---|---|
| `case-triage` | awaiting_approval | disposition proposal on a case |
| `dashboard-designer` | awaiting_approval | dashboard from real semantic measures |
| `onboarding` | awaiting_approval | ingestion config from the connector catalog |
| `model-training` | awaiting_approval | training run from an algorithm template |
| `inference` | awaiting_approval | batch scoring job |
| `governance` | awaiting_approval | retrain proposal on drift |
| `meta-router` | awaiting_approval | classifies, then delegates (→ dashboard-designer) |
| `analytics` | completed | read-only; never emits a write |
| `ml-engineer` | completed | honest "no dataset found" rather than a guess |

Re-run any time:

```bash
deploy/e2e/.venv/bin/python3 scratchpad/test_agents_chat.py <case_id> <dataset_id>
```

---

## 5. Top 5 packs to sell

| # | Pack | Why it sells | Binding burden |
|---|---|---|---|
| 1 | **card-disputes** | Only pack with proven v2.1.0 install. CFPB-named regulator, a named clock, 12 rules, exemplar depth | 3 datasets / 41 cols |
| 2 | **ap-invoice-audit** | Widest buyer — every company has AP. Duplicate-payment recovery in CFO dollars, plus BEC bank-change holds | 3 / 32 |
| 3 | **mortgage-loss-mitigation** | Reg X 30-day clock + **dual-tracking holds**; get it wrong and it's a CFPB finding. Investor waterfall shows real domain depth | 3 / 35 |
| 4 | **trade-compliance** | Deepest grounding corpus (13 memories). OFAC 50% rule, BIS Entity List, UFLPA — current board-level fears | 3 / 34 |
| 5 | **credit-disputes** | Lightest lift in the catalog (28 cols) — pairs with #1 as a two-pack banking story. FCRA clocks, enormous furnisher market | 3 / 28 |

**Avoid on a first call:** `insurance-claims-payer` (audited shallow),
`manufacturing-mrb` and `tax-notices` (repeat install failures).
`banking-aml` has the most obvious buyer but the thinnest agent prompt in the
fleet — polish before it leads.

---

## 6. Reset between demos

```bash
packs/demo.sh clean card-disputes    # drop just this demo tenant
packs/demo.sh clean-all              # every wr-demo-* tenant
make reset FORCE=1 && make up        # nuclear: wipes all volumes
```

`make down` stops services but **keeps** data; only `make reset` drops volumes.
Cleanup does not GC MinIO/Iceberg objects — they become unreachable local debris.

---

## 7. Known limits — read before you demo

Honest list. Each was observed, not assumed.

1. **The copilot cannot answer warehouse questions.** The `analytics` agent has
   no semantic-layer tool wiring (marked Phase-2 in `analytics.py`). "How many
   disputes are overdue?" returns prose, not a number. Ask the *dashboards* and
   the *decision table* for numbers; ask the copilot about **one case**.
2. **Latency is 10–45 s on a laptop** and arrives in one chunk, not streamed.
   Warm the model first. The rules + four-eyes arc needs no LLM and is instant —
   lead with it.
3. **`/data*` pages route the copilot to the `onboarding` agent.** Ask data
   questions from `/cases`, `/`, or `/copilot` or you'll get an ingestion answer.
4. **Autonomous agent runs are degraded.** Event-triggered triage and the
   drift-driven retrain scheduler run as the agent's own principal, which holds
   no RBAC grants — every grounding read 403s ("grounding degraded"). The
   user-driven copilot path is unaffected because it runs on-behalf-of the user.
   Do not demo autonomous triggers.

4a. **Know exactly what is automatic before you claim it** (researched
   2026-07-24 — the marketing copy previously overclaimed here):

   | Step | Automatic? |
   |---|---|
   | Data arriving | **Yes, on a schedule — since 2026-07-26.** Previously "nothing polls, listens or wakes up"; that is now out of date. `app/main.py` starts the in-process scheduler at boot and rehydrates every enabled schedule, so a cron/interval schedule fires on its own and survives a restart. Object-store (`s3`/`gcs`/`azure_blob`) and now `sftp`/`ftp` sources ingest via `file_poll`. Still true: `http_api` tests green and cannot ingest; webhook-batch creation 501s; Temporal schedules remain a stub. Single-replica only — the tick registry has no cross-replica lease. |
   | Rows becoming cases | **Yes — once a human authors an intake rule.** `ingestion.completed` → case-trigger evaluation → cases materialized, dedup-keyed on `(dataset_urn, row_pk)`. Fully wired, no feature flag, real Postgres integration test. Without a trigger, an operator must tick rows in the dataset/dashboard grid and click "Create cases" every time. |
   | Agent triaging a new case | **Not automatically — but now reachable from the UI.** `AR_EVENT_TRIGGERS_ENABLED` still defaults `false` and is set nowhere in `deploy/`, so nothing triages on its own. The `KeyError` that would have crashed it if enabled is fixed (the dispatcher now derives `case_id`/`tenant_id` from the event envelope). The "no UI control" claim is out of date: the case detail page has a **Draft recommendation** button, which is the supported way to run triage on demand. |
   | Decision table across a worklist | **No.** `POST /decision-models/{id}/batch-evaluate` is real and defaults to dry-run, but **no UI component calls it** — the React hook exists with zero callers. Operator must hit the API. |
   | Inference → auto-create case | **Dead path.** The consumer is wired, but no service emits `inference.completed` and nothing anywhere sets `auto_case`. |

   Honest one-liner for a buyer: *the intake queue fills itself accurately once
   someone writes a trigger rule; the "agent reads it and drafts" half is not
   running in any shipped configuration.*
5. **`data-pipeline-builder` is a dead agent key** — present in `RUNNERS` but
   missing from `CATALOG`, so invoking it 404s.
6. **Dev login is local-mode.** Real OIDC/SSO is built and verified against
   Keycloak but needs an IdP configured for a prospect-facing environment.
7. **`MULTITENANT_LOGINS.md` goes stale** after any tenant rebuild.
   `deploy/local/run/personas.json` is the source of truth.
8. **`personas.json` is baked into ui-web's env at boot** — editing it does
   nothing until `deploy/local/restart_ui.sh`. Never restart ui-web with a bare
   `next dev`; it self-signs throwaway JWTs and silently breaks auth
   platform-wide.

---

## 8. One-page cheat sheet

```bash
make up                                  # start everything
make doctor                              # prove it's healthy
packs/demo.sh load  card-disputes        # install a vertical (fails closed w/o data)
packs/demo.sh clean card-disputes        # tear it down
deploy/local/restart_ui.sh               # the ONLY safe ui-web restart
make down                                # stop (data survives)
make reset FORCE=1                       # wipe everything
```

| Surface | URL |
|---|---|
| App | http://localhost:3000 |
| GraphQL BFF | http://localhost:4000/graphql |
| Temporal | http://localhost:8233 |
| MLflow | http://localhost:5500 |
| MinIO | http://localhost:9001 (`datacern` / `datacern_dev`) |
| Mailpit | http://localhost:8025 |
