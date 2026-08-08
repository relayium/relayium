package account

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
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

// pendingUploadTTL bounds how long an abandoned chunked-upload session (and its
// partial blob) lives before the reaper drops it.
const pendingUploadTTL = int64(3600) // 1 h

// maxSessionsPerUser caps concurrent open chunked-upload sessions per account.
// Without it, handleUploadInit — which reserves no quota until finalize — lets a
// single account pin maxSessionsPerUser×MaxFileSize of partial blobs on disk (and
// their manifests) indefinitely, unbilled. Shares the single-shot path's
// per-account concurrency budget (M1).
const maxSessionsPerUser = maxConcurrentUploadsPerUser

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

// ReapPendingUploads drops abandoned upload sessions and their partial blobs.
// Wired into the GC tick (see main.go). now is unix seconds. It runs two passes,
// both keyed on IDLE time (no chunk since) rather than absolute age, so a legit
// long upload is never reaped mid-flight:
//   - open sessions idle past the TTL: claim `done` atomically before dropping,
//     so it never races a finalize that already committed the blob;
//   - finalized (done=1) sessions idle past the TTL whose blob nothing
//     references — a finalize that crashed before persisting the file — whose
//     partial blob would otherwise leak forever.
func (s *Service) ReapPendingUploads(now int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	before := now - pendingUploadTTL
	if rows, err := s.store.ListExpiredOpenUploadSessions(ctx, before); err == nil {
		for _, r := range rows {
			if _, ok, err := s.store.ClaimUploadDone(ctx, r.ID, now); err != nil || !ok {
				continue // finalized (blob kept) or claimed by another reaper
			}
			s.dropUploadBlob(ctx, r.NodeID, r.BlobKey)
			_ = s.store.DeleteUploadSession(ctx, r.ID)
		}
	}
	// Orphaned finalized rows: drop the unreferenced blob, then purge every stale
	// done=1 row (referenced ones keep their now-live blob; this only clears the
	// leftover session row, including any the open pass above failed to delete).
	if orphans, err := s.store.ListOrphanDoneUploadSessions(ctx, before); err == nil {
		for _, r := range orphans {
			s.dropUploadBlob(ctx, r.NodeID, r.BlobKey)
		}
	}
	_ = s.store.PurgeDoneUploadSessions(ctx, before)
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

	row := UploadSessionRow{
		ID: authx.NewID(), UserID: u.ID, BlobKey: authx.RandToken(), NodeID: nodeID, Billable: billable,
		EncManifest: encManifest, TTL: ttl, MaxDL: maxDL, Purpose: purpose,
		MaxSize:   s.sessionWriteCap(r.Context(), u.ID, st.MaxFileSize, billable),
		CreatedAt: s.now().Unix(),
	}
	ok, err := s.store.CreateUploadSession(r.Context(), row, maxSessionsPerUser)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"uploadId": row.ID, "chunkSize": uploadChunkSize})
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
	sess, ok, err := s.store.GetUploadSession(r.Context(), uploadID, u.ID)
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
	if start < sess.Received {
		// Client re-sent bytes we already have (a resume overshoot) — ack the
		// current offset so it advances without corrupting the blob.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"received": sess.Received})
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

	bs, err := s.blobFor(r.Context(), sess.NodeID)
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
	capped := &cappedReader{r: io.LimitReader(r.Body, maxAppendBytes), max: sess.MaxSize - sess.Received}
	newSize, err := bs.Append(r.Context(), sess.BlobKey, sess.Received, capped)
	if errors.Is(err, errTooLarge) {
		// Oversize chunk. Do NOT advance the offset here: on the remote-node path
		// the request aborted mid-body, so Append returns 0 — advancing would
		// clobber the committed offset. Leave it unchanged; the upload is rejected
		// (413) and the client stops. (The node committed up to the cap; a client
		// that ignores the 413 and retries resyncs via the offset-mismatch path.)
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	// Mirror the blob's authoritative size into the DB (monotonic; a no-op if a
	// concurrent request already advanced past it or the session was finalized;
	// clamped to max_size so a lying node can't inflate the ledger). Stamps
	// last_activity so the idle reaper knows this session is still progressing.
	if uerr := s.store.AdvanceUploadReceived(r.Context(), sess.ID, newSize, s.now().Unix()); uerr != nil {
		log.Printf("upload chunk %s: advance received to %d: %v", uploadID, newSize, uerr)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if errors.Is(err, storage.ErrOffsetMismatch) {
		// The blob and our counter disagree (e.g. a duplicated request lost the
		// race); report the blob's truth so the client re-syncs.
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{"received": newSize})
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"received": newSize})
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
	// Claim the session terminally, getting the committed size at that instant. A
	// racing finalize (or the reaper) that already claimed it loses here.
	size, claimed, err := s.store.ClaimUploadDone(r.Context(), sess.ID, s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !claimed {
		http.Error(w, "already finalized", http.StatusConflict)
		return
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
	if sess.Billable {
		// Authoritative per-plan traffic gate on the real byte count now that the
		// upload is complete (the init pre-check only saw the client-declared
		// size). Storage caps are enforced atomically at persist time below.
		if over, err := s.overTraffic(r.Context(), u.ID, size); err == nil && over {
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
	}
	// Atomic, fail-closed storage-cap enforcement + insert (see persistStoredFile).
	switch reason, err := s.persistStoredFile(r.Context(), sf, sess.Billable); {
	case err != nil:
		fail("server error", http.StatusInternalServerError)
		return
	case reason == "global":
		fail("server storage is full", http.StatusInsufficientStorage)
		return
	case reason == "storage":
		fail("storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
		return
	}
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
	// Own-node uploads (billable=false) are not metered against the plan (see the
	// single-shot path); only billable central/fleet storage counts.
	if sess.Billable {
		_ = s.store.RecordMeter(r.Context(), u.ID, MeterUpload, size, now)
	}
	_ = s.store.DeleteUploadSession(r.Context(), sess.ID)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": fid, "expiresAt": sf.ExpiresAt})
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"received": sess.Received})
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
