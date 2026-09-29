package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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
	for field, want := range map[string]any{
		"policyRevision": float64(1), "recommendedVersion": "0.3.0",
		"recommendedBuild": float64(9), "channel": "direct",
	} {
		if android[field] != want {
			t.Errorf("%s = %v, want %v", field, android[field], want)
		}
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

func TestAndroidClientPolicyRecommendsPublishedInstallableRelease(t *testing.T) {
	var policy struct {
		Android struct {
			Version string `json:"recommendedVersion"`
			Build   int    `json:"recommendedBuild"`
		} `json:"android"`
	}
	if err := json.Unmarshal(androidClientPolicyJSON, &policy); err != nil {
		t.Fatal(err)
	}
	feedBytes, err := os.ReadFile("../../web/public/apps/android/update.json")
	if err != nil {
		t.Fatal(err)
	}
	var feed struct {
		Android struct {
			Available bool   `json:"available"`
			Version   string `json:"versionName"`
			Build     int    `json:"versionCode"`
			URL       string `json:"downloadUrl"`
		} `json:"android"`
	}
	if err := json.Unmarshal(feedBytes, &feed); err != nil {
		t.Fatal(err)
	}
	if !feed.Android.Available || feed.Android.URL == "" ||
		policy.Android.Version != feed.Android.Version || policy.Android.Build != feed.Android.Build {
		t.Fatalf("policy %s(%d) is not the published installable release %+v",
			policy.Android.Version, policy.Android.Build, feed.Android)
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
