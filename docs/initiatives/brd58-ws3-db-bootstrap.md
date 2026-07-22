# BRD 58 WS3 — Postgres DB/role bootstrap job

**Status:** done — 2026-07-22
**Related:** [58_production_hardening_BRD.md](../brd/58_production_hardening_BRD.md) WS3

Filed as a standalone initiative doc rather than appended directly to
`docs/brd/58_production_hardening_BRD.md`, which has had concurrent
in-flight edits from a parallel session throughout this work — fold this in
(flip WS3's "DB/role bootstrap job" checklist item to `[x]`) the next time
that file is safely editable.

---

## 1. Analysis

**Researched before writing anything** (not assumed from the BRD's own
wording, which describes an aspirational design that turned out not to match
reality):

- **Only Hetzner and local dev actually create the ~20 per-service
  databases** — a plain (non-Helm) `batch/v1` Job,
  `deploy/k8s/data-tier/postgres-createdbs.yaml`, loops over the DB list and
  guard-creates each with `createdb`; `deploy/local/up.sh` does the identical
  thing for pure local dev. Neither AWS, GCP, nor Azure's Helm deploy has an
  equivalent.
- **AWS's Terraform creates zero per-service databases or roles** —
  `deploy/terraform/aws/rds.tf`'s own comment describes an aspirational
  design ("migration jobs run `CREATE DATABASE` ... using
  `POSTGRES_APP_PASSWORD_<DB>`") that was never actually implemented:
  grepping the whole repo for `POSTGRES_APP_PASSWORD` hits only that comment
  and its GCP counterpart, never any real Helm template, values file, or
  service code.
- **GCP/Azure's Terraform DO create the databases** (`google_sql_database`,
  `azurerm_postgresql_flexible_server_database`, both `for_each` over a
  `databases`/`postgres_databases` variable) — but not the roles, same gap
  as AWS.
- **Every service's own migration already creates its own login role**,
  idempotently, with `NOSUPERUSER NOBYPASSRLS` — this part already works
  correctly on every cloud via the existing `migrate-job.yaml` hook
  (hook-weight `-5`). The missing piece is narrower than "roles are
  missing everywhere" — it's specifically "the *database* a migration would
  connect to doesn't exist yet on a fresh AWS instance, and isn't
  role-bootstrapped anywhere but Hetzner/local."
- **One genuine, already-known exception**: `semantic-service`'s migration
  creates only a `NOLOGIN` group role (`semantic_app`); the actual login role
  (`semantic`) is created by neither Alembic nor golang-migrate anywhere —
  only by the Hetzner/local Job. This is the one case with no per-service
  migration to defer to.
- **A real gotcha found while reading every service's role-creation SQL**:
  most migrations use `IF EXISTS THEN ALTER ... ELSE CREATE` (self-correcting
  on every re-run, including the password), but two
  (`usage-service`, `notification-service`) use `IF NOT EXISTS THEN CREATE`
  only — if a role with that name already existed with a *different*
  password, these two would never fix it. This directly shaped the design
  below: a bootstrap job must never create a login role with a password that
  could differ from what a service's own migration expects.

## 2. Design

A new Helm hook Job, `templates/bootstrap-job.yaml`, at hook-weight `-10`
(strictly before `migrate-job.yaml`'s `-5`), disabled by default
(`postgresBootstrap.enabled`, same opt-in convention as
`observability.serviceMonitor`/`prometheusRule`).

**Deliberately narrow scope, not the aspirational "create everything"
design**: the Job creates ONLY the per-service databases + the 6 `pgvector`
extensions + the one `semantic` login-role exception — ported verbatim from
the already-proven-correct `postgres-createdbs.yaml` script, not
reinvented. It does **not** create the other ~20 services' login roles at
all, on purpose: that's already `migrate-job.yaml`'s job, and given the
`usage-service`/`notification-service` non-self-correcting gotcha above,
having two different places create the same role with potentially different
passwords is a real footgun, not a redundant safety net. Duplicating 20
role-name/password pairs into `values.yaml` would also be a pure
transcription-risk with no corresponding benefit.

Admin credentials: composes a DSN from `POSTGRES_HOST`/`POSTGRES_PORT`/
`POSTGRES_ADMIN_USER`/`POSTGRES_ADMIN_PASSWORD` — four keys already declared
in `values.yaml`'s `externalSecrets.keys` but previously marked
"informational" (nothing in the chart actually used them). This Job is the
first real consumer.

## 3. Implementation & Test

`deploy/helm/datacern/templates/bootstrap-job.yaml` (new), `values.yaml`
(+`postgresBootstrap` block: `enabled: false`, `image: postgres:16-alpine`,
the 21-database list and 6-database pgvector list, both copied verbatim from
`postgres-createdbs.yaml`; updated the `POSTGRES_ADMIN_*` key comment since
they're no longer merely informational).

**Test:**
- `helm lint` clean.
- `helm template` verified with the flag both off (renders nothing) and on
  (renders exactly 1 Job, at hook-weight `-10`, strictly before all 11
  `migrate-job.yaml` Jobs at `-5`) — confirmed by parsing the rendered YAML
  back with a real YAML parser, not just grepping.
- Re-verified both states across all four cloud overlays
  (`values-aws/gcp/azure/hetzner.yaml`) — all render clean.
- Extracted the shell script this pod actually creates, ran `sh -n` for a
  syntax check.
- **Live-verified end to end against a real, genuinely-empty Postgres
  instance** (a throwaway `pgvector/pgvector:pg16` Docker container — the
  same image the platform's own data tier uses, not a plain `postgres`
  image, since `CREATE EXTENSION vector` needs the extension binary
  present): ran the exact rendered script, confirmed all 21 databases were
  created from nothing, all 6 `pgvector` extensions installed, and the
  `semantic`/`semantic_app` role special case landed correctly
  (`semantic_app`: `NOLOGIN`; `semantic`: `LOGIN`, neither superuser nor
  bypassrls). Re-ran the identical script a second time against the same
  now-populated instance and confirmed full idempotency (every `CREATE
  DATABASE` guard skips, `CREATE EXTENSION IF NOT EXISTS` emits a harmless
  "already exists" notice, the role `DO` block's `IF NOT EXISTS` guards
  skip). Scratch container removed after verification.

**Explicitly not done, and why (flagged honestly):** the per-service
login-role hardcoded-password issue found during research (every service's
migration hardcodes its role's password as a literal with no env-var
override, on every cloud including Hetzner/local) is real but out of this
Job's scope — fixing it means patching ~20 migration files' SQL to accept a
password parameter, a separate, larger, cross-cutting change. Applying this
Job's own migration-hook-weight pattern to a fresh AWS/GCP/Azure cluster and
watching a real install succeed end-to-end remains resource-gated (needs a
real cloud account), the same class of limitation as this BRD's earlier
B9/B10 Terraform work.
