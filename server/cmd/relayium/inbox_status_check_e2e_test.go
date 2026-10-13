//go:build !windows

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
)

func decodeStatusJSON(t *testing.T, stdout string) inboxStatusReport {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(stdout))
	var rep inboxStatusReport
	if err := dec.Decode(&rep); err != nil {
		t.Fatalf("status --json is not one JSON document: %v\n%s", err, stdout)
	}
	if dec.More() {
		t.Fatalf("status --json printed more than one document:\n%s", stdout)
	}
	return rep
}

func holdWorkerLock(t *testing.T, cfgDir string) {
	t.Helper()
	store := inboxclient.NewStore(inboxclient.StoreDir(cfgDir))
	lock, err := inboxclient.AcquireLock(store.LockPath())
	if err != nil {
		t.Fatalf("acquire worker lock: %v", err)
	}
	t.Cleanup(func() { lock.Release() })
}

func hasReason(rep inboxStatusReport, code string) bool {
	for _, r := range rep.NotReady {
		if r == code {
			return true
		}
	}
	return false
}

// --check answers 0 only for a device that can really receive, 3 with every
// reason when it cannot, and 1 when the question could not be asked. The
// default status keeps its exit contract throughout.
func TestInboxStatusCheckReadinessE2E(t *testing.T) {
	e := newInboxEnv(t)

	// Never enabled: the default status still exits 0; --check says not ready.
	if code, _, _ := e.run("status", "--config-dir", e.cfgDir); code != 0 {
		t.Fatalf("default status before enable: code %d, want 0", code)
	}
	code, stdout, _ := e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	rep := decodeStatusJSON(t, stdout)
	if code != exitInboxNotReady || rep.Ready || !hasReason(rep, "not_enabled") {
		t.Fatalf("before enable: code %d rep %+v", code, rep)
	}

	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)

	// Enabled but no worker holds the lock: not ready.
	code, stdout, _ = e.run("status", "--check", "--config-dir", e.cfgDir)
	if code != exitInboxNotReady || !strings.Contains(stdout, "NOT READY: worker_not_running") {
		t.Fatalf("no worker: code %d\n%s", code, stdout)
	}

	// A worker holds the lock but has not yet heartbeated: the server still
	// shows the device offline, so it is not ready (a lock alone is not proof).
	holdWorkerLock(t, e.cfgDir)
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	if rep = decodeStatusJSON(t, stdout); code != exitInboxNotReady || !hasReason(rep, "server_presence_not_online") {
		t.Fatalf("lock without heartbeat: code %d rep %+v", code, rep)
	}
	// The worker's heartbeat (what `inbox run` sends): ready.
	hbID, _ := e.deviceInbox()
	if _, err := e.store.TouchDeviceInboxPresence(t.Context(), hbID, e.userID, time.Now().Unix(), time.Now().Add(time.Hour).Unix(), true); err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = e.run("status", "--check", "--config-dir", e.cfgDir)
	if code != 0 || !strings.Contains(stdout, "READY: this device can receive") {
		t.Fatalf("ready device: code %d\n%s", code, stdout)
	}
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	rep = decodeStatusJSON(t, stdout)
	if code != 0 || !rep.Ready || len(rep.NotReady) != 0 || rep.ServerState == nil || !rep.ServerState.KeyHeldLocally {
		t.Fatalf("ready json: code %d rep %+v", code, rep)
	}
	// No secret in the document.
	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	keys, err := store.Keys().Load()
	if err != nil || len(keys) == 0 {
		t.Fatalf("keys: %v", err)
	}
	for _, secret := range []string{e.token, keys[0].PrivateKey, keys[0].PublicKey} {
		if strings.Contains(stdout, secret) {
			t.Fatal("status --json printed a token or key material")
		}
	}

	// Each server-side condition below leaves the server's CanReceive true
	// (a sender may still SEAL a task) while the device cannot receive
	// automatically now. Every one must turn a ready device not-ready.
	deviceID, _ := e.deviceInbox()
	ic := inboxclient.NewClient(e.ts.URL, e.token)
	ic.DeviceID = deviceID
	enrol := func(auto string, dirReady bool) {
		t.Helper()
		if _, err := ic.Enrol(t.Context(), inboxclient.EnrolRequest{
			Platform: inboxclient.Platform(), AppVersion: "test",
			ProtocolVersions: inboxclient.ProtocolVersions(), Capabilities: inboxclient.Capabilities(),
			AutoAccept: auto, ReceiveDirReady: dirReady,
		}); err != nil {
			t.Fatalf("enrol %s/%v: %v", auto, dirReady, err)
		}
	}
	expectServerReason := func(reason string) {
		t.Helper()
		code, stdout, _ := e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
		rep := decodeStatusJSON(t, stdout)
		if code != exitInboxNotReady || rep.Ready || !hasReason(rep, reason) {
			t.Fatalf("want not-ready %q: code %d rep %+v", reason, code, rep)
		}
		if rep.ServerState == nil || !rep.ServerState.CanReceive {
			t.Fatalf("fixture premise: the server should still report CanReceive=true: %+v", rep.ServerState)
		}
	}
	enrol("ask", true)
	expectServerReason("server_policy_not_auto")
	enrol("auto", false)
	expectServerReason("server_receive_dir_not_ready")
	enrol("auto", true)
	if _, err := e.store.ExpireDeviceInboxPresence(t.Context(), deviceID, e.userID, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	expectServerReason("server_presence_not_online")
	// Back to ready: a fresh heartbeat with a usable directory.
	if _, err := e.store.TouchDeviceInboxPresence(t.Context(), deviceID, e.userID, time.Now().Unix(), time.Now().Add(time.Hour).Unix(), true); err != nil {
		t.Fatal(err)
	}
	if code, stdout, _ := e.run("status", "--check", "--config-dir", e.cfgDir); code != 0 {
		t.Fatalf("restored ready state: code %d\n%s", code, stdout)
	}

	// Paused: not ready, and the default status still exits 0.
	e.mustRun("pause", "--config-dir", e.cfgDir)
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	if rep = decodeStatusJSON(t, stdout); code != exitInboxNotReady || !hasReason(rep, "paused") {
		t.Fatalf("paused: code %d rep %+v", code, rep)
	}
	if code, _, _ := e.run("status", "--config-dir", e.cfgDir); code != 0 {
		t.Fatalf("default status while paused: code %d, want 0 (unchanged contract)", code)
	}
	e.mustRun("resume", "--config-dir", e.cfgDir)

	// Receive directory unusable.
	if err := os.Chmod(e.receive, 0o500); err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	_ = os.Chmod(e.receive, 0o700)
	if rep = decodeStatusJSON(t, stdout); code != exitInboxNotReady || !hasReason(rep, "receive_dir_unusable") {
		t.Fatalf("unusable dir: code %d rep %+v", code, rep)
	}

	// The private half of the active key is not held here.
	keysPath := filepath.Join(inboxclient.StoreDir(e.cfgDir))
	entries, _ := os.ReadDir(keysPath)
	moved := ""
	for _, en := range entries {
		if strings.Contains(en.Name(), "key") {
			moved = filepath.Join(keysPath, en.Name())
			if err := os.Rename(moved, moved+".aside"); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if moved == "" {
		t.Fatalf("could not find the key file in %v", entries)
	}
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	rep = decodeStatusJSON(t, stdout)
	if code != exitInboxNotReady || !(hasReason(rep, "active_key_not_held") || hasReason(rep, "keys_unreadable")) {
		t.Fatalf("missing key: code %d rep %+v", code, rep)
	}
	if err := os.Rename(moved+".aside", moved); err != nil {
		t.Fatal(err)
	}

	// Revoked on the server.
	deviceID, in := e.deviceInbox()
	req, _ := http.NewRequest(http.MethodPost,
		e.ts.URL+"/api/devices/"+deviceID+"/inbox/keys/"+in.Key.ID+"/revoke", nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.ts.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke: %v %v", resp, err)
	}
	resp.Body.Close()
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	rep = decodeStatusJSON(t, stdout)
	if code != exitInboxNotReady || rep.Ready {
		t.Fatalf("revoked: code %d rep %+v", code, rep)
	}

	// Query failures are 1, never 3, and --json still prints one document.
	noCreds := t.TempDir()
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", noCreds)
	if rep = decodeStatusJSON(t, stdout); code != 1 || rep.Error != "not_logged_in" || rep.Ready {
		t.Fatalf("no credential: code %d rep %+v", code, rep)
	}
	e.ts.Close()
	code, stdout, _ = e.run("status", "--check", "--json", "--config-dir", e.cfgDir)
	if rep = decodeStatusJSON(t, stdout); code != 1 || rep.Error != "server_unreachable" || rep.Ready {
		t.Fatalf("server down: code %d rep %+v", code, rep)
	}
	// Without --check the default contract is unchanged: 1 on a failed query.
	if code, _, _ := e.run("status", "--config-dir", e.cfgDir); code != 1 {
		t.Fatalf("default status with server down: code %d, want 1", code)
	}
}

// A negotiated protocol or capability this build does not speak is not ready,
// whatever else holds.
func TestInboxReadinessRequiresSupportedProtocol(t *testing.T) {
	base := func() inboxStatusReport {
		var r inboxStatusReport
		r.Local.Configured, r.Local.Enabled, r.Local.ReceiveDirUsable, r.Local.Worker = true, true, true, "running"
		r.ServerState = &inboxServerStatus{Enrolled: true, CanReceive: true, Presence: inbox.PresenceOnline,
			AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true, ProtocolVersion: inboxclient.ProtocolVersions()[0],
			ReceiveCapability: inboxclient.Capabilities()[0], KeyPublished: true, KeyHeldLocally: true}
		return r
	}
	r := base()
	r.computeReadiness()
	if !r.Ready {
		t.Fatalf("baseline should be ready: %+v", r.NotReady)
	}
	r = base()
	r.ServerState.ProtocolVersion = 9999
	r.computeReadiness()
	if r.Ready || !hasReason(r, "protocol_unsupported") {
		t.Fatalf("unknown protocol: %+v", r.NotReady)
	}
	r = base()
	r.ServerState.ReceiveCapability = "inbox.unknown.v9"
	r.computeReadiness()
	if r.Ready || !hasReason(r, "protocol_unsupported") {
		t.Fatalf("unknown capability: %+v", r.NotReady)
	}
}
