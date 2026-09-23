package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The HTTP answer to a mistyped password on the verify page is a 400 the page
// can act on, and the same link still verifies afterwards.
func TestVerifyEmailHandlerAnswersPasswordMismatchAndKeepsTheLink(t *testing.T) {
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	mux := http.NewServeMux()
	mux.Handle("/api/", svc.Routes())

	post := func(password string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"token": raw, "password": password})
		req := httptest.NewRequest(http.MethodPost, "/api/auth/email/verify", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	rec := post(vPassword + "x")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatch: status %d, want 400; body %q", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got["error"] != "password_mismatch" {
		t.Fatalf("mismatch: body %q, want {\"error\":\"password_mismatch\"}", rec.Body.String())
	}
	if s := readVerifyState(t, svc, u.ID, raw); s.Verified || !s.LinkUnspent {
		t.Fatalf("a mismatch must leave the account unverified and the link unspent: %+v", s)
	}

	rec = post(vPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("the same link must verify after a mismatch: status %d body %q", rec.Code, rec.Body.String())
	}
	if s := readVerifyState(t, svc, u.ID, raw); !s.Verified || !s.HasPassword {
		t.Fatalf("the confirmed password must be kept: %+v", s)
	}
}
