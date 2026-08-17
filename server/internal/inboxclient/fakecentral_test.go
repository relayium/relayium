package inboxclient

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxmanifest"
	"github.com/relayium/relayium/internal/storecrypto"
)

// inboxManifestJSON writes a Device Inbox v2 manifest's canonical bytes.
//
// Written HERE, by hand, and deliberately NOT through `inboxmanifest.Encode`.
// That encoder validates, so a fixture built on it could only ever pose as a
// WELL-BEHAVED sender — and the traversal, reserved-name and unsupported-kind
// tests all need the opposite: a manifest that authenticates perfectly under the
// real content key and says something this receiver must refuse. A fixture that
// cannot lie cannot test a refusal.
//
// The escaping is `%q`, which agrees with the canonical form for the ASCII names
// these fixtures use and is not a second implementation of the codec's rules.
func inboxManifestJSON(m inboxmanifest.Manifest) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, `{"v":%d,"items":[`, m.V)
	for i, it := range m.Items {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"kind":%q`, string(it.Kind))
		if it.Kind == inboxmanifest.KindFile {
			fmt.Fprintf(&b, `,"name":%q`, it.Name)
		}
		fmt.Fprintf(&b, `,"size":%d}`, it.Size)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

// A controllable stand-in for central's Device Inbox endpoints.
//
// WHY A FAKE AND NOT THE REAL SERVICE. cmd/relayium/inbox_e2e_test.go drives the
// real account.Service, which is what proves the wire contract. What that cannot
// do is produce the situations this worker exists to survive: a tampered frame,
// a truncated body, a server that ignores Range, a lease reclaimed mid-download,
// a `saved` report whose response is lost. Those are the tests that matter here,
// and they need a server that can be told to misbehave.
//
// The fake implements the protocol doc's state machine through the shared
// internal/inbox package rather than a second copy of the rules, so it cannot
// drift into permitting a transition the real server forbids.

type fakeTask struct {
	Task
	encManifest []byte
	wrappedKey  string
	claimToken  string
	plaintext   []byte // framed ciphertext this task's blob serves
}

type reportEvent struct {
	TaskID    string
	State     string
	ErrorCode string
	Committed bool
}

type fakeCentral struct {
	t      *testing.T
	server *httptest.Server

	mu sync.Mutex

	deviceID string
	token    string

	enrolled        bool
	revoked         bool
	autoAccept      string
	caps            []string
	dirReady        bool
	presenceExpires int64

	keys    []Key
	nextKey int

	tasks []*fakeTask

	// Knobs. Each one exists because a real deployment can do it to us.
	protocolVersions []int    // what this "server" speaks
	receiveCaps      []string // receive capabilities it can negotiate
	corruptBlobByte  int      // index of a byte to flip in the served blob; -1 off
	truncateBlobTo   int      // serve only this many bytes; 0 off
	ignoreRange      bool     // answer a Range request with a full 200
	failBlobTimes    int      // fail this many blob requests with 503 first
	dropSavedReport  bool     // lose the response to a `saved` report WITHOUT applying it
	failHeartbeat    int      // fail this many heartbeats first
	staleClaimOnBlob bool     // reject blob reads as stale_claim

	// Observations.
	heartbeats   int
	pendingHits  int
	claimHits    int
	claimMaxes   []int
	blobHits     int
	reports      []reportEvent
	offlineHits  int
	inboxCleared bool
}

func newFakeCentral(t *testing.T) *fakeCentral {
	fc := &fakeCentral{
		t: t, deviceID: "dev-1", token: "rlm_cli_test",
		autoAccept:       inbox.AutoAcceptOff,
		protocolVersions: []int{inbox.ProtocolV2},
		receiveCaps:      []string{inbox.CapReceiveV2},
		corruptBlobByte:  -1,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/devices", fc.auth(fc.listDevices))
	mux.HandleFunc("PUT /api/devices/{id}/inbox", fc.auth(fc.enrol))
	mux.HandleFunc("DELETE /api/devices/{id}/inbox", fc.auth(fc.clearInbox))
	mux.HandleFunc("POST /api/devices/{id}/inbox/keys", fc.auth(fc.registerKey))
	mux.HandleFunc("GET /api/devices/{id}/inbox/keys", fc.auth(fc.listKeys))
	mux.HandleFunc("POST /api/devices/{id}/inbox/heartbeat", fc.auth(fc.heartbeat))
	mux.HandleFunc("POST /api/devices/{id}/inbox/offline", fc.auth(fc.offline))
	mux.HandleFunc("GET /api/devices/{id}/inbox/pending", fc.auth(fc.pending))
	mux.HandleFunc("POST /api/devices/{id}/inbox/claim", fc.auth(fc.claim))
	mux.HandleFunc("GET /api/devices/{id}/inbox/tasks/{taskId}/blob", fc.auth(fc.blob))
	mux.HandleFunc("POST /api/devices/{id}/inbox/tasks/{taskId}/report", fc.auth(fc.report))
	mux.HandleFunc("POST /api/devices/{id}/inbox/tasks/{taskId}/accept", fc.auth(fc.accept))
	fc.server = httptest.NewServer(mux)
	t.Cleanup(fc.server.Close)
	return fc
}

// auth enforces the bearer, exactly as RequireAuth plus deviceSelf do: an
// unauthenticated caller reaches none of this, and a caller that is not this
// device is told 404 rather than 403.
func (fc *fakeCentral) auth(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fc.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if id := r.PathValue("id"); id != "" && id != fc.deviceID {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, token string) {
	writeJSON(w, code, map[string]string{"error": token})
}

func (fc *fakeCentral) inboxView() *InboxView {
	if !fc.enrolled {
		return nil
	}
	v := &InboxView{
		Presence:                 inbox.Presence(fc.presenceExpires, time.Now().Unix(), fc.revoked),
		PresenceExpiresAt:        fc.presenceExpires,
		HeartbeatIntervalSeconds: int(inbox.HeartbeatInterval.Seconds()),
		ProtocolVersion:          inbox.ProtocolV2,
		Capabilities:             fc.caps,
		ReceiveCapability:        inbox.CapReceiveV2,
		AutoAccept:               fc.autoAccept,
		ReceiveDirReady:          fc.dirReady,
		Revoked:                  fc.revoked,
	}
	if k := fc.activeKeyLocked(); k != nil {
		v.Key = k
		v.CanReceive = !fc.revoked
	}
	return v
}

func (fc *fakeCentral) activeKeyLocked() *Key {
	for i := range fc.keys {
		if fc.keys[i].Active() {
			return &fc.keys[i]
		}
	}
	return nil
}

func (fc *fakeCentral) listDevices(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	writeJSON(w, 200, map[string]any{"devices": []Device{{
		ID: fc.deviceID, Name: "test-server", Kind: "cli", Current: true, Inbox: fc.inboxView(),
	}}})
}

func (fc *fakeCentral) enrol(w http.ResponseWriter, r *http.Request) {
	var in EnrolRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.revoked {
		writeErr(w, 409, "device_inbox_revoked")
		return
	}
	version := 0
	for _, v := range in.ProtocolVersions {
		for _, s := range fc.protocolVersions {
			if v == s && v > version {
				version = v
			}
		}
	}
	if version == 0 {
		writeJSON(w, 409, map[string]any{
			"error": "unsupported_protocol_version", "supportedProtocols": fc.protocolVersions})
		return
	}
	receive := ""
	for _, s := range fc.receiveCaps {
		if containsStr(in.Capabilities, s) {
			receive = s
			break
		}
	}
	if receive == "" {
		writeJSON(w, 409, map[string]any{
			"error": "unsupported_capability", "supportedReceiveCapabilities": fc.receiveCaps})
		return
	}
	if in.AutoAccept == inbox.AutoAcceptAuto && !containsStr(in.Capabilities, inbox.CapAutoAcceptV1) {
		writeErr(w, 409, "unsupported_auto_accept_capability")
		return
	}
	fc.enrolled = true
	fc.caps = in.Capabilities
	fc.autoAccept = in.AutoAccept
	fc.dirReady = in.ReceiveDirReady
	writeJSON(w, 200, map[string]any{
		"inbox": fc.inboxView(), "protocolVersion": version,
		"receiveCapability": receive, "keyAlgorithm": inbox.KeyAlgX25519SealedBoxV1,
	})
}

func (fc *fakeCentral) clearInbox(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if !fc.enrolled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	fc.enrolled, fc.keys, fc.inboxCleared = false, nil, true
	for _, t := range fc.tasks {
		if !inbox.IsTerminalTaskState(t.State) {
			t.State, t.ErrorCode = inbox.TaskRevoked, inbox.TaskErrKeyRevoked
		}
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}

func (fc *fakeCentral) registerKey(w http.ResponseWriter, r *http.Request) {
	var in struct{ Algorithm, PublicKey, PreviousKeyID string }
	body, _ := readAllJSON(r)
	in.Algorithm, _ = body["algorithm"].(string)
	in.PublicKey, _ = body["publicKey"].(string)
	in.PreviousKeyID, _ = body["previousKeyId"].(string)

	fc.mu.Lock()
	defer fc.mu.Unlock()
	if !fc.enrolled {
		writeErr(w, 409, "device_inbox_not_registered")
		return
	}
	if _, err := inbox.ValidatePublicKey(in.Algorithm, in.PublicKey); err != nil {
		writeErr(w, 400, "malformed_public_key")
		return
	}
	active := fc.activeKeyLocked()
	// Compare-and-swap, exactly as the real store does: the submitted previous
	// key must be the current one, and re-submitting the active key converges.
	if active != nil && active.PublicKey == in.PublicKey {
		writeJSON(w, 200, map[string]any{"key": *active})
		return
	}
	for _, k := range fc.keys {
		if k.PublicKey == in.PublicKey {
			writeErr(w, 409, "device_key_reused")
			return
		}
	}
	switch {
	case active == nil && in.PreviousKeyID != "":
		writeErr(w, 409, "stale_key_rotation")
		return
	case active != nil && in.PreviousKeyID != active.ID:
		writeErr(w, 409, "stale_key_rotation")
		return
	}
	if active != nil {
		active.SupersededAt = time.Now().Unix()
	}
	fc.nextKey++
	k := Key{
		ID: fmt.Sprintf("key-%d", fc.nextKey), Algorithm: in.Algorithm, PublicKey: in.PublicKey,
		Generation: int64(fc.nextKey), CreatedAt: time.Now().Unix(),
	}
	fc.keys = append(fc.keys, k)
	writeJSON(w, 200, map[string]any{"key": k})
}

func (fc *fakeCentral) listKeys(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	out := make([]Key, 0, len(fc.keys))
	for i := len(fc.keys) - 1; i >= 0; i-- {
		out = append(out, fc.keys[i])
	}
	writeJSON(w, 200, map[string]any{"keys": out})
}

func (fc *fakeCentral) heartbeat(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ReceiveDirReady bool `json:"receiveDirReady"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.heartbeats++
	if fc.failHeartbeat > 0 {
		fc.failHeartbeat--
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !fc.enrolled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if fc.revoked {
		writeErr(w, 409, "device_inbox_revoked")
		return
	}
	fc.dirReady = in.ReceiveDirReady
	fc.presenceExpires = inbox.PresenceExpiry(time.Now())
	writeJSON(w, 200, map[string]any{
		"presence": inbox.PresenceOnline, "presenceExpiresAt": fc.presenceExpires,
		"heartbeatIntervalSeconds": int(inbox.HeartbeatInterval.Seconds()),
	})
}

func (fc *fakeCentral) offline(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.offlineHits++
	fc.presenceExpires = 0
	writeJSON(w, 200, map[string]any{"presence": inbox.PresenceOffline})
}

func (fc *fakeCentral) pending(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.pendingHits++
	out := []Task{}
	for _, t := range fc.tasks {
		switch t.State {
		case inbox.TaskQueued:
			t.State = inbox.TaskNotified // the poll IS the notification
			out = append(out, t.Task)
		case inbox.TaskNotified, inbox.TaskAttentionRequired:
			out = append(out, t.Task)
		}
	}
	writeJSON(w, 200, map[string]any{
		"tasks": out, "leaseSeconds": int(inbox.TaskLeaseTTL.Seconds()),
		"maxClaimBatch": inbox.MaxClaimBatch,
	})
}

func (fc *fakeCentral) claim(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Max int `json:"max"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.claimHits++
	fc.claimMaxes = append(fc.claimMaxes, in.Max)
	if fc.revoked {
		writeErr(w, 409, "device_inbox_revoked")
		return
	}
	max := in.Max
	if max <= 0 || max > inbox.MaxClaimBatch {
		max = inbox.DefaultClaimBatch
	}
	out := []Delivery{}
	for _, t := range fc.tasks {
		if len(out) >= max {
			break
		}
		if t.State != inbox.TaskQueued && t.State != inbox.TaskNotified {
			continue
		}
		t.State = inbox.TaskDownloading
		t.Attempts++
		t.claimToken = randToken()
		t.LeaseExpiresAt = time.Now().Add(inbox.TaskLeaseTTL).Unix()
		out = append(out, Delivery{
			Task: t.Task, EncManifest: base64.StdEncoding.EncodeToString(t.encManifest),
			WrappedKey: t.wrappedKey, ClaimToken: t.claimToken,
		})
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, 200, map[string]any{"tasks": out, "leaseSeconds": int(inbox.TaskLeaseTTL.Seconds())})
}

func (fc *fakeCentral) find(id string) *fakeTask {
	for _, t := range fc.tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (fc *fakeCentral) blob(w http.ResponseWriter, r *http.Request) {
	fc.mu.Lock()
	t := fc.find(r.PathValue("taskId"))
	token := r.Header.Get(ClaimTokenHeader)
	stale := fc.staleClaimOnBlob
	fc.blobHits++
	if fc.failBlobTimes > 0 {
		fc.failBlobTimes--
		fc.mu.Unlock()
		http.Error(w, "storage node offline", http.StatusServiceUnavailable)
		return
	}
	corrupt, truncate, ignoreRange := fc.corruptBlobByte, fc.truncateBlobTo, fc.ignoreRange
	fc.mu.Unlock()

	if t == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// The claim token is required IN ADDITION to the device bearer: a device
	// with several workers must not be able to read another worker's task.
	if stale || token == "" || token != t.claimToken {
		writeErr(w, 409, "stale_claim")
		return
	}
	body := append([]byte{}, t.plaintext...)
	if corrupt >= 0 && corrupt < len(body) {
		body[corrupt] ^= 0x01
	}
	if truncate > 0 && truncate < len(body) {
		body = body[:truncate]
	}
	start := int64(0)
	if h := r.Header.Get("Range"); strings.HasPrefix(h, "bytes=") {
		v := strings.TrimSuffix(strings.TrimPrefix(h, "bytes="), "-")
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			start = n
		}
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, no-store")
	if start > 0 && !ignoreRange {
		if start > int64(len(body)) {
			start = int64(len(body))
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(body)-1, len(body)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(body[start:])
		return
	}
	_, _ = w.Write(body)
}

func (fc *fakeCentral) report(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ClaimToken string `json:"claimToken"`
		State      string `json:"state"`
		ErrorCode  string `json:"errorCode"`
		Committed  bool   `json:"committed"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	t := fc.find(r.PathValue("taskId"))
	if t == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if in.ClaimToken == "" || in.ClaimToken != t.claimToken {
		writeErr(w, 409, "stale_claim")
		return
	}
	if err := inbox.ValidateServerState(in.State); err != nil {
		writeErr(w, 400, "invalid_task_state")
		return
	}
	if !inbox.IsDeviceReportableState(in.State) {
		writeErr(w, 409, "invalid_transition")
		return
	}
	if err := inbox.ValidateDeviceErrorCode(in.ErrorCode); err != nil {
		writeErr(w, 400, "invalid_error_code")
		return
	}
	if in.State == inbox.TaskSaved && !in.Committed {
		writeErr(w, 400, "saved_not_asserted")
		return
	}
	if in.State == inbox.TaskSaved && fc.dropSavedReport {
		// The response is lost BEFORE the transition is applied — a proxy that
		// timed out on the way back. The task therefore stays claimable.
		http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
		return
	}
	fc.reports = append(fc.reports, reportEvent{t.ID, in.State, in.ErrorCode, in.Committed})
	if inbox.IsTerminalTaskState(t.State) {
		writeJSON(w, 409, map[string]any{"error": "task_terminal", "task": t.Task})
		return
	}
	if t.State == in.State { // idempotent progress heartbeat, renews the lease
		t.LeaseExpiresAt = time.Now().Add(inbox.TaskLeaseTTL).Unix()
		writeJSON(w, 200, map[string]any{"task": t.Task})
		return
	}
	if !inbox.CanTransitionTask(t.State, in.State) {
		writeErr(w, 409, "invalid_transition")
		return
	}
	t.State, t.ErrorCode = in.State, in.ErrorCode
	if in.State == inbox.TaskSaved {
		t.SavedAt = time.Now().Unix()
	}
	t.Terminal = inbox.IsTerminalTaskState(t.State)
	writeJSON(w, 200, map[string]any{"task": t.Task})
}

func (fc *fakeCentral) accept(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Accept bool `json:"accept"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	t := fc.find(r.PathValue("taskId"))
	if t == nil || t.State != inbox.TaskAttentionRequired {
		writeErr(w, 409, "invalid_transition")
		return
	}
	if in.Accept {
		t.State, t.ErrorCode = inbox.TaskQueued, inbox.TaskErrNone
	} else {
		t.State, t.ErrorCode, t.Terminal = inbox.TaskFailedTerminal, inbox.TaskErrUserDeclined, true
	}
	writeJSON(w, 200, map[string]any{"task": t.Task})
}

// ---------------------------------------------------------------- test data

type srcFile struct {
	Name string
	Data []byte
}

// enqueue builds a REAL encrypted delivery: a one-time AES-256-GCM content key,
// a storecrypto manifest and frames byte-identical to what `relayium up` and the
// browser produce, and the content key sealed to the device's registered public
// key with libsodium's crypto_box_seal.
//
// Nothing here is a stub. The bytes the worker decrypts in these tests are the
// bytes a real sender would have produced.
func (fc *fakeCentral) enqueue(t *testing.T, files ...srcFile) string {
	t.Helper()
	items := make([]inboxmanifest.Item, 0, len(files))
	payload := make([][]byte, 0, len(files))
	for _, f := range files {
		items = append(items, inboxmanifest.Item{
			Kind: inboxmanifest.KindFile, Name: f.Name, Size: int64(len(f.Data)),
		})
		payload = append(payload, f.Data)
	}
	return fc.enqueueSealed(t, inboxManifestJSON(inboxmanifest.Manifest{
		V: inboxmanifest.Version, Items: items,
	}), payload)
}

// enqueueSealed is the same real delivery with the manifest BYTES chosen by the
// caller, so a test can pose as a sender this receiver must refuse: a v1-shaped
// document, a text delivery, a traversal name, a non-canonical spelling.
func (fc *fakeCentral) enqueueSealed(t *testing.T, manifest []byte, payload [][]byte) string {
	t.Helper()
	fc.mu.Lock()
	active := fc.activeKeyLocked()
	fc.mu.Unlock()
	if active == nil {
		t.Fatal("enqueue before the device registered a public key")
	}
	pubRaw, err := DecodeKeyBytes(active.PublicKey, 32)
	if err != nil {
		t.Fatalf("decode device public key: %v", err)
	}
	var pub [32]byte
	copy(pub[:], pubRaw)

	key, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatalf("content key: %v", err)
	}
	encManifest, err := storecrypto.SealManifest(key, manifest)
	if err != nil {
		t.Fatalf("encrypt manifest: %v", err)
	}
	var blob []byte
	seq := uint64(1)
	for _, data := range payload {
		for off := 0; off < len(data); off += storecrypto.ChunkSize {
			end := min(off+storecrypto.ChunkSize, len(data))
			frame, err := storecrypto.FrameChunk(key, seq, data[off:end])
			if err != nil {
				t.Fatalf("frame: %v", err)
			}
			seq++
			blob = append(blob, frame...)
		}
	}
	sealed, err := box.SealAnonymous(nil, key, &pub, rand.Reader)
	if err != nil {
		t.Fatalf("seal content key: %v", err)
	}

	fc.mu.Lock()
	defer fc.mu.Unlock()
	id := fmt.Sprintf("task-%d", len(fc.tasks)+1)
	fc.tasks = append(fc.tasks, &fakeTask{
		Task: Task{
			ID: id, TargetDeviceID: fc.deviceID, StoredFileID: "sf-" + id,
			State: inbox.TaskQueued, CiphertextBytes: int64(len(blob)),
			WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1,
			TargetKeyID:   active.ID, TargetKeyGeneration: active.Generation,
			CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix(),
		},
		encManifest: encManifest, wrappedKey: EncodeKeyBytes(sealed), plaintext: blob,
	})
	return id
}

// enqueueOversized queues a task whose manifest declares far more plaintext than
// any disk holds, to exercise the free-space preflight. CiphertextBytes is set
// to match so the manifest passes the size cross-check and the SPACE check is
// what refuses it.
func (fc *fakeCentral) enqueueOversized(t *testing.T, declared int64) string {
	t.Helper()
	fc.mu.Lock()
	active := fc.activeKeyLocked()
	fc.mu.Unlock()
	if active == nil {
		t.Fatal("enqueue before the device registered a public key")
	}
	pubRaw, _ := DecodeKeyBytes(active.PublicKey, 32)
	var pub [32]byte
	copy(pub[:], pubRaw)
	key, _ := storecrypto.GenerateKey()
	encManifest, err := storecrypto.SealManifest(key, inboxManifestJSON(inboxmanifest.Manifest{
		V:     inboxmanifest.Version,
		Items: []inboxmanifest.Item{{Kind: inboxmanifest.KindFile, Name: "huge.bin", Size: declared}},
	}))
	if err != nil {
		t.Fatalf("encrypt manifest: %v", err)
	}
	sealed, _ := box.SealAnonymous(nil, key, &pub, rand.Reader)
	fc.mu.Lock()
	defer fc.mu.Unlock()
	id := fmt.Sprintf("task-%d", len(fc.tasks)+1)
	fc.tasks = append(fc.tasks, &fakeTask{
		Task: Task{
			ID: id, TargetDeviceID: fc.deviceID, StoredFileID: "sf-" + id,
			State: inbox.TaskQueued, CiphertextBytes: declared,
			WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1,
			TargetKeyID:   active.ID, TargetKeyGeneration: active.Generation,
			ExpiresAt: time.Now().Add(time.Hour).Unix(),
		},
		encManifest: encManifest, wrappedKey: EncodeKeyBytes(sealed),
	})
	return id
}

// enqueueHostile queues a task whose manifest names a destination outside the
// receive directory. It decrypts and authenticates perfectly; only the name
// rules stop it.
func (fc *fakeCentral) enqueueHostile(t *testing.T, name string) string {
	t.Helper()
	return fc.enqueue(t, srcFile{Name: name, Data: []byte("owned")})
}

func (fc *fakeCentral) taskState(id string) (string, string) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if t := fc.find(id); t != nil {
		return t.State, t.ErrorCode
	}
	return "", ""
}

// requeue puts a task back in the queue, which is what central's lease-expiry
// sweep does to a claimant that stopped reporting.
func (fc *fakeCentral) requeue(id string) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if t := fc.find(id); t != nil {
		t.State, t.claimToken, t.ErrorCode = inbox.TaskQueued, "", inbox.TaskErrLeaseExpired
	}
}

func (fc *fakeCentral) counts() (heartbeats, pending, claims, blobs int) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return fc.heartbeats, fc.pendingHits, fc.claimHits, fc.blobHits
}

func (fc *fakeCentral) requestedClaimMaxes() []int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return append([]int(nil), fc.claimMaxes...)
}

func (fc *fakeCentral) reportedStates(taskID string) []string {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	var out []string
	for _, r := range fc.reports {
		if r.TaskID == taskID {
			out = append(out, r.State)
		}
	}
	return out
}

func containsStr(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

func randToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func readAllJSON(r *http.Request) (map[string]any, error) {
	var m map[string]any
	err := json.NewDecoder(r.Body).Decode(&m)
	return m, err
}

// framedSize reports how many ciphertext bytes a plaintext of n bytes occupies,
// used by the resume test to pick a mid-stream cut point.
func framedSize(n int) int {
	if n == 0 {
		return 0
	}
	frames := (n + storecrypto.ChunkSize - 1) / storecrypto.ChunkSize
	return n + frames*(4+16)
}

var _ = binary.BigEndian
