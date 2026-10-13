package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// A negative --max-downloads is refused with a usage exit before the
// credential, the files or the network are touched. The stub server counts
// every request it sees; none may arrive.
func TestUpRefusesNegativeMaxDownloadsBeforeAnyRequest(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "unexpected", http.StatusTeapot)
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"-1", "-9223372036854775808"} {
		var out, errOut bytes.Buffer
		code := runUp([]string{"--max-downloads", v, src}, &out, &errOut)
		if code != 2 {
			t.Fatalf("--max-downloads %s: code=%d, want 2 (stderr %q)", v, code, errOut.String())
		}
		if out.Len() != 0 {
			t.Fatalf("--max-downloads %s: stdout must be empty, got %q", v, out.String())
		}
		if !strings.Contains(errOut.String(), "max-downloads") {
			t.Fatalf("--max-downloads %s: error should name the flag, got %q", v, errOut.String())
		}
	}
	// The refusal also comes before the files: a missing source is not even
	// looked at.
	var out, errOut bytes.Buffer
	if code := runUp([]string{"--max-downloads", "-3", filepath.Join(t.TempDir(), "missing")}, &out, &errOut); code != 2 {
		t.Fatalf("missing source with negative limit: code=%d, want 2 (stderr %q)", code, errOut.String())
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("a refused --max-downloads must send nothing, server saw %d request(s)", n)
	}
}

// 0 keeps its documented meaning: the parameter is not sent, and the server's
// default policy applies. (The help says so; it never promises "unlimited".)
func TestUpZeroMaxDownloadsSendsNoLimit(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "zero1", "expiresAt": 999})
	}))
	defer srv.Close()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runUp([]string{"--max-downloads", "0", src}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	if strings.Contains(gotQuery, "maxDownloads") {
		t.Fatalf("0 must leave the limit to the server, query was %q", gotQuery)
	}
	if !strings.Contains(upUsage, "not necessarily") || strings.Contains(strings.ToLower(upUsage), "0 means unlimited") {
		t.Fatalf("help must describe 0 as the server default, not unlimited:\n%s", upUsage)
	}
}

func withDownStdin(t *testing.T, input string, terminal bool) {
	t.Helper()
	oldIn, oldTTY := downStdin, downStdinIsTerminal
	downStdin = func() io.Reader { return strings.NewReader(input) }
	downStdinIsTerminal = func() bool { return terminal }
	t.Cleanup(func() { downStdin, downStdinIsTerminal = oldIn, oldTTY })
}

// `down -` refuses empty, oversized, multi-line and terminal standard input
// with a usage exit, before any request, and never echoes what it read.
func TestDownStdinRefusals(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	const secret = "SECRETKEYMATERIALdoNotEcho"
	cases := []struct {
		name     string
		input    string
		terminal bool
		want     string
	}{
		{"empty", "", false, "empty"},
		{"whitespace", " \n\t\n", false, "empty"},
		{"oversize", srv.URL + "/d/abc#k=" + secret + strings.Repeat("A", maxStdinClaim), false, "longer than"},
		{"two lines", srv.URL + "/d/abc#k=" + secret + "\n" + srv.URL + "/d/def#k=" + secret, false, "more than one line"},
		{"terminal", "", true, "terminal"},
		{"no fragment", "abc k=" + secret, false, "no #k="},
		{"key alone", secret, false, "no #k="},
		{"bad fragment", srv.URL + "/d/abc#x=" + secret, false, "must be k=<key>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withDownStdin(t, tc.input, tc.terminal)
			var out, errOut bytes.Buffer
			code := runDown([]string{"-", t.TempDir()}, &out, &errOut)
			if code != 2 {
				t.Fatalf("code=%d, want 2 (stderr %q)", code, errOut.String())
			}
			if !strings.Contains(errOut.String(), tc.want) {
				t.Fatalf("stderr %q should mention %q", errOut.String(), tc.want)
			}
			if strings.Contains(errOut.String(), secret) || strings.Contains(out.String(), secret) {
				t.Fatalf("output repeated the key: stdout=%q stderr=%q", out.String(), errOut.String())
			}
		})
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("refused stdin must send nothing, server saw %d request(s)", n)
	}
}

// Every claim-parse error hides the key, whatever spelling carried it.
func TestParseClaimErrorsNeverRepeatTheKey(t *testing.T) {
	const secret = "VERYSECRETkeyMaterial123"
	for _, claim := range []string{
		secret, // a pasted key alone carries no marker at all
		"abc k=" + secret,
		"abc%23k=" + secret,
		"https://relayium.com/x/abc#k=" + secret,
		"https://relayium.com/d/abc#x=" + secret,
		"#k=" + secret,
	} {
		_, _, _, err := cloud.ParseClaim(claim)
		if err == nil {
			t.Fatalf("%q: expected a parse error", claim)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("%q: error repeated the key: %v", claim, err)
		}
	}
}
