package account

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAndroidClientPolicyIsAnonymousAdvisoryAndInert(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodGet, "/api/client-policy/android", nil)
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatal("policy route set a cookie")
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("Content-Type = %q", rec.Header().Get("Content-Type"))
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	android, ok := body["android"].(map[string]any)
	if !ok || body["schema"] != float64(1) {
		t.Fatalf("body = %v", body)
	}
	if !bytes.Equal(rec.Body.Bytes(), androidClientPolicyJSON) {
		t.Fatal("policy route did not serve the embedded advisory")
	}
	for _, field := range []string{"policyRevision", "recommendedBuild"} {
		value, ok := android[field].(float64)
		if !ok || value <= 0 || value != math.Trunc(value) {
			t.Errorf("%s = %v, want a positive integer", field, android[field])
		}
	}
	if version, ok := android["recommendedVersion"].(string); !ok || version == "" {
		t.Errorf("recommendedVersion = %v, want a nonempty version", android["recommendedVersion"])
	}
	if android["channel"] != "direct" {
		t.Errorf("channel = %v, want direct", android["channel"])
	}
	if len(body) != 2 || len(android) != 4 {
		t.Fatalf("unexpected fields: %v", body)
	}
	text := strings.ToLower(rec.Body.String())
	for _, forbidden := range []string{"http://", "https://", "minimum", "required", "block"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("policy contains forbidden %q: %s", forbidden, text)
		}
	}
}

func TestAndroidClientPolicyRefusesWrites(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodPost, "/api/client-policy/android", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatal("POST was accepted")
	}
}
