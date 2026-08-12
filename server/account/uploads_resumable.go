package account

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/storage"
)

// uploadChunkSize is the chunk size the client is told to use: large enough to
// amortise per-request overhead, small enough that a reset loses little and no
// single request runs long enough to trip an edge timeout.
const uploadChunkSize = 8 << 20 // 8 MiB

// maxAppendBytes bounds how much ONE PATCH may write past the committed offset.
// It caps the finalize-vs-in-flight-append race: a chunk that reads done=0, then
// races a finalize that claims the session at `received`, can still commit bytes
// to the blob after finalize billed `received` — under-billing physical vs
// charged storage. Without a per-append bound a single slow-drip PATCH could
// write the whole remaining budget (~MaxSize, up to ~1 GiB) past `received`,
// making it an unbounded free-storage primitive. Bounding each append caps that
// residual to one chunk's worth (concurrent same-offset appends clobber rather
// than sum, per the blob's offset check). It sits comfortably above the client's
// real chunk peak (chunkSize + one ~192 KiB frame ≈ 8.2 MiB), so conforming
// clients never hit it. Fully closing the residual would need a blob-seal op the
// node protocol doesn't have. (A var, not a const, only so a test can shrink it
// to exercise the bound with tiny payloads — production never reassigns it.)
var maxAppendBytes int64 = 2 * uploadChunkSize // 16 MiB

// maxAppendLifetime is the WALL-CLOCK ceiling on one PATCH, from the moment the
// session is authorised to the moment the append returns. It is the bound that
// makes a room's held delete intent (pairRoomBlobHold) mean something.
//
// THE HOLE IT CLOSES. A void deletes an upload's session row and its blob, and
// keeps a delete intent on the books for pairRoomBlobHold afterwards, because an
// append that read the row a moment earlier may still be streaming and will
// re-create the key when it lands. That argument only works if "still streaming"
// has an upper bound — and it had none. The server sets no ReadTimeout (it must
// not: /ws is a long-lived hijacked connection), DiskStore.Append copied its
// reader to completion without looking at a context, and the remote path
// inherited the request context, which for a client that is merely SLOW is never
// cancelled at all. A drip-feeding client could therefore hold one append open
// past the hold, land its bytes on a key nothing points at any more, and leave
// ciphertext with no owner whatsoever.
//
// THREE LAYERS, because no one of them covers every way an append can hang:
//   - a read deadline on the client connection (http.ResponseController), which
//     is the only thing that can interrupt a body read that has stalled outright;
//   - this deadline on the context the blob store runs under, which is what
//     stops a NODE that accepts the body and never answers (the read deadline
//     cannot fire there: central is blocked writing, not reading);
//   - DiskStore.Append honouring that context, which is what stops a drip that
//     never stalls a single read long enough for a socket deadline to notice.
//
// TEN MINUTES is 16 MiB (maxAppendBytes) at ~28 KB/s sustained — below any
// connection on which the surrounding transfer is feasible at all, and a client
// cut here loses nothing: the bytes that landed are billed and recorded, and it
// resumes from the offset the response carries. See appendSettlementSlack for
// the rest of the sum and pairRoomBlobHold for what it has to stay under.
//
// A var, not a const, only so a test can shrink it to milliseconds and watch the
// cut actually happen — production never reassigns it.
var maxAppendLifetime = 10 * time.Minute

// uploadCommitBudget bounds the one store transaction that records an append's
// offset, its bill and the deadline it bought. Detached from the request, so it
// is spent after maxAppendLifetime may already have expired.
const uploadCommitBudget = 5 * time.Second

// voidedAppendSettleBudget bounds the cleanup an append does when it discovers
// its room was voided underneath it: bill what landed, remove the blob.
const voidedAppendSettleBudget = 10 * time.Second

// appendSettlementSlack is everything ONE PATCH may still spend after its append
// deadline has expired: a blob read-back probe, the progress commit, and (for a
// pre-upload) the settlement of an append that landed in a voided room. Each is
// a detached, individually bounded context, and they run in sequence.
//
// maxAppendLifetime + this is the whole wall-clock answer to "how long after a
// request was authorised can it still write to a blob", and
// TestAnAppendCannotOutliveTheHoldOnItsBlob is what keeps it strictly under the
// hold.
const appendSettlementSlack = blobProbeTimeout + uploadCommitBudget + voidedAppendSettleBudget

// pendingUploadTTL is the idle threshold before the reaper tries to settle an
// abandoned chunked upload. A reachable blob is billed and dropped then; an
// unreachable one moves to the durable recovery state and remains until an
// exact probe succeeds (see uploadUnresolvedRetryEvery).
const pendingUploadTTL = int64(3600) // 1 h

// maxSessionsPerUser caps concurrent open chunked-upload sessions per account.
// Traffic is metered per committed append, but daily quota is reserved only at
// finalize and partial blobs/session rows are still finite operator resources;
// without this cap one account could open an unbounded number of them before
// any finalize. Shares the single-shot path's per-account concurrency budget
// (M1).
const maxSessionsPerUser = maxConcurrentUploadsPerUser

// eofTrackingReader remembers whether the reader it wraps was ever read to EOF.
// handleUploadChunk wraps the request body with it, because "the body was fully
// consumed" is the one condition under which the connection read deadline may
// safely be cleared for keep-alive. Atomic, because the remote blob path hands
// the reader to an HTTP transport whose goroutine does the reading.
type eofTrackingReader struct {
	r      io.Reader
	sawEOF atomic.Bool
}

func (t *eofTrackingReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err == io.EOF {
		t.sawEOF.Store(true)
	}
	return n, err
}

// dropUploadBlob reclaims an abandoned upload's partial blob, resolving the blob
// store from node_id first; if the node can't be resolved it queues the delete
// for GC to retry rather than leaking it.
func (s *Service) dropUploadBlob(ctx context.Context, nodeID, blobKey string) {
	bs, err := s.blobFor(ctx, nodeID)
	if err != nil {
		_ = s.store.EnqueueNodeDelete(ctx, blobKey, nodeID, s.now().Unix())
		return
	}
	s.dropBlob(bs, blobKey, nodeID)
}

// uploadUnresolvedRetryEvery paces the re-probe of a session in the recovery
// state (see MarkUploadUnresolved). One hour, matching pendingUploadTTL: a node
// that is coming back gets its blob accounted for and reclaimed within an hour
// of returning, and a node that is not costs one bounded attempt an hour rather
// than one per GC tick.
//
// There is deliberately NO horizon after which the attempts stop and the row is
// written off. The bound on this state is the work it costs — an interval and a
// batch — not the evidence it holds. A row here is the only record that some
// number of committed bytes was never billed; time cannot answer that question,
// so time is not allowed to close it.
const uploadUnresolvedRetryEvery int64 = 3600

// uploadUnresolvedRecoverBatch bounds one recovery pass. Each attempt may spend
// a blob-store timeout on a node that is not answering, so the pass is capped
// and the leftovers wait for the next sweep — the rows are not going anywhere.
const uploadUnresolvedRecoverBatch = 16

// ReapPendingUploads drops abandoned upload sessions and their partial blobs.
// Wired into the GC tick (see main.go). now is unix seconds. It runs three
// passes; the first two are keyed on IDLE time (no chunk since) rather than
// absolute age, so a legit long upload is never reaped mid-flight:
//   - open sessions idle past the TTL, settled and dropped by reapOpenUpload;
//   - finalized (done=1) sessions idle past the TTL whose blob nothing
//     references — a finalize that crashed before persisting the file — whose
//     partial blob would otherwise leak forever;
//   - sessions in the recovery state, whose node was unreachable when the
//     reaper got to them, re-probed on their own slower cadence.
func (s *Service) ReapPendingUploads(now int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	before := now - pendingUploadTTL
	if rows, err := s.store.ListExpiredOpenUploadSessions(ctx, before); err == nil {
		for _, r := range rows {
			s.reapOpenUpload(ctx, r, now)
		}
	}
	// Orphaned finalized rows: settle the bill, then drop the unreferenced blob.
	//
	// BEFORE the recovery pass, not after. Recovery stamps each attempt, and a
	// stamp is idle time — running it first would keep a recovery-state row out
	// of this pass's idle window as a side effect, which reads as protection and
	// is not one. The protection is that this query excludes the state outright
	// (ListOrphanDoneUploadSessions); ordering it this way is what leaves that
	// clause as the only thing standing between this pass and a blob it must not
	// delete, where a test can see it.
	if orphans, err := s.store.ListOrphanDoneUploadSessions(ctx, before); err == nil {
		for _, r := range orphans {
			// A finalize that crashed between claiming the session and billing it.
			// Idempotent, so a session that WAS billed pays nothing again here — and
			// its blob only goes once the bill is settled, because the row is the
			// only record of what those bytes were.
			if !s.reconcileUploadMeter(ctx, r.ID, now) {
				continue
			}
			s.dropUploadBlob(ctx, r.NodeID, r.BlobKey)
		}
	}
	s.recoverUnresolvedUploads(ctx, now)
	// Purges only rows whose meter is settled (see PurgeDoneUploadSessions); an
	// unreconciled one survives to be reconciled on the next sweep instead of
	// taking its unbilled bytes to the grave.
	_ = s.store.PurgeDoneUploadSessions(ctx, before)
}

// reapOpenUpload settles and removes ONE abandoned open session.
//
// The order is the point, and each step is a precondition for the next:
//
//  1. RE-PROBE the blob. `received` is only as good as the last append that
//     managed to write it down, and an append that committed bytes and then
//     failed to record them — a node that died on the way back, a database that
//     was briefly unavailable — leaves the truth on the blob and nowhere else.
//     This is the last moment anything can ask.
//  2. CLAIM the session terminally, which settles its meter in the same
//     transaction: the bill and the terminal state are one fact.
//  3. Only then drop the blob and the row.
//
// A step that cannot be completed leaves the session exactly as it was, for the
// next sweep. Deleting it anyway would erase the only record that those bytes
// were ever accepted — the exact shape of "hang up and it is free", one level
// further out than the finalize path it was fixed in.
//
// When step 1 cannot be done at all — the node is unreachable, so nothing can
// say how big the blob is — the session does not proceed to step 2 against the
// offset it happens to know. It moves to the RECOVERY state instead
// (markUploadUnresolved): the answer is unknown, and an unknown settled at its
// lower bound is a permanent underbill of the bytes the node took but never
// acknowledged.
func (s *Service) reapOpenUpload(ctx context.Context, r UploadSessionRow, now int64) {
	if !s.recoverUploadSize(ctx, r, now) {
		s.markUploadUnresolved(ctx, r, now)
		return
	}
	_, billed, claimed, err := s.store.ClaimUploadDone(ctx, r.ID, now)
	if err != nil {
		log.Printf("upload session %s: claiming it to settle %d committed bytes: %v", r.ID, r.Received, err)
		return // NOT deleted: the bill is unsettled and this row is its only record
	}
	if !claimed {
		return // finalized (blob kept) or claimed by another reaper
	}
	if billed > 0 {
		log.Printf("upload session %s: billed %d committed bytes no append recorded", r.ID, billed)
	}
	s.dropUploadBlob(ctx, r.NodeID, r.BlobKey)
	_ = s.store.DeleteUploadSession(ctx, r.ID)
}

// recoverUploadSize asks the blob how big it really is and records whatever the
// session's offset is missing. ok=false means the blob could not be asked at
// all, which is "unknown", not "unchanged" — the caller must leave the session
// alone rather than settle it against a number nothing confirmed.
func (s *Service) recoverUploadSize(ctx context.Context, r UploadSessionRow, now int64) bool {
	bs, err := s.blobFor(ctx, r.NodeID)
	if err != nil {
		log.Printf("upload session %s: cannot reach node %s to read its blob back: %v",
			r.ID, nodeLabelForLog(r.NodeID), err)
		return false
	}
	size, ok := s.probeBlobSize(ctx, bs, r)
	if !ok {
		return false
	}
	if size <= r.Received {
		return true
	}
	// No room id on purpose: this session is being ENDED, and a dead upload must
	// not push a pairing room's deadline out on its way to the reaper. The bytes
	// are billed; the deadline they would have bought is not owed to them.
	if _, err := s.store.CommitUploadProgress(ctx, UploadProgress{
		SessionID: r.ID, UserID: r.UserID, Committed: size, Billable: r.Billable, Now: now,
	}); err != nil {
		log.Printf("upload session %s: recording the %d bytes its blob still holds: %v",
			r.ID, size-r.Received, err)
		return false
	}
	return true
}

// markUploadUnresolved hands a session whose blob could not be reached to the
// recovery pass, and says so once, loudly, naming what is at stake.
//
// Nothing is billed and nothing is deleted here. That is the whole point: the
// row and the blob are the two witnesses to how many bytes this upload really
// accepted, and until one of them can be asked, the account's bill for it is
// known only to be AT LEAST what is already on the meter.
func (s *Service) markUploadUnresolved(ctx context.Context, r UploadSessionRow, now int64) {
	ok, err := s.store.MarkUploadUnresolved(ctx, r.ID, now)
	if err != nil {
		log.Printf("upload session %s: moving it to the unresolved state: %v", r.ID, err)
		return // left open: the next sweep tries again
	}
	if !ok {
		return // a racing finalize or reaper claimed it first
	}
	log.Printf("upload session %s: node %s is unreachable, so the %d committed bytes it acknowledged are billed but its real size is UNKNOWN; keeping the session and its blob %s as evidence until the node answers",
		r.ID, nodeLabelForLog(r.NodeID), r.Received, r.BlobKey)
}

// recoverUnresolvedUploads re-probes the sessions whose blob nothing could read
// when they were abandoned, and settles the ones whose node has come back.
//
// Bounded per sweep (a batch and a per-row retry interval) and unbounded in
// patience: a row stays until a probe answers for it. That asymmetry is
// deliberate. The cost of keeping one is a few dozen bytes of a table nobody
// queries on a hot path; the cost of dropping one is a bill that can never be
// reconstructed, for bytes a customer's node really did accept.
func (s *Service) recoverUnresolvedUploads(ctx context.Context, now int64) {
	rows, err := s.store.ListUnresolvedUploadSessions(ctx,
		now-uploadUnresolvedRetryEvery, uploadUnresolvedRecoverBatch)
	if err != nil {
		log.Printf("upload recovery: listing the sessions waiting on an unreachable node: %v", err)
		return
	}
	var stuck int
	for _, r := range rows {
		if ctx.Err() != nil {
			return // out of sweep budget; the rest keep until the next one
		}
		if !s.recoverUnresolvedUpload(ctx, r, now) {
			stuck++
		}
	}
	if stuck > 0 {
		log.Printf("upload recovery: %d session(s) still waiting on an unreachable node to say how many bytes it committed; their evidence is kept", stuck)
	}
}

// recoverUnresolvedUpload re-probes ONE recovery-state session. Reports whether
// it is finished with (settled, or gone).
//
// The order is reapOpenUpload's, for the same reason: the bill is settled from
// a size the blob itself gave, and only then is the blob allowed to go. Asking
// and deleting can never be reordered — the delete destroys the answer.
func (s *Service) recoverUnresolvedUpload(ctx context.Context, r UploadSessionRow, now int64) bool {
	if bs, err := s.blobFor(ctx, r.NodeID); err != nil {
		log.Printf("upload session %s: still cannot reach node %s to read its blob back: %v",
			r.ID, nodeLabelForLog(r.NodeID), err)
	} else if size, ok := s.probeBlobSize(ctx, bs, r); ok {
		return s.settleUnresolvedUpload(ctx, r, size, now)
	}
	// Nothing learned. The only write is the attempt stamp, which paces the next
	// try; the accounting is untouched, because nothing answered it.
	if nerr := s.store.NoteUnresolvedProbe(ctx, r.ID, now); nerr != nil {
		log.Printf("upload session %s: recording the failed re-probe: %v", r.ID, nerr)
	}
	return false
}

// settleUnresolvedUpload writes the bill a successful probe finally made
// possible, then reclaims the blob and the row.
func (s *Service) settleUnresolvedUpload(ctx context.Context, r UploadSessionRow, size, now int64) bool {
	billed, err := s.store.SettleUnresolvedUpload(ctx, r.ID, size, now)
	if err != nil {
		// NOT deleted, and NOT settled: the row is still the only record of these
		// bytes, and the next sweep asks again.
		log.Printf("upload session %s: settling the %d bytes its blob turned out to hold: %v", r.ID, size, err)
		return false
	}
	if billed > 0 {
		log.Printf("upload session %s: node %s came back holding %d bytes; billed the %d that no append had recorded",
			r.ID, nodeLabelForLog(r.NodeID), size, billed)
	}
	s.dropUploadBlob(ctx, r.NodeID, r.BlobKey)
	_ = s.store.DeleteUploadSession(ctx, r.ID)
	return true
}

// reconcileUploadMeter bills a session's committed-but-unmetered bytes. Reports
// whether the ledger is now settled — its callers must not delete a session
// that is not, because the row is the only record of what it accepted.
func (s *Service) reconcileUploadMeter(ctx context.Context, sessionID string, now int64) bool {
	billed, err := s.store.ReconcileUploadMeter(ctx, sessionID, now)
	if err != nil {
		log.Printf("upload session %s: reconciling the meter: %v", sessionID, err)
		return false
	}
	if billed > 0 {
		log.Printf("upload session %s: billed %d committed bytes no append recorded", sessionID, billed)
	}
	return true
}

// handleUploadInit (POST /api/files/uploads) starts a chunked upload. The body
// is the length-prefixed encrypted manifest (uint32BE(len)||encManifest), the
// same header the single-shot upload leads with; retention comes from the query
// and the declared ciphertext size from ?size=. It runs the same placement,
// disk-cap and daily-quota pre-checks as the single-shot path, then persists a
// session and returns {uploadId, chunkSize}.
func (s *Service) handleUploadInit(w http.ResponseWriter, r *http.Request, u User) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	// ?size= is the client-declared ciphertext size. Parsed here (unchanged
	// semantics: advisory, never stored, never re-checked at finalize) so placement
	// can ask "does this node fit THIS upload" instead of "does it fit a
	// MaxFileSize one". A liar declaring 0 gets floored by placementMinFree and
	// still cannot buy a bigger write budget — sessionWriteCap below ignores ?size=.
	declared, _ := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
	nodeID, _, billable, perr := s.placeUpload(r.Context(), u.ID, declared)
	if errors.Is(perr, errStrictNodeUnreachable) {
		http.Error(w, "central can't reach your storage node — check its blob port is open", http.StatusServiceUnavailable)
		return
	}
	if errors.Is(perr, errStrictNodeFull) {
		http.Error(w, "your storage node has no free space", http.StatusServiceUnavailable)
		return
	}
	if errors.Is(perr, errStrictNoNode) {
		http.Error(w, "your storage node is offline", http.StatusServiceUnavailable)
		return
	}
	if nodeID == "" && s.diskUsage != nil && s.blobDiskMax > 0 {
		if used, _, err := s.diskUsage(); err == nil && used >= uint64(s.blobDiskMax) {
			http.Error(w, "storage temporarily full", http.StatusServiceUnavailable)
			return
		}
	}

	st := s.ResolveSettings(r.Context())
	// Same resolution as the single-shot path, from the same helper: the two
	// upload routes must not be able to disagree about what an object IS.
	purpose, ttl, maxDL, okp := resolveUploadRetention(r.URL.Query(), st)
	if !okp {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if capSecs := s.planRetentionCap(r.Context(), u.ID); capSecs > 0 && ttl > capSecs {
		ttl = capSecs
	}
	br := bufio.NewReader(r.Body)
	var mlen uint32
	if err := binary.Read(br, binary.BigEndian, &mlen); err != nil || int64(mlen) > maxManifestBytes {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	encManifest := make([]byte, mlen)
	if _, err := io.ReadFull(br, encManifest); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Fail fast if the declared ciphertext size already overflows the remaining
	// daily quota (client-supplied, trusted only to reject; finalize is the
	// authoritative gate). Own-node uploads don't bill against DailyQuota.
	if billable && declared > 0 {
		used, err := s.store.UserUploadedSince(r.Context(), u.ID, s.now().Unix()-dayWindow)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// Fail-closed, matching the UserUploadedSince read above: a store error
		// aborts with 500 rather than falling back to some other cap.
		quota, err := s.dailyQuotaFor(r.Context(), u.ID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if used+declared > quota {
			http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
			return
		}
	}

	// Per-plan gates (billable central-stored uploads only; own-node uploads use
	// the user's own disk and are never metered against a plan). Client-declared
	// size is trusted only to reject early; finalize is the authoritative gate.
	if billable {
		declaredForPlan := declared
		if declaredForPlan < 0 {
			declaredForPlan = 0
		}
		if over, err := s.overGlobalStorage(r.Context(), declaredForPlan); err == nil && over {
			http.Error(w, "server storage is full", http.StatusInsufficientStorage)
			return
		}
		if over, err := s.overStorage(r.Context(), u.ID, declaredForPlan); err == nil && over {
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, declaredForPlan); err == nil && over {
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}

	// A pre-upload binds to the pairing room its ?code= names, and the account
	// must be the one that minted that code (pairRoomForUpload).
	//
	// LAST, after every quota gate above. A room is durable state that outlives
	// the request and holds a code's ciphertext lifecycle; opening one for an
	// account that is already over its limits — as this did when it ran before the
	// gates — creates lifecycle bookkeeping for a transfer the very next check
	// refuses. It stays before CreateUploadSession for the original reason: a
	// refused binding must not leave an open session or a partial blob behind.
	var pairRoomID string
	if purpose == StoredPurposePairRoom {
		room, err := s.pairRoomForUpload(r.Context(), u.ID, r.URL.Query().Get("code"))
		if err != nil {
			writePairRoomError(w, err)
			return
		}
		pairRoomID = room.ID
	}

	row := UploadSessionRow{
		ID: authx.NewID(), UserID: u.ID, BlobKey: authx.RandToken(), NodeID: nodeID, Billable: billable,
		EncManifest: encManifest, TTL: ttl, MaxDL: maxDL, Purpose: purpose, PairRoomID: pairRoomID,
		MaxSize:   s.sessionWriteCap(r.Context(), u.ID, st.MaxFileSize, billable),
		CreatedAt: s.now().Unix(),
	}
	ok, err := s.store.CreateUploadSession(r.Context(), row, maxSessionsPerUser)
	if errors.Is(err, ErrPairRoomClosed) {
		// The room ended between resolving it above and inserting this session. The
		// insert carries the room's open-ness as a precondition precisely so that
		// window cannot leave a session bound to a room whose void has already run
		// — the one row nothing would ever enumerate again.
		s.endPairRoomByID(r.Context(), pairRoomID)
		writePairRoomError(w, errPairRoomOver)
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"uploadId": row.ID, "chunkSize": chunkSizeFor(purpose)})
}

// pairRoomChunkSize is the chunk a pre-upload is told to use.
//
// Smaller than the default for one specific reason: a pair room's deadline moves
// only when a chunk COMMITS, so an upload whose single chunk takes longer than
// pairRoomJoinWindow to arrive would let the room expire underneath itself.
// 8 MiB needs ~218 kbit/s to clear 300 seconds; 1 MiB needs ~27 kbit/s, which no
// connection capable of finishing the transfer at all falls below. The cost is
// eight times as many PATCHes (and deadline writes) per megabyte, which is
// nothing next to the bytes they carry.
const pairRoomChunkSize = 1 << 20 // 1 MiB

func chunkSizeFor(purpose string) int64 {
	if purpose == StoredPurposePairRoom {
		return pairRoomChunkSize
	}
	return uploadChunkSize
}

// writePairRoomError maps a pair-room refusal onto its HTTP status. A non-
// pairRoomError is a store failure and is never described to the client in
// detail — it says nothing about whether a code exists.
func writePairRoomError(w http.ResponseWriter, err error) {
	if pe, ok := err.(pairRoomError); ok {
		http.Error(w, pe.msg, pe.status)
		return
	}
	http.Error(w, "server error", http.StatusInternalServerError)
}

// sessionWriteCap 给一个 chunked 上传会话定写入上限：单文件上限与用户三项剩余
// 额度（日额度 / 存储 / 流量）的最小值。四个量全部由服务端自算，**不看客户端
// 声明的 ?size=**——那个值只用来提前拒绝，谎报 size=0 只能跳过那道早失败，换不
// 到更大的写入配额。否则一个免费账号能用 maxSessionsPerUser 个会话，每个写满
// MaxFileSize，把这些半成品 blob 在磁盘上占住整个 pendingUploadTTL。
//
// 读失败时 fail-OPEN：某项额度读不出来就让它不参与 min（而不是收紧到 0）。理由
// 是这里定的只是一个**上界**，不是额度门本身——读挂了还有 MaxFileSize 兜底，而
// 真正的权威闸门（finalize 按 received 重跑全部额度检查）一道没少。反过来一次 DB
// 抖动就把 maxSize 压成 0，会让所有正常上传在 PATCH 阶段 413。注意这与
// handleUploadInit/handleUploadFinalize 里日额度读失败就 500 的 fail-CLOSED 并不
// 矛盾：那两处是放不放行的判决点，这里只是给会话挑一个尺寸。
//
// billable=false（文件落在用户自己的存储节点上）整条豁免：这类上传本来就不计入
// 任何套餐额度（init 和 finalize 的额度闸对它们全部跳过），拿"剩余额度"去卡它
// 等于在执行一份根本没在花的预算。它们占的是用户自己的盘，由节点自身的
// StorageFree/磁盘上限管。
func (s *Service) sessionWriteCap(ctx context.Context, userID string, maxFileSize int64, billable bool) int64 {
	cap := maxFileSize
	if !billable {
		return cap
	}
	clamp := func(v int64) {
		if v < 0 {
			v = 0
		}
		if v < cap {
			cap = v
		}
	}
	if remaining, err := s.remainingDailyQuota(ctx, userID); err == nil {
		clamp(remaining)
	}
	if remaining, unlimited, err := s.remainingStorage(ctx, userID); err == nil && !unlimited {
		clamp(remaining)
	}
	if remaining, unlimited, err := s.remainingTraffic(ctx, userID); err == nil && !unlimited {
		clamp(remaining)
	}
	return cap
}

// handleUploadChunk (PATCH /api/files/uploads/{uploadId}) appends one chunk. The
// Content-Range's start must equal the bytes already committed; a stale start
// (already received) is acked idempotently, a gap is 409 with the real offset.
// The blob store's own offset check is the authority; the DB `received` mirrors
// it (advanced monotonically), so any instance can serve the next chunk.
func (s *Service) handleUploadChunk(w http.ResponseWriter, r *http.Request, u User) {
	uploadID := r.PathValue("uploadId")
	// THE LIFETIME, set before anything is read or authorised so the bound covers
	// the whole request rather than the append alone (see maxAppendLifetime).
	//
	// The socket deadline and the context are both needed and neither subsumes the
	// other: the deadline is the only thing that can interrupt a body read that has
	// stalled, and the context is the only thing that reaches a node which took the
	// body and went quiet. time.Now, not s.now — a kernel deadline cannot be moved
	// by a test's injected clock, and pretending otherwise would make the bound a
	// fiction on exactly the path it is here to bound.
	//
	// FAIL CLOSED when the deadline cannot be set. The context layers below do
	// NOT subsume it on the local-disk path: DiskStore.Append checks its context
	// between reads, so a single body Read that blocks outright — a client that
	// stops sending on an open connection, with no server ReadTimeout to cut it —
	// is bounded by nothing but this deadline. Accepting the upload anyway would
	// silently reopen the exact hole maxAppendLifetime exists to close (an append
	// outliving the hold on its blob). No production wrapper stands between this
	// handler and the server's own connection (CSRFGuard, securityHeaders and
	// RequireAuth all pass the ResponseWriter through untouched), so the only
	// thing that fails here is a deployment that introduced one — and that
	// deployment must hear about it as a hard error, not as a quietly unbounded
	// upload path.
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Now().Add(maxAppendLifetime)); err != nil {
		log.Printf("upload chunk %s: cannot bound the body read (%v); refusing the append rather than accepting an unbounded one", uploadID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// The deadline is ABSOLUTE and the connection outlives this request: left in
	// place, a keep-alive connection carries it into whatever request runs on it
	// next (the server sets no ReadTimeout of its own to overwrite it), and a
	// later slow-but-legitimate body read inherits a budget that started counting
	// here. It is cleared below — but ONLY once this request's body has provably
	// been read to EOF (bodyEOF, checked after the append). That is the only case
	// the server will reuse the connection at all, and it is the only case the
	// clear is SAFE: the server's own post-handler drain of an unfinished body
	// runs under this same deadline, and clearing it first would hand a client
	// that stalls mid-body an unbounded server read — the exact hole the deadline
	// exists to close.
	ctx, cancelAppend := context.WithTimeout(r.Context(), maxAppendLifetime)
	defer cancelAppend()
	sess, ok, err := s.store.GetUploadSession(ctx, uploadID, u.ID)
	if err != nil {
		log.Printf("upload chunk %s: read session: %v", uploadID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || sess.Done {
		// Missing, wrong owner, or finalized/reaped: no longer ours to append to.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	start, okr := parseContentRangeStart(r.Header.Get("Content-Range"))
	if !okr {
		http.Error(w, "bad Content-Range", http.StatusBadRequest)
		return
	}
	// A pre-upload's room can end WHILE the upload runs — nobody joined inside
	// the window, or the ceiling was reached. Re-derived on every append, not
	// only at init, because continuing to accept (and bill) bytes for ciphertext
	// that is already void is exactly what the immediate-void rule exists to
	// prevent. The refusal also voids, so the deadline is true on disk before the
	// client reads the status.
	//
	// BEFORE the offset bookkeeping below, so that EVERY request against a
	// pre-upload is answered against the room's real state: a resume overshoot or
	// a gap into a room that is already over used to be acked 200/409, which tells
	// a sender its upload is fine when the ciphertext behind it has been deleted.
	// Reading the room renews nothing — only committed BYTES move a deadline
	// (CommitUploadProgress) — so asking on every request costs a read and buys
	// the one answer the client needs.
	var pairRoom PairRoom
	if sess.PairRoomID != "" {
		room, perr := s.pairRoomStillOpen(ctx, sess.PairRoomID)
		if perr != nil {
			writePairRoomError(w, perr)
			return
		}
		pairRoom = room
	}

	if start < sess.Received {
		// Client re-sent bytes we already have (a resume overshoot) — ack the
		// current offset so it advances without corrupting the blob.
		//
		// The deadline it hears back is the one the room ALREADY has: this request
		// committed nothing, and nothing is exactly what it may buy. That is the
		// store's own rule for moving the room (CommitUploadProgress), stated here
		// so the answer cannot drift from it — an empty replay is a request anyone
		// can send in a loop, and one that renewed the window would make the
		// window free.
		//
		// Re-read rather than taken from `pairRoom` above, even though that read is
		// a few lines old. This path never reaches the store transaction, so nothing
		// else here can notice a sibling append that moved the room in between —
		// and answering from the older snapshot would report a deadline the room has
		// already replaced. The read renews nothing.
		httpx.WriteJSON(w, http.StatusOK,
			withRoomDeadline(map[string]any{"received": sess.Received},
				s.persistedRoomJoinDeadline(ctx, sess.PairRoomID)))
		return
	}
	if start > sess.Received {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{"received": sess.Received})
		return
	}

	// M3b: the global blob-volume soft cap is only checked at init; a chunked
	// upload grows the blob incrementally, so re-check here so a session opened
	// while there was room can't keep appending past the high-water mark. Applies
	// only to central-local placement; a usage-read error fails open, matching the
	// single-shot path.
	if sess.NodeID == "" && s.diskUsage != nil && s.blobDiskMax > 0 {
		if used, _, err := s.diskUsage(); err == nil && used >= uint64(s.blobDiskMax) {
			http.Error(w, "storage temporarily full", http.StatusServiceUnavailable)
			return
		}
	}

	bs, err := s.blobFor(ctx, sess.NodeID)
	if err != nil {
		http.Error(w, "storage node unavailable", http.StatusServiceUnavailable)
		return
	}
	// Two independent bounds on what this one PATCH may write:
	//   - io.LimitReader stops reading cleanly at maxAppendBytes, so a single
	//     append can't drip more than one chunk's worth past the committed
	//     offset (the finalize-race bound, see maxAppendBytes). Anything beyond
	//     is simply not read; the client resumes from the returned offset.
	//   - cappedReader still enforces the whole-file MaxSize: exceeding it errors
	//     (errTooLarge → 413), which the LimitReader truncation must NOT mask, so
	//     it wraps the limited reader (its max is the remaining file budget).
	// When the remaining budget is the tighter of the two, cappedReader trips
	// first and the file-too-large 413 is preserved.
	body := &eofTrackingReader{r: r.Body}
	capped := &cappedReader{r: io.LimitReader(body, maxAppendBytes), max: sess.MaxSize - sess.Received}
	// ...on the bounded context, which is the third of maxAppendLifetime's three
	// layers: a node that swallows the body and never answers is cut here, and a
	// local copy that would otherwise run as long as the client keeps dripping is
	// cut inside DiskStore.Append.
	newSize, err := bs.Append(ctx, sess.BlobKey, sess.Received, capped)
	if body.sawEOF.Load() {
		// The whole body has been read, so the connection is reusable — and the
		// absolute deadline set above must not ride along into the next request on
		// it. Cleared ONLY in this case (see the comment at the deadline): with
		// bytes still unread, the deadline is what bounds the server's own drain
		// of them. Best-effort; failing to clear errs in the safe direction.
		_ = rc.SetReadDeadline(time.Time{})
	}
	// The lifetime ends with the append. Everything below is SETTLEMENT — a
	// read-back probe, a billing commit, a cleanup — and every one of those runs
	// on r.Context() with its own detached budget (appendSettlementSlack), never
	// on `ctx`: an append cut off at its deadline is precisely the case whose
	// bytes still have to be billed, and inheriting the expired deadline would
	// abandon the accounting instead.
	cancelAppend()
	now := s.now().Unix()

	// ANY failed append may have committed a prefix, and the number Append
	// returns with an error is not the blob's size — it is 0, meaning "I do not
	// know". The remote path proves it: central streams the body straight to the
	// node, so a node that wrote what it had read and then died (or a proxy that
	// reset the response, or a transport error mid-stream) leaves bytes committed
	// and answers 500. Writing that 0 down would clobber the committed offset;
	// treating it as "nothing landed" loses the bill for bytes that crossed the
	// network. So the blob is asked.
	//
	// This used to be done for the oversize refusal alone, which is the least
	// likely of the failures to be reached at all — the ordinary way to lose
	// bytes here is a node or a network, not a file-size cap.
	//
	// ErrOffsetMismatch is excluded because it already CARRIES the blob's
	// authoritative size; there is nothing to recover.
	committed := newSize
	if err != nil && !errors.Is(err, storage.ErrOffsetMismatch) {
		committed, _ = s.committedBlobSize(r.Context(), bs, sess, newSize, capped.n)
	}

	// One commit for every outcome: the offset the blob now holds, the bill for
	// the bytes that bought it, and (for a pre-upload) the deadline that progress
	// buys — one transaction, so no failure can leave a subset of them true.
	//
	// A failure is a 500 the client retries, and the retry cannot double-bill or
	// lose the bytes: the blob's size is the authority, so the retried PATCH
	// re-derives the same committed offset (through the offset-mismatch path) and
	// the delta is computed against the offset the database still holds.
	progress, cerr := s.commitUploadProgress(r.Context(), sess, pairRoom, committed, now)
	switch {
	case cerr != nil && errors.Is(err, errTooLarge):
		// Logged, not 500: the client is being refused either way, and a 500 here
		// would hide WHY (the file is too large) behind a transient-looking status.
		// The reaper's re-probe is the second chance at the bill.
		log.Printf("upload chunk %s: billing the %d bytes an oversize append committed: %v",
			uploadID, committed-sess.Received, cerr)
	case cerr != nil:
		log.Printf("upload chunk %s: commit progress to %d: %v", uploadID, committed, cerr)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	case sess.PairRoomID != "" && !progress.RoomOpen && s.endPairRoomByID(r.Context(), sess.PairRoomID):
		// The room ended between the liveness check above and this write. The bytes
		// are billed — they moved — but they bought nothing, and saying so now is
		// the difference between a sender who switches to the live link and one who
		// keeps paying to fill a blob no receiver can reach.
		//
		// And the bytes THIS append just wrote have to be billed and then removed,
		// here, before the status is written. This is the one path that can put
		// ciphertext back after a void has deleted it: the void removes the session
		// row and drops the blob, and this request — which read that row a moment
		// earlier — was already streaming to the node. Its write lands afterwards
		// and re-creates the key. Nothing central holds points at it any more, so if
		// this request does not clean up after itself, only the void's held delete
		// intent will (see pairRoomBlobHold) — and that is the crash net, not the
		// mechanism.
		s.settleAppendIntoAVoidedRoom(r.Context(), sess, committed,
			err == nil && progress.Received <= sess.Received)
		writePairRoomError(w, errPairRoomOver)
		return
	}
	if errors.Is(err, errTooLarge) {
		// Oversize chunk. The refusal does not un-send the bytes: cappedReader
		// errors only AFTER the read that overshot, so on both paths the blob has
		// already absorbed everything up to the cap — locally because Append copied
		// it, remotely because the node had written it before central cut the body.
		// Those bytes crossed the network and are billed, exactly like a hangup is.
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	if errors.Is(err, storage.ErrOffsetMismatch) {
		// The blob and our counter disagree (e.g. a duplicated request lost the
		// race); report the blob's truth so the client re-syncs.
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{"received": committed})
		return
	}
	if err != nil {
		// The line that was missing when a node's blob port was firewalled shut:
		// every PATCH 500'd, nothing was logged, and the only route to the cause
		// was nginx's access log plus a hand-written database query. Name the
		// node — "which node" is the whole question.
		log.Printf("upload chunk %s: append to blob %s on node %s at offset %d: %v",
			uploadID, sess.BlobKey, nodeLabelForLog(sess.NodeID), sess.Received, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// The one answer a pre-upload cannot get anywhere else. Every committed chunk
	// pushes this room's join deadline — and with it the pairing code's — out
	// again, and until this line the only response that ever said where it landed
	// was finalize's. An upload that FAILED after committing bytes therefore left
	// the sender's page counting the mint's window down and announcing a dead code
	// while the room was still taking joins, with a button offering to burn it.
	//
	// The number comes from the STORE's transaction, never from `pairRoom` and
	// this handler's clock. That reconstruction is what was wrong here: `pairRoom`
	// was read before the append, duplicate and sibling appends overlap by design
	// (a retry after a lost answer is the ordinary case this whole field exists
	// for), and whichever of them settles last would otherwise report a window
	// computed from its own stale snapshot — earlier than the deadline the room
	// and the code registry now hold, which is precisely how a client comes to
	// announce a dead code while receivers can still join. progress.RoomJoinDeadline
	// is the row's own answer at commit, a sibling's move included.
	httpx.WriteJSON(w, http.StatusOK,
		withRoomDeadline(map[string]any{"received": progress.Received}, progress.RoomJoinDeadline))
}

// withRoomDeadline adds a pairing room's join deadline to a resumable-upload
// response body, and only for a pre-upload.
//
// ADDITIVE, on purpose. There is no new endpoint and no new request: the append
// and the resume probe are already the two things a stalled pre-upload sends,
// and an optional field on their existing 200 is what makes an old client keep
// working unchanged against a new server and a new client keep working (without
// this answer) against an old one.
//
// It DERIVES NOTHING. `deadline` is a number some authoritative read of the
// room's row already produced — the store transaction's own answer
// (UploadProgressResult.RoomJoinDeadline) or persistedRoomJoinDeadline — and 0
// means "say nothing", which is the honest answer for an upload with no room
// and for one whose room could not be read. This used to take the room snapshot
// and a timestamp and re-derive the deadline here, which put a second copy of
// the timing rule on the response path, running on a snapshot that a concurrent
// append could already have replaced.
func withRoomDeadline(body map[string]any, deadline int64) map[string]any {
	if deadline > 0 {
		body["expiresAt"] = deadline
	}
	return body
}

// persistedRoomJoinDeadline reports the instant `roomID` is joinable until, as
// its row currently stands in the store — the answer for the two response paths
// that never reach a CommitUploadProgress transaction and so have nothing else
// authoritative to report (the resume overshoot's ack and the status probe).
//
// A plain read. It renews nothing, it does not void an expired room and it does
// not refuse — those belong to the append.
//
// 0 for every case that must say NOTHING rather than something reassuring: no
// room, a room that cannot be read, a room that is no longer live, and a room
// somebody has already JOINED. A join deadline in the future computed from a
// room whose bytes are already gone is an invitation to a rendezvous the server
// has emptied, and a read is not the thing that gets to declare that either way
// — the append's own 410 is. A join deadline for a joined room is an instant at
// which nobody may still join: not a window, and not a number the code registry
// holds (pairRoomCodeDeadline).
func (s *Service) persistedRoomJoinDeadline(ctx context.Context, roomID string) int64 {
	if roomID == "" {
		return 0
	}
	room, found, err := s.store.GetPairRoom(ctx, roomID)
	if err != nil || !found || !pairRoomLive(room, s.now().Unix()) {
		return 0
	}
	return pairRoomCodeDeadline(room)
}

// commitUploadProgress records one committed append: the offset the blob now
// holds, the bill for the bytes that advance bought, and — for a pre-upload —
// the pairing-room deadline that progress buys. One store transaction (see
// Store.CommitUploadProgress); this only decides what to hand it.
//
// Metering used to happen only at finalize, which made an ABANDONED chunked
// upload free: a client could stream gigabytes, never finalize, and the monthly
// traffic ledger would never hear about it. Billing per committed append is what
// makes "every accepted byte is billed, including a cancellation or a failure"
// literally true, and it is load-bearing for the pair-room deadline rule — the
// only way to hold a code open is to keep uploading, and uploading is billed.
//
// Written on a DETACHED context. A client that aborts mid-append is precisely
// the case this is here to bill, and its cancelled request context would
// otherwise take the accounting write down with it.
func (s *Service) commitUploadProgress(ctx context.Context, sess UploadSessionRow, room PairRoom, committed, now int64) (UploadProgressResult, error) {
	if committed <= sess.Received && room.ID == "" {
		return UploadProgressResult{Received: sess.Received, RoomOpen: true}, nil
	}
	p := UploadProgress{
		SessionID: sess.ID, UserID: sess.UserID, Committed: committed,
		Billable: sess.Billable, Now: now,
	}
	if room.ID != "" {
		p.RoomID = room.ID
		p.RoomExpiry = pairRoomProgressExpiry(room, now)
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadCommitBudget)
	defer cancel()
	res, err := s.store.CommitUploadProgress(cctx, p)
	if err == nil && res.RoomOpen && room.ID != "" {
		// The room's deadline may just have moved in the database; the CODE that
		// reaches it has to move with it, or the batch's next file is refused and the
		// receiver this upload is for cannot join at all (syncPairCode).
		//
		// After the transaction and only on its success, so the credential can never
		// outlive the deadline it is supposed to mirror.
		//
		// TO THE STORE'S OWN NUMBER, which is what makes the byte-gate this used to
		// carry unnecessary rather than merely tidier. The target is the deadline the
		// row HOLDS, so an extension can only bring the code up to the room and never
		// past it: a request that committed nothing buys nothing here either, it just
		// stops the registry lagging behind bytes some other request already paid for.
		// The old gate compared the store's offset against the one THIS request read
		// before the append, which a sibling could already have advanced — so it fired
		// on requests that had bought nothing while extending the code to a window
		// derived from this handler's clock, and that window could sit past the room's
		// own. Nothing is derived here now, so the code and the response cannot say
		// different things (see UploadProgressResult.RoomJoinDeadline).
		s.syncPairCodeTo(room, res.RoomJoinDeadline)
	}
	return res, err
}

// settleAppendIntoAVoidedRoom bills the bytes an append committed after its
// pairing room was voided underneath it, then removes the ciphertext they left.
//
// It closes the one window a room's void cannot pre-empt. The void settles and
// deletes the session row and drops the blob; an append already streaming to the
// node lands after both and re-creates the key with up to one chunk's worth of
// bytes (maxAppendBytes), or with an empty file when its offset no longer
// matches what the node holds. Nothing central holds references it any more, so
// the request that created it is the right thing to remove it — immediately,
// while it still knows the key.
//
// WHO BILLS WHAT. `ownBytes` is the caller's answer to "did this request's own
// append land, and did the store's transaction fail to charge for it" — a
// successful append starts exactly at the offset the session held, so
// `committed - Received` is precisely what this request wrote and nothing else's
// bytes can be inside it. When the append FAILED, the number on the blob is
// whatever survived, and settling it is the void's probe's job
// (settleReclaimedUpload), not this request's: billing here as well would charge
// the same bytes twice. Clamped to the session's write cap for the reason every
// blob-reported number is — a node may answer with anything, and max_size is the
// budget this server authorized.
//
// So "every accepted byte is billed" holds through the void as well: the bytes
// crossed the wire, they are charged, they buy no deadline, and the object they
// were going into is never created.
//
// Detached, like every other reclaim on a request that is about to answer 410:
// a client that hangs up on reading the status must not cancel the deletion the
// status is claiming.
func (s *Service) settleAppendIntoAVoidedRoom(ctx context.Context, sess UploadSessionRow, committed int64, ownBytes bool) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), voidedAppendSettleBudget)
	defer cancel()
	if to := min(committed, sess.MaxSize); ownBytes && sess.Billable && to > sess.Received {
		// Through settleBlobBillingDurably, not RecordMeter: the blob these bytes
		// are the measure of is deleted on the next line, so the bill must be
		// durable — metered, or journaled with the intent row's floor advanced —
		// before the last copy of the number is destroyed.
		if !s.settleBlobBillingDurably(ctx, sess.BlobKey, sess.NodeID, to, s.now().Unix(),
			"bytes appended to blob "+sess.BlobKey+" after pair room "+sess.PairRoomID+" was voided") {
			// Neither the meter nor the journal could be written. The blob stays as
			// the bill's own evidence: the void's intent row owns both the billing
			// and the deletion, and GC settles the first before it performs the
			// second. Deleting here would trade the bill for a tidier disk.
			log.Printf("upload session %s: keeping blob %s until the bill for its post-void bytes is durable",
				sess.ID, sess.BlobKey)
			return
		}
		log.Printf("upload session %s: settled %d bytes that landed on blob %s after pair room %s was voided; they buy no deadline and the blob goes now",
			sess.ID, to-sess.Received, sess.BlobKey, sess.PairRoomID)
	}
	s.dropUploadBlob(ctx, sess.NodeID, sess.BlobKey)
}

// committedBlobSize recovers how big the blob REALLY is after an append that
// errored, so the bytes it accepted can be billed and resumed from. ok=false
// means the blob could not be asked at all — the size is UNKNOWN, not
// unchanged, and the reaper's re-probe is what eventually settles it.
//
// The two blob stores fail differently and neither can be trusted blindly:
//   - local: Append copied what it could and returns offset+n with the error, so
//     its number is the truth.
//   - remote: the request ended mid-flight, so the node committed some prefix
//     and answered 500, and Append reports 0 — which is not "nothing landed", it
//     is "I do not know".
//
// So: believe a number that moved forward, and otherwise ASK the blob, with a
// zero-byte append at the offset we last knew. That probe writes nothing and
// needs no new node protocol: a node whose size still matches answers 200 with
// it, and one that committed more answers 409 with the real size — the same
// re-sync answer the resumable path already relies on.
//
// `sent` is how many bytes central actually read from the client and forwarded
// (cappedReader's count), and it is a CEILING on the answer. Everything here
// comes from the blob store, and a malicious BYO or fleet node is free to
// invent a number; this one request cannot have grown the blob by more than the
// bytes that crossed central, so anything above that is somebody else's write
// or a lie, and either way not this account's bill. (max_size is the other,
// coarser bound, applied inside CommitUploadProgress.)
func (s *Service) committedBlobSize(ctx context.Context, bs storage.BlobStore, sess UploadSessionRow, reported, sent int64) (int64, bool) {
	ceiling := sess.Received + sent
	if reported > sess.Received {
		return min(reported, ceiling), true
	}
	size, ok := s.probeBlobSize(ctx, bs, sess)
	if !ok {
		return sess.Received, false
	}
	return min(size, ceiling), true
}

// probeBlobSize asks the blob how many bytes it holds, with a zero-byte append
// at the offset the session last recorded: a blob still at that offset accepts
// it and answers with the same number, a blob that holds more refuses with the
// real one. ok=false ⇒ the blob store could not answer.
//
// Asking creates the blob if nothing was ever written to it (an append at
// offset 0 opens the file), which is why every caller either drops the blob
// immediately afterwards or leaves a session row that will. An empty file is
// not worth a second node round trip to avoid.
func (s *Service) probeBlobSize(ctx context.Context, bs storage.BlobStore, sess UploadSessionRow) (int64, bool) {
	pctx, cancel := probeContext(ctx)
	defer cancel()
	size, err := bs.Append(pctx, sess.BlobKey, sess.Received, bytes.NewReader(nil))
	if err == nil || errors.Is(err, storage.ErrOffsetMismatch) {
		return size, true
	}
	log.Printf("upload session %s: could not read back blob %s on node %s: %v",
		sess.ID, sess.BlobKey, nodeLabelForLog(sess.NodeID), err)
	return 0, false
}

// blobProbeTimeout bounds one read-back probe against a node that is not
// answering. Short: the answer is worth having, but never worth a request
// goroutine.
const blobProbeTimeout = 5 * time.Second

// probeContext is the context one blob probe runs on: the caller's CANCELLATION
// dropped, its DEADLINE kept when that is the tighter of the two.
//
// Cancellation is dropped because the usual caller is a request that is about to
// fail, and a client hanging up must not take the accounting for its own bytes
// with it. The deadline is kept because the callers that have one are spending a
// budget — a room's void, the reaper's sweep — and a probe that ignored it would
// let one unreachable node overshoot that budget by its own full timeout, which
// is exactly how a bounded pass stops being bounded.
func probeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	pctx := context.WithoutCancel(ctx)
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) < blobProbeTimeout {
		return context.WithDeadline(pctx, dl)
	}
	return context.WithTimeout(pctx, blobProbeTimeout)
}

// nodeLabelForLog renders a placement target for a log line: the node id, or
// "central" for the empty id that means central-local storage.
func nodeLabelForLog(nodeID string) string {
	if nodeID == "" {
		return "central"
	}
	return nodeID
}

// handleUploadFinalize (POST /api/files/uploads/{uploadId}/finalize) commits the
// upload: it reserves the daily quota against the real byte count, creates the
// stored-file row, records stats/metering, and drops the session.
func (s *Service) handleUploadFinalize(w http.ResponseWriter, r *http.Request, u User) {
	sess, ok, err := s.store.GetUploadSession(r.Context(), r.PathValue("uploadId"), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// The OPTIONAL completion verifier, read before anything is claimed.
	//
	// BEFORE, and that ordering is the whole of it. The claim below is terminal by
	// design — it is what makes finalize once-only — so a refusal taken after it
	// would turn one malformed field into an upload that can never be finalized at
	// all: the sender's bytes are on the node, the session is spent, and no retry
	// can land them. A 400 here costs the sender a request and nothing else.
	//
	// It is additive in both directions. A client that sends no body is every
	// client that exists today and is answered exactly as before; a client that
	// sends one against a server predating this simply has it ignored.
	completionVerifier, cerr := finalizeCompletionVerifier(r)
	if cerr != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// A completion capability belongs to a pair-room object and to nothing else. A
	// share's life is its TTL and its download count; a Device Inbox object's is
	// its task. Neither has anything for a receiver to end, so a verifier on one is
	// a caller that has misread the endpoint — refused rather than stored and
	// quietly ignored, which is the same choice the pre-upload path already makes
	// for retention parameters it cannot honour.
	if completionVerifier != nil && sess.Purpose != StoredPurposePairRoom {
		http.Error(w, "completion verifier is only for a pair-room upload", http.StatusBadRequest)
		return
	}
	// Claim the session terminally AND settle its meter, in one store transaction:
	// the committed size at that instant, and a bill for every committed byte no
	// append got to record. A racing finalize (or the reaper) that already claimed
	// it loses here.
	//
	// The bill has to be settled before any gate below can refuse the object,
	// because the bytes moved whether or not this finalize succeeds — and it has
	// to be atomic with the claim, because the two used to be separate calls whose
	// second could fail on its own: this handler logged that failure and went on
	// to delete the session, which was the only record of what those bytes were.
	// Failing the claim instead costs nothing: the session stays open and the
	// client's retry finalizes it normally.
	//
	// Normally it bills nothing at all: every append already billed itself.
	size, billedNow, claimed, err := s.store.ClaimUploadDone(r.Context(), sess.ID, s.now().Unix())
	if err != nil {
		log.Printf("upload finalize %s: claiming it and settling its meter: %v", sess.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !claimed {
		http.Error(w, "already finalized", http.StatusConflict)
		return
	}
	if billedNow > 0 {
		log.Printf("upload finalize %s: billed %d committed bytes no append recorded", sess.ID, billedNow)
	}

	// reservedUploadID is the daily-quota event this finalize reserved (if any);
	// fail refunds it so a file rejected by the later storage-cap gate doesn't
	// leave the user charged daily quota for bytes that never landed.
	var reservedUploadID string
	// fail drops the partial blob + the (already done-claimed) session row and
	// writes the given HTTP error.
	fail := func(msg string, code int) {
		s.dropUploadBlob(r.Context(), sess.NodeID, sess.BlobKey)
		_ = s.store.DeleteUploadSession(r.Context(), sess.ID)
		if reservedUploadID != "" {
			_ = s.store.RefundUpload(r.Context(), reservedUploadID)
		}
		http.Error(w, msg, code)
	}

	now := s.now().Unix()
	// A pre-upload's room can have ended while the last chunks were arriving.
	// Binding an object to a room that is over would create ciphertext no reader
	// can ever reach, so this finalize fails and the partial blob goes with it —
	// while the bytes stay billed, because they moved.
	//
	// Checked AFTER the terminal claim so this refusal takes the same
	// drop-blob/drop-session path as every other one, and so a racing reaper
	// cannot delete the blob out from under a finalize that is about to succeed.
	var pairRoom PairRoom
	if sess.PairRoomID != "" {
		room, perr := s.pairRoomStillOpen(r.Context(), sess.PairRoomID)
		if perr != nil {
			pe, isPair := perr.(pairRoomError)
			if !isPair {
				fail("server error", http.StatusInternalServerError)
				return
			}
			fail(pe.msg, pe.status)
			return
		}
		// The last byte of this upload has landed: it is the room's most recent
		// progress, and therefore the instant the final join window starts.
		//
		// Its failure fails the finalize. This write is the only thing that makes
		// the promised five-minutes-from-completion true, and swallowing it would
		// hand the sender an object whose room is already counting down from some
		// earlier chunk — a code that dies early, for a reason nothing recorded.
		//
		// It is also the second, transactional reading of "is this room still
		// open": the check above is a separate statement and the room can end
		// between the two.
		if terr := s.notePairRoomUpload(r.Context(), room, now); terr != nil {
			if errors.Is(terr, ErrPairRoomClosed) {
				s.endPairRoomByID(r.Context(), room.ID)
				fail(errPairRoomOver.msg, errPairRoomOver.status)
				return
			}
			log.Printf("upload finalize %s: moving pair room %s's deadline: %v", sess.ID, room.ID, terr)
			fail("server error", http.StatusInternalServerError)
			return
		}
		// The snapshot is kept only for what cannot go stale — which room, whose
		// code — and deliberately NOT advanced to `now` here. It used to be, and
		// the object's deadline was then read back off it; that projection is the
		// bug this path had, and leaving the assignment behind would leave the
		// next reader a plausible-looking source for it.
		pairRoom = room
	}
	if sess.Billable {
		// Authoritative per-plan traffic gate now that the upload is complete (the
		// init pre-check only saw the client-declared size). Storage caps are
		// enforced atomically at persist time below.
		//
		// ZERO additional bytes, not `size`: every byte of this object is already on
		// the account's meter (per-append, plus the reconcile above), so asking
		// "would size more bytes fit" would count this upload twice and refuse an
		// object that fits. The question here is the exact one the meter can now
		// answer — is the account over its allowance as things stand — and it is
		// the same test as before per-append metering, since used_now equals
		// used_before + size.
		if over, err := s.overTraffic(r.Context(), u.ID, 0); err == nil && over {
			fail("monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
		billed := size
		if billed < minBillableBytes {
			billed = minBillableBytes
		}
		// Authoritative gate: a quota read error fails CLOSED just like the
		// ReserveUpload error below — drop the blob, kill the session, 500.
		quota, err := s.dailyQuotaFor(r.Context(), u.ID)
		if err != nil {
			fail("server error", http.StatusInternalServerError)
			return
		}
		evID := authx.NewID()
		reserved, err := s.store.ReserveUpload(r.Context(),
			UploadEvent{ID: evID, UserID: u.ID, Bytes: billed, UploadedAt: now},
			now-dayWindow, quota)
		if err != nil {
			fail("server error", http.StatusInternalServerError)
			return
		}
		if !reserved {
			fail("daily quota exceeded", http.StatusTooManyRequests)
			return
		}
		reservedUploadID = evID // committed — a later failure must refund it
	}

	fid := authx.NewID()
	sf := StoredFile{
		ID: fid, UserID: u.ID, BlobKey: sess.BlobKey, EncManifest: sess.EncManifest,
		Size: size, BurnAfterRead: sess.MaxDL == 1, CreatedAt: now, ExpiresAt: now + sess.TTL,
		NodeID: sess.NodeID, MaxDownloads: sess.MaxDL, Purpose: sess.Purpose,
		PairRoomID: sess.PairRoomID, CompletionVerifier: completionVerifier,
	}
	// sf.ExpiresAt above is the SESSION's TTL, and for a pre-upload it is not the
	// answer: the object inherits its ROOM's deadline, which is the same 300
	// seconds at this instant but is the only one that keeps moving as the rest of
	// the batch uploads and stops moving when someone joins.
	//
	// It is deliberately NOT computed here. The room this handler read is a
	// snapshot, `now` is this handler's clock, and between the two of them and the
	// insert below sits an interval a sibling request can land in — the batch's
	// next file, or a retry of an append whose answer was lost, either of which
	// pushes the room further out. An object built from the snapshot then lands
	// behind its own room and dies early, alone in its batch, and nothing repairs
	// it (touchPairRoomOn only moves objects that are BEHIND the value it writes,
	// and this one would already hold that value). The store decides it, from the
	// room's row, inside the insert's own transaction — see StoredFileWrite.
	//
	// Atomic, fail-closed storage-cap enforcement + insert (see persistStoredFile).
	// For a pre-upload the insert also carries the room's open precondition, so
	// this is the last and tightest place a room that ended mid-finalize is caught:
	// a 200 from here can never describe ciphertext bound to a closed room.
	persisted, perr := s.persistStoredFile(r.Context(), sf, sess.Billable)
	switch {
	case errors.Is(perr, ErrPairRoomClosed):
		s.endPairRoomByID(r.Context(), sess.PairRoomID)
		fail(errPairRoomOver.msg, errPairRoomOver.status)
		return
	case perr != nil:
		fail("server error", http.StatusInternalServerError)
		return
	case persisted.Reason == "global":
		fail("server storage is full", http.StatusInsufficientStorage)
		return
	case persisted.Reason == "storage":
		fail("storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
		return
	}
	if pairRoom.ID != "" {
		// The room may have moved while this finalize was running, and the row —
		// not this handler — is what says where to. Bringing the CODE up to the
		// deadline the transaction actually saw is not a renewal: it is at most the
		// deadline the room demonstrably already holds, which is why it is safe to
		// do unconditionally, and it is what stops the registry from lagging behind
		// bytes some other request already paid for. syncPairCodeTo, never
		// syncPairCode: nothing is projected from a snapshot here.
		//
		// "At most the deadline the room holds" includes NONE of it: if the peer
		// joined while this finalize ran, the insert's transaction answers 0 and
		// this moves nothing (pairRoomCodeDeadline).
		s.syncPairCodeTo(pairRoom, persisted.RoomJoinDeadline)
	}
	// Lifetime stats are whole-object on purpose, and are NOT the meter: they
	// count completed uploads, while the meter counts bytes that crossed the wire.
	// A cancelled upload is deliberately present in one and absent from the other.
	// (The meter for this object was settled above, before any gate could refuse
	// it.)
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
	_ = s.store.DeleteUploadSession(r.Context(), sess.ID)
	// The row's own deadline, which for a pre-upload is the room's and never the
	// session TTL sf still carries. This number is what the sender counts down and
	// treats as certainty about its code, so it has to be the one that landed.
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": fid, "expiresAt": persisted.ExpiresAt})
}

// handleUploadStatus (GET /api/files/uploads/{uploadId}) reports the committed
// offset so a client can resume after an interruption.
func (s *Service) handleUploadStatus(w http.ResponseWriter, r *http.Request, u User) {
	sess, ok, err := s.store.GetUploadSession(r.Context(), r.PathValue("uploadId"), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	body := map[string]any{"received": sess.Received}
	// For a pre-upload, also where its room is joinable until — this is the
	// request a client falls back to when an append's answer is lost, and the
	// deadline that append bought is precisely what it came back for.
	//
	// A plain READ, unlike the append's pairRoomStillOpen: it does not void an
	// expired room, it does not refuse, and a room that is over is simply not
	// spoken for (persistedRoomJoinDeadline, where the whole rule lives). Read at
	// RESPONSE time from the row itself, so a probe that overlaps a sibling
	// append's commit reports the deadline the room ends up with rather than one
	// this request derived on the way past.
	body = withRoomDeadline(body, s.persistedRoomJoinDeadline(r.Context(), sess.PairRoomID))
	httpx.WriteJSON(w, http.StatusOK, body)
}

// parseContentRangeStart pulls N from "bytes N-M/total" (the standard request
// Content-Range the browser sends for a chunk). Only the start is needed; end
// and total are advisory.
func parseContentRangeStart(h string) (int64, bool) {
	spec, ok := strings.CutPrefix(h, "bytes ")
	if !ok {
		return 0, false
	}
	dash := strings.IndexByte(spec, '-')
	if dash <= 0 {
		return 0, false
	}
	n, err := strconv.ParseInt(spec[:dash], 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}
