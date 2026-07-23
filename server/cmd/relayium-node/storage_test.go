package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/dltoken"
	"github.com/relayium/relayium/internal/storage"
)

// TestDLEndpointTokenAuth pins the public direct-download endpoint: GET
// /dl/{key}?t=<token> serves the blob to a client that presents a valid signed
// token (no bearer secret — the client must never hold it), and refuses a
// missing, wrong-key, or expired token.
func TestDLEndpointTokenAuth(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	srv := httptest.NewServer(newBlobHandler(ds, secret, nil, nil, nil, nil))
	defer srv.Close()

	// Seed a blob via the bearer-authed PUT.
	putReq, _ := http.NewRequest("PUT", srv.URL+"/blob/dlkey1", bytes.NewReader([]byte("cipher")))
	putReq.Header.Set("Authorization", "Bearer "+secret)
	if resp, err := http.DefaultClient.Do(putReq); err != nil || resp.StatusCode != 200 {
		t.Fatalf("seed put: err=%v code=%v", err, resp.StatusCode)
	}

	get := func(path string) (int, string) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	now := time.Now().Unix()
	good := dltoken.Sign(secret, "dlkey1", now+60, "n1")

	// Valid token → 200 + the ciphertext, WITHOUT any bearer header.
	if code, body := get("/dl/dlkey1?t=" + good); code != 200 || body != "cipher" {
		t.Fatalf("valid token: code=%d body=%q, want 200 \"cipher\"", code, body)
	}
	// No token → refused.
	if code, _ := get("/dl/dlkey1"); code != http.StatusForbidden {
		t.Fatalf("missing token: code=%d, want 403", code)
	}
	// Token minted for a different key → refused.
	other := dltoken.Sign(secret, "otherkey", now+60, "n1")
	if code, _ := get("/dl/dlkey1?t=" + other); code != http.StatusForbidden {
		t.Fatalf("wrong-key token: code=%d, want 403", code)
	}
	// Expired token → refused.
	expired := dltoken.Sign(secret, "dlkey1", now-1, "n1")
	if code, _ := get("/dl/dlkey1?t=" + expired); code != http.StatusForbidden {
		t.Fatalf("expired token: code=%d, want 403", code)
	}
}

// TestPublicDownloadHandlerHidesBlobAPI: the public listener (what Cloudflare
// proxies to) must serve /dl and /healthz but NOT the bearer-authed /blob write
// API — even a valid bearer must not reach a write there.
func TestPublicDownloadHandlerHidesBlobAPI(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	// Seed a blob directly so /dl has something to serve.
	if _, err := ds.Put(t.Context(), "pk", bytes.NewReader([]byte("cipher"))); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newDownloadHandler(ds, secret, nil, nil))
	defer srv.Close()

	// /healthz is up.
	if resp, _ := http.Get(srv.URL + "/healthz"); resp == nil || resp.StatusCode != 200 {
		t.Fatal("public handler must serve /healthz")
	}
	// /dl with a valid token works.
	tok := dltoken.Sign(secret, "pk", time.Now().Unix()+60, "n")
	if resp, _ := http.Get(srv.URL + "/dl/pk?t=" + tok); resp == nil || resp.StatusCode != 200 {
		t.Fatal("public handler must serve /dl")
	}
	// PUT /blob (even with the bearer) must NOT be reachable here.
	req, _ := http.NewRequest("PUT", srv.URL+"/blob/pk", bytes.NewReader([]byte("x")))
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("public download listener must NOT expose the /blob write API")
	}
}

// TestDLReceiptFiresWithServedBytes: after a served download the node reports the
// blob key, the token nonce, and the exact byte count, so central can reconcile.
func TestDLReceiptFiresWithServedBytes(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	if _, err := ds.Put(t.Context(), "rk", bytes.NewReader([]byte("ciphertext!!"))); err != nil { // 12 bytes
		t.Fatal(err)
	}
	got := make(chan [3]string, 1)
	h := newDownloadHandler(ds, secret, nil, func(blobKey, nonce string, served int64) {
		got <- [3]string{blobKey, nonce, strconv.FormatInt(served, 10)}
	})
	srv := httptest.NewServer(h)
	defer srv.Close()

	tok := dltoken.Sign(secret, "rk", time.Now().Unix()+60, "nonceX")
	resp, err := http.Get(srv.URL + "/dl/rk?t=" + tok)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	select {
	case r := <-got:
		if r[0] != "rk" || r[1] != "nonceX" || r[2] != "12" {
			t.Fatalf("receipt = key=%q nonce=%q served=%q, want rk/nonceX/12", r[0], r[1], r[2])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("receipt callback never fired")
	}
}

// TestDLEndpointCORS: the browser fetches the ciphertext cross-origin (it's sent
// from relayium.com to nodeN.relayium.com by a 302), and may use a Range header
// for resumable streaming — which triggers a CORS preflight. The node must
// answer the preflight and expose the range headers to JS.
func TestDLEndpointCORS(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	srv := httptest.NewServer(newBlobHandler(ds, secret, nil, nil, nil, nil))
	defer srv.Close()
	putReq, _ := http.NewRequest("PUT", srv.URL+"/blob/ck", bytes.NewReader([]byte("cipher")))
	putReq.Header.Set("Authorization", "Bearer "+secret)
	http.DefaultClient.Do(putReq)

	// Preflight for a Range GET.
	preReq, _ := http.NewRequest(http.MethodOptions, srv.URL+"/dl/ck", nil)
	preReq.Header.Set("Origin", "https://relayium.com")
	preReq.Header.Set("Access-Control-Request-Method", "GET")
	preReq.Header.Set("Access-Control-Request-Headers", "range")
	pre, err := http.DefaultClient.Do(preReq)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	pre.Body.Close()
	if pre.StatusCode != http.StatusNoContent && pre.StatusCode != http.StatusOK {
		t.Fatalf("preflight status = %d, want 204/200", pre.StatusCode)
	}
	if pre.Header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("preflight must allow the origin")
	}
	if !strings.Contains(strings.ToLower(pre.Header.Get("Access-Control-Allow-Headers")), "range") {
		t.Fatalf("preflight must allow the Range request header, got %q", pre.Header.Get("Access-Control-Allow-Headers"))
	}

	// Actual GET must expose the range/length headers so streaming JS can read them.
	tok := dltoken.Sign(secret, "ck", time.Now().Unix()+60, "n")
	resp, err := http.Get(srv.URL + "/dl/ck?t=" + tok)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	exp := strings.ToLower(resp.Header.Get("Access-Control-Expose-Headers"))
	if !strings.Contains(exp, "content-length") || !strings.Contains(exp, "accept-ranges") {
		t.Fatalf("GET must expose length/range headers to JS, got %q", resp.Header.Get("Access-Control-Expose-Headers"))
	}
}

func TestBlobHandlerRoundTripAndAuth(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	h := newBlobHandler(ds, "nodesecret", nil, nil, nil, nil)
	srv := httptest.NewServer(h)
	defer srv.Close()

	put := func(auth string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/blob/abc123", bytes.NewReader([]byte("cipher")))
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := put(""); code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", code)
	}
	if code := put("Bearer wrong"); code != http.StatusUnauthorized {
		t.Fatalf("wrong auth: %d", code)
	}
	if code := put("Bearer nodesecret"); code != http.StatusOK {
		t.Fatalf("good auth put: %d", code)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	req.Header.Set("Authorization", "Bearer nodesecret")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "cipher" {
		t.Fatalf("get: %d %q", resp.StatusCode, body)
	}

	// Path-traversal / invalid key rejected (DiskStore.validKey).
	bad, _ := http.NewRequest("GET", srv.URL+"/blob/..%2f..%2fetc", nil)
	bad.Header.Set("Authorization", "Bearer nodesecret")
	br, _ := http.DefaultClient.Do(bad)
	br.Body.Close()
	if br.StatusCode == 200 {
		t.Fatalf("traversal key must not 200")
	}

	// DELETE is idempotent.
	del, _ := http.NewRequest("DELETE", srv.URL+"/blob/abc123", nil)
	del.Header.Set("Authorization", "Bearer nodesecret")
	dr, _ := http.DefaultClient.Do(del)
	dr.Body.Close()
	if dr.StatusCode != 204 {
		t.Fatalf("delete: %d", dr.StatusCode)
	}
	gone, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	gone.Header.Set("Authorization", "Bearer nodesecret")
	gr, _ := http.DefaultClient.Do(gone)
	gr.Body.Close()
	if gr.StatusCode != 404 {
		t.Fatalf("get after delete: %d", gr.StatusCode)
	}
}

// TestBlobHandlerAppend verifies the node's PATCH /blob append (X-Blob-Offset)
// used by resumable uploads, including the offset-mismatch 409.
func TestBlobHandlerAppend(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newBlobHandler(ds, "s", nil, nil, nil, nil))
	defer srv.Close()

	patch := func(offset int64, data string) (int, string) {
		req, _ := http.NewRequest("PATCH", srv.URL+"/blob/uploadkey", bytes.NewReader([]byte(data)))
		req.Header.Set("Authorization", "Bearer s")
		req.Header.Set("X-Blob-Offset", itoa64(offset))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}

	if code, body := patch(0, "chunk1"); code != 200 || !strings.Contains(body, `"size":6`) {
		t.Fatalf("append#1: %d %s", code, body)
	}
	if code, body := patch(6, "chunk2"); code != 200 || !strings.Contains(body, `"size":12`) {
		t.Fatalf("append#2: %d %s", code, body)
	}
	// Stale offset → 409 with the real size.
	if code, body := patch(6, "dup"); code != http.StatusConflict || !strings.Contains(body, `"size":12`) {
		t.Fatalf("stale offset: %d %s", code, body)
	}

	// The assembled blob reads back whole.
	req, _ := http.NewRequest("GET", srv.URL+"/blob/uploadkey", nil)
	req.Header.Set("Authorization", "Bearer s")
	resp, _ := http.DefaultClient.Do(req)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "chunk1chunk2" {
		t.Fatalf("assembled = %q", got)
	}
}

func itoa64(n int64) string {
	return itoa(int(n))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// TestBlobHandlerRange verifies the node serves HTTP Range (206) so central can
// resume an interrupted download.
func TestBlobHandlerRange(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := newBlobHandler(ds, "s", nil, nil, nil, nil)
	srv := httptest.NewServer(h)
	defer srv.Close()

	putReq, _ := http.NewRequest("PUT", srv.URL+"/blob/blobkey", bytes.NewReader([]byte("0123456789")))
	putReq.Header.Set("Authorization", "Bearer s")
	pr, _ := http.DefaultClient.Do(putReq)
	pr.Body.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/blob/blobkey", nil)
	req.Header.Set("Authorization", "Bearer s")
	req.Header.Set("Range", "bytes=4-")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", resp.StatusCode)
	}
	if string(body) != "456789" {
		t.Fatalf("range body = %q, want %q", body, "456789")
	}
	if ar := resp.Header.Get("Accept-Ranges"); ar != "bytes" {
		t.Fatalf("Accept-Ranges = %q, want bytes", ar)
	}
}

// TestDLTokenIsSingleUse: central pre-meters the file size when it signs the
// 302, so a token that can be replayed for its whole lifetime turns ONE metered
// request into unbounded unmetered egress from the node. A token must buy
// exactly one fetch; a freshly signed one for the same blob still works, because
// that is what every real retry does (both clients re-enter central).
func TestDLTokenIsSingleUse(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	if _, err := ds.Put(t.Context(), "sk", bytes.NewReader([]byte("cipher"))); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newDownloadHandler(ds, secret, newReplayGuard(), nil))
	defer srv.Close()

	get := func(tok string) int {
		resp, err := http.Get(srv.URL + "/dl/sk?t=" + tok)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}

	exp := time.Now().Unix() + 60
	tok := dltoken.Sign(secret, "sk", exp, "once")
	if code := get(tok); code != 200 {
		t.Fatalf("first use = %d, want 200", code)
	}
	if code := get(tok); code != http.StatusForbidden {
		t.Fatalf("replayed token = %d, want 403", code)
	}
	// A retry gets a brand-new token from central — that must still work.
	if code := get(dltoken.Sign(secret, "sk", exp, "twice")); code != 200 {
		t.Fatalf("fresh token = %d, want 200", code)
	}
}

// TestDLGuardIsSharedAcrossListeners: /dl is served on BOTH the blob listener and
// the public download listener. A token spent on one must be dead on the other —
// otherwise single-use just means twice.
func TestDLGuardIsSharedAcrossListeners(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	const secret = "nodesecret"
	if _, err := ds.Put(t.Context(), "gk", bytes.NewReader([]byte("cipher"))); err != nil {
		t.Fatal(err)
	}
	guard := newReplayGuard()
	blobSrv := httptest.NewServer(newBlobHandler(ds, secret, nil, nil, nil, guard))
	defer blobSrv.Close()
	dlSrv := httptest.NewServer(newDownloadHandler(ds, secret, guard, nil))
	defer dlSrv.Close()

	tok := dltoken.Sign(secret, "gk", time.Now().Unix()+60, "shared")
	resp, err := http.Get(blobSrv.URL + "/dl/gk?t=" + tok)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("first use = %d, want 200", resp.StatusCode)
	}
	resp2, err := http.Get(dlSrv.URL + "/dl/gk?t=" + tok)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Fatalf("same token on the other listener = %d, want 403", resp2.StatusCode)
	}
}
