package account

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storage"
)

// Device Inbox Phase 1D-A acceptance: the task-purpose opaque upload.
//
// PRE-IMPLEMENTATION INVARIANTS. Written before the code and repeated here so a
// reader checks the assertions against the intent rather than against the
// implementation:
//
//  1. SAME MACHINERY. A task-purpose object is an ordinary encrypted Stored
//     Wire object: it consumes the same placement, daily quota, storage cap,
//     traffic cap, max-file-size, TTL/plan retention cap, expiry and GC
//     machinery as a share. No second quota is invented, and none is skipped.
//  2. NO CAPABILITY-LINK SEMANTICS. It is never disclosed or consumed by the
//     public surfaces: `GET /api/files/{id}/meta`, `GET /api/files/{id}/blob`,
//     the account file list, the download-slot/burn counters, or a fleet
//     direct-download receipt. A capability link is a bearer for SHARES only.
//  3. ONE SENDER, ONE BINDING. Only an authenticated same-account caller may
//     upload it, and only that account may bind it — to exactly one task,
//     exactly once. It cannot be reused for a second task, a second device or
//     another account. Idempotency is honest: a retried create carrying the
//     SAME idempotency key converges on the one task that already owns the
//     object; a DIFFERENT key naming a bound object is refused, not silently
//     converged.
//  4. ONE READER. Only the target device holding the current valid claim may
//     stream it, through the task blob endpoint, under every pre-existing
//     device-self / epoch / lease / bounded-stream check.
//  5. NO INVISIBLE QUOTA, NO PREMATURE DELETION. An abandoned upload, a deleted
//     task, an expired/revoked task and a terminal task all release the
//     ciphertext within a bounded window; while a delivery can still legally
//     read the ciphertext it is never deleted. Cleanup that cannot reach a node
//     is retried through the existing pending-delete queue.
//  6. COMPATIBILITY. Share objects, the public download path and the Phase 1B
//     by-reference task path behave exactly as before.

// ---------- harness ----------

// taskObjectHarness is taskHarness plus a real blob store and quota-bearing
// config, because Phase 1D-A is precisely the seam between the upload path and
// the queue and neither half can be faked without erasing the property under
// test.
type taskObjectHarness struct {
	*taskHarness
	blobs storage.BlobStore
}

func newTaskObjectHarness(t *testing.T) *taskObjectHarness {
	t.Helper()
	return newTaskObjectHarnessWithConfig(t, func(c *Config) {})
}

func newTaskObjectHarnessWithConfig(t *testing.T, tweak func(*Config)) *taskObjectHarness {
	t.Helper()
	store := newTestStore(t)
	cfg := Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		MaxFileSize: 1 << 20, DailyQuota: 8 << 20,
		// The default TTL is deliberately several times taskObjectBindGrace.
		// Every cleanup test below advances past the grace and asserts what the
		// RECLAIM pass did; with a TTL at or under the grace the ordinary expiry
		// pass would delete the same rows, and each of those assertions would
		// pass without the reclaim pass existing at all.
		DefaultTTL: 4 * 3600, MaxTTL: 8 * 3600,
		DefaultRetention: retentionTTL,
	}
	tweak(&cfg)
	svc := NewService(store, &capturingMailer{}, cfg)
	svc.nodeHTTP.Transport.(*http.Transport).DialContext = guardedDialContext(true)
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk store: %v", err)
	}
	svc.SetBlobStore(disk)
	clk := new(atomic.Int64)
	clk.Store(time.Now().Unix())
	svc.now = func() time.Time { return time.Unix(clk.Load(), 0) }
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return &taskObjectHarness{
		taskHarness: &taskHarness{
			deviceHarness: &deviceHarness{ts: ts, svc: svc, store: store},
			clock:         clk,
		},
		blobs: disk,
	}
}

// upload posts a single-shot upload with an arbitrary query and returns the
// response, so a test can assert on a refusal as easily as on a success.
func (h *taskObjectHarness) upload(t *testing.T, token, query string, manifest, blob []byte) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(manifest)))
	buf.Write(manifest)
	buf.Write(blob)
	req, err := http.NewRequest("POST", h.ts.URL+"/api/files"+query, &buf)
	if err != nil {
		t.Fatalf("build upload: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// uploadTaskObject uploads one task-purpose object and returns its id.
func (h *taskObjectHarness) uploadTaskObject(t *testing.T, token string, blob []byte) string {
	t.Helper()
	resp := h.upload(t, token, "?purpose=device_task", []byte("opaque-manifest"), blob)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("task-purpose upload: got %d, want 200", resp.StatusCode)
	}
	id, _ := decodeJSONBody(t, resp)["id"].(string)
	if id == "" {
		t.Fatalf("task-purpose upload returned no id")
	}
	return id
}

// uploadShare uploads one ordinary share object and returns its id.
func (h *taskObjectHarness) uploadShare(t *testing.T, token string, blob []byte) string {
	t.Helper()
	resp := h.upload(t, token, "?ttl=3600", []byte("opaque-manifest"), blob)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("share upload: got %d, want 200", resp.StatusCode)
	}
	id, _ := decodeJSONBody(t, resp)["id"].(string)
	return id
}

// storedPurpose reads the persisted purpose straight from the row, so an
// assertion about it cannot be satisfied by a handler that merely reports one.
func (h *taskObjectHarness) storedPurpose(t *testing.T, fileID string) string {
	t.Helper()
	var p string
	if err := h.store.db.QueryRow(`SELECT purpose FROM stored_files WHERE id = ?`, fileID).Scan(&p); err != nil {
		t.Fatalf("read purpose of %s: %v", fileID, err)
	}
	return p
}

func (h *taskObjectHarness) boundTaskID(t *testing.T, fileID string) string {
	t.Helper()
	var id string
	if err := h.store.db.QueryRow(`SELECT inbox_task_id FROM stored_files WHERE id = ?`, fileID).Scan(&id); err != nil {
		t.Fatalf("read binding of %s: %v", fileID, err)
	}
	return id
}

func (h *taskObjectHarness) fileExists(t *testing.T, fileID string) bool {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE id = ?`, fileID).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", fileID, err)
	}
	return n == 1
}

func (h *taskObjectHarness) blobKey(t *testing.T, fileID string) string {
	t.Helper()
	sf, err := h.store.GetStoredFile(context.Background(), fileID)
	if err != nil {
		t.Fatalf("stored file %s: %v", fileID, err)
	}
	return sf.BlobKey
}

func (h *taskObjectHarness) blobExists(t *testing.T, blobKey string) bool {
	t.Helper()
	rc, err := h.blobs.GetRange(context.Background(), blobKey, 0)
	if err != nil {
		return false
	}
	rc.Close()
	return true
}

// gc builds a GC bound to this harness's store, blobs and clock — the real
// sweeper, so a cleanup assertion exercises the production pass rather than a
// test-only reimplementation of it.
func (h *taskObjectHarness) gc() *GC {
	return &GC{
		Store: h.store,
		Blobs: h.blobs,
		Now:   func() int64 { return h.nowUnix() },
		Log:   log.New(io.Discard, "", 0),
		BlobFor: func(ctx context.Context, nodeID string) (storage.BlobStore, error) {
			return h.svc.blobFor(ctx, nodeID)
		},
	}
}

// ---------- 1. persistence and the upload path ----------

func TestTaskPurposeUploadPersistsItsPurpose(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "sender@example.test")
	tok := h.bearer(t, u, "browser")

	fileID := h.uploadTaskObject(t, tok, []byte("ciphertext-bytes"))

	if got := h.storedPurpose(t, fileID); got != StoredPurposeDeviceTask {
		t.Fatalf("purpose = %q, want %q", got, StoredPurposeDeviceTask)
	}
	if got := h.boundTaskID(t, fileID); got != "" {
		t.Fatalf("a fresh task object is bound to %q, want unbound", got)
	}
}

func TestOrdinaryUploadStaysShare(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "share@example.test")
	tok := h.bearer(t, u, "browser")

	fileID := h.uploadShare(t, tok, []byte("ciphertext-bytes"))

	if got := h.storedPurpose(t, fileID); got != StoredPurposeShare {
		t.Fatalf("purpose = %q, want %q", got, StoredPurposeShare)
	}
}

func TestUnknownUploadPurposeIsRefused(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "bogus@example.test")
	tok := h.bearer(t, u, "browser")

	resp := h.upload(t, tok, "?purpose=something_else", []byte("m"), []byte("c"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown purpose: got %d, want 400", resp.StatusCode)
	}
}

// A task-purpose object must be unlimited-until-TTL: the queue refuses a
// limited object because an unrelated reader could spend its final slot. Asking
// for burn/limited retention on one is a contradiction, so it is refused by name
// rather than silently rewritten into something the caller did not ask for.
func TestTaskPurposeUploadRefusesLimitedRetention(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "limited@example.test")
	tok := h.bearer(t, u, "browser")

	for _, q := range []string{
		"?purpose=device_task&burnAfterRead=1",
		"?purpose=device_task&maxDownloads=3",
	} {
		resp := h.upload(t, tok, q, []byte("m"), []byte("c"))
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want 400", q, resp.StatusCode)
		}
	}
}

// The admin-wide default retention policy governs SHARES. A deployment whose
// default is burn-after-read must not silently produce task objects the queue
// will then refuse — the delivery is not a public share and does not inherit a
// share's download-count policy.
func TestTaskPurposeUploadIgnoresBurnDefaultRetention(t *testing.T) {
	h := newTaskObjectHarnessWithConfig(t, func(c *Config) { c.DefaultRetention = retentionBurn })
	u := h.user(t, "burndefault@example.test")
	tok := h.bearer(t, u, "browser")

	fileID := h.uploadTaskObject(t, tok, []byte("ciphertext"))

	sf, err := h.store.GetStoredFile(context.Background(), fileID)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.MaxDownloads != 0 || sf.BurnAfterRead {
		t.Fatalf("task object retention = (maxDownloads %d, burn %t), want unlimited-until-TTL",
			sf.MaxDownloads, sf.BurnAfterRead)
	}
	// The same deployment still burns an ordinary share. Uploaded with NO
	// retention parameters, because naming any of them is what opts out of the
	// admin default — the control has to exercise the default itself.
	resp := h.upload(t, tok, "", []byte("m"), []byte("ciphertext"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("default-retention share upload: got %d, want 200", resp.StatusCode)
	}
	share, err := h.store.GetStoredFile(context.Background(), decodeJSONBody(t, resp)["id"].(string))
	if err != nil {
		t.Fatalf("share stored file: %v", err)
	}
	if share.MaxDownloads != 1 {
		t.Fatalf("share maxDownloads = %d under a burn default, want 1", share.MaxDownloads)
	}
}

// ---------- 2. the public surfaces cannot see it ----------

func TestTaskPurposeObjectIsInvisibleToPublicMetaAndBlob(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "hidden@example.test")
	tok := h.bearer(t, u, "browser")
	taskFile := h.uploadTaskObject(t, tok, []byte("ciphertext"))
	shareFile := h.uploadShare(t, tok, []byte("ciphertext"))

	for _, path := range []string{"/meta", "/blob"} {
		if resp := h.do(t, "GET", "/api/files/"+taskFile+path, nil); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("public %s on a task object: got %d, want 404", path, resp.StatusCode)
		}
		// Even the owner's own authenticated session gets nothing: the public
		// endpoint has ONE rule, and it is not "unless you are the owner".
		if resp := h.do(t, "GET", "/api/files/"+taskFile+path, withBearer(tok)); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("owner-authenticated %s on a task object: got %d, want 404", path, resp.StatusCode)
		}
		if resp := h.do(t, "GET", "/api/files/"+shareFile+path, nil); resp.StatusCode != http.StatusOK {
			t.Fatalf("public %s on a share: got %d, want 200", path, resp.StatusCode)
		}
	}
}

func TestTaskPurposeObjectIsExcludedFromTheAccountFileList(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "list@example.test")
	tok := h.bearer(t, u, "browser")
	taskFile := h.uploadTaskObject(t, tok, []byte("ciphertext"))
	shareFile := h.uploadShare(t, tok, []byte("ciphertext"))

	resp := h.do(t, "GET", "/api/files", withBearer(tok))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list files: got %d, want 200", resp.StatusCode)
	}
	var sawShare bool
	for _, raw := range decodeJSONBody(t, resp)["files"].([]any) {
		id := raw.(map[string]any)["id"].(string)
		if id == taskFile {
			t.Fatalf("the account file list disclosed task object %s", taskFile)
		}
		if id == shareFile {
			sawShare = true
		}
	}
	if !sawShare {
		t.Fatalf("the account file list lost the ordinary share %s", shareFile)
	}
}

// A fleet download receipt refunds metering for bytes a node served under a
// central-issued 302. A task object is never redirected, so a receipt naming its
// blob is either a mistake or a rogue node inventing a refund.
func TestDownloadReceiptRefusesATaskPurposeBlob(t *testing.T) {
	h := newTaskObjectHarnessWithConfig(t, func(c *Config) { c.NodeToken = "fleet-token" })
	u := h.user(t, "receipt@example.test")
	tok := h.bearer(t, u, "browser")
	fileID := h.uploadTaskObject(t, tok, bytes.Repeat([]byte("z"), 512))
	key := h.blobKey(t, fileID)

	// No 302 was ever issued for this object, so nothing was pre-metered. A
	// receipt claiming zero served bytes would, unguarded, refund the whole
	// object size — driving the owner's download meter NEGATIVE, which is the
	// observable form of the accounting hole.
	period := periodOf(h.nowUnix())
	if code := postReceipt(t, h.svc, "fleet-token",
		fmt.Sprintf(`{"blobKey":%q,"nonce":"n1","servedBytes":0}`, key)); code != http.StatusOK {
		t.Fatalf("receipt: got %d, want 200", code)
	}
	if _, down, err := h.store.MonthlyUsage(context.Background(), u, period); err != nil {
		t.Fatalf("monthly usage: %v", err)
	} else if down != 0 {
		t.Fatalf("a receipt moved a task object's download meter to %d, want 0", down)
	}
}

// ---------- 3. binding ----------

// bindTask uploads a task object and queues it to tg, returning (fileID, task).
func (h *taskObjectHarness) bindTask(t *testing.T, tg target, idem string, blob []byte) (string, map[string]any) {
	t.Helper()
	fileID := h.uploadTaskObject(t, tg.token, blob)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: idem, fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create task on a task object: got %d, want 201", resp.StatusCode)
	}
	return fileID, decodeJSONBody(t, resp)["task"].(map[string]any)
}

func TestCreatingATaskBindsItsTaskPurposeObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "bind@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))

	if got, want := h.boundTaskID(t, fileID), task["ID"].(string); got != want {
		t.Fatalf("binding = %q, want the created task %q", got, want)
	}
	if got := task["CiphertextBytes"].(float64); int64(got) != int64(len("ciphertext")) {
		t.Fatalf("CiphertextBytes = %v, want the real uploaded size", got)
	}
}

func TestOwnerFileDeleteCannotRemoveAnUnboundTaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "delete-unbound@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.uploadTaskObject(t, tg.token, []byte("ciphertext"))
	blobKey := h.blobKey(t, fileID)

	resp := h.do(t, "DELETE", "/api/files/"+fileID, withBearer(tg.token))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("delete unbound task object: got %d, want 404", resp.StatusCode)
	}
	if !h.fileExists(t, fileID) || !h.blobExists(t, blobKey) {
		t.Fatal("generic share delete removed a Device Inbox object")
	}
}

func TestOwnerFileDeleteCannotRemoveABoundTaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "delete-bound@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	blobKey := h.blobKey(t, fileID)

	resp := h.do(t, "DELETE", "/api/files/"+fileID, withBearer(tg.token))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("delete bound task object: got %d, want 404", resp.StatusCode)
	}
	if !h.fileExists(t, fileID) || !h.blobExists(t, blobKey) {
		t.Fatal("generic file delete removed a live task's ciphertext")
	}
	if got, want := h.boundTaskID(t, fileID), task["ID"].(string); got != want {
		t.Fatalf("binding after refused delete = %q, want %q", got, want)
	}
}

func TestABoundTaskObjectCannotBeSentTwice(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "rebind@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	other := h.enrolTarget(t, u, "laptop", inbox.AutoAcceptAuto, true)
	fileID, first := h.bindTask(t, tg, "send-1", []byte("ciphertext"))

	// A DIFFERENT idempotency key is a genuinely different send. Converging it
	// on the first task would tell the sender a second delivery was queued.
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-2", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second task on a bound object: got %d, want 409", resp.StatusCode)
	}
	if code := apiErrorCode(t, resp); code != "stored_object_already_bound" {
		t.Fatalf("second task error = %q, want stored_object_already_bound", code)
	}
	// Nor to a second device of the same account.
	resp = h.createTask(t, other.deviceID, createOpts{
		idem: "send-3", fileID: fileID, keyID: other.keyID, keyGen: other.keyGen,
		authMutate: withBearer(other.token),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("cross-device rebind: got %d, want 409", resp.StatusCode)
	}
	if got, want := h.boundTaskID(t, fileID), first["ID"].(string); got != want {
		t.Fatalf("binding moved to %q, want it pinned to %q", got, want)
	}
}

// The honest half of idempotency: the SAME key converges on the one task that
// already owns the object, without rebinding it or creating a second delivery.
func TestRetriedCreateConvergesOnTheBoundTask(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "retry@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, first := h.bindTask(t, tg, "send-1", []byte("ciphertext"))

	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("retried create: got %d, want 200", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["created"].(bool) {
		t.Fatalf("retried create reported a NEW task")
	}
	if got := body["task"].(map[string]any)["ID"].(string); got != first["ID"].(string) {
		t.Fatalf("retried create returned task %q, want %q", got, first["ID"])
	}
	if got, want := h.boundTaskID(t, fileID), first["ID"].(string); got != want {
		t.Fatalf("binding = %q, want %q", got, want)
	}
}

func TestATaskObjectCannotBeSentByAnotherAccount(t *testing.T) {
	h := newTaskObjectHarness(t)
	owner := h.user(t, "owner@example.test")
	ownerTok := h.bearer(t, owner, "owner-browser")
	fileID := h.uploadTaskObject(t, ownerTok, []byte("ciphertext"))

	attacker := h.user(t, "attacker@example.test")
	tg := h.enrolTarget(t, attacker, "attacker-server", inbox.AutoAcceptAuto, true)
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "steal-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("cross-account create: got %d, want 409", resp.StatusCode)
	}
	if code := apiErrorCode(t, resp); code != "stored_object_unavailable" {
		t.Fatalf("cross-account error = %q, want stored_object_unavailable", code)
	}
	if got := h.boundTaskID(t, fileID); got != "" {
		t.Fatalf("a cross-account create bound the object to %q", got)
	}
}

func TestUnknownPersistedPurposeCannotBackATask(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "unknown-purpose-create@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.uploadTaskObject(t, tg.token, []byte("ciphertext"))
	if _, err := h.store.db.Exec(`UPDATE stored_files SET purpose = 'future_kind' WHERE id = ?`, fileID); err != nil {
		t.Fatalf("corrupt purpose: %v", err)
	}

	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("create from unknown purpose: got %d, want 409", resp.StatusCode)
	}
	if code := apiErrorCode(t, resp); code != "stored_object_unavailable" {
		t.Fatalf("create error = %q, want stored_object_unavailable", code)
	}
	if got := h.boundTaskID(t, fileID); got != "" {
		t.Fatalf("unknown-purpose object was bound to task %q", got)
	}
}

// Phase 1B compatibility: a SHARE may still back a task, and doing so neither
// binds it nor stops it being shared with anyone holding the link.
func TestShareBackedTasksKeepPhase1BBehaviour(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "compat@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	second := h.enrolTarget(t, u, "laptop", inbox.AutoAcceptAuto, true)
	shareID := h.uploadShare(t, tg.token, []byte("ciphertext"))

	for i, tgt := range []target{tg, second} {
		resp := h.createTask(t, tgt.deviceID, createOpts{
			idem: fmt.Sprintf("share-send-%d", i), fileID: shareID,
			keyID: tgt.keyID, keyGen: tgt.keyGen, authMutate: withBearer(tgt.token),
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("share-backed task %d: got %d, want 201", i, resp.StatusCode)
		}
	}
	if got := h.boundTaskID(t, shareID); got != "" {
		t.Fatalf("a share was bound to task %q; Phase 1B references must not bind", got)
	}
	if resp := h.do(t, "GET", "/api/files/"+shareID+"/meta", nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("share meta after being referenced: got %d, want 200", resp.StatusCode)
	}
}

// ---------- 4. only the claim holder reads it ----------

func TestOnlyTheClaimHolderStreamsATaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "stream@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	payload := bytes.Repeat([]byte("c"), 300)
	_, task := h.bindTask(t, tg, "send-1", payload)
	taskID := task["ID"].(string)
	blobPath := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + taskID + "/blob"

	// Before any claim: the device itself cannot read it.
	if resp := h.do(t, "GET", blobPath, withBearer(tg.token)); resp.StatusCode != http.StatusConflict {
		t.Fatalf("unclaimed blob read: got %d, want 409", resp.StatusCode)
	}
	_, claim := h.claimOne(t, tg)

	// A wrong claim token is refused even from the right device.
	resp := h.do(t, "GET", blobPath, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+tg.token)
		r.Header.Set("X-Relayium-Inbox-Claim", "not-the-claim")
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("wrong claim token: got %d, want 409", resp.StatusCode)
	}

	// The account session is not the device.
	resp = h.do(t, "GET", blobPath, func(r *http.Request) {
		r.AddCookie(h.cookie(t, u))
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("session-authenticated blob read: got %d, want 404", resp.StatusCode)
	}

	// The claim holder gets exactly the ciphertext.
	resp = h.do(t, "GET", blobPath, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+tg.token)
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim-holder blob read: got %d, want 200", resp.StatusCode)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read streamed ciphertext: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("streamed %d bytes, want the %d uploaded", len(got), len(payload))
	}
}

func TestUnknownPersistedPurposeCannotBeStreamedByATask(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "unknown-purpose-read@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	if _, err := h.store.db.Exec(`UPDATE stored_files SET purpose = 'future_kind' WHERE id = ?`, fileID); err != nil {
		t.Fatalf("corrupt purpose: %v", err)
	}
	_, claim := h.claimOne(t, tg)

	resp := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+task["ID"].(string)+"/blob",
		func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+tg.token)
			r.Header.Set("X-Relayium-Inbox-Claim", claim)
		})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("unknown-purpose ciphertext read: got %d, want 409", resp.StatusCode)
	}
}

// A task object bound to task A must not be reachable through task B, even when
// both belong to the same account and the same device. The binding is checked at
// authorization time, not merely at creation.
func TestATaskObjectIsNotReachableThroughAnotherTask(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "crosstask@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileA, taskA := h.bindTask(t, tg, "send-a", []byte("payload-a"))
	_, taskB := h.bindTask(t, tg, "send-b", []byte("payload-b"))

	// Repoint task B at A's object behind the API's back: the store-level
	// binding check is what has to refuse it.
	if _, err := h.store.db.Exec(`UPDATE inbox_tasks SET stored_file_id = ? WHERE id = ?`,
		fileA, taskB["ID"].(string)); err != nil {
		t.Fatalf("repoint task B: %v", err)
	}
	_ = taskA
	// Claim both, then try to read A's ciphertext through B.
	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/claim", `{"max":8}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim: got %d, want 200", resp.StatusCode)
	}
	var claimB string
	for _, raw := range decodeJSONBody(t, resp)["tasks"].([]any) {
		task := raw.(map[string]any)
		if task["ID"].(string) == taskB["ID"].(string) {
			claimB = task["ClaimToken"].(string)
		}
	}
	if claimB == "" {
		t.Fatalf("task B was not claimed")
	}
	got := h.do(t, "GET", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskB["ID"].(string)+"/blob",
		func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+tg.token)
			r.Header.Set("X-Relayium-Inbox-Claim", claimB)
		})
	if got.StatusCode != http.StatusConflict {
		t.Fatalf("cross-task ciphertext read: got %d, want 409", got.StatusCode)
	}
}

// ---------- 5. cleanup ----------

// An upload that is never bound is invisible quota. It must be reclaimed after a
// bounded grace window — and not one second before, because the sender binds it
// moments after the upload finishes.
func TestUnboundTaskObjectIsReclaimedAfterTheBindGrace(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "orphan@example.test")
	tok := h.bearer(t, u, "browser")
	fileID := h.uploadTaskObject(t, tok, []byte("ciphertext"))
	key := h.blobKey(t, fileID)

	h.gc().sweep(context.Background())
	if !h.fileExists(t, fileID) {
		t.Fatalf("a just-uploaded task object was reclaimed inside its bind grace")
	}

	h.advance(taskObjectBindGrace + time.Minute)
	h.gc().sweep(context.Background())
	if h.fileExists(t, fileID) {
		t.Fatalf("an abandoned task object survived the bind grace")
	}
	if h.blobExists(t, key) {
		t.Fatalf("an abandoned task object's ciphertext survived the bind grace")
	}
}

func TestBoundTaskObjectSurvivesWhileItsDeliveryIsLive(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "live@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, _ := h.bindTask(t, tg, "send-1", []byte("ciphertext"))

	// Past the bind grace but far inside the object's TTL: the only thing that
	// could delete it here is the reclaim pass, and it must not.
	h.advance(taskObjectBindGrace + time.Minute)
	h.gc().sweep(context.Background())

	if !h.fileExists(t, fileID) {
		t.Fatalf("GC deleted the ciphertext of a live delivery")
	}
}

func TestTerminalTaskReleasesItsTaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "saved@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)
	taskID := task["ID"].(string)

	_, claim := h.claimOne(t, tg)
	if resp := h.report(t, tg, taskID, claim, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("report verifying: got %d", resp.StatusCode)
	}
	if resp := h.report(t, tg, taskID, claim, inbox.TaskSaved, "", true); resp.StatusCode != 200 {
		t.Fatalf("report saved: got %d", resp.StatusCode)
	}

	h.gc().sweep(context.Background())
	if h.fileExists(t, fileID) {
		t.Fatalf("a saved delivery's ciphertext was retained")
	}
	if h.blobExists(t, key) {
		t.Fatalf("a saved delivery's blob was retained")
	}
	// The task row itself survives for the sender's UI, with its truthful state.
	if got := h.taskState(t, tg, taskID)["State"].(string); got != inbox.TaskSaved {
		t.Fatalf("task state after ciphertext release = %q, want saved", got)
	}
}

// Deleting the task deletes the ciphertext it owns. This is the one place a task
// DOES own its object: there is no share link to break, so leaving the row would
// strand quota the sender can no longer see or reach.
func TestDeletingATaskDeletesTheTaskObjectItOwns(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "cancel@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)

	resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+task["ID"].(string), withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete task: got %d, want 200", resp.StatusCode)
	}
	if h.fileExists(t, fileID) {
		t.Fatalf("deleting the task left its owned ciphertext behind")
	}
	if h.blobExists(t, key) {
		t.Fatalf("deleting the task left its owned blob behind")
	}
}

// The card's queued-state snapshot can become stale while its confirmation is
// open. Cancellation therefore has to re-check the state in the same database
// statement that deletes: once the receiver has a lease, neither the task nor
// its owned ciphertext may disappear underneath it.
func TestDeletingAnInProgressTaskPreservesItsTaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "cancel-race@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)
	taskID := task["ID"].(string)

	claimed, _ := h.claimOne(t, tg)
	if claimed["ID"] != taskID || claimed["State"] != inbox.TaskDownloading {
		t.Fatalf("claim = %v/%v, want %s/downloading", claimed["ID"], claimed["State"], taskID)
	}
	resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID, withBearer(tg.token))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("delete in-progress task: got %d, want 409", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["error"] != "invalid_transition" {
		t.Fatalf("delete error = %v, want invalid_transition", body["error"])
	}
	if got := h.taskState(t, tg, taskID)["State"]; got != inbox.TaskDownloading {
		t.Fatalf("task after refused cancellation = %v, want downloading", got)
	}
	if !h.fileExists(t, fileID) || !h.blobExists(t, key) {
		t.Fatal("refused cancellation deleted ciphertext under the active receiver")
	}
}

// Deleting a SHARE-backed task still leaves the share alone (Phase 1B).
func TestDeletingAShareBackedTaskKeepsTheShare(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "keepshare@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	shareID := h.uploadShare(t, tg.token, []byte("ciphertext"))
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-1", fileID: shareID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d, want 201", resp.StatusCode)
	}
	taskID := decodeJSONBody(t, resp)["task"].(map[string]any)["ID"].(string)

	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID+"/inbox/tasks/"+taskID, withBearer(tg.token)); resp.StatusCode != 200 {
		t.Fatalf("delete task: got %d, want 200", resp.StatusCode)
	}
	if !h.fileExists(t, shareID) {
		t.Fatalf("deleting a share-backed task destroyed the share")
	}
	if resp := h.do(t, "GET", "/api/files/"+shareID+"/meta", nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("share meta after its task was deleted: got %d, want 200", resp.StatusCode)
	}
}

// A cleanup that cannot reach the node must not silently drop the blob: it goes
// on the existing retry queue instead.
func TestUnreachableNodeCleanupIsQueuedForRetry(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "unreachable@example.test")
	tok := h.bearer(t, u, "browser")
	fileID := h.uploadTaskObject(t, tok, []byte("ciphertext"))
	key := h.blobKey(t, fileID)
	// Pretend the object landed on a node central can no longer resolve.
	if _, err := h.store.db.Exec(`UPDATE stored_files SET node_id = 'gone-node' WHERE id = ?`, fileID); err != nil {
		t.Fatalf("repoint node: %v", err)
	}

	h.advance(taskObjectBindGrace + time.Minute)
	h.gc().sweep(context.Background())

	if h.fileExists(t, fileID) {
		t.Fatalf("an abandoned task object survived because its node was unreachable")
	}
	pending, err := h.store.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("list pending deletes: %v", err)
	}
	var queued bool
	for _, p := range pending {
		if p.BlobKey == key {
			queued = true
		}
	}
	if !queued {
		t.Fatalf("an unreachable node's orphan blob %q was not queued for retry", key)
	}
}

// Revoking the key the task was sealed to makes the delivery impossible: no
// private key can open that ciphertext again, including the target's. Holding
// the bytes after that is pure invisible quota.
func TestRevokedKeyReleasesItsTaskObject(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "revoke@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)

	resp := h.jsonDo(t, "POST", "/api/devices/"+tg.deviceID+"/inbox/keys/"+tg.keyID+"/revoke", `{}`, withBearer(tg.token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke key: got %d, want 200", resp.StatusCode)
	}
	if got := h.taskState(t, tg, task["ID"].(string))["State"].(string); got != inbox.TaskRevoked {
		t.Fatalf("task state after key revocation = %q, want revoked", got)
	}

	h.gc().sweep(context.Background())
	if h.fileExists(t, fileID) {
		t.Fatalf("a revoked delivery's ciphertext was retained")
	}
	if h.blobExists(t, key) {
		t.Fatalf("a revoked delivery's blob was retained")
	}
}

// Deleting the device cascades the task away. The object is then bound to a task
// that no longer exists — unreachable by anyone — so GC must reclaim it rather
// than leave it pinned by a dangling binding forever.
func TestDeletingTheTargetDeviceReleasesItsTaskObjects(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "devicegone@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, _ := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)

	if resp := h.do(t, "DELETE", "/api/devices/"+tg.deviceID, withBearer(tg.token)); resp.StatusCode != http.StatusOK {
		t.Fatalf("delete device: got %d, want 200", resp.StatusCode)
	}

	h.gc().sweep(context.Background())
	if h.fileExists(t, fileID) {
		t.Fatalf("a deleted device's delivery ciphertext was retained")
	}
	if h.blobExists(t, key) {
		t.Fatalf("a deleted device's delivery blob was retained")
	}
}

// Two creates racing for one object: exactly one binds. Both the application's
// conditional UPDATE and the partial unique index enforce this, and the property
// must hold whichever wins the race.
func TestConcurrentCreatesBindOneObjectOnce(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "race@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.uploadTaskObject(t, tg.token, []byte("ciphertext"))

	const racers = 8
	var wg sync.WaitGroup
	codes := make([]int, racers)
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp := h.createTask(t, tg.deviceID, createOpts{
				idem:       fmt.Sprintf("race-%d", i),
				fileID:     fileID,
				keyID:      tg.keyID,
				keyGen:     tg.keyGen,
				authMutate: withBearer(tg.token),
			})
			codes[i] = resp.StatusCode
		}()
	}
	wg.Wait()

	created := 0
	for i, c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
		default:
			t.Fatalf("racer %d: got %d, want 201 or 409", i, c)
		}
	}
	if created != 1 {
		t.Fatalf("%d racers created a task for one object, want exactly 1", created)
	}
	var bound int
	if err := h.store.db.QueryRow(
		`SELECT COUNT(*) FROM inbox_tasks WHERE stored_file_id = ?`, fileID).Scan(&bound); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	if bound != 1 {
		t.Fatalf("%d tasks reference the object, want 1", bound)
	}
}

// ---------- 6. parity with an ordinary upload ----------

func TestTaskPurposeUploadConsumesTheSameQuotaAndMeters(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "quota@example.test")
	tok := h.bearer(t, u, "browser")
	ctx := context.Background()

	fileID := h.uploadTaskObject(t, tok, bytes.Repeat([]byte("z"), 4096))

	used, err := h.store.UserUploadedSince(ctx, u, 0)
	if err != nil {
		t.Fatalf("uploaded since: %v", err)
	}
	if used != minBillableBytes {
		t.Fatalf("daily-quota debit = %d, want the %d floor an ordinary upload pays", used, minBillableBytes)
	}
	stored, err := h.store.CurrentStorage(ctx, u, h.nowUnix())
	if err != nil {
		t.Fatalf("current storage: %v", err)
	}
	if stored != 4096 {
		t.Fatalf("storage usage = %d, want the object's 4096 ciphertext bytes", stored)
	}
	stats, err := h.store.GetUserStats(ctx, u)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if stats.UploadBytes != 4096 {
		t.Fatalf("upload stat = %d, want 4096", stats.UploadBytes)
	}
	sf, err := h.store.GetStoredFile(ctx, fileID)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.ExpiresAt != h.nowUnix()+4*3600 {
		t.Fatalf("expiry = %d, want the same DefaultTTL a share gets (%d)", sf.ExpiresAt, h.nowUnix()+4*3600)
	}
}

func TestTaskPurposeUploadIsRefusedOverTheDailyQuota(t *testing.T) {
	h := newTaskObjectHarnessWithConfig(t, func(c *Config) { c.DailyQuota = minBillableBytes })
	u := h.user(t, "overquota@example.test")
	tok := h.bearer(t, u, "browser")

	if resp := h.upload(t, tok, "?purpose=device_task", []byte("m"), []byte("x")); resp.StatusCode != http.StatusOK {
		t.Fatalf("first task upload: got %d, want 200", resp.StatusCode)
	}
	resp := h.upload(t, tok, "?purpose=device_task", []byte("m"), []byte("x"))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second task upload over quota: got %d, want 429", resp.StatusCode)
	}
}

func TestTaskPurposeUploadHonoursPlanStorageAndTrafficCaps(t *testing.T) {
	for _, tc := range []struct {
		name, email      string
		storage, traffic int64
		want             int
	}{
		{name: "storage", email: "plan-storage@example.test", storage: 10, traffic: 1 << 30, want: http.StatusRequestEntityTooLarge},
		{name: "traffic", email: "plan-traffic@example.test", storage: 1 << 30, traffic: 10, want: http.StatusTooManyRequests},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTaskObjectHarness(t)
			u := h.user(t, tc.email)
			tok := h.bearer(t, u, "browser")
			setUserPlanWith(t, h.store, u, tc.storage, tc.traffic, 3*86400)

			resp := h.upload(t, tok, "?purpose=device_task", []byte("m"), bytes.Repeat([]byte("x"), 50))
			if resp.StatusCode != tc.want {
				t.Fatalf("task upload over plan %s cap: got %d, want %d", tc.name, resp.StatusCode, tc.want)
			}
		})
	}
}

func TestTaskPurposeUploadTTLIsClampedToThePlan(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "plan-retention@example.test")
	tok := h.bearer(t, u, "browser")
	const retention = int64(600)
	setUserPlanWith(t, h.store, u, 1<<30, 1<<30, retention)

	fileID := h.uploadTaskObject(t, tok, []byte("ciphertext"))
	sf, err := h.store.GetStoredFile(context.Background(), fileID)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if got, want := sf.ExpiresAt, h.nowUnix()+retention; got != want {
		t.Fatalf("task object expiry = %d, want plan-clamped %d", got, want)
	}
}

// The object expires on its own TTL like any other, and its task expires with
// it — the TTL machinery is shared, not re-implemented.
func TestTaskObjectExpiryTerminalisesItsTask(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "ttl@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID, task := h.bindTask(t, tg, "send-1", []byte("ciphertext"))
	key := h.blobKey(t, fileID)

	h.advance(5 * time.Hour) // past the 4h DefaultTTL
	h.gc().sweep(context.Background())

	if h.fileExists(t, fileID) {
		t.Fatalf("an expired task object survived GC")
	}
	if h.blobExists(t, key) {
		t.Fatalf("an expired task object's blob survived GC")
	}
	if got := h.taskState(t, tg, task["ID"].(string))["State"].(string); got != inbox.TaskExpired {
		t.Fatalf("task state after object expiry = %q, want expired", got)
	}
}

// ---------- 7. the resumable path ----------

func TestResumableTaskPurposeUpload(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "resumable@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	payload := bytes.Repeat([]byte("R"), 900)

	fileID := h.resumableUpload(t, tg.token, "&purpose=device_task", []byte("opaque-manifest"), payload)
	if got := h.storedPurpose(t, fileID); got != StoredPurposeDeviceTask {
		t.Fatalf("resumable purpose = %q, want %q", got, StoredPurposeDeviceTask)
	}
	if resp := h.do(t, "GET", "/api/files/"+fileID+"/meta", nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("public meta on a resumable task object: got %d, want 404", resp.StatusCode)
	}
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "send-1", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create task on a resumable task object: got %d, want 201", resp.StatusCode)
	}
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	if int64(task["CiphertextBytes"].(float64)) != int64(len(payload)) {
		t.Fatalf("CiphertextBytes = %v, want %d", task["CiphertextBytes"], len(payload))
	}
	if got, want := h.boundTaskID(t, fileID), task["ID"].(string); got != want {
		t.Fatalf("binding = %q, want %q", got, want)
	}
}

func TestResumableUploadRefusesAnUnknownPurpose(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "resumable-bogus@example.test")
	tok := h.bearer(t, u, "browser")

	var body bytes.Buffer
	_ = binary.Write(&body, binary.BigEndian, uint32(1))
	body.WriteByte('m')
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads?size=1&purpose=nope", &body)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("resumable init with an unknown purpose: got %d, want 400", resp.StatusCode)
	}
}

// resumableUpload runs init → chunks → finalize and returns the new file id.
func (h *taskObjectHarness) resumableUpload(t *testing.T, token, extraQuery string, manifest, payload []byte) string {
	t.Helper()
	var body bytes.Buffer
	_ = binary.Write(&body, binary.BigEndian, uint32(len(manifest)))
	body.Write(manifest)
	req, _ := http.NewRequest("POST",
		h.ts.URL+"/api/uploads?size="+strconv.Itoa(len(payload))+extraQuery, &body)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("upload init: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload init: got %d, want 200", resp.StatusCode)
	}
	uploadID, _ := decodeJSONBody(t, resp)["uploadId"].(string)
	if uploadID == "" {
		t.Fatalf("upload init returned no uploadId")
	}
	for start := 0; start < len(payload); start += 300 {
		end := min(start+300, len(payload))
		creq, _ := http.NewRequest("PATCH", h.ts.URL+"/api/uploads/"+uploadID, bytes.NewReader(payload[start:end]))
		creq.Header.Set("Authorization", "Bearer "+token)
		creq.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, len(payload)))
		cresp, err := h.ts.Client().Do(creq)
		if err != nil {
			t.Fatalf("chunk %d: %v", start, err)
		}
		cresp.Body.Close()
		if cresp.StatusCode != http.StatusOK {
			t.Fatalf("chunk %d: got %d, want 200", start, cresp.StatusCode)
		}
	}
	freq, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	freq.Header.Set("Authorization", "Bearer "+token)
	fresp, err := h.ts.Client().Do(freq)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finalize: got %d, want 200", fresp.StatusCode)
	}
	id, _ := decodeJSONBody(t, fresp)["id"].(string)
	if id == "" {
		t.Fatalf("finalize returned no id")
	}
	return id
}

// ---------- 8. migration ----------

// A database written before Phase 1D-A has neither column. Opening it must add
// both, read every pre-existing row as an ordinary share, and leave the public
// download path working — a share must not become invisible because a column
// appeared.
func TestMigrationTreatsPreExistingObjectsAsShares(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "migrate@example.test")
	tok := h.bearer(t, u, "browser")
	fileID := h.uploadShare(t, tok, []byte("ciphertext"))

	// Simulate the pre-migration shape by clearing the new columns to what an
	// old row would have carried: they did not exist, so supplying their value
	// is exactly the migration's job.
	if _, err := h.store.db.Exec(`UPDATE stored_files SET purpose = '', inbox_task_id = '' WHERE id = ?`, fileID); err != nil {
		t.Fatalf("blank the new columns: %v", err)
	}
	if err := backfillStoredFilePurpose(context.Background(), h.store.db); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if got := h.storedPurpose(t, fileID); got != StoredPurposeShare {
		t.Fatalf("backfilled purpose = %q, want %q", got, StoredPurposeShare)
	}
	if resp := h.do(t, "GET", "/api/files/"+fileID+"/meta", nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("public meta after migration: got %d, want 200", resp.StatusCode)
	}
}
