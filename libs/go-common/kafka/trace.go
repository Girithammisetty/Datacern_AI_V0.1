package kafka

import (
	"context"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// headerCarrier adapts kafka-go's []kafka.Header to OTel's TextMapCarrier for
// EXTRACTION. Kafka headers aren't a mutable map at read time, so Set is a
// deliberate no-op — injection uses propagation.MapCarrier instead (see
// injectTraceHeaders).
type headerCarrier []kafka.Header

func (h headerCarrier) Get(key string) string {
	for _, kv := range h {
		if kv.Key == key {
			return string(kv.Value)
		}
	}
	return ""
}

func (h headerCarrier) Set(string, string) {}

func (h headerCarrier) Keys() []string {
	keys := make([]string, len(h))
	for i, kv := range h {
		keys[i] = kv.Key
	}
	return keys
}

// injectTraceHeaders returns the W3C trace-context headers (traceparent,
// tracestate) for ctx's active span. Empty when tracing is disabled — the
// global propagator stays the default no-op composite until otelx.Init runs
// (BRD 58 WS2: previously the Kafka path carried no span context at all, only
// the app-level "trace_id" header kept below for backward compatibility).
func injectTraceHeaders(ctx context.Context) []kafka.Header {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	if len(carrier) == 0 {
		return nil
	}
	headers := make([]kafka.Header, 0, len(carrier))
	for k, v := range carrier {
		headers = append(headers, kafka.Header{Key: k, Value: []byte(v)})
	}
	return headers
}

// extractTraceContext returns ctx carrying the span context extracted from a
// consumed message's Kafka headers, so the handler's downstream calls (HTTP
// via otelx.Transport, further Kafka publishes) parent under the producer's
// span instead of starting a disconnected trace. A message with no trace
// headers, or tracing disabled, returns ctx unchanged (no-op extract).
func extractTraceContext(ctx context.Context, headers []kafka.Header) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, headerCarrier(headers))
}
