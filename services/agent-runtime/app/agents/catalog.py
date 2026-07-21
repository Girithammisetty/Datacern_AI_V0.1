"""Agent catalog seed (ART-FR-040): the 8 agent definitions, with real published
v1 graphs for the priority agents (case-triage, governance, analytics). Adding an
agent is a definition + graph module — no runtime fork.
"""

from __future__ import annotations

from app import prompts
from app.domain.entities import AgentDefinition, AgentVersion
from app.graphs.base import graph_digest
from app.signing import build_card, sign_card

# key -> (display, description, write_mode, graph_ref|None, skills)
CATALOG = {
    "case-triage": ("Case Triage Copilot",
                    "Proposes claim dispositions (severity/assignee/disposition) grounded in "
                    "case data + resolved-case RAG.", "proposal", "triage.v1",
                    [{"id": "triage_claim", "description": "Propose a disposition for a claim case",
                      "tags": ["claims", "triage", "proposals"]}]),
    "governance": ("Governance Agent",
                   "Opens retrain proposals when drift/correction signals exceed thresholds.",
                   "proposal", "governance.v1",
                   [{"id": "open_retrain", "description": "Propose a model retrain",
                     "tags": ["mlops", "governance", "proposals"]}]),
    "analytics": ("Analytics Agent",
                  "Conversational analytics over governed semantic-layer data. Read-only.",
                  "read_only", "analytics.v1",
                  [{"id": "answer_data_question", "description": "Answer NL data questions",
                    "tags": ["analytics", "read-only"]}]),
    "onboarding": ("Onboarding Agent",
                   "Proposes ingestion configs and column mappings grounded in the "
                   "connector catalog + source schema preview + prior-onboarding RAG.",
                   "proposal", "onboarding.v1",
                   [{"id": "onboard_source",
                     "description": "Propose an ingestion config + column mapping for a source",
                     "tags": ["ingestion", "onboarding", "proposals"]}]),
    "dashboard-designer": ("Dashboard Designer",
                           "Proposes draft dashboards (a title + charts) grounded in the governed "
                           "semantic layer (measures/dimensions) + the chart-type catalog.",
                           "proposal", "dashboard_designer.v1",
                           [{"id": "design_dashboard",
                             "description": "Propose a draft dashboard with charts over "
                                            "the semantic layer",
                             "tags": ["insights", "dashboards", "proposals"]}]),
    "model-training": ("Model Training Agent",
                       "Proposes governed training runs: fills a pipeline template "
                       "(algorithm, hyperparameters, label/feature columns) grounded in the "
                       "algorithm-template schema + prior experiment history.",
                       "proposal", "model_training.v1",
                       [{"id": "train_model",
                         "description": "Propose a training run for an algorithm on a dataset",
                         "tags": ["mlops", "training", "proposals"]}]),
    "ml-engineer": ("ML Engineer Agent",
                    "Autonomously runs the data-science loop on a governed dataset: "
                    "inspects the schema, trains candidate models via sandboxed "
                    "pipeline runs, compares real metrics, and PROPOSES the winning "
                    "model's promotion (four-eyes; never promotes directly).",
                    "proposal", "ml_engineer.v1",
                    [{"id": "build_and_propose_model",
                      "description": "Train candidate models on a dataset and propose "
                                     "promoting the best one",
                      "tags": ["mlops", "training", "promotion", "proposals"]}]),
    "inference": ("Inference Agent",
                  "Proposes batch inference jobs grounded in the registered model's "
                  "production version + input-dataset schema compatibility.",
                  "proposal", "inference.v1",
                  [{"id": "run_inference",
                    "description": "Propose a batch inference job",
                    "tags": ["inference", "mlops", "proposals"]}]),
    "meta-router": ("Meta Router",
                    "Classifies a free-text request and delegates to the specialist "
                    "agent whose skill matches (analytics/onboarding/model-training/"
                    "inference/dashboard-designer/governance); the delegate's own "
                    "write mode governs whether a proposal results.",
                    "proposal", "meta_router.v1",
                    [{"id": "route_request",
                      "description": "Classify and delegate a request to the "
                                     "matching specialist agent",
                      "tags": ["routing", "meta", "delegation"]}]),
}


def _prompt_refs(key: str) -> list[dict]:
    """Real immutability ref for the agent's system prompt from the prompt
    registry (id + semantic version + sha256 content digest) — replaces the old
    faked ``digest: "seed"``. An agent with no registered prompt (should not
    happen for a published catalog agent) falls back to an explicit unregistered
    marker rather than a silent fake."""
    pid = prompts.AGENT_SYSTEM_PROMPT.get(key)
    if pid is None:
        return [{"id": f"{key}-sys", "version": 0, "digest": "unregistered"}]
    return [prompts.get(pid).ref]


def _toolset_ids(toolset) -> set[str]:
    return {str(t.get("tool_id")) for t in (toolset or []) if t.get("tool_id")}


async def _publish_agent_version(store, signing_key, key, version, display, desc,
                                 wmode, graph_ref, skills, toolset, endpoint_base) -> None:
    """Publish one fixed-agent version (v1 seed OR a toolset-bump v(N+1))."""
    card = build_card(agent_key=key, version=version, display_name=display, description=desc,
                      write_mode=wmode, skills=skills, endpoint=f"{endpoint_base}/a2a/{key}")
    signature = sign_card(signing_key, card)
    card["signature"] = {"alg": "RS256", "kid": signing_key.kid, "value": signature}
    await store.create_agent_version(AgentVersion(
        agent_key=key, version=version, graph_ref=graph_ref, graph_digest=graph_digest(graph_ref),
        prompt_refs=_prompt_refs(key), toolset=toolset,
        model_config={"request_class": "chat", "max_rung": 1, "temperature": 0.2},
        memory_policy={"scopes_readable": ["workspace", "tenant"], "scopes_writable": []},
        eval_gate={"suite_id": f"{key}-suite", "baseline_version": 0,
                   "thresholds": {"min_score": 0.6}},
        eval_gate_result_id="seed-gate-pass",
        a2a_card=card, card_signature=signature,
        principal_ref=f"spiffe://datacern/ns/ai/agent/{key}", status="published"))


async def seed_catalog(store, signing_key, *,
                       endpoint_base: str = "https://agent-runtime.internal") -> None:
    for key, (display, desc, wmode, graph_ref, skills) in CATALOG.items():
        await store.upsert_agent_definition(AgentDefinition(
            agent_key=key, display_name=display, description=desc, owner_team="platform-ai",
            default_write_mode=wmode,
            status="published" if graph_ref else "draft"))
        if graph_ref is None:
            continue
        toolset = ([{"tool_id": "case.apply_disposition", "version_range": ">=1.0.0"}]
                   if key == "case-triage" else
                   [{"tool_id": "mlops.open_retrain", "version_range": ">=1.0.0"}]
                   if key == "governance" else
                   [{"tool_id": "ingestion.create", "version_range": ">=1.0.0"}]
                   if key == "onboarding" else
                   [{"tool_id": "chart.dashboard.create", "version_range": ">=1.0.0"}]
                   if key == "dashboard-designer" else
                   [{"tool_id": "pipeline.template.create_from_algorithm",
                     "version_range": ">=1.0.0"}]
                   if key == "model-training" else
                   # ml-engineer promotes models AND (BRD 52 inc2) may initiate an
                   # ingestion from an existing connection to refresh training data.
                   [{"tool_id": "experiment.model.promote", "version_range": ">=1.0.0"},
                    {"tool_id": "ingestion.create", "version_range": ">=1.0.0"}]
                   if key == "ml-engineer" else
                   [{"tool_id": "inference.submit", "version_range": ">=1.0.0"}]
                   if key == "inference" else
                   # meta-router forwards whichever delegate produced the write
                   # intent (§8.4); it needs the union of delegate write tools so
                   # its own agent_version registration stays a truthful superset.
                   [{"tool_id": "ingestion.create", "version_range": ">=1.0.0"},
                    {"tool_id": "chart.dashboard.create", "version_range": ">=1.0.0"},
                    {"tool_id": "pipeline.template.create_from_algorithm",
                     "version_range": ">=1.0.0"},
                    {"tool_id": "inference.submit", "version_range": ">=1.0.0"},
                    {"tool_id": "mlops.open_retrain", "version_range": ">=1.0.0"}]
                   if key == "meta-router" else [])

        # A published agent_version is IMMUTABLE (DB-enforced). To change a fixed
        # agent's enforced toolset (e.g. BRD 52 inc2 adds ingestion.create to
        # ml-engineer) we publish a NEW version carrying the updated toolset —
        # never mutate a published one. Runs resolve the latest published version,
        # so the change takes effect for new sessions. Idempotent: once the latest
        # version's toolset matches the code, no further versions are minted.
        latest_v = await store.latest_published_version(key)
        if latest_v is not None:
            latest = await store.get_agent_version(key, latest_v)
            if latest is not None and _toolset_ids(latest.toolset) != _toolset_ids(toolset):
                await _publish_agent_version(store, signing_key, key, latest_v + 1,
                                             display, desc, wmode, graph_ref, skills,
                                             toolset, endpoint_base)
            continue
        await _publish_agent_version(store, signing_key, key, 1, display, desc, wmode,
                                     graph_ref, skills, toolset, endpoint_base)
