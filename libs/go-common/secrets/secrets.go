// Package secrets is the shared minimal Vault KV v2 client (net/http only).
// Services store NO secret material in Postgres — a row carries only a
// vault_ref (the full KV v2 data path, e.g.
// `secret/data/tenants/<tenant>/fhir-backends/<id>`), and this client reads,
// writes and deletes the material behind that ref. The KV v2 wire format puts
// the mount and the literal `data` segment in the URL
// (`{addr}/v1/secret/data/{relative-path}`), so the stored full-path
// convention is translated here exactly once instead of ad hoc per caller.
package secrets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrNotFound is returned by Get when the path has no (current) secret version.
var ErrNotFound = errors.New("secret not found")

// Client talks to one Vault server's KV v2 engine mounted at `secret/`.
type Client struct {
	addr  string
	token string
	http  *http.Client
}

// New builds a client for addr (e.g. http://vault:8200) authenticating with
// token (X-Vault-Token). An empty addr yields a client whose every call fails
// with a clear configuration error — callers decide at boot whether that is
// fatal (REQUIRE_REAL_ADAPTERS) or a loud dev degradation.
func New(addr, token string) *Client {
	return &Client{addr: strings.TrimRight(addr, "/"), token: token,
		http: &http.Client{Timeout: 10 * time.Second}}
}

// url translates a stored vault_ref to the KV v2 REST URL. The repo convention
// stores the FULL path `secret/data/<relative>`; the API URL is
// `{addr}/v1/secret/data/<relative>` — so the `secret/data/` prefix is
// stripped (when present) and re-emitted exactly once in the URL.
func (c *Client) url(path string) (string, error) {
	if c.addr == "" {
		return "", errors.New("vault not configured (empty address)")
	}
	p := strings.Trim(path, "/")
	p = strings.TrimPrefix(p, "secret/data/")
	if p == "" {
		return "", errors.New("empty secret path")
	}
	return c.addr + "/v1/secret/data/" + p, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	u, err := c.url(path)
	if err != nil {
		return nil, err
	}
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Vault-Token", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.http.Do(req)
}

// Get reads the current version of the secret at path (KV v2 read envelope
// {"data":{"data":{...}}}).
func (c *Client) Get(ctx context.Context, path string) (map[string]string, error) {
	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vault get: status %d", resp.StatusCode)
	}
	var env struct {
		Data struct {
			Data map[string]string `json:"data"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&env); err != nil {
		return nil, fmt.Errorf("vault get: decode: %w", err)
	}
	if env.Data.Data == nil {
		return nil, ErrNotFound
	}
	return env.Data.Data, nil
}

// Put writes data as a new version at path (KV v2 write body {"data":{...}}).
func (c *Client) Put(ctx context.Context, path string, data map[string]string) error {
	resp, err := c.do(ctx, http.MethodPost, path, map[string]any{"data": data})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("vault put: status %d", resp.StatusCode)
	}
	return nil
}

// Delete soft-deletes the latest version at path (DELETE /v1/secret/data/...).
func (c *Client) Delete(ctx context.Context, path string) error {
	resp, err := c.do(ctx, http.MethodDelete, path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent &&
		resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("vault delete: status %d", resp.StatusCode)
	}
	return nil
}
