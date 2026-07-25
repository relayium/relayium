package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/selfupdate"
)

// nodeAssetName is the release archive the NODE ships in, spelled out here
// rather than derived from selfupdate: this test's whole job is to pin the
// contract that `relayium-node update` installs the node's artifact
// ("relayium-node_<os>_<arch>.tar.gz", entry "relayium-node" — see
// .goreleaser.yaml and install-node.sh) and not the CLI's. Deriving it from
// selfupdate.AssetName would make the test agree with whatever the updater
// happens to fetch, which is exactly how the CLI-installed-over-the-node bug
// stayed invisible.
func nodeAssetName(goos, goarch string) string {
	return "relayium-node_" + goos + "_" + goarch + ".tar.gz"
}

// nodeBinaryEntry is the file name inside that archive.
const nodeBinaryEntry = "relayium-node"

// tarGzSingleFile builds a gzip+tar archive containing one regular file named
// entryName — the shape goreleaser produces and replaceFromArchive expects.
func tarGzSingleFile(t *testing.T, entryName, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte(content)
	if err := tw.WriteHeader(&tar.Header{Name: entryName, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// cliArchiveContent is what the CLI archive of the fake release contains. A
// real release publishes both archives under one checksums.txt, so fetching the
// wrong one verifies perfectly — tests assert on the installed bytes to tell
// them apart.
const cliArchiveContent = "CLI-BINARY-WRONG-ARTIFACT"

// fakeGithubRelease serves just enough of a GitHub-shaped release for
// selfupdate.Update to succeed against a fixed TargetTag. Like a real release
// it publishes BOTH archives — the CLI's "relayium_<os>_<arch>.tar.gz" and the
// node's "relayium-node_<os>_<arch>.tar.gz" — under a single checksums.txt that
// covers both. That matters: an updater that fetches the CLI archive by mistake
// still passes checksum and signature verification, so only the installed bytes
// reveal the error. It deliberately serves no checksums.txt.sig — tests using
// it must set RELAYIUM_UPDATE_ALLOW_UNSIGNED=1, since a real release signing
// key is embedded in this binary (release_pubkey.go) and would otherwise fail
// the update closed.
func fakeGithubRelease(t *testing.T, tag, nodeArchiveContent string) *httptest.Server {
	t.Helper()
	nodeAsset := nodeAssetName(runtime.GOOS, runtime.GOARCH)
	nodeArchive := tarGzSingleFile(t, nodeBinaryEntry, nodeArchiveContent)
	cliAsset := selfupdate.AssetName(runtime.GOOS, runtime.GOARCH)
	cliArchive := tarGzSingleFile(t, "relayium", cliArchiveContent)

	nodeSum := sha256.Sum256(nodeArchive)
	cliSum := sha256.Sum256(cliArchive)
	checksums := fmt.Sprintf("%x  %s\n%x  %s\n", nodeSum, nodeAsset, cliSum, cliAsset)

	mux := http.NewServeMux()
	base := "/relayium/relayium/releases/download/" + tag
	mux.HandleFunc(base+"/"+nodeAsset, func(w http.ResponseWriter, r *http.Request) {
		w.Write(nodeArchive)
	})
	mux.HandleFunc(base+"/"+cliAsset, func(w http.ResponseWriter, r *http.Request) {
		w.Write(cliArchive)
	})
	mux.HandleFunc(base+"/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, checksums)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// The node updater must install the NODE's artifact. Both archives are signed
// and checksummed in the same release, so fetching the CLI's verifies fine and
// then installs a binary that prints usage and exits 2 at /usr/local/bin/
// relayium-node — Restart=always crash-loops it, the watchdog rolls back after
// the full health window, and the good version lands in failed-versions
// forever. Assert on the installed bytes.
func TestRunUpdateWithInstallsTheNodeArtifactNotTheCLI(t *testing.T) {
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := fakeGithubRelease(t, "v9.9.9", "NEW-NODE-BINARY")
	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		APIBase: srv.URL, DownloadBase: srv.URL,
	}
	// The fake service brings the node back healthy, so the run reaches the
	// success path and the installed binary is the one left on disk.
	svc := newHealthySvc(t, dir, "9.9.9")
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 10*time.Second, 5*time.Millisecond, &out, &errBuf)

	if code != exitOK {
		t.Fatalf("code = %d, want %d (stderr=%s)", code, exitOK, errBuf.String())
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) == cliArchiveContent {
		t.Fatalf("installed the CLI archive at %s — the node updater must fetch relayium-node_<os>_<arch>.tar.gz and extract %q", bin, nodeBinaryEntry)
	}
	if string(got) != "NEW-NODE-BINARY" {
		t.Fatalf("installed binary = %q, want the node archive's %q", got, "NEW-NODE-BINARY")
	}
}

// (a) A target version already recorded as failed must be refused before
// anything is touched: no backup, no restart, binary unmodified.
func TestRunUpdateWithRefusesAlreadyFailedVersionBeforeTouchingAnything(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	var w bytes.Buffer
	recordFailed(dir, "v1.2.3", &w)

	uc := updateConfig{StateDir: dir, BinPath: bin, TargetTag: "v1.2.3", Repo: updateRepo}
	svc := &fakeSvc{}
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code == 0 {
		t.Error("code = 0, want non-zero: a previously-failed version must be refused")
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("binary = %q, want it untouched at %q", got, "OLD")
	}
	if svc.restarts != 0 {
		t.Errorf("restarts = %d, want 0: refusal must happen before any restart", svc.restarts)
	}
	if _, err := os.Stat(backupPath(bin)); err == nil {
		t.Error("a .prev backup was created even though the update was refused before touching anything")
	}
	// The above assertions alone are satisfied even if the anti-retry guard is
	// deleted entirely, because a subsequent selfupdate.Update failure (empty
	// APIBase here) leaves the same observable state. Pin down that the guard
	// itself is what fired, not just any failure path, by requiring its
	// distinctive message on stderr.
	if want := "refusing to retry " + "v1.2.3"; !bytes.Contains(errBuf.Bytes(), []byte(want)) {
		t.Errorf("stderr = %q, want it to contain %q (the anti-retry guard message)", errBuf.String(), want)
	}
}

// (b) When selfupdate.Update itself fails (here: unreachable download/API
// hosts, so no network dependency is needed), the live binary is left intact,
// a non-zero code is returned, no restart happens, and no stray .prev backup
// is left behind (finding 3).
func TestRunUpdateWithLeavesBinaryIntactWhenSelfupdateFails(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		// Port 1 on loopback: nothing listens there, so this fails fast with
		// "connection refused" — no real network access required.
		APIBase: "http://127.0.0.1:1", DownloadBase: "http://127.0.0.1:1",
	}
	svc := &fakeSvc{}
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code == 0 {
		t.Error("code = 0, want non-zero when selfupdate.Update fails")
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("binary = %q, want it untouched at %q after a failed update", got, "OLD")
	}
	if svc.restarts != 0 {
		t.Errorf("restarts = %d, want 0: a failed update must never restart the service", svc.restarts)
	}
	if _, err := os.Stat(backupPath(bin)); err == nil {
		t.Error("a .prev backup was left behind after a failed update (finding 3)")
	}
}

// (c) The restart-failure branch: selfupdate.Update succeeds (changed=true),
// but svc.Restart() fails. runUpdateWith must roll back to the previous
// binary, and — unlike the unhealthy-heartbeat path — must NOT record the
// target version as failed, since the new binary was never actually given a
// chance to prove itself.
func TestRunUpdateWithRollsBackWhenRestartFails(t *testing.T) {
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := fakeGithubRelease(t, "v9.9.9", "NEW-BINARY")
	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		APIBase: srv.URL, DownloadBase: srv.URL,
	}
	svc := &fakeSvc{failRestart: true}
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code == 0 {
		t.Error("code = 0, want non-zero when the restart itself fails")
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("binary = %q after a restart failure, want rollback to %q", got, "OLD")
	}
	if svc.restarts < 1 {
		t.Errorf("restarts = %d, want at least 1 restart attempt", svc.restarts)
	}
	if _, err := os.Stat(backupPath(bin)); err == nil {
		t.Error("backup should have been consumed by rollback (restoreBinary renames it away)")
	}
	if failedBefore(dir, "v9.9.9") {
		t.Error("v9.9.9 recorded as failed after a restart failure — it must only be recorded when the new binary was actually given a chance to heartbeat")
	}
}

// Deliberate-break check for finding 1: fakeSvc.Restart stamps the health file
// itself, simulating the OLD binary's in-flight heartbeat landing during the
// restart. If restartedAt were captured BEFORE svc.Restart() (the bug), this
// stale heartbeat would be misread as the NEW binary proving itself healthy,
// even though the new (broken) binary never heartbeats again. The correct
// ordering (restartedAt captured AFTER Restart() returns) must see this
// heartbeat as no-later-than the restart and time out instead.
// The updater replaced a binary the unit does not actually execute — the case
// `-bin`/RELAYIUM_NODE_BIN makes reachable, e.g. the node-hardening runbook's (relayium-ops) unit
// running /opt/relayium/relayium-node while the updater defaults to
// /usr/local/bin/relayium-node. The old process keeps heartbeating happily, and
// every one of those heartbeats is genuine and stamped after the restart. Only
// the recorded VERSION distinguishes this from success, so the run must roll
// back rather than report a false `ok` to central's rollout queue.
func TestRunUpdateWithRejectsFreshHeartbeatFromTheOldVersion(t *testing.T) {
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := fakeGithubRelease(t, "v9.9.9", "NEW-NODE-BINARY")
	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		APIBase: srv.URL, DownloadBase: srv.URL,
	}
	// Healthy, continuous, post-restart heartbeats — from 9.9.8, the version
	// still running.
	svc := newHealthySvc(t, dir, "9.9.8")
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 100*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code != exitNotHealthy {
		t.Fatalf("code = %d, want %d: heartbeats from 9.9.8 must not confirm an update to v9.9.9 (stdout=%s)", code, exitNotHealthy, out.String())
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("binary = %q, want rollback to %q", got, "OLD")
	}
}

func TestRunUpdateWithRejectsHeartbeatStampedDuringRestart(t *testing.T) {
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := fakeGithubRelease(t, "v9.9.9", "NEW-BROKEN")
	uc := updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: "relayium/relayium",
		APIBase: srv.URL, DownloadBase: srv.URL,
	}
	// Stamped with the TARGET version, so the only thing that can reject this
	// heartbeat is when it was written — which is exactly what this test is
	// about.
	svc := &fakeSvc{heartbeatOnRestart: dir, heartbeatVersion: "9.9.9"}
	var out, errBuf bytes.Buffer
	// The new binary never heartbeats again after the one fakeSvc.Restart
	// stamps, so a correct implementation must time out here, not succeed.
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code == 0 {
		t.Fatal("runUpdateWith reported success using a heartbeat stamped during restart — restartedAt must be captured AFTER svc.Restart() returns, not before")
	}
	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("binary = %q, want rollback to %q once the stale heartbeat was correctly rejected", got, "OLD")
	}
}
