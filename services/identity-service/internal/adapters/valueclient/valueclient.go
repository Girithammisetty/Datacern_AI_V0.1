// Package valueclient implements domain.ValueSummaryReader (BRD 70 slice 3,
// DSP-FR-021) against the REAL usage-service HTTP API
// (GET /api/v1/value/summary, BRD 69). This is the "identity-service calls
// usage-service over HTTP the same way any other service-to-service call in
// this repo works" path the task briefing asks for -- structurally identical
// to internal/rbacclient's pattern for calling rbac-service: mint a
// short-lived, service-typed token via the platform Issuer, call the real
// endpoint, decode the response.
//
// Scope note (honestly flagged, mirroring internal/adapters/demoseed's own
// doc comment about its broad-scope service token): the minted token carries
// a wildcard scope ["*"], the same precedent demoseed's SubprocessRunner and
// deploy/e2e's harness already use, because usage-service's RequireAction
// gate is OPA-projection-based (rbac-service's permissions_flat) rather than
// JWT-scope-based -- a narrower Scopes list would not tighten anything real
// here, only look like it does. Whether a "service" typed, wildcard-scoped
// token actually clears usage-service's RequireAction(usage.report.read) OPA
// check has not been exercised against a live stack in this build (no
// Docker/OPA available in this environment) -- see the initiative doc's
// honesty notes for the same caveat applied to demoseed's own cross-service
// calls.
package valueclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// Client drives usage-service's GET /api/v1/value/summary (BRD 69,
// ROI-FR-010) on behalf of PocService.Progress/ExportReport (BRD 70,
// DSP-FR-021). All fields except HTTP are required.
type Client struct {
	BaseURL string             // usage-service base URL, e.g. http://localhost:8084
	Issuer  domain.TokenIssuer // mints the service token (platform signing key)
	HTTP    *http.Client
}

var _ domain.ValueSummaryReader = (*Client)(nil)

func (c *Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// wireEstimatedValue mirrors usage-service's EstimatedValue.MarshalJSON
// shape ({"value":..,"assumption_version":..}, or JSON null).
type wireEstimatedValue struct {
	Value             float64 `json:"value"`
	AssumptionVersion int     `json:"assumption_version"`
}

type wireDecisions struct {
	Total int64 `json:"total"`
}

type wireAdoption struct {
	ActiveUsers int64 `json:"active_users"`
}

type wireProvenance struct {
	AssumptionVersion *int    `json:"assumption_version"`
	MeterGap          *string `json:"meter_gap"`
}

type wireValueSummary struct {
	Period         string              `json:"period"`
	Decisions      *wireDecisions      `json:"decisions"`
	HoursSavedEst  *wireEstimatedValue `json:"hours_saved_est"`
	NetValueEstUSD *wireEstimatedValue `json:"net_value_est_usd"`
	Adoption       wireAdoption        `json:"adoption"`
	Provenance     wireProvenance      `json:"provenance"`
}

// Summary reads usage-service's value/summary for tenantID over one
// calendar-month period ("YYYY-MM"). Errors (usage-service unreachable,
// non-200, decode failure) propagate -- PocService fails loud rather than
// fabricating progress when the real data can't be read (ROI-NFR-004
// spirit).
func (c *Client) Summary(ctx context.Context, tenantID uuid.UUID, period string) (*domain.ValueSummaryView, error) {
	token, _, err := c.Issuer.Issue(domain.Claims{
		Subject: "svc:identity-service", TenantID: tenantID, Typ: domain.TypService, Scopes: []string{"*"},
	})
	if err != nil {
		return nil, fmt.Errorf("mint usage-service token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.BaseURL+"/api/v1/value/summary?period="+period, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("usage-service value/summary: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage-service value/summary: status %d: %s", resp.StatusCode, string(raw))
	}
	var w wireValueSummary
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, fmt.Errorf("usage-service value/summary: decode: %w", err)
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap) // best-effort: carried verbatim into poc-report.v1, never re-derived
	view := &domain.ValueSummaryView{
		Period:            w.Period,
		AssumptionVersion: w.Provenance.AssumptionVersion,
		MeterGap:          w.Provenance.MeterGap,
		Raw:               rawMap,
	}
	if w.Decisions != nil {
		v := w.Decisions.Total
		view.DecisionsTotal = &v
	}
	if w.HoursSavedEst != nil {
		v := w.HoursSavedEst.Value
		view.HoursSavedEstHours = &v
	}
	if w.NetValueEstUSD != nil {
		v := w.NetValueEstUSD.Value
		view.NetValueEstUSD = &v
	}
	users := w.Adoption.ActiveUsers
	view.AdoptionActiveUsers = &users
	return view, nil
}
