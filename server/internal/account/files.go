package account

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

const (
	dayWindow        = int64(86400)
	maxManifestBytes = 64 * 1024
)

// minBillableBytes floors each upload's quota debit (M3a). A near-zero object
// still costs 64 KiB of the DailyQuota, which caps object COUNT (~DailyQuota/64KiB
// per day) without a separate hard row limit; actual stored size is unaffected.
const minBillableBytes = 64 << 10

// errTooLarge is returned by cappedReader once the upload exceeds the live
// max_file_size; it propagates out of BlobStore.Put so no oversize blob commits.
var errTooLarge = errors.New("account: upload exceeds max file size")

// cappedReader fails the copy as soon as more than max bytes are read.
type cappedReader struct {
	r   io.Reader
	n   int64
	max int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.n > c.max {
		return n, errTooLarge
	}
	return n, err
}

// registerFileRoutes mounts the stored-transfer endpoints on the account mux.
// Public routes (meta/blob) are unauthenticated; the rest require auth — a
// session cookie (browser) or a CLI bearer token (RequireAuth covers both).
func (s *Service) registerFileRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/files", s.RequireAuth(s.handleUploadFile))
	// Resumable chunked upload (browser): init → append chunks → finalize, with a
	// status probe for resume. Kept under /api/uploads (not /api/files/uploads) so
	// it can't collide with the /api/files/{id}/... wildcard routes. The
	// single-shot POST /api/files above stays for the CLI.
	mux.HandleFunc("POST /api/uploads", s.RequireAuth(s.handleUploadInit))
	mux.HandleFunc("PATCH /api/uploads/{uploadId}", s.RequireAuth(s.handleUploadChunk))
	mux.HandleFunc("POST /api/uploads/{uploadId}/finalize", s.RequireAuth(s.handleUploadFinalize))
	mux.HandleFunc("GET /api/uploads/{uploadId}", s.RequireAuth(s.handleUploadStatus))
	mux.HandleFunc("GET /api/files", s.RequireAuth(s.handleListFiles))
	mux.HandleFunc("DELETE /api/files/{id}", s.RequireAuth(s.handleDeleteFile))
	mux.HandleFunc("GET /api/files/{id}/meta", s.handleFileMeta)
	mux.HandleFunc("GET /api/files/{id}/blob", s.handleFileBlob)
}

func (s *Service) handleUploadFile(w http.ResponseWriter, r *http.Request, u User) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	// M1: cap concurrent uploads per account so a burst of parallel writes can't
	// pile MaxFileSize each onto disk before the quota refuses them.
	if !s.uploadSem.acquire(u.ID) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	defer s.uploadSem.release(u.ID)

	// Content-Length is the whole body (4-byte manifest length + encManifest +
	// ciphertext), so it slightly OVER-states the ciphertext — conservative in the
	// right direction for a free-space bar, and it is all we have this early (mlen
	// is only read below). <=0 for a chunked request; placementMinFree floors it.
	nodeID, bs, billable, perr := s.placeUpload(r.Context(), u.ID, r.ContentLength)
	if errors.Is(perr, errStrictNodeFull) {
		http.Error(w, "your storage node has no free space", http.StatusServiceUnavailable)
		return
	}
	if errors.Is(perr, errStrictNoNode) {
		http.Error(w, "your storage node is offline", http.StatusServiceUnavailable)
		return
	}

	// M3b: global blob-volume soft cap. Per-account quota × unbounded accounts is
	// still unbounded, so refuse new uploads once the volume crosses the high-water
	// mark. A usage read error fails open (never block every upload on one Statfs blip).
	// Applies only to central-local placement: a node-routed upload never touches
	// central disk, so it must not be blocked by central disk being full.
	if nodeID == "" && s.diskUsage != nil && s.blobDiskMax > 0 {
		if used, _, err := s.diskUsage(); err != nil {
			log.Printf("disk-usage check failed: %v (fail-open, accepting upload)", err)
		} else if used >= uint64(s.blobDiskMax) {
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
	// Length-prefixed opaque encrypted manifest.
	var mlen uint32
	if err := binary.Read(br, binary.BigEndian, &mlen); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if int64(mlen) > maxManifestBytes {
		http.Error(w, "manifest too large", http.StatusBadRequest)
		return
	}
	encManifest := make([]byte, mlen)
	if _, err := io.ReadFull(br, encManifest); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	now := s.now().Unix()

	// Cheap pre-check to avoid writing a blob we'd immediately delete: if the
	// declared body already overflows the remaining daily quota, reject before
	// touching disk. Content-Length is client-supplied, so it is trusted only to
	// fail fast — never to admit; the authoritative gate is ReserveUpload below.
	// Own-node uploads (billable=false) use the user's own disk, not our
	// DailyQuota, so this pre-check does not apply to them.
	if billable && r.ContentLength > 0 {
		declared := r.ContentLength - 4 - int64(mlen) // ciphertext bytes (minus framing)
		if declared > 0 {
			used, err := s.store.UserUploadedSince(r.Context(), u.ID, now-dayWindow)
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			// Same fail-closed orientation as the UserUploadedSince read above:
			// a store error here aborts with 500 rather than guessing a quota.
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
	}

	// Per-plan gates (billable central-stored uploads only; own-node uploads use
	// the user's own disk and are never metered against a plan).
	if billable {
		declared := r.ContentLength - 4 - int64(mlen) // ciphertext bytes (minus framing)
		if declared < 0 {
			declared = 0
		}
		// Global logical storage ceiling (oversubscription backstop) first.
		if over, err := s.overGlobalStorage(r.Context(), declared); err == nil && over {
			http.Error(w, "server storage is full", http.StatusInsufficientStorage)
			return
		}
		if over, err := s.overStorage(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}

	blobKey := randToken()
	// Bound the on-disk write. Own-node uploads use the user's own disk, so only
	// MaxFileSize applies; a billable central upload is additionally capped to
	// what the user could actually keep (uploadWriteCap) so a chunked/understated
	// Content-Length can't stream a full MaxFileSize blob only to be dropped.
	writeCap := st.MaxFileSize
	if billable {
		if c := s.uploadWriteCap(r.Context(), u.ID, st.MaxFileSize); c < writeCap {
			writeCap = c
		}
	}
	capped := &cappedReader{r: br, max: writeCap}
	size, err := bs.Put(r.Context(), blobKey, capped)
	if err != nil {
		// Reclaim a committed-but-response-lost blob; if the node is unreachable
		// the pending-delete queue ensures GC retries instead of orphaning it.
		s.dropBlob(bs, blobKey, nodeID)
		if errors.Is(err, errTooLarge) {
			http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// Authoritative post-write re-check on the REAL received size. The pre-gate
	// above trusts client-declared Content-Length only to fail fast (a chunked
	// request or an understated Content-Length yields declared<=0 and sails
	// through it), so a dishonest/broken client could stream up to
	// MaxFileSize past the pre-gate. Storage caps are enforced atomically at
	// persist time below (persistStoredFile); only traffic is rechecked here.
	if billable {
		if over, err := s.overTraffic(r.Context(), u.ID, size); err == nil && over {
			s.dropBlob(bs, blobKey, nodeID)
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}

	// Daily quota: atomically re-read the rolling 24h sum, verify this upload
	// fits, and record the event in one transaction. This closes the read/record
	// race where concurrent uploads each see a stale sum and collectively bust the
	// quota. Reserve first, then commit the file — if either fails, drop the blob.
	// The debit is billed at max(size, minBillableBytes): a near-zero object
	// still costs the 64 KiB floor, indirectly capping object count; the stored
	// row/stats below stay at the actual size.
	// Own-node uploads (billable=false) skip this entirely: they never reserved
	// against the daily quota, so there is nothing to refund on failure below.
	if billable {
		billed := size
		if billed < minBillableBytes {
			billed = minBillableBytes
		}
		// This is the authoritative gate, so a quota read error fails CLOSED
		// exactly like the ReserveUpload error just below: drop the blob and 500,
		// never admit an upload against an unknown cap.
		quota, err := s.dailyQuotaFor(r.Context(), u.ID)
		if err != nil {
			s.dropBlob(bs, blobKey, nodeID)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		ok, err := s.store.ReserveUpload(r.Context(),
			UploadEvent{ID: newID(), UserID: u.ID, Bytes: billed, UploadedAt: now},
			now-dayWindow, quota)
		if err != nil {
			s.dropBlob(bs, blobKey, nodeID)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			s.dropBlob(bs, blobKey, nodeID)
			http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
			return
		}
	}
	id := newID()
	// resolveRetention above turns request params + admin default policy into
	// (ttl, maxDL); maxDL==1 is the burn-equivalent slot count, so the
	// generalized ClaimDownloadSlot enforcement (files.go handleFileBlob) covers
	// burn without a separate code path. BurnAfterRead itself is kept for
	// back-compat/display only.
	sf := StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
		Size: size, BurnAfterRead: maxDL == 1, CreatedAt: now, ExpiresAt: now + ttl, NodeID: nodeID,
		MaxDownloads: maxDL,
	}
	// Atomic, fail-closed storage-cap enforcement + insert. This is what actually
	// stops N concurrent uploads from collectively busting the plan/global cap
	// (the over* pre-checks race and fail open).
	switch reason, err := s.persistStoredFile(r.Context(), sf, billable); {
	case err != nil:
		s.dropBlob(bs, blobKey, nodeID)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	case reason == "global":
		s.dropBlob(bs, blobKey, nodeID)
		http.Error(w, "server storage is full", http.StatusInsufficientStorage)
		return
	case reason == "storage":
		s.dropBlob(bs, blobKey, nodeID)
		http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
		return
	}
	// Lifetime stats are best-effort: a stats write failure must not fail the
	// upload the user already completed.
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
	_ = s.store.RecordMeter(r.Context(), u.ID, MeterUpload, size, now)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "expiresAt": sf.ExpiresAt})
}

// dropBlob reclaims an orphaned upload blob. It deletes best-effort, and on a
// node/transport failure records a pending delete so GC retries instead of
// leaking the blob. Uses a fresh context so cleanup survives a cancelled
// request (the client hangup that stranded the blob in the first place).
func (s *Service) dropBlob(bs storage.BlobStore, blobKey, nodeID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := bs.Delete(ctx, blobKey); err != nil {
		_ = s.store.EnqueueNodeDelete(ctx, blobKey, nodeID, s.now().Unix())
	}
}

func (s *Service) handleFileMeta(w http.ResponseWriter, r *http.Request) {
	sf, ok := s.liveFile(r, r.PathValue("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"encManifest":   base64.StdEncoding.EncodeToString(sf.EncManifest),
		"size":          sf.Size,
		"burnAfterRead": sf.BurnAfterRead,
		"expiresAt":     sf.ExpiresAt,
	})
}

func (s *Service) handleFileBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	sf, ok := s.liveFile(r, r.PathValue("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Per-plan traffic gate, charged to the file's OWNER (downloader identity is
	// never read — zero-knowledge). Over quota → the owner's shares pause until
	// the month rolls over or they upgrade. Fail-open on a read error.
	if over, err := s.overTraffic(r.Context(), sf.UserID, sf.Size); err == nil && over {
		http.Error(w, "this file's account has reached its monthly traffic limit", http.StatusTooManyRequests)
		return
	}
	bs, err := s.blobFor(r.Context(), sf.NodeID)
	if err != nil {
		http.Error(w, "storage node unavailable", http.StatusServiceUnavailable)
		return
	}
	// Retention & resume gating: unlimited files (max_downloads==0) stream
	// freely and support HTTP Range, so an interrupted download can resume.
	// Limited files claim a slot BEFORE streaming so an offline node never
	// spends a shot, and deliberately do NOT support Range — a resumed download
	// is several stateless GETs that can't be reconciled with max-downloads/burn
	// accounting, so they always serve the whole blob. slot is THIS request's
	// own 1-based slot number (from the same atomic UPDATE that incremented
	// download_count) — the post-delivery delete gates on it directly rather
	// than re-reading download_count, which would be racy: a concurrent
	// in-flight (later-failing) claim could inflate the count and make an
	// earlier, genuinely-final-slot-less download look like the last one.
	limited := sf.MaxDownloads > 0
	var start int64
	if !limited {
		start = parseRangeStart(r.Header.Get("Range"), sf.Size)
	}

	rc, err := bs.GetRange(r.Context(), sf.BlobKey, start)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		// Node exists but is unreachable: the file's single copy is offline.
		http.Error(w, "storage node offline, try again later", http.StatusServiceUnavailable)
		return
	}
	defer rc.Close()

	var claimAt, slot int64
	if limited {
		claimAt = s.now().Unix()
		var claimed bool
		var cerr error
		slot, claimed, cerr = s.store.ClaimDownloadSlot(r.Context(), sf.ID, claimAt)
		if cerr != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !claimed {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	if !limited {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if start > 0 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, sf.Size-1, sf.Size))
		w.Header().Set("Content-Length", strconv.FormatInt(sf.Size-start, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(sf.Size, 10))
	}
	n, err := io.Copy(w, rc)
	complete := err == nil && n == sf.Size-start

	// Meter/stat the OWNER for the bytes THIS request actually egressed — whether
	// or not the transfer completed — never the downloader (no downloader identity
	// is read or stored). Bytes that physically left the server count against the
	// owner's monthly traffic even on a mid-stream abort: without this a link/key
	// holder could `Range: bytes=0-`, drain all-but-the-last frame, RST, and pull
	// an unlimited file an unbounded number of times with ZERO metering, so the
	// overTraffic gate at the top of this handler never trips — a download-side
	// traffic-cap bypass and egress amplifier. The stored blob is chunk-AEAD, so
	// partial bytes ARE usable plaintext. Metering the served count (n), not
	// sf.Size, avoids over-charging a resume for bytes a prior (already-metered)
	// attempt sent: a start=0 partial then a Range resume together meter the whole
	// file exactly once.
	//
	// These writes MUST NOT ride r.Context(): a client typically drops the
	// connection the instant it receives the last byte (and an abort cancels it
	// mid-copy), which would silently lose every best-effort write below. A fresh,
	// short-lived context detaches the accounting from the client.
	if n > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.store.AddDownloadStat(ctx, sf.UserID, n)
		_ = s.store.RecordMeter(ctx, sf.UserID, MeterDownload, n, s.now().Unix())
		cancel()
	}

	if !complete {
		// Incomplete delivery (client hung up / network hiccup). Refund the claim
		// ONLY when nothing was delivered (n == 0): a genuine connect-then-drop
		// that leaked no content shouldn't cost the owner a download. Once ANY
		// bytes were sent, the slot is spent — otherwise a link/key holder could
		// drain all-but-the-last frame and RST on every request, so the slot was
		// always released, download_count never advanced, and a burn/limited file
		// stayed alive to be pulled an unbounded number of times. Treating a
		// near-complete read as "free" is exactly the burn bypass; the
		// download-once guarantee wins over a mid-transfer retry for limited files.
		if limited && n == 0 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = s.store.ReleaseDownloadSlot(ctx, sf.ID)
			cancel()
		}
		return
	}

	// Complete delivery: finalize the burn/limited deletion or bump the unlimited
	// download count. Fresh context for the same reason as the metering above.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if limited {
		// Delete iff THIS request took the final slot (its own claimed slot
		// number is >= MaxDownloads) — never by re-reading download_count, which
		// a concurrent claim could have already bumped past MaxDownloads on a
		// request that hasn't (and may never) finish delivering.
		if slot >= sf.MaxDownloads {
			if derr := bs.Delete(ctx, sf.BlobKey); derr != nil {
				// Node unreachable: record the orphan so GC retries; still remove the row.
				_ = s.store.EnqueueNodeDelete(ctx, sf.BlobKey, sf.NodeID, s.now().Unix())
			}
			_ = s.store.DeleteStoredFile(ctx, sf.ID)
		}
	} else {
		_ = s.store.IncDownloadCount(ctx, sf.ID)
	}
}

// parseRangeStart extracts N from a "bytes=N-" Range header — the only form the
// resumable client sends. Anything absent, malformed, a suffix ("-N"), an
// explicit-end ("N-M"), a multi-range, or an out-of-bounds start yields 0 (serve
// the whole object). The returned start is guaranteed to be in (0, size).
func parseRangeStart(h string, size int64) int64 {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || !strings.HasSuffix(spec, "-") || strings.Contains(spec, ",") {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSuffix(spec, "-"), 10, 64)
	if err != nil || n <= 0 || n >= size {
		return 0
	}
	return n
}

func (s *Service) handleListFiles(w http.ResponseWriter, r *http.Request, u User) {
	files, err := s.store.ListStoredFilesByUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		out = append(out, map[string]any{
			"id":            f.ID,
			"size":          f.Size,
			"createdAt":     f.CreatedAt,
			"expiresAt":     f.ExpiresAt,
			"burnAfterRead": f.BurnAfterRead,
			"downloaded":    f.DownloadedAt > 0,
			"downloadCount": f.DownloadCount,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out})
}

func (s *Service) handleDeleteFile(w http.ResponseWriter, r *http.Request, u User) {
	sf, err := s.store.GetStoredFile(r.Context(), r.PathValue("id"))
	if err != nil || sf.UserID != u.ID {
		// Non-owner and missing are indistinguishable: no existence leak.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if bs, berr := s.blobFor(r.Context(), sf.NodeID); berr == nil {
		if derr := bs.Delete(r.Context(), sf.BlobKey); derr != nil {
			// Node unreachable: record the orphan so GC retries; still remove the row.
			_ = s.store.EnqueueNodeDelete(r.Context(), sf.BlobKey, sf.NodeID, s.now().Unix())
		}
	} else {
		_ = s.store.EnqueueNodeDelete(r.Context(), sf.BlobKey, sf.NodeID, s.now().Unix())
	}
	if err := s.store.DeleteStoredFile(r.Context(), sf.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// liveFile fetches a stored file that exists and has not expired; ok=false maps
// to a 404 for missing, expired, or store errors (fail closed).
func (s *Service) liveFile(r *http.Request, id string) (StoredFile, bool) {
	sf, err := s.store.GetStoredFile(r.Context(), id)
	if err != nil || s.now().Unix() >= sf.ExpiresAt {
		return StoredFile{}, false
	}
	// A limited-download file whose slots are already spent is gone: treat it as
	// gone even if the row lingers (e.g. an interrupted stream that claimed a
	// slot but never reached the cleanup delete).
	if sf.MaxDownloads > 0 && sf.DownloadCount >= sf.MaxDownloads {
		return StoredFile{}, false
	}
	return sf, true
}
