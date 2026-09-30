package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// B-L6: the post-update health signal is "a heartbeat reached central", so a
// central outage during the health window used to look exactly like a broken
// release — the updater rolled back AND wrote the (good) version into
// failed-versions, refusing it on this node forever. A missing heartbeat while
// central itself is unreachable is inconclusive: roll back, report rolled_back,
// but do not blacklist.
func runNeverHealthyUpdate(t *testing.T, centralURL string) (int, string, string) {
	t.Helper()
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv := fakeGithubRelease(t, "v9.9.9", "NEW-NODE-BINARY")
	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		APIBase: srv.URL, DownloadBase: srv.URL, CentralURL: centralURL,
	}
	svc := &fakeSvc{} // restarts fine, never heartbeats
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)
	if got, _ := os.ReadFile(bin); string(got) != "OLD" {
		t.Fatalf("binary = %q, want rollback to OLD", got)
	}
	return code, dir, errBuf.String()
}

func TestRunUpdateCentralOutageDoesNotBlacklistTheVersion(t *testing.T) {
	// A port nothing listens on: connection refused, i.e. central is down.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	downURL := "http://" + l.Addr().String()
	l.Close()

	code, dir, stderr := runNeverHealthyUpdate(t, downURL)
	if code != exitNotHealthy {
		t.Fatalf("code = %d, want %d (rolled_back); stderr=%s", code, exitNotHealthy, stderr)
	}
	if failedBefore(dir, "v9.9.9") {
		t.Fatalf("v9.9.9 was blacklisted although central was unreachable during the health window; stderr=%s", stderr)
	}
}

func TestRunUpdateCentral5xxDoesNotBlacklistTheVersion(t *testing.T) {
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down for maintenance", http.StatusServiceUnavailable)
	}))
	defer central.Close()
	code, dir, stderr := runNeverHealthyUpdate(t, central.URL)
	if code != exitNotHealthy || failedBefore(dir, "v9.9.9") {
		t.Fatalf("code=%d blacklisted=%v, want rolled back and retryable; stderr=%s", code, failedBefore(dir, "v9.9.9"), stderr)
	}
}

// The other half must not regress: with central answering, a version that never
// heartbeats failed on its own and is still blacklisted.
func TestRunUpdateCentralUpStillBlacklistsAnUnhealthyVersion(t *testing.T) {
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer central.Close()
	code, dir, stderr := runNeverHealthyUpdate(t, central.URL)
	if code != exitNotHealthy {
		t.Fatalf("code = %d, want %d; stderr=%s", code, exitNotHealthy, stderr)
	}
	if !failedBefore(dir, "v9.9.9") {
		t.Fatalf("v9.9.9 not blacklisted although central was reachable; stderr=%s", stderr)
	}
}
