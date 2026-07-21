package storage

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// RemoteBlobStore is a BlobStore that proxies to a relay node's blob endpoint
// (central-proxy storage). The payload is E2E ciphertext, but the request also
// carries a bearer secret the node validates, so the channel is pinned-TLS when
// the node reported a cert fingerprint (fingerprint != ""): standard CA checks
// are disabled and the node's self-signed cert is matched by SHA-256, which
// keeps the secret and blob traffic from being sniffed or tampered on-path.
// Legacy nodes that reported no fingerprint fall back to plain HTTP unchanged.
type RemoteBlobStore struct {
	baseURL string
	secret  string
	hc      *http.Client
}

func NewRemoteBlobStore(baseURL, secret, fingerprint string, hc *http.Client) *RemoteBlobStore {
	if fingerprint != "" {
		hc = pinnedClient(hc, fingerprint)
	}
	return &RemoteBlobStore{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, hc: hc}
}

// pinCacheKey identifies a pinned client by its base client + fingerprint, so
// every RemoteBlobStore built for the same node reuses one client (one
// connection pool). NewRemoteBlobStore is called per blob request — including
// once per resumable-upload PATCH chunk — so minting a fresh *http.Transport
// each time (as this used to) leaked its keep-alive idle connections and their
// goroutines forever (neither the central nor the node sets an idle timeout),
// exhausting file descriptors under normal traffic.
type pinCacheKey struct {
	base        *http.Client
	fingerprint string
}

var pinnedClientCache sync.Map // pinCacheKey -> *http.Client

// pinnedClient returns a client (cached per base+fingerprint) whose TLS
// verification is replaced by a fingerprint pin. It clones hc's *http.Transport
// so all other settings — crucially the SSRF-guarded DialContext and the
// ResponseHeaderTimeout — are preserved; only TLSClientConfig changes. The
// clone's connection pool is shared across all requests to the node, so idle
// connections are reused (and pool-capped) rather than accumulating.
func pinnedClient(hc *http.Client, fingerprint string) *http.Client {
	key := pinCacheKey{base: hc, fingerprint: fingerprint}
	if c, ok := pinnedClientCache.Load(key); ok {
		return c.(*http.Client)
	}
	var tr *http.Transport
	if base, ok := hc.Transport.(*http.Transport); ok && base != nil {
		tr = base.Clone()
	} else {
		tr = &http.Transport{}
	}
	tr.TLSClientConfig = &tls.Config{
		InsecureSkipVerify:    true, // pinning (VerifyPeerCertificate) replaces CA + hostname verification
		MinVersion:            tls.VersionTLS13,
		VerifyPeerCertificate: pinVerify(fingerprint),
	}
	c := *hc
	c.Transport = tr
	actual, _ := pinnedClientCache.LoadOrStore(key, &c)
	return actual.(*http.Client)
}

// pinVerify matches the leaf cert's SHA-256 (hex) against want in constant time.
func pinVerify(want string) func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("remote blob: node presented no TLS certificate")
		}
		sum := sha256.Sum256(rawCerts[0])
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(want)) != 1 {
			return errors.New("remote blob: node TLS fingerprint mismatch (pin failed)")
		}
		return nil
	}
}

func (r *RemoteBlobStore) url(key string) string { return r.baseURL + "/blob/" + key }

// errCapturingReader records the first error the wrapped reader returns, so Put
// can surface it verbatim even when the HTTP transport masks it.
type errCapturingReader struct {
	r   io.Reader
	mu  sync.Mutex
	err error
}

func (e *errCapturingReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF {
		e.mu.Lock()
		if e.err == nil {
			e.err = err
		}
		e.mu.Unlock()
	}
	return n, err
}

func (e *errCapturingReader) readerErr() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

func (r *RemoteBlobStore) Put(ctx context.Context, key string, body io.Reader) (int64, error) {
	er := &errCapturingReader{r: body}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, r.url(key), er)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if rerr := er.readerErr(); rerr != nil {
		return 0, rerr // the source reader failed (e.g. cappedReader errTooLarge) — surface it verbatim
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

// GetRange fetches the object from `start` to the end via an HTTP Range
// request. It returns a reader positioned exactly at `start`: normally the node
// answers 206 and the body already starts there; defensively, if the node
// ignored Range and returned 200 (whole object), the leading `start` bytes are
// skipped so callers get identical behaviour either way.
func (r *RemoteBlobStore) GetRange(ctx context.Context, key string, start int64) (io.ReadCloser, error) {
	if start <= 0 {
		return r.Get(ctx, key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url(key), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	resp, err := r.hc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	switch resp.StatusCode {
	case http.StatusPartialContent:
		return resp.Body, nil
	case http.StatusOK:
		if _, err := io.CopyN(io.Discard, resp.Body, start); err != nil {
			resp.Body.Close()
			return nil, err
		}
		return resp.Body, nil
	default:
		resp.Body.Close()
		return nil, fmt.Errorf("remote blob get %s: status %d", key, resp.StatusCode)
	}
}

// Append PATCHes a chunk to the node at `offset` (sent via X-Blob-Offset), for
// resumable uploads. The node replies {"size":N} on success, or 409 with the
// node's current size on an offset mismatch (surfaced as ErrOffsetMismatch).
func (r *RemoteBlobStore) Append(ctx context.Context, key string, offset int64, body io.Reader) (int64, error) {
	er := &errCapturingReader{r: body}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, r.url(key), er)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	req.Header.Set("X-Blob-Offset", strconv.FormatInt(offset, 10))
	resp, err := r.hc.Do(req)
	if rerr := er.readerErr(); rerr != nil {
		// The source reader failed (e.g. cappedReader's errTooLarge on an oversize
		// chunk). Surface it verbatim — without this the http.Client masks it as a
		// generic transport error, so the caller returns 500 instead of 413 and
		// clobbers its committed offset with the 0 returned below.
		return 0, rerr
	}
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		var out struct {
			Size int64 `json:"size"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out.Size, ErrOffsetMismatch
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return 0, fmt.Errorf("remote blob append %s: status %d: %s", key, resp.StatusCode, string(b))
	}
	var out struct {
		Size int64 `json:"size"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Size, nil
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
