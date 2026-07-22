"""Real Kafka (Redpanda) plumbing over aiokafka.

* ``KafkaProducerClient`` — an idempotent producer; ``KafkaEventPublisher``
  (ingestion's ``publish(topic, key, value)``) and ``KafkaEventBus``
  (dataset's ``publish(topic, envelope)``) are thin ports over it. Both key
  records by ``tenant_id`` so a tenant's events stay ordered on one partition
  (MASTER-FR-031).
* ``KafkaConsumer`` — a consumer-group runner that JSON-decodes the master
  envelope, skips events already seen via a Redis dedup store (MASTER-FR-032),
  invokes the handler, retries transient handler failures with exponential
  backoff, and routes poison / exhausted messages to a real DLQ topic
  (``<topic>.<group>.dlq``, MASTER-FR-033). Offsets are committed only after an
  event is durably handled, deduped, or DLQ'd.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from opentelemetry import context as otel_context
from opentelemetry.propagate import extract, inject

logger = logging.getLogger(__name__)


def _inject_trace_headers() -> list[tuple[str, bytes]]:
    """W3C trace-context headers (traceparent/tracestate) for the current span
    (BRD 58 WS2). Empty when no real span is active -- OTel's default
    TraceContextTextMapPropagator skips injecting an invalid span context, so
    this is a true no-op until tracing is configured (datacern_common.otelx)."""
    carrier: dict[str, str] = {}
    inject(carrier)
    return [(k, v.encode()) for k, v in carrier.items()]


def _extract_trace_context(headers) -> otel_context.Context:
    """Recover the producer's span context from a consumed message's Kafka
    headers, so the handler's downstream calls parent under it instead of
    starting a disconnected trace. Absent/empty headers -> the current
    (empty) context, unchanged."""
    carrier = {k: v.decode() for k, v in (headers or [])}
    return extract(carrier)

Handler = Callable[[dict], Awaitable[None]]


def _dumps(value: dict) -> bytes:
    return json.dumps(value, default=str).encode()


def dlq_topic(topic: str, group_id: str) -> str:
    return f"{topic}.{group_id}.dlq"


@dataclass(slots=True)
class KafkaConfig:
    bootstrap_servers: str = "localhost:9092"


class KafkaProducerClient:
    def __init__(self, cfg: KafkaConfig | None = None) -> None:
        self.cfg = cfg or KafkaConfig()
        self._producer: AIOKafkaProducer | None = None

    async def start(self) -> None:
        if self._producer is None:
            self._producer = AIOKafkaProducer(
                bootstrap_servers=self.cfg.bootstrap_servers,
                enable_idempotence=True,
                acks="all",
                value_serializer=_dumps,
                key_serializer=lambda k: (k or "").encode(),
            )
            await self._producer.start()

    async def stop(self) -> None:
        if self._producer is not None:
            await self._producer.stop()
            self._producer = None

    async def send(self, topic: str, key: str | None, value: dict) -> None:
        assert self._producer is not None, "producer not started"
        await self._producer.send_and_wait(
            topic, key=key, value=value, headers=_inject_trace_headers()
        )

    async def __aenter__(self) -> KafkaProducerClient:
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.stop()


class KafkaEventPublisher:
    """ingestion-service EventPublisher port: publish(topic, key, value)."""

    def __init__(self, client: KafkaProducerClient) -> None:
        self._client = client

    async def publish(self, topic: str, key: str, value: dict) -> None:
        await self._client.send(topic, key, value)


class KafkaEventBus:
    """dataset-service EventBus port: publish(topic, envelope) keyed by tenant."""

    def __init__(self, client: KafkaProducerClient) -> None:
        self._client = client

    async def publish(self, topic: str, envelope: dict) -> None:
        await self._client.send(topic, envelope.get("tenant_id"), envelope)


@dataclass(slots=True)
class ConsumeStats:
    processed: int = 0
    deduped: int = 0
    dlq: int = 0
    errors: list[str] = field(default_factory=list)


class KafkaConsumer:
    """Consumer-group runner with Redis dedup, retry/backoff and a real DLQ."""

    def __init__(
        self,
        topic: str,
        group_id: str,
        handler: Handler,
        dedup,
        producer: KafkaProducerClient,
        *,
        cfg: KafkaConfig | None = None,
        max_retries: int = 5,
        backoff_base_s: float = 0.2,
        backoff_cap_s: float = 5.0,
    ) -> None:
        self.topic = topic
        self.group_id = group_id
        self.handler = handler
        self.dedup = dedup
        self.producer = producer
        self.cfg = cfg or KafkaConfig()
        self.max_retries = max_retries
        self.backoff_base_s = backoff_base_s
        self.backoff_cap_s = backoff_cap_s
        self.dlq = dlq_topic(topic, group_id)
        self._consumer: AIOKafkaConsumer | None = None

    async def start(self) -> None:
        if self._consumer is None:
            self._consumer = AIOKafkaConsumer(
                self.topic,
                bootstrap_servers=self.cfg.bootstrap_servers,
                group_id=self.group_id,
                enable_auto_commit=False,
                auto_offset_reset="earliest",
            )
            await self._consumer.start()

    async def stop(self) -> None:
        if self._consumer is not None:
            await self._consumer.stop()
            self._consumer = None

    async def consume_batch(self, max_messages: int, timeout_ms: int = 2000) -> ConsumeStats:
        """Process up to ``max_messages`` records then return, polling until that
        many are seen or the overall ``timeout_ms`` budget elapses. The budget
        (rather than a single poll) absorbs the initial consumer-group rebalance,
        where the first poll returns empty before partitions are assigned.
        Deterministic for tests; ``run`` wraps a loop for production."""
        assert self._consumer is not None, "consumer not started"
        import time

        stats = ConsumeStats()
        seen = 0
        deadline = time.monotonic() + timeout_ms / 1000.0
        while seen < max_messages:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            poll_ms = max(50, int(min(remaining, 0.5) * 1000))
            batch = await self._consumer.getmany(timeout_ms=poll_ms, max_records=max_messages)
            if not batch:
                continue
            for _tp, messages in batch.items():
                for msg in messages:
                    await self._handle_message(msg, stats)
                    seen += 1
                    await self._consumer.commit()
                    if seen >= max_messages:
                        break
        return stats

    async def run(self, stop_event: asyncio.Event | None = None) -> None:
        assert self._consumer is not None, "consumer not started"
        async for msg in self._consumer:
            stats = ConsumeStats()
            await self._handle_message(msg, stats)
            await self._consumer.commit()
            if stop_event is not None and stop_event.is_set():
                return

    async def _handle_message(self, msg, stats: ConsumeStats) -> None:
        # poison (undecodable) -> straight to DLQ
        try:
            envelope = json.loads(msg.value)
        except Exception as exc:  # noqa: BLE001
            await self._to_dlq_raw(msg.value, f"decode_error: {exc}")
            stats.dlq += 1
            return

        # Join the producer's trace (BRD 58 WS2) for the duration of this
        # message's handling -- a no-op when the message carries no
        # traceparent header (tracing disabled, or an older producer).
        token = otel_context.attach(_extract_trace_context(getattr(msg, "headers", None)))
        try:
            await self._process_envelope(envelope, stats)
        finally:
            otel_context.detach(token)

    async def _process_envelope(self, envelope: dict, stats: ConsumeStats) -> None:
        tenant_id = envelope.get("tenant_id", "")
        event_id = envelope.get("event_id", "")
        if event_id and await self.dedup.already_processed(tenant_id, event_id):
            stats.deduped += 1
            return

        attempt = 0
        while True:
            try:
                await self.handler(envelope)
                if event_id:
                    await self.dedup.mark_processed(tenant_id, event_id)
                stats.processed += 1
                return
            except Exception as exc:  # noqa: BLE001 — retry then DLQ
                attempt += 1
                if attempt > self.max_retries:
                    await self._to_dlq(envelope, f"max_retries_exceeded: {exc}")
                    if event_id:
                        await self.dedup.mark_processed(tenant_id, event_id)
                    stats.dlq += 1
                    stats.errors.append(str(exc))
                    return
                delay = min(self.backoff_base_s * (2 ** (attempt - 1)), self.backoff_cap_s)
                await asyncio.sleep(delay)

    async def _to_dlq(self, envelope: dict, reason: str) -> None:
        payload = {"reason": reason, "original": envelope}
        await self.producer.send(self.dlq, envelope.get("tenant_id"), payload)

    async def _to_dlq_raw(self, raw: bytes, reason: str) -> None:
        payload = {"reason": reason, "raw": raw.decode(errors="replace")}
        await self.producer.send(self.dlq, None, payload)
