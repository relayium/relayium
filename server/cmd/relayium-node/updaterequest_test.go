package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The node process is UNPRIVILEGED and must stay that way. Everything it is
// allowed to do with central's "go and check now" hint is touch one file in its
// own runtime directory; the root updater's path unit notices that file, and
// the updater then re-asks central itself and verifies the release signature.
// These tests pin the narrowness of that channel, because it is the only new
// thing the low-privilege service gained.

func TestRequestUpdateCheckWritesTheRequestFile(t *testing.T) {
	dir := t.TempDir()
	ur := &updateRequester{dir: dir}
	now := time.Unix(1_000_000, 0)

	wrote, err := ur.request(now)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if !wrote {
		t.Fatal("request reported that it wrote nothing")
	}
	fi, err := os.Stat(updateRequestPath(dir))
	if err != nil {
		t.Fatalf("request file: %v", err)
	}
	// Owner-only: the runtime directory is the node user's, and nothing else on
	// the host has any business reading or forging this.
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("request file mode = %04o, want 0600", perm)
	}
	// EMPTY, and this is the security property rather than tidiness: the
	// unprivileged process must not be able to hand root a version, a path or a
	// URL. The request says "ask central", nothing more — the root updater
	// re-queries central for the version itself.
	b, err := os.ReadFile(updateRequestPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if len(bytes.TrimSpace(b)) != 0 {
		t.Errorf("request file carries content %q; it must carry nothing actionable", b)
	}
}

// A host that has not been re-provisioned has no runtime directory and no path
// unit. The request must then be a silent no-op: it must NOT create the
// directory (the node runs unprivileged and a wrongly-owned /run entry is its
// own outage), and it must NOT fail — the systemd timer is the fallback, and a
// missing acceleration path is not an error.
func TestRequestUpdateCheckIsANoOpWithoutARuntimeDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-provisioned")
	ur := &updateRequester{dir: missing}

	wrote, err := ur.request(time.Unix(1_000_000, 0))
	if err != nil {
		t.Fatalf("request must not fail when the runtime dir is absent: %v", err)
	}
	if wrote {
		t.Fatal("request claimed to write into a directory that does not exist")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("request created the runtime directory: %v", err)
	}
}

// An empty dir is the "no runtime directory configured at all" case, and must
// behave the same way rather than writing into the process's cwd.
func TestRequestUpdateCheckIsANoOpWithoutAConfiguredDir(t *testing.T) {
	ur := &updateRequester{}
	wrote, err := ur.request(time.Unix(1_000_000, 0))
	if err != nil || wrote {
		t.Fatalf("request with no dir: wrote=%v err=%v, want false/nil", wrote, err)
	}
}

// A pending request is not re-made. Central hints on every heartbeat while it is
// this node's turn (every 30s), and the file only re-triggers the path unit on
// the transition into existence — so rewriting it neither helps nor is free.
func TestRequestUpdateCheckDoesNotRepeatWhileOneIsPending(t *testing.T) {
	dir := t.TempDir()
	ur := &updateRequester{dir: dir}
	now := time.Unix(1_000_000, 0)

	if wrote, _ := ur.request(now); !wrote {
		t.Fatal("first request wrote nothing")
	}
	// Far past any rate limit, but the earlier request has not been consumed.
	if wrote, err := ur.request(now.Add(24 * time.Hour)); wrote || err != nil {
		t.Fatalf("second request while one is pending: wrote=%v err=%v, want false/nil", wrote, err)
	}
}

// ...and once it HAS been consumed, requests are still rate-limited, so a
// compromised or looping node cannot spin the root updater as fast as it can
// heartbeat.
func TestRequestUpdateCheckIsRateLimited(t *testing.T) {
	dir := t.TempDir()
	ur := &updateRequester{dir: dir}
	now := time.Unix(1_000_000, 0)

	if wrote, _ := ur.request(now); !wrote {
		t.Fatal("first request wrote nothing")
	}
	consumeUpdateRequest(dir, &bytes.Buffer{})

	if wrote, _ := ur.request(now.Add(updateRequestMinInterval - time.Second)); wrote {
		t.Fatal("a second request landed inside the minimum interval")
	}
	if wrote, _ := ur.request(now.Add(updateRequestMinInterval + time.Second)); !wrote {
		t.Fatal("a request after the minimum interval was refused")
	}
}

// The root updater consumes the request when it starts. That is what makes the
// path unit's trigger IDEMPOTENT: systemd re-arms a PathExists trigger as soon
// as the unit deactivates, so a request left behind would start the updater
// again, forever.
func TestConsumeUpdateRequestIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	var log bytes.Buffer

	// Nothing pending: the normal case (the timer, not the path unit, started
	// this run) and not an error.
	consumeUpdateRequest(dir, &log)
	if log.Len() != 0 {
		t.Errorf("consuming a missing request complained: %q", log.String())
	}

	ur := &updateRequester{dir: dir}
	if wrote, _ := ur.request(time.Unix(1_000_000, 0)); !wrote {
		t.Fatal("request wrote nothing")
	}
	consumeUpdateRequest(dir, &log)
	if _, err := os.Stat(updateRequestPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("request file survived consumption: %v", err)
	}
	consumeUpdateRequest(dir, &log)
	if log.Len() != 0 {
		t.Errorf("consuming twice complained: %q", log.String())
	}
}

// THE LOW-PRIVILEGE BOUNDARY, from the other side. consumeUpdateRequest runs as
// ROOT, and the path it removes lives in a directory the UNPRIVILEGED node owns
// and can write. If a compromised node replaced the marker with a symlink, a
// root process that followed it would delete an arbitrary file — so this pins
// that the removal unlinks the LINK and leaves its target alone.
func TestConsumeUpdateRequestDoesNotFollowASymlink(t *testing.T) {
	dir := t.TempDir()
	victimDir := t.TempDir()
	victim := filepath.Join(victimDir, "important-root-owned-file")
	if err := os.WriteFile(victim, []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, updateRequestPath(dir)); err != nil {
		t.Fatal(err)
	}

	consumeUpdateRequest(dir, &bytes.Buffer{})

	if _, err := os.Lstat(updateRequestPath(dir)); !os.IsNotExist(err) {
		t.Errorf("the symlink itself was not removed: %v", err)
	}
	b, err := os.ReadFile(victim)
	if err != nil || string(b) != "must survive" {
		t.Fatalf("root followed the node's symlink and destroyed its target: %q (%v)", b, err)
	}
}

// The wire half: an older central omits the key entirely, and the node must read
// that as "no hint" rather than as anything else.
func TestHeartbeatRespDecodesTheUpdateHint(t *testing.T) {
	var absent heartbeatResp
	if err := json.Unmarshal([]byte(`{"ok":true,"heartbeatInterval":30}`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.UpdateCheckNow {
		t.Fatal("a response without the key decoded as a hint")
	}
	var present heartbeatResp
	if err := json.Unmarshal([]byte(`{"ok":true,"updateCheckNow":true}`), &present); err != nil {
		t.Fatal(err)
	}
	if !present.UpdateCheckNow {
		t.Fatal("a response with the key did not decode as a hint")
	}
}

// The wiring, and the one thing it must NOT do. A hint produces a request file
// and nothing else: no download, no install, no binary touched. The node process
// has no code path to install and this pins that the hint did not add one.
func TestUpdateHintOnlyEverWritesTheRequestFile(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(t.TempDir(), "relayium-node")
	if err := os.WriteFile(bin, []byte("original binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	ur := &updateRequester{dir: dir}
	now := time.Unix(1_000_000, 0)

	// No hint: nothing at all happens.
	handleUpdateHint(heartbeatResp{OK: true}, ur, now)
	if _, err := os.Stat(updateRequestPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("a response with no hint produced a request: %v", err)
	}

	handleUpdateHint(heartbeatResp{OK: true, UpdateCheckNow: true}, ur, now)
	if _, err := os.Stat(updateRequestPath(dir)); err != nil {
		t.Fatalf("a hinted response produced no request: %v", err)
	}
	// The whole runtime dir must contain exactly the request marker: the
	// low-privilege process gained one file, not a work area.
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 1 || ents[0].Name() != updateRequestFile {
		names := make([]string, 0, len(ents))
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Fatalf("runtime dir holds %v, want exactly [%s]", names, updateRequestFile)
	}
	b, err := os.ReadFile(bin)
	if err != nil || string(b) != "original binary" {
		t.Fatalf("the hint touched the node binary: %q (%v)", b, err)
	}
}

// A nil requester is the "no runtime dir resolved" configuration, and a
// heartbeat must survive it.
func TestUpdateHintToleratesNoRequester(t *testing.T) {
	handleUpdateHint(heartbeatResp{OK: true, UpdateCheckNow: true}, nil, time.Unix(1, 0))
}
