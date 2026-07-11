package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// newFileServerWithQuota mirrors newFileServer but lets the test pick a
// DailyQuota/MaxFileSize so the 64 KiB minBillableBytes floor lands on clean
// boundaries (newFileServer's fixed DailyQuota:4096 is too small to hold even
// one billed slot).
func newFileServerWithQuota(t *testing.T, dailyQuota, maxFileSize int64) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		MaxFileSize: maxFileSize, DailyQuota: dailyQuota, DefaultTTL: 3600, MaxTTL: 7200,
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

// TestMinBillableDebitsFloor: a 1-byte upload still costs 64 KiB of the
// rolling-24h quota ledger, even though the stored row and blob remain 1 byte.
func TestMinBillableDebitsFloor(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 130*1024, 1024*1024)
	cookie := loginCookie(t, ts, mail, "floor@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "floor@example.com", "")

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("x")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	used, err := store.UserUploadedSince(context.Background(), u.ID, 0)
	if err != nil {
		t.Fatalf("uploaded since: %v", err)
	}
	if used != 65536 {
		t.Fatalf("quota debit = %d, want 65536 (64 KiB floor)", used)
	}

	sf, err := store.GetStoredFile(context.Background(), up.ID)
	if err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
	if sf.Size != 1 {
		t.Fatalf("StoredFile.Size = %d, want actual 1", sf.Size)
	}
}

// TestMinBillableLargeUsesActual: an upload already at/above the 64 KiB floor
// debits its actual size, not the floor.
func TestMinBillableLargeUsesActual(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 1024*1024, 1024*1024)
	cookie := loginCookie(t, ts, mail, "large@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "large@example.com", "")

	blob := bytes.Repeat([]byte("y"), 100*1024) // 100 KiB, > 64 KiB floor
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), blob))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}

	used, err := store.UserUploadedSince(context.Background(), u.ID, 0)
	if err != nil {
		t.Fatalf("uploaded since: %v", err)
	}
	if used != 100*1024 {
		t.Fatalf("quota debit = %d, want actual 102400", used)
	}
}

// TestMinBillableCapsCount: with a 128 KiB quota (exactly two 64 KiB billed
// slots), two tiny uploads succeed and a third is rejected — proving the
// 64 KiB floor indirectly caps the number of stored objects per day.
func TestMinBillableCapsCount(t *testing.T) {
	ts, _, _, mail := newFileServerWithQuota(t, 128*1024, 1024*1024)
	cookie := loginCookie(t, ts, mail, "count@example.com")

	for i := 0; i < 2; i++ {
		resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("z")))
		if resp.StatusCode != 200 {
			t.Fatalf("upload %d: want 200, got %d", i, resp.StatusCode)
		}
	}
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("z")))
	if resp.StatusCode != 429 {
		t.Fatalf("third tiny upload: want 429, got %d", resp.StatusCode)
	}
}
