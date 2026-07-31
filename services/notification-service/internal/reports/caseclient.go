package reports

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// CaseClient reads the DECISIONS side of a report from case-service.
//
// It calls the same GET /cases/queue-intelligence the approver panel uses —
// deliberately not a second aggregation over the same tables. A report and the
// panel disagreeing about how many cases were resolved this week would be worse
// than either being slightly wrong, and two implementations of "resolved in a
// window" is exactly how that happens.
type CaseClient struct {
	BaseURL string
	HTTP    *http.Client
}

func NewCaseClient(base string) *CaseClient {
	return &CaseClient{BaseURL: base, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// DecisionsDigest is what the queue produced over the report's own period.
//
// Percentiles stay POINTERS the whole way to the renderer. case-service returns
// null when nothing resolved in the window, and a report that prints "0s median
// time to decision" to an executive is not a rounding error — it is a false
// claim that the team decided everything instantly. Absence has to survive as
// absence.
type DecisionsDigest struct {
	WindowDays   int
	Opened       int
	Resolved     int
	Closed       int
	OpenTotal    int
	SLABreached  int
	P50Seconds   *int64
	Sample       int
}

type queueIntelDTO struct {
	Data struct {
		WindowDays int `json:"window_days"`
		Open       struct {
			Total int `json:"total"`
		} `json:"open"`
		SLA struct {
			Breached int `json:"breached"`
		} `json:"sla"`
		Throughput struct {
			Opened   int `json:"opened"`
			Resolved int `json:"resolved"`
			Closed   int `json:"closed"`
		} `json:"throughput"`
		Latency struct {
			P50Seconds *int64 `json:"p50_seconds"`
			Sample     int    `json:"sample"`
		} `json:"latency"`
	} `json:"data"`
}

// FetchDecisions reads the queue aggregate for the report's window.
//
// The caller treats a failure as "omit the section", never as "report zeroes":
// an unreachable case-service must not turn into a digest claiming nothing was
// decided this week.
func (c *CaseClient) FetchDecisions(ctx context.Context, token string, windowDays int) (*DecisionsDigest, error) {
	if windowDays <= 0 {
		windowDays = 7
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.BaseURL+"/api/v1/cases/queue-intelligence?days="+strconv.Itoa(windowDays), nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("case-service unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("case-service queue-intelligence: %d %s", resp.StatusCode, truncate(raw, 200))
	}
	var dto queueIntelDTO
	if err := json.Unmarshal(raw, &dto); err != nil {
		return nil, fmt.Errorf("decode queue-intelligence: %w", err)
	}
	d := dto.Data
	return &DecisionsDigest{
		WindowDays:  d.WindowDays,
		Opened:      d.Throughput.Opened,
		Resolved:    d.Throughput.Resolved,
		Closed:      d.Throughput.Closed,
		OpenTotal:   d.Open.Total,
		SLABreached: d.SLA.Breached,
		P50Seconds:  d.Latency.P50Seconds,
		Sample:      d.Latency.Sample,
	}, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
