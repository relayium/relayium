package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// TestAccountCommandsHonorConfigDir pins CLI-3: whoami, up, send, text and pair
// used to read the credential only from the default directory, so a login made
// with `relayium login --config-dir D` was invisible to them ("not logged in"),
// or — worse — they silently used a different account stored in the default
// directory. Every command that reads the stored login must accept --config-dir.
func TestAccountCommandsHonorConfigDir(t *testing.T) {
	isolatedEnv(t) // the default directory is empty: only --config-dir holds a login
	// Every request is refused with 429, so a command that DID find the login
	// fails fast on the server's answer instead of dialing a rendezvous.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	cfg := t.TempDir()
	if err := cloud.Save(cfg, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc", AccountEmail: "cfgdir@example.com"}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("whoami", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		rc := Run([]string{"whoami", "--config-dir", cfg}, &stdout, &stderr)
		if rc != 0 || !strings.Contains(stdout.String(), "cfgdir@example.com") {
			t.Fatalf("whoami --config-dir: rc=%d stdout=%q stderr=%q", rc, stdout.String(), stderr.String())
		}
	})

	notLoggedIn := []string{"login` first", "not logged in", "needs an account"}
	for _, args := range [][]string{
		{"up", src, "--config-dir", cfg},
		{"send", src, "--server", srv.URL, "--config-dir", cfg},
		{"text", "--server", srv.URL, "--config-dir", cfg},
		{"pair", "--server", srv.URL, "--config-dir", cfg},
	} {
		args := args
		t.Run(args[0], func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			rc := Run(args, &stdout, &stderr)
			if rc == 2 {
				t.Fatalf("`relayium %s`: usage error, --config-dir not accepted: %s", strings.Join(args, " "), stderr.String())
			}
			for _, bad := range notLoggedIn {
				if strings.Contains(stderr.String(), bad) {
					t.Fatalf("`relayium %s` ignored --config-dir (reported %q): %s", strings.Join(args, " "), bad, stderr.String())
				}
			}
			if rc == 0 {
				t.Fatalf("`relayium %s` succeeded against a server that refuses everything", strings.Join(args, " "))
			}
		})
	}
}
