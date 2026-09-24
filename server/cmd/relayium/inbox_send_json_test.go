//go:build !windows

// Server-only on Windows: one test here uses newSendEnv from
// inbox_send_e2e_test.go, which drives the account server (internal/storage —
// syscall.Statfs), not released for Windows. See the cli-windows job in
// .github/workflows/go.yml.

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
)

// F-B (revision 3): --json means exactly one JSON document on stdout, also
// when the command fails before a Session exists (not logged in, unusable
// configuration directory) and when the command line itself is refused.
// Whether JSON was asked for is read with real flag rules, never a substring.

// oneJSONDoc decodes stdout as exactly one JSON object, nothing after it, with
// no raw control character anywhere.
func oneJSONDoc(t *testing.T, where, stdout string) map[string]any {
	t.Helper()
	for _, r := range strings.TrimSuffix(stdout, "\n") {
		if unicode.IsControl(r) {
			t.Fatalf("%s: raw control character %U on stdout %q", where, r, stdout)
		}
	}
	dec := json.NewDecoder(strings.NewReader(stdout))
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("%s: stdout is not a JSON document: %v %q", where, err, stdout)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		t.Fatalf("%s: more than one JSON document on stdout: %q", where, stdout)
	}
	return m
}

func TestInboxSenderJSONOnPreflightFailures(t *testing.T) {
	isolatedEnv(t)
	empty := t.TempDir() // a configuration directory holding no credential
	id := strings.Repeat("a", 32)
	for _, args := range [][]string{
		{"inbox", "devices", "--json", "--config-dir", empty},
		{"inbox", "send", "--json", "--to", "x", "--config-dir", empty, "a.txt"},
		{"inbox", "sent", "--json", "--config-dir", empty},
		{"inbox", "cancel", "--json", "--config-dir", empty, "abc"},
		{"inbox", "retry", "--json", "--config-dir", empty, id},
		{"inbox", "retry", "--config-dir", empty, "not-an-id", "-json"}, // trailing, single dash
		{"inbox", "send", "--json=true", "--to", "x", "--config-dir", empty, "a.txt"},
	} {
		var o, e bytes.Buffer
		rc := Run(args, &o, &e)
		doc := oneJSONDoc(t, strings.Join(args, " "), o.String())
		if rc != exitSendFailed || doc["error"] != "signed_out" || doc["outcome"] != "failed" || len(doc) != 2 {
			t.Errorf("%v: rc=%d doc=%v", args, rc, doc)
		}
		if !strings.Contains(e.String(), "not logged in") {
			t.Errorf("%v: the reason is not on stderr: %q", args, e.String())
		}
	}

	// An unusable configuration directory (a path under a regular file).
	blocked := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var o, e bytes.Buffer
	rc := Run([]string{"inbox", "devices", "--json", "--config-dir", filepath.Join(blocked, "sub")}, &o, &e)
	doc := oneJSONDoc(t, "unusable config dir", o.String())
	if rc != exitSendFailed || doc["outcome"] != "failed" || (doc["error"] != "local_state" && doc["error"] != "signed_out") {
		t.Errorf("unusable config dir: rc=%d doc=%v stderr=%q", rc, doc, e.String())
	}
	if strings.TrimSpace(e.String()) == "" {
		t.Error("unusable config dir: nothing on stderr")
	}
}

func TestInboxSenderJSONOnUsageFailures(t *testing.T) {
	isolatedEnv(t)
	for _, args := range [][]string{
		{"inbox", "send", "--json", "a.txt"},                         // no --to
		{"inbox", "send", "--to", "x", "--json"},                     // no paths
		{"inbox", "send", "--to", "x", "--ttl", "zz", "a", "--json"}, // bad --ttl
		{"inbox", "send", "--json", "--to", "x", "--wait=-1s", "a"},  // flag value refused by Parse
		{"inbox", "send", "--json", "--bogus", "a"},                  // unknown flag
		{"inbox", "send", "--json", "--to"},                          // value flag with nothing after it
		{"inbox", "retry", "--json"},
		{"inbox", "cancel", "--json"},
		{"inbox", "sent", "--json", "a", "b"},
		{"inbox", "sent", "--json", "--limit", "0"},
		{"inbox", "devices", "--json", "extra"},
	} {
		var o, e bytes.Buffer
		rc := Run(args, &o, &e)
		doc := oneJSONDoc(t, strings.Join(args, " "), o.String())
		if rc != exitSendUsage || doc["error"] != "usage" || doc["outcome"] != "refused" || len(doc) != 2 {
			t.Errorf("%v: rc=%d doc=%v", args, rc, doc)
		}
		if strings.TrimSpace(e.String()) == "" {
			t.Errorf("%v: nothing on stderr", args)
		}
	}
}

// Without a real --json request stdout stays empty: --json=false, a later
// --json=false, a malformed value, a file literally named --json after "--",
// and a value flag whose value happens to be "--json".
func TestInboxSenderJSONIsReadWithFlagRules(t *testing.T) {
	isolatedEnv(t)
	empty := t.TempDir()
	for _, tc := range []struct {
		args []string
		rc   int
	}{
		{[]string{"inbox", "devices", "--json=false", "--config-dir", empty}, exitSendFailed},
		{[]string{"inbox", "sent", "--json", "--config-dir", empty, "--json=false"}, exitSendFailed},
		{[]string{"inbox", "send", "--json=false", "a.txt"}, exitSendUsage},
		{[]string{"inbox", "send", "--json", "--json=0", "--bogus", "a"}, exitSendUsage},
		{[]string{"inbox", "send", "--json=maybe", "--to", "x", "a"}, exitSendUsage},
		{[]string{"inbox", "send", "--to", "x", "--config-dir", empty, "--", "--json"}, exitSendFailed},
		{[]string{"inbox", "send", "--bogus", "--", "--json"}, exitSendUsage},
		{[]string{"inbox", "send", "--to", "--json", "--config-dir", empty, "a.txt"}, exitSendFailed},
		{[]string{"inbox", "send", "--config-dir", "--json", "--bogus", "a"}, exitSendUsage},
	} {
		var o, e bytes.Buffer
		if rc := Run(tc.args, &o, &e); rc != tc.rc || o.Len() != 0 {
			t.Errorf("%v: rc=%d (want %d) stdout=%q", tc.args, rc, tc.rc, o.String())
		}
	}
}

// jsonRequested agrees with the flag package wherever the flag package can
// parse at all.
func TestJSONRequestedMatchesFlagParsing(t *testing.T) {
	for _, args := range [][]string{
		{"--json"}, {"-json"}, {"--json=true"}, {"--json=1"}, {"--json=false"}, {"--json", "--json=f"},
		{"--json=false", "--json"}, {"a", "--json"}, {"--", "--json"}, {"--to", "--json"}, {"--to=--json"},
		{"--to", "x", "--json", "b"}, {"-to", "--json", "-json"}, {"--limit", "3", "--json"}, {"---json"},
	} {
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		var j bool
		var to string
		var limit int
		fs.BoolVar(&j, "json", false, "")
		fs.StringVar(&to, "to", "", "")
		fs.IntVar(&limit, "limit", 0, "")
		permuted, err := permuteFlags(fs, args)
		if err == nil {
			err = fs.Parse(permuted)
		}
		if err != nil {
			continue // nothing to compare against; the usage tests cover these
		}
		if got := jsonRequested(fs, args); got != j {
			t.Errorf("%v: jsonRequested = %v, flag parsed %v", args, got, j)
		}
	}
}

// Stderr of a refused command line is sanitized like everything else the
// sender prints: an argument cannot put escape sequences on the terminal.
func TestInboxSenderUsageStderrIsTerminalSafe(t *testing.T) {
	isolatedEnv(t)
	var o, e bytes.Buffer
	rc := Run([]string{"inbox", "send", "--json", "--to", "x", "--ttl", "\x1b[2J\x9b31m", "a"}, &o, &e)
	if rc != exitSendUsage {
		t.Fatalf("rc = %d", rc)
	}
	oneJSONDoc(t, "bad ttl", o.String())
	if strings.ContainsAny(e.String(), "\x1b\x9b") || strings.Contains(e.String(), "\u009b") {
		t.Fatalf("raw escape on stderr: %q", e.String())
	}
}

// Help keeps its convention (usage on stdout, exit 0) even with --json, and a
// failure after the Session exists still prints its one document.
func TestInboxSenderHelpAndSessionFailuresUnchanged(t *testing.T) {
	isolatedEnv(t)
	for _, sub := range []string{"devices", "send", "sent", "cancel", "retry"} {
		var o, e bytes.Buffer
		if rc := Run([]string{"inbox", sub, "--json", "--help"}, &o, &e); rc != 0 || !strings.HasPrefix(o.String(), "relayium inbox "+sub) {
			t.Errorf("%s --json --help: rc=%d stdout=%q", sub, rc, o.String())
		}
	}
	s := newSendEnv(t)
	rc, stdout, _ := s.cli("sent", "--json", "--config-dir", s.senderCfg, "no-such-task")
	doc := oneJSONDoc(t, "session-level failure", stdout)
	if rc != exitSendFailed || doc["error"] != "no_such_task" || doc["outcome"] != "failed" {
		t.Errorf("session-level failure: rc=%d doc=%v", rc, doc)
	}
}
