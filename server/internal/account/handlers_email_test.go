package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleRegisterReturnsVerificationSentNoCookie(t *testing.T) {
	svc, m := newTestService(t)
	req := httptest.NewRequest("POST", "/api/auth/register",
		strings.NewReader(`{"email":"h@example.com","password":"supersecret","displayName":"H"}`))
	rec := httptest.NewRecorder()
	svc.handleRegister(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "verification_sent") {
		t.Fatalf("body=%s", rec.Body.String())
	}
	if strings.Contains(rec.Header().Get("Set-Cookie"), sessionCookie) {
		t.Fatal("register must not set a session cookie")
	}
	if m.verify == "" {
		t.Fatal("verify email not sent")
	}
}

func TestHandleLoginUnverifiedReturns403(t *testing.T) {
	svc, _ := newTestService(t)
	_, _ = svc.Register(context.Background(), "u@example.com", "supersecret", "")
	req := httptest.NewRequest("POST", "/api/auth/password/login",
		strings.NewReader(`{"email":"u@example.com","password":"supersecret"}`))
	rec := httptest.NewRecorder()
	svc.handlePasswordLogin(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "email_unverified") {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestHandleForgotAlwaysOK(t *testing.T) {
	svc, _ := newTestService(t)
	req := httptest.NewRequest("POST", "/api/auth/password/forgot",
		strings.NewReader(`{"email":"nobody@example.com"}`))
	rec := httptest.NewRecorder()
	svc.handleForgotPassword(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("forgot must be 200, got %d", rec.Code)
	}
}
