package main

import (
	"bytes"
	"crypto/sha256"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// dirDigest hashes every file (path + bytes + mode) under dir, so "nothing in
// the config directory changed" is checked byte for byte.
func dirDigest(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		line := p + " " + info.Mode().String()
		if d.Type().IsRegular() {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(b)
			line += " " + string(sum[:])
		}
		lines = append(lines, line)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return string(sum[:])
}

// A second login on a machine that holds a credential is refused before any
// request, with the credential, the Device Inbox state and sender journals
// left byte-for-byte as they were -- for the same server and for another one.
func TestLoginRefusesWhenAlreadyLoggedIn(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "unexpected", http.StatusTeapot)
	}))
	defer srv.Close()

	cfgDir := t.TempDir()
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "OLD-TOKEN"}); err != nil {
		t.Fatal(err)
	}
	// Stand-ins for Device Inbox receiver state and a sender journal: their
	// exact content does not matter, only that nothing touches them.
	for name, body := range map[string]string{
		"inbox/config.json":           `{"enabled":true,"deviceId":"dev-old"}`,
		"inbox/keys.json":             `[{"keyId":"k1"}]`,
		"inbox-send/op-123/send.json": `{"phase":"uploaded"}`,
	} {
		p := filepath.Join(cfgDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	before := dirDigest(t, cfgDir)

	for _, args := range [][]string{
		{"--server", srv.URL, "--config-dir", cfgDir},
		{"--server", "https://other.example.test", "--config-dir", cfgDir},
		{"--server", srv.URL, "--config-dir", cfgDir, "--device-name", "laptop"},
	} {
		var out, errOut bytes.Buffer
		code := runLogin(args, &out, &errOut)
		if code == 0 {
			t.Fatalf("login %v succeeded over an existing credential", args)
		}
		for _, want := range []string{"already logged in as a@example.com", "relayium logout", "NEW device", "Nothing was changed"} {
			if !strings.Contains(errOut.String(), want) {
				t.Fatalf("login %v: stderr should say %q:\n%s", args, want, errOut.String())
			}
		}
		if strings.Contains(errOut.String()+out.String(), "OLD-TOKEN") {
			t.Fatal("the refusal printed the token")
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("a refused login made %d request(s)", n)
	}
	if after := dirDigest(t, cfgDir); after != before {
		t.Fatal("a refused login changed the config directory")
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil || !ok || creds.AccessToken != "OLD-TOKEN" {
		t.Fatalf("credential after refusal: %+v %v %v", creds, ok, err)
	}
}

// An unreadable credential file is refused too, not overwritten.
func TestLoginRefusesOverUnreadableCredential(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	cfgDir := t.TempDir()
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "T"}); err != nil {
		t.Fatal(err)
	}
	var credPath string
	_ = filepath.WalkDir(cfgDir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			credPath = p
		}
		return nil
	})
	if err := os.WriteFile(credPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := dirDigest(t, cfgDir)
	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL, "--config-dir", cfgDir}, &out, &errOut); code == 0 {
		t.Fatal("login replaced an unreadable credential")
	}
	if hits.Load() != 0 || dirDigest(t, cfgDir) != before {
		t.Fatalf("refusal made requests (%d) or changed files", hits.Load())
	}
}
