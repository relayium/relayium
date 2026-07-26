package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relayium/relayium/authx"
)

// TestRequireAuthBearer proves RequireAuth accepts a valid CLI bearer token
// (Task 5's cli_tokens, looked up via hashToken/GetCLITokenUser) and rejects
// an unknown/bad one with 401 — the cookie path is covered separately by the
// existing /api/files cookie-based tests, which continue to exercise
// RequireAuth once files.go is switched over.
func TestRequireAuthBearer(t *testing.T) {
	s, _ := newTestService(t)
	ctx := context.Background()
	u, err := s.store.UpsertUserByEmail(ctx, "bearer@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	raw := "rlm_cli_" + authx.RandToken()
	dev, err := s.store.UpsertDevice(ctx, Device{ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := s.store.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}

	var gotUser string
	h := s.RequireAuth(func(w http.ResponseWriter, r *http.Request, usr User) { gotUser = usr.ID; w.WriteHeader(200) })

	// bearer accepted
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != 200 || gotUser != u.ID {
		t.Fatalf("bearer: code=%d user=%q", rec.Code, gotUser)
	}
	// bad bearer rejected
	req2 := httptest.NewRequest("GET", "/x", nil)
	req2.Header.Set("Authorization", "Bearer rlm_cli_nope")
	rec2 := httptest.NewRecorder()
	h(rec2, req2)
	if rec2.Code != 401 {
		t.Fatalf("bad bearer should 401, got %d", rec2.Code)
	}
	// no credentials at all rejected
	req3 := httptest.NewRequest("GET", "/x", nil)
	rec3 := httptest.NewRecorder()
	h(rec3, req3)
	if rec3.Code != 401 {
		t.Fatalf("no credentials should 401, got %d", rec3.Code)
	}

	// A frozen/pending-delete account must not keep bearer access, mirroring the
	// cookie path's central guard — even while its cli_tokens row still exists.
	if err := s.store.SetAccountDeletion(ctx, u.ID, s.now().Unix(), s.now().Unix()+100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	req4 := httptest.NewRequest("GET", "/x", nil)
	req4.Header.Set("Authorization", "Bearer "+raw)
	rec4 := httptest.NewRecorder()
	h(rec4, req4)
	if rec4.Code != 401 {
		t.Fatalf("frozen account bearer should 401, got %d", rec4.Code)
	}
}
