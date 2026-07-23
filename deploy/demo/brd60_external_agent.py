#!/usr/bin/env python3
"""BRD 60 — register the external demo agent `acme-ext-bot` with a real toolset
allow-list, then live-verify the allow-list binds (defense-in-depth closure).

Background: BRD 60 WS1 shipped the governed external-intent ingress
(`POST /external/v1/intents`) that turns a customer agent's proposed write into
a four-eyes proposal. Every downstream control (tier ceiling, propose-only,
four-eyes, WORM emit) binds regardless. But the `AgentVersion.toolset`
allow-list only binds when the agent version resolves to a NON-EMPTY toolset —
and the demo agent was minted a token but never REGISTERED, so its toolset was
empty and `_enforce_guardrail`'s allow-list check was skipped: an off-allow-list
tool was accepted. (The enforcement code is correct; the agent config lacked a
toolset.)

External agents register an IDENTITY + toolset allow-list but do NOT run an
internal graph (the ingress reads their declared toolset and routes the write
through ProposalService — it never executes an agent graph). So the generic
graph-backed operator registry route does not apply; we register the agent's
control-plane record through the platform's own store (SqlStore) with
`graph_ref="external"`. The running agent-runtime reads `agent_versions` fresh
per request, so the allow-list binds immediately — no restart.

  1. register `acme-ext-bot`: agent definition + published v1 whose declared
     `toolset` IS the enforced allow-list (here: `case.apply_disposition`).
  2. live-verify (via the datacern-agent SDK) against the running agent-runtime:
       * an OFF-allow-list propose  -> 403 GUARDRAIL_VIOLATION (refused)
       * an  ON-allow-list propose  -> 200 pending (governed proposal created)

Run (agent-runtime venv — it has the store + pyjwt + cryptography):
  services/agent-runtime/.venv/bin/python deploy/demo/brd60_external_agent.py
"""

from __future__ import annotations

import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "services", "agent-runtime"))
sys.path.insert(0, os.path.join(REPO, "deploy", "e2e", "lib"))
sys.path.insert(0, os.path.join(REPO, "sdk", "agent-python"))

import common as c  # noqa: E402  (harness IdP key -> real RS256 tokens)
from sqlalchemy.ext.asyncio import async_sessionmaker  # noqa: E402

from app.domain.entities import AgentDefinition, AgentVersion  # noqa: E402
from app.store.sql import SqlStore, make_engine  # noqa: E402
from datacern_agent import DatacernAgentClient, DatacernAgentError  # noqa: E402

AGENT_RUNTIME = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:8306")
# The BYPASSRLS (control-plane) engine — agent_versions is a global registry
# table, exactly the session the service itself uses to seed internal agents.
ADMIN_DB = os.environ.get(
    "AR_ADMIN_DATABASE_URL",
    "postgresql+asyncpg://datacern:datacern_dev@localhost:5432/agent_runtime")

AGENT_KEY = os.environ.get("EXT_AGENT_KEY", "acme-ext-bot")
# Reuse the tenant the WS1 live-verify used, so the demo agent's rows stay
# consistent with the earlier smoke. Any real tenant uuid works — the ingress
# takes the tenant from the (signed) token.
TENANT = os.environ.get("EXT_AGENT_TENANT", "019f8cc6-cef2-7904-9900-d35ae2ca30d9")
# The one tool this external agent is permitted to propose. This IS the
# allow-list the guardrail enforces at runtime.
ON_LIST_TOOL = "case.apply_disposition"
OFF_LIST_TOOL = "case.delete_everything"


async def register() -> None:
    """Register the external agent + its allow-list through the platform store
    (idempotent). This is what sets AgentVersion.toolset for an external agent."""
    engine = make_engine(ADMIN_DB)
    store = SqlStore(async_sessionmaker(engine, expire_on_commit=False))
    try:
        await store.upsert_agent_definition(AgentDefinition(
            agent_key=AGENT_KEY,
            display_name="ACME external bot (BRD 60 demo)",
            description="External customer agent (origin=external) — governed via "
                        "Datacern's four-eyes proposal rails. Its registered toolset "
                        "is the enforced allow-list.",
            owner_team="external:acme", default_write_mode="proposal",
            status="published", owner_tenant=TENANT))
        print(f"  define agent  -> ok  ({AGENT_KEY})")

        toolset = [{"tool_id": ON_LIST_TOOL, "version_range": ">=1.0.0"}]
        existing = await store.get_agent_version(AGENT_KEY, 1)
        if existing is None:
            await store.create_agent_version(AgentVersion(
                agent_key=AGENT_KEY, version=1, graph_ref="external",
                # External agents run no internal graph, so there is no module
                # source to digest — a stable sentinel marks that intentionally.
                graph_digest="external:no-internal-graph", toolset=toolset,
                model_config={"request_class": "external"},
                principal_ref=f"spiffe://datacern/ns/ai/agent/{AGENT_KEY}",
                status="published"))
            print(f"  register v1   -> ok  toolset={[t['tool_id'] for t in toolset]}")
        else:
            # Idempotent re-run: force the declared allow-list onto the row.
            from sqlalchemy import text
            async with engine.begin() as conn:
                await conn.execute(
                    text("UPDATE agent_versions SET toolset=cast(:ts as jsonb), "
                         "status='published', updated_at=now() "
                         "WHERE agent_key=:k AND version=1"),
                    {"ts": __import__("json").dumps(toolset), "k": AGENT_KEY})
            print(f"  register v1   -> updated  toolset={[t['tool_id'] for t in toolset]}")
    finally:
        await engine.dispose()


def _agent_token() -> str:
    """A signed EXTERNAL agent principal (typ=agent_autonomous) for acme-ext-bot@1
    — exactly the shape identity-service's agent-token exchange mints, so it
    verifies against the real JWKS the running agent-runtime trusts."""
    return c._mint({
        "sub": f"agent:{AGENT_KEY}@1", "tenant_id": TENANT, "typ": "agent_autonomous",
        "agent_id": AGENT_KEY, "agent_version": "1", "scopes": [],
    })


def _propose(agent: DatacernAgentClient, tool_id: str):
    return agent.propose(
        tool_id=tool_id, tool_version="1.0.0",
        args={"case_id": "c-brd60", "disposition": "approve"},
        affected_urns=[f"wr:{TENANT}:case:case/c-brd60"],
        rationale="BRD 60 allow-list live-verify.",
        predicted_effect={"summary": "apply disposition"})


def verify() -> bool:
    agent = DatacernAgentClient(base_url=AGENT_RUNTIME, token=_agent_token())
    ok = True

    # OFF-allow-list: the SDK raises a typed error carrying the platform code.
    try:
        _propose(agent, OFF_LIST_TOOL)
        print(f"  OFF-list ({OFF_LIST_TOOL}) -> ACCEPTED  FAIL — expected refusal")
        ok = False
    except DatacernAgentError as e:
        off_ok = e.status == 403 and e.code == "GUARDRAIL_VIOLATION"
        ok &= off_ok
        print(f"  OFF-list ({OFF_LIST_TOOL}) -> {e.status} {e.code} "
              f"{'PASS (refused)' if off_ok else 'FAIL — expected 403 GUARDRAIL_VIOLATION'}")

    # ON-allow-list: a governed, pending proposal (never executes inline).
    prop = _propose(agent, ON_LIST_TOOL)
    on_ok = prop.status == "pending"
    ok &= on_ok
    print(f"  ON-list  ({ON_LIST_TOOL}) -> status={prop.status} "
          f"{'PASS (governed proposal)' if on_ok else 'FAIL — expected pending'}")
    if on_ok:
        print(f"     proposal_id={prop.id}  (now awaiting four-eyes approval)")
    return ok


async def _main() -> int:
    print(f"BRD 60 — external agent allow-list closure  ({AGENT_KEY} @ {AGENT_RUNTIME})")
    print("register:")
    await register()
    print("live-verify (datacern-agent SDK):")
    passed = verify()
    print("\nRESULT:", "ALL PASS" if passed else "FAILURES")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
