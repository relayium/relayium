package account

// Shared fixtures for the residual-billing tests (upload_residual_*_test.go and
// unbilled_meter_ownership_test.go).
//
// A RESIDUAL is what an upload's blob physically holds past the `received`
// offset central recorded: an append the node committed and then answered 500
// to, with the read-back probe failing too, leaves the node holding more than
// central knows. These fixtures stage exactly that on a real disk-backed node
// served over HTTP, and drive it through the real handlers, the real reaper
// (Service.ReapPendingUploads) and the real GC sweep.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The confirmed shape: 1200 bytes acknowledged and billed, then a 3000-byte
// append the node commits and answers 500 to.
const (
	residualAcked   = 1200
	residualUnacked = 3000
	residualOnNode  = residualAcked + residualUnacked
)

// stageResidual builds that shape on an ORDINARY (non-pair) upload: the node
// holds 4200 bytes, central recorded 1200, and the probe still fails (the node
// is dark). byo places the upload on the user's own node instead of the fleet.
func stageResidual(t *testing.T, h *pairHarness, byo bool) (uploadID string, node *commitThenFailNode, sess UploadSessionRow) {
	t.Helper()
	node = newCommitThenFailNode(t)
	if byo {
		h.registerOwnStorageNode(t, node.URL)
	} else {
		h.registerStorageNode(t, node.URL)
	}
	blob := bytes.Repeat([]byte("W"), residualOnNode)
	uploadID = initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), residualOnNode, 0)
	sess = h.session(t, uploadID)
	if sess.NodeID == "" {
		t.Fatal("setup: the upload was not placed on the switchable node")
	}
	if sess.Billable == byo {
		t.Fatalf("setup: billable=%v for byo=%v", sess.Billable, byo)
	}
	if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, residualAcked, residualOnNode); code != 200 {
		t.Fatalf("setup: first chunk %d", code)
	}
	node.failAfterCommit.Store(true)
	node.failProbe.Store(true)
	if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, residualAcked, residualOnNode, residualOnNode); code != 500 {
		t.Fatalf("setup: failed append %d, want 500", code)
	}
	if got := nodeBlobSize(t, node.dir, sess.BlobKey); got != residualOnNode {
		t.Fatalf("setup: node holds %d, want %d", got, residualOnNode)
	}
	if got := h.session(t, uploadID).Received; got != residualAcked {
		t.Fatalf("setup: central recorded %d, want %d", got, residualAcked)
	}
	return uploadID, node, h.session(t, uploadID)
}

// claimDone is a finalize that crashed right after its durable terminal claim.
func claimDone(t *testing.T, h *pairHarness, uploadID string) {
	t.Helper()
	if _, _, ok, err := h.store.ClaimUploadDone(context.Background(), uploadID, h.now); err != nil || !ok {
		t.Fatalf("terminal claim: ok=%v err=%v", ok, err)
	}
}

// gcSweep runs one real GC sweep: pending-delete drain, owed bills, pair-room
// backstop.
func gcSweep(h *pairHarness) {
	g := &GC{Store: h.store, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0),
		BlobFor: h.svc.blobFor, SweepPairRooms: h.svc.SweepPairRooms}
	g.sweep(context.Background())
}

// reapIdle moves the clock past the idle TTL and runs the real reaper.
func reapIdle(h *pairHarness) {
	h.advance(pendingUploadTTL + 1)
	h.svc.ReapPendingUploads(h.now)
}

// provenanceOf reads one session's residual_provenance through the harness.
func (h *pairHarness) provenanceOf(t *testing.T, uploadID string) int64 {
	t.Helper()
	var v int64
	if err := h.store.db.QueryRow(`SELECT residual_provenance FROM upload_sessions WHERE id = ?`, uploadID).Scan(&v); err != nil {
		t.Fatalf("residual_provenance(%s): %v", uploadID, err)
	}
	return v
}

// refuseBillingWrites installs (on=true) or removes private SQLite triggers
// that make the meter refuse every write — and, with journal=true, the
// owed-bills outbox refuse its INSERT too: the database refusing exactly the
// writes that would make a residual durable.
func refuseBillingWrites(t *testing.T, h *pairHarness, on, journal bool) {
	t.Helper()
	stmts := []string{
		`DROP TRIGGER IF EXISTS test_refuse_meter_ins`,
		`DROP TRIGGER IF EXISTS test_refuse_meter_upd`,
		`DROP TRIGGER IF EXISTS test_refuse_owed_ins`,
	}
	if on {
		stmts = []string{
			`CREATE TRIGGER test_refuse_meter_ins BEFORE INSERT ON usage_monthly BEGIN SELECT RAISE(FAIL, 'injected meter fault'); END`,
			`CREATE TRIGGER test_refuse_meter_upd BEFORE UPDATE ON usage_monthly BEGIN SELECT RAISE(FAIL, 'injected meter fault'); END`,
		}
		if journal {
			stmts = append(stmts,
				`CREATE TRIGGER test_refuse_owed_ins BEFORE INSERT ON unbilled_meter BEGIN SELECT RAISE(FAIL, 'injected outbox fault'); END`)
		}
	}
	for _, q := range stmts {
		if _, err := h.store.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
}

// meteredFor is a user's upload meter for the period containing at.
func meteredFor(t *testing.T, h *pairHarness, userID string, at int64) int64 {
	t.Helper()
	up, _, err := h.store.MonthlyUsage(context.Background(), userID, time.Unix(at, 0).UTC().Format("200601"))
	if err != nil {
		t.Fatal(err)
	}
	return up
}

// archivedUpload is the anonymized archive's upload total for the period
// containing at.
func archivedUpload(t *testing.T, h *pairHarness, at int64) int64 {
	t.Helper()
	var up int64
	err := h.store.db.QueryRow(`SELECT upload_bytes FROM usage_archive WHERE period = ?`,
		time.Unix(at, 0).UTC().Format("200601")).Scan(&up)
	if err != nil && !strings.Contains(err.Error(), "no rows") {
		t.Fatal(err)
	}
	return up
}

// owedFor counts a user's rows in the owed-bills outbox, and their bytes.
func owedFor(t *testing.T, h *pairHarness, userID string) (rows int, bytes int64) {
	t.Helper()
	if err := h.store.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM unbilled_meter WHERE user_id = ?`,
		userID).Scan(&rows, &bytes); err != nil {
		t.Fatal(err)
	}
	return rows, bytes
}

// storedObjectsOn counts stored_files rows naming a blob.
func storedObjectsOn(t *testing.T, h *pairHarness, key string) int {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE blob_key = ?`, key).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// finalizeHTTP finalizes without failing the test on a transport error, for
// goroutines racing the finalize against cleanup.
func finalizeHTTP(h *pairHarness, uploadID string) (int, string) {
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		return 0, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, ""
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out.ID
}

// deleteFileHTTP is the owner deleting a stored object.
func deleteFileHTTP(h *pairHarness, fileID string) int {
	req, _ := http.NewRequest("DELETE", h.ts.URL+"/api/files/"+fileID, nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}
