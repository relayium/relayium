package account

// Finalize recovery (A02 / W-C1 Stage 0, generalized to shares by A14).
//
// A resumable finalize that committed its object but whose answer never
// reached the caller used to be unrecoverable: the retry heard `409 already
// finalized` with no id, and the only way forward was a second, separately
// counted upload. The session id is the operation's identity, so the object's
// insert transaction now records it on the session (finalized_file_id), and a
// finalize carrying `{"recoverFinalized":true}` answers from that durable link.
//
// Every test runs the real handlers over real HTTP on a FILE-backed SQLite
// database (WAL, the production pragmas) with a real DiskStore, a logical clock,
// the real reaper and the real GC. Invariants under test:
//
//   - the default answers are byte-identical (text 409, status 404), and a
//     pair-room finalize keeps its first-200 / repeat-409 answers with the
//     field present;
//   - recovery is a PURE READ: no reserve, meter, refund, stat, object or queue
//     row, however many times it is asked or raced;
//   - an id is returned only for the object this session's own insert linked,
//     and only while that object is live — never one cleanup owns, never a
//     re-created one;
//   - the link commits and rolls back with the object, and a refusal marker
//     never overwrites it.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const recoverOptIn = `{"recoverFinalized":true}`

// newRecoveryHarness is a pair harness over a SQLite FILE in the test's temp dir.
func newRecoveryHarness(t *testing.T) *pairHarness {
	t.Helper()
	return openFileHarness(t, filepath.Join(t.TempDir(), "central.sqlite"), 1_767_312_000)
}

// recAnswer is one finalize answer, raw and decoded.
type recAnswer struct {
	status     int
	ctype      string
	retryAfter string
	raw        []byte
	body       struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
		Recovered *bool  `json:"recovered"`
		Error     string `json:"error"`
		Outcome   string `json:"outcome"`
	}
}

func (a recAnswer) String() string {
	return fmt.Sprintf("%d %s %q", a.status, a.ctype, a.raw)
}

// finalizeAs sends one finalize with `body` ("" = no body at all, which is what
// every client before the opt-in sent) as the given cookie. No t: callable from
// racing goroutines.
func finalizeAs(h *pairHarness, cookie *http.Cookie, uploadID, body string) (recAnswer, error) {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		return recAnswer{}, err
	}
	defer resp.Body.Close()
	var a recAnswer
	a.status, a.ctype, a.retryAfter = resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Retry-After")
	a.raw, _ = io.ReadAll(resp.Body)
	if strings.HasPrefix(a.ctype, "application/json") {
		_ = json.Unmarshal(a.raw, &a.body)
	}
	return a, nil
}

func finalizeT(t *testing.T, h *pairHarness, uploadID, body string) recAnswer {
	t.Helper()
	a, err := finalizeAs(h, h.cookie, uploadID, body)
	if err != nil {
		t.Fatalf("finalize %s: %v", uploadID, err)
	}
	return a
}

func statusProbe(t *testing.T, h *pairHarness, uploadID string) int {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/uploads/"+uploadID, nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// purposeUpload inits a resumable upload of `size` bytes with the given
// purpose and uploads all of it. It is not finalized.
func purposeUpload(t *testing.T, h *pairHarness, purpose string, size int) (uploadID, key string) {
	t.Helper()
	var body bytes.Buffer
	manifest := []byte("MANIFEST")
	_ = binary.Write(&body, binary.BigEndian, uint32(len(manifest)))
	body.Write(manifest)
	q := url.Values{"size": {strconv.Itoa(size)}, "ttl": {"7200"}}
	if purpose != StoredPurposeShare {
		q.Set("purpose", purpose)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads?"+q.Encode(), &body)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("init %s: %d %s", purpose, resp.StatusCode, b)
	}
	var out struct {
		UploadID string `json:"uploadId"`
	}
	decodeJSON(t, resp, &out)
	blob := bytes.Repeat([]byte("F"), size)
	if code, got := patchChunk(t, h.ts, h.cookie, out.UploadID, blob, 0, size, size); code != 200 || got != int64(size) {
		t.Fatalf("patch: %d, %d bytes", code, got)
	}
	sess := h.session(t, out.UploadID)
	if sess.Purpose != purpose {
		t.Fatalf("session purpose %q, want %q", sess.Purpose, purpose)
	}
	return out.UploadID, sess.BlobKey
}

// finalizeAnswerLost sends a finalize over a raw TCP connection and never reads
// its answer: the request reaches the real handler whole, the handler runs to
// completion and writes its 200 into the socket, and the caller hangs up
// without having seen it. That is the answer lost in transit.
func finalizeAnswerLost(t *testing.T, h *pairHarness, uploadID string) {
	t.Helper()
	u, _ := url.Parse(h.ts.URL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "POST /api/uploads/%s/finalize HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\nContent-Length: 0\r\n\r\n",
		uploadID, u.Host, h.cookie.Name, h.cookie.Value)
	deadline := time.Now().Add(10 * time.Second)
	for linkOf(t, h, uploadID) == "" {
		if time.Now().After(deadline) {
			conn.Close()
			t.Fatal("the lost finalize never committed its object")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Give the handler the moment it needs to write its 200 into the socket,
	// then drop the connection unread.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = bufio.NewReader(conn).Peek(1)
	conn.Close()
}

// linkOf reads upload_sessions.finalized_file_id directly ("" also when the
// row is gone).
func linkOf(t *testing.T, h *pairHarness, uploadID string) string {
	t.Helper()
	var link string
	err := h.store.db.QueryRow(`SELECT finalized_file_id FROM upload_sessions WHERE id = ?`, uploadID).Scan(&link)
	if err != nil && err.Error() != "sql: no rows in result set" {
		t.Fatalf("link of %s: %v", uploadID, err)
	}
	return link
}

func refusedAtOf(t *testing.T, h *pairHarness, uploadID string) int64 {
	t.Helper()
	var at int64
	if err := h.store.db.QueryRow(`SELECT finalize_refused_at FROM upload_sessions WHERE id = ?`, uploadID).Scan(&at); err != nil {
		t.Fatalf("refusal marker of %s: %v", uploadID, err)
	}
	return at
}

// recLedger is every money-adjacent and object-adjacent fact a recovery must
// leave untouched.
type recLedger struct {
	objects      int   // stored_files rows of the user
	events       int   // upload_events rows (daily-quota debits)
	daily        int64 // their bytes
	metered      int64 // monthly upload traffic
	transfers    int64 // user_stats.transfers_total
	queued       int   // pending_node_deletes rows
	sessions     int   // upload_sessions rows of the user
	uploadedWin  int64 // UserUploadedSince(0)
	ownedUnbound int   // device_task objects not bound to a task
}

func ledgerOf(t *testing.T, h *pairHarness) recLedger {
	t.Helper()
	var l recLedger
	q := func(dst any, sql string, args ...any) {
		t.Helper()
		if err := h.store.db.QueryRow(sql, args...).Scan(dst); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	q(&l.objects, `SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, h.userID)
	q(&l.events, `SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, h.userID)
	q(&l.daily, `SELECT COALESCE(SUM(bytes), 0) FROM upload_events WHERE user_id = ?`, h.userID)
	q(&l.transfers, `SELECT COALESCE(SUM(transfers_total), 0) FROM user_stats WHERE user_id = ?`, h.userID)
	q(&l.queued, `SELECT COUNT(*) FROM pending_node_deletes`)
	q(&l.sessions, `SELECT COUNT(*) FROM upload_sessions WHERE user_id = ?`, h.userID)
	q(&l.ownedUnbound, `SELECT COUNT(*) FROM stored_files WHERE user_id = ? AND purpose = 'device_task' AND inbox_task_id = ''`, h.userID)
	l.metered = h.uploadMetered(t)
	n, err := h.store.UserUploadedSince(context.Background(), h.userID, 0)
	if err != nil {
		t.Fatal(err)
	}
	l.uploadedWin = n
	return l
}

func wantRecovered(t *testing.T, a recAnswer, id string, expiresAt int64) {
	t.Helper()
	if a.status != http.StatusOK || !strings.HasPrefix(a.ctype, "application/json") ||
		a.body.ID != id || a.body.ExpiresAt != expiresAt || a.body.Recovered == nil || !*a.body.Recovered {
		t.Fatalf("recovery = %s; want 200 {id:%s expiresAt:%d recovered:true}", a, id, expiresAt)
	}
	// Nothing but the three fields: no blob key, node, size, bill or verifier.
	var m map[string]any
	if err := json.Unmarshal(a.raw, &m); err != nil || len(m) != 3 {
		t.Fatalf("recovery body %q carries more than id/expiresAt/recovered", a.raw)
	}
}

func wantOutcome(t *testing.T, a recAnswer, outcome string) {
	t.Helper()
	if a.status != http.StatusConflict || !strings.HasPrefix(a.ctype, "application/json") ||
		a.body.Error != "already_finalized" || a.body.Outcome != outcome || a.body.ID != "" {
		t.Fatalf("recovery = %s; want 409 already_finalized/%s", a, outcome)
	}
	var m map[string]any
	if err := json.Unmarshal(a.raw, &m); err != nil || len(m) != 2 {
		t.Fatalf("recovery body %q carries more than error/outcome", a.raw)
	}
	if (outcome == "running") != (a.retryAfter == finalizeRecoveryRetryAfter) {
		t.Fatalf("outcome %s with Retry-After %q", outcome, a.retryAfter)
	}
}

// wantLegacy409 is today's repeat-finalize answer, byte for byte.
func wantLegacy409(t *testing.T, a recAnswer) {
	t.Helper()
	if a.status != http.StatusConflict || a.ctype != "text/plain; charset=utf-8" || string(a.raw) != "already finalized\n" {
		t.Fatalf("repeat finalize = %s; want the legacy text 409", a)
	}
}

func wantLegacy404(t *testing.T, a recAnswer) {
	t.Helper()
	if a.status != http.StatusNotFound || a.ctype != "text/plain; charset=utf-8" || string(a.raw) != "not found\n" {
		t.Fatalf("finalize = %s; want the legacy text 404", a)
	}
}

var recoverablePurposes = []string{StoredPurposeDeviceTask, StoredPurposeShare}

// ---------------------------------------------------------------------------
// T1. Without the opt-in nothing changes.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT1DefaultAnswersAreUnchanged(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			id, _ := purposeUpload(t, h, purpose, 900)
			first := finalizeT(t, h, id, "")
			if first.status != 200 || first.body.ID == "" || first.body.Recovered != nil {
				t.Fatalf("first finalize = %s", first)
			}
			var m map[string]any
			if err := json.Unmarshal(first.raw, &m); err != nil || len(m) != 2 {
				t.Fatalf("first finalize body %q changed shape", first.raw)
			}
			// The link is written on every resumable finalize, visible to nobody
			// who does not ask.
			if got := linkOf(t, h, id); got != first.body.ID {
				t.Fatalf("link = %q, want %q", got, first.body.ID)
			}
			for _, body := range []string{"", `{}`, `{"recoverFinalized":false}`, `{"recoverFinalized":null}`,
				`{"recoverFinalized":"true"}`, `{"recoverFinalized":1}`} {
				wantLegacy409(t, finalizeT(t, h, id, body))
			}
			if got := statusProbe(t, h, id); got != http.StatusNotFound {
				t.Fatalf("status probe of a finalized upload = %d, want 404", got)
			}
			// Tombstone lifetime unchanged: idle past the TTL, the purge takes it
			// and every answer becomes the legacy 404 — with or without the opt-in.
			reapIdle(h)
			wantLegacy404(t, finalizeT(t, h, id, ""))
			wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
			if !h.storedFileExists(t, first.body.ID) {
				t.Fatal("the purge took the object with the tombstone")
			}
		})
	}
}

// The opt-in on the FIRST finalize is an ordinary finalize: same answer shape,
// same single debit.
func TestFinalizeRecoveryD3FirstFinalizeWithTheOptInIsOrdinary(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			id, _ := purposeUpload(t, h, purpose, 900)
			a := finalizeT(t, h, id, recoverOptIn)
			if a.status != 200 || a.body.ID == "" || a.body.Recovered != nil {
				t.Fatalf("first finalize with the opt-in = %s; want the ordinary 200", a)
			}
			if l := ledgerOf(t, h); l.objects != 1 || l.events != 1 {
				t.Fatalf("ledger %+v; want one object, one debit", l)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// T2. The answer is lost; the opt-in recovers the same object and moves nothing.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT2LostAnswerRecoversTheSameObjectAndChargesNothing(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			id, key := purposeUpload(t, h, purpose, 900)
			finalizeAnswerLost(t, h, id)
			link := linkOf(t, h, id)
			sf, err := h.store.GetStoredFile(context.Background(), link)
			if err != nil || sf.BlobKey != key || sf.Purpose != purpose {
				t.Fatalf("linked object %+v, %v", sf, err)
			}
			before := ledgerOf(t, h)
			if before.objects != 1 || before.events != 1 || before.daily != minBillableBytes || before.metered != 900 || before.transfers != 1 {
				t.Fatalf("after the lost answer: %+v; want one object, one 64 KiB debit, 900 metered, one transfer", before)
			}
			h.advance(30)
			for i := 0; i < 3; i++ {
				wantRecovered(t, finalizeT(t, h, id, recoverOptIn), link, sf.ExpiresAt)
			}
			if after := ledgerOf(t, h); after != before {
				t.Fatalf("recovery moved the ledger: %+v -> %+v", before, after)
			}
			// Still the legacy answers for a caller that does not ask.
			wantLegacy409(t, finalizeT(t, h, id, ""))
			if got := statusProbe(t, h, id); got != http.StatusNotFound {
				t.Fatalf("status probe = %d, want 404", got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// T3. Another account: the same 404 as today.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT3AnotherAccountGetsTheLegacy404(t *testing.T) {
	h := newRecoveryHarness(t)
	id, _ := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	if a := finalizeT(t, h, id, ""); a.status != 200 {
		t.Fatalf("finalize = %s", a)
	}
	other, _ := h.otherCookie(t, "other@example.com")
	before := ledgerOf(t, h)
	for _, body := range []string{"", recoverOptIn} {
		a, err := finalizeAs(h, other, id, body)
		if err != nil {
			t.Fatal(err)
		}
		wantLegacy404(t, a)
	}
	if after := ledgerOf(t, h); after != before {
		t.Fatalf("a foreign request moved the owner's ledger: %+v -> %+v", before, after)
	}
}

// ---------------------------------------------------------------------------
// T4 (as corrected by the Stage 0 preflight). A pair-room finalize ignores the
// field: first 200 with the exact stored verifier, repeat text 409 — never 400.
// A verifier on a recoverable purpose stays the 400 it was.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT4PairRoomKeepsItsLegacyAnswers(t *testing.T) {
	verifier := verifierBody(base64.RawURLEncoding.EncodeToString(mustHex(t, completionVectorVerifier)))
	withOptIn := verifier[:len(verifier)-1] + `,"recoverFinalized":true}`
	for name, body := range map[string]string{
		"verifier_only":       verifier,
		"verifier_plus_optin": withOptIn,
		"optin_only":          recoverOptIn,
		"no_body":             "",
	} {
		t.Run(name, func(t *testing.T) {
			h := newRecoveryHarness(t)
			h.mintCode("328100", "")
			blob := bytes.Repeat([]byte("compat"), 170)
			status, uploadID, _ := h.initPairUpload(t, "328100", len(blob), "")
			if status != 200 {
				t.Fatalf("init = %d", status)
			}
			if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
				t.Fatalf("patch = %d", got)
			}
			first := finalizeT(t, h, uploadID, body)
			if first.status != 200 || first.body.ID == "" || first.body.Recovered != nil {
				t.Fatalf("first pair-room finalize = %s; want the legacy 200", first)
			}
			if strings.Contains(body, "completionVerifier") {
				if got := h.storedVerifier(t, first.body.ID); !bytes.Equal(got, mustHex(t, completionVectorVerifier)) {
					t.Fatalf("stored verifier %x", got)
				}
			}
			wantLegacy409(t, finalizeT(t, h, uploadID, body))
			wantLegacy409(t, finalizeT(t, h, uploadID, recoverOptIn))
		})
	}
	t.Run("verifier_on_a_recoverable_purpose_is_still_400", func(t *testing.T) {
		h := newRecoveryHarness(t)
		for _, purpose := range recoverablePurposes {
			id, _ := purposeUpload(t, h, purpose, 900)
			for _, body := range []string{verifier, withOptIn} {
				if a := finalizeT(t, h, id, body); a.status != http.StatusBadRequest {
					t.Fatalf("%s finalize with a verifier = %s; want 400", purpose, a)
				}
			}
			if h.session(t, id).Done {
				t.Fatalf("%s: a 400 claimed the session", purpose)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// T5 / D7. A refused finalize answers "failed" and leaves no debit.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT5RefusedFinalizeAnswersFailed(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			id, _ := purposeUpload(t, h, purpose, 900)
			h.spendDailyQuota(t, 64<<20) // the whole window: this debit cannot fit
			before := ledgerOf(t, h)
			if a := finalizeT(t, h, id, ""); a.status != http.StatusTooManyRequests {
				t.Fatalf("finalize over the daily quota = %s; want 429", a)
			}
			if linkOf(t, h, id) != "" || refusedAtOf(t, h, id) == 0 {
				t.Fatalf("refusal: link %q marker %d; want no link and a marker", linkOf(t, h, id), refusedAtOf(t, h, id))
			}
			afterRefusal := ledgerOf(t, h)
			if afterRefusal.objects != before.objects || afterRefusal.events != before.events || afterRefusal.daily != before.daily {
				t.Fatalf("the refusal left an object or a debit: %+v -> %+v", before, afterRefusal)
			}
			for i := 0; i < 3; i++ {
				wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "failed")
			}
			if after := ledgerOf(t, h); after != afterRefusal {
				t.Fatalf("recovery moved the ledger: %+v -> %+v", afterRefusal, after)
			}
			wantLegacy409(t, finalizeT(t, h, id, ""))
		})
	}
}

// A stored insert that fails AFTER the link's compare-and-set rolls the link
// back with it: the refusal is recorded instead, and recovery says "failed",
// never "removed" and never an id.
func TestFinalizeRecoveryAFailedInsertRollsTheLinkBack(t *testing.T) {
	h := newRecoveryHarness(t)
	id, _ := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	if _, err := h.store.db.Exec(`CREATE TRIGGER recovery_refuse_insert BEFORE INSERT ON stored_files
		BEGIN SELECT RAISE(ABORT, 'injected stored insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if a := finalizeT(t, h, id, ""); a.status != http.StatusInternalServerError {
		t.Fatalf("finalize with a failing insert = %s; want 500", a)
	}
	if _, err := h.store.db.Exec(`DROP TRIGGER recovery_refuse_insert`); err != nil {
		t.Fatal(err)
	}
	if got := linkOf(t, h, id); got != "" {
		t.Fatalf("the failed insert left the link %q", got)
	}
	if l := ledgerOf(t, h); l.objects != 0 || l.events != 0 {
		t.Fatalf("the failed insert left %+v", l)
	}
	wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "failed")
}

// A refusal marker never overwrites a success link: the store's refusal step
// on a linked tombstone writes nothing — whether the object is still there
// (referenced branch) or already gone (the link predicate).
func TestFinalizeRecoveryARefusalMarkerNeverOverwritesALink(t *testing.T) {
	ctx := context.Background()
	h := newRecoveryHarness(t)
	id, key := purposeUpload(t, h, StoredPurposeShare, 900)
	a := finalizeT(t, h, id, "")
	if a.status != 200 {
		t.Fatalf("finalize = %s", a)
	}
	sess := h.session(t, id)
	owned, err := h.store.PrepareRefusedUploadReclaim(ctx, id, key, sess.NodeID, h.now)
	if err != nil || owned {
		t.Fatalf("refusal step on a live object: owned=%v err=%v", owned, err)
	}
	if deleteFileHTTP(h, a.body.ID) != http.StatusOK {
		t.Fatal("owner delete failed")
	}
	if _, err := h.store.PrepareRefusedUploadReclaim(ctx, id, key, sess.NodeID, h.now); err != nil {
		t.Fatal(err)
	}
	if got, at := linkOf(t, h, id), refusedAtOf(t, h, id); got != a.body.ID || at != 0 {
		t.Fatalf("after two refusal steps: link %q marker %d; want the link intact and no marker", got, at)
	}
	wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "removed")
}

// ---------------------------------------------------------------------------
// T6 / T7. The cleanup race, both orderings.
// ---------------------------------------------------------------------------

// recoveryHookStore adds a hook after a cleanup claim and after the purge to
// the gated cleanupStore.
type recoveryHookStore struct {
	*cleanupStore
	mu                sync.Mutex
	afterCleanupClaim func(id string, ok bool)
}

func (r *recoveryHookStore) ClaimUploadSessionCleanup(ctx context.Context, id string, idleBefore, at int64) (string, string, bool, error) {
	b, n, ok, err := r.cleanupStore.ClaimUploadSessionCleanup(ctx, id, idleBefore, at)
	r.mu.Lock()
	f := r.afterCleanupClaim
	r.mu.Unlock()
	if f != nil && err == nil {
		f(id, ok)
	}
	return b, n, ok, err
}

// Cleanup first: a finalize held between its claim and its insert, past the
// idle TTL; the reaper takes ownership of the blob; the late insert fails its
// compare-and-set. Recovery — asked while the finalize is still held and again
// after it has been refused — is the 404 of a row that is gone, never an id;
// the blob is queued exactly once, no object exists and no debit remains.
func TestFinalizeRecoveryT6CleanupFirstIsNeverAnID(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			id, key := purposeUpload(t, h, purpose, 700)
			st := newCleanupStore(t, h.store)
			h.svc.store = st
			st.persist.armed.Store(true)
			codeCh := finalizeAsync(h, id)
			st.persist.waitEntered(t, "finalize")
			wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "running")
			h.advance(pendingUploadTTL + 1)
			h.svc.ReapPendingUploads(h.now) // cleanup wins
			if h.sessionExists(t, id) {
				t.Fatal("the cleanup claim did not take the tombstone")
			}
			wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
			st.persist.open()
			if code := awaitCode(t, codeCh, "finalize"); code != http.StatusInternalServerError {
				t.Fatalf("late finalize = %d, want 500", code)
			}
			wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
			if n := storedFilesFor(t, h, key); n != 0 {
				t.Fatalf("%d stored file(s) on a blob cleanup owns", n)
			}
			if q := queuedFor(t, h, key); len(q) != 1 {
				t.Fatalf("queue rows for the blob: %+v, want exactly one", q)
			}
			if n := dailyEvents(t, h); n != 0 {
				t.Fatalf("%d daily debit(s) left by a refused finalize", n)
			}
		})
	}
}

// Finalize first: the reaper's orphan snapshot is taken while the finalize is
// held, the finalize then commits, and the reaper's claim — re-checking inside
// its transaction — refuses. Recovery asked at that instant returns the object,
// the blob is neither queued nor deleted, and only the tombstone's ordinary
// purge ends recovery (legacy 404; the object stays).
func TestFinalizeRecoveryT7FinalizeFirstIsNeverCleaned(t *testing.T) {
	for _, purpose := range recoverablePurposes {
		t.Run(purpose, func(t *testing.T) {
			h := newRecoveryHarness(t)
			deletes := countCleanupDeletes(h)
			id, key := purposeUpload(t, h, purpose, 700)
			cs := newCleanupStore(t, h.store)
			st := &recoveryHookStore{cleanupStore: cs}
			h.svc.store = st
			cs.persist.armed.Store(true)
			codeCh := finalizeAsync(h, id)
			cs.persist.waitEntered(t, "finalize")
			h.advance(pendingUploadTTL + 1)
			cs.list.armed.Store(true)
			var inHook []recAnswer
			var claimed []bool
			st.afterCleanupClaim = func(cid string, ok bool) {
				if cid != id {
					return
				}
				claimed = append(claimed, ok)
				a, err := finalizeAs(h, h.cookie, id, recoverOptIn)
				if err == nil {
					inHook = append(inHook, a)
				}
			}
			reaped := make(chan struct{})
			reapAt := h.now
			go func() { defer close(reaped); h.svc.ReapPendingUploads(reapAt) }()
			cs.list.waitEntered(t, "the orphan pass")
			cs.persist.open() // the finalize commits first
			if code := awaitCode(t, codeCh, "finalize"); code != http.StatusOK {
				t.Fatalf("finalize = %d, want 200", code)
			}
			cs.list.open() // the reaper resumes from its stale snapshot
			select {
			case <-reaped:
			case <-time.After(20 * time.Second):
				t.Fatal("the reaper never finished")
			}
			link := linkOf(t, h, id)
			if len(claimed) != 1 || claimed[0] {
				t.Fatalf("cleanup claims %v; want one, refused", claimed)
			}
			sf, err := h.store.GetStoredFile(context.Background(), storedIDOn(t, h, key))
			if err != nil {
				t.Fatal(err)
			}
			if len(inHook) != 1 {
				t.Fatalf("recovery at the refused claim: %v", inHook)
			}
			if link != "" && link != sf.ID {
				t.Fatalf("link %q names another object than %q", link, sf.ID)
			}
			wantRecovered(t, inHook[0], sf.ID, sf.ExpiresAt)
			if q := queuedFor(t, h, key); len(q) != 0 || deletes.n.Load() != 0 || !h.blobExists(t, key) {
				t.Fatalf("a live object's blob was queued (%+v) or deleted (%d)", q, deletes.n.Load())
			}
			// The same reap pass purged the idle tombstone (its lifetime is
			// unchanged): legacy 404 from here on, and the object is untouched.
			wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
			if n := storedFilesFor(t, h, key); n != 1 {
				t.Fatalf("%d stored files, want 1", n)
			}
		})
	}
}

func storedIDOn(t *testing.T, h *pairHarness, key string) string {
	t.Helper()
	var id string
	if err := h.store.db.QueryRow(`SELECT id FROM stored_files WHERE blob_key = ?`, key).Scan(&id); err != nil {
		t.Fatalf("stored file on %s: %v", key, err)
	}
	return id
}

// ---------------------------------------------------------------------------
// T8 / D8. In flight: "running" with Retry-After, then the object.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT8RunningThenSucceeded(t *testing.T) {
	h := newRecoveryHarness(t)
	id, _ := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	st := newCleanupStore(t, h.store)
	h.svc.store = st
	st.persist.armed.Store(true)
	codeCh := finalizeAsync(h, id)
	st.persist.waitEntered(t, "finalize")
	before := ledgerOf(t, h)
	for i := 0; i < 3; i++ {
		wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "running")
	}
	if after := ledgerOf(t, h); after != before {
		t.Fatalf("a running answer moved the ledger: %+v -> %+v", before, after)
	}
	st.persist.open()
	if code := awaitCode(t, codeCh, "finalize"); code != 200 {
		t.Fatalf("finalize = %d", code)
	}
	link := linkOf(t, h, id)
	sf, err := h.store.GetStoredFile(context.Background(), link)
	if err != nil {
		t.Fatal(err)
	}
	wantRecovered(t, finalizeT(t, h, id, recoverOptIn), link, sf.ExpiresAt)
}

// ---------------------------------------------------------------------------
// T9 / D5 / D6. Expired and removed objects are reported, never returned.
// ---------------------------------------------------------------------------

func TestFinalizeRecoveryT9ExpiredAndRemovedAreNotReturned(t *testing.T) {
	t.Run("expired", func(t *testing.T) {
		for _, purpose := range recoverablePurposes {
			h := newRecoveryHarness(t)
			id, _ := purposeUpload(t, h, purpose, 900)
			a := finalizeT(t, h, id, "")
			if a.status != 200 {
				t.Fatalf("finalize = %s", a)
			}
			h.now = a.body.ExpiresAt - 1
			wantRecovered(t, finalizeT(t, h, id, recoverOptIn), a.body.ID, a.body.ExpiresAt)
			h.now = a.body.ExpiresAt
			wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "expired")
		}
	})
	t.Run("removed_by_the_bind_grace_gc", func(t *testing.T) {
		h := newRecoveryHarness(t)
		id, _ := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
		a := finalizeT(t, h, id, "")
		if a.status != 200 {
			t.Fatalf("finalize = %s", a)
		}
		h.advance(int64(taskObjectBindGrace/time.Second) + 1)
		(&GC{Store: h.store, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0),
			BlobFor: h.svc.blobFor}).reclaimTaskObjects(context.Background(), h.now)
		if h.storedFileExists(t, a.body.ID) {
			t.Fatal("the unbound task object outlived its bind grace")
		}
		if !h.sessionExists(t, id) {
			t.Fatal("setup: the tombstone is gone too")
		}
		wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "removed")
	})
	t.Run("removed_by_the_owner", func(t *testing.T) {
		h := newRecoveryHarness(t)
		id, _ := purposeUpload(t, h, StoredPurposeShare, 900)
		a := finalizeT(t, h, id, "")
		if a.status != 200 {
			t.Fatalf("finalize = %s", a)
		}
		if deleteFileHTTP(h, a.body.ID) != http.StatusOK {
			t.Fatal("owner delete failed")
		}
		before := ledgerOf(t, h)
		wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "removed")
		if after := ledgerOf(t, h); after != before || after.objects != 0 {
			t.Fatalf("recovery of a removed object re-created or charged something: %+v -> %+v", before, after)
		}
	})
}

// ---------------------------------------------------------------------------
// T10 + the adversarial double-charge case.
// ---------------------------------------------------------------------------

// Concurrent finalizes, with and without the opt-in, all racing from an open
// session: exactly one object, one daily debit, the bytes metered once, and
// every 200 names that one object. Everything else is a legacy 409 (no opt-in)
// or a "running" 409 (opt-in, raced the winner's commit).
func TestFinalizeRecoveryT10ConcurrentRetriesNeverCreateASecondObjectOrDebit(t *testing.T) {
	for _, mix := range []struct {
		name          string
		plain, optins int
	}{{"five_plain_five_optin", 5, 5}, {"ten_optin", 0, 10}} {
		for _, purpose := range recoverablePurposes {
			t.Run(mix.name+"/"+purpose, func(t *testing.T) {
				h := newRecoveryHarness(t)
				id, key := purposeUpload(t, h, purpose, 900)
				n := mix.plain + mix.optins
				answers := make([]recAnswer, n)
				errs := make([]error, n)
				start := make(chan struct{})
				var wg sync.WaitGroup
				for i := 0; i < n; i++ {
					body := ""
					if i >= mix.plain {
						body = recoverOptIn
					}
					wg.Add(1)
					go func(i int, body string) {
						defer wg.Done()
						<-start
						answers[i], errs[i] = finalizeAs(h, h.cookie, id, body)
					}(i, body)
				}
				close(start)
				wg.Wait()
				// Then everyone retries with the opt-in, concurrently again.
				retries := make([]recAnswer, n)
				for i := 0; i < n; i++ {
					wg.Add(1)
					go func(i int) {
						defer wg.Done()
						a, err := finalizeAs(h, h.cookie, id, recoverOptIn)
						retries[i] = a
						if err != nil {
							errs[i] = err
						}
					}(i)
				}
				wg.Wait()
				for i, err := range errs {
					if err != nil {
						t.Fatalf("request %d: %v", i, err)
					}
				}
				objID := storedIDOn(t, h, key)
				fresh := 0
				for i, a := range answers {
					switch {
					case a.status == 200 && a.body.Recovered == nil:
						fresh++
						if a.body.ID != objID {
							t.Fatalf("request %d: fresh 200 names %q, the object is %q", i, a.body.ID, objID)
						}
					case a.status == 200:
						if a.body.ID != objID {
							t.Fatalf("request %d: recovered %q, the object is %q", i, a.body.ID, objID)
						}
					case a.status == 409 && i < mix.plain:
						wantLegacy409(t, a)
					case a.status == 409:
						wantOutcome(t, a, "running")
					default:
						t.Fatalf("request %d: %s", i, a)
					}
				}
				if fresh != 1 {
					t.Fatalf("%d fresh finalizes succeeded, want exactly 1", fresh)
				}
				for i, a := range retries {
					if a.status != 200 || a.body.ID != objID || a.body.Recovered == nil {
						t.Fatalf("retry %d: %s; want the one object", i, a)
					}
				}
				l := ledgerOf(t, h)
				if l.objects != 1 || l.events != 1 || l.daily != minBillableBytes || l.metered != 900 || l.transfers != 1 {
					t.Fatalf("ledger %+v; want one object, one 64 KiB debit, 900 metered, one transfer", l)
				}
				if linkOf(t, h, id) != objID {
					t.Fatalf("link %q, object %q", linkOf(t, h, id), objID)
				}
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Upgrade and rollback.
// ---------------------------------------------------------------------------

// stripFinalizeRecovery turns a database this code wrote into the schema the
// code before the link wrote: no finalized_file_id, no finalize_refused_at.
func stripFinalizeRecovery(t *testing.T, path string) {
	t.Helper()
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, q := range []string{
		`ALTER TABLE upload_sessions DROP COLUMN finalized_file_id`,
		`ALTER TABLE upload_sessions DROP COLUMN finalize_refused_at`,
	} {
		if _, err := st.db.Exec(q); err != nil {
			t.Fatalf("strip (%s): %v", q, err)
		}
	}
}

// Upgrade: a tombstone the previous binary finalized has no link. After the
// upgrade it answers the legacy 409 by default and "running" (cannot confirm)
// with the opt-in — never an id guessed from its blob — until its ordinary
// purge; a new upload on the upgraded database recovers normally.
//
// Rollback: the previous binary's statements name their columns, so it reads
// and writes a migrated database without seeing either column; a finalize it
// runs leaves no link. Emulated here by its exact effect (the terminal claim,
// then the object insert without the session link) on the migrated file. On
// re-upgrade the link written before the rollback still recovers, and the
// rollback-era session reads "running", never an id.
func TestFinalizeRecoveryUpgradeAndRollbackCompatibility(t *testing.T) {
	path := filepath.Join(t.TempDir(), "central.sqlite")
	const t0 = int64(1_767_312_000)

	// Phase 1: the previous binary's database — a finalized tombstone with an
	// object and no link.
	h := openFileHarness(t, path, t0)
	legacyID, legacyKey := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	if a := finalizeT(t, h, legacyID, ""); a.status != 200 {
		t.Fatalf("finalize = %s", a)
	}
	closeHarness(h)
	stripFinalizeRecovery(t, path)

	// Phase 2: upgrade.
	h = openFileHarness(t, path, t0+10)
	if got := linkOf(t, h, legacyID); got != "" {
		t.Fatalf("the migration backfilled a link %q", got)
	}
	wantLegacy409(t, finalizeT(t, h, legacyID, ""))
	wantOutcome(t, finalizeT(t, h, legacyID, recoverOptIn), "running")
	if n := storedFilesFor(t, h, legacyKey); n != 1 {
		t.Fatalf("legacy object count %d", n)
	}
	newID, _ := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	finalizeAnswerLost(t, h, newID)
	newLink := linkOf(t, h, newID)
	sf, err := h.store.GetStoredFile(context.Background(), newLink)
	if err != nil {
		t.Fatal(err)
	}
	wantRecovered(t, finalizeT(t, h, newID, recoverOptIn), newLink, sf.ExpiresAt)

	// Phase 3: rollback — a finalize by the previous binary on the migrated file.
	rbID, rbKey := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	claimDone(t, h, rbID)
	if err := h.store.CreateStoredFile(context.Background(), StoredFile{
		ID: "f-rollback", UserID: h.userID, BlobKey: rbKey, EncManifest: []byte("M"), Size: 900,
		CreatedAt: h.now, ExpiresAt: h.now + 7200, Purpose: StoredPurposeDeviceTask,
	}); err != nil {
		t.Fatal(err)
	}
	closeHarness(h)

	// Phase 4: re-upgrade.
	h = openFileHarness(t, path, t0+20)
	wantRecovered(t, finalizeT(t, h, newID, recoverOptIn), newLink, sf.ExpiresAt)
	wantOutcome(t, finalizeT(t, h, rbID, recoverOptIn), "running")
	wantLegacy409(t, finalizeT(t, h, rbID, ""))
	// Both end the same way as ever: the purge collects the tombstones and the
	// objects stay.
	reapIdle(h)
	wantLegacy404(t, finalizeT(t, h, newID, recoverOptIn))
	wantLegacy404(t, finalizeT(t, h, rbID, recoverOptIn))
	for _, k := range []string{legacyKey, rbKey} {
		if n := storedFilesFor(t, h, k); n != 1 {
			t.Fatalf("object on %s: %d", k, n)
		}
	}
}
