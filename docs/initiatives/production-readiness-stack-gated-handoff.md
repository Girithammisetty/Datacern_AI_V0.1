# Production-readiness: stack-gated work — handoff for a Docker-capable session

This container has the docker binary but **no daemon** (`docker ps` → cannot
connect to `/var/run/docker.sock`), so the tasks below could not be *executed*
here. Each is scoped and its harness prepared; run them against a booted stack
(`deploy/local/up.sh`, which needs the compose infra + a real local Ollama).

## Blocked purely on a running stack

| Task | Deliverable | How to run |
|---|---|---|
| Load & soak (#20) | p95 per hero surface at 50 concurrent users | `deploy/local/soak.sh` + `soak_volume.sh` against the booted stack; capture p95 for worklist / case-detail / copilot-run / approval; file regressions as follow-ups |
| Unattended runs (#24) | Temporal-scheduled agent runs, retrain watches, governance-agent firing solid | `deploy/e2e/driver.py` unattended journey; diagnose the degraded legs (docs/WHAT_DATACERN_IS.md flags them); stability-durability initiative also needs its "infra recreate" live-green |
| Pack fleet install (#25) | Recorded v2.1.0 installs for the 27 packs beyond card-disputes | `packs/install_packs_multitenant.py` + `onboard_pack_tenant.py`; fix any refusal beyond honest binding-contract refusals |
| Memory/context posture (#26) | Right-to-erasure cascade + verification report on real pgvector; retention/expiry drill; corpus rebuild under load | memory-service integration tier + the new /admin/memory console |
| Observability drill (#23) | Live pending→firing evidence | `deploy/observability/drill.sh` (self-contained throwaway Prometheus) |
| Cross-tenant probe re-run (#22) | Fresh PASS evidence incl. the 2 new campaign surfaces | `python deploy/security/cross_tenant_authz_probe.py` (extended this session, syntax-verified) |

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
