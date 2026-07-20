package account

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/relayium/relayium/internal/storage"
)

// uploadChunkSize is the chunk size the client is told to use: large enough to
// amortise per-request overhead, small enough that a reset loses little and no
// single request runs long enough to trip an edge timeout.
const uploadChunkSize = 8 << 20 // 8 MiB

// pendingUploadTTL bounds how long an abandoned chunked-upload session (and its
// partial blob) lives before the reaper drops it.
const pendingUploadTTL = int64(3600) // 1 h

// uploadSession is the server-side state of one in-progress chunked upload. It
// lives only in memory (see resumableUploads): relayium is a single instance
// and a session need only outlive one upload; a restart abandons it and the
// reaper/GC reclaims the partial blob.
type uploadSession struct {
	mu          sync.Mutex // serialises chunks of THIS upload
	userID      string
	blobKey     string
	nodeID      string
	bs          storage.BlobStore
	billable    bool
	encManifest []byte
	ttl         int64
	maxDL       int64
	maxSize     int64 // MaxFileSize snapshot at init
	received    int64 // bytes committed to the blob so far
	createdAt   int64
	// done is set (under mu) by the first terminal action — finalize, or the
	// reaper's drop — so a racing second finalize can't double-bill/double-create
	// and a chunk can't append to (or the reaper drop) a blob another goroutine
	// has already committed or reclaimed.
	done bool
}

// maxSessionsPerUser caps concurrent open chunked-upload sessions per account.
// Without it, handleUploadInit — which reserves no quota until finalize — lets a
// single account pin maxSessionsPerUser×MaxFileSize of partial blobs on disk (and
// their manifests in RAM) indefinitely, unbilled. Shares the single-shot path's
// per-account concurrency budget (M1).
const maxSessionsPerUser = maxConcurrentUploadsPerUser

// resumableUploads is the in-memory registry of upload sessions, keyed by a
// random uploadId. perUser tracks each account's open-session count so a single
// account can't open unbounded sessions; entries are pruned at zero.
type resumableUploads struct {
	mu      sync.Mutex
	m       map[string]*uploadSession
	perUser map[string]int
	maxUser int
}

func newResumableUploads() *resumableUploads {
	return &resumableUploads{m: map[string]*uploadSession{}, perUser: map[string]int{}, maxUser: maxSessionsPerUser}
}

// tryPut registers a session, returning false if userID is already at its
// open-session cap (caller should 429). The count is released by del/expired.
func (ru *resumableUploads) tryPut(id string, s *uploadSession) bool {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	if ru.perUser[s.userID] >= ru.maxUser {
		return false
	}
	ru.m[id] = s
	ru.perUser[s.userID]++
	return true
}

// get returns the session for id only if it belongs to userID (ownership gate).
func (ru *resumableUploads) get(id, userID string) (*uploadSession, bool) {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	s, ok := ru.m[id]
	if !ok || s.userID != userID {
		return nil, false
	}
	return s, true
}

// release drops userID's open-session count by one, pruning the entry at zero.
// Caller holds ru.mu.
func (ru *resumableUploads) release(userID string) {
	if ru.perUser[userID] <= 1 {
		delete(ru.perUser, userID)
		return
	}
	ru.perUser[userID]--
}

func (ru *resumableUploads) del(id string) {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	if s, ok := ru.m[id]; ok {
		ru.release(s.userID)
		delete(ru.m, id)
	}
}

// expired removes and returns every session older than ttl, for the reaper.
func (ru *resumableUploads) expired(now, ttl int64) []*uploadSession {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	var out []*uploadSession
	for id, s := range ru.m {
		if now-s.createdAt >= ttl {
			out = append(out, s)
			ru.release(s.userID)
			delete(ru.m, id)
		}
	}
	return out
}

// ReapPendingUploads drops abandoned upload sessions and their partial blobs.
// Wired into the GC tick (see main.go). now is unix seconds. It takes each
// session's mutex and honours the done flag so it never drops a blob a
// concurrent finalize has already committed, nor races an in-flight chunk append.
func (s *Service) ReapPendingUploads(now int64) {
	for _, sess := range s.resumable.expired(now, pendingUploadTTL) {
		sess.mu.Lock()
		if sess.done {
			sess.mu.Unlock()
			continue // already finalized (blob kept) or dropped
		}
		sess.done = true
		bs, key, node := sess.bs, sess.blobKey, sess.nodeID
		sess.mu.Unlock()
		s.dropBlob(bs, key, node)
	}
}

// handleUploadInit (POST /api/files/uploads) starts a chunked upload. The body
// is the length-prefixed encrypted manifest (uint32BE(len)||encManifest), the
// same header the single-shot upload leads with; retention comes from the query
// and the declared ciphertext size from ?size=. It runs the same placement,
// disk-cap and daily-quota pre-checks as the single-shot path, then mints a
// session and returns {uploadId, chunkSize}.
func (s *Service) handleUploadInit(w http.ResponseWriter, r *http.Request, u User) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	nodeID, bs, billable, perr := s.placeUpload(r.Context(), u.ID)
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

	st := s.resolveSettings(r.Context())
	burn := r.URL.Query().Get("burnAfterRead") == "1"
	reqTTL, _ := strconv.ParseInt(r.URL.Query().Get("ttl"), 10, 64)
	reqMaxDL, _ := strconv.ParseInt(r.URL.Query().Get("maxDownloads"), 10, 64)
	ttl, maxDL := resolveRetention(burn, reqTTL, reqMaxDL, st)
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
	declared, _ := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
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

	sess := &uploadSession{
		userID: u.ID, blobKey: randToken(), nodeID: nodeID, bs: bs, billable: billable,
		encManifest: encManifest, ttl: ttl, maxDL: maxDL, maxSize: st.MaxFileSize,
		createdAt: s.now().Unix(),
	}
	uploadID := newID()
	if !s.resumable.tryPut(uploadID, sess) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"uploadId": uploadID, "chunkSize": uploadChunkSize})
}

// handleUploadChunk (PATCH /api/files/uploads/{uploadId}) appends one chunk. The
// Content-Range's start must equal the bytes already committed; a stale start
// (already received) is acked idempotently, a gap is 409 with the real offset.
func (s *Service) handleUploadChunk(w http.ResponseWriter, r *http.Request, u User) {
	sess, ok := s.resumable.get(r.PathValue("uploadId"), u.ID)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	start, okr := parseContentRangeStart(r.Header.Get("Content-Range"))
	if !okr {
		http.Error(w, "bad Content-Range", http.StatusBadRequest)
		return
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	if sess.done {
		// Finalized or reaped while this chunk was in flight; the blob is no longer
		// ours to append to.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if start < sess.received {
		// Client re-sent bytes we already have (a resume overshoot) — ack the
		// current offset so it advances without corrupting the blob.
		writeJSON(w, http.StatusOK, map[string]any{"received": sess.received})
		return
	}
	if start > sess.received {
		writeJSON(w, http.StatusConflict, map[string]any{"received": sess.received})
		return
	}

	// M3b: the global blob-volume soft cap is only checked at init; a chunked
	// upload grows the blob incrementally, so re-check here so a session opened
	// while there was room can't keep appending past the high-water mark. Applies
	// only to central-local placement; a usage-read error fails open, matching the
	// single-shot path.
	if sess.nodeID == "" && s.diskUsage != nil && s.blobDiskMax > 0 {
		if used, _, err := s.diskUsage(); err == nil && used >= uint64(s.blobDiskMax) {
			http.Error(w, "storage temporarily full", http.StatusServiceUnavailable)
			return
		}
	}

	capped := &cappedReader{r: r.Body, max: sess.maxSize - sess.received}
	newSize, err := sess.bs.Append(r.Context(), sess.blobKey, sess.received, capped)
	sess.received = newSize // Append reports bytes written even on error
	if errors.Is(err, errTooLarge) {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	if errors.Is(err, storage.ErrOffsetMismatch) {
		// The blob and our counter disagree (e.g. a duplicated request lost the
		// race); report the blob's truth so the client re-syncs.
		writeJSON(w, http.StatusConflict, map[string]any{"received": newSize})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": newSize})
}

// handleUploadFinalize (POST /api/files/uploads/{uploadId}/finalize) commits the
// upload: it reserves the daily quota against the real byte count, creates the
// stored-file row, records stats/metering, and drops the session.
func (s *Service) handleUploadFinalize(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("uploadId")
	sess, ok := s.resumable.get(id, u.ID)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if sess.done {
		// A concurrent finalize already committed (or the reaper dropped) this
		// session; don't bill or create a second file row for the same blob.
		http.Error(w, "already finalized", http.StatusConflict)
		return
	}
	sess.done = true // claim the session so a racing finalize/reaper backs off

	size := sess.received
	now := s.now().Unix()
	if sess.billable {
		// Authoritative per-plan gate on the real byte count now that the upload
		// is complete (the init pre-check only saw the client-declared size).
		if over, err := s.overStorage(r.Context(), u.ID, size); err == nil && over {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, size); err == nil && over {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}
	if sess.billable {
		billed := size
		if billed < minBillableBytes {
			billed = minBillableBytes
		}
		// Authoritative gate: a quota read error fails CLOSED just like the
		// ReserveUpload error below — drop the blob, kill the session, 500.
		quota, err := s.dailyQuotaFor(r.Context(), u.ID)
		if err != nil {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		reserved, err := s.store.ReserveUpload(r.Context(),
			UploadEvent{ID: newID(), UserID: u.ID, Bytes: billed, UploadedAt: now},
			now-dayWindow, quota)
		if err != nil {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !reserved {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
			return
		}
	}

	fid := newID()
	sf := StoredFile{
		ID: fid, UserID: u.ID, BlobKey: sess.blobKey, EncManifest: sess.encManifest,
		Size: size, BurnAfterRead: sess.maxDL == 1, CreatedAt: now, ExpiresAt: now + sess.ttl,
		NodeID: sess.nodeID, MaxDownloads: sess.maxDL,
	}
	if err := s.store.CreateStoredFile(r.Context(), sf); err != nil {
		s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
		s.resumable.del(id)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
	_ = s.store.RecordMeter(r.Context(), u.ID, MeterUpload, size, now)
	s.resumable.del(id)
	writeJSON(w, http.StatusOK, map[string]any{"id": fid, "expiresAt": sf.ExpiresAt})
}

// handleUploadStatus (GET /api/files/uploads/{uploadId}) reports the committed
// offset so a client can resume after an interruption.
func (s *Service) handleUploadStatus(w http.ResponseWriter, r *http.Request, u User) {
	sess, ok := s.resumable.get(r.PathValue("uploadId"), u.ID)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	sess.mu.Lock()
	received := sess.received
	sess.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"received": received})
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
