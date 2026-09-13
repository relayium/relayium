package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The Windows supported-version gate's server end.
//
// The client half has existed and been thorough for a while — ten invariants,
// each with an adversarial case — and it has never once been able to fetch a
// document, because this route did not exist. Every Windows launch ran on the
// floor compiled into its own binary.
//
// These tests hold the served bytes to what the SHIPPED client decoder will
// accept. The decoder itself is exercised over these same bytes on the other
// side, in `apps/windows/test/unit/policy-contract.test.ts`; what is here is
// the half that can be checked without a TypeScript runtime.

func servedWindowsPolicy(t *testing.T) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodGet, "/api/client-policy/windows", nil)
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

func TestWindowsClientPolicyIsServedAndInert(t *testing.T) {
	rec, body := servedWindowsPolicy(t)

	// The client refuses a document whose schema it does not know, WHOLE. A
	// wrong number here is not a degraded read, it is a route that silently
	// does nothing.
	if body["schema"] != float64(1) {
		t.Fatalf("schema = %v", body["schema"])
	}
	windows, ok := body["windows"].(map[string]any)
	if !ok {
		t.Fatalf("no windows object: %v", body)
	}

	// Exactly EMBEDDED_FLOOR. Two separate reasons, and both matter:
	//
	//  - Weaker than the floor and the client refuses the document outright
	//    (its invariant 2), so the route would be dead on arrival while
	//    appearing to work.
	//  - Stronger than the floor and it would BLOCK builds, which the owner has
	//    not asked for (OA-033: no minimum for now).
	for field, want := range map[string]any{
		"policyRevision":          float64(1),
		"minimumSupportedVersion": "0.0.0",
		"minimumSupportedBuild":   float64(0),
		"recommendedVersion":      "0.0.0",
		"latestVersion":           "0.0.1",
	} {
		if windows[field] != want {
			t.Errorf("%s = %v, want %v", field, windows[field], want)
		}
	}

	// Whole or nothing: an extra field is not harmless here. The client drops
	// what it was not asked for, so a field added on this side is a field that
	// silently does nothing while reading as configuration.
	if len(windows) != 5 {
		t.Errorf("windows object has %d fields, want 5: %v", len(windows), windows)
	}
	if len(body) != 2 {
		t.Errorf("document has %d fields, want 2: %v", len(body), body)
	}

	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("cache control = %q; a cached policy cannot be changed in the emergency it exists for", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content type = %q", got)
	}
}

func TestWindowsClientPolicyCarriesNoURL(t *testing.T) {
	// The client's invariant 6, enforced from this end too. It fetches this
	// document over the network; a policy that could name where an update comes
	// from would be a remote redirect for the one action that installs code on
	// somebody's PC. The client drops unknown fields — this is so a server
	// never offers one to drop.
	rec, _ := servedWindowsPolicy(t)
	raw := strings.ToLower(rec.Body.String())
	for _, needle := range []string{"http", "://", "url", "href", "feed", "endpoint", "origin"} {
		if strings.Contains(raw, needle) {
			t.Errorf("served policy contains %q: %s", needle, rec.Body.String())
		}
	}
}

func TestWindowsClientPolicyIsTheEmbeddedFileVerbatim(t *testing.T) {
	// One artefact, not two. A struct marshalled here and a decoder written in
	// TypeScript are two statements of one contract that drift silently, and
	// the drift is invisible: a refused document just makes the client fall
	// back to its floor with no user-visible symptom. The TypeScript contract
	// test reads this same file.
	rec, _ := servedWindowsPolicy(t)
	if rec.Body.String() != string(windowsClientPolicyJSON) {
		t.Fatalf("served bytes differ from the embedded file:\n%s\n---\n%s",
			rec.Body.String(), windowsClientPolicyJSON)
	}
}
