package siemexport

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	gcevent "github.com/datacern-ai/go-common/event"
)

// Format is a per-tenant SIEM export wire format (BRD 59 WS2). JSON is the
// existing audit.export.v1 payload verbatim; CEF and LEEF are the two
// industry-standard line formats most SIEM collectors (Splunk, QRadar,
// ArcSight, Microsoft Sentinel) accept directly over HTTP/syslog.
type Format string

const (
	FormatJSON Format = "JSON"
	FormatCEF  Format = "CEF"
	FormatLEEF Format = "LEEF"
)

// deviceVendor/Product are the fixed CEF/LEEF header identity for every
// exported event — the platform is always the "device" in these formats
// (the customer's SIEM is the collector).
const (
	deviceVendor  = "Datacern"
	deviceProduct = "AuditService"
)

// severityForOutcome maps Event.Outcome to a CEF severity (0-10, low-to-high)
// per the CEF spec's convention that a denied/failed security-relevant event
// ranks higher than a routine success.
func severityForOutcome(outcome string) int {
	switch outcome {
	case "denied", "rejected", "failed":
		return 7
	case "expired":
		return 4
	case "success":
		return 1
	default: // "recorded" and anything else uncategorized
		return 3
	}
}

// FormatEvent renders env (as produced by Envelope(rec)) in the requested
// wire format. env.Payload is expected to carry the audit.export.v1 Event
// fields (schema_version, action, outcome, ...) exactly as Envelope() builds
// them — this function reads them back out rather than taking an Event
// directly, since that's the same shape the Kafka/webhook JSON transport
// already carries end to end.
func FormatEvent(env gcevent.Envelope, format Format) (string, error) {
	switch format {
	case FormatCEF:
		return formatCEF(env), nil
	case FormatLEEF:
		return formatLEEF(env), nil
	case FormatJSON, "":
		b, err := json.Marshal(env)
		if err != nil {
			return "", fmt.Errorf("marshal JSON export event: %w", err)
		}
		return string(b), nil
	default:
		return "", fmt.Errorf("unsupported SIEM export format %q", format)
	}
}

func payloadStr(env gcevent.Envelope, key string) string {
	v, _ := env.Payload[key].(string)
	return v
}

// cefEscapeHeader escapes CEF header fields (pipe and backslash) per the CEF
// spec section "CEF Header" — headers use only \| and \\, not the extension
// escaping rules below.
func cefEscapeHeader(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `|`, `\|`)
	return s
}

// cefEscapeExtension escapes CEF extension VALUES per the CEF spec: backslash,
// equals sign, and newline must be escaped; pipe does not need escaping here
// (only header fields are pipe-delimited).
func cefEscapeExtension(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `=`, `\=`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

// formatCEF renders one CEF 0 record:
//
//	CEF:0|Datacern|AuditService|<schema_version>|<action>|<source_event_type>|<severity>|<extension>
//
// Extension carries the standard CEF keys the fields map onto most directly
// (suser/duser/act/outcome/cs1..) plus the platform-specific fields as
// labeled custom string fields (cs2/cs3) so no information is dropped even
// though CEF has no native "tenant_id"/"resource_urn" key.
func formatCEF(env gcevent.Envelope) string {
	action := payloadStr(env, "action")
	sourceEventType := payloadStr(env, "source_event_type")
	outcome := payloadStr(env, "outcome")
	schemaVersion := payloadStr(env, "schema_version")

	header := fmt.Sprintf("CEF:0|%s|%s|%s|%s|%s|%d",
		cefEscapeHeader(deviceVendor), cefEscapeHeader(deviceProduct), cefEscapeHeader(schemaVersion),
		cefEscapeHeader(action), cefEscapeHeader(sourceEventType), severityForOutcome(outcome))

	ext := []string{
		"externalId=" + cefEscapeExtension(env.EventID.String()),
		"rt=" + strconv.FormatInt(env.OccurredAt.UnixMilli(), 10),
		"outcome=" + cefEscapeExtension(outcome),
		"duser=" + cefEscapeExtension(env.Actor.ID),
		"act=" + cefEscapeExtension(action),
		"cs1Label=tenant_id", "cs1=" + cefEscapeExtension(env.TenantID.String()),
		"cs2Label=resource_urn", "cs2=" + cefEscapeExtension(env.ResourceURN),
		"cs3Label=source_event_id", "cs3=" + cefEscapeExtension(payloadStr(env, "source_event_id")),
		"cs4Label=payload_digest", "cs4=" + cefEscapeExtension(payloadStr(env, "payload_digest")),
	}
	if env.TraceID != "" {
		ext = append(ext, "cs5Label=trace_id", "cs5="+cefEscapeExtension(env.TraceID))
	}
	return header + "|" + strings.Join(ext, " ")
}

// leefEscape escapes LEEF extension values: LEEF 2.0 uses tab as the field
// delimiter and pipe/equals have no special meaning in the extension, but a
// literal tab or newline inside a value would corrupt the record, so both
// are escaped.
func leefEscape(s string) string {
	s = strings.ReplaceAll(s, "\t", `\t`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

// formatLEEF renders one LEEF 2.0 record (IBM QRadar's format):
//
//	LEEF:2.0|Datacern|AuditService|<schema_version>|<source_event_type>|<tab-separated key=value ext>
func formatLEEF(env gcevent.Envelope) string {
	action := payloadStr(env, "action")
	sourceEventType := payloadStr(env, "source_event_type")
	outcome := payloadStr(env, "outcome")
	schemaVersion := payloadStr(env, "schema_version")

	header := fmt.Sprintf("LEEF:2.0|%s|%s|%s|%s",
		deviceVendor, deviceProduct, schemaVersion, leefEscape(sourceEventType))

	ext := []string{
		"externalId=" + leefEscape(env.EventID.String()),
		"devTime=" + strconv.FormatInt(env.OccurredAt.UnixMilli(), 10),
		"outcome=" + leefEscape(outcome),
		"usrName=" + leefEscape(env.Actor.ID),
		"act=" + leefEscape(action),
		"tenantId=" + leefEscape(env.TenantID.String()),
		"resourceUrn=" + leefEscape(env.ResourceURN),
		"sourceEventId=" + leefEscape(payloadStr(env, "source_event_id")),
		"payloadDigest=" + leefEscape(payloadStr(env, "payload_digest")),
	}
	if env.TraceID != "" {
		ext = append(ext, "traceId="+leefEscape(env.TraceID))
	}
	return header + "|" + strings.Join(ext, "\t")
}
