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

## Larger builds (do in a worktree, verify against the stack)

- **ClickHouse HA (#21)** — BRD 58 WS4 B9/B10: replicated tables + keeper in
  `deploy/clickhouse` + helm, stateless-service horizontal-scaling proof, the
  ops-resilience drill in `docs/initiatives/clickhouse-ha-and-ops-resilience.md`.
- **BRD 55 remaining legs (#27)** — OM-FR-030 decision-drift detection
  (proposal-mode review on effectiveness drop, AC-3), OM-FR-040 SFT enrichment
  with outcome-labeled examples (AC-4), and SoR inbound outcome capture. All in
  agent-runtime + eval-service; the outcome-label write path + effectiveness
  read are already built and wired to the UI this session (the /decisions
  outcome surfaces), so these extend a live base.

## Done and pushed this session (executable-here work)

All 17 service→BFF→UI gap clusters (coverage 73%→97%, 119→20 unreachable
routes), the agentic security pass (adversarial review + 3 proxy fixes +
probe extension), and Layer-B hygiene. BFF vitest 421 / ui-web vitest 659,
all green; SDL snapshot regenerated each merge.
