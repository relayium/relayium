package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// newFileServer builds a magic-link-capable account server with a disk blob store.
func newFileServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		// DailyQuota is well above minBillableBytes (64 KiB, see files.go) so
		// ordinary small test uploads aren't rejected by the M3a billing floor;
		// tests that specifically exercise quota exhaustion build their own
		// tight-quota server via newFileServerWithQuota instead.
		MaxFileSize: 1024, DailyQuota: 8 << 20, DefaultTTL: 3600, MaxTTL: 7200,
		// DefaultRetention=ttl keeps a plain upload (no burn/ttl/maxDownloads
		// params) unlimited-until-TTL, matching this suite's pre-existing
		// assumption; tests that want burn/count behavior request it explicitly.
		DefaultRetention: retentionTTL,
		// AccountGraceDays: self-deletion tests (deletion_test.go) need a
		// nonzero grace window so purge_after lands strictly after deleted_at;
		// harmless to every other test in this suite, which doesn't touch it.
		AccountGraceDays: 30,
	})
	// Tests route blobs to loopback fakeNode servers; relax the SSRF dial guard.
	svc.nodeHTTP.Transport.(*http.Transport).DialContext = guardedDialContext(true)
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	svc.SetBlobStore(disk)
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store, mail
}

// loginCookie logs a user in via magic link and returns the session cookie.
func loginCookie(t *testing.T, ts *httptest.Server, mail *capturingMailer, email string) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", map[string][]string{"email": {email}})
	i := strings.Index(mail.lastLink, "token=")
	// POST 才消费令牌（GET 只重定向，见 M5），所以登录必须走 POST。
	verify, _ := client.Post(ts.URL+"/api/auth/magic/verify", "application/json",
		strings.NewReader(`{"token":"`+mail.lastLink[i+len("token="):]+`"}`))
	for _, c := range verify.Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("no session cookie")
	return nil
}

// uploadBody frames an opaque manifest + blob stream per the wire format.
func uploadBody(manifest, blob []byte) *bytes.Buffer {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(manifest)))
	buf.Write(manifest)
	buf.Write(blob)
	return &buf
}

func postUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie, query string, body *bytes.Buffer) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+"/api/files"+query, body)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func decodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestUploadSuccess(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "up@example.com")
	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("manifestCT"), []byte("ciphertextblob")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var out struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	decodeJSON(t, resp, &out)
	if out.ID == "" || out.ExpiresAt == 0 {
		t.Fatalf("bad response %+v", out)
	}
	sf, err := store.GetStoredFile(context.Background(), out.ID)
	if err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
	if !sf.BurnAfterRead || sf.Size != int64(len("ciphertextblob")) || string(sf.EncManifest) != "manifestCT" {
		t.Fatalf("stored row wrong: %+v", sf)
	}
	// ttl=0 → DefaultTTL (3600); created at now → expiresAt ≈ now+3600.
	if out.ExpiresAt != sf.ExpiresAt {
		t.Fatalf("expiresAt mismatch")
	}
}

func TestUploadOversizeIs413(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "big@example.com")
	big := bytes.Repeat([]byte("x"), 2048) // > MaxFileSize 1024
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), big))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: want 413, got %d", resp.StatusCode)
	}
}

func TestUploadOverQuotaIs429(t *testing.T) {
	// Own tight-quota server: newFileServer's default is now well above
	// minBillableBytes (see its comment), so quota-exhaustion tests build a
	// small quota locally via newFileServerWithQuota instead.
	ts, _, store, mail := newFileServerWithQuota(t, 4096, 1024)
	cookie := loginCookie(t, ts, mail, "quota@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "quota@example.com", "")
	// Pre-fill the rolling window to within 100 bytes of the 4096 quota.
	_ = store.RecordUpload(context.Background(), UploadEvent{ID: newID(), UserID: u.ID, Bytes: 4000, UploadedAt: time.Now().Unix()})
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("y"), 500)))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over quota: want 429, got %d", resp.StatusCode)
	}
}

func TestUploadUnauthIs401(t *testing.T) {
	ts, _, _, _ := newFileServer(t)
	resp := postUpload(t, ts, nil, "?ttl=0", uploadBody([]byte("m"), []byte("c")))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth: want 401, got %d", resp.StatusCode)
	}
}

func TestFileMetaOKAnd404(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "m@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("MANIFEST"), []byte("blobby")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	// Public meta — no cookie needed.
	mresp, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/meta")
	if mresp.StatusCode != http.StatusOK {
		t.Fatalf("meta: %d", mresp.StatusCode)
	}
	var meta struct {
		EncManifest   string `json:"encManifest"`
		Size          int64  `json:"size"`
		BurnAfterRead bool   `json:"burnAfterRead"`
		ExpiresAt     int64  `json:"expiresAt"`
	}
	decodeJSON(t, mresp, &meta)
	if meta.Size != int64(len("blobby")) {
		t.Fatalf("meta size = %d", meta.Size)
	}
	dec, _ := base64.StdEncoding.DecodeString(meta.EncManifest)
	if string(dec) != "MANIFEST" {
		t.Fatalf("encManifest decode = %q", dec)
	}
	// Missing id → 404.
	r404, _ := ts.Client().Get(ts.URL + "/api/files/deadbeef/meta")
	if r404.StatusCode != http.StatusNotFound {
		t.Fatalf("missing meta: want 404, got %d", r404.StatusCode)
	}
}

func TestBlobStreamsAndBurnDeletes(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "b@example.com")
	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("m"), []byte("CIPHERTEXT")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	bresp, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if bresp.StatusCode != http.StatusOK {
		t.Fatalf("blob: %d", bresp.StatusCode)
	}
	body, _ := io.ReadAll(bresp.Body)
	if string(body) != "CIPHERTEXT" {
		t.Fatalf("blob body = %q", body)
	}
	// Burn-after-read: the row is gone and a second fetch 404s.
	if _, err := store.GetStoredFile(context.Background(), up.ID); err != ErrNotFound {
		t.Fatalf("burned file should be deleted, got err=%v", err)
	}
	again, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if again.StatusCode != http.StatusNotFound {
		t.Fatalf("second blob fetch: want 404, got %d", again.StatusCode)
	}
}

// TestBlobRangeResumeUnlimited: an unlimited file honours a Range request with
// 206 + the correct tail + Content-Range + Accept-Ranges, backing resume.
func TestBlobRangeResumeUnlimited(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "r@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("0123456789")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	req, _ := http.NewRequest("GET", ts.URL+"/api/files/"+up.ID+"/blob", nil)
	req.Header.Set("Range", "bytes=4-")
	br, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(br.Body)
	br.Body.Close()
	if br.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", br.StatusCode)
	}
	if string(body) != "456789" {
		t.Fatalf("range body = %q, want %q", body, "456789")
	}
	if cr := br.Header.Get("Content-Range"); cr != "bytes 4-9/10" {
		t.Fatalf("Content-Range = %q", cr)
	}
	if ar := br.Header.Get("Accept-Ranges"); ar != "bytes" {
		t.Fatalf("Accept-Ranges = %q", ar)
	}
}

// TestBlobRangeMetersServedBytes: a Range continuation (start>0) must still meter
// the bytes it egresses and count the completed delivery — otherwise a client
// could pull a whole unlimited file via `Range: bytes=N-` with zero metering and
// zero download_count, an unmetered egress amplifier. The meter is the SERVED
// count (6 of 10 here), not the full size.
func TestBlobRangeMetersServedBytes(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "rm@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("0123456789")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	req, _ := http.NewRequest("GET", ts.URL+"/api/files/"+up.ID+"/blob", nil)
	req.Header.Set("Range", "bytes=4-")
	br, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(br.Body)
	br.Body.Close()
	if br.StatusCode != http.StatusPartialContent || string(body) != "456789" {
		t.Fatalf("range download: status=%d body=%q", br.StatusCode, body)
	}

	var st statsResp
	if r := getJSON(t, ts, cookie, "/api/stats", &st); r.StatusCode != http.StatusOK {
		t.Fatalf("stats: %d", r.StatusCode)
	}
	if st.Downloads != 1 || st.DownloadBytes != 6 {
		t.Fatalf("range download must be metered: downloads=%d bytes=%d, want 1/6", st.Downloads, st.DownloadBytes)
	}
	var list struct {
		Files []map[string]any `json:"files"`
	}
	getJSON(t, ts, cookie, "/api/files", &list)
	if dc, _ := list.Files[0]["downloadCount"].(float64); dc != 1 {
		t.Fatalf("downloadCount = %v, want 1", list.Files[0]["downloadCount"])
	}
}

// TestBlobRangeIgnoredForLimited: a max-downloads file ignores Range (serves the
// whole blob, 200) and still consumes its single slot — so resume can't be used
// to bypass the download cap.
func TestBlobRangeIgnoredForLimited(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "l@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0&maxDownloads=1", uploadBody([]byte("m"), []byte("0123456789")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	req, _ := http.NewRequest("GET", ts.URL+"/api/files/"+up.ID+"/blob", nil)
	req.Header.Set("Range", "bytes=4-")
	br, _ := ts.Client().Do(req)
	body, _ := io.ReadAll(br.Body)
	br.Body.Close()
	if br.StatusCode != http.StatusOK {
		t.Fatalf("limited status = %d, want 200 (Range ignored)", br.StatusCode)
	}
	if string(body) != "0123456789" {
		t.Fatalf("limited body = %q, want the whole object", body)
	}
	if _, err := store.GetStoredFile(context.Background(), up.ID); err != ErrNotFound {
		t.Fatalf("maxDownloads=1 should be spent by the full delivery, got %v", err)
	}
}

func TestListOwnFilesNoPlaintextNames(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "l@example.com")
	_ = postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("c1")))
	req, _ := http.NewRequest("GET", ts.URL+"/api/files", nil)
	req.AddCookie(cookie)
	resp, _ := ts.Client().Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list: %d", resp.StatusCode)
	}
	var out struct {
		Files []map[string]any `json:"files"`
	}
	decodeJSON(t, resp, &out)
	if len(out.Files) != 1 {
		t.Fatalf("want 1 file, got %d", len(out.Files))
	}
	if _, hasName := out.Files[0]["name"]; hasName {
		t.Fatalf("list must not expose plaintext names")
	}
}

func TestDeleteFileOwnerGate(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	owner := loginCookie(t, ts, mail, "owner@example.com")
	resp := postUpload(t, ts, owner, "?ttl=0", uploadBody([]byte("m"), []byte("c")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	// A different user cannot see/delete it → 404 (no existence leak).
	other := loginCookie(t, ts, mail, "other@example.com")
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/files/"+up.ID, nil)
	req.AddCookie(other)
	r, _ := ts.Client().Do(req)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("non-owner delete: want 404, got %d", r.StatusCode)
	}
	// Owner deletes → 200, then meta 404.
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/files/"+up.ID, nil)
	req.AddCookie(owner)
	r, _ = ts.Client().Do(req)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("owner delete: %d", r.StatusCode)
	}
	m, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/meta")
	if m.StatusCode != http.StatusNotFound {
		t.Fatalf("meta after delete: want 404, got %d", m.StatusCode)
	}
}

// TestBurnBlobConcurrentSingleDelivery proves the burn-after-read TOCTOU fix at
// the HTTP layer: many concurrent GETs of the same burn file yield exactly one
// 200 with the full plaintext; every other request 404s. Before the fix, several
// requests could each stream the complete ciphertext.
// A burn claim released after a failed mid-stream delivery must let the owner
// re-download, while a wrong-timestamp release must never clobber a live claim.
func TestReleaseBurnDownloadAllowsRetry(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "burnrelease@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "b1", UserID: u.ID, BlobKey: "bk", EncManifest: []byte("m"),
		Size: 5, BurnAfterRead: true, CreatedAt: 1, ExpiresAt: 1 << 40,
	}); err != nil {
		t.Fatal(err)
	}

	if claimed, err := store.ClaimBurnDownload(ctx, "b1", 100); err != nil || !claimed {
		t.Fatalf("first claim: claimed=%v err=%v", claimed, err)
	}
	if again, _ := store.ClaimBurnDownload(ctx, "b1", 200); again {
		t.Fatal("second concurrent claim succeeded; want blocked")
	}
	// Wrong-timestamp release is a no-op: the claim stays held.
	if err := store.ReleaseBurnDownload(ctx, "b1", 999); err != nil {
		t.Fatal(err)
	}
	if again, _ := store.ClaimBurnDownload(ctx, "b1", 300); again {
		t.Fatal("claim succeeded after wrong-timestamp release; want still held")
	}
	// Releasing our own claim restores availability.
	if err := store.ReleaseBurnDownload(ctx, "b1", 100); err != nil {
		t.Fatal(err)
	}
	if again, err := store.ClaimBurnDownload(ctx, "b1", 400); err != nil || !again {
		t.Fatalf("re-claim after release: claimed=%v err=%v", again, err)
	}
}

func TestBurnBlobConcurrentSingleDelivery(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "burnrace@example.com")
	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("m"), []byte("CIPHERTEXT")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	const n = 24
	var full, notFound int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r, err := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
			if err != nil {
				t.Errorf("get: %v", err)
				return
			}
			defer r.Body.Close()
			body, _ := io.ReadAll(r.Body)
			switch {
			case r.StatusCode == http.StatusOK && string(body) == "CIPHERTEXT":
				atomic.AddInt64(&full, 1)
			case r.StatusCode == http.StatusNotFound:
				atomic.AddInt64(&notFound, 1)
			default:
				t.Errorf("unexpected status=%d body=%q", r.StatusCode, body)
			}
		}()
	}
	close(start)
	wg.Wait()

	if full != 1 {
		t.Fatalf("full plaintext deliveries = %d, want exactly 1", full)
	}
	if notFound != n-1 {
		t.Fatalf("404s = %d, want %d", notFound, n-1)
	}
	// Row is gone after the single successful burn download.
	if _, err := store.GetStoredFile(context.Background(), up.ID); err != ErrNotFound {
		t.Fatalf("burned file should be deleted, got err=%v", err)
	}
}

// TestConcurrentUploadsRespectQuota proves the quota TOCTOU fix: firing many
// uploads at once, whose combined size far exceeds the daily quota, never lets
// the recorded total exceed the quota. Pre-fix, each request read a stale usage
// sum and they collectively busted the cap.
func TestConcurrentUploadsRespectQuota(t *testing.T) {
	const (
		n     = 16
		each  = 1000                 // actual ciphertext bytes; each < minBillableBytes (64 KiB)
		quota = 4 * minBillableBytes // exactly 4 billed (floored) slots
	)
	// Every upload here is billed at the 64 KiB floor (M3a), not its actual 1000
	// bytes, so the quota is sized in floored slots via newFileServerWithQuota
	// rather than the shared newFileServer's byte-scale default.
	ts, _, store, mail := newFileServerWithQuota(t, quota, 1024)
	cookie := loginCookie(t, ts, mail, "qrace@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "qrace@example.com", "")

	var accepted int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("z"), each)))
			defer resp.Body.Close()
			switch resp.StatusCode {
			case http.StatusOK:
				atomic.AddInt64(&accepted, 1)
			case http.StatusTooManyRequests:
			default:
				t.Errorf("unexpected upload status %d", resp.StatusCode)
			}
		}()
	}
	close(start)
	wg.Wait()

	total, _ := store.UserUploadedSince(context.Background(), u.ID, 0)
	if total > quota {
		t.Fatalf("recorded upload total %d exceeds quota %d", total, quota)
	}
	if accepted*minBillableBytes != total {
		t.Fatalf("accepted*minBillableBytes=%d != recorded total=%d", accepted*minBillableBytes, total)
	}
	if accepted != 4 {
		t.Fatalf("accepted uploads = %d, want 4 (4*64KiB fits quota, 5th doesn't)", accepted)
	}
}

// getJSON does an authenticated GET and decodes the JSON body.
func getJSON(t *testing.T, ts *httptest.Server, cookie *http.Cookie, path string, v any) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+path, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("get %s: %v", path, err)
	}
	if v != nil {
		decodeJSON(t, resp, v)
	}
	return resp
}

type statsResp struct {
	Transfers     int64 `json:"transfers"`
	Downloads     int64 `json:"downloads"`
	UploadBytes   int64 `json:"uploadBytes"`
	DownloadBytes int64 `json:"downloadBytes"`
	RelayBytes    int64 `json:"relayBytes"`
}

// TestDownloadCountAndStats: a non-burn file downloaded twice reports
// downloadCount=2 in the list, and /api/stats aggregates 1 upload + 2 downloads
// with matching byte totals. Downloads are recorded per fetch (no dedup).
func TestDownloadCountAndStats(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "dc@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("HELLO")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	for i := 0; i < 2; i++ {
		br, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
		body, _ := io.ReadAll(br.Body)
		br.Body.Close()
		if br.StatusCode != http.StatusOK || string(body) != "HELLO" {
			t.Fatalf("download %d: status=%d body=%q", i, br.StatusCode, body)
		}
	}

	var list struct {
		Files []map[string]any `json:"files"`
	}
	getJSON(t, ts, cookie, "/api/files", &list)
	if len(list.Files) != 1 {
		t.Fatalf("want 1 file, got %d", len(list.Files))
	}
	if dc, _ := list.Files[0]["downloadCount"].(float64); dc != 2 {
		t.Fatalf("downloadCount = %v, want 2", list.Files[0]["downloadCount"])
	}

	var st statsResp
	if r := getJSON(t, ts, cookie, "/api/stats", &st); r.StatusCode != http.StatusOK {
		t.Fatalf("stats: %d", r.StatusCode)
	}
	if st.Transfers != 1 || st.Downloads != 2 {
		t.Fatalf("stats counts = %+v, want transfers=1 downloads=2", st)
	}
	sz := int64(len("HELLO"))
	if st.UploadBytes != sz || st.DownloadBytes != 2*sz {
		t.Fatalf("stats bytes = %+v, want upload=%d download=%d", st, sz, 2*sz)
	}
}

// TestBurnDownloadCountsInStats: a burn-after-read download deletes its row, but
// the user's lifetime stats still record the one download + its bytes.
func TestBurnDownloadCountsInStats(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "burnstat@example.com")
	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("m"), []byte("XY")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	br, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	io.ReadAll(br.Body)
	br.Body.Close()

	var st statsResp
	getJSON(t, ts, cookie, "/api/stats", &st)
	if st.Downloads != 1 || st.DownloadBytes != int64(len("XY")) {
		t.Fatalf("burn stats = %+v, want downloads=1 downloadBytes=2", st)
	}
}
