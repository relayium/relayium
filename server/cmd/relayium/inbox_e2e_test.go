package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
)

// End-to-end Device Inbox, against the REAL account.Service.
//
// The fake-central tests in internal/inboxclient prove the worker survives
// servers that misbehave. This file proves the opposite thing, which no fake
// can: that the wire contract is right. A real device-code login mints a real
// bearer; `relayium inbox enable` enrols and publishes a real X25519 key through
// the real handlers; a real Stored Object is uploaded with the real client-side
// encryption; a real task is queued with the content key sealed to the published
// key; and `relayium inbox run` claims it, streams the real ciphertext, and
// commits the real plaintext to disk.
//
// If the client and the server ever disagree about a field name, an encoding, an
// authorization rule or a state transition, it fails here.

// inboxEnv is a fully wired CLI environment: a real server, a real logged-in
// config directory, and a real receive directory.
type inboxEnv struct {
	t        *testing.T
	ts       *httptest.Server
	svc      *account.Service
	store    *account.SQLiteStore
	userID   string
	token    string
	cfgDir   string
	receive  string
	deviceID string
}

func newInboxEnv(t *testing.T) *inboxEnv {
	t.Helper()
	ts, svc, store := newE2EService(t)
	u, err := store.UpsertUserByEmail(context.Background(), "inbox@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	token := cliToken(t, ts, svc, u.ID)

	cfgDir := t.TempDir()
	if err := cloud.Save(cfgDir, cloud.Creds{
		Server: ts.URL, AccessToken: token, AccountEmail: "inbox@example.com",
	}); err != nil {
		t.Fatalf("save creds: %v", err)
	}
	return &inboxEnv{t: t, ts: ts, svc: svc, store: store, userID: u.ID, token: token,
		cfgDir: cfgDir, receive: t.TempDir()}
}

// run invokes the CLI exactly as a user would, through the top-level dispatcher.
func (e *inboxEnv) run(args ...string) (code int, stdout, stderr string) {
	e.t.Helper()
	var out, errBuf bytes.Buffer
	code = Run(append([]string{"inbox"}, args...), &out, &errBuf)
	return code, out.String(), errBuf.String()
}

func (e *inboxEnv) mustRun(args ...string) (stdout, stderr string) {
	e.t.Helper()
	code, out, errOut := e.run(args...)
	if code != 0 {
		e.t.Fatalf("relayium inbox %s exited %d\nstdout:\n%s\nstderr:\n%s",
			strings.Join(args, " "), code, out, errOut)
	}
	return out, errOut
}

// deviceInbox reads this device's enrolment through the real API.
func (e *inboxEnv) deviceInbox() (id string, in *inboxclient.InboxView) {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.ts.URL+"/api/devices", nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		e.t.Fatalf("list devices: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Devices []inboxclient.Device `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		e.t.Fatalf("decode devices: %v", err)
	}
	for _, d := range out.Devices {
		if d.Current {
			return d.ID, d.Inbox
		}
	}
	e.t.Fatal("no device row is marked Current for this bearer")
	return "", nil
}

// sendFile does exactly what a SENDER does: encrypt and upload a Stored Object
// with the existing client-side crypto, seal that object's content key to the
// target device's published public key, and queue a task.
func (e *inboxEnv) sendFile(name string, data []byte) (taskID string) {
	e.t.Helper()
	deviceID, in := e.deviceInbox()
	if in == nil || in.Key == nil {
		e.t.Fatal("the device has no published public key; enable the inbox first")
	}

	src := filepath.Join(e.t.TempDir(), name)
	if err := os.MkdirAll(filepath.Dir(src), 0o700); err != nil {
		e.t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(src, data, 0o600); err != nil {
		e.t.Fatalf("write source: %v", err)
	}
	c := cloud.NewClient(e.ts.URL)
	c.Token = e.token
	// A plain upload is unlimited-until-TTL, which is what a task may reference:
	// a limited/burn object could have its last slot spent by an unrelated public
	// reader, stranding a delivery that was promised to be reliable.
	id, keyB64, _, err := c.Upload(context.Background(), []string{src}, cloud.UploadOpts{})
	if err != nil {
		e.t.Fatalf("upload: %v", err)
	}

	contentKey, err := base64.RawURLEncoding.DecodeString(keyB64)
	if err != nil {
		e.t.Fatalf("decode content key: %v", err)
	}
	pubRaw, err := base64.RawURLEncoding.Strict().DecodeString(in.Key.PublicKey)
	if err != nil {
		e.t.Fatalf("decode device public key: %v", err)
	}
	var pub [32]byte
	copy(pub[:], pubRaw)
	sealed, err := box.SealAnonymous(nil, contentKey, &pub, rand.Reader)
	if err != nil {
		e.t.Fatalf("seal: %v", err)
	}

	body, _ := json.Marshal(map[string]any{
		"idempotencyKey":      "e2e-" + id,
		"storedFileId":        id,
		"wrapAlgorithm":       inbox.KeyAlgX25519SealedBoxV1,
		"wrappedKey":          base64.RawURLEncoding.EncodeToString(sealed),
		"targetKeyId":         in.Key.ID,
		"targetKeyGeneration": in.Key.Generation,
	})
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+"/api/devices/"+deviceID+"/inbox/tasks", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		e.t.Fatalf("create task: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io_ReadAll(resp)
		e.t.Fatalf("create task: status %d: %s", resp.StatusCode, b)
	}
	var created struct {
		Task struct {
			ID string `json:"ID"`
		} `json:"task"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		e.t.Fatalf("decode task: %v", err)
	}
	return created.Task.ID
}

func io_ReadAll(resp *http.Response) (string, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(resp.Body)
	return b.String(), err
}

// taskState reads a task back through the account API.
func (e *inboxEnv) taskState(deviceID, taskID string) (state, errorCode string, savedAt int64) {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.ts.URL+"/api/devices/"+deviceID+"/inbox/tasks/"+taskID, nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		e.t.Fatalf("get task: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Task struct {
			State     string `json:"State"`
			ErrorCode string `json:"ErrorCode"`
			SavedAt   int64  `json:"SavedAt"`
		} `json:"task"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		e.t.Fatalf("decode task: %v", err)
	}
	return out.Task.State, out.Task.ErrorCode, out.Task.SavedAt
}

// TestInboxEndToEndAgainstTheRealServer is the whole Phase 1C contract in one
// pass: enable, enrol, publish a key, queue a real encrypted delivery, run the
// worker once, and check the plaintext landed and central recorded `saved`.
func TestInboxEndToEndAgainstTheRealServer(t *testing.T) {
	e := newInboxEnv(t)

	stdout, _ := e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	if !strings.Contains(stdout, "Device Inbox enabled") {
		t.Fatalf("enable output:\n%s", stdout)
	}
	deviceID, in := e.deviceInbox()
	if in == nil || !in.CanReceive {
		t.Fatalf("after enable the device is not a valid target: %+v", in)
	}
	if in.AutoAccept != inbox.AutoAcceptAuto {
		t.Fatalf("auto-accept policy = %q, want %q", in.AutoAccept, inbox.AutoAcceptAuto)
	}
	if !in.ReceiveDirReady {
		t.Fatal("the enrolment does not report a usable receive directory")
	}
	if in.Key == nil || in.Key.Algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		t.Fatalf("no usable published key: %+v", in.Key)
	}

	payload := []byte(strings.Repeat("end to end device inbox\n", 20000)) // multi-frame
	taskID := e.sendFile("delivery.txt", payload)
	if state, _, _ := e.taskState(deviceID, taskID); state != inbox.TaskQueued {
		t.Fatalf("a task for an auto-accept device with a ready directory started as %q, want queued", state)
	}

	e.mustRun("run", "--config-dir", e.cfgDir, "--once")

	got, err := os.ReadFile(filepath.Join(e.receive, "delivery.txt"))
	if err != nil {
		t.Fatalf("the delivery did not land: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("delivered %d bytes, sent %d", len(got), len(payload))
	}
	fi, err := os.Lstat(filepath.Join(e.receive, "delivery.txt"))
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if fi.Mode().Perm()&0o111 != 0 {
		t.Fatalf("the received file has mode %v; received files must never be executable", fi.Mode())
	}

	state, code, savedAt := e.taskState(deviceID, taskID)
	if state != inbox.TaskSaved {
		t.Fatalf("task state = %q/%q, want saved", state, code)
	}
	if savedAt == 0 {
		t.Fatal("SavedAt is zero on a saved task: `saved` must record when the commit happened")
	}
}

// TestInboxEndToEndIsIdempotentAcrossARerun: running the worker again must not
// deliver the file a second time, and must not fabricate a second task.
func TestInboxEndToEndIsIdempotentAcrossARerun(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	e.sendFile("once.txt", []byte("only once"))
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")

	entries, err := os.ReadDir(e.receive)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var files []string
	for _, en := range entries {
		if en.Name() == ".relayium-incoming" {
			continue
		}
		files = append(files, en.Name())
	}
	if len(files) != 1 || files[0] != "once.txt" {
		t.Fatalf("receive directory holds %v, want exactly [once.txt]", files)
	}
}

// TestInboxEndToEndNeverOverwritesAnExistingFile drives the PRD §9 rule through
// the real server: the user's own file survives untouched and the delivery gets
// a deterministic safe name.
func TestInboxEndToEndNeverOverwritesAnExistingFile(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	mine := filepath.Join(e.receive, "notes.txt")
	if err := os.WriteFile(mine, []byte("MY OWN NOTES"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	e.sendFile("notes.txt", []byte("incoming"))
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")

	if got, _ := os.ReadFile(mine); string(got) != "MY OWN NOTES" {
		t.Fatalf("the existing file was modified: %q", got)
	}
	got, err := os.ReadFile(filepath.Join(e.receive, "notes (2).txt"))
	if err != nil || string(got) != "incoming" {
		t.Fatalf("collision rename missing or wrong: %q %v", got, err)
	}
}

// TestInboxDisableClearsTheServerBeforeDeletingKeys is the disable ordering
// requirement, checked through the real API: the enrolment and the key history
// are gone server-side, the local keys are gone, and unfinished tasks were
// terminalised rather than left to look deliverable.
func TestInboxDisableClearsTheServerBeforeDeletingKeys(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	deviceID, _ := e.deviceInbox()
	taskID := e.sendFile("pending.txt", []byte("queued but never claimed"))

	stdout, _ := e.mustRun("disable", "--config-dir", e.cfgDir)
	for _, want := range []string{"automatic receive is off", "server inbox cleared", "private keys and task receipts deleted"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("disable output does not report %q:\n%s", want, stdout)
		}
	}

	if _, in := e.deviceInbox(); in != nil {
		t.Fatalf("the enrolment survived disable: %+v", in)
	}
	state, code, _ := e.taskState(deviceID, taskID)
	if state != inbox.TaskRevoked {
		t.Fatalf("an unfinished task is %q/%q after disable; it must be terminalised so the sender is told the truth", state, code)
	}

	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	keys, err := store.Keys().Load()
	if err != nil || len(keys) != 0 {
		t.Fatalf("local private keys survived a confirmed disable: %d (%v)", len(keys), err)
	}
	if _, found, err := store.LoadConfig(); found || err != nil {
		t.Fatalf("the configuration survived disable: found=%v err=%v", found, err)
	}
	// And the credential itself is untouched: disable is not logout.
	if _, ok, err := cloud.Load(e.cfgDir); !ok || err != nil {
		t.Fatalf("disable destroyed the login credential: ok=%v err=%v", ok, err)
	}
}

// TestInboxDisableKeepsKeysWhenTheServerCannotBeReached. Deleting the private
// keys before central confirms would destroy the only thing that can decrypt
// tasks still sitting in the queue — a reversible "turn it off" becoming silent,
// permanent data loss.
func TestInboxDisableKeepsKeysWhenTheServerCannotBeReached(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	e.ts.Close() // the server is gone

	code, stdout, stderr := e.run("disable", "--config-dir", e.cfgDir)
	if code == 0 {
		t.Fatalf("a failed server clear reported success:\n%s\n%s", stdout, stderr)
	}
	if !strings.Contains(stderr, "NOT cleared") {
		t.Fatalf("stderr does not say the server inbox was not cleared:\n%s", stderr)
	}
	if !strings.Contains(stderr, "private keys were kept") {
		t.Fatalf("stderr does not explain that the keys were kept:\n%s", stderr)
	}

	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	keys, err := store.Keys().Load()
	if err != nil || len(keys) == 0 {
		t.Fatalf("the private keys were destroyed despite the server clear failing: %d (%v)", len(keys), err)
	}
	// The local half still took effect: this machine stops receiving immediately.
	cfg, found, err := store.LoadConfig()
	if err != nil || !found || cfg.Enabled {
		t.Fatalf("automatic receive was not turned off locally: %+v (found=%v err=%v)", cfg, found, err)
	}
}

func TestInboxDisableWaitsForTheWorkerBeforeDestroyingState(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	lock, err := inboxclient.AcquireLock(store.LockPath())
	if err != nil {
		t.Fatalf("hold worker lock: %v", err)
	}

	code, _, stderr := e.run("disable", "--config-dir", e.cfgDir)
	if code == 0 || !strings.Contains(stderr, "still running") {
		t.Fatalf("disable raced a running worker: code=%d stderr=%q", code, stderr)
	}
	if _, in := e.deviceInbox(); in == nil {
		t.Fatal("disable cleared the server while the worker lock was held")
	}
	if keys, err := store.Keys().Load(); err != nil || len(keys) == 0 {
		t.Fatalf("disable destroyed keys while the worker lock was held: %d, %v", len(keys), err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}

	// The first call durably switched local receive off. Once the worker has
	// stopped, retry completes the remote clear and key destruction.
	e.mustRun("disable", "--config-dir", e.cfgDir)
	if _, in := e.deviceInbox(); in != nil {
		t.Fatal("retry after worker stop did not clear the enrolment")
	}
}

// TestInboxLocalOnlyDisableIsHonestAboutWhatItDidNotDo.
func TestInboxLocalOnlyDisableIsHonestAboutWhatItDidNotDo(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	stdout, _ := e.mustRun("disable", "--local-only", "--config-dir", e.cfgDir)
	if !strings.Contains(stdout, "server inbox was NOT cleared") {
		t.Fatalf("--local-only did not say the server was untouched:\n%s", stdout)
	}
	if _, in := e.deviceInbox(); in == nil {
		t.Fatal("--local-only cleared the server enrolment")
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	if keys, err := store.Keys().Load(); err != nil || len(keys) == 0 {
		t.Fatalf("--local-only destroyed private keys: %d (%v)", len(keys), err)
	}
}

// TestInboxPauseAndResumeAreDurableAndLocal. Pause must survive a process exit,
// must not touch the server, and must actually stop deliveries.
func TestInboxPauseAndResumeAreDurableAndLocal(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	deviceID, before := e.deviceInbox()
	e.sendFile("paused.txt", []byte("wait for me"))

	e.mustRun("pause", "--config-dir", e.cfgDir)
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")
	if _, err := os.Stat(filepath.Join(e.receive, "paused.txt")); err == nil {
		t.Fatal("a paused worker delivered a file")
	}
	// Pause is LOCAL: the enrolment, the key and the policy are untouched, which
	// is what makes resume free.
	_, after := e.deviceInbox()
	if after == nil || after.AutoAccept != before.AutoAccept || after.Key == nil || after.Key.ID != before.Key.ID {
		t.Fatalf("pause changed server state: before %+v after %+v", before, after)
	}

	e.mustRun("resume", "--config-dir", e.cfgDir)
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")
	if got, err := os.ReadFile(filepath.Join(e.receive, "paused.txt")); err != nil || string(got) != "wait for me" {
		t.Fatalf("resume did not deliver the queued file: %q %v", got, err)
	}
	_ = deviceID
}

// TestInboxStatusReportsTruthWithoutSecrets. `status` is the command an operator
// runs when something is wrong, so it must be accurate about every layer — and
// must never print a private key.
func TestInboxStatusReportsTruthWithoutSecrets(t *testing.T) {
	e := newInboxEnv(t)

	// Before enabling: honest about being off, and it says how to turn it on.
	_, stdout, _ := e.run("status", "--config-dir", e.cfgDir)
	if !strings.Contains(stdout, "automatic receive: off") || !strings.Contains(stdout, "inbox enable --dir") {
		t.Fatalf("status before enable:\n%s", stdout)
	}

	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	_, stdout, _ = e.run("status", "--config-dir", e.cfgDir)
	for _, want := range []string{
		"automatic receive: on", e.receive, "directory status:  usable",
		"worker:            not running", "inbox@example.com",
		"1 private key(s) held locally", "auto-accept \"auto\"",
		"private half held locally: true",
	} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("status does not report %q:\n%s", want, stdout)
		}
	}

	// No key material, in either direction.
	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	keys, err := store.Keys().Load()
	if err != nil || len(keys) != 1 {
		t.Fatalf("keys: %v %v", keys, err)
	}
	if strings.Contains(stdout, keys[0].PrivateKey) {
		t.Fatal("status printed the device PRIVATE key")
	}
	if strings.Contains(stdout, keys[0].PublicKey) {
		t.Fatal("status printed raw key material; a generation number is what an operator can act on")
	}
	if strings.Contains(stdout, e.token) {
		t.Fatal("status printed the bearer token")
	}

	// Paused is reported as such rather than as plain "on".
	e.mustRun("pause", "--config-dir", e.cfgDir)
	_, stdout, _ = e.run("status", "--config-dir", e.cfgDir)
	if !strings.Contains(stdout, "PAUSED") {
		t.Fatalf("status does not surface the paused state:\n%s", stdout)
	}
}

// TestInboxEnableRequiresAnExplicitUsableDirectory. Automatic receive is
// default-off and the directory is the opt-in; a missing --dir, a non-existent
// path and a file must all be refused BEFORE anything is announced to central.
func TestInboxEnableRequiresAnExplicitUsableDirectory(t *testing.T) {
	e := newInboxEnv(t)

	if code, _, stderr := e.run("enable", "--config-dir", e.cfgDir); code == 0 {
		t.Fatal("enable succeeded without --dir")
	} else if !strings.Contains(stderr, "--dir") {
		t.Fatalf("stderr does not name the missing flag:\n%s", stderr)
	}
	if code, _, _ := e.run("enable", "--dir", filepath.Join(e.receive, "nope"), "--config-dir", e.cfgDir); code == 0 {
		t.Fatal("enable succeeded with a non-existent directory")
	}
	file := filepath.Join(e.receive, "afile")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if code, _, _ := e.run("enable", "--dir", file, "--config-dir", e.cfgDir); code == 0 {
		t.Fatal("enable succeeded with a file as the receive directory")
	}
	// Nothing may have been enrolled by any of those failures.
	if _, in := e.deviceInbox(); in != nil {
		t.Fatalf("a failed enable still enrolled the device: %+v", in)
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(e.cfgDir))
	if _, found, _ := store.LoadConfig(); found {
		t.Fatal("a failed enable still wrote a configuration")
	}
}

// TestInboxRunRefusesWithoutTheOptIn and without a login.
func TestInboxRunRefusesWithoutTheOptIn(t *testing.T) {
	e := newInboxEnv(t)
	code, _, stderr := e.run("run", "--config-dir", e.cfgDir, "--once")
	if code == 0 {
		t.Fatal("the worker ran without an explicit opt-in")
	}
	if !strings.Contains(stderr, "inbox enable --dir") {
		t.Fatalf("stderr does not tell the operator how to opt in:\n%s", stderr)
	}

	// And with no credential at all, every command says so rather than failing
	// with something an operator has to decode.
	noCreds := t.TempDir()
	code, stdout, _ := e.run("status", "--config-dir", noCreds)
	if code == 0 {
		t.Fatal("status reported success with no credential")
	}
	if !strings.Contains(stdout, "not logged in") {
		t.Fatalf("status with no credential does not say so:\n%s", stdout)
	}
	code, _, stderr = e.run("enable", "--dir", e.receive, "--config-dir", noCreds)
	if code == 0 {
		t.Fatal("enable succeeded with no credential")
	}
	if !strings.Contains(stderr, "relayium login") {
		t.Fatalf("enable with no credential does not point at login:\n%s", stderr)
	}
}

// TestInboxServicePrintsAUnitForThisMachine: no hardcoded developer path, the
// real binary, the real directories, and no claim that a rootless install can
// create a system service.
func TestInboxServicePrintsAUnitForThisMachine(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)

	for _, kind := range []string{"systemd-user", "systemd-system", "launchd"} {
		stdout, stderr := e.mustRun("service", kind, "--config-dir", e.cfgDir)
		if !strings.Contains(stdout, e.cfgDir) {
			t.Fatalf("%s definition does not name this machine's config dir:\n%s", kind, stdout)
		}
		// Only the systemd units confine the filesystem, so only they have to
		// name the receive directory (in ReadWritePaths); launchd has no
		// equivalent and inventing one would be noise.
		if strings.HasPrefix(kind, "systemd") && !strings.Contains(stdout, e.receive) {
			t.Fatalf("%s definition does not grant write access to this machine's receive dir:\n%s", kind, stdout)
		}
		if strings.Contains(stdout, "@RELAYIUM_BIN@") || strings.Contains(stdout, "@CONFIG_DIR@") {
			t.Fatalf("%s definition still contains placeholders:\n%s", kind, stdout)
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatalf("executable: %v", err)
		}
		if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = resolved
		}
		if !strings.Contains(stdout, exe) {
			t.Fatalf("%s definition does not name the running executable %q:\n%s", kind, exe, stdout)
		}
		if stderr == "" {
			t.Fatalf("%s printed no install instructions", kind)
		}
	}
	sysOut, sysInstr := e.mustRun("service", "systemd-system", "--config-dir", e.cfgDir)
	if !strings.Contains(sysInstr, "sudo") {
		t.Fatalf("the system-wide instructions never mention sudo:\n%s", sysInstr)
	}
	if strings.Contains(sysOut, "User=root") {
		t.Fatal("the system unit runs as root")
	}

	// Without an explicit --config-dir, a SYSTEM unit must not point at the
	// invoking operator's home: the dedicated service account cannot read it, so
	// the unit would start and immediately fail to find a credential.
	defaultSysOut, _ := e.mustRun("service", "systemd-system", "--dir", "/srv/incoming")
	if !strings.Contains(defaultSysOut, systemServiceConfigDir) {
		t.Fatalf("the default system unit does not use %s:\n%s", systemServiceConfigDir, defaultSysOut)
	}
	if home, err := os.UserHomeDir(); err == nil && strings.Contains(defaultSysOut, filepath.Join(home, ".config", "relayium")) {
		t.Fatalf("the default system unit points at the invoking user's home:\n%s", defaultSysOut)
	}

	notes, _ := e.mustRun("service", "container", "--config-dir", e.cfgDir)
	if !strings.Contains(notes, "inbox") || !strings.Contains(strings.ToLower(notes), "no official") {
		t.Fatalf("container notes:\n%s", notes)
	}
	if code, _, _ := e.run("service", "sysvinit", "--config-dir", e.cfgDir); code == 0 {
		t.Fatal("an unknown service kind was accepted")
	}
}

// TestInboxSurvivesLogoutAndReLogin is the credential-change case the PRD asks
// about. A new login mints a DIFFERENT device row, so the old enrolment's device
// id no longer matches. The worker must refuse and say what to do, rather than
// polling an id this credential does not authenticate as.
func TestInboxSurvivesLogoutAndReLogin(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)

	// A second device-code login: a new device row, a new bearer.
	newToken := cliToken(t, e.ts, e.svc, e.userID)
	if err := cloud.Save(e.cfgDir, cloud.Creds{
		Server: e.ts.URL, AccessToken: newToken, AccountEmail: "inbox@example.com",
	}); err != nil {
		t.Fatalf("save creds: %v", err)
	}

	code, _, stderr := e.run("run", "--config-dir", e.cfgDir, "--once")
	if code == 0 {
		t.Fatal("the worker ran against a device id this credential does not authenticate as")
	}
	if !strings.Contains(stderr, "inbox enable --dir") {
		t.Fatalf("stderr does not tell the operator how to recover:\n%s", stderr)
	}

	// Re-enabling adopts the new device and works.
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	e.token = newToken
	e.sendFile("after-relogin.txt", []byte("still works"))
	e.mustRun("run", "--config-dir", e.cfgDir, "--once")
	if got, err := os.ReadFile(filepath.Join(e.receive, "after-relogin.txt")); err != nil || string(got) != "still works" {
		t.Fatalf("delivery after re-login: %q %v", got, err)
	}
}

// TestInboxHandlesServerSideRevocation: the account revoked this device's key
// from elsewhere. The worker must stop with an actionable message instead of
// retrying forever, and must not keep claiming.
func TestInboxHandlesServerSideRevocation(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	deviceID, in := e.deviceInbox()

	req, _ := http.NewRequest(http.MethodPost,
		e.ts.URL+"/api/devices/"+deviceID+"/inbox/keys/"+in.Key.ID+"/revoke", nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke: status %d", resp.StatusCode)
	}

	code, _, stderr := e.run("run", "--config-dir", e.cfgDir, "--once")
	if code == 0 {
		t.Fatal("the worker kept running after its key was revoked")
	}
	if !strings.Contains(stderr, "revoked") {
		t.Fatalf("stderr does not explain the revocation:\n%s", stderr)
	}
	if _, err := os.ReadDir(e.receive); err != nil {
		t.Fatalf("receive dir: %v", err)
	}
}

// TestInboxHandlesDirectoryLoss: the receive directory disappeared (an unmounted
// volume). The worker must report it as unusable rather than recreating it —
// recreating a mount point would deliver into the underlying filesystem and hide
// the failure.
func TestInboxHandlesDirectoryLoss(t *testing.T) {
	e := newInboxEnv(t)
	e.mustRun("enable", "--dir", e.receive, "--config-dir", e.cfgDir)
	e.sendFile("lost.txt", []byte("nowhere to go"))
	if err := os.RemoveAll(e.receive); err != nil {
		t.Fatalf("remove: %v", err)
	}

	e.mustRun("run", "--config-dir", e.cfgDir, "--once")

	if _, err := os.Stat(e.receive); err == nil {
		t.Fatal("the worker recreated the missing receive directory; an unmounted volume would be silently written to")
	}
	_, in := e.deviceInbox()
	if in == nil || in.ReceiveDirReady {
		t.Fatalf("the device still advertises a usable receive directory: %+v", in)
	}
	// And `status` says so.
	_, stdout, _ := e.run("status", "--config-dir", e.cfgDir)
	if !strings.Contains(stdout, "NOT USABLE") {
		t.Fatalf("status does not surface the missing directory:\n%s", stdout)
	}
}
