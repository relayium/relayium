package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The iOS supported-version document's server end. The iOS decoder is run over
// these same bytes on the other side (`IOSVersionSupportTests` in RelayiumKit),
// so what is here is the half that can be checked without a Swift runtime.

func servedIOSPolicy(t *testing.T) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodGet, "/api/client-policy/ios", nil)
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("served document does not parse: %v", err)
	}
	return rec, body
}

// Inert: exactly the app's embedded floor. A minimum, a recommendation or an
// availability here would be a product decision (C02) and a claim about what
// a store can deliver, neither of which this change makes.
func TestIOSClientPolicyIsServedAndInert(t *testing.T) {
	rec, body := servedIOSPolicy(t)
	if body["schema"] != float64(1) {
		t.Fatalf("schema = %v", body["schema"])
	}
	ios, ok := body["ios"].(map[string]any)
	if !ok {
		t.Fatalf("no ios object: %v", body)
	}
	for field, want := range map[string]any{
		"policyRevision":          float64(1),
		"minimumSupportedVersion": "0.0.0",
		"recommendedVersion":      "0.0.0",
		"appStoreVersion":         "",
		"testFlightVersion":       "",
	} {
		if ios[field] != want {
			t.Errorf("%s = %v, want %v", field, ios[field], want)
		}
	}
	if len(ios) != 5 || len(body) != 2 {
		t.Errorf("unexpected fields: %v", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q", got)
	}
	// No URL of any kind: where an update comes from is compiled into the app.
	if strings.Contains(rec.Body.String(), "://") {
		t.Errorf("the policy names a URL: %s", rec.Body.String())
	}
}

// Anonymous by construction: the route answers without a session, so a
// signed-out app (or one with no account at all) learns its support state.
func TestIOSClientPolicyNeedsNoSession(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodGet, "/api/client-policy/ios", nil)
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("anonymous request status = %d", rec.Code)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("the policy route set a cookie")
	}
}

// Only GET: nothing can write through this path.
func TestIOSClientPolicyRefusesWrites(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodPost, "/api/client-policy/ios", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("POST was accepted")
	}
}
