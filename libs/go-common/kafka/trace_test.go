package kafka

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// TestTraceHeaderRoundTrip proves inject then extract recovers the SAME span
// context (BRD 58 WS2's explicit ask) -- a producer's active span survives
// the Kafka hop and a consumer's downstream calls parent under it.
func TestTraceHeaderRoundTrip(t *testing.T) {
	prevProp := otel.GetTextMapPropagator()
	prevProv := otel.GetTracerProvider()
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}))
	tp := sdktrace.NewTracerProvider() // real SDK provider so spans get valid IDs
	otel.SetTracerProvider(tp)
	t.Cleanup(func() {
		otel.SetTextMapPropagator(prevProp)
		otel.SetTracerProvider(prevProv)
	})

	tracer := tp.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "publish")
	defer span.End()
	want := trace.SpanContextFromContext(ctx)
	if !want.IsValid() {
		t.Fatal("expected a valid span context from the real SDK tracer")
	}

	headers := injectTraceHeaders(ctx)
	if len(headers) == 0 {
		t.Fatal("expected inject to produce at least a traceparent header")
	}

	extracted := extractTraceContext(context.Background(), headers)
	got := trace.SpanContextFromContext(extracted)
	if !got.IsValid() {
		t.Fatal("expected extract to recover a valid span context")
	}
	if got.TraceID() != want.TraceID() {
		t.Fatalf("trace id mismatch: got %s want %s", got.TraceID(), want.TraceID())
	}
	if got.SpanID() != want.SpanID() {
		t.Fatalf("span id mismatch: got %s want %s", got.SpanID(), want.SpanID())
	}
}

// TestTraceHeaderNoopWhenTracingDisabled confirms the default (no provider
// configured, as in every service until DATACERN_OTEL_ENABLED is set) is a
// true no-op: no headers added, and extracting an empty/absent header set
// leaves the context unchanged.
func TestTraceHeaderNoopWhenTracingDisabled(t *testing.T) {
	prevProp := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator()) // empty: the real default
	t.Cleanup(func() { otel.SetTextMapPropagator(prevProp) })

	if headers := injectTraceHeaders(context.Background()); headers != nil {
		t.Fatalf("expected no trace headers when tracing is disabled, got %v", headers)
	}

	ctx := context.Background()
	got := extractTraceContext(ctx, nil)
	if got != ctx {
		t.Fatal("expected extractTraceContext to return the same context unchanged with no headers")
	}
}
