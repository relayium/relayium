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

// A receipt naming a real shared file, with a plausible partial byte count, is
// still settled as nothing: usage the owner genuinely accrued is untouched and
// the reply is the same 410 every other receipt gets. This is the shape the
// withdrawn protocol trusted most — and the shape that made an unissued credit
// indistinguishable from a real one.
func TestDownloadReceiptSettlesNothingForAKnownFile(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	owner, _ := s.store.UpsertUserByEmail(ctx, "recv@example.com", "")
	if err := s.store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	}); err != nil {
		t.Fatal(err)
	}
	now := s.now().Unix()
	period := periodOf(now)
	// 200 bytes central really proxied and really billed for.
	if err := s.store.RecordMeter(ctx, owner.ID, MeterDownload, 200, now); err != nil {
		t.Fatal(err)
	}

	for _, served := range []string{"120", "200", "999999", "-5"} {
		body := `{"blobKey":"bk","nonce":"n-` + served + `","servedBytes":` + served + `}`
		if code := postReceipt(t, s, "fleet-secret", body); code != http.StatusGone {
			t.Fatalf("receipt servedBytes=%s: got %d want 410", served, code)
		}
		if _, d, _ := s.store.MonthlyUsage(ctx, owner.ID, period); d != 200 {
			t.Fatalf("receipt servedBytes=%s moved download usage to %d, want the real 200", served, d)
		}
	}
}

// A receipt for a blob key central has no file for gets the same answer as one
// for a file it does know — the reply does not disclose whether the object
// exists.
func TestDownloadReceiptDoesNotDiscloseObjectExistence(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	owner, _ := s.store.UpsertUserByEmail(ctx, "recv2@example.com", "")
	s.store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	})

	known := postReceipt(t, s, "fleet-secret", `{"blobKey":"bk","nonce":"a","servedBytes":1}`)
	unknown := postReceipt(t, s, "fleet-secret", `{"blobKey":"no-such-key","nonce":"b","servedBytes":1}`)
	if known != http.StatusGone || unknown != http.StatusGone {
		t.Fatalf("known=%d unknown=%d, want both 410", known, unknown)
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
