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
}

// resumableUploads is the in-memory registry of upload sessions, keyed by a
// random uploadId.
type resumableUploads struct {
	mu sync.Mutex
	m  map[string]*uploadSession
}

func newResumableUploads() *resumableUploads {
	return &resumableUploads{m: map[string]*uploadSession{}}
}

func (ru *resumableUploads) put(id string, s *uploadSession) {
	ru.mu.Lock()
	ru.m[id] = s
	ru.mu.Unlock()
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

func (ru *resumableUploads) del(id string) {
	ru.mu.Lock()
	delete(ru.m, id)
	ru.mu.Unlock()
}

// expired removes and returns every session older than ttl, for the reaper.
func (ru *resumableUploads) expired(now, ttl int64) []*uploadSession {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	var out []*uploadSession
	for id, s := range ru.m {
		if now-s.createdAt >= ttl {
			out = append(out, s)
			delete(ru.m, id)
		}
	}
	return out
}

// ReapPendingUploads drops abandoned upload sessions and their partial blobs.
// Wired into the GC tick (see main.go). now is unix seconds.
func (s *Service) ReapPendingUploads(now int64) {
	for _, sess := range s.resumable.expired(now, pendingUploadTTL) {
		s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
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
		if used+declared > st.DailyQuota {
			http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
			return
		}
	}

	sess := &uploadSession{
		userID: u.ID, blobKey: randToken(), nodeID: nodeID, bs: bs, billable: billable,
		encManifest: encManifest, ttl: ttl, maxDL: maxDL, maxSize: st.MaxFileSize,
		createdAt: s.now().Unix(),
	}
	uploadID := newID()
	s.resumable.put(uploadID, sess)
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

	size := sess.received
	now := s.now().Unix()
	if sess.billable {
		billed := size
		if billed < minBillableBytes {
			billed = minBillableBytes
		}
		reserved, err := s.store.ReserveUpload(r.Context(),
			UploadEvent{ID: newID(), UserID: u.ID, Bytes: billed, UploadedAt: now},
			now-dayWindow, s.resolveSettings(r.Context()).DailyQuota)
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
