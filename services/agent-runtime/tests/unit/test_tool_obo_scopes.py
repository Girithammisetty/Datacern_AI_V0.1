"""The agent_obo scope model for a tool call (BRD 74 AC-10).

`mint_tool_obo` is the one sanctioned constructor for the token a tool call
carries. A read tool whose registered version DECLARES downstream actions gets a
token that names them, so tool-plane can delegate it to that tool's backend
facade; everything else gets exactly `scopes=[tool_id]`, as before.

The security properties under test:

  * only READ actions can ever end up in a delegated token — a write can never
    ride a forwarded bearer, it still needs the signed, human-approved grant;
  * no wildcard — a `*` token is precisely what tool-plane refuses to delegate;
  * the write path's token is UNCHANGED by this feature (`scopes == [tool_id]`),
    which is what keeps the blast radius of delegation to declaring tools only.
"""

from __future__ import annotations

import jwt as pyjwt
import pytest

from app.container import build_container
from app.domain.entities import Run, new_uuid
from app.graphs.base import WriteIntent
from app.signing.tokens import TokenMinter
from tests.conftest import TENANT_A, make_settings

ISSUER = "https://identity.datacern.local"
AUDIENCE = "datacern"


def _minter(key) -> TokenMinter:
    return TokenMinter(key, issuer=ISSUER, audience=AUDIENCE)


def _claims(key, token: str) -> dict:
    return pyjwt.decode(token, key.public_pem, algorithms=["RS256"],
                        issuer=ISSUER, audience=AUDIENCE)


def _mint(minter, **kw):
    base = dict(tenant_id=TENANT_A, obo_sub="u-77", agent_key="search",
                agent_version=1, tool_id="search.query")
    base.update(kw)
    return minter.mint_tool_obo(**base)


def test_declared_read_actions_land_in_scopes_after_the_tool_id():
    c = build_container(make_settings(), mode="memory")
    minter = _minter(c.signing_key)
    token = _mint(minter, downstream_actions=["dataset.dataset.list", "case.case.read"])
    claims = _claims(c.signing_key, token)
    assert claims["scopes"] == ["search.query", "dataset.dataset.list", "case.case.read"]
    assert claims["typ"] == "agent_obo"
    assert claims["obo_sub"] == "u-77"


def test_no_declaration_means_exactly_the_tool_id():
    c = build_container(make_settings(), mode="memory")
    minter = _minter(c.signing_key)
    for declared in (None, []):
        claims = _claims(c.signing_key, _mint(minter, downstream_actions=declared))
        assert claims["scopes"] == ["search.query"]


@pytest.mark.parametrize("action", [
    "case.case.update",          # write verb
    "chart.dashboard.delete",    # destructive verb
    "chart.dashboard.admin",     # admin verb
    "chart.dashboard.execute",   # execute verb
    "chart.dashboard.share",     # share verb
])
def test_a_write_action_can_never_be_delegated(action):
    """A delegated bearer must never carry authority to mutate anything."""
    c = build_container(make_settings(), mode="memory")
    with pytest.raises(ValueError, match="not a read action"):
        _mint(_minter(c.signing_key), downstream_actions=[action])


@pytest.mark.parametrize("action", [
    "*",                      # the run token's scope — the one tool-plane refuses
    "dataset.dataset.*",
    "case.read",              # not a canonical three-segment action
    "a.b.c.read",
    "Dataset.Dataset.list",
    "",
])
def test_a_non_canonical_or_wildcard_action_is_refused(action):
    c = build_container(make_settings(), mode="memory")
    with pytest.raises(ValueError):
        _mint(_minter(c.signing_key), downstream_actions=[action])


def test_a_duplicate_declaration_is_refused():
    c = build_container(make_settings(), mode="memory")
    with pytest.raises(ValueError, match="more than once"):
        _mint(_minter(c.signing_key),
              downstream_actions=["dataset.dataset.list", "dataset.dataset.list"])


def test_the_run_token_still_carries_the_wildcard_and_is_untouched():
    """The RUN token (direct REST reads) is a different token and is unchanged —
    only tool-call tokens go through mint_tool_obo."""
    c = build_container(make_settings(), mode="memory")
    token = c.token_minter.mint_agent_obo(
        tenant_id=TENANT_A, obo_sub="u-77", agent_key="case-triage", agent_version=1,
        workspace_id=None, scopes=["*"])
    assert _claims(c.signing_key, token)["scopes"] == ["*"]


# ---- the write path is unchanged by delegation ------------------------------


async def _approved_call(auto: bool):
    """Drive a real proposal to execution and return the recorded tool call."""
    c = build_container(make_settings(), mode="memory")
    run = Run(run_id=new_uuid(), tenant_id=TENANT_A, session_id=new_uuid(),
              agent_key="case-triage", agent_version=1, temporal_workflow_id=None,
              status="running", principal_type="user_obo", obo_sub="u-77")
    await c.store.create_run(run)
    intent = WriteIntent(
        tool_id="case.apply_disposition", tool_version="1.0.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": "c-91", "severity": "high", "assignee_id": "u-dana"},
        rationale="Vendor pattern matches 14 resolved cases.",
        affected_urns=[f"wr:{TENANT_A}:case:case/c-91"],
        predicted_effect={"summary": "assign", "reversibility": "reversible", "blast_radius": 1})
    policy = {"case-triage": {"write-proposal": {"reversible": "auto"}}} if auto else {}
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=intent, obo_user="u-77", auto_execute_policy=policy)
    if not auto:
        await c.proposal_service.decide(
            tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
            action="approve")
    assert len(c.tool_client.calls) == 1
    return c, c.tool_client.calls[0]


async def test_an_approved_write_token_is_scoped_to_the_tool_and_nothing_else():
    """A write tool declares no downstream actions, so its token stays exactly
    [tool_id] — tool-plane forwards NO Authorization header for it."""
    c, call = await _approved_call(auto=False)
    claims = _claims(c.signing_key, call["auth"])
    assert claims["scopes"] == ["case.apply_disposition"]
    assert "*" not in claims["scopes"]


async def test_an_approved_write_acts_as_the_approver_not_the_trigger_user():
    """Execution authority belongs to whoever DECIDED to run the write."""
    c, call = await _approved_call(auto=False)
    assert _claims(c.signing_key, call["auth"])["obo_sub"] == "u-super"


async def test_an_auto_executed_write_acts_as_the_trigger_user():
    """No human decider, so the token rides the original OBO user's authority."""
    c, call = await _approved_call(auto=True)
    assert _claims(c.signing_key, call["auth"])["obo_sub"] == "u-77"
