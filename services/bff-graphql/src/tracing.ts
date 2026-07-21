/**
 * Env-gated OpenTelemetry tracing for the BFF — the Node counterpart of
 * `libs/go-common/otelx` and `libs/py-common/datacern_common/otelx.py`, with the
 * SAME contract so one env pair configures the whole platform:
 *
 *   DATACERN_OTEL_ENABLED=true  OR  OTEL_EXPORTER_OTLP_ENDPOINT=host:port
 *
 * Unset => a genuine no-op: no provider, no exporter, no spans, and
 * `withServerSpan` degrades to a direct call. Like the Go/Python helpers it
 * NEVER throws — a missing or unreachable collector must never destabilize the
 * request path (the gRPC exporter dials lazily and drops on failure).
 *
 * MANUAL instrumentation on purpose. The auto-instrumentation packages patch
 * `node:http` at require time, which under ESM ("type": "module") needs a
 * loader hook + a `--import` preload. This service has exactly two seams that
 * matter — the inbound /graphql request and the outbound ServiceClient fetch —
 * so instrumenting them directly gives the same trace topology with no loader
 * hook, no preload, and nothing patched in the hot path.
 *
 * Protocol is OTLP/gRPC (collector :4317), matching deploy/CONFIG.md: every
 * Datacern service exports gRPC, not HTTP.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "bff-graphql";

/** Mirrors otelx.Enabled(): on when DATACERN_OTEL_ENABLED is truthy or an OTLP
 * endpoint is explicitly configured, so the default (no collector) is a no-op. */
export function tracingEnabled(): boolean {
  const v = (process.env.DATACERN_OTEL_ENABLED ?? "").toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  return (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "") !== "";
}

/** Set only when tracing is actually installed; every helper below no-ops on it
 * being undefined, which is what keeps the disabled path free. */
let provider: NodeTracerProvider | undefined;

/**
 * Install the tracer provider iff enabled. Returns a shutdown that flushes
 * pending spans (no-op when disabled), mirroring otelx.InitFromEnv. Safe to
 * call more than once.
 */
export function initTracing(serviceName: string = TRACER_NAME): () => Promise<void> {
  if (provider || !tracingEnabled()) return async () => {};
  try {
    // Same normalization as the Go helper: the contract is host:port, but a
    // leading scheme is tolerated. The gRPC exporter wants a URL, and http://
    // selects the insecure (no-TLS) channel used for the in-cluster collector.
    const hostPort = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "localhost:4317")
      .replace(/^https?:\/\//, "");
    const p = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `http://${hostPort}` }))],
    });
    p.register({ propagator: new W3CTraceContextPropagator() });
    provider = p;
    return async () => {
      try {
        await provider?.shutdown();
      } catch {
        // Best-effort flush: a collector that is down must not fail shutdown.
      }
    };
  } catch {
    provider = undefined; // stay disabled rather than half-installed
    return async () => {};
  }
}

/**
 * Run `fn` inside a SERVER span parented under the inbound W3C `traceparent`,
 * so the UI's trace continues through the BFF instead of skipping it. When
 * tracing is disabled this is a direct call — no context switch, no allocation.
 */
export function withServerSpan<T>(
  name: string,
  incomingTraceparent: string | undefined,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (!provider) return fn();
  const parent = incomingTraceparent
    ? propagation.extract(context.active(), { traceparent: incomingTraceparent })
    : context.active();
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(name, { kind: SpanKind.SERVER, attributes }, parent, async (span) => {
      try {
        const out = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return out;
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        span.end();
      }
    });
}

/**
 * W3C traceparent for the currently active span. ServiceClient forwards this
 * instead of the inbound header so downstream services parent under the BFF's
 * span (a real hop) rather than becoming siblings of it. `undefined` when
 * tracing is off, so the caller falls back to verbatim passthrough.
 */
export function activeTraceparent(): string | undefined {
  if (!provider) return undefined;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
