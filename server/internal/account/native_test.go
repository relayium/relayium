package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestNativeLoginIssuesUsableBearer proves the native login endpoint validates
// credentials and returns a bearer token that RequireAuth then accepts.
func TestNativeLoginIssuesUsableBearer(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	u, err := svc.Register(ctx, "app@example.com", "hunter2hunter", "App User")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := svc.store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/auth/native/login", strings.NewReader(body))
		rec := httptest.NewRecorder()
		svc.handleNativeLogin(rec, req)
		return rec
	}

	// Correct credentials → 200 + token + linkedMethods.
	rec := post(`{"email":"app@example.com","password":"hunter2hunter"}`)
	if rec.Code != 200 {
		t.Fatalf("login code = %d, body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Token string `json:"token"`
		User  struct {
			LinkedMethods []string `json:"linkedMethods"`
		} `json:"user"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(out.Token, "rlm_cli_") {
		t.Fatalf("token = %q", out.Token)
	}
	if len(out.User.LinkedMethods) != 1 || out.User.LinkedMethods[0] != "password" {
		t.Errorf("linkedMethods = %v, want [password]", out.User.LinkedMethods)
	}

	// The returned bearer must authenticate against RequireAuth.
	var gotUID string
	h := svc.RequireAuth(func(w http.ResponseWriter, r *http.Request, usr User) { gotUID = usr.ID; w.WriteHeader(200) })
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+out.Token)
	rec2 := httptest.NewRecorder()
	h(rec2, req)
	if rec2.Code != 200 || gotUID != u.ID {
		t.Fatalf("bearer not usable: code=%d uid=%q", rec2.Code, gotUID)
	}

	// Wrong password → 401.
	if rec := post(`{"email":"app@example.com","password":"nope-nope-1"}`); rec.Code != 401 {
		t.Fatalf("wrong password code = %d", rec.Code)
	}
}

// TestNativeLoginUnverifiedBlocked proves an unverified account can't get a
// bearer (mirrors the cookie login's email_unverified path).
func TestNativeLoginUnverifiedBlocked(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	if _, err := svc.Register(ctx, "unverified@example.com", "hunter2hunter", ""); err != nil {
		t.Fatalf("register: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/auth/native/login",
		strings.NewReader(`{"email":"unverified@example.com","password":"hunter2hunter"}`))
	rec := httptest.NewRecorder()
	svc.handleNativeLogin(rec, req)
	if rec.Code != 403 {
		t.Fatalf("unverified login code = %d, want 403", rec.Code)
	}
}

// TestUnlinkIdentityGuard proves you can unlink a provider while a password (or
// another identity) remains, but not the last remaining login method.
func TestUnlinkIdentityGuard(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	unlink := func(u User, provider string) int {
		req := httptest.NewRequest("DELETE", "/api/auth/identities/"+provider, nil)
		req.SetPathValue("provider", provider)
		rec := httptest.NewRecorder()
		svc.handleUnlinkIdentity(rec, req, u)
		return rec.Code
	}

	// User A: has a password AND a linked google → unlinking google is allowed.
	a, _ := svc.Register(ctx, "a@example.com", "hunter2hunter", "")
	_ = svc.store.SetEmailVerified(ctx, a.ID)
	if err := svc.store.LinkIdentity(ctx, "google", "goog-a", a.ID); err != nil {
		t.Fatalf("link: %v", err)
	}
	if code := unlink(a, "google"); code != 200 {
		t.Fatalf("unlink with password present: code = %d, want 200", code)
	}
	if provs, _ := svc.store.ListIdentityProviders(ctx, a.ID); containsStr(provs, "google") {
		t.Errorf("google still linked after unlink: %v", provs)
	}

	// User B: passwordless, only google linked → unlinking it is refused (409).
	b, err := svc.store.UpsertUserByEmail(ctx, "b@example.com", "")
	if err != nil {
		t.Fatalf("upsert b: %v", err)
	}
	if err := svc.store.LinkIdentity(ctx, "google", "goog-b", b.ID); err != nil {
		t.Fatalf("link b: %v", err)
	}
	if code := unlink(b, "google"); code != 409 {
		t.Fatalf("unlink last method: code = %d, want 409", code)
	}
	if provs, _ := svc.store.ListIdentityProviders(ctx, b.ID); len(provs) != 1 {
		t.Errorf("google should remain after refused unlink: %v", provs)
	}
}
