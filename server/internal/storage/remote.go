package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// RemoteBlobStore is a BlobStore that proxies to a relay node's HTTP blob
// endpoint (central-proxy storage). The payload is E2E ciphertext, so plain HTTP
// is acceptable; requests carry a bearer secret the node validates.
type RemoteBlobStore struct {
	baseURL string
	secret  string
	hc      *http.Client
}

func NewRemoteBlobStore(baseURL, secret string, hc *http.Client) *RemoteBlobStore {
	return &RemoteBlobStore{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, hc: hc}
}

func (r *RemoteBlobStore) url(key string) string { return r.baseURL + "/blob/" + key }

// errCapturingReader records the first error the wrapped reader returns, so Put
// can surface it verbatim even when the HTTP transport masks it.
type errCapturingReader struct {
	r   io.Reader
	err error
}

func (e *errCapturingReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF && e.err == nil {
		e.err = err
	}
	return n, err
}

func (r *RemoteBlobStore) Put(ctx context.Context, key string, body io.Reader) (int64, error) {
	er := &errCapturingReader{r: body}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, r.url(key), er)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if er.err != nil {
		return 0, er.err // the source reader failed (e.g. cappedReader errTooLarge) — surface it verbatim
	}
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return 0, fmt.Errorf("remote blob put %s: status %d: %s", key, resp.StatusCode, string(b))
	}
	var out struct {
		Size int64 `json:"size"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Size, nil
}

func (r *RemoteBlobStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url(key), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if err != nil {
		return nil, err // unreachable node — caller maps to 503
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("remote blob get %s: status %d", key, resp.StatusCode)
	}
	return resp.Body, nil // caller closes
}

func (r *RemoteBlobStore) Delete(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, r.url(key), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("remote blob delete %s: status %d", key, resp.StatusCode)
	}
	return nil // 404 is success (idempotent)
}
