package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func decodeOne(t *testing.T, s string, into any) {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(s))
	if err := dec.Decode(into); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, s)
	}
	if dec.More() {
		t.Fatalf("more than one JSON document:\n%s", s)
	}
}

func TestWhoamiJSON(t *testing.T) {
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	if code := runWhoami([]string{"--json", "--config-dir", dir}, &out, &errOut); code != 1 {
		t.Fatalf("logged out: code %d", code)
	}
	var doc struct {
		LoggedIn bool   `json:"loggedIn"`
		Account  string `json:"account"`
		Server   string `json:"server"`
		Error    string `json:"error"`
	}
	decodeOne(t, out.String(), &doc)
	if doc.LoggedIn || doc.Error != "not_logged_in" {
		t.Fatalf("logged out doc: %+v", doc)
	}

	if err := cloud.Save(dir, cloud.Creds{Server: "https://example.test", AccountEmail: "a@example.com", AccessToken: "SECRET-TOKEN"}); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := runWhoami([]string{"--json", "--config-dir", dir}, &out, &errOut); code != 0 {
		t.Fatalf("logged in: code %d", code)
	}
	doc = struct {
		LoggedIn bool   `json:"loggedIn"`
		Account  string `json:"account"`
		Server   string `json:"server"`
		Error    string `json:"error"`
	}{}
	decodeOne(t, out.String(), &doc)
	if !doc.LoggedIn || doc.Account != "a@example.com" || doc.Server != "https://example.test" {
		t.Fatalf("logged in doc: %+v", doc)
	}
	if strings.Contains(out.String(), "SECRET-TOKEN") {
		t.Fatal("whoami --json printed the token")
	}
	// The text form is unchanged.
	out.Reset()
	if code := runWhoami([]string{"--config-dir", dir}, &out, &errOut); code != 0 || out.String() != "a@example.com (https://example.test)\n" {
		t.Fatalf("text whoami changed: code %d %q", code, out.String())
	}
}

// --json without --check is refused before anything is fetched or installed.
func TestUpdateJSONRequiresCheck(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	old := updateAPIBase
	updateAPIBase = srv.URL
	defer func() { updateAPIBase = old }()

	var out, errOut bytes.Buffer
	if code := runUpdate([]string{"--json"}, &out, &errOut); code != 2 {
		t.Fatalf("--json alone: code %d, want 2 (stderr %q)", code, errOut.String())
	}
	if hits.Load() != 0 || out.Len() != 0 {
		t.Fatalf("--json alone must do nothing: hits=%d stdout=%q", hits.Load(), out.String())
	}
}

func TestUpdateCheckJSON(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"tag_name":"v9.9.9","draft":false,"prerelease":false}]`))
	}))
	defer srv.Close()
	old := updateAPIBase
	updateAPIBase = srv.URL
	defer func() { updateAPIBase = old }()

	var out, errOut bytes.Buffer
	if code := runUpdate([]string{"--check", "--json"}, &out, &errOut); code != 0 {
		t.Fatalf("code %d stderr %q", code, errOut.String())
	}
	var doc updateCheckDoc
	decodeOne(t, out.String(), &doc)
	if doc.Latest != "v9.9.9" || doc.Current != version || doc.UpdateAvailable != updateAvailable("v9.9.9", version) {
		t.Fatalf("doc %+v", doc)
	}

	fail.Store(true)
	out.Reset()
	if code := runUpdate([]string{"--check", "--json"}, &out, &errOut); code != 1 {
		t.Fatalf("failed check: code %d", code)
	}
	doc = updateCheckDoc{}
	decodeOne(t, out.String(), &doc)
	if doc.Error == "" || doc.UpdateAvailable {
		t.Fatalf("failed check doc %+v", doc)
	}
}
