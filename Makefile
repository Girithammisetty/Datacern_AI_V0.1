SERVICES := $(wildcard services/*)

.PHONY: dev-up dev-down test test-unit lint e2e e2e-keep up up-platform down reset doctor soak soak-volume \
        journey journey-forms journey-packs journey-fhir demo-list demo-load demo-clean demo-clean-all security-probe

# Capstone: provision the WHOLE platform locally and open it in a browser for
# hands-on end-user testing. Preflight -> infra -> migrate+boot all 22 services
# -> platform seed (tenant, 4 RBAC-gated personas) -> claims-vertical demo seed
# (claims dataset, triage queue, a pending proposal, a trained+promoted model)
# -> print a banner with the URL + logins.
#   make up                        full platform + claims demo
#   make up ARGS=--core             RAM-constrained: documented claims-showcase profile
#   make up ARGS=--platform-only    tenant + personas only, no vertical demo data
up:
	deploy/local/up.sh $(ARGS)

# Boot the platform with NO vertical demo data seeded THIS boot (tenant +
# personas only), then load exactly the pack you want with `demo-load`.
# NOTE: this does not remove data already in the DBs — use `make reset` for that.
up-platform:
	deploy/local/up.sh --platform-only $(ARGS)

# Stop every native service. `make down ARGS=--infra` also stops Docker infra.
down:
	deploy/local/down.sh $(ARGS)

# TRUE clean slate: delete ALL persistent data (drops the Docker data volumes
# that survive `make down`) so the next `make up` starts genuinely empty. Wipes
# every tenant/case/dataset/model/dashboard/audit record. Prompts unless FORCE=1.
#   make reset            # confirm, then wipe
#   make reset FORCE=1    # no prompt
reset:
	FORCE=$(FORCE) deploy/local/reset.sh

# Health doctor: detect the "fragile after a restart" failure class (lost data
# volumes / unbuilt projections) before it bites, per active tenant.
#   make doctor           # check only (read-only)
#   make doctor HEAL=1    # check, then rebuild any missing projections
doctor:
	HEAL=$(HEAL) deploy/local/doctor.sh

# Restart-survival soak: with the stack up, prove it survives an infra restart
# with data + projections intact (baseline doctor GREEN -> restart stateful
# containers, volumes preserved -> doctor must STILL be GREEN). Catches any
# ephemeral-store / lost-projection regression. Run `make up` first.
soak:
	deploy/local/soak.sh

# Volume/load soak (WS5, BRD 58): proves B1 (streaming Iceberg commit) and B5
# (bulk case-service reindex) hold at real row-count scale, not just their
# own small unit-test fixtures. Runs go test/pytest directly (testcontainers +
# the real dev Iceberg/MinIO) — does not need `make up` first.
#   make soak-volume                     # 100k rows, ~10s
#   make soak-volume VOLUME_ROWS=1000000 # the BRD's literal 1M-row scale, ~90s
soak-volume:
	VOLUME_ROWS=$(VOLUME_ROWS) deploy/local/soak_volume.sh

# Governed write loop: does an APPROVED AI decision actually change the row?
# The one check that would have caught the 2026-07-26 defect, where the whole
# flagship loop was dead (case.apply_disposition unregistered -> every approved
# disposition silently dropped) while 1538 unit tests and 63 CI checks were all
# green. They check components; this checks the JOURNEY, and asserts on STATE
# rather than on the platform's own "approved" acknowledgement. Needs `make up`.
journey:
	deploy/e2e/.venv/bin/python deploy/e2e/test_governed_write_loop.py

# Realtime-case-streams add-on journey (docs/initiatives/realtime-case-streams-
# addon.md, slice 6): entitlement gate -> commercial grant -> one-call composed
# stream -> watermark-incremental pull -> department worklist gains a case with
# intake-snapshot evidence -> the OTHER department 404s on all of it -> lapse
# re-gates resume but never pause. Asserts on STATE (rows, evidence bytes,
# boundary 404s), same rule as `make journey`. Needs `make up`.
journey-streams:
	deploy/e2e/.venv/bin/python deploy/e2e/test_case_stream_journey.py

# Learn-flywheel journey (learning-loop slice 7): 24 governed resolutions ->
# labeled_examples -> real random_forest training run -> four-eyes promotion
# (self-approval rejected) -> the approved stage lands in the MLflow registry
# with no harness bridging -> batch scoring with auto_case -> cases exist for
# EXACTLY the model-flagged rows. Asserts on STATE (Postgres rows, registry
# stages, output parquet bytes). Needs `make up`.
journey-learn:
	deploy/e2e/.venv/bin/python deploy/e2e/test_learn_journey.py

# Schema-driven forms journey (schema-driven-forms-addon slice 5): a customer
# declares typed intake fields with layout hints -> the bff serves them to a
# renderer unchanged (required hoisted, group/order/widget intact) -> a wrong
# type / undeclared key / missing required are each REFUSED and write nothing ->
# real ai-gateway drafting returns typed suggestions inside the catalog and
# writes nothing -> the human's submit stores EXACTLY what was sent -> the draft
# is metered on the caller's tenant. Asserts on STATE (catalog rows, the served
# form model, custom_fields JSONB, request_log). Needs `make up`.
journey-forms:
	deploy/e2e/.venv/bin/python deploy/e2e/test_forms_journey.py

# Pack conformance journey: does INSTALLING a vertical pack actually change the
# platform? `packctl lint` and `packctl coherence` both check FILES — a pack
# with a perfect manifest whose installer no-ops passes both. This installs
# payer-fwa-siu into a fresh tenant and asserts on Core's rows: SKU gate refuses
# and materializes nothing -> dry run materializes nothing -> install lands real
# case_fields/dispositions/roles rows (incl. the pack's intake-form layout) ->
# drift goes RED when a human edits one object -> uninstall really deletes what
# Core can delete and honestly retains what it cannot. Needs `make up`.
journey-packs:
	deploy/e2e/.venv/bin/python deploy/e2e/test_packs_journey.py

# Governed FHIR journey (fhir-bridge next slice): the tenant's clinical system
# of record changes ONLY through the governed loop. Runs its own in-process
# FHIR R4 sandbox as the system of record, connects it as the tenant backend
# via the bridge's REST API (secret to Vault; /test ok:true proves the bridge
# attached the bearer, since the sandbox 401s everything else), then: governed
# READ returns the actual patient -> an UNGRANTED write and a FORGED-grant
# write are both refused (proposal_required) with the store byte-for-byte
# unchanged -> the legitimately-signed grant lands EXACTLY ONE new resource
# with the approved fields -> read + refusals + execution all present in
# tool-plane's invocation_log. Asserts on STATE (the sandbox's own bytes,
# audit rows), same rule as `make journey`. Needs `make up`.
journey-fhir:
	deploy/e2e/.venv/bin/python deploy/e2e/test_fhir_journey.py

# ---- Demo pack control -----------------------------------------------------
# Load ONE vertical pack (+ its demo data + per-role logins) into a throwaway
# `wr-demo-<pack>` tenant for a demo, then tear it down cleanly afterwards. The
# main `demo.datacern` tenant is never touched. Needs the stack up (`make up`).
#   make demo-list                       # packs you can load + demos loaded now
#   make demo-load PACK=card-disputes    # spin up wr-demo-card-disputes
#   make demo-clean PACK=card-disputes   # tear it down
#   make demo-clean-all                  # tear down every wr-demo-* tenant
demo-list:
	@packs/demo.sh list

demo-load:
	@[ -n "$(PACK)" ] || { echo "usage: make demo-load PACK=<pack>  (see: make demo-list)"; exit 2; }
	@packs/demo.sh load $(PACK)

demo-clean:
	@[ -n "$(PACK)" ] || { echo "usage: make demo-clean PACK=<pack>  (see: make demo-list)"; exit 2; }
	@packs/demo.sh clean $(PACK)

demo-clean-all:
	@packs/demo.sh clean-all

# Repo-level end-to-end proof: boots the full real stack (infra + every money-path
# service, no fakes in the path) and drives the insurance claims triage-and-governance
# journey with real evidence at each step (real MinIO/Iceberg object, real Ollama
# tokens + rationale, forged-grant rejection, real case.disposition_applied Kafka
# event, real RAG chunk in pgvector). Stops services on exit; leave infra up.
e2e:
	deploy/e2e/run.sh

# Same, but leave all services running afterward (for inspection).
e2e-keep:
	deploy/e2e/run.sh --no-teardown

# Cross-tenant authorization probe ("pen-test-lite", BRD 58 production-
# readiness gap "no external pen test"): mints narrow-scoped tokens for two
# REAL, already-seeded tenants and, purely over HTTP (no service code or DB
# touched), tries to read/list/write tenant A's real resources with tenant
# B's token across case-service/dataset-service/pipeline-orchestrator/
# audit-service. Prints real HTTP status codes; exits non-zero on any leak.
# Needs the stack up (`make up`). See docs/initiatives/cross-tenant-authz-probe.md.
security-probe:
	deploy/e2e/.venv/bin/python deploy/security/cross_tenant_authz_probe.py

dev-up:
	docker compose -f deploy/docker-compose.dev.yml up -d

dev-down:
	docker compose -f deploy/docker-compose.dev.yml down

test:
	@set -e; for s in $(SERVICES); do \
		if [ -f $$s/Makefile ]; then echo "=== $$s ==="; $(MAKE) -C $$s test; fi; \
	done

test-unit:
	@set -e; for s in $(SERVICES); do \
		if [ -f $$s/Makefile ]; then echo "=== $$s ==="; $(MAKE) -C $$s test-unit; fi; \
	done

lint:
	@set -e; for s in $(SERVICES); do \
		if [ -f $$s/Makefile ]; then echo "=== $$s ==="; $(MAKE) -C $$s lint || true; fi; \
	done
