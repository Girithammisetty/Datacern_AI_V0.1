"""/internal/v1/mcp/invoke — the MCP backend facade tool-plane federates
approved ``experiment.model.promote`` proposals to (BRD 52 / TPL-FR-012).
Verifies: SPIFFE gate, per-tool action re-check for the effective human,
happy-path pending-promotion creation, and honest 4xx bodies (which the
gateway's backend_rejected path now surfaces verbatim to the agent)."""

from __future__ import annotations

from tests.conftest import TENANT_A, ctx_for, make_experiment, seed_finished_run

GATEWAY_SPIFFE = "spiffe://windrose/ns/tools/sa/mcp-gateway"
HDR = {"x-client-spiffe-id": GATEWAY_SPIFFE}


class GrantOboUpdate:
    """Authz double for the LIVE behavior: the rbac projection grants the
    EFFECTIVE HUMAN (obo_sub) experiment.model.update — the gateway principal
    itself carries no scopes (as in production)."""

    async def allow(self, principal, action, resource_urn):
        return action == "experiment.model.update" and principal.obo_sub == "user-1"


async def _registered_model(container):
    ctx = ctx_for()
    exp = await make_experiment(container, ctx, name="exp-mcp")
    run = await seed_finished_run(container, ctx, exp.id, mlflow_run_id="run-mcp",
                                  metrics={"f1_score": 0.9}, params={})
    result = await container.registry_service.register(ctx, exp.id, run.id,
                                                       {"model_name": "mcp-model"})
    return result["model_id"], result["version"]


def _body(model_id, version, **over):
    body = {"tool_id": "experiment.model.promote", "version": "1.0.0",
            "tenant": TENANT_A, "obo_sub": "user-1", "agent_id": "ml-engineer",
            "args": {"model_id": model_id, "version": version,
                     "target_stage": "staging", "rationale": "evidence…"}}
    body.update(over)
    return body


async def test_mcp_invoke_requires_allowed_spiffe(client, container):
    model_id, version = await _registered_model(container)
    r = await client.post("/internal/v1/mcp/invoke", json=_body(model_id, version),
                          headers={"x-client-spiffe-id": "spiffe://evil/ns/x/sa/y"})
    assert r.status_code == 403


async def test_mcp_invoke_denies_obo_human_without_action(client, container):
    """Default memory authz grants the gateway principal nothing — the route's
    defense-in-depth re-check must 403 with the honest action name."""
    model_id, version = await _registered_model(container)
    r = await client.post("/internal/v1/mcp/invoke", json=_body(model_id, version),
                          headers=HDR)
    assert r.status_code == 403
    assert "experiment.model.update" in r.json()["output"]["error"]


async def test_mcp_invoke_creates_pending_promotion(client, container, app):
    app.state.authz = GrantOboUpdate()
    model_id, version = await _registered_model(container)
    r = await client.post("/internal/v1/mcp/invoke", json=_body(model_id, version),
                          headers=HDR)
    assert r.status_code == 200, r.text
    out = r.json()["output"]
    assert out["promotion_id"] and out["status"] == "pending"
    # The promotion is PENDING — experiment-service four-eyes still governs it;
    # its requester is the effective human (dual attribution via agent).
    promo = await container.promotion_service.decide(
        ctx_for(sub="second-reviewer"), out["promotion_id"], "approve")
    assert promo["status"] == "approved"


async def test_mcp_invoke_unknown_tool_404(client, container):
    model_id, version = await _registered_model(container)
    r = await client.post("/internal/v1/mcp/invoke",
                          json=_body(model_id, version, tool_id="experiment.nuke"),
                          headers=HDR)
    assert r.status_code == 404


async def test_mcp_invoke_missing_arg_422(client, container, app):
    app.state.authz = GrantOboUpdate()
    model_id, version = await _registered_model(container)
    body = _body(model_id, version)
    del body["args"]["target_stage"]
    r = await client.post("/internal/v1/mcp/invoke", json=body, headers=HDR)
    assert r.status_code == 422
    assert "target_stage" in r.json()["output"]["error"]
