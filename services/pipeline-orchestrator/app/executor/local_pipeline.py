"""BRD 62 — the local in-process DAG executor for data-prep / feature-engineering
pipelines. Topologically runs a pipeline `definition` (nodes + edges) over the pandas
operator library (`operators.py`), threading DataFrames along `alias.port` edges, so
a non-training pipeline executes end to end on a Mac with NO Argo cluster.

Pure by construction: warehouse read/write is delegated to injected reader/writer
ports, so the executor is trivially unit-testable with a dict-backed fake, and the
same class runs against real dataset-service IO in the service wiring (inc2).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

import pandas as pd

from app.domain.resources import topo_order
from app.executor.operators import OperatorError, run_operator

logger = logging.getLogger(__name__)

# reader(dataset_urn, params) -> frame ; writer(frame, alias, params) -> output ref
DatasetReader = Callable[[str, dict], pd.DataFrame]
DatasetWriter = Callable[[pd.DataFrame, str, dict], str]

_READ_COMPONENTS = {"read-from-warehouse", "batch-read-from-warehouse"}
_WRITE_COMPONENTS = {"write-to-warehouse", "batch-write-to-warehouse"}
# Executed but produce no data output at runtime (profiling done by dataset-service).
_PASSTHROUGH = {"comment"}


class PipelineExecutionError(RuntimeError):
    """A node failed during local pipeline execution."""

    def __init__(self, alias: str, component: str, cause: Exception):
        self.alias = alias
        self.component = component
        self.cause = cause
        super().__init__(f"node {alias!r} ({component}) failed: {cause}")


@dataclass
class NodeStatus:
    alias: str
    component: str
    phase: str  # Succeeded | Failed
    rows_out: int | None = None
    error: str | None = None


@dataclass
class PipelineResult:
    # Terminal outputs (nodes with no downstream edge / write nodes' refs).
    outputs: dict[str, pd.DataFrame] = field(default_factory=dict)
    written_refs: dict[str, str] = field(default_factory=dict)
    statuses: list[NodeStatus] = field(default_factory=list)


def _endpoint(ref: str) -> tuple[str, str]:
    alias, _, port = (ref or "").rpartition(".")
    if not alias:  # no dot → whole node, default port
        return ref, "out"
    return alias, port


def _node_output_ports(node: dict) -> list[str]:
    outs = node.get("outputs")
    if outs:
        return [o.get("name", "out") if isinstance(o, dict) else str(o) for o in outs]
    return ["out"]


class LocalPipelineExecutor:
    """Executes a validated pipeline definition locally over the operator library."""

    def __init__(self, reader: DatasetReader | None = None,
                 writer: DatasetWriter | None = None) -> None:
        self._reader = reader
        self._writer = writer

    def run(self, definition: dict) -> PipelineResult:
        nodes = definition.get("nodes") or []
        edges = definition.get("edges") or []
        by_alias = {n.get("alias"): n for n in nodes}
        aliases = list(by_alias)

        # Incoming edges per node, IN DEFINITION ORDER (preserves authoring order so a
        # 2-input operator like join-data sees left=input[0], right=input[1]).
        incoming: dict[str, list[tuple[str, str]]] = {a: [] for a in aliases}
        topo_edges: list[tuple[str, str]] = []
        for e in edges:
            fa, fp = _endpoint(e.get("from", ""))
            ta, _tp = _endpoint(e.get("to", ""))
            if fa in by_alias and ta in by_alias:
                incoming[ta].append((fa, fp))
                topo_edges.append((fa, ta))

        order = topo_order(aliases, topo_edges)
        produced: dict[tuple[str, str], pd.DataFrame] = {}
        result = PipelineResult()
        has_downstream = {fa for fa, _ in topo_edges}

        for alias in order:
            node = by_alias.get(alias)
            if node is None:
                continue
            comp = node.get("component", "")
            params = node.get("parameters") or {}
            try:
                if comp in _PASSTHROUGH:
                    continue
                if comp in _READ_COMPONENTS:
                    frame = self._read(node, params)
                    produced[(alias, "out")] = frame
                    result.statuses.append(NodeStatus(alias, comp, "Succeeded",
                                                      rows_out=len(frame)))
                    continue
                # Gather ordered inputs from upstream ports.
                inputs = [produced[(fa, fp)] for fa, fp in incoming[alias]
                          if (fa, fp) in produced]
                if comp in _WRITE_COMPONENTS:
                    ref = self._write(inputs[0] if inputs else pd.DataFrame(), alias, params)
                    result.written_refs[alias] = ref
                    result.statuses.append(NodeStatus(alias, comp, "Succeeded",
                                                      rows_out=len(inputs[0]) if inputs else 0))
                    continue
                outs = run_operator(comp, inputs, params)
                ports = _node_output_ports(node)
                for i, frame in enumerate(outs):
                    port = ports[i] if i < len(ports) else f"out_{i}"
                    produced[(alias, port)] = frame
                result.statuses.append(NodeStatus(
                    alias, comp, "Succeeded",
                    rows_out=len(outs[0]) if outs else 0))
                # A node with no outgoing edge is a terminal output.
                if alias not in has_downstream and comp not in _WRITE_COMPONENTS:
                    result.outputs[alias] = outs[0] if outs else pd.DataFrame()
            except (OperatorError, KeyError, ValueError, TypeError) as exc:
                result.statuses.append(NodeStatus(alias, comp, "Failed", error=str(exc)))
                raise PipelineExecutionError(alias, comp, exc) from exc
        return result

    def _read(self, node: dict, params: dict) -> pd.DataFrame:
        if self._reader is None:
            raise PipelineExecutionError(
                node.get("alias", "?"), node.get("component", "read"),
                RuntimeError("no dataset reader configured for local read"))
        dataset = params.get("dataset") or params.get("dataset_urn")
        if not dataset:
            raise OperatorError("read-from-warehouse: 'dataset' param required")
        return self._reader(dataset, params)

    def _write(self, frame: pd.DataFrame, alias: str, params: dict) -> str:
        if self._writer is None:
            raise PipelineExecutionError(
                alias, "write-to-warehouse",
                RuntimeError("no dataset writer configured for local write"))
        return self._writer(frame, alias, params)
