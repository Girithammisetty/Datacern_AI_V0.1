"""W3C trace-context propagation on the Kafka path (BRD 58 WS2). No real
Kafka/collector needed -- these exercise the inject/extract helpers directly,
mirroring go-common/kafka's extract==inject round-trip test."""

from __future__ import annotations

from opentelemetry import context as otel_context
from opentelemetry import trace

from datacern_common.kafka import _extract_trace_context, _inject_trace_headers


def test_inject_extract_round_trip():
    span_context = trace.SpanContext(
        trace_id=0x0102030405060708090A0B0C0D0E0F10,
        span_id=0x1112131415161718,
        is_remote=False,
        trace_flags=trace.TraceFlags(trace.TraceFlags.SAMPLED),
    )
    ctx = trace.set_span_in_context(trace.NonRecordingSpan(span_context))
    token = otel_context.attach(ctx)
    try:
        headers = _inject_trace_headers()
    finally:
        otel_context.detach(token)

    assert headers, "expected at least a traceparent header for an active span"

    extracted = _extract_trace_context(headers)
    got = trace.get_current_span(extracted).get_span_context()
    assert got.trace_id == span_context.trace_id
    assert got.span_id == span_context.span_id


def test_inject_is_noop_without_an_active_span():
    # No span attached to the current context (the default state before any
    # producer call sets one) -- the propagator must skip the invalid span
    # context, exactly matching go-common/kafka's no-op-when-disabled behavior.
    assert _inject_trace_headers() == []


def test_extract_returns_current_context_when_headers_absent():
    ctx = otel_context.get_current()
    assert _extract_trace_context(None) == ctx
    assert _extract_trace_context([]) == ctx
