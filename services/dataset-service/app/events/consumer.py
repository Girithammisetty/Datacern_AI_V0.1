"""Consumer for `ingestion.events.v1` (BRD §6).

ingestion.completed -> create/advance dataset + version, auto lineage edge,
trigger profiling. Idempotent twice over: event_id dedup (MASTER-FR-032) and
ingestion_id natural idempotency (produced_by_urn lookup).

The Kafka consumer-group adapter (Avro deserialization, 5-retry backoff, DLQ
routing per MASTER-FR-033) is stubbed below; handlers are transport-agnostic.
"""

from __future__ import annotations

import logging

from app.domain.entities import DatasetStatus, Visibility
from app.domain.errors import Conflict, SnapshotAlreadyRegistered
from app.domain.ports import DedupStore
from app.domain.services import (
    CallCtx,
    DatasetService,
    LineageService,
    ServiceDeps,
    VersionService,
)
from app.domain.state import transition_dataset
from app.domain.urn import dataset_urn, parse_urn, version_urn
from app.events.envelope import make_envelope

#: The interop standards ingestion-service decodes (its decode.py allow-list).
STANDARDS_FORMATS = ("x12", "fhir", "hl7v2", "iso20022", "acord")

#: Formats whose decoder emits rows with ONE documented meaning (see
#: ingestion-service app/domain/xml_standards.py: ISO 20022 = one row per
#: statement entry; ACORD = one row per policy-bearing element). x12/fhir/hl7v2
#: are deliberately absent — their row meaning varies per transaction set /
#: resourceType / message type, so a dataset-level hint would be a guess.
STANDARDS_ROW_ENTITY = {"iso20022": "bank_statement_entry", "acord": "policy"}

#: Mixed-meaning formats carry a PER-ROW discriminator column (written by the
#: decoder onto every row) — the per-row linkage slice observes its actual
#: values in the committed snapshot instead of guessing from the format.
STANDARDS_ROW_DISCRIMINATOR = {
    "x12": "transaction_set",   # ingestion-service x12.py _ENVELOPE_COLUMNS
    "fhir": "resource_type",    # fhir.py COLUMNS
    "hl7v2": "message_type",    # hl7v2.py COLUMNS (e.g. "ADT^A01", "ORU^R01")
}

#: What one row IS per x12 transaction set — each set's row meaning is
#: documented on its column list in ingestion-service x12.py (837 one row per
#: claim, 835 per claim payment, 271 per eligibility/benefit segment, 277 per
#: claim status response, 834 per health-coverage line, 999 per acknowledged
#: transaction set).
X12_ROW_ENTITY = {
    "837": "claim", "835": "claim_payment", "271": "eligibility_benefit",
    "277": "claim_status", "834": "enrollment", "999": "acknowledgment",
}

#: FHIR resourceType -> entity kind, for exactly the types the decoder maps
#: (unmapped resources are skipped at decode, so observed values ⊆ this set;
#: anything else records entity_key None rather than a guess).
FHIR_ROW_ENTITY = {
    "Patient": "patient", "Coverage": "coverage", "Claim": "claim",
    "ClaimResponse": "claim_response",
    "ExplanationOfBenefit": "explanation_of_benefit", "Encounter": "encounter",
}

#: Bounded row scan for per-row linkage — same order as the profiler/contract
#: reads; rows_scanned is recorded so a partial scan is disclosed, never hidden.
ROW_SCAN_LIMIT = 20_000
#: Distinct discriminator values recorded, most-frequent first (evidence, not a
#: dump; truncation is logged).
MAX_ROW_ENTITY_VALUES = 20


def _row_entity_for(fmt: str, value: str) -> str | None:
    """The entity kind one row instantiates, from its discriminator value —
    None when the value maps to nothing we can honestly name."""
    if fmt == "x12":
        return X12_ROW_ENTITY.get(value)
    if fmt == "fhir":
        return FHIR_ROW_ENTITY.get(value)
    if fmt == "hl7v2":
        # hl7v2.py: ADT emits one patient/event row per message; ORU one row
        # per OBX observation. The suffix (^A01, ^R01) refines the trigger,
        # not what a row is.
        if value.startswith("ADT"):
            return "patient_event"
        if value.startswith("ORU"):
            return "observation"
    return None

logger = logging.getLogger(__name__)

INGESTION_TOPIC = "ingestion.events.v1"


class IngestionEventHandler:
    def __init__(
        self,
        deps: ServiceDeps,
        dedup: DedupStore,
        dataset_service: DatasetService,
        version_service: VersionService,
        lineage_service: LineageService,
    ):
        self.deps = deps
        self.dedup = dedup
        self.datasets = dataset_service
        self.versions = version_service
        self.lineage = lineage_service

    async def handle(self, envelope: dict) -> None:
        tenant_id = envelope["tenant_id"]
        event_id = envelope["event_id"]
        if await self.dedup.already_processed(tenant_id, event_id):
            logger.info("duplicate event %s skipped", event_id)
            return
        event_type = envelope["event_type"]
        # Handle first; if the handler raises, the marker is never written and
        # the event is re-run on redelivery. The handler is idempotent (natural
        # dedup on ingestion_id + snapshot + edge upsert), so re-runs never
        # double effects — exactly-once effect, DLQ-ready (MASTER-FR-032/033).
        if event_type == "ingestion.completed":
            await self._on_completed(envelope)
        elif event_type == "ingestion.failed":
            await self._on_failed(envelope)
        await self.dedup.mark_processed(tenant_id, event_id)

    def _ctx(self, envelope: dict) -> CallCtx:
        return CallCtx(
            tenant_id=envelope["tenant_id"],
            actor=envelope.get("actor") or {"type": "service", "id": "ingestion-service"},
            via_agent=envelope.get("via_agent"),
            trace_id=envelope.get("trace_id"),
        )

    async def _on_completed(self, envelope: dict) -> None:
        ctx = self._ctx(envelope)
        payload = envelope["payload"]
        ingestion_id = payload["ingestion_id"]
        ingestion_urn = f"wr:{ctx.tenant_id}:ingestion:ingestion/{ingestion_id}"

        # Guard: an event that carries neither an existing dataset reference nor the
        # workspace needed to create one cannot be auto-registered (e.g. a legacy
        # event predating the enriched ingestion.completed payload). Skip it
        # cleanly (mark processed) rather than raising into the retry/DLQ path.
        if not (self._event_dataset_id(ctx, payload) or payload.get("workspace_id")):
            logger.warning(
                "ingestion.completed %s missing dataset_id/workspace_id; skipping auto-register",
                ingestion_id,
            )
            return

        # Natural idempotency on ingestion_id: version already registered -> no-op
        async with self.deps.uow_factory(ctx.tenant_id) as uow:
            if await uow.versions.by_produced_by(ingestion_urn):
                logger.info("ingestion %s already registered; skipping", ingestion_id)
                return

        dataset = await self._resolve_dataset(ctx, payload)
        if dataset is None:
            logger.warning(
                "ingestion.completed %s references an unknown dataset and carries no "
                "workspace_id to create it; skipping auto-register",
                ingestion_id,
            )
            return
        try:
            version = await self.versions.register(
                ctx,
                dataset.id,
                {
                    "iceberg_snapshot_id": payload["iceberg_snapshot_id"],
                    "schema": payload.get("schema") or {},
                    "row_count": payload.get("row_count"),
                    "bytes": payload.get("bytes"),
                    "produced_by_urn": ingestion_urn,
                    "skip_profiling": payload.get("skip_profiling", False),
                },
            )
        except SnapshotAlreadyRegistered:
            # A concurrent delivery already registered this snapshot: safe skip.
            # A BR-1 'snapshot not yet readable' Conflict is NOT caught here — it
            # propagates so the event is left un-marked and retried on redelivery.
            logger.info("snapshot for ingestion %s already registered", ingestion_id)
            return

        # Automatic lineage edge (DST-FR-044): connection|upload -[ingested]-> version
        source_urn = payload.get("connection_urn") or (
            f"wr:{ctx.tenant_id}:ingestion:upload/{ingestion_id}"
        )
        await self.lineage.add_edge(
            ctx,
            {
                "from_urn": source_urn,
                "to_urn": version_urn(ctx.tenant_id, dataset.id, version.version_no),
                "activity": "ingested",
                "run_urn": ingestion_urn,
            },
        )

    @staticmethod
    def _event_dataset_id(ctx: CallCtx, payload: dict) -> str | None:
        """The dataset id ingestion-service minted (or was given), from the
        explicit ``dataset_id`` field or parsed out of ``dataset_urn``. This id
        is the SINGLE SOURCE OF TRUTH for the dataset row: every consumer that
        stored the ingestion's dataset_urn (case rows, lineage, the UI) must
        resolve to the row this handler creates. A URN whose tenant does not
        match the envelope tenant is ignored (defense in depth, MASTER-FR-003)."""
        if payload.get("dataset_id"):
            return str(payload["dataset_id"])
        raw_urn = payload.get("dataset_urn")
        if raw_urn:
            try:
                parsed = parse_urn(raw_urn)
            except Exception:  # noqa: BLE001 - malformed URN: fall through
                logger.warning("ignoring malformed dataset_urn %r", raw_urn)
                return None
            if (
                parsed.tenant == ctx.tenant_id
                and parsed.service == "dataset"
                and parsed.rtype == "dataset"
            ):
                return parsed.rid
            logger.warning("ignoring foreign/non-dataset dataset_urn %r", raw_urn)
        return None

    async def _standards_provenance(
        self, ctx: CallCtx, payload: dict,
    ) -> tuple[list[str], dict | None]:
        """Knowledge Spine WS5: a dataset decoded from an interop standard says
        so, and — where the decoder's row meaning is single and documented —
        links to the governed ontology type its rows instantiate.

        Honesty rules: the ``standard:<format>`` tag states only what the
        decoder ran. An ``ontology:<key>`` tag is added ONLY when the workspace
        registry actually declares the key (checked here, in the service that
        owns the registry) — a miss is recorded as ``ontology_linked: false``
        in custom_metadata, never fabricated into a tag. x12/fhir/hl7v2 mix row
        meanings per transaction set / resourceType / message type, so they get
        NO dataset-level entity hint (a guess is worse than silence; per-row
        linkage is the future slice).
        """
        fmt = payload.get("file_format")
        if fmt not in STANDARDS_FORMATS:
            return [], None
        tags = [f"standard:{fmt}"]
        hint = STANDARDS_ROW_ENTITY.get(fmt)
        linked = False
        if hint and payload.get("workspace_id"):
            async with self.deps.uow_factory(ctx.tenant_id) as uow:
                linked = await uow.ontology.get(payload["workspace_id"], hint) is not None
            if linked:
                tags.append(f"ontology:{hint}")
        meta = {"standards": {"format": fmt, "entity_key": hint, "ontology_linked": linked}}

        # Per-row slice: for mixed-meaning formats, observe the discriminator
        # values ACTUALLY present in the committed snapshot and link each one.
        if fmt in STANDARDS_ROW_DISCRIMINATOR:
            observed = await self._observe_row_entities(ctx, payload, fmt)
            if observed is not None:
                rows_scanned, row_entities = observed
                meta["standards"]["discriminator"] = STANDARDS_ROW_DISCRIMINATOR[fmt]
                meta["standards"]["rows_scanned"] = rows_scanned
                meta["standards"]["row_entities"] = row_entities
                for re_ in row_entities:
                    if re_["ontology_linked"]:
                        tag = f"ontology:{re_['entity_key']}"
                        if tag not in tags:
                            tags.append(tag)
        return tags, meta

    async def _observe_row_entities(
        self, ctx: CallCtx, payload: dict, fmt: str,
    ) -> tuple[int, list[dict]] | None:
        """Read a bounded head of the event's exact snapshot and report the
        distinct discriminator values present — value, row count, the entity
        kind such a row instantiates, and whether the workspace registry
        declares that kind. Any failure (unreadable snapshot, missing column)
        skips per-row linkage with a warning — it NEVER blocks registration,
        and nothing is recorded that wasn't observed."""
        table = payload.get("iceberg_table")
        snapshot_id = payload.get("iceberg_snapshot_id")
        workspace_id = payload.get("workspace_id")
        col = STANDARDS_ROW_DISCRIMINATOR[fmt]
        if not table or snapshot_id is None or not workspace_id:
            return None
        try:
            df = await self.deps.catalog.read_snapshot_head(table, snapshot_id, ROW_SCAN_LIMIT)
        except Exception as exc:  # noqa: BLE001 — linkage is best-effort metadata
            logger.warning("standards row scan failed for %s@%s: %s — per-row "
                           "linkage skipped", table, snapshot_id, exc)
            return None
        if df is None or col not in df.columns:
            logger.warning("standards dataset %s carries no %r column; per-row "
                           "linkage skipped", table, col)
            return None

        counts = df[col].astype(str).value_counts()
        if len(counts) > MAX_ROW_ENTITY_VALUES:
            logger.warning("%s distinct %r values; recording the %s most frequent",
                           len(counts), col, MAX_ROW_ENTITY_VALUES)
        out: list[dict] = []
        async with self.deps.uow_factory(ctx.tenant_id) as uow:
            for value, n in counts.head(MAX_ROW_ENTITY_VALUES).items():
                key = _row_entity_for(fmt, str(value))
                linked = False
                if key:
                    linked = await uow.ontology.get(workspace_id, key) is not None
                out.append({"value": str(value), "rows": int(n),
                            "entity_key": key, "ontology_linked": linked})
        return int(len(df)), out

    async def _resolve_dataset(self, ctx: CallCtx, payload: dict):
        dataset_id = self._event_dataset_id(ctx, payload)
        async with self.deps.uow_factory(ctx.tenant_id) as uow:
            if dataset_id:
                existing = await uow.datasets.get(dataset_id)
                if existing:
                    return existing
            elif payload.get("dataset_name") and payload.get("workspace_id"):
                # Name fallback is ONLY for legacy events that carry no dataset
                # id. When the payload has an id, resolving by name to a
                # DIFFERENT dataset would register this ingestion's bronze
                # snapshot against that dataset's table — never readable there,
                # so the event retries out to the DLQ and the upload's data is
                # orphaned (the duplicate-name new_dataset bug).
                existing = await uow.datasets.get_by_name(
                    payload["workspace_id"], payload["dataset_name"]
                )
                if existing:
                    return existing
        if not payload.get("workspace_id"):
            return None  # cannot create without a workspace; caller skips cleanly
        # Auto-register UNDER THE EVENT'S ID: ingestion-service pre-minted the
        # dataset id (it is embedded in the bronze table name and in every
        # dataset_urn it handed out), so the row must carry that exact id —
        # minting a fresh one here is the URN drift this fixes.
        std_tags, std_meta = await self._standards_provenance(ctx, payload)
        base = {
            "id": dataset_id,  # None -> DatasetService mints one (API path)
            "workspace_id": payload["workspace_id"],
            "iceberg_table": payload.get("iceberg_table"),
            "visibility": Visibility.WORKSPACE,
            "tags": [*(payload.get("tags") or []), *std_tags],
        }
        if std_meta:
            base["custom_metadata"] = std_meta
        name = payload.get("dataset_name") or f"ingestion-{payload['ingestion_id']}"
        try:
            return await self.datasets.create(ctx, {**base, "name": name})
        except Conflict:
            pass
        # The requested name is taken by another dataset in the workspace
        # (names are unique per workspace). The data is already committed to
        # this ingestion's own bronze table, so de-conflict the name rather
        # than DLQing the event and orphaning the upload.
        for n in range(2, 100):
            candidate = f"{name} ({n})"
            try:
                dataset = await self.datasets.create(ctx, {**base, "name": candidate})
            except Conflict:
                continue
            logger.warning(
                "dataset name %r already exists in workspace %s; registered "
                "ingestion %s as %r (dataset %s)",
                name, payload["workspace_id"], payload["ingestion_id"],
                candidate, dataset.id,
            )
            return dataset
        raise Conflict(
            f"could not find a free name for dataset {name!r} in workspace "
            f"{payload['workspace_id']} after 99 attempts"
        )

    async def _on_failed(self, envelope: dict) -> None:
        ctx = self._ctx(envelope)
        payload = envelope["payload"]
        dataset_id = payload.get("dataset_id")
        if not dataset_id:
            return
        async with self.deps.uow_factory(ctx.tenant_id) as uow:
            dataset = await uow.datasets.get(dataset_id)
            if not dataset:
                return
            versions = await uow.versions.list_all(dataset_id)
            if versions or dataset.status not in (
                DatasetStatus.DRAFT, DatasetStatus.PROCESSING
            ):
                return  # only fail datasets with no usable data (BRD §6)
            if dataset.status == DatasetStatus.DRAFT:
                transition_dataset(dataset, DatasetStatus.PROCESSING)
            transition_dataset(
                dataset,
                DatasetStatus.FAILED,
                error_log={"source": "ingestion", "digest": payload.get("error_digest")},
            )
            dataset.updated_at = self.deps.clock.now()
            await uow.datasets.update(dataset)
            await uow.outbox.add(
                self.deps.settings.events_topic,
                make_envelope(
                    event_type="dataset.updated",
                    tenant_id=ctx.tenant_id,
                    actor=ctx.actor,
                    via_agent=ctx.via_agent,
                    resource_urn=dataset_urn(ctx.tenant_id, dataset.id),
                    payload={"status": str(DatasetStatus.FAILED),
                             "error_digest": payload.get("error_digest")},
                    trace_id=ctx.trace_id,
                ),
            )
            await uow.commit()


class KafkaIngestionConsumer:
    """Real aiokafka consumer group (``dataset-service.ingestion``) on
    ingestion.events.v1 via the shared ``datacern_common`` consumer runner:
    Redis dedup, 5-retry exponential backoff and a real DLQ
    ``ingestion.events.v1.dataset-service.dlq`` (MASTER-FR-032/033). The
    transport-agnostic ``IngestionEventHandler.handle`` is the handler. Runtime
    consumer."""

    GROUP_ID = "dataset-service.ingestion"

    def __init__(
        self,
        handler: IngestionEventHandler,
        dedup,
        producer,
        *,
        bootstrap_servers: str = "localhost:9092",
        topic: str = INGESTION_TOPIC,
    ):
        from datacern_common.kafka import KafkaConfig, KafkaConsumer

        self._handler = handler
        self._consumer = KafkaConsumer(
            topic,
            self.GROUP_ID,
            handler.handle_raw if hasattr(handler, "handle_raw") else handler.handle,
            dedup,
            producer,
            cfg=KafkaConfig(bootstrap_servers=bootstrap_servers),
            max_retries=5,
        )

    async def start(self) -> None:
        await self._consumer.start()

    async def stop(self) -> None:
        await self._consumer.stop()

    async def consume_batch(self, max_messages: int, timeout_ms: int = 2000):
        return await self._consumer.consume_batch(max_messages, timeout_ms=timeout_ms)

    async def run(self, stop_event=None) -> None:
        await self._consumer.run(stop_event)
