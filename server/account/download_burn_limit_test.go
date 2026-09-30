package account

// A stored blob can be LONGER than the object's committed size (a late append
// after the terminal finalize leaves bytes past sf.Size). The download
// handlers must serve and meter exactly the committed bytes: before the bound,
// net/http refused the Write that crossed Content-Length, so the client got a
// truncated body, a burn-after-read file was never burned, and the metered
// byte count did not match what was committed.
//
// Every download here goes through a real HTTP server (httptest.NewServer),
// because the Content-Length enforcement being exercised lives in net/http's
// response writer; an httptest.ResponseRecorder accepts any length.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inbox"
)

// settledServer serves h and lets a test wait until every request it has
// started has fully returned — so post-body accounting (metering, burn,
// download count) is observed after it ran, not raced.
type settledServer struct {
	*httptest.Server
	inflight sync.WaitGroup
}

func newSettledServer(t *testing.T, h http.Handler) *settledServer {
	t.Helper()
	s := &settledServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.inflight.Add(1)
		defer s.inflight.Done()
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

// get performs one GET, reads the whole body (keeping any read error), and
// waits for the handler to return.
func (s *settledServer) get(t *testing.T, path string, hdr map[string]string) (int, []byte, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, s.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := s.Client().Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, rerr := io.ReadAll(resp.Body)
	resp.Body.Close()
	s.inflight.Wait()
	return resp.StatusCode, body, rerr
}

// patterned returns n bytes whose content identifies their offset, so a body
// that contains the wrong range is caught, not only a wrong length.
func patterned(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i/251)
	}
	return b
}

// seedBlobFile stores blob under a fresh key and records a stored file whose
// COMMITTED size is size — which may differ from len(blob) on purpose.
func seedBlobFile(t *testing.T, svc *Service, store *SQLiteStore, email string, blob []byte, size, maxDownloads int64) (StoredFile, User) {
	t.Helper()
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, email, "O")
	if err != nil {
		t.Fatal(err)
	}
	bs, err := svc.blobFor(ctx, "")
	if err != nil {
		t.Fatalf("blobFor: %v", err)
	}
	key := "burnlimit" + authx.NewID()
	if _, err := bs.Put(ctx, key, bytes.NewReader(blob)); err != nil {
		t.Fatalf("put blob: %v", err)
	}
	now := svc.now().Unix()
	sf := StoredFile{
		ID: authx.NewID(), UserID: u.ID, BlobKey: key, EncManifest: []byte("m"),
		Size: size, MaxDownloads: maxDownloads, CreatedAt: now, ExpiresAt: now + 3600,
	}
	if err := store.CreateStoredFile(ctx, sf); err != nil {
		t.Fatalf("create stored file: %v", err)
	}
	return sf, u
}

func blobPresent(t *testing.T, svc *Service, key string) bool {
	t.Helper()
	bs, err := svc.blobFor(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	rc, err := bs.GetRange(context.Background(), key, 0)
	if err != nil {
		return false
	}
	rc.Close()
	return true
}

func assertBurned(t *testing.T, svc *Service, store *SQLiteStore, sf StoredFile) {
	t.Helper()
	if _, err := store.GetStoredFile(context.Background(), sf.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("burn-after-read row still present after a complete download (err=%v)", err)
	}
	if blobPresent(t, svc, sf.BlobKey) {
		t.Fatal("burn-after-read blob still stored after a complete download")
	}
}

func assertMeteredAndStat(t *testing.T, store *SQLiteStore, userID string, at, want int64) {
	t.Helper()
	if got := downloadMeter(t, store, userID, at); got != want {
		t.Fatalf("download meter = %d bytes, want exactly %d", got, want)
	}
	st, err := store.GetUserStats(context.Background(), userID)
	if err != nil || st.DownloadBytes != want {
		t.Fatalf("download stat = (%d, %v), want %d", st.DownloadBytes, err, want)
	}
	if owed := owedRows(t, store); len(owed) != 0 {
		t.Fatalf("unexpected owed meter rows: %+v", owed)
	}
}

// The committed object is the prefix; the stored blob carries extra bytes.
// Both sizes are exercised: under 512 bytes the body goes out through one
// buffered Write, and above it net/http's ReadFrom path takes over for the
// remainder of a file-backed source.
func TestBurnLimitOverLongBlobBurnsAfterServingExactlyTheCommittedBytes(t *testing.T) {
	for _, tc := range []struct {
		name            string
		committed, blob int
	}{
		{"small", 300, 400},
		{"large", 64 << 10, 96 << 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, svc, store, _ := newFileServer(t)
			srv := newSettledServer(t, svc.Routes())
			blob := patterned(tc.blob)
			sf, owner := seedBlobFile(t, svc, store, "burnlimit-"+tc.name+"@example.test", blob, int64(tc.committed), 1)
			at := svc.now().Unix()

			status, body, rerr := srv.get(t, "/api/files/"+sf.ID+"/blob", nil)
			if status != http.StatusOK || rerr != nil {
				t.Fatalf("download = (%d, read err %v), want 200 and a clean body", status, rerr)
			}
			if !bytes.Equal(body, blob[:tc.committed]) {
				t.Fatalf("client received %d bytes, want exactly the %d committed bytes", len(body), tc.committed)
			}
			assertBurned(t, svc, store, sf)
			assertMeteredAndStat(t, store, owner.ID, at, int64(tc.committed))

			// A second fetch of the burned link finds nothing.
			if status, _, _ := srv.get(t, "/api/files/"+sf.ID+"/blob", nil); status != http.StatusNotFound {
				t.Fatalf("burned link re-fetch = %d, want 404", status)
			}
		})
	}
}

// Unlimited file, Range resume, over-long blob: the 206 body stops at the
// committed end, counts as a completed download, and meters only its range.
func TestBurnLimitOverLongBlobRangeResumeStopsAtTheCommittedEnd(t *testing.T) {
	_, svc, store, _ := newFileServer(t)
	srv := newSettledServer(t, svc.Routes())
	blob := patterned(1000)
	const committed, start = 700, 250
	sf, owner := seedBlobFile(t, svc, store, "burnlimit-range@example.test", blob, committed, 0)
	at := svc.now().Unix()

	status, body, rerr := srv.get(t, "/api/files/"+sf.ID+"/blob", map[string]string{"Range": "bytes=" + strconv.Itoa(start) + "-"})
	if status != http.StatusPartialContent || rerr != nil {
		t.Fatalf("resume = (%d, read err %v), want 206 and a clean body", status, rerr)
	}
	if !bytes.Equal(body, blob[start:committed]) {
		t.Fatalf("resume body = %d bytes, want the %d bytes up to the committed end", len(body), committed-start)
	}
	got, err := store.GetStoredFile(context.Background(), sf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.DownloadCount != 1 {
		t.Fatalf("download count = %d, want 1 (the resume completed the object)", got.DownloadCount)
	}
	assertMeteredAndStat(t, store, owner.ID, at, committed-start)
}

// Positive control, unchanged semantics: a blob SHORTER than its committed
// size is not a complete delivery. The bytes that did leave are metered and
// spend the burn slot, but the file is not burned.
func TestBurnLimitShortBlobStaysIncompleteAsBefore(t *testing.T) {
	_, svc, store, _ := newFileServer(t)
	srv := newSettledServer(t, svc.Routes())
	blob := patterned(300)
	sf, owner := seedBlobFile(t, svc, store, "burnlimit-short@example.test", blob, 400, 1)
	at := svc.now().Unix()

	_, body, rerr := srv.get(t, "/api/files/"+sf.ID+"/blob", nil)
	if rerr == nil {
		t.Fatal("client read a short body without error; Content-Length promised the committed size")
	}
	if !bytes.Equal(body, blob) {
		t.Fatalf("client received %d bytes, want the %d stored bytes", len(body), len(blob))
	}
	if _, err := store.GetStoredFile(context.Background(), sf.ID); err != nil {
		t.Fatalf("an incomplete delivery removed the row: %v", err)
	}
	if !blobPresent(t, svc, sf.BlobKey) {
		t.Fatal("an incomplete delivery deleted the blob")
	}
	if _, claimed, err := store.ClaimDownloadSlot(context.Background(), sf.ID, svc.now().Unix()); err != nil || claimed {
		t.Fatalf("slot after a partial delivery = (claimed %v, %v), want spent", claimed, err)
	}
	assertMeteredAndStat(t, store, owner.ID, at, int64(len(blob)))
}

// Positive control, unchanged semantics: a client that aborts mid-body on an
// over-long blob spends the slot, is metered for what it got, and does not burn.
func TestBurnLimitClientAbortOnOverLongBlobStaysIncompleteAsBefore(t *testing.T) {
	_, svc, store, _ := newFileServer(t)
	sf, owner := seedBlobFile(t, svc, store, "burnlimit-abort@example.test", patterned(400), 300, 1)
	at := svc.now().Unix()

	req := httptest.NewRequest(http.MethodGet, "/api/files/"+sf.ID+"/blob", nil)
	req.SetPathValue("id", sf.ID)
	tw := &truncWriter{limit: 10}
	svc.handleFileBlob(tw, req)
	if tw.got != 10 {
		t.Fatalf("test setup: delivered %d bytes, want 10", tw.got)
	}
	if _, err := store.GetStoredFile(context.Background(), sf.ID); err != nil {
		t.Fatalf("an aborted delivery removed the row: %v", err)
	}
	if !blobPresent(t, svc, sf.BlobKey) {
		t.Fatal("an aborted delivery deleted the blob")
	}
	if _, claimed, err := store.ClaimDownloadSlot(context.Background(), sf.ID, svc.now().Unix()); err != nil || claimed {
		t.Fatalf("slot after an aborted delivery = (claimed %v, %v), want spent", claimed, err)
	}
	assertMeteredAndStat(t, store, owner.ID, at, 10)
}

// Device Inbox task download: an over-long task blob serves and meters
// exactly the committed bytes, for a whole read and for a resume.
func TestBurnLimitInboxTaskOverLongBlobServesAndMetersTheCommittedBytes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload int
		start   int
	}{
		{"whole-small", 333, 0},
		{"whole-large", 64 << 10, 0},
		{"resume", 333, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTaskObjectHarness(t)
			srv := newSettledServer(t, h.svc.Routes())
			uid := h.user(t, "burnlimit-inbox-"+tc.name+"@example.test")
			tg := h.enrolTarget(t, uid, "server", inbox.AutoAcceptAuto, true)
			long := patterned(tc.payload + 4096)
			payload := long[:tc.payload]
			fileID, task := h.bindTask(t, tg, "burnlimit-send", payload)
			// Lengthen the stored object past its committed size.
			if _, err := h.blobs.Put(context.Background(), h.blobKey(t, fileID), bytes.NewReader(long)); err != nil {
				t.Fatalf("lengthen blob: %v", err)
			}
			_, claim := h.claimOne(t, tg)
			at := h.svc.now().Unix()
			before := downloadMeter(t, h.store, uid, at)
			stBefore, err := h.store.GetUserStats(context.Background(), uid)
			if err != nil {
				t.Fatal(err)
			}

			hdr := map[string]string{"Authorization": "Bearer " + tg.token, "X-Relayium-Inbox-Claim": claim}
			wantStatus := http.StatusOK
			if tc.start > 0 {
				hdr["Range"] = "bytes=" + strconv.Itoa(tc.start) + "-"
				wantStatus = http.StatusPartialContent
			}
			status, body, rerr := srv.get(t, "/api/devices/"+tg.deviceID+"/inbox/tasks/"+task["ID"].(string)+"/blob", hdr)
			if status != wantStatus || rerr != nil {
				t.Fatalf("task blob read = (%d, read err %v), want %d and a clean body", status, rerr, wantStatus)
			}
			if !bytes.Equal(body, payload[tc.start:]) {
				t.Fatalf("streamed %d bytes, want exactly the %d committed bytes", len(body), tc.payload-tc.start)
			}
			want := int64(tc.payload - tc.start)
			if got := downloadMeter(t, h.store, uid, at) - before; got != want {
				t.Fatalf("download meter moved by %d bytes, want exactly %d", got, want)
			}
			st, err := h.store.GetUserStats(context.Background(), uid)
			if err != nil || st.DownloadBytes-stBefore.DownloadBytes != want {
				t.Fatalf("download stat moved by %d (%v), want %d", st.DownloadBytes-stBefore.DownloadBytes, err, want)
			}
		})
	}
}
