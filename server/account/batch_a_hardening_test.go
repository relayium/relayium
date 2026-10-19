package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The old incident response — rotate the admin password and restart — no
// longer exists, because there is no admin password. Its replacement is
// revoking at the terminal: revoking the passkey that opened a session ends
// that session, and revoke-all ends every session.
func TestAdminSessionRevokedWithItsPasskey(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	if !svc.validAdmin(ctx, tok) {
		t.Fatal("a freshly minted session must validate")
	}
	k := adminTestPasskey(t, svc)
	if _, err := store.AdminAuth().RevokeCredential(ctx, k.credID, true, svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	if svc.validAdmin(ctx, tok) {
		t.Fatal("revoking the passkey must invalidate the sessions it opened")
	}
}

// denyLimiter is a rateLimiter that refuses everything.
type denyLimiter struct{}

func (denyLimiter) Allow(string) bool { return false }

// An exhausted per-IP begin budget 429s the (unauthenticated) passkey login/begin
// before it can create a ceremony row, so a begin-flood can't fill the table.
func TestPasskeyLoginBeginRateLimited(t *testing.T) {
	ts, svc := newAdminServer(t, "admin", "pw")
	svc.SetPasskeyBeginLimiter(denyLimiter{})
	req, _ := http.NewRequest("POST", ts.URL+"/admin/passkey/login/begin", nil)
	req.Header.Set("Origin", svc.selfOrigin()) // pass the CSRF/origin guard
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("begin under an exhausted limiter: got %d, want 429", resp.StatusCode)
	}
}

// Once a node has reported a TLS fingerprint, a re-register that drops it (empty
// FP / non-https URL) must NOT downgrade the pinned channel to plaintext — the
// prior storage config is retained.
func TestNodeRegisterRefusesPinDowngrade(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	register := func(req nodeRegisterReq) nodeRegisterResp {
		t.Helper()
		body, _ := json.Marshal(req)
		r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer fleet-secret")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("register: %d %s", w.Code, w.Body)
		}
		var resp nodeRegisterResp
		json.Unmarshal(w.Body.Bytes(), &resp)
		return resp
	}

	// First registration pins a fingerprint over https.
	id := register(nodeRegisterReq{
		TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"storage"},
		StorageURL: "https://1.2.3.4:8081", StorageSecret: "ss", StorageFP: "abc123",
	}).NodeID

	// A re-register (same id) that drops the FP and downgrades to http must be
	// refused at the storage-config level — the pin is retained.
	register(nodeRegisterReq{
		NodeID: id, TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"storage"},
		StorageURL: "http://1.2.3.4:8081", StorageSecret: "ss", StorageFP: "",
	})
	got, ok, _ := s.store.GetNode(context.Background(), id)
	if !ok {
		t.Fatal("node vanished")
	}
	if got.StorageFP != "abc123" || got.StorageURL != "https://1.2.3.4:8081" {
		t.Fatalf("pin downgraded: fp=%q url=%q, want the prior pinned config", got.StorageFP, got.StorageURL)
	}
}
