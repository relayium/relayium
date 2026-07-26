package account

import (
	"net/http"
	"testing"
)

func TestUserFromRequest(t *testing.T) {
	ts, svc, store, mail := newFileServer(t) // harness from files_test.go
	_ = store
	cookie := loginCookie(t, ts, mail, "who@example.com")

	// With a valid session cookie → resolves the user.
	req, _ := http.NewRequest("GET", "/api/pair", nil)
	req.AddCookie(cookie)
	u, ok := svc.UserFromRequest(req)
	if !ok || u.Email != "who@example.com" {
		t.Fatalf("UserFromRequest = (%+v,%v), want who@example.com,true", u, ok)
	}

	// No cookie → anonymous.
	req2, _ := http.NewRequest("GET", "/api/pair", nil)
	if _, ok := svc.UserFromRequest(req2); ok {
		t.Fatalf("UserFromRequest with no cookie should be false")
	}
}
