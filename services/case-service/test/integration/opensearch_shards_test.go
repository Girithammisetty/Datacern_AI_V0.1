package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/datacern-ai/case-service/internal/search"
)

// TestOpenSearchConfigurableShardCount proves B9/B10's fix: a tenant index's
// number_of_shards is driven by the Client's configured value, not the old
// hardcoded 1, verified against the REAL OpenSearch cluster (no simulation).
func TestOpenSearchConfigurableShardCount(t *testing.T) {
	requireHarness(t)
	ctx := context.Background()
	tenant := uuid.New()

	client, err := search.New("http://localhost:9200", search.Options{NumShards: 3})
	require.NoError(t, err)
	require.NoError(t, client.EnsureIndex(ctx, tenant))

	alias := "cases-" + tenant.String()
	resp, err := http.Get("http://localhost:9200/" + alias + "/_settings")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var out map[string]struct {
		Settings struct {
			Index struct {
				NumberOfShards string `json:"number_of_shards"`
			} `json:"index"`
		} `json:"settings"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Len(t, out, 1, "expected exactly one physical index behind the alias")
	for _, idx := range out {
		require.Equal(t, "3", idx.Settings.Index.NumberOfShards,
			"the index must be created with the Client's configured shard count, not the old hardcoded 1")
	}
}
