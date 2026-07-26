"""BRD 67 slice 1 — governed_decision metering fields survive the REAL
transactional-outbox -> Kafka path (VMB-FR-003), not just the in-memory bus.

Runs the actual `decide()` commit path (proposals/service.py) through the real
KafkaEventBus and reads the message back off the real `ai.proposal.v1` topic
(the service always publishes there — TOPIC_PROPOSAL is a fixed constant, so
unlike test_kafka.py's isolated-topic trick this consumes the shared topic and
filters on this test's own proposal_id to stay independent of concurrent runs)."""

from __future__ import annotations

import json
import uuid

import pytest

from app.constants import TOPIC_PROPOSAL
from app.container import build_container
from app.domain.entities import Run, new_uuid
from app.events.bus import KafkaEventBus
from app.graphs.base import WriteIntent
from tests.conftest import TENANT_A, make_settings

pytestmark = pytest.mark.integration


async def test_approve_metering_fields_round_trip_real_kafka(require_kafka):
    from aiokafka import AIOKafkaConsumer

    bus = KafkaEventBus("localhost:9092")
    c = build_container(make_settings(), mode="memory", bus=bus)
    run = Run(run_id=new_uuid(), tenant_id=TENANT_A, session_id=new_uuid(),
              agent_key="case-triage", agent_version=1, temporal_workflow_id=None,
              status="running", principal_type="user_obo", obo_sub="u-77")
    await c.store.create_run(run)

    consumer = AIOKafkaConsumer(
        TOPIC_PROPOSAL, bootstrap_servers="localhost:9092",
        auto_offset_reset="latest", group_id=f"itest-vm-{uuid.uuid4().hex[:6]}")
    await consumer.start()
    try:
        intent = WriteIntent(
            tool_id="case.apply_disposition", tool_version="1.0.0", tier="write-proposal",
            side_effects="reversible", args={"case_id": "c-1", "severity": "high"},
            rationale="r", affected_urns=[f"wr:{TENANT_A}:case:case/c-1"],
            predicted_effect={})
        prop, _ = await c.proposal_service.create_from_intent(
            run=run, intent=intent, obo_user="u-77", auto_execute_policy={})
        await c.proposal_service.decide(
            tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
            action="approve")

        # Drain until we see OUR proposal_id's proposal.approved message (the
        # shared topic may carry other concurrent tests' traffic).
        payload = None
        async for msg in consumer:
            got = json.loads(msg.value)
            if (got.get("event_type") == "proposal.approved"
                    and got.get("payload", {}).get("proposal_id") == prop.proposal_id):
                payload = got["payload"]
                break
        assert payload is not None, "did not observe our proposal.approved on real Kafka"
        assert payload["decision_label"] == "approved"
        assert payload["proposal_kind"] == "case"
        assert isinstance(payload["decision_latency_ms"], int)
        assert payload["pack_name"] is None
    finally:
        await consumer.stop()
        await bus.aclose()
