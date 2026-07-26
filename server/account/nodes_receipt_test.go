package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// postReceipt POSTs a direct-download receipt as a fleet node.
func postReceipt(t *testing.T, s *Service, bearer, body string) int {
	t.Helper()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	r := httptest.NewRequest("POST", "/api/nodes/download-receipt", bytes.NewReader([]byte(body)))
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w.Code
}

// A partial direct download (node served fewer bytes than the file size) refunds
// the owner the over-metered difference, exactly once.
func TestDownloadReceiptRefundsPartial(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	owner, _ := s.store.UpsertUserByEmail(ctx, "recv@example.com", "")
	if err := s.store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	}); err != nil {
		t.Fatal(err)
	}
	// Simulate the 302 pre-charge: full size metered to the owner.
	now := s.now().Unix()
	period := periodOf(now)
	if err := s.store.RecordMeter(ctx, owner.ID, MeterDownload, 200, now); err != nil {
		t.Fatal(err)
	}

	// Node reports it only served 120 bytes (client aborted).
	if code := postReceipt(t, s, "fleet-secret", `{"blobKey":"bk","nonce":"n1","servedBytes":120}`); code != http.StatusOK {
		t.Fatalf("receipt: got %d want 200", code)
	}
	if _, d, _ := s.store.MonthlyUsage(ctx, owner.ID, period); d != 120 {
		t.Fatalf("after receipt: download = %d, want 120 (200 pre-charge minus 80 refund)", d)
	}

	// A re-sent receipt for the same download must NOT refund again.
	if code := postReceipt(t, s, "fleet-secret", `{"blobKey":"bk","nonce":"n1","servedBytes":120}`); code != http.StatusOK {
		t.Fatalf("duplicate receipt: got %d want 200", code)
	}
	if _, d, _ := s.store.MonthlyUsage(ctx, owner.ID, period); d != 120 {
		t.Fatalf("duplicate receipt must not double-refund, download = %d want 120", d)
	}
}

// A complete download (served == size) refunds nothing — the pre-charge was exact.
func TestDownloadReceiptCompleteNoRefund(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	owner, _ := s.store.UpsertUserByEmail(ctx, "recv2@example.com", "")
	s.store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	})
	now := s.now().Unix()
	s.store.RecordMeter(ctx, owner.ID, MeterDownload, 200, now)

	if code := postReceipt(t, s, "fleet-secret", `{"blobKey":"bk","nonce":"n2","servedBytes":200}`); code != http.StatusOK {
		t.Fatalf("receipt: got %d want 200", code)
	}
	if _, d, _ := s.store.MonthlyUsage(ctx, owner.ID, periodOf(now)); d != 200 {
		t.Fatalf("complete download must not refund, download = %d want 200", d)
	}
}

// An over-reported servedBytes (> size) is clamped so it can never turn a refund
// into a charge (a buggy/hostile node must not be able to inflate usage).
func TestDownloadReceiptClampsOverReport(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	owner, _ := s.store.UpsertUserByEmail(ctx, "recv3@example.com", "")
	s.store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	})
	now := s.now().Unix()
	s.store.RecordMeter(ctx, owner.ID, MeterDownload, 200, now)

	postReceipt(t, s, "fleet-secret", `{"blobKey":"bk","nonce":"n3","servedBytes":999999}`)
	if _, d, _ := s.store.MonthlyUsage(ctx, owner.ID, periodOf(now)); d != 200 {
		t.Fatalf("over-reported servedBytes must clamp to size (no charge), download = %d want 200", d)
	}
}

// Unauthenticated receipts are rejected.
func TestDownloadReceiptRequiresAuth(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	if code := postReceipt(t, s, "", `{"blobKey":"bk","nonce":"n","servedBytes":1}`); code != http.StatusUnauthorized {
		t.Fatalf("no bearer: got %d want 401", code)
	}
	if code := postReceipt(t, s, "wrong", `{"blobKey":"bk","nonce":"n","servedBytes":1}`); code != http.StatusUnauthorized {
		t.Fatalf("bad bearer: got %d want 401", code)
	}
}

var _ = json.Marshal
