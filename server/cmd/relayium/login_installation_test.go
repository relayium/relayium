package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestLoginCorruptIdentityGivesSafeRepairGuidanceBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Error(w, "unexpected", 500) }))
	defer srv.Close()
	dir := t.TempDir()
	if _, err := cloud.InstallationID(dir, srv.URL); err != nil {
		t.Fatal(err)
	}
	identityDir := filepath.Join(dir, "cli-installations")
	files, err := os.ReadDir(identityDir)
	if err != nil || len(files) != 1 {
		t.Fatalf("identity setup: %v", err)
	}
	path := filepath.Join(identityDir, files[0].Name())
	if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if runLogin([]string{"--server", srv.URL, "--config-dir", dir}, &out, &out) == 0 {
		t.Fatal("corrupt identity accepted")
	}
	for _, want := range []string{identityDir, "trusted backup", "new --config-dir"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing safe repair guidance %q: %s", want, out.String())
		}
	}
	if calls.Load() != 0 {
		t.Fatal("corrupt identity caused network traffic")
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "corrupt" {
		t.Fatal("corrupt identity was replaced")
	}
}

func TestLoginRetainsInstallationAcrossLocalLogoutAndWarnsForLegacyServer(t *testing.T) {
	for _, capable := range []bool{true, false} {
		t.Run(map[bool]string{true: "modern", false: "legacy"}[capable], func(t *testing.T) {
			var hints []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/cli/device/start" {
					var in map[string]string
					if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
						t.Error(err)
					}
					hints = append(hints, in["cli_install_id"])
					_ = json.NewEncoder(w).Encode(map[string]any{"user_code": "AAAA-BBBB", "device_code": "dc", "verification_uri": "http://x/device", "expires_in": 60, "cli_install_identity": capable})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "access_token": "synthetic-token", "account_email": "a@example.com"})
				}
			}))
			defer srv.Close()
			dir := t.TempDir()
			args := []string{"--server", srv.URL, "--config-dir", dir}
			for range 2 {
				var out, errs bytes.Buffer
				if code := runLogin(args, &out, &errs); code != 0 {
					t.Fatalf("login failed %d: %s", code, errs.String())
				}
				warned := strings.Contains(errs.String(), "does not support stable CLI installation identity")
				if warned == capable {
					t.Fatal("incorrect capability warning")
				}
				if code := runLogout([]string{"--config-dir", dir, "--local-only"}, &out, &errs); code != 0 {
					t.Fatal("local logout failed", code)
				}
			}
			if len(hints) != 2 || len(hints[0]) != 43 || hints[0] != hints[1] {
				t.Fatal("CLI login did not retain the same hint")
			}
		})
	}
}

func TestConcurrentLoginRefusesBeforeAnotherApproval(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var starts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/cli/device/start" {
			starts.Add(1)
			close(entered)
			<-release
			_ = json.NewEncoder(w).Encode(map[string]any{"user_code": "AAAA-BBBB", "device_code": "dc", "verification_uri": "http://x/device", "expires_in": 60, "cli_install_identity": true})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "access_token": "synthetic-token", "account_email": "a@example.com"})
		}
	}))
	defer srv.Close()
	defer unblock()
	dir := t.TempDir()
	args := []string{"--server", srv.URL, "--config-dir", dir}
	done := make(chan int, 1)
	go func() { var out bytes.Buffer; done <- runLogin(args, &out, &out) }()
	select {
	case <-entered:
	case code := <-done:
		t.Fatalf("original login failed before request entry: %d", code)
	}
	var out bytes.Buffer
	if code := runLogin(args, &out, &out); code == 0 {
		t.Fatal("second overlapping login accepted")
	}
	if starts.Load() != 1 {
		t.Fatal("overlapping login issued another approval")
	}
	unblock()
	if code := <-done; code != 0 {
		t.Fatal("original login failed", code)
	}
}
