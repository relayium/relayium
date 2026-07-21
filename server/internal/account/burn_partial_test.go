package account

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// truncWriter is a ResponseWriter that accepts at most `limit` bytes total, then
// fails every Write — simulating a client that reads part of the body and RSTs.
type truncWriter struct {
	hdr    http.Header
	limit  int
	got    int
	status int
}

func (t *truncWriter) Header() http.Header {
	if t.hdr == nil {
		t.hdr = http.Header{}
	}
	return t.hdr
}
func (t *truncWriter) WriteHeader(code int) { t.status = code }
func (t *truncWriter) Write(p []byte) (int, error) {
	room := t.limit - t.got
	if room <= 0 {
		return 0, errors.New("connection reset by peer")
	}
	if len(p) > room {
		t.got += room
		return room, errors.New("connection reset by peer")
	}
	t.got += len(p)
	return len(p), nil
}

// seedLimitedFile creates a MaxDownloads=1 stored file with a real blob and
// returns its id.
func seedLimitedFile(t *testing.T, svc *Service, store *SQLiteStore, ownerEmail string) string {
	t.Helper()
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, ownerEmail, "O")
	bs, err := svc.blobFor(ctx, "")
	if err != nil {
		t.Fatalf("blobFor: %v", err)
	}
	const blobKey = "burnpartialkey"
	if _, err := bs.Put(ctx, blobKey, bytes.NewReader(bytes.Repeat([]byte("x"), 400))); err != nil {
		t.Fatalf("put blob: %v", err)
	}
	id := newID()
	now := svc.now().Unix()
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: []byte("m"),
		Size: 400, MaxDownloads: 1, CreatedAt: now, ExpiresAt: now + 3600,
	}); err != nil {
		t.Fatalf("create stored file: %v", err)
	}
	return id
}

// A partial download that delivered real bytes must SPEND the limited/burn slot:
// the slot is not refunded, so the file can't be pulled again. Regression for the
// bypass where any incomplete delivery released the claim, letting a link holder
// drain all-but-the-last frame and RST forever without ever advancing the count.
func TestBurnPartialDeliverySpendsTheSlot(t *testing.T) {
	_, svc, store, _ := newFileServer(t)
	id := seedLimitedFile(t, svc, store, "burn-partial@example.com")

	// Deliver only a prefix, then fail — simulating a read-most-then-RST client.
	req := httptest.NewRequest(http.MethodGet, "/api/files/"+id+"/blob", nil)
	req.SetPathValue("id", id)
	tw := &truncWriter{limit: 10}
	svc.handleFileBlob(tw, req)
	if tw.got == 0 {
		t.Fatal("test setup: expected some bytes to be delivered before the simulated RST")
	}

	// The single slot must be spent: a fresh claim now fails (file is burned),
	// and liveFile treats it as gone.
	_, claimed, err := store.ClaimDownloadSlot(context.Background(), id, svc.now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if claimed {
		t.Fatal("SECURITY: partial download refunded the slot — a burn file survived a near-complete read")
	}
}

// The narrow, safe refund is preserved: a connect-then-drop that delivered
// NOTHING (n == 0, no content leaked) does not cost the owner a download.
func TestBurnZeroDeliveryRefundsTheSlot(t *testing.T) {
	_, svc, store, _ := newFileServer(t)
	id := seedLimitedFile(t, svc, store, "burn-zero@example.com")

	req := httptest.NewRequest(http.MethodGet, "/api/files/"+id+"/blob", nil)
	req.SetPathValue("id", id)
	tw := &truncWriter{limit: 0} // fail on the very first write — zero bytes out
	svc.handleFileBlob(tw, req)
	if tw.got != 0 {
		t.Fatalf("test setup: expected zero bytes delivered, got %d", tw.got)
	}

	// Nothing leaked, so the slot is refunded and the file is still downloadable.
	slot, claimed, err := store.ClaimDownloadSlot(context.Background(), id, svc.now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if !claimed || slot != 1 {
		t.Fatalf("zero-byte delivery should refund the slot (claimed=%v slot=%d)", claimed, slot)
	}
}
