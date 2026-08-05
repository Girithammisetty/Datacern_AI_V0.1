"""Consumed events (BRD §6). A transport-agnostic ``PipelineEventConsumer.handle``
dispatches by event_type; the real path drives it from one ``KafkaPipelineConsumer``
per topic (datacern_common.KafkaConsumer: Redis dedup, retry/backoff, DLQ)."""

from __future__ import annotations

import logging

from app.domain.entities import TenantQuota
from app.domain.labeling import LabeledExampleAssembler

logger = logging.getLogger(__name__)

IDENTITY_TOPIC = "identity.events.v1"
CASE_TOPIC = "case.events.v1"
DATASET_TOPIC = "dataset.events.v1"
# BRD 73: the batch job's ingestion phase advances on THESE events rather than by
# polling ingestion-service — the same informer discipline the Argo watch uses.
INGESTION_TOPIC = "ingestion.events.v1"
CONSUMED_TOPICS = [IDENTITY_TOPIC, CASE_TOPIC, DATASET_TOPIC, INGESTION_TOPIC]

#: ingestion.events.v1 terminal event types → the status recorded on the binding.
_INGESTION_TERMINAL_EVENTS = {
    "ingestion.completed": "completed",
    "ingestion.failed": "failed",
    "ingestion.cancelled": "cancelled",
}


class PipelineEventConsumer:
    def __init__(self, deps, dedup, *, feature_source=None, default_quota=None,
                 batch_job_service=None):
        self.d = deps
        self.dedup = dedup
        self.assembler = LabeledExampleAssembler(deps, feature_source=feature_source)
        self.default_quota = default_quota or {}
        self.batch_jobs = batch_job_service

    async def handle(self, env: dict) -> None:
        tenant_id = env.get("tenant_id", "")
        event_id = env.get("event_id", "")
        if event_id and await self.dedup.already_processed(tenant_id, event_id):
            return
        et = env.get("event_type", "")
        try:
            if et == "tenant.provisioned":
                await self._provision(tenant_id)
            elif et in ("case.disposition_applied", "case.correction_recorded"):
                ex = await self.assembler.handle_disposition(env)
                if ex:
                    logger.info("labeled example assembled dataset=%s row=%s label=%s",
                                ex.dataset_urn, ex.row_pk, ex.label)
            elif et in _INGESTION_TERMINAL_EVENTS:
                await self._ingestion_terminal(tenant_id, et, env)
            elif et == "dataset.version_created":
                await self._dataset_version(tenant_id, env)
        finally:
            if event_id:
                await self.dedup.mark_processed(tenant_id, event_id)

    async def _ingestion_terminal(self, tenant_id: str, event_type: str,
                                  env: dict) -> None:
        """An ingestion reached a terminal state. If a batch job run is waiting on
        it, record the outcome and let the run advance (or fail, if the ingestion
        did — the pipeline phase must never run on a batch that did not land)."""
        if self.batch_jobs is None:
            return
        payload = env.get("payload") or {}
        ingestion_id = str(payload.get("ingestion_id") or "")
        if not ingestion_id:
            return
        status = _INGESTION_TERMINAL_EVENTS[event_type]
        matched = await self.batch_jobs.on_ingestion_terminal(
            tenant_id, ingestion_id, status, payload)
        if matched:
            logger.info("batch job ingestion %s %s", ingestion_id, status)

    async def _dataset_version(self, tenant_id: str, env: dict) -> None:
        """``dataset.version_created`` carries the ``produced_by_urn`` of the
        ingestion that landed it — the only place the exact version URN of a
        batch's data is published, and therefore what makes pinning the pipeline
        run to "what this batch produced" real instead of a timestamp guess."""
        if self.batch_jobs is None:
            return
        version_urn = env.get("resource_urn") or ""
        payload = env.get("payload") or {}
        if not version_urn:
            return
        await self.batch_jobs.on_dataset_version_created(tenant_id, version_urn,
                                                         payload)

    async def _provision(self, tenant_id: str) -> None:
        async with self.d.uow_factory(tenant_id) as uow:
            if await uow.quotas.get(tenant_id) is None:
                await uow.quotas.upsert(TenantQuota(
                    tenant_id=tenant_id,
                    max_concurrent_runs=self.default_quota.get("max_concurrent_runs", 10),
                    max_concurrent_pods=self.default_quota.get("max_concurrent_pods", 40),
                    max_run_duration_minutes=self.default_quota.get(
                        "max_run_duration_minutes", 480),
                    min_seconds_between_runs=self.default_quota.get(
                        "min_seconds_between_runs", 15)))


class _DedupPassthrough:
    """datacern_common.KafkaConsumer owns commit semantics; the handler already
    dedups, so this pass-through avoids double-suppression."""

    async def already_processed(self, tenant_id, event_id):
        return False

    async def mark_processed(self, tenant_id, event_id):
        return None


class KafkaPipelineConsumer:
    """Real Kafka consumer-group runner for one topic (datacern_common)."""

    def __init__(self, topic, consumer, producer, *, group_id=None,
                 bootstrap_servers="localhost:9092"):
        from datacern_common.kafka import KafkaConfig, KafkaConsumer

        self._runner = KafkaConsumer(
            topic, group_id or f"pipeline-orchestrator.{topic}", consumer.handle,
            _DedupPassthrough(), producer,
            cfg=KafkaConfig(bootstrap_servers=bootstrap_servers))

    async def start(self):
        await self._runner.start()

    async def stop(self):
        await self._runner.stop()

    async def consume_batch(self, max_messages, timeout_ms=6000):
        return await self._runner.consume_batch(max_messages, timeout_ms)

    async def run(self, stop_event=None):
        await self._runner.run(stop_event)
