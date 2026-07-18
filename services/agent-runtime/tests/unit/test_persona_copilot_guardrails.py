"""persona-copilot guardrail envelope (BRD 53 inc2) — proves the shared graph
enforces the per-agent security policy INDEPENDENT of the prompt:

- PA-FR-040 data-scope: a case outside the agent's workspace scope is refused
  (empty read, logged refusal, no LLM call, no write intent) — additive to RLS.
- budget: the per-run output-token ceiling is clamped to the agent's
  max_tokens_per_session.
- pii: block_pii_egress redacts direct identifiers from everything the agent
  emits (answer + proposal rationale/summary).
"""

from __future__ import annotations

from app.adapters.fakes import FakeLlm, FakeMemory
from app.graphs.base import GraphDeps
from app.graphs.persona_copilot import run_persona_copilot
from tests.conftest import TENANT_A

# Rationale carries a raw email + SSN so the PII test has something to scrub.
_LLM_PII = ('{"severity": "high", "disposition_code": "deny_no_error_found", '
            '"rationale": "Cardholder jane.doe@example.com (SSN 123-45-6789) '
            'confirmed delivery."}')
_LLM_CLEAN = ('{"severity": "high", "disposition_code": "deny_no_error_found", '
              '"rationale": "Delivery confirmed to the address on file."}')


class _CaseReader:
    def __init__(self, workspace_id: str = "ws-1") -> None:
        self._ws = workspace_id

    async def get_case(self, *, tenant_id, case_id, auth_token) -> dict:
        return {"id": case_id, "severity": "medium", "workspace_id": self._ws}

    async def list_dispositions(self, *, tenant_id, auth_token) -> list[dict]:
        return [{"id": "disp-1", "code": "deny_no_error_found", "label": "Deny"}]


def _deps(prompt_params, guardrail_policy, *, llm_content=_LLM_CLEAN, case_ws="ws-1"):
    llm = FakeLlm(content=llm_content)
    deps = GraphDeps(
        llm=llm, memory=FakeMemory(results=[]), case_reader=_CaseReader(case_ws),
        prompt_params=prompt_params, guardrail_policy=guardrail_policy, obo_token="tok")
    return deps, llm


_PP = {"persona": "Analyst", "system_prompt": "Be conservative.",
       "propose_tool": "case.apply_disposition"}


async def test_data_scope_refuses_out_of_scope_case():
    # Agent scoped to ws-9; the case lives in ws-1 -> refused.
    deps, llm = _deps(_PP, {"data_scope": {"workspaces": ["ws-9"]}}, case_ws="ws-1")
    out = await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})

    assert out.write_intent is None                       # no proposal over unseen data
    assert out.structured.get("out_of_scope") is True
    assert "outside" in out.final_text.lower()
    assert llm.calls == []                                # never reached the model
    assert any(t.get("event") == "data_scope_refusal" for t in out.trace)


async def test_data_scope_allows_in_scope_case():
    deps, llm = _deps(_PP, {"data_scope": {"workspaces": ["ws-1"]}}, case_ws="ws-1")
    out = await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})

    assert out.structured.get("out_of_scope") is not True
    assert out.write_intent is not None
    assert out.write_intent.tool_id == "case.apply_disposition"
    assert len(llm.calls) == 1


async def test_empty_data_scope_is_unrestricted():
    # No workspaces listed -> the agent may read any case its RLS/caller allows.
    deps, _ = _deps(_PP, {"data_scope": {}}, case_ws="ws-7")
    out = await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})
    assert out.write_intent is not None


async def test_budget_clamps_output_tokens():
    deps, llm = _deps(_PP, {"budget": {"max_tokens_per_session": 150}})
    await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})
    assert llm.calls[0]["max_tokens"] == 150               # capped below the 300 default


async def test_budget_absent_uses_default_ceiling():
    deps, llm = _deps(_PP, {})
    await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})
    assert llm.calls[0]["max_tokens"] == 300


async def test_pii_egress_is_redacted():
    deps, _ = _deps(_PP, {"pii": {"block_pii_egress": True}}, llm_content=_LLM_PII)
    out = await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})

    # The proposal still forms, but no raw identifier leaves the graph.
    assert "jane.doe@example.com" not in out.final_text
    assert "123-45-6789" not in out.final_text
    wi = out.write_intent
    assert wi is not None
    assert "jane.doe@example.com" not in wi.rationale
    assert "123-45-6789" not in wi.rationale
    assert "[REDACTED:email]" in wi.rationale or "[REDACTED:ssn]" in wi.rationale


async def test_pii_off_leaves_text_intact():
    deps, _ = _deps(_PP, {}, llm_content=_LLM_PII)
    out = await run_persona_copilot(deps, {"tenant_id": TENANT_A, "case_id": "c-1"})
    # No pii policy -> the rationale flows through unredacted (redaction is opt-in).
    assert "jane.doe@example.com" in out.write_intent.rationale
