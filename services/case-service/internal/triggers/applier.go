// Package triggers applies tenant-authored case-trigger rules to
// ingestion.completed events (realtime-decisioning INC-1): match enabled
// triggers → fetch the dataset's rows from dataset-service (filter pushdown)
// → materialize matching rows as cases through the SAME CreateCases path the
// inference auto-case consumer uses. Dedup by (dataset_urn, row_pk) makes
// replays and re-ingestions idempotent; triggers create work, never decisions.
package triggers

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/datacern-ai/case-service/internal/domain"
	"github.com/datacern-ai/case-service/internal/store"
)

// RowsPage is one browse_rows page from dataset-service (DST-FR-050).
type RowsPage struct {
	Columns []string
	Rows    [][]any
}

// RowsClient fetches dataset rows. Implemented by DatasetHTTP (runtime) and a
// test double in unit tests.
type RowsClient interface {
	BrowseRows(ctx context.Context, tenant uuid.UUID, datasetID string,
		conditions []domain.TriggerCondition, limit int) (*RowsPage, error)
	// BrowseDeltaRows fetches ONLY the rows appended by one ingestion
	// (dataset-service resolves the delta from catalog snapshot summaries,
	// independent of version registration). Conditions push down exactly as
	// in BrowseRows. This is the incremental read the delta trigger path
	// evaluates conditions over — no registration catch-up wait required.
	BrowseDeltaRows(ctx context.Context, tenant uuid.UUID, datasetID string,
		ingestionID string, conditions []domain.TriggerCondition, limit int) (*RowsPage, error)
	// CurrentSnapshotID returns the Iceberg snapshot id of the dataset's
	// REGISTERED current version ("" if none yet). browse_rows serves that
	// pinned snapshot, and dataset-service bumps it asynchronously from the
	// same ingestion.completed event this applier consumes — so on appends the
	// applier must wait for registration to catch up to the event's snapshot
	// or it browses pre-append rows and silently misses the increment. Only
	// the legacy full-snapshot path needs this.
	CurrentSnapshotID(ctx context.Context, tenant uuid.UUID, datasetID string) (string, error)
}

// DatasetHTTP is the real dataset-service rows client. A background consumer
// has no end-user bearer, so it mints a least-privilege service token
// (scopes=["dataset.dataset.read"]) with the same platform signing key the
// action-registration path uses — the OPA service rule authorizes the exact
// scoped action, nothing broader.
type DatasetHTTP struct {
	BaseURL  string
	Issuer   string
	Audience string
	KID      string
	Key      *rsa.PrivateKey
	client   *http.Client
}

// NewDatasetHTTP builds the runtime client; key may be nil (client disabled —
// BrowseRows then errors, surfacing misconfiguration rather than faking rows).
func NewDatasetHTTP(baseURL, issuer, audience, kid string, key *rsa.PrivateKey) *DatasetHTTP {
	return &DatasetHTTP{BaseURL: baseURL, Issuer: issuer, Audience: audience, KID: kid,
		Key: key, client: &http.Client{Timeout: 30 * time.Second}}
}

func (d *DatasetHTTP) mint(tenant uuid.UUID) (string, error) {
	return d.mintScopes(tenant, []string{"dataset.dataset.read"})
}

func (d *DatasetHTTP) mintScopes(tenant uuid.UUID, scopes []string) (string, error) {
	if d.Key == nil {
		return "", fmt.Errorf("dataset client signing key not configured")
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":       "svc:case-service",
		"typ":       "service",
		"tenant_id": tenant.String(),
		"scopes":    scopes,
		"iss":       d.Issuer,
		"aud":       d.Audience,
		"iat":       now.Unix(),
		"exp":       now.Add(5 * time.Minute).Unix(),
		"jti":       fmt.Sprintf("case-trigger-%d", now.UnixNano()),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	if d.KID != "" {
		tok.Header["kid"] = d.KID
	}
	return tok.SignedString(d.Key)
}

// OntologyTypeExists asks dataset-service's public ontology API whether the
// workspace declares entity_key (Knowledge Spine WS5 — the evidence-upload
// registry check). Three-way contract mirroring semantic-service's authoring
// validation: (true, nil) declared; (false, nil) a DEFINITIVE miss (the
// registry answered 404); (false, err) the registry was unreachable or errored
// — the caller fails SOFT on err, because the tag is optional metadata and an
// outage must never block evidence upload.
func (d *DatasetHTTP) OntologyTypeExists(ctx context.Context, tenant uuid.UUID,
	workspaceID uuid.UUID, entityKey string) (bool, error) {
	if d.BaseURL == "" {
		return false, fmt.Errorf("dataset-service not configured (DATASET_URL)")
	}
	tok, err := d.mintScopes(tenant, []string{"dataset.ontology.read"})
	if err != nil {
		return false, err
	}
	u := fmt.Sprintf("%s/api/v1/ontology/entities/%s?filter[workspace_id]=%s",
		strings.TrimRight(d.BaseURL, "/"), url.PathEscape(entityKey),
		url.QueryEscape(workspaceID.String()))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := d.client.Do(req)
	if err != nil {
		return false, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	switch {
	case resp.StatusCode == http.StatusOK:
		return true, nil
	case resp.StatusCode == http.StatusNotFound:
		return false, nil // definitive: the registry answered, the key is not declared
	default:
		return false, fmt.Errorf("dataset-service returned %d", resp.StatusCode)
	}
}

// BrowseRows fetches up to limit rows with the trigger's conditions pushed
// down as dataset-service filter params (filter=<col>:<op>:<value>).
func (d *DatasetHTTP) BrowseRows(ctx context.Context, tenant uuid.UUID, datasetID string,
	conditions []domain.TriggerCondition, limit int) (*RowsPage, error) {
	if d.BaseURL == "" {
		return nil, fmt.Errorf("dataset-service not configured (DATASET_URL)")
	}
	tok, err := d.mint(tenant)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("limit", fmt.Sprintf("%d", limit))
	for _, c := range conditions {
		q.Add("filter", fmt.Sprintf("%s:%s:%s", c.Col, c.Op, c.Value))
	}
	u := fmt.Sprintf("%s/api/v1/datasets/%s/rows?%s", d.BaseURL, url.PathEscape(datasetID), q.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dataset browse_rows: status %d: %s", resp.StatusCode, string(raw))
	}
	var body struct {
		Data struct {
			Columns []string `json:"columns"`
			Rows    [][]any  `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("dataset browse_rows: decode: %w", err)
	}
	return &RowsPage{Columns: body.Data.Columns, Rows: body.Data.Rows}, nil
}

// BrowseDeltaRows fetches up to limit rows appended by one ingestion, with the
// trigger's conditions pushed down — GET /rows?delta_ingestion_id=...
func (d *DatasetHTTP) BrowseDeltaRows(ctx context.Context, tenant uuid.UUID, datasetID string,
	ingestionID string, conditions []domain.TriggerCondition, limit int) (*RowsPage, error) {
	if d.BaseURL == "" {
		return nil, fmt.Errorf("dataset-service not configured (DATASET_URL)")
	}
	tok, err := d.mint(tenant)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("limit", fmt.Sprintf("%d", limit))
	q.Set("delta_ingestion_id", ingestionID)
	for _, c := range conditions {
		q.Add("filter", fmt.Sprintf("%s:%s:%s", c.Col, c.Op, c.Value))
	}
	u := fmt.Sprintf("%s/api/v1/datasets/%s/rows?%s", d.BaseURL, url.PathEscape(datasetID), q.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dataset browse_rows: status %d: %s", resp.StatusCode, string(raw))
	}
	var body struct {
		Data struct {
			Columns []string `json:"columns"`
			Rows    [][]any  `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("dataset browse_rows: decode: %w", err)
	}
	return &RowsPage{Columns: body.Data.Columns, Rows: body.Data.Rows}, nil
}

// CurrentSnapshotID reads GET /datasets/{id} and returns
// current_version.iceberg_snapshot_id as a canonical string ("" if the
// dataset or its version is not registered yet).
func (d *DatasetHTTP) CurrentSnapshotID(ctx context.Context, tenant uuid.UUID, datasetID string) (string, error) {
	if d.BaseURL == "" {
		return "", fmt.Errorf("dataset-service not configured (DATASET_URL)")
	}
	tok, err := d.mint(tenant)
	if err != nil {
		return "", err
	}
	u := fmt.Sprintf("%s/api/v1/datasets/%s", d.BaseURL, url.PathEscape(datasetID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("dataset get: status %d: %s", resp.StatusCode, string(raw))
	}
	var body struct {
		Data struct {
			CurrentVersion *struct {
				IcebergSnapshotID json.Number `json:"iceberg_snapshot_id"`
			} `json:"current_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", fmt.Errorf("dataset get: decode: %w", err)
	}
	if body.Data.CurrentVersion == nil {
		return "", nil
	}
	return body.Data.CurrentVersion.IcebergSnapshotID.String(), nil
}

// Applier evaluates triggers for one event. Store is the concrete PG store —
// the same instance the API layer uses, so RLS pinning and case-event outbox
// behavior are identical to interactive case creation.
type Applier struct {
	Store *store.PG
	Rows  RowsClient
	// Blob stores intake-snapshot evidence bytes (the same object store the
	// evidence upload API writes to). Nil = snapshots disabled: a trigger with
	// attach_evidence set logs loudly instead of silently skipping, so a
	// misconfigured deployment is visible, not quiet.
	Blob EvidenceBlob
	// SnapshotPollInterval paces the wait for dataset-service to register the
	// event's snapshot before browsing (default 3s; tests shrink it).
	SnapshotPollInterval time.Duration
	// DeltaBrowse switches condition evaluation to the snapshot-delta read
	// (only the rows the event's ingestion appended) — no registration
	// catch-up wait, no full-snapshot rescan, and MaxCasesPerEvent becomes a
	// plain rate limit instead of a correctness crutch. TRIGGER_DELTA_BROWSE
	// env. On delta failure the applier falls back to the legacy full browse,
	// so enabling it is never stricter than the pre-flag behavior.
	DeltaBrowse bool
}

// EvidenceBlob is the minimal surface the applier needs from the evidence
// object store (satisfied by blob.MinioEvidence).
type EvidenceBlob interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
}

// snapshotKey canonicalizes an Iceberg snapshot id for equality checks. The
// Kafka payload decodes numbers to float64 (plain json.Unmarshal) while the
// dataset detail yields the exact json.Number string — Iceberg ids are random
// int64s that exceed float64's exact range, so compare AFTER pushing both
// sides through the same float64 representation. Precision loss is symmetric,
// which is all equality needs.
func snapshotKey(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
		return x.String()
	case string:
		if x == "" {
			return ""
		}
		if f, err := strconv.ParseFloat(x, 64); err == nil {
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
		return x
	default:
		return snapshotKey(fmt.Sprintf("%v", x))
	}
}

// ApplyIngestionCompleted matches enabled triggers against an
// ingestion.completed payload and materializes matching rows as cases.
// Returns an error for transient failures (the Kafka consumer retries; case
// dedup makes retries safe). Malformed payloads are logged and acked.
func (a *Applier) ApplyIngestionCompleted(ctx context.Context, tenant uuid.UUID, payload map[string]any) error {
	datasetURN, _ := payload["dataset_urn"].(string)
	datasetID, _ := payload["dataset_id"].(string)
	datasetName, _ := payload["dataset_name"].(string)
	if datasetURN == "" || datasetID == "" {
		return nil // not a dataset-producing ingestion; nothing to trigger on
	}
	trigs, err := a.Store.ListEnabledTriggers(ctx, tenant)
	if err != nil {
		return err
	}
	eventSnapshot := snapshotKey(payload["iceberg_snapshot_id"])
	ingestionID, _ := payload["ingestion_id"].(string)
	var firstErr error
	for _, t := range trigs {
		if !t.MatchesSource(datasetURN, datasetName) {
			continue
		}
		if err := a.applyOne(ctx, tenant, t, datasetURN, datasetID, eventSnapshot, ingestionID); err != nil {
			slog.Error("case trigger apply failed", "trigger", t.ID, "name", t.Name,
				"dataset_urn", datasetURN, "err", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// browseDelta evaluates the trigger's conditions over ONLY the rows the
// event's ingestion appended. The delta is resolved by dataset-service
// straight from the Iceberg catalog, so no registration catch-up wait is
// needed; the one remaining race is the DATASET ROW itself (created
// asynchronously by dataset-service's consumer on first fire), covered by the
// bounded 404 retry.
func (a *Applier) browseDelta(ctx context.Context, tenant uuid.UUID, t *domain.CaseTrigger,
	datasetID, ingestionID string) (*RowsPage, error) {
	var page *RowsPage
	var err error
	for attempt := 0; attempt < 6; attempt++ {
		page, err = a.Rows.BrowseDeltaRows(ctx, tenant, datasetID, ingestionID, t.Conditions, t.MaxCasesPerEvent)
		if err == nil || !strings.Contains(err.Error(), "status 404") {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return page, err
}

// browseFull is the legacy path: wait for version registration to catch up to
// the event's snapshot, then browse the ENTIRE current snapshot.
func (a *Applier) browseFull(ctx context.Context, tenant uuid.UUID, t *domain.CaseTrigger,
	datasetURN, datasetID, eventSnapshot string) (*RowsPage, error) {
	// dataset-service registers the dataset AND its new version ASYNCHRONOUSLY
	// from the same ingestion.completed event this consumer received. Two races
	// follow. (1) First fire: the dataset does not exist yet → browse 404s —
	// handled by the retry loop below. (2) Append fires: the dataset EXISTS
	// with the PREVIOUS version still current, so browse succeeds immediately
	// but serves PRE-APPEND rows; every fetched row then dedups against
	// existing cases and the increment is silently missed (caught live by the
	// slice-6 journey: second fire opened zero cases). So when the event names
	// its snapshot, wait until the registered current version IS that snapshot
	// before browsing. On timeout, browse anyway with a loud log — never
	// stricter than the pre-fix behavior.
	interval := a.SnapshotPollInterval
	if interval <= 0 {
		interval = 3 * time.Second
	}
	if eventSnapshot != "" {
		caughtUp := false
		for attempt := 0; attempt < 10; attempt++ {
			cur, serr := a.Rows.CurrentSnapshotID(ctx, tenant, datasetID)
			if serr == nil && snapshotKey(cur) == eventSnapshot {
				caughtUp = true
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(interval):
			}
		}
		if !caughtUp {
			slog.Warn("dataset registration did not reach the event's snapshot; browsing anyway (rows may be stale)",
				"trigger", t.ID, "dataset_urn", datasetURN, "event_snapshot", eventSnapshot)
		}
	}
	var page *RowsPage
	var err error
	for attempt := 0; attempt < 6; attempt++ {
		page, err = a.Rows.BrowseRows(ctx, tenant, datasetID, t.Conditions, t.MaxCasesPerEvent)
		if err == nil || !strings.Contains(err.Error(), "status 404") {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return page, err
}

func (a *Applier) applyOne(ctx context.Context, tenant uuid.UUID, t *domain.CaseTrigger,
	datasetURN, datasetID, eventSnapshot, ingestionID string) error {
	var page *RowsPage
	var err error
	if a.DeltaBrowse && ingestionID != "" {
		page, err = a.browseDelta(ctx, tenant, t, datasetID, ingestionID)
		if err != nil {
			// Fall back to the legacy full browse so a delta regression can
			// only ever cost latency, never a lost fire.
			slog.Warn("delta browse failed; falling back to full-snapshot browse",
				"trigger", t.ID, "dataset_urn", datasetURN, "ingestion_id", ingestionID, "err", err)
			page, err = a.browseFull(ctx, tenant, t, datasetURN, datasetID, eventSnapshot)
		}
	} else {
		page, err = a.browseFull(ctx, tenant, t, datasetURN, datasetID, eventSnapshot)
	}
	if err != nil {
		return err
	}
	if len(page.Rows) == 0 {
		// A matched trigger that fetches nothing is usually a condition/type
		// mismatch (e.g. numeric op on a string column degrades to contains in
		// dataset-service). Log it so the miss is diagnosable, then ack.
		slog.Info("case trigger matched but no rows passed conditions",
			"trigger", t.ID, "name", t.Name, "dataset_urn", datasetURN)
		return nil
	}
	colIdx := map[string]int{}
	for i, c := range page.Columns {
		colIdx[c] = i
	}
	pkIdx := 0
	if t.RowPKField != "" {
		i, ok := colIdx[t.RowPKField]
		if !ok {
			// Config error, not transient: ack with a log so the consumer
			// doesn't retry forever against a column that doesn't exist.
			slog.Error("case trigger row_pk_field not in dataset columns",
				"trigger", t.ID, "field", t.RowPKField, "columns", page.Columns)
			return nil
		}
		pkIdx = i
	}

	cellStr := func(v any) string {
		if v == nil {
			return ""
		}
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprintf("%v", v)
	}

	projCols := t.ProjectionFields
	if len(projCols) == 0 {
		projCols = page.Columns
	}

	now := time.Now().UTC()
	due := now.Add(time.Duration(t.DueHours) * time.Hour)
	var cases []*domain.Case
	for _, row := range page.Rows {
		if pkIdx >= len(row) {
			continue
		}
		rowPK := cellStr(row[pkIdx])
		if rowPK == "" {
			continue
		}
		proj := map[string]string{}
		for _, c := range projCols {
			if i, ok := colIdx[c]; ok && i < len(row) {
				proj[c] = cellStr(row[i])
			}
		}
		tproj, trunc := domain.TruncateProjection(proj)
		var dedup *string
		if k, ok := domain.DedupKey(datasetURN, rowPK); ok {
			dedup = &k
		}
		cases = append(cases, &domain.Case{
			ID: domain.NewID(), TenantID: tenant, WorkspaceID: t.WorkspaceID,
			Status: domain.StatusUnassigned, Severity: t.Severity,
			CreatedByID: "trigger/" + t.Name, DatasetURN: datasetURN, RowPK: rowPK,
			DedupKey: dedup, DisplayProjection: tproj, ProjectionTruncated: trunc,
			SourceQueryURNs: []string{}, DueDate: due, CustomFields: map[string]any{},
			CaseVersion: 1, CreatedAt: now, UpdatedAt: now,
		})
	}
	if len(cases) == 0 {
		return nil
	}
	op := domain.Op{Tenant: tenant, Actor: domain.Actor{Type: "service", ID: "case-service"}}
	created, _, err := a.Store.CreateCases(ctx, op, cases, "", 24*time.Hour)
	if err != nil {
		return err
	}
	if len(created) > 0 {
		slog.Info("case trigger created cases", "trigger", t.ID, "name", t.Name,
			"dataset_urn", datasetURN, "created", len(created))
		_ = a.Store.TouchTriggerFired(ctx, tenant, t.ID, now)
		if t.AttachEvidence {
			a.attachIntakeSnapshots(ctx, tenant, t, datasetURN, page, colIdx, created, now)
		}
	}
	return nil
}

// attachIntakeSnapshots freezes each created case's matched source row as a
// governed CaseEvidence attachment (real-time case-streams add-on): the bytes
// go to the SAME object store as human evidence uploads, the pointer row goes
// through the SAME InsertEvidence path, and the workspace is inherited from
// the trigger — department isolation carries to the snapshot automatically.
//
// Best-effort by design: the cases already exist (row_pk dedup means a Kafka
// redelivery would NOT recreate them, so failing the event here could never
// retry the snapshots into place — it would only re-log). A failed snapshot is
// therefore a loud error, not a rolled-back case.
func (a *Applier) attachIntakeSnapshots(ctx context.Context, tenant uuid.UUID,
	t *domain.CaseTrigger, datasetURN string, page *RowsPage, colIdx map[string]int,
	created []*domain.Case, now time.Time) {
	if a.Blob == nil {
		slog.Error("trigger has attach_evidence but no evidence blob store is wired; skipping snapshots",
			"trigger", t.ID, "name", t.Name)
		return
	}
	pkIdx := 0
	if t.RowPKField != "" {
		if i, ok := colIdx[t.RowPKField]; ok {
			pkIdx = i
		}
	}
	rowByPK := map[string][]any{}
	for _, row := range page.Rows {
		if pkIdx < len(row) {
			if pk := fmt.Sprintf("%v", row[pkIdx]); pk != "" && row[pkIdx] != nil {
				rowByPK[pk] = row
			}
		}
	}
	op := domain.Op{Tenant: tenant, Actor: domain.Actor{Type: "service", ID: "case-service"}}
	for _, c := range created {
		row, ok := rowByPK[c.RowPK]
		if !ok {
			continue // dedup-created earlier or pk mismatch; nothing to freeze
		}
		data, err := BuildIntakeSnapshot(t, datasetURN, page.Columns, row, now)
		if err != nil {
			slog.Error("intake snapshot marshal failed", "case", c.ID, "err", err)
			continue
		}
		ev := &domain.CaseEvidence{
			ID: domain.NewID(), TenantID: tenant, WorkspaceID: t.WorkspaceID,
			CaseID: c.ID, Filename: "intake-snapshot.json",
			ContentType: "application/json", SizeBytes: int64(len(data)),
			StorageKey: fmt.Sprintf("evidence/%s/%s/%s.json", tenant, c.ID, ev0()),
			UploadedBy: "trigger/" + t.Name, CreatedAt: now,
		}
		if err := a.Blob.Put(ctx, ev.StorageKey, data, ev.ContentType); err != nil {
			slog.Error("intake snapshot blob write failed", "case", c.ID, "err", err)
			continue
		}
		if err := a.Store.InsertEvidence(ctx, op, ev); err != nil {
			slog.Error("intake snapshot evidence row insert failed", "case", c.ID, "err", err)
		}
	}
}

func ev0() string { return domain.NewID().String() }

// BuildIntakeSnapshot serializes the matched source row exactly as seen at
// intake: full row (NOT the truncated display projection), column names,
// provenance of which trigger fired on which dataset, and when. Deterministic
// field order via json.Marshal of a struct — byte-stable for a given input,
// so the same intake produces the same snapshot bytes.
func BuildIntakeSnapshot(t *domain.CaseTrigger, datasetURN string,
	columns []string, row []any, capturedAt time.Time) ([]byte, error) {
	type snapshot struct {
		Kind        string         `json:"kind"`
		TriggerID   string         `json:"trigger_id"`
		TriggerName string         `json:"trigger_name"`
		DatasetURN  string         `json:"dataset_urn"`
		Columns     []string       `json:"columns"`
		Row         map[string]any `json:"row"`
		CapturedAt  string         `json:"captured_at"`
	}
	m := make(map[string]any, len(columns))
	for i, col := range columns {
		if i < len(row) {
			m[col] = row[i]
		}
	}
	return json.MarshalIndent(snapshot{
		Kind: "intake_snapshot/v1", TriggerID: t.ID.String(), TriggerName: t.Name,
		DatasetURN: datasetURN, Columns: columns, Row: m,
		CapturedAt: capturedAt.UTC().Format(time.RFC3339),
	}, "", "  ")
}
