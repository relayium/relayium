package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storage"
)

// Device Inbox Phase 1B acceptance: the encrypted asynchronous task queue.
//
// The invariants under test, stated before the implementation and repeated here
// so a reader checks the assertions against them rather than against the code:
//
//  1. ZERO KNOWLEDGE. A task row may hold the account, the devices, the
//     ciphertext byte count, times, a state, an opaque error token and
//     idempotency metadata — plus two blobs central cannot read. No submitted
//     value that looks like a secret, a file name or a path ever reaches
//     storage or a response.
//  2. A PUBLIC LINK NEVER WRITES TO DISK. The queue is same-account and
//     authenticated; an unauthenticated caller reaches none of it.
//  3. SESSION ≠ DEVICE. A cookie may create and read tasks; only the machine
//     itself may claim work or assert what it did with a file.
//  4. THE KEY BINDING IS FIXED AT CREATION. Rotation preserves an existing
//     task's claim on the superseded key; revoking that key terminates it.
//  5. EXACTLY ONE CLAIMANT. Concurrent claims produce one winner, an expired
//     lease returns the work to the pool, and the superseded claimant is
//     rejected rather than allowed to overwrite the current one.
//  6. RETRIES CONVERGE. Duplicate create, claim, progress and saved reports do
//     not duplicate work or falsify a timestamp.
//  7. SAVED IS EARNED. It is reachable only from `verifying`, only with an
//     explicit commit assertion, and never from ciphertext upload.
//  8. DELETION CASCADES, BLOBS DO NOT LEAK. Deleting a device or purging an
//     account removes every owned task; deleting a task never destroys the
//     Stored Object it merely referenced.

// ---------- harness ----------

// taskHarness adds a controllable clock to deviceHarness. Lease expiry, TTL and
// retention are all time-driven, and a test that had to sleep for them would be
// both slow and flaky.
type taskHarness struct {
	*deviceHarness
	clock *atomic.Int64
}

func newTaskHarness(t *testing.T) *taskHarness {
	t.Helper()
	h := newDeviceHarness(t)
	clk := new(atomic.Int64)
	// Based on real time so the sessions deviceHarness.cookie mints (which use
	// time.Now directly) are valid against this clock.
	clk.Store(time.Now().Unix())
	h.svc.now = func() time.Time { return time.Unix(clk.Load(), 0) }
	return &taskHarness{deviceHarness: h, clock: clk}
}

func (h *taskHarness) advance(d time.Duration) { h.clock.Add(int64(d / time.Second)) }
func (h *taskHarness) nowUnix() int64          { return h.clock.Load() }

// target is one enrolled, keyed receiving device: everything a sender needs to
// address it, and the bearer the device itself authenticates with.
type target struct {
	deviceID string
	token    string
	keyID    string
	keyGen   int64
	kp       inboxKeypair
}

// enrolTarget enrols a device with an explicit automatic-receive policy and
// directory report, then registers its first end-to-end key.
func (h *taskHarness) enrolTarget(t *testing.T, userID, name, policy string, dirReady bool) target {
	t.Helper()
	token := h.bearer(t, userID, name)
	var deviceID string
	for _, d := range decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token))) {
		if d.Current {
			deviceID = d.ID
		}
	}
	if deviceID == "" {
		t.Fatalf("no current device for a freshly minted bearer")
	}
	body := fmt.Sprintf(`{"platform":"linux","appVersion":"0.15.0","protocolVersions":[3],
		"capabilities":["inbox.receive.v3","inbox.autoaccept.v1"],
		"autoAccept":%q,"receiveDirReady":%t}`, policy, dirReady)
	if resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", body, withBearer(token)); resp.StatusCode != 200 {
		t.Fatalf("enrol %s: got %d, want 200", name, resp.StatusCode)
	}
	kp := newInboxKeypair(t)
	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, kp.encoded),
		withBearer(token))
	if resp.StatusCode != 200 {
		t.Fatalf("register key for %s: got %d, want 200", name, resp.StatusCode)
	}
	key := decodeJSONBody(t, resp)["key"].(map[string]any)
	return target{
		deviceID: deviceID, token: token, kp: kp,
		keyID: key["ID"].(string), keyGen: int64(key["Generation"].(float64)),
	}
}

// storedObject creates a live encrypted Stored Object for a user. The manifest
// bytes are opaque to central, exactly as a real upload's are.
func (h *taskHarness) storedObject(t *testing.T, userID string, size int64, ttl time.Duration) string {
	t.Helper()
	id := authx.NewID()
	err := h.store.CreateStoredFile(context.Background(), StoredFile{
		ID: id, UserID: userID, BlobKey: "blob-" + id,
		EncManifest: []byte("opaque-ciphertext-manifest-" + id),
		Size:        size, CreatedAt: h.nowUnix(), ExpiresAt: h.nowUnix() + int64(ttl/time.Second),
	})
	if err != nil {
		t.Fatalf("create stored object: %v", err)
	}
	return id
}

// sealedKey is a stand-in for the sender's sealed box: canonical base64url of a
// plausible length. Central never opens one, so its contents are irrelevant to
// every server-side assertion — what matters is that the encoding rule is the
// same one Phase 1A defined for public keys.
func sealedKey(seed string) string {
	raw := make([]byte, 80)
	copy(raw, seed)
	for i := len(seed); i < len(raw); i++ {
		raw[i] = byte(i * 7)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

type createOpts struct {
	idem      string
	fileID    string
	keyID     string
	keyGen    int64
	wrapped   string
	algorithm string
	// protocol overrides the declared manifest protocol version; 0 means "the
	// version this build writes". omitProtocol drops the field entirely, which
	// is the shape a client predating v2 would send.
	protocol     int
	omitProtocol bool
	extraJSON    string // raw extra fields, for strict-decoding tests
	authMutate   func(*http.Request)
}

func (h *taskHarness) createTask(t *testing.T, deviceID string, o createOpts) *http.Response {
	t.Helper()
	if o.algorithm == "" {
		o.algorithm = inbox.KeyAlgX25519SealedBoxV1
	}
	if o.wrapped == "" {
		o.wrapped = sealedKey(o.idem)
	}
	if o.protocol == 0 {
		o.protocol = inbox.ProtocolV3
	}
	proto := fmt.Sprintf(`"protocolVersion":%d,`, o.protocol)
	if o.omitProtocol {
		proto = ""
	}
	body := fmt.Sprintf(`{"idempotencyKey":%q,"storedFileId":%q,%s"wrapAlgorithm":%q,
		"wrappedKey":%q,"targetKeyId":%q,"targetKeyGeneration":%d%s}`,
		o.idem, o.fileID, proto, o.algorithm, o.wrapped, o.keyID, o.keyGen, o.extraJSON)
	return h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/tasks", body, o.authMutate)
}

// queueTask is the happy path most tests start from: one live object, one task,
// asserted created.
func (h *taskHarness) queueTask(t *testing.T, tg target, idem string) map[string]any {
	t.Helper()
	fileID := h.storedObject(t, h.userOf(t, tg), 4096, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: idem, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create task: got %d, want 201", resp.StatusCode)
	}
	return decodeJSONBody(t, resp)["task"].(map[string]any)
}

// userOf resolves the account a device belongs to, so helpers do not have to
// thread the user id through every call.
func (h *taskHarness) userOf(t *testing.T, tg target) string {
	t.Helper()
	var uid string
	if err := h.store.db.QueryRow(`SELECT user_id FROM devices WHERE id = ?`, tg.deviceID).Scan(&uid); err != nil {
		t.Fatalf("resolve device owner: %v", err)
	}
	return uid
}

// claimOne leases exactly one task and returns it with its claim token.
func (h *taskHarness) claimOne(t *testing.T, tg target) (map[string]any, string) {
	t.Helper()
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":1}`, withBearer(tg.token))
	if resp.StatusCode != 200 {
		t.Fatalf("claim: got %d, want 200", resp.StatusCode)
	}
	tasks := decodeJSONBody(t, resp)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("claim returned %d tasks, want 1", len(tasks))
	}
	task := tasks[0].(map[string]any)
	return task, task["ClaimToken"].(string)
}

func (h *taskHarness) report(t *testing.T, tg target, taskID, token, state, errCode string, committed bool) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"claimToken":%q,"state":%q,"errorCode":%q,"committed":%t}`,
		token, state, errCode, committed)
	return h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID+"/report", body, withBearer(tg.token))
}

func (h *taskHarness) taskState(t *testing.T, tg target, taskID string) map[string]any {
	t.Helper()
	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID, withBearer(tg.token))
	if resp.StatusCode != 200 {
		t.Fatalf("read task: got %d, want 200", resp.StatusCode)
	}
	return decodeJSONBody(t, resp)["task"].(map[string]any)
}

// forceState is a TEST-ONLY trapdoor that writes a state directly, so the
// transition matrix below can start from every reachable state without building
// a bespoke API sequence for each. It deliberately goes through the same table
// CHECK the application does, so it cannot fabricate a state the schema forbids.
func (h *taskHarness) forceState(t *testing.T, taskID, state string) {
	t.Helper()
	if _, err := h.store.db.Exec(`UPDATE inbox_tasks SET state = ? WHERE id = ?`, state, taskID); err != nil {
		t.Fatalf("force state %q: %v", state, err)
	}
}

func apiErrorCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	body := decodeJSONBody(t, resp)
	s, _ := body["error"].(string)
	return s
}

// ---------- creation and the automatic-receive policy ----------

func TestCreateTaskQueuesUnderAutoPolicy(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "auto@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 4096, time.Hour)

	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d, want 201", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["created"] != true {
		t.Fatalf("created = %v, want true", body["created"])
	}
	task := body["task"].(map[string]any)
	if task["State"] != inbox.TaskQueued {
		t.Fatalf("state = %v, want queued", task["State"])
	}
	// Size and expiry are DERIVED from the object, never asserted by the sender.
	if task["CiphertextBytes"].(float64) != 4096 {
		t.Fatalf("CiphertextBytes = %v, want the object's 4096", task["CiphertextBytes"])
	}
	if task["SavedAt"].(float64) != 0 {
		t.Fatalf("a freshly created task must not carry a saved timestamp")
	}
	// The account view must not leak delivery material: only the target device
	// gets the sealed key and the manifest, and only under a lease.
	for _, forbidden := range []string{"WrappedKey", "EncManifest", "ClaimToken"} {
		if _, present := task[forbidden]; present {
			t.Fatalf("account task view leaked %s", forbidden)
		}
	}
}

func TestCreateTaskIsHeldUnderAskPolicy(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "ask@example.test")
	tg := h.enrolTarget(t, u, "laptop", inbox.AutoAcceptAsk, true)
	task := h.queueTask(t, tg, "ask-1")
	if task["State"] != inbox.TaskAttentionRequired {
		t.Fatalf("ask policy created %v, want attention_required", task["State"])
	}
	// And it is NOT claimable: nothing may reach the disk before a person at
	// that machine says so.
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":5}`, withBearer(tg.token))
	if got := decodeJSONBody(t, resp)["tasks"].([]any); len(got) != 0 {
		t.Fatalf("claimed %d held tasks, want 0", len(got))
	}
}

func TestCreateTaskRefusedWhenPolicyIsOff(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "off@example.test")
	tg := h.enrolTarget(t, u, "nas", inbox.AutoAcceptOff, true)
	fileID := h.storedObject(t, u, 1024, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "off-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("create against an off device: got %d, want 409", resp.StatusCode)
	}
	if code := apiErrorCode(t, resp); code != "auto_receive_disabled" {
		t.Fatalf("error = %q, want auto_receive_disabled", code)
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a refused create stored %d rows (err %v), want 0", n, err)
	}
}

func TestCreateTaskHeldWhenAutoButReceiveDirectoryIsUnusable(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "nodir@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, false)
	task := h.queueTask(t, tg, "nodir-1")
	if task["State"] != inbox.TaskAttentionRequired {
		t.Fatalf("auto with an unusable directory created %v, want attention_required", task["State"])
	}
}

// TestOfflineDeviceIsAValidQueueTarget is the reason the queue exists: presence
// and the ability to receive are separate (PRD §7.3). The device below has never
// heartbeated.
func TestOfflineDeviceIsAValidQueueTargetAndDrainsOnReturn(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "offline@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	row := h.deviceRow(t, tg.token, tg.deviceID)
	if row.Inbox == nil {
		t.Fatalf("target device carries no inbox view")
	}
	if row.Inbox.Presence != inbox.PresenceOffline {
		t.Fatalf("presence = %q, want offline", row.Inbox.Presence)
	}
	if !row.Inbox.CanReceive {
		t.Fatalf("an offline but enrolled device must still be a queue target")
	}

	// A long-lived object, so the wait below tests the QUEUE outliving an outage
	// rather than the ciphertext's own TTL.
	fileID := h.storedObject(t, u, 4096, 30*24*time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "offline-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d, want 201", resp.StatusCode)
	}
	task := decodeJSONBody(t, resp)["task"].(map[string]any)

	// Two days later the machine comes back and drains the queue.
	h.advance(48 * time.Hour)
	_ = h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/heartbeat", `{"receiveDirReady":true}`, withBearer(tg.token))
	claimed, token := h.claimOne(t, tg)
	if claimed["ID"] != task["ID"] {
		t.Fatalf("claimed %v, want the queued task %v", claimed["ID"], task["ID"])
	}
	if resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("verify report: got %d", resp.StatusCode)
	}
	if resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskSaved, "", true); resp.StatusCode != 200 {
		t.Fatalf("saved report: got %d", resp.StatusCode)
	}
	if got := h.taskState(t, tg, task["ID"].(string))["State"]; got != inbox.TaskSaved {
		t.Fatalf("state = %v, want saved", got)
	}
}

// ---------- the referenced Stored Object ----------

func TestCreateTaskDerivesManifestAndSizeFromTheStoredObject(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "derive@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 7777, 90*time.Minute)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "d-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	if task["CiphertextBytes"].(float64) != 7777 {
		t.Fatalf("size = %v, want 7777", task["CiphertextBytes"])
	}
	// The task cannot outlive the ciphertext it points at, so its TTL IS the
	// object's — no second retention window to keep consistent with the first.
	var fileExpires int64
	if err := h.store.db.QueryRow(`SELECT expires_at FROM stored_files WHERE id = ?`, fileID).Scan(&fileExpires); err != nil {
		t.Fatalf("read object expiry: %v", err)
	}
	if int64(task["ExpiresAt"].(float64)) != fileExpires {
		t.Fatalf("task expiry %v != object expiry %d", task["ExpiresAt"], fileExpires)
	}
	// The manifest is copied from the object, never taken from the request.
	var stored, taskManifest []byte
	if err := h.store.db.QueryRow(`SELECT enc_manifest FROM stored_files WHERE id = ?`, fileID).Scan(&stored); err != nil {
		t.Fatalf("read object manifest: %v", err)
	}
	if err := h.store.db.QueryRow(`SELECT enc_manifest FROM inbox_tasks WHERE id = ?`, task["ID"]).Scan(&taskManifest); err != nil {
		t.Fatalf("read task manifest: %v", err)
	}
	if string(stored) != string(taskManifest) {
		t.Fatalf("task manifest diverged from the object's")
	}
}

func TestCreateTaskRejectsAnotherAccountsStoredObject(t *testing.T) {
	h := newTaskHarness(t)
	mine := h.user(t, "mine@example.test")
	theirs := h.user(t, "theirs@example.test")
	tg := h.enrolTarget(t, mine, "server", inbox.AutoAcceptAuto, true)
	foreign := h.storedObject(t, theirs, 100, time.Hour)

	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "x-1", fileID: foreign, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stored_object_unavailable" {
		t.Fatalf("cross-account object: got %d, want 409 stored_object_unavailable", resp.StatusCode)
	}
}

// TestCreateTaskRejectsAnExpiredStoredObject pins the TTL boundary: a task may
// not be created against ciphertext that is already gone, and expires_at is the
// exact instant of death, not a second later.
func TestCreateTaskRejectsAnExpiredStoredObject(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "ttl@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 512, time.Minute)

	// One second before expiry: still live.
	h.advance(59 * time.Second)
	if resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "ttl-live", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	}); resp.StatusCode != http.StatusCreated {
		t.Fatalf("one second before expiry: got %d, want 201", resp.StatusCode)
	}
	// Exactly at expiry: gone.
	h.advance(time.Second)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "ttl-dead", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stored_object_unavailable" {
		t.Fatalf("at expiry: got %d, want 409 stored_object_unavailable", resp.StatusCode)
	}
}

func TestCreateTaskRejectsLimitedOrBurnStoredObjects(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "limited-object@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	for _, max := range []int64{1, 5} {
		fileID := h.storedObject(t, u, 64, time.Hour)
		if _, err := h.store.db.Exec(`UPDATE stored_files SET max_downloads = ? WHERE id = ?`, max, fileID); err != nil {
			t.Fatalf("set max downloads: %v", err)
		}
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: fmt.Sprintf("limited-%d", max), fileID: fileID,
			keyID: tg.keyID, keyGen: tg.keyGen, authMutate: withBearer(tg.token),
		})
		if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stored_object_unavailable" {
			t.Fatalf("maxDownloads=%d: got %d, want 409 stored_object_unavailable", max, resp.StatusCode)
		}
	}
	fileID := h.storedObject(t, u, 64, time.Hour)
	if _, err := h.store.db.Exec(`UPDATE stored_files SET burn_after_read = 1 WHERE id = ?`, fileID); err != nil {
		t.Fatalf("set legacy burn flag: %v", err)
	}
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "legacy-burn", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stored_object_unavailable" {
		t.Fatalf("legacy burn object: got %d, want 409 stored_object_unavailable", resp.StatusCode)
	}
}

// ---------- target key binding, rotation, revocation ----------

func TestCreateTaskRejectsAStaleTargetKey(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "bind@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 128, time.Hour)

	for name, o := range map[string]createOpts{
		"unknown key id":    {keyID: authx.NewID(), keyGen: tg.keyGen},
		"wrong generation":  {keyID: tg.keyID, keyGen: tg.keyGen + 1},
		"zero generation":   {keyID: tg.keyID, keyGen: 0},
		"empty key id":      {keyID: "", keyGen: tg.keyGen},
		"another gen entry": {keyID: tg.keyID, keyGen: 99},
	} {
		o.idem, o.fileID, o.authMutate = "stale-"+name, fileID, withBearer(tg.token)
		resp := h.createTask(t, tg.deviceID, o)
		if resp.StatusCode == http.StatusCreated {
			t.Fatalf("%s: create succeeded, want refusal", name)
		}
	}
	// Rotate, then try the now-superseded key: a NEW task must go to the current
	// one, or the device would be handed work it may no longer prefer to open.
	kp2 := newInboxKeypair(t)
	rot := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, kp2.encoded, tg.keyID), withBearer(tg.token))
	if rot.StatusCode != 200 {
		t.Fatalf("rotate: got %d", rot.StatusCode)
	}
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "stale-after-rotate", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stale_target_key" {
		t.Fatalf("superseded key: got %d, want 409 stale_target_key", resp.StatusCode)
	}
}

// TestRotationPreservesAQueuedTaskSealedToTheSupersededKey is PRD §16.2: a
// rotation must not strand work already sealed to the old key. The device still
// holds that private key, so it can still open it.
func TestRotationPreservesAQueuedTaskSealedToTheSupersededKey(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "rotate@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "pre-rotate")

	kp2 := newInboxKeypair(t)
	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, kp2.encoded, tg.keyID), withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("rotate: got %d", resp.StatusCode)
	}
	if got := h.taskState(t, tg, task["ID"].(string))["State"]; got != inbox.TaskQueued {
		t.Fatalf("state after rotation = %v, want the task still queued", got)
	}
	claimed, _ := h.claimOne(t, tg)
	if claimed["ID"] != task["ID"] {
		t.Fatalf("a task sealed to a superseded key must still be claimable")
	}
	if claimed["TargetKeyID"] != tg.keyID {
		t.Fatalf("the key binding moved on rotation: %v", claimed["TargetKeyID"])
	}
}

func TestRevokingTheBoundKeyTerminatesItsQueuedAndLeasedTasks(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "revoke@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg, "revoke-queued")
	h.queueTask(t, tg, "revoke-leased")
	// Lease one of them, so revocation has to stop work already in flight and
	// not merely stop the next claim.
	claimed, leaseToken := h.claimOne(t, tg)
	leasedID := claimed["ID"].(string)

	// Revoke the active key from ANOTHER credential — the point of revocation is
	// that it works without the device's cooperation.
	cookie := h.cookie(t, u)
	rev := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys/"+tg.keyID+"/revoke", `{}`,
		func(r *http.Request) { r.AddCookie(cookie) })
	if rev.StatusCode != 200 {
		t.Fatalf("revoke: got %d", rev.StatusCode)
	}

	var states []string
	rows, err := h.store.db.Query(`SELECT state FROM inbox_tasks WHERE target_device_id = ?`, tg.deviceID)
	if err != nil {
		t.Fatalf("read states: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan: %v", err)
		}
		states = append(states, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate states: %v", err)
	}
	if len(states) != 2 {
		t.Fatalf("expected 2 task rows, got %d", len(states))
	}
	for _, s := range states {
		if s != inbox.TaskRevoked {
			t.Fatalf("task state after key revocation = %q, want revoked", s)
		}
	}
	// The claimant holding a lease can no longer advance it.
	if resp := h.report(t, tg, leasedID, leaseToken, inbox.TaskVerifying, "", false); resp.StatusCode != http.StatusConflict {
		t.Fatalf("revoked device advanced a live lease: got %d, want 409", resp.StatusCode)
	}
	// And it cannot claim new work. The specific code matters: a revoked device
	// must be told to stop and involve a human, which is a different instruction
	// from the generic "this device cannot receive".
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "device_inbox_revoked" {
		t.Fatalf("revoked device claim: got %d %q, want 409 device_inbox_revoked",
			resp.StatusCode, apiErrorCode(t, resp))
	}
	if resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/pending", withBearer(tg.token)); resp.StatusCode != http.StatusConflict ||
		apiErrorCode(t, resp) != "device_inbox_revoked" {
		t.Fatalf("revoked device pending poll: got %d, want 409 device_inbox_revoked", resp.StatusCode)
	}
}

// TestARevokedKeyIsRefusedAtClaimEvenIfATaskSurvived is defence in depth for the
// key binding. Revocation normally terminates a key's tasks in the same
// transaction, so this forces the state that would exist if some future write
// path revoked a key WITHOUT sweeping its queue: the claim itself must still
// refuse to hand out a task nothing can open, and must say so on the row rather
// than leaving it queued forever.
func TestARevokedKeyIsRefusedAtClaimEvenIfATaskSurvived(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "keydefence@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "defence-1")

	// Rotate so the bound key is superseded but the DEVICE stays in service,
	// then revoke that key behind the store's back.
	kp2 := newInboxKeypair(t)
	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, kp2.encoded, tg.keyID), withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("rotate: got %d", resp.StatusCode)
	}
	if _, err := h.store.db.Exec(`UPDATE device_keys SET revoked_at = ? WHERE id = ?`,
		h.nowUnix(), tg.keyID); err != nil {
		t.Fatalf("revoke key directly: %v", err)
	}

	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":5}`, withBearer(tg.token))
	if resp.StatusCode != 200 {
		t.Fatalf("claim: got %d", resp.StatusCode)
	}
	if got := decodeJSONBody(t, resp)["tasks"].([]any); len(got) != 0 {
		t.Fatalf("claimed %d tasks sealed to a revoked key, want 0", len(got))
	}
	stored := h.taskState(t, tg, task["ID"].(string))
	if stored["State"] != inbox.TaskRevoked || stored["ErrorCode"] != inbox.TaskErrKeyRevoked {
		t.Fatalf("task = %v/%v, want revoked/key_revoked rather than a task queued forever",
			stored["State"], stored["ErrorCode"])
	}
}

// TestRevokingASupersededKeyTerminatesOnlyItsOwnTasks: withdrawing an old key
// must not take down work sealed to the device's current one.
func TestRevokingASupersededKeyTerminatesOnlyItsOwnTasks(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "supersede@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	old := h.queueTask(t, tg, "sealed-to-gen1")

	kp2 := newInboxKeypair(t)
	rot := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, kp2.encoded, tg.keyID), withBearer(tg.token))
	newKey := decodeJSONBody(t, rot)["key"].(map[string]any)
	tg2 := tg
	tg2.keyID, tg2.keyGen = newKey["ID"].(string), int64(newKey["Generation"].(float64))
	fresh := h.queueTask(t, tg2, "sealed-to-gen2")

	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys/"+tg.keyID+"/revoke", `{}`,
		withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("revoke superseded key: got %d", resp.StatusCode)
	}
	if got := h.taskState(t, tg, old["ID"].(string))["State"]; got != inbox.TaskRevoked {
		t.Fatalf("task on the revoked key = %v, want revoked", got)
	}
	if got := h.taskState(t, tg, fresh["ID"].(string))["State"]; got != inbox.TaskQueued {
		t.Fatalf("task on the current key = %v, want it untouched (queued)", got)
	}
	// The device itself is unaffected and keeps working: claimOne fails the test
	// if the survivor is not claimable.
	if got, _ := h.claimOne(t, tg2); got["ID"] != fresh["ID"] {
		t.Fatalf("claimed %v, want the surviving task", got["ID"])
	}
}

// ---------- idempotency ----------

func TestCreateTaskConvergesOnARetriedIdempotencyKey(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "idem@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 2048, time.Hour)
	o := createOpts{idem: "same-key", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		wrapped: sealedKey("fixed"), authMutate: withBearer(tg.token)}

	first := decodeJSONBody(t, h.createTask(t, tg.deviceID, o))
	second := h.createTask(t, tg.deviceID, o)
	if second.StatusCode != http.StatusOK {
		t.Fatalf("retry: got %d, want 200 (converged, not created)", second.StatusCode)
	}
	body := decodeJSONBody(t, second)
	if body["created"] != false {
		t.Fatalf("created = %v on a retry, want false", body["created"])
	}
	if body["task"].(map[string]any)["ID"] != first["task"].(map[string]any)["ID"] {
		t.Fatalf("a retry produced a second task")
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows = %d (err %v), want exactly 1", n, err)
	}
}

func TestReusingAnIdempotencyKeyForADifferentTaskIsRefused(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "idemconf@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	a := h.storedObject(t, u, 10, time.Hour)
	b := h.storedObject(t, u, 20, time.Hour)

	h.createTask(t, tg.deviceID, createOpts{idem: "k", fileID: a, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token)})
	resp := h.createTask(t, tg.deviceID, createOpts{idem: "k", fileID: b, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token)})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "idempotency_key_conflict" {
		t.Fatalf("got %d, want 409 idempotency_key_conflict — silently returning the first task "+
			"would tell the sender their SECOND file was queued", resp.StatusCode)
	}
}

func TestIdempotencyKeyIsUniquePerAccountInTheDatabase(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "unique@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg, "dup")
	// A future write path that bypassed CreateInboxTask must still be stopped.
	_, err := h.store.db.Exec(
		`INSERT INTO inbox_tasks (id, user_id, target_device_id, idempotency_key, stored_file_id,
		   enc_manifest, wrap_algorithm, wrapped_key, target_key_id, target_key_generation,
		   ciphertext_bytes, state, created_at, updated_at, expires_at)
		 VALUES ('t2', ?, ?, 'dup', 'f', x'00', 'a', 'w', 'k', 1, 1, 'queued', 1, 1, 99999999999)`,
		u, tg.deviceID)
	if err == nil {
		t.Fatal("the database accepted a duplicate (user, idempotency key)")
	}
}

// ---------- concurrency: exactly one claimant ----------

func TestConcurrentClaimsProduceExactlyOneWinner(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "race@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "race-1")

	const workers = 8
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners []string
	)
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			tasks, tokens, err := h.store.ClaimInboxTasks(context.Background(), tg.deviceID, u, h.nowUnix(), 5)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for i := range tasks {
				winners = append(winners, tasks[i].ID+"/"+tokens[i])
			}
		}()
	}
	close(start)
	wg.Wait()

	if len(winners) != 1 {
		t.Fatalf("%d workers claimed the same task, want exactly 1: %v", len(winners), winners)
	}
	if !strings.HasPrefix(winners[0], task["ID"].(string)+"/") {
		t.Fatalf("winner %q is not the queued task", winners[0])
	}
	var state string
	var attempts int64
	if err := h.store.db.QueryRow(`SELECT state, attempts FROM inbox_tasks WHERE id = ?`,
		task["ID"]).Scan(&state, &attempts); err != nil {
		t.Fatalf("read task: %v", err)
	}
	if state != inbox.TaskDownloading || attempts != 1 {
		t.Fatalf("state=%q attempts=%d, want downloading/1 — a lost race must not burn an attempt",
			state, attempts)
	}
}

func TestRepeatedClaimDoesNotReleaseAnAlreadyLeasedTask(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "reclaim@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg, "lease-1")
	_, first := h.claimOne(t, tg)

	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":5}`, withBearer(tg.token))
	if got := decodeJSONBody(t, resp)["tasks"].([]any); len(got) != 0 {
		t.Fatalf("a second claim leased %d already-held tasks, want 0", len(got))
	}
	// The original lease is untouched and still works.
	var taskID string
	if err := h.store.db.QueryRow(`SELECT id FROM inbox_tasks`).Scan(&taskID); err != nil {
		t.Fatalf("read task: %v", err)
	}
	if resp := h.report(t, tg, taskID, first, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("original claimant lost its lease: got %d", resp.StatusCode)
	}
}

func TestClaimBatchIsBounded(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "batch@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	for i := 0; i < inbox.MaxClaimBatch+5; i++ {
		h.queueTask(t, tg, fmt.Sprintf("batch-%d", i))
	}
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":1000}`, withBearer(tg.token))
	got := decodeJSONBody(t, resp)["tasks"].([]any)
	if len(got) != inbox.MaxClaimBatch {
		t.Fatalf("claimed %d, want the cap %d", len(got), inbox.MaxClaimBatch)
	}
}

// ---------- lease expiry, reclaim, stale claimants ----------

func TestExpiredLeaseIsReclaimedAndTheStaleClaimantIsRejected(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "stale@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "stale-1")
	taskID := task["ID"].(string)
	_, staleToken := h.claimOne(t, tg)

	// The claimant dies. Past the lease, and past the backoff its first attempt
	// earned, the work returns to the pool.
	h.advance(inbox.TaskLeaseTTL + inbox.TaskRetryBaseBackoff + time.Second)
	fresh, freshToken := h.claimOne(t, tg)
	if fresh["ID"] != taskID {
		t.Fatalf("reclaimed %v, want the abandoned task %v", fresh["ID"], taskID)
	}
	if freshToken == staleToken {
		t.Fatalf("a reclaim reissued the dead claimant's token")
	}
	if fresh["Attempts"].(float64) != 2 {
		t.Fatalf("attempts = %v after a reclaim, want 2", fresh["Attempts"])
	}

	// The resurrected old worker must not be able to write over the new one.
	resp := h.report(t, tg, taskID, staleToken, inbox.TaskSaved, "", true)
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stale_claim" {
		t.Fatalf("stale claimant report: got %d, want 409 stale_claim", resp.StatusCode)
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskDownloading {
		t.Fatalf("state = %v after a rejected stale report, want downloading", got)
	}
	if got := h.taskState(t, tg, taskID)["SavedAt"].(float64); got != 0 {
		t.Fatalf("a stale claimant set SavedAt=%v", got)
	}
}

func TestExpiredLeaseCannotBeRevivedBeforeReclaim(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "expired-report@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "expired-report-1")
	_, token := h.claimOne(t, tg)
	h.advance(inbox.TaskLeaseTTL + time.Second)

	resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskDownloading, "", false)
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stale_claim" {
		t.Fatalf("expired claimant report: got %d, want 409 stale_claim", resp.StatusCode)
	}
	got := h.taskState(t, tg, task["ID"].(string))
	if got["LeaseExpiresAt"].(float64) >= float64(h.nowUnix()) {
		t.Fatalf("expired report revived lease to %v", got["LeaseExpiresAt"])
	}
}

func TestTaskTTLIsEnforcedBeforeGCOnReportAndAccept(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "ttl-mutation@example.test")
	auto := h.enrolTarget(t, u, "auto", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, 2*time.Minute)
	resp := h.createTask(t, auto.deviceID, createOpts{
		idem: "ttl-report", fileID: fileID, keyID: auto.keyID, keyGen: auto.keyGen,
		authMutate: withBearer(auto.token),
	})
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	_, token := h.claimOne(t, auto)
	h.advance(3 * time.Minute) // object TTL elapsed; the five-minute lease has not
	resp = h.report(t, auto, taskID, token, inbox.TaskSaved, "", true)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("report after TTL: got %d, want 409", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["error"] != "task_terminal" || body["task"].(map[string]any)["State"] != inbox.TaskExpired {
		t.Fatalf("report after TTL = %v, want task_terminal/expired", body)
	}

	ask := h.enrolTarget(t, u, "ask", inbox.AutoAcceptAsk, true)
	fileID = h.storedObject(t, u, 64, 2*time.Minute)
	resp = h.createTask(t, ask.deviceID, createOpts{
		idem: "ttl-accept", fileID: fileID, keyID: ask.keyID, keyGen: ask.keyGen,
		authMutate: withBearer(ask.token),
	})
	askID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	h.advance(3 * time.Minute)
	resp = h.jsonDo(t, "POST", "/api/devices/"+ask.deviceID+"/inbox/tasks/"+askID+"/accept",
		`{"accept":true}`, withBearer(ask.token))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("accept after TTL: got %d, want 409", resp.StatusCode)
	}
	body = decodeJSONBody(t, resp)
	if body["error"] != "task_terminal" || body["task"].(map[string]any)["State"] != inbox.TaskExpired {
		t.Fatalf("accept after TTL = %v, want task_terminal/expired", body)
	}
}

func TestLeaseNeverOutlivesTaskTTL(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "lease-ttl@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, 2*time.Minute)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "lease-ttl", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	taskID := task["ID"].(string)
	expiresAt := int64(task["ExpiresAt"].(float64))
	claimed, token := h.claimOne(t, tg)
	if lease := int64(claimed["LeaseExpiresAt"].(float64)); lease != expiresAt {
		t.Fatalf("claim lease = %d, want task expiry %d", lease, expiresAt)
	}
	resp = h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verifying report: got %d, want 200", resp.StatusCode)
	}
	if lease := int64(decodeJSONBody(t, resp)["task"].(map[string]any)["LeaseExpiresAt"].(float64)); lease != expiresAt {
		t.Fatalf("renewed lease = %d, want task expiry %d", lease, expiresAt)
	}
	h.advance(3 * time.Minute)
	path := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/blob"
	resp = h.do(t, "GET", path, func(r *http.Request) {
		withBearer(tg.token)(r)
		r.Header.Set("X-Relayium-Inbox-Claim", token)
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "task_terminal" {
		t.Fatalf("blob at task TTL: got %d, want 409 task_terminal", resp.StatusCode)
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskExpired {
		t.Fatalf("blob-expired task state = %v, want expired", got)
	}
}

func TestExpiredTasksAreHiddenAndTerminalizedByPollingBeforeGC(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "ttl-poll@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	queueWithTTL := func(idem string) string {
		fileID := h.storedObject(t, u, 64, time.Minute)
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: idem, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
			authMutate: withBearer(tg.token),
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create %s: got %d, want 201", idem, resp.StatusCode)
		}
		return decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	}

	pendingID := queueWithTTL("ttl-pending")
	h.advance(2 * time.Minute)
	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/pending", withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pending after TTL: got %d, want 200", resp.StatusCode)
	}
	if tasks := decodeJSONBody(t, resp)["tasks"].([]any); len(tasks) != 0 {
		t.Fatalf("pending after TTL returned %d task(s), want none", len(tasks))
	}
	if got := h.taskState(t, tg, pendingID)["State"]; got != inbox.TaskExpired {
		t.Fatalf("pending task state = %v, want expired", got)
	}

	claimID := queueWithTTL("ttl-claim")
	h.advance(2 * time.Minute)
	resp = h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim",
		`{"max":1}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim after TTL: got %d, want 200", resp.StatusCode)
	}
	if tasks := decodeJSONBody(t, resp)["tasks"].([]any); len(tasks) != 0 {
		t.Fatalf("claim after TTL returned %d task(s), want none", len(tasks))
	}
	if got := h.taskState(t, tg, claimID)["State"]; got != inbox.TaskExpired {
		t.Fatalf("claim task state = %v, want expired", got)
	}
}

func TestAccountReadsShowExpiredTaskTruthBeforeGC(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "ttl-read@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	queue := func(idem string) string {
		fileID := h.storedObject(t, u, 64, time.Minute)
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: idem, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
			authMutate: withBearer(tg.token),
		})
		return decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	}
	getID := queue("ttl-get")
	listID := queue("ttl-list")
	h.advance(2 * time.Minute)

	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+getID, withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get after TTL: got %d, want 200", resp.StatusCode)
	}
	if got := decodeJSONBody(t, resp)["task"].(map[string]any)["State"]; got != inbox.TaskExpired {
		t.Fatalf("get state = %v, want expired", got)
	}

	resp = h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks", withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list after TTL: got %d, want 200", resp.StatusCode)
	}
	found := false
	for _, raw := range decodeJSONBody(t, resp)["tasks"].([]any) {
		task := raw.(map[string]any)
		if task["ID"] == listID {
			found = true
			if task["State"] != inbox.TaskExpired {
				t.Fatalf("list state = %v, want expired", task["State"])
			}
		}
	}
	if !found {
		t.Fatalf("list omitted task %s", listID)
	}
}

func TestClaimScopedBlobDownloadRequiresCurrentDeviceWorker(t *testing.T) {
	h := newTaskHarness(t)
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk store: %v", err)
	}
	h.svc.SetBlobStore(disk)
	u := h.user(t, "task-blob@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 15, time.Hour)
	var blobKey string
	if err := h.store.db.QueryRow(`SELECT blob_key FROM stored_files WHERE id = ?`, fileID).Scan(&blobKey); err != nil {
		t.Fatalf("read blob key: %v", err)
	}
	if _, err := disk.Put(context.Background(), blobKey, bytes.NewReader([]byte("ciphertext-body"))); err != nil {
		t.Fatalf("put ciphertext: %v", err)
	}
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "blob-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	_, claim := h.claimOne(t, tg)
	path := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/blob"

	for name, mutate := range map[string]func(*http.Request){
		"session only": func(r *http.Request) { r.AddCookie(h.cookie(t, u)); r.Header.Set("X-Relayium-Inbox-Claim", claim) },
		"no claim":     withBearer(tg.token),
		"wrong claim":  func(r *http.Request) { withBearer(tg.token)(r); r.Header.Set("X-Relayium-Inbox-Claim", "wrong") },
	} {
		if got := h.do(t, "GET", path, mutate); got.StatusCode == http.StatusOK {
			t.Fatalf("%s downloaded task ciphertext", name)
		}
	}
	good := h.do(t, "GET", path, func(r *http.Request) {
		withBearer(tg.token)(r)
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	})
	if good.StatusCode != http.StatusOK {
		t.Fatalf("valid worker download: got %d", good.StatusCode)
	}
	body, _ := io.ReadAll(good.Body)
	if string(body) != "ciphertext-body" {
		t.Fatalf("downloaded %q", body)
	}
	var count int64
	if err := h.store.db.QueryRow(`SELECT download_count FROM stored_files WHERE id = ?`, fileID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("task download spent public-link slots: count=%d err=%v", count, err)
	}
	h.advance(inbox.TaskLeaseTTL + time.Second)
	if expired := h.do(t, "GET", path, func(r *http.Request) {
		withBearer(tg.token)(r)
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	}); expired.StatusCode != http.StatusConflict || apiErrorCode(t, expired) != "stale_claim" {
		t.Fatalf("expired worker blob request: got %d, want 409 stale_claim", expired.StatusCode)
	}
}

func TestMissingTaskBlobHealsStoredMetadataAndTaskState(t *testing.T) {
	h := newTaskHarness(t)
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk store: %v", err)
	}
	h.svc.SetBlobStore(disk)
	u := h.user(t, "task-blob-missing@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 15, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "blob-missing-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)
	_, claim := h.claimOne(t, tg)

	path := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/blob"
	resp = h.do(t, "GET", path, func(r *http.Request) {
		withBearer(tg.token)(r)
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stored_object_unavailable" {
		t.Fatalf("missing blob: got %d, want 409 stored_object_unavailable", resp.StatusCode)
	}
	got := h.taskState(t, tg, taskID)
	if got["State"] != inbox.TaskFailedTerminal || got["ErrorCode"] != inbox.TaskErrStoredObjectUnavailable {
		t.Fatalf("task after missing blob = %v/%v, want failed_terminal/stored_object_unavailable",
			got["State"], got["ErrorCode"])
	}
	var rows int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE id = ?`, fileID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("dead stored metadata rows = %d (err %v), want 0", rows, err)
	}
}

func TestProgressRenewsTheLeaseSoALongDownloadKeepsIt(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "renew@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "renew-1")
	taskID := task["ID"].(string)
	_, token := h.claimOne(t, tg)

	// A download longer than the lease stays claimed by reporting progress.
	for i := 0; i < 4; i++ {
		h.advance(inbox.TaskLeaseTTL - time.Minute)
		resp := h.report(t, tg, taskID, token, inbox.TaskDownloading, "", false)
		if resp.StatusCode != 200 {
			t.Fatalf("progress %d: got %d, want 200", i, resp.StatusCode)
		}
		got := decodeJSONBody(t, resp)["task"].(map[string]any)
		if got["State"] != inbox.TaskDownloading {
			t.Fatalf("progress changed state to %v", got["State"])
		}
		if got["Attempts"].(float64) != 1 {
			t.Fatalf("a progress heartbeat burned an attempt: %v", got["Attempts"])
		}
	}
	if resp := h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("verify after renewals: got %d", resp.StatusCode)
	}
}

// ---------- saved is earned ----------

func TestSavedRequiresVerifyingAndAnExplicitCommitAssertion(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "saved@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "saved-1")
	taskID := task["ID"].(string)
	_, token := h.claimOne(t, tg)

	// From downloading, "saved" is not a legal transition at all: the bytes
	// arriving is not the file being on disk.
	resp := h.report(t, tg, taskID, token, inbox.TaskSaved, "", true)
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "invalid_transition" {
		t.Fatalf("saved from downloading: got %d, want 409 invalid_transition", resp.StatusCode)
	}
	if resp := h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("verifying: got %d", resp.StatusCode)
	}
	// From verifying but WITHOUT the assertion: still refused. Central cannot
	// observe an atomic commit, so it will not infer one from a state name.
	resp = h.report(t, tg, taskID, token, inbox.TaskSaved, "", false)
	if resp.StatusCode != http.StatusBadRequest || apiErrorCode(t, resp) != "saved_not_asserted" {
		t.Fatalf("saved without committed=true: got %d, want 400 saved_not_asserted", resp.StatusCode)
	}
	if got := h.taskState(t, tg, taskID); got["SavedAt"].(float64) != 0 || got["State"] != inbox.TaskVerifying {
		t.Fatalf("a refused saved changed the row: %v", got)
	}
	// With the assertion: saved, timestamped now.
	at := h.nowUnix()
	if resp := h.report(t, tg, taskID, token, inbox.TaskSaved, "", true); resp.StatusCode != 200 {
		t.Fatalf("saved: got %d", resp.StatusCode)
	}
	got := h.taskState(t, tg, taskID)
	if got["State"] != inbox.TaskSaved || int64(got["SavedAt"].(float64)) != at {
		t.Fatalf("state=%v savedAt=%v, want saved at %d", got["State"], got["SavedAt"], at)
	}
}

func TestDuplicateSavedReportKeepsTheOriginalTimestamp(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "dupsaved@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "dupsaved-1")
	taskID := task["ID"].(string)
	_, token := h.claimOne(t, tg)
	h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false)
	committedAt := h.nowUnix()
	h.report(t, tg, taskID, token, inbox.TaskSaved, "", true)

	// The device loses the response and retries an hour later.
	h.advance(time.Hour)
	resp := h.report(t, tg, taskID, token, inbox.TaskSaved, "", true)
	if resp.StatusCode != 200 {
		t.Fatalf("retried saved: got %d, want 200 (idempotent)", resp.StatusCode)
	}
	got := decodeJSONBody(t, resp)["task"].(map[string]any)
	if int64(got["SavedAt"].(float64)) != committedAt {
		t.Fatalf("SavedAt moved to %v on a retry; it must stay the moment of the real commit (%d)",
			got["SavedAt"], committedAt)
	}
}

func TestSavedTaskRefusesAnyFurtherTransition(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "terminal@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "terminal-1")
	taskID := task["ID"].(string)
	_, token := h.claimOne(t, tg)
	h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false)
	h.report(t, tg, taskID, token, inbox.TaskSaved, "", true)

	for _, to := range []string{inbox.TaskDownloading, inbox.TaskVerifying,
		inbox.TaskFailedRetryable, inbox.TaskFailedTerminal, inbox.TaskAttentionRequired} {
		resp := h.report(t, tg, taskID, token, to, "", false)
		if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "task_terminal" {
			t.Fatalf("saved -> %s: got %d, want 409 task_terminal", to, resp.StatusCode)
		}
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskSaved {
		t.Fatalf("state = %v after refused transitions, want saved", got)
	}
}

// TestStoreRefusesEveryIllegalTransition drives the store's report path from
// every reachable source state through every device-reportable target and
// asserts the outcome against the table, so a permissive edge cannot be added
// without this failing.
func TestStoreRefusesEveryIllegalTransition(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "matrix@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	sources := []string{inbox.TaskQueued, inbox.TaskNotified, inbox.TaskDownloading,
		inbox.TaskVerifying, inbox.TaskAttentionRequired, inbox.TaskFailedRetryable}
	targets := []string{inbox.TaskDownloading, inbox.TaskVerifying, inbox.TaskSaved,
		inbox.TaskAttentionRequired, inbox.TaskFailedRetryable, inbox.TaskFailedTerminal}

	for _, from := range sources {
		for _, to := range targets {
			if from == to {
				continue // an idempotent no-op, covered separately
			}
			task := h.queueTask(t, tg, fmt.Sprintf("m-%s-%s", from, to))
			taskID := task["ID"].(string)
			// A claim gives the reporter a valid lease; the source state is then
			// forced so the transition itself is what is under test.
			_, token := h.claimOne(t, tg)
			h.forceState(t, taskID, from)

			resp := h.report(t, tg, taskID, token, to, "", to == inbox.TaskSaved)
			legal := inbox.CanTransitionTask(from, to)
			if legal && resp.StatusCode != 200 {
				t.Fatalf("%s -> %s: got %d, want 200 (legal)", from, to, resp.StatusCode)
			}
			if !legal && resp.StatusCode == 200 {
				t.Fatalf("%s -> %s: got 200, want a refusal (illegal)", from, to)
			}
			if !legal {
				if code := apiErrorCode(t, resp); code != "invalid_transition" {
					t.Fatalf("%s -> %s: error = %q, want invalid_transition", from, to, code)
				}
			}
			// Clean up so the per-device queue bound is not exhausted.
			if _, err := h.store.db.Exec(`DELETE FROM inbox_tasks WHERE id = ?`, taskID); err != nil {
				t.Fatalf("cleanup: %v", err)
			}
		}
	}
}

func TestReportRejectsSenderLocalStatesByName(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "senderlocal@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "sl-1")
	_, token := h.claimOne(t, tg)

	for _, s := range []string{inbox.SenderStateEncrypting, inbox.SenderStateUploading} {
		resp := h.report(t, tg, task["ID"].(string), token, s, "", false)
		if resp.StatusCode != http.StatusBadRequest || apiErrorCode(t, resp) != "sender_local_state" {
			t.Fatalf("%q: got %d %q, want 400 sender_local_state — central cannot observe it",
				s, resp.StatusCode, apiErrorCode(t, resp))
		}
	}
	var stored int
	if err := h.store.db.QueryRow(
		`SELECT COUNT(*) FROM inbox_tasks WHERE state IN ('encrypting','uploading')`).Scan(&stored); err != nil {
		t.Fatalf("query: %v", err)
	}
	if stored != 0 {
		t.Fatalf("%d rows hold a sender-local state", stored)
	}
}

func TestReportRejectsFreeTextErrorCodes(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "errcode@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "err-1")
	_, token := h.claimOne(t, tg)

	// The one shape that must never be storable: a real path in an error field.
	const leaky = "cannot write /Users/lily/Documents/salary.pdf"
	resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskFailedRetryable, leaky, false)
	if resp.StatusCode != http.StatusBadRequest || apiErrorCode(t, resp) != "invalid_error_code" {
		t.Fatalf("free-text error code: got %d, want 400 invalid_error_code", resp.StatusCode)
	}
	if hits := sweepDatabaseForSecrets(t, h.store, []string{"salary.pdf"}); len(hits) > 0 {
		t.Fatalf("a rejected error string reached storage: %v", hits)
	}
	// Central's own codes are not device-submittable either.
	for _, c := range []string{inbox.TaskErrLeaseExpired, inbox.TaskErrAttemptsExhausted, inbox.TaskErrKeyRevoked} {
		if resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskFailedRetryable, c, false); resp.StatusCode != 400 {
			t.Fatalf("device forged central's %q: got %d, want 400", c, resp.StatusCode)
		}
	}
	// A legitimate closed-set code works.
	if resp := h.report(t, tg, task["ID"].(string), token, inbox.TaskFailedRetryable, inbox.TaskErrDiskFull, false); resp.StatusCode != 200 {
		t.Fatalf("disk_full: got %d, want 200", resp.StatusCode)
	}
}

func TestReportRequiresTheCurrentClaimToken(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "claimtok@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "tok-1")
	taskID := task["ID"].(string)

	// Before any claim, no token is valid: reporting without claiming is
	// impossible, so an unclaimed task cannot be advanced by anyone.
	for _, tok := range []string{"", authx.RandToken()} {
		resp := h.report(t, tg, taskID, tok, inbox.TaskVerifying, "", false)
		if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "stale_claim" {
			t.Fatalf("token %q on an unclaimed task: got %d, want 409 stale_claim", tok, resp.StatusCode)
		}
	}
	_, token := h.claimOne(t, tg)
	if resp := h.report(t, tg, taskID, token+"x", inbox.TaskVerifying, "", false); resp.StatusCode != http.StatusConflict {
		t.Fatalf("a mangled token was accepted: got %d", resp.StatusCode)
	}
	if resp := h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("the real token was refused: got %d", resp.StatusCode)
	}
}

func TestRetryBudgetExhaustionBecomesTerminal(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "budget@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	// Long-lived ciphertext, so what runs out below is the RETRY budget and not
	// the object's TTL — the two failure modes must be distinguishable.
	fileID := h.storedObject(t, u, 4096, 30*24*time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "budget-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d, want 201", resp.StatusCode)
	}
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)

	var last map[string]any
	for i := 0; i < inbox.MaxTaskAttempts+2; i++ {
		claimed, token := h.claimOne(t, tg)
		last = claimed
		resp := h.report(t, tg, taskID, token, inbox.TaskFailedRetryable, inbox.TaskErrDownloadFailed, false)
		if resp.StatusCode != 200 {
			t.Fatalf("attempt %d report: got %d", i, resp.StatusCode)
		}
		got := decodeJSONBody(t, resp)["task"].(map[string]any)
		if got["State"] == inbox.TaskFailedTerminal {
			if got["ErrorCode"] != inbox.TaskErrAttemptsExhausted {
				t.Fatalf("terminal error code = %v, want attempts_exhausted", got["ErrorCode"])
			}
			if int(last["Attempts"].(float64)) < inbox.MaxTaskAttempts {
				t.Fatalf("gave up after %v attempts, before the budget of %d",
					last["Attempts"], inbox.MaxTaskAttempts)
			}
			return
		}
		// Serve the backoff so the next claim is allowed.
		h.advance(inbox.TaskRetryMaxBackoff + time.Second)
	}
	t.Fatalf("a permanently failing task never became terminal after %d attempts", inbox.MaxTaskAttempts+2)
}

func TestRepeatedClaimantCrashesAlsoExhaustTheRetryBudget(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "crash-budget@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 4096, 30*24*time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "crash-budget-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)

	for i := 0; i < inbox.MaxTaskAttempts; i++ {
		claimed, _ := h.claimOne(t, tg)
		if attempts := int(claimed["Attempts"].(float64)); attempts != i+1 {
			t.Fatalf("claim %d attempts = %d, want %d", i, attempts, i+1)
		}
		h.advance(inbox.TaskLeaseTTL + inbox.TaskRetryMaxBackoff + time.Second)
	}
	resp = h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim",
		`{"max":1}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reclaim exhausted worker: got %d, want 200", resp.StatusCode)
	}
	if tasks := decodeJSONBody(t, resp)["tasks"].([]any); len(tasks) != 0 {
		t.Fatalf("claim after crash budget returned %d task(s), want none", len(tasks))
	}
	got := h.taskState(t, tg, taskID)
	if got["State"] != inbox.TaskFailedTerminal || got["ErrorCode"] != inbox.TaskErrAttemptsExhausted {
		t.Fatalf("crash-exhausted task = %v/%v, want failed_terminal/attempts_exhausted",
			got["State"], got["ErrorCode"])
	}
}

func TestFailedRetryableServesItsBackoffBeforeBeingClaimableAgain(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "backoff@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "backoff-1")
	_, token := h.claimOne(t, tg)
	h.report(t, tg, task["ID"].(string), token, inbox.TaskFailedRetryable, inbox.TaskErrDownloadFailed, false)

	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{}`, withBearer(tg.token))
	if got := decodeJSONBody(t, resp)["tasks"].([]any); len(got) != 0 {
		t.Fatalf("claimed %d tasks inside the backoff window, want 0", len(got))
	}
	h.advance(inbox.TaskRetryBaseBackoff + time.Second)
	if got, _ := h.claimOne(t, tg); got["ID"] != task["ID"] {
		t.Fatalf("claimed %v after the backoff, want the failed task", got["ID"])
	}
}

// ---------- attention_required ----------

func TestAttentionRequiredIsResolvedByTheDeviceItself(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "attn@example.test")
	tg := h.enrolTarget(t, u, "laptop", inbox.AutoAcceptAsk, true)
	accepted := h.queueTask(t, tg, "attn-accept")
	declined := h.queueTask(t, tg, "attn-decline")

	// A browser session must not be able to accept on the device's behalf: the
	// whole point of `ask` is that a person at THAT machine decides.
	cookie := h.cookie(t, u)
	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+accepted["ID"].(string)+"/accept",
		`{"accept":true}`, func(r *http.Request) { r.AddCookie(cookie) }); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("session accepted for the device: got %d, want 404", resp.StatusCode)
	}

	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+accepted["ID"].(string)+"/accept",
		`{"accept":true}`, withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("accept: got %d", resp.StatusCode)
	}
	if got := h.taskState(t, tg, accepted["ID"].(string))["State"]; got != inbox.TaskQueued {
		t.Fatalf("accepted task = %v, want queued", got)
	}
	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+declined["ID"].(string)+"/accept",
		`{"accept":false}`, withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("decline: got %d", resp.StatusCode)
	}
	got := h.taskState(t, tg, declined["ID"].(string))
	if got["State"] != inbox.TaskFailedTerminal || got["ErrorCode"] != inbox.TaskErrUserDeclined {
		t.Fatalf("declined task = %v/%v, want failed_terminal/user_declined", got["State"], got["ErrorCode"])
	}
	// Only the accepted one is now claimable.
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":10}`, withBearer(tg.token))
	tasks := decodeJSONBody(t, resp)["tasks"].([]any)
	if len(tasks) != 1 || tasks[0].(map[string]any)["ID"] != accepted["ID"] {
		t.Fatalf("claimed %d tasks, want only the accepted one", len(tasks))
	}
}

// TestAcceptOnlyResolvesAHeldTask: without this guard the transition table
// alone would permit downloading -> queued through accept, letting a device
// cancel its own live lease and clear next_attempt_at — a way to spin past the
// retry backoff it just earned.
func TestAcceptOnlyResolvesAHeldTask(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "acceptguard@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "guard-1")
	taskID := task["ID"].(string)
	accept := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/accept"

	// queued: not held by a person, so not acceptable.
	if resp := h.jsonDo(t, "POST", accept, `{"accept":true}`, withBearer(tg.token)); resp.StatusCode != http.StatusConflict {
		t.Fatalf("accept on a queued task: got %d, want 409", resp.StatusCode)
	}
	_, token := h.claimOne(t, tg)
	resp := h.jsonDo(t, "POST", accept, `{"accept":true}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "invalid_transition" {
		t.Fatalf("accept on a leased task: got %d, want 409 invalid_transition", resp.StatusCode)
	}
	got := h.taskState(t, tg, taskID)
	if got["State"] != inbox.TaskDownloading || got["LeaseExpiresAt"].(float64) == 0 {
		t.Fatalf("accept cancelled a live lease: %v", got)
	}
	// The lease still belongs to its claimant.
	if resp := h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("claimant lost its lease to an accept: got %d", resp.StatusCode)
	}
}

// TestRepeatedNonWorkingReportDoesNotAttachALease: reporting a state in which
// nobody is working must not create a lease, because the reclaim pass only looks
// at downloading/verifying and would never take such a lease back.
func TestRepeatedNonWorkingReportDoesNotAttachALease(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "noleak@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "noleak-1")
	taskID := task["ID"].(string)
	_, token := h.claimOne(t, tg)
	h.report(t, tg, taskID, token, inbox.TaskFailedRetryable, inbox.TaskErrDiskFull, false)

	resp := h.report(t, tg, taskID, token, inbox.TaskFailedRetryable, inbox.TaskErrDiskFull, false)
	if resp.StatusCode != 200 {
		t.Fatalf("repeat report: got %d, want 200 (idempotent)", resp.StatusCode)
	}
	if got := decodeJSONBody(t, resp)["task"].(map[string]any); got["LeaseExpiresAt"].(float64) != 0 {
		t.Fatalf("a repeated failure report attached a lease: %v", got["LeaseExpiresAt"])
	}
}

func TestCreateRejectsAWrappedKeyOfTheWrongShape(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "wrapshape@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, time.Hour)

	short := base64.RawURLEncoding.EncodeToString(make([]byte, inbox.SealedBoxBytes-1))
	long := base64.RawURLEncoding.EncodeToString(make([]byte, inbox.SealedBoxBytes+1))
	// An absent wrapped key, sent as a raw body so the helper's default cannot
	// fill it in.
	if resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/tasks",
		fmt.Sprintf(`{"idempotencyKey":"wrap-empty","storedFileId":%q,"protocolVersion":%d,
			"wrapAlgorithm":%q,"wrappedKey":"","targetKeyId":%q,"targetKeyGeneration":%d}`,
			fileID, inbox.ProtocolV3, inbox.KeyAlgX25519SealedBoxV1, tg.keyID, tg.keyGen),
		withBearer(tg.token)); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty wrapped key: got %d, want 400", resp.StatusCode)
	}
	for name, wrapped := range map[string]string{
		"one byte short":    short,
		"one byte long":     long,
		"standard base64":   base64.StdEncoding.EncodeToString(make([]byte, inbox.SealedBoxBytes)),
		"padded base64url":  base64.URLEncoding.EncodeToString(make([]byte, inbox.SealedBoxBytes)),
		"not base64 at all": strings.Repeat("!", 108),
		"an oversized blob": base64.RawURLEncoding.EncodeToString(make([]byte, 1024)),
	} {
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: "wrap-" + name, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
			wrapped: wrapped, authMutate: withBearer(tg.token),
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want 400", name, resp.StatusCode)
		}
	}
	// An unsupported algorithm is a NEGOTIATION failure, not a malformed request.
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "wrap-alg", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		algorithm: "rsa-oaep-v1", authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "unsupported_key_algorithm" {
		t.Fatalf("unknown algorithm: got %d, want 409 unsupported_key_algorithm", resp.StatusCode)
	}
	// The exact real shape is accepted.
	if resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "wrap-ok", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	}); resp.StatusCode != http.StatusCreated {
		t.Fatalf("a correctly shaped sealed box was refused: got %d", resp.StatusCode)
	}
}

// TestClearedEnrolmentStillExplainsWhatHappened: the sender must be able to read
// the truthful reason a transfer stopped, even after the enrolment that carried
// it was cleared.
func TestClearedEnrolmentStillExplainsWhatHappened(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "explain@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "explain-1")
	cookie := h.cookie(t, u)
	withCookie := func(r *http.Request) { r.AddCookie(cookie) }

	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox", withCookie); resp.StatusCode != 200 {
		t.Fatalf("clear enrolment: got %d", resp.StatusCode)
	}
	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks", withCookie)
	if resp.StatusCode != 200 {
		t.Fatalf("list after clearing: got %d, want 200", resp.StatusCode)
	}
	tasks := decodeJSONBody(t, resp)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("listed %d tasks, want 1", len(tasks))
	}
	got := tasks[0].(map[string]any)
	if got["ID"] != task["ID"] || got["State"] != inbox.TaskRevoked || got["Terminal"] != true {
		t.Fatalf("task reads as %v/%v, want the revoked original", got["ID"], got["State"])
	}
}

// ---------- notification ----------

func TestPendingMarksNotifiedWithoutLeasingOrLeakingDeliveryMaterial(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "notify@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "notify-1")

	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/pending", withBearer(tg.token))
	if resp.StatusCode != 200 {
		t.Fatalf("pending: got %d", resp.StatusCode)
	}
	tasks := decodeJSONBody(t, resp)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("pending returned %d tasks, want 1", len(tasks))
	}
	got := tasks[0].(map[string]any)
	for _, forbidden := range []string{"WrappedKey", "EncManifest", "ClaimToken"} {
		if _, present := got[forbidden]; present {
			t.Fatalf("pending leaked %s outside a claim", forbidden)
		}
	}
	stored := h.taskState(t, tg, task["ID"].(string))
	if stored["State"] != inbox.TaskNotified || stored["NotifiedAt"].(float64) == 0 {
		t.Fatalf("state=%v notifiedAt=%v, want notified with a timestamp",
			stored["State"], stored["NotifiedAt"])
	}
	if stored["LeaseExpiresAt"].(float64) != 0 {
		t.Fatalf("pending leased the task")
	}
	// A notified task is still claimable — knowing about work is not doing it.
	if claimed, _ := h.claimOne(t, tg); claimed["ID"] != task["ID"] {
		t.Fatalf("a notified task became unclaimable")
	}
}

// ---------- authorization boundaries ----------

func TestQueueRejectsUnauthenticatedCallers(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "anon@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "anon-1")
	id, taskID := tg.deviceID, task["ID"].(string)

	// A capability link authenticates NOTHING. Holding one — or the stored file
	// id inside it — must not reach any queue endpoint (PRD §8).
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/api/devices/" + id + "/inbox/tasks", `{"idempotencyKey":"x","storedFileId":"f","protocolVersion":3,"wrapAlgorithm":"x25519-sealedbox-v1","wrappedKey":"","targetKeyId":"k","targetKeyGeneration":1}`},
		{"GET", "/api/devices/" + id + "/inbox/tasks", ""},
		{"GET", "/api/devices/" + id + "/inbox/tasks/" + taskID, ""},
		{"DELETE", "/api/devices/" + id + "/inbox/tasks/" + taskID, ""},
		{"GET", "/api/devices/" + id + "/inbox/pending", ""},
		{"POST", "/api/devices/" + id + "/inbox/claim", `{}`},
		{"GET", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/blob", ""},
		{"POST", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/report", `{"claimToken":"t","state":"saved","errorCode":"","committed":true}`},
		{"POST", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/accept", `{"accept":true}`},
	} {
		resp := h.jsonDo(t, c.method, c.path, c.body, nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s unauthenticated: got %d, want 401", c.method, c.path, resp.StatusCode)
		}
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskQueued {
		t.Fatalf("an unauthenticated caller changed the task to %v", got)
	}
}

func TestQueueIsInvisibleAcrossAccounts(t *testing.T) {
	h := newTaskHarness(t)
	mine := h.user(t, "owner@example.test")
	other := h.user(t, "attacker@example.test")
	tg := h.enrolTarget(t, mine, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "secret-1")
	id, taskID := tg.deviceID, task["ID"].(string)

	// The attacker holds a perfectly valid credential — for their OWN account.
	intruder := h.bearer(t, other, "attacker-cli")
	fileID := h.storedObject(t, other, 10, time.Hour)

	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/devices/" + id + "/inbox/tasks", "", http.StatusNotFound},
		{"GET", "/api/devices/" + id + "/inbox/tasks/" + taskID, "", http.StatusNotFound},
		{"DELETE", "/api/devices/" + id + "/inbox/tasks/" + taskID, "", http.StatusNotFound},
		{"GET", "/api/devices/" + id + "/inbox/pending", "", http.StatusNotFound},
		{"POST", "/api/devices/" + id + "/inbox/claim", `{}`, http.StatusNotFound},
		{"GET", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/blob", "", http.StatusNotFound},
		{"POST", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/report",
			`{"claimToken":"t","state":"saved","errorCode":"","committed":true}`, http.StatusNotFound},
		{"POST", "/api/devices/" + id + "/inbox/tasks/" + taskID + "/accept", `{"accept":true}`, http.StatusNotFound},
	} {
		resp := h.jsonDo(t, c.method, c.path, c.body, withBearer(intruder))
		if resp.StatusCode != c.want {
			t.Fatalf("%s %s cross-account: got %d, want %d", c.method, c.path, resp.StatusCode, c.want)
		}
	}
	// Creating a task aimed at someone else's device is a 404 as well: the API
	// must not confirm that another account's device id exists.
	resp := h.createTask(t, id, createOpts{
		idem: "evil", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(intruder),
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-account create: got %d, want 404", resp.StatusCode)
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskQueued {
		t.Fatalf("a cross-account caller changed the task to %v", got)
	}
}

// TestBrowserInstallationCanSendButCannotSpeakForTheTargetDevice is the
// browser-sender/device-self line.
// A cookie is account-wide: letting a signed-in tab report `saved` would let the
// UI claim a file landed on a machine that never received it.
func TestBrowserInstallationCanSendButCannotSpeakForTheTargetDevice(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "split@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, time.Hour)
	cookie := h.cookie(t, u)
	withCookie := func(r *http.Request) { r.AddCookie(cookie) }

	refused := h.createTask(t, tg.deviceID, createOpts{
		idem: "web-no-device", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen, authMutate: withCookie,
	})
	if refused.StatusCode != http.StatusConflict || apiErrorCode(t, refused) != "sender_device_required" {
		t.Fatalf("cookie-only create: got %d, want 409 sender_device_required", refused.StatusCode)
	}
	install := h.jsonDo(t, "POST", "/api/devices/browser-install", `{}`, withCookie)
	if install.StatusCode != http.StatusCreated || len(install.Cookies()) != 1 {
		t.Fatalf("browser install: got %d and %d cookies", install.StatusCode, len(install.Cookies()))
	}
	deviceCookie := install.Cookies()[0]
	withBrowser := func(r *http.Request) { r.AddCookie(cookie); r.AddCookie(deviceCookie) }

	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "web-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen, authMutate: withBrowser,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("browser create: got %d, want 201", resp.StatusCode)
	}
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	sourceID := task["SourceDeviceID"].(string)
	if sourceID == "" || sourceID == tg.deviceID {
		t.Fatalf("SourceDeviceID = %q, want distinct authenticated browser device", sourceID)
	}
	taskID := task["ID"].(string)

	// But it may not act AS the device.
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/devices/" + tg.deviceID + "/inbox/pending", ""},
		{"POST", "/api/devices/" + tg.deviceID + "/inbox/claim", `{}`},
		{"GET", "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/blob", ""},
		{"POST", "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/report",
			`{"claimToken":"t","state":"saved","errorCode":"","committed":true}`},
		{"POST", "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/accept", `{"accept":true}`},
	} {
		if resp := h.jsonDo(t, c.method, c.path, c.body, withCookie); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("session %s %s: got %d, want 404", c.method, c.path, resp.StatusCode)
		}
	}
	// Reading remains account-scoped, as the sender's UI needs.
	if resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks", withCookie); resp.StatusCode != 200 {
		t.Fatalf("session list: got %d, want 200", resp.StatusCode)
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskQueued {
		t.Fatalf("a session moved the task to %v", got)
	}
}

// TestAnotherOfMyDevicesCannotActAsThisOne: device-self means THIS device row,
// not "any device on the account". A compromised NAS must not be able to finish
// or fail the laptop's transfers.
func TestAnotherOfMyDevicesCannotActAsThisOne(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "twodev@example.test")
	a := h.enrolTarget(t, u, "device-a", inbox.AutoAcceptAuto, true)
	b := h.enrolTarget(t, u, "device-b", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, a, "a-only")
	taskID := task["ID"].(string)

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/devices/" + a.deviceID + "/inbox/pending", ""},
		{"POST", "/api/devices/" + a.deviceID + "/inbox/claim", `{}`},
		{"GET", "/api/devices/" + a.deviceID + "/inbox/tasks/" + taskID + "/blob", ""},
		{"POST", "/api/devices/" + a.deviceID + "/inbox/tasks/" + taskID + "/report",
			`{"claimToken":"t","state":"saved","errorCode":"","committed":true}`},
		{"POST", "/api/devices/" + a.deviceID + "/inbox/tasks/" + taskID + "/accept", `{"accept":true}`},
	} {
		if resp := h.jsonDo(t, c.method, c.path, c.body, withBearer(b.token)); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("device-b %s %s: got %d, want 404", c.method, c.path, resp.StatusCode)
		}
	}
	// A task belonging to device A is not readable through device B's path
	// either, even though both are the same account's.
	if resp := h.do(t, "GET", "/api/devices/"+b.deviceID+"/inbox/tasks/"+taskID, withBearer(b.token)); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-device task read: got %d, want 404", resp.StatusCode)
	}
}

// ---------- strict request shape and the zero-knowledge sweep ----------

// TestCreateRequiresTheDeclaredProtocolVersion covers the ONE non-opaque field
// v2 added to create. It fails closed in both directions: an omitted field is
// not the current version by default, and a version central does not define is
// refused with the actionable set rather than a bare 400.
func TestCreateRequiresTheDeclaredProtocolVersion(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "protocol@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	for _, tc := range []struct {
		name string
		opts createOpts
	}{
		{"omitted", createOpts{omitProtocol: true}},
		{"explicit zero", createOpts{protocol: -1}}, // -1 keeps the helper from defaulting
		{"historical v1", createOpts{protocol: inbox.ProtocolV1}},
		{"future", createOpts{protocol: inbox.ProtocolV3 + 1}},
		{"absurd", createOpts{protocol: 1 << 30}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fileID := h.storedObject(t, u, 32, time.Hour)
			o := tc.opts
			o.idem, o.fileID, o.keyID, o.keyGen = "proto-"+tc.name, fileID, tg.keyID, tg.keyGen
			o.authMutate = withBearer(tg.token)
			resp := h.createTask(t, tg.deviceID, o)
			// 409, not 400: the request is well formed, the two sides simply do
			// not overlap, and the client's correct move is to upgrade.
			if resp.StatusCode != http.StatusConflict {
				t.Fatalf("got %d, want 409", resp.StatusCode)
			}
			body := decodeJSONBody(t, resp)
			if body["error"] != "unsupported_protocol_version" {
				t.Fatalf("error = %v", body["error"])
			}
			// Actionable: the refusal names what central does speak, so a client
			// can say "upgrade" instead of "the send failed".
			got, ok := body["supportedProtocols"].([]any)
			if !ok || len(got) == 0 || got[0] != float64(inbox.ProtocolV3) {
				t.Fatalf("supportedProtocols = %v, want [%d]", body["supportedProtocols"], inbox.ProtocolV3)
			}
			// Fail closed means nothing was written, not "written and reported".
			var n int
			if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil || n != 0 {
				t.Fatalf("rows = %d (err %v), want 0", n, err)
			}
		})
	}

	// And the current version is accepted, so the gate is a gate and not a wall.
	fileID := h.storedObject(t, u, 32, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "proto-ok", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		protocol: inbox.ProtocolV3, authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("current version: got %d, want 201", resp.StatusCode)
	}
	// The declared version is validated, not stored and echoed. Central holds no
	// per-task protocol column, so nothing here can later be mistaken for a
	// description of the delivery's contents.
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	for _, k := range []string{"ProtocolVersion", "protocolVersion", "Kind", "kind"} {
		if _, present := task[k]; present {
			t.Fatalf("the task view exposes %q; central must describe no delivery", k)
		}
	}
}

// TestCreateRejectsUnknownAndSecretShapedFields is the structural half of the
// zero-knowledge promise: there is no field for a content key, a private key, a
// file name or a path, and strict decoding turns an attempt to add one into a
// refusal rather than a silently ignored value.
func TestCreateRejectsUnknownAndSecretShapedFields(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "strict@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 32, time.Hour)

	const marker = "PLAINTEXTMARKER-7f3a"
	for _, extra := range []string{
		`,"contentKey":"` + marker + `"`,
		`,"privateKey":"` + marker + `"`,
		`,"fileName":"` + marker + `.pdf"`,
		`,"destinationPath":"/Users/lily/` + marker + `"`,
		`,"plaintext":"` + marker + `"`,
		`,"state":"saved"`,        // a sender may not start a task saved
		`,"savedAt":123456`,       // nor stamp one
		`,"ciphertextBytes":1`,    // nor describe its own object
		`,"expiresAt":9999999999`, // nor extend its retention
		// v2 moved content KIND into the encrypted manifest. Central must have
		// no field for it and no field for the message itself, or the whole
		// point of sealing the kind is lost: a `kind` here would let central,
		// its logs and its operators tell a message from a file, and a `text`
		// here would hand it the message.
		`,"kind":"text"`,
		`,"contentKind":"text"`,
		`,"text":"` + marker + `"`,
		`,"message":"` + marker + `"`,
		`,"itemCount":1`,
		`,"manifest":"` + marker + `"`,
	} {
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: "strict-" + extra, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
			extraJSON: extra, authMutate: withBearer(tg.token),
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("extra field %s: got %d, want 400", extra, resp.StatusCode)
		}
	}
	// The full-database sweep: nothing a rejected request carried is anywhere.
	if hits := sweepDatabaseForSecrets(t, h.store, []string{marker}); len(hits) > 0 {
		t.Fatalf("a rejected request's value reached storage: %v", hits)
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows = %d (err %v), want 0", n, err)
	}
}

// TestNoTaskColumnCanHoldASecret sweeps every table in the database after a
// COMPLETE successful queue lifecycle, looking for the marker each secret-shaped
// input carried. The claim token is the one bearer in this feature, and only its
// hash may be at rest.
func TestNoSecretReachesStorageAcrossAFullLifecycle(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "sweep@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "sweep-1")
	taskID := task["ID"].(string)

	claimed, token := h.claimOne(t, tg)
	h.report(t, tg, taskID, token, inbox.TaskVerifying, "", false)
	h.report(t, tg, taskID, token, inbox.TaskSaved, "", true)

	// The RAW claim token must exist only in the one response that minted it.
	if hits := sweepDatabaseForSecrets(t, h.store, []string{token}); len(hits) > 0 {
		t.Fatalf("the raw claim token is stored at %v; only its hash may be at rest", hits)
	}
	var storedHash string
	if err := h.store.db.QueryRow(`SELECT claim_token_hash FROM inbox_tasks WHERE id = ?`, taskID).Scan(&storedHash); err != nil {
		t.Fatalf("read claim hash: %v", err)
	}
	if storedHash != authx.HashToken(token) {
		t.Fatalf("claim_token_hash is not the hash of the issued token")
	}
	// The device's PRIVATE key never left the device, so it is nowhere.
	if hits := sweepDatabaseForSecrets(t, h.store,
		[]string{base64.RawURLEncoding.EncodeToString(tg.kp.priv.Bytes())}); len(hits) > 0 {
		t.Fatalf("a device private key reached storage: %v", hits)
	}
	// The sealed key IS stored — it is ciphertext central cannot open — and it
	// is exactly what the sender submitted, unmodified.
	if claimed["WrappedKey"] != sealedKey("sweep-1") {
		t.Fatalf("wrapped key round-tripped as %v", claimed["WrappedKey"])
	}
	// And no account-scoped read returns any of it. The WHOLE response body is
	// scanned, not the parsed task object: a leak added beside the task — a
	// debugging field at the top level, say — is exactly the kind this has to
	// catch.
	secrets := map[string]string{
		"the claim token":        token,
		"the sealed key":         claimed["WrappedKey"].(string),
		"the encrypted manifest": claimed["EncManifest"].(string),
	}
	for _, read := range []struct{ what, path string }{
		{"single-task read", "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID},
		{"task list", "/api/devices/" + tg.deviceID + "/inbox/tasks"},
		{"device list", "/api/devices"},
	} {
		raw, err := io.ReadAll(h.do(t, "GET", read.path, withBearer(tg.token)).Body)
		if err != nil {
			t.Fatalf("read %s: %v", read.what, err)
		}
		for name, secret := range secrets {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("the %s leaked %s", read.what, name)
			}
		}
	}
}

// ---------- deletion, cascade and purge ----------

func TestDeletingATaskLeavesTheStoredObjectAlone(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "del@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 99, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "del-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen, authMutate: withBearer(tg.token),
	})
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)

	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID, withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("delete task: got %d", resp.StatusCode)
	}
	// The task is gone; the user's own stored transfer and its link are not.
	if _, err := h.store.GetStoredFile(context.Background(), fileID); err != nil {
		t.Fatalf("deleting a task destroyed the Stored Object it merely referenced: %v", err)
	}
	if resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID, withBearer(tg.token)); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted task still readable: got %d", resp.StatusCode)
	}
}

func TestDeletingStoredObjectTerminalizesOnlyUnfinishedTasks(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "object-delete@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	queued := h.queueTask(t, tg, "object-delete-queued")
	fileID := queued["StoredFileID"].(string)

	if err := h.store.DeleteStoredFile(context.Background(), fileID, h.nowUnix()); err != nil {
		t.Fatalf("delete stored object: %v", err)
	}
	got := h.taskState(t, tg, queued["ID"].(string))
	if got["State"] != inbox.TaskFailedTerminal || got["ErrorCode"] != inbox.TaskErrStoredObjectUnavailable {
		t.Fatalf("task after object deletion = %v/%v, want failed_terminal/stored_object_unavailable",
			got["State"], got["ErrorCode"])
	}
	if _, err := h.store.GetStoredFile(context.Background(), fileID); err == nil {
		t.Fatal("stored object row survived deletion")
	}

	// A successfully saved task is historical truth and is not retroactively
	// failed when its ciphertext is later removed.
	saved := h.queueTask(t, tg, "object-delete-saved")
	_, token := h.claimOne(t, tg)
	savedID := saved["ID"].(string)
	if resp := h.report(t, tg, savedID, token, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("verifying: %d", resp.StatusCode)
	}
	if resp := h.report(t, tg, savedID, token, inbox.TaskSaved, "", true); resp.StatusCode != 200 {
		t.Fatalf("saved: %d", resp.StatusCode)
	}
	if err := h.store.DeleteStoredFile(context.Background(), saved["StoredFileID"].(string), h.nowUnix()); err != nil {
		t.Fatalf("delete saved object: %v", err)
	}
	if got := h.taskState(t, tg, savedID); got["State"] != inbox.TaskSaved {
		t.Fatalf("saved task changed to %v after object deletion", got["State"])
	}
}

func TestDeletingTheDeviceRemovesItsQueue(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "devdel@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg, "cascade-1")
	h.queueTask(t, tg, "cascade-2")

	cookie := h.cookie(t, u)
	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID, func(r *http.Request) { r.AddCookie(cookie) }); resp.StatusCode != 200 {
		t.Fatalf("delete device: got %d", resp.StatusCode)
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tasks after device delete = %d (err %v), want 0", n, err)
	}
}

func TestClearingTheEnrolmentTerminatesItsQueue(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "clear@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	task := h.queueTask(t, tg, "clear-1")

	// Clearing deletes the whole key history, so the tasks sealed to it become
	// permanently unopenable — they must stop reading as pending deliveries.
	cookie := h.cookie(t, u)
	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox", func(r *http.Request) { r.AddCookie(cookie) }); resp.StatusCode != 200 {
		t.Fatalf("clear enrolment: got %d", resp.StatusCode)
	}
	var state, code string
	if err := h.store.db.QueryRow(`SELECT state, error_code FROM inbox_tasks WHERE id = ?`,
		task["ID"]).Scan(&state, &code); err != nil {
		t.Fatalf("read task: %v", err)
	}
	if state != inbox.TaskRevoked || code != inbox.TaskErrKeyRevoked {
		t.Fatalf("state=%q code=%q, want revoked/key_revoked", state, code)
	}
}

func TestAccountPurgeRemovesEveryOwnedTask(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "purge@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg, "purge-1")

	files, err := h.store.PurgeTransientUserData(context.Background(), u)
	if err != nil {
		t.Fatalf("purge transient: %v", err)
	}
	if len(files) == 0 {
		t.Fatalf("purge returned no stored files to reclaim; blobs would leak")
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks WHERE user_id = ?`, u).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tasks after account purge = %d (err %v), want 0", n, err)
	}
	// The hard purge is independently correct, not merely a repeat of the above.
	u2 := h.user(t, "purge2@example.test")
	tg2 := h.enrolTarget(t, u2, "server2", inbox.AutoAcceptAuto, true)
	h.queueTask(t, tg2, "purge-2")
	if _, err := h.store.db.Exec(`UPDATE users SET purge_after = 1 WHERE id = ?`, u2); err != nil {
		t.Fatalf("schedule purge: %v", err)
	}
	if err := h.store.ArchiveAndPurgeUser(context.Background(), u2, 2); err != nil {
		t.Fatalf("hard purge: %v", err)
	}
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks WHERE user_id = ?`, u2).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tasks after hard purge = %d (err %v), want 0", n, err)
	}
}

// ---------- sweep ----------

func TestSweepExpiresPastTTLReclaimsLeasesAndPrunesTerminalRows(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "sweep2@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	ctx := context.Background()
	retention := int64(inbox.TerminalTaskRetention / time.Second)

	// One task that will be abandoned mid-lease, one that will simply age out.
	abandoned := h.queueTask(t, tg, "sweep-abandoned")
	aging := h.queueTask(t, tg, "sweep-aging")
	_, _ = h.claimOne(t, tg)

	h.advance(inbox.TaskLeaseTTL + time.Second)
	reclaimed, expired, pruned, err := h.store.SweepInboxTasks(ctx, h.nowUnix(), retention)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if reclaimed != 1 || expired != 0 || pruned != 0 {
		t.Fatalf("sweep = %d/%d/%d, want 1 reclaimed only", reclaimed, expired, pruned)
	}
	var state, hash string
	if err := h.store.db.QueryRow(`SELECT state, claim_token_hash FROM inbox_tasks WHERE id = ?`,
		abandoned["ID"]).Scan(&state, &hash); err != nil {
		t.Fatalf("read: %v", err)
	}
	if state != inbox.TaskQueued || hash != "" {
		t.Fatalf("reclaimed row = %q/%q, want queued with no claimant", state, hash)
	}

	// Past the objects' TTL, everything unfinished becomes expired.
	h.advance(2 * time.Hour)
	_, expired, _, err = h.store.SweepInboxTasks(ctx, h.nowUnix(), retention)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 2 {
		t.Fatalf("expired = %d, want 2", expired)
	}
	if err := h.store.db.QueryRow(`SELECT state FROM inbox_tasks WHERE id = ?`, aging["ID"]).Scan(&state); err != nil {
		t.Fatalf("read: %v", err)
	}
	if state != inbox.TaskExpired {
		t.Fatalf("state = %q, want expired", state)
	}

	// Terminal rows survive until retention, then go — this is what bounds the
	// table, so it must not fire early.
	h.advance(inbox.TerminalTaskRetention - time.Hour)
	if _, _, pruned, err = h.store.SweepInboxTasks(ctx, h.nowUnix(), retention); err != nil || pruned != 0 {
		t.Fatalf("pruned %d before retention (err %v), want 0", pruned, err)
	}
	h.advance(2 * time.Hour)
	if _, _, pruned, err = h.store.SweepInboxTasks(ctx, h.nowUnix(), retention); err != nil || pruned != 2 {
		t.Fatalf("pruned %d after retention (err %v), want 2", pruned, err)
	}
}

// ---------- queue bounds ----------

func TestPerDeviceQueueDepthIsBounded(t *testing.T) {
	h := newTaskHarness(t)
	ctx := context.Background()
	u := h.user(t, "depth@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	// Driven through the store so the bound is exercised without the HTTP cost
	// of several hundred round trips.
	for i := 0; i < inbox.MaxPendingTasksPerDevice; i++ {
		fileID := h.storedObject(t, u, 1, time.Hour)
		if _, _, err := h.store.CreateInboxTask(ctx, InboxTask{
			ID: authx.NewID(), UserID: u, TargetDeviceID: tg.deviceID, SourceDeviceID: tg.deviceID,
			IdempotencyKey: fmt.Sprintf("depth-%d", i), StoredFileID: fileID,
			WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1, WrappedKey: sealedKey("k"),
			TargetKeyID: tg.keyID, TargetKeyGeneration: tg.keyGen, CreatedAt: h.nowUnix(),
		}); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	fileID := h.storedObject(t, u, 1, time.Hour)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "over-the-line", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusTooManyRequests || apiErrorCode(t, resp) != "inbox_queue_full" {
		t.Fatalf("over the bound: got %d, want 429 inbox_queue_full", resp.StatusCode)
	}
	// An elapsed TTL frees a slot even before GC: the bound counts genuinely
	// unfinished work, not stale rows waiting for the periodic sweep.
	if _, err := h.store.db.Exec(
		`UPDATE inbox_tasks SET expires_at = ? WHERE idempotency_key = 'depth-0'`,
		h.nowUnix()-1); err != nil {
		t.Fatalf("age one out: %v", err)
	}
	if resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "after-a-slot-freed", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	}); resp.StatusCode != http.StatusCreated {
		t.Fatalf("after a slot freed: got %d, want 201", resp.StatusCode)
	}
}

// ---------- schema-level guarantees ----------

// TestSchemaRefusesImpossibleRows proves the invariants are enforced by the
// database, not only by the code above it. Each INSERT below is one a future
// write path could plausibly attempt.
func TestSchemaRefusesImpossibleRows(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "schema@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)

	base := `INSERT INTO inbox_tasks (id, user_id, target_device_id, source_device_id, idempotency_key, stored_file_id,
	  enc_manifest, wrap_algorithm, wrapped_key, target_key_id, target_key_generation,
	  ciphertext_bytes, state, claim_token_hash, lease_expires_at, saved_at,
	  created_at, updated_at, expires_at) VALUES `
	for name, values := range map[string]string{
		"an invented state":                `('a', ?, ?, ?, 'i1', 'f', x'00', 'alg', 'w', 'k', 1, 0, 'sent',      '',  0, 0, 1, 1, 9)`,
		"a sender-local state":             `('b', ?, ?, ?, 'i2', 'f', x'00', 'alg', 'w', 'k', 1, 0, 'uploading', '',  0, 0, 1, 1, 9)`,
		"a saved timestamp without saved":  `('c', ?, ?, ?, 'i3', 'f', x'00', 'alg', 'w', 'k', 1, 0, 'queued',    '',  0, 7, 1, 1, 9)`,
		"a lease with no claimant":         `('d', ?, ?, ?, 'i4', 'f', x'00', 'alg', 'w', 'k', 1, 0, 'downloading','', 5, 0, 1, 1, 9)`,
		"an empty idempotency key":         `('e', ?, ?, ?, '',   'f', x'00', 'alg', 'w', 'k', 1, 0, 'queued',    '',  0, 0, 1, 1, 9)`,
		"a negative ciphertext byte count": `('f', ?, ?, ?, 'i6', 'f', x'00', 'alg', 'w', 'k', 1, -1,'queued',    '',  0, 0, 1, 1, 9)`,
	} {
		if _, err := h.store.db.Exec(base+values, u, tg.deviceID, tg.deviceID); err == nil {
			t.Fatalf("the database accepted %s", name)
		}
	}
	// The shape that MUST be allowed: a claimant retained after its lease ended,
	// which is what makes a retried final report idempotent.
	if _, err := h.store.db.Exec(base+
		`('ok', ?, ?, ?, 'i7', 'f', x'00', 'alg', 'w', 'k', 1, 0, 'saved', 'hash', 0, 5, 1, 1, 9)`,
		u, tg.deviceID, tg.deviceID); err != nil {
		t.Fatalf("the database refused a legitimately finished row: %v", err)
	}
}

// TestSQLTerminalSetMatchesThePackage keeps the SQL literal used by the sweep,
// the queue-depth count and the revocation update in step with inbox's own
// definition of terminal.
func TestSQLTerminalSetMatchesThePackage(t *testing.T) {
	for _, s := range inbox.TaskStates() {
		inSQL := strings.Contains(terminalStateSQL, "'"+s+"'")
		if inSQL != inbox.IsTerminalTaskState(s) {
			t.Fatalf("terminalStateSQL and inbox disagree about %q (sql=%v pkg=%v)",
				s, inSQL, inbox.IsTerminalTaskState(s))
		}
	}
	for _, s := range inbox.TaskStates() {
		inSQL := strings.Contains(claimableStateSQL, "'"+s+"'")
		want := s == inbox.TaskQueued || s == inbox.TaskNotified
		if inSQL != want {
			t.Fatalf("claimableStateSQL disagrees about %q (sql=%v want=%v)", s, inSQL, want)
		}
	}
}

// TestSchemaStateCheckCoversExactlyThePRDSet reads the CHECK constraint back out
// of the live schema, so adding a state to inbox without adding it here (or the
// reverse) fails rather than silently letting the two drift.
func TestSchemaStateCheckCoversExactlyThePRDSet(t *testing.T) {
	h := newTaskHarness(t)
	var ddl string
	if err := h.store.db.QueryRow(
		`SELECT sql FROM sqlite_master WHERE type='table' AND name='inbox_tasks'`).Scan(&ddl); err != nil {
		t.Fatalf("read schema: %v", err)
	}
	for _, s := range inbox.TaskStates() {
		if !strings.Contains(ddl, "'"+s+"'") {
			t.Fatalf("the state CHECK constraint is missing %q", s)
		}
	}
	for _, s := range []string{inbox.SenderStateEncrypting, inbox.SenderStateUploading} {
		if strings.Contains(ddl, "'"+s+"'") {
			t.Fatalf("the schema allows the sender-local state %q", s)
		}
	}
}
