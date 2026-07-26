package recon

import (
	"context"
	"strings"
	"time"
)

// BillObject describes one object under the provider-bill-drop prefix.
type BillObject struct {
	Key  string
	Size int64
}

// BillStore lists and reads provider-bill CSV drops (USG-FR-070: "provider
// bill exports ... dropped in a configured object-storage prefix"). The real
// implementation (internal/jobs.MinioBillStore) wraps go-common/objectstore's
// real S3/MinIO client. This is deliberately NOT a live AWS CUR/Azure/GCP/LLM
// provider billing API client — no such adapter exists anywhere in this repo,
// and per README "No credential-gated exceptions" those stay out of scope.
// An operator or an out-of-repo pull job drops the provider's CSV export into
// this prefix; the reconciliation job only reads it.
type BillStore interface {
	List(ctx context.Context, prefix string) ([]BillObject, error)
	Get(ctx context.Context, key string) ([]byte, error)
}

// ParseBillKey extracts (provider, month) from a bill-drop object key of the
// form "<prefix>/<provider>/<month>.csv", e.g. "bills/openai/2026-05.csv" ->
// ("openai", "2026-05"). ok is false for any key that doesn't match this
// layout (skipped by the reconciliation job rather than failing it).
func ParseBillKey(prefix, key string) (provider, month string, ok bool) {
	rel := strings.TrimPrefix(strings.TrimPrefix(key, prefix), "/")
	parts := strings.Split(rel, "/")
	if len(parts) != 2 || parts[0] == "" {
		return "", "", false
	}
	base := strings.TrimSuffix(parts[1], "/")
	if !strings.HasSuffix(base, ".csv") {
		return "", "", false
	}
	month = strings.TrimSuffix(base, ".csv")
	if _, err := time.Parse("2006-01", month); err != nil {
		return "", "", false
	}
	return parts[0], month, true
}
