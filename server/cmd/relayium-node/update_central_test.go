package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeCentral(t *testing.T, status int, body map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
}

func TestFetchTargetReturnsEligibleTarget(t *testing.T) {
	srv := fakeCentral(t, 200, map[string]any{
		"targetVersion": "v0.9.0", "eligible": true, "allowDowngrade": false,
	})
	defer srv.Close()

	tag, eligible, allowDown, err := fetchTarget(srv.URL, "tok", "n1", "0.8.0", "", srv.Client())
	if err != nil {
		t.Fatalf("fetchTarget: %v", err)
	}
	if tag != "v0.9.0" || !eligible || allowDown {
		t.Errorf("got tag=%q eligible=%v allowDowngrade=%v, want v0.9.0/true/false", tag, eligible, allowDown)
	}
}

// The overwhelmingly common answer is "not your turn" — it must be a cheap,
// quiet, non-error path, because every node asks every few minutes forever.
func TestFetchTargetHandlesIneligible(t *testing.T) {
	srv := fakeCentral(t, 200, map[string]any{"targetVersion": "v0.9.0", "eligible": false})
	defer srv.Close()

	_, eligible, _, err := fetchTarget(srv.URL, "tok", "n1", "0.8.0", "", srv.Client())
	if err != nil {
		t.Errorf("fetchTarget returned an error for the normal not-my-turn answer: %v", err)
	}
	if eligible {
		t.Error("eligible = true, want false")
	}
}

// A bad token must be a loud error, not silently read as "not my turn" —
// otherwise a node would sit un-updated forever and look healthy doing it.
func TestFetchTargetErrorsOnUnauthorized(t *testing.T) {
	srv := fakeCentral(t, 200, nil)
	defer srv.Close()

	if _, _, _, err := fetchTarget(srv.URL, "wrong-token", "n1", "0.8.0", "", srv.Client()); err == nil {
		t.Error("fetchTarget err = nil on 401, want an error")
	}
}

// Central being down must not touch the binary. The node keeps running the
// version it has; that is always the safe outcome.
func TestFetchTargetErrorsWhenCentralUnreachable(t *testing.T) {
	if _, _, _, err := fetchTarget("http://127.0.0.1:1", "tok", "n1", "0.8.0", "", http.DefaultClient); err == nil {
		t.Error("fetchTarget err = nil against an unreachable central, want an error")
	}
}
