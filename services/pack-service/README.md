# pack-service

Datacern's **governed, in-cluster capability-pack install service** (BRD 23). A
*capability pack* is a versioned bundle that stands up a whole vertical use case
— datasets, semantic models, dashboards, dispositions, roles, decision tables,
agents + guardrails, cases, eval sets, ontology, write-back adapters, and more —
inside a tenant workspace. pack-service promotes the pre-existing out-of-cluster
`packs/packctl` CLI into a first-class service with a catalog, a dry-run plan, a
transactional install saga (an origin-tagged ledger), reversible uninstall, and
version lifecycle (upgrade / rollback / drift).

Spec: `docs/brd/23_pack_service_BRD.md` inheriting `docs/brd/00_MASTER_BRD.md`.
Layout per `CONVENTIONS.md` (Python/FastAPI service, conventions cloned from
[dataset-service](../dataset-service/README.md)).

> **It reuses `packs/packctl` as a library** (`from packctl import manifest,
> client, installer`) — the mature, idempotent `ensure_*` materializers that call
> Core services' public APIs. pack-service does **not** reinvent materialization;
> it wraps packctl in a governed, persisted, multi-tenant install saga.

## Run

```bash
export PATH="/opt/homebrew/bin:$PATH"   # uv
make install    # uv sync (Python 3.12)
make migrate    # alembic upgrade head (PACK_DATABASE_URL / alembic.ini)
make run        # uvicorn on :8309
make test       # pytest
make lint       # ruff
```

Database bootstrap: migrations create the non-privileged `pack_app` role and
enable RLS on every table. Create the runtime login per environment with
`CREATE USER <user> LOGIN PASSWORD '…' IN ROLE pack_app` and point
`PACK_DATABASE_URL` (asyncpg) at it — RLS binds only to non-superusers, keyed off
`set_config('app.tenant_id', …)` per request.

Settings via `PACK_*` env vars (`app/config.py`): JWT PEM/JWKS + issuer, the
Core service base URLs the installer calls (identity, rbac, dataset, semantic,
case, agent-runtime, chart, ingestion, decision, eval, memory), and the
registration credentials used to publish this service's action manifest to rbac
at startup.

## Architecture

```
app/
  main.py         app wiring + startup rbac action registration
  config.py       PACK_* settings (Core service URLs, JWT, DB)
  registration.py publishes the action MANIFEST to rbac-service on boot
  api/
    routes/       health, packs (catalog), installs (plan/execute/lifecycle)
    auth.py       vendored Principal / TokenVerifier / require(...)
    errors.py     shared error envelope
    middleware.py request context + tenant binding
  domain/
    catalog.py    reads the pack catalog LIVE from the packs/ dir (no catalog table)
    installer.py  the install saga: plan, run_install, run_data_chain (two-phase),
                  run_complete, uninstall, upgrade, rollback, drift
    errors.py     domain error taxonomy
  store/
    db.py         SQLAlchemy 2 async engine, RLS-bound unit of work
    repo.py       installs + materialized_objects (the origin-tagged ledger)
migrations/versions/
  0001_initial.py           installs + materialized_objects (+ RLS + grants)
  0002_install_lifecycle.py version lifecycle columns
tests/test_pack_service.py
```

## API surface

All routes forward the installing **user's** JWT (see Governance below).

| Method & path | Purpose |
|---|---|
| `GET /healthz`, `GET /readyz` | liveness / readiness |
| `GET /api/v1/packs` | list the pack catalog (read live from `packs/`) |
| `GET /api/v1/packs/{name}` | pack detail (declared components) |
| `POST /api/v1/installs` | `?dry_run=true` → a **plan** (create / exists / deferred / after_approval per object); otherwise **execute** the install saga into a workspace |
| `POST /api/v1/installs/{id}/complete` | finish a two-phase data-chain install after a distinct steward approves the submitted semantic models (real four-eyes) |
| `GET /api/v1/installs` | list installs |
| `GET /api/v1/installs/{id}` | install detail + the materialized-object ledger |
| `GET /api/v1/installs/{id}/drift` | compare materialized objects against the pack's current definition |
| `POST /api/v1/installs/{id}/upgrade` | install a newer pack version over an existing install |
| `POST /api/v1/installs/{id}/rollback` | revert to the previously installed version |
| `POST /api/v1/installs/{id}/uninstall` | reverse the install (revert where Core exposes a verb; tombstone honestly where it does not) |

## Governance model

pack-service makes **no security decisions of its own** — it runs an install *as
the installing user*:

- **User-JWT forwarding.** Every `ensure_*` call carries the caller's Bearer
  token, so Core services apply their normal RBAC/OPA checks. The installer can
  do only what the user is already allowed to do.
- **Four-eyes is preserved, not bypassed.** Semantic-service requires
  `submitted_by != approver`, and the installer forwards the user's own token —
  so it authors semantic models as **draft + submit** and stops. A *distinct*
  human steward approves them, then `POST /installs/{id}/complete` materializes
  the dependent dashboards. This is why data-chain installs are two-phase
  (`awaiting_approval` → `installed`).
- **Origin-tagged ledger.** Every object the install materializes is recorded in
  `materialized_objects` with its real Core id and the first reversing action, so
  uninstall/rollback are precise and honest about what Core can and cannot undo.
- **Reversibility varies by Core maturity (a real, documented finding).** Kinds
  with a revert verb (e.g. roles, saved queries, dashboards, entity types) are
  reversed on uninstall; kinds Core cannot delete (e.g. dispositions, decision
  tables) are **tombstoned** with a truthful note ("Core exposes no revert verb;
  retained") rather than faked.

## RBAC actions (registered with rbac-service at startup)

| Action | Grants |
|---|---|
| `pack.pack.read` | browse the pack catalog |
| `pack.install.read` | read installs + their ledger |
| `pack.install.execute` | install / uninstall / upgrade / rollback a pack into a workspace |

Granted to the built-in **Use case Admin** role. `app/registration.py` publishes
this manifest to rbac so the OPA projection recognizes the verbs.

## Component kinds

Materialization is delegated to `packctl`. All pack-authored component kinds are
supported end-to-end: `datasets`, `semantic_models`, `verified_queries`,
`saved_queries`, `dashboards`, `dispositions`, `roles`, `decision_models`,
`case_fields`, `display_labels`, `guardrails`, `agent_configs`, `cases`,
`memories`, `pipelines`, `eval_sets`, `model_archetypes`, `case_schemas`,
`ontology`, and `write_adapters`. Only `agent_recipes` (real LangGraph code) and
`connection_templates` (bring-your-own credentials) remain deferred — both
honestly hard, reported as `deferred` in the plan rather than faked.

## Test status

```
make test    12 passed
make lint    ruff: All checks passed!
```

The suite covers the catalog read, the dry-run plan (create / exists / deferred),
the install saga + ledger, two-phase data-chain gating (submit-without-approve,
then complete), and reversal. The full stack (UI → bff-graphql → pack-service →
Core) has been live-verified end-to-end: browse packs → plan → install →
inspect the ledger → uninstall → confirm reversed objects are gone from Core and
non-reversible ones are tombstoned.
