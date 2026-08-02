# Production-readiness: stack-gated work — handoff for a Docker-capable session

This container has the docker binary but **no daemon** (`docker ps` → cannot
connect to `/var/run/docker.sock`), so the tasks below could not be *executed*
here. Each is scoped and its harness prepared; run them against a booted stack
(`deploy/local/up.sh`, which needs the compose infra + a real local Ollama).

## Code/tooling built this session; only the LIVE run remains

| Task | Built + verified here | Live run that remains |
|---|---|---|
| Load & soak (#20) | **`deploy/local/load_test.py`** — concurrent-VU driver (ramp → target, per-step p50/p95/p99 + error rate + throughput, SLO gate, read-only). `--self-test` passes here (percentile/roll-up/ramp math). | `python deploy/local/load_test.py --users 50 --duration 60` against a booted stack; capture p95 per surface; `soak.sh`/`soak_volume.sh` for restart survival |
| Unattended runs (#24) | Retrain-scheduler replica-safety fix (`FOR UPDATE SKIP LOCKED` claim, unit-verified) — the primary degraded leg. | `deploy/e2e/driver.py` unattended journey + the stability-durability infra-recreate live-green |
| Pack fleet install (#25) | **`packctl coherence` run: 28 packs + 4 bundles, 0 errors/0 warnings** (offline C1–C11). | `packs/install_packs_multitenant.py` for recorded v2.1.0 installs (live binding-contract resolution) |
| Memory/context (#26) | Erasure verification-GATE failure test — **caught + fixed a real bug** (failed sweep was emitting `erasure.completed`). memory unit tier 45 green. | erasure/retention/rebuild against live pgvector (integration tier) |
| Observability drill (#23) | 10 alert rules + PrometheusRule CRD + drill script already built. | `deploy/observability/drill.sh` (throwaway Prometheus) for live pending→firing |
| Cross-tenant probe (#22) | Probe extended with the 2 new campaign surfaces, syntax-verified. | `python deploy/security/cross_tenant_authz_probe.py` for fresh PASS evidence |

## Code/config portions now DONE (verify live when a stack exists)

- **ClickHouse HA (#21)** — manifests built + helm-lint-validated; the
  retrain-scheduler replica blocker is CLOSED in code (`FOR UPDATE SKIP LOCKED`
  claim, unit-verified). **Stack-gated remainder:** raft-quorum + failover on a
  multi-node cluster (kind/k3d), and a live-Postgres confirmation before the
  `replicas: 2` bump is enabled.
- **BRD 55 legs (#27)** — OM-FR-030 drift detection (AC-3) and OM-FR-040 SFT
  enrichment (AC-4) BUILT + unit-verified + wired to the effectiveness panel.
  **Stack-gated remainder:** SoR inbound outcome capture (needs the live
  write-back / connection rails).

## Done and pushed this session (executable-here work)

All 17 service→BFF→UI gap clusters (coverage 73%→97%, 119→20 unreachable
routes), the agentic security pass (adversarial review + 3 proxy fixes +
probe extension), and Layer-B hygiene. BFF vitest 421 / ui-web vitest 659,
all green; SDL snapshot regenerated each merge.
