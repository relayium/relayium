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
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/dltoken"
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

// byoUpdateExemptWindow bounds how long a BYO owner's downloads stay free while
// we restart their node to update it. It must cover a real update (download +
// the node's 60s drain + restart + the updater's 10-minute health watch) but
// must expire: a node commanded hours ago and never seen again is broken, not
// updating, and a permanently "updating" node would otherwise earn permanent
// free egress. Deliberately a little longer than the updater's health window.
const byoUpdateExemptWindow = 20 * time.Minute

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

// errClientBodyReleased is what clientBody returns to any reader that arrives
// after the handler took the request body back.
var errClientBodyReleased = errors.New("account: upload body already released")

// clientBodyReleaseWait bounds how long release waits for a read that is still
// running when the handler takes the body back.
const clientBodyReleaseWait = 5 * time.Second

// clientBody is the single-shot upload's request body as the handler owns it:
// it counts every byte read from the client and can be taken back.
//
// bs.Put may return while something is still reading its reader:
// RemoteBlobStore hands the body to net/http, whose transport answers as soon
// as the node's response arrives and keeps copying the request body in its own
// goroutine (a node answers 401/507 before reading, and 500 mid-stream). Left
// alone, that goroutine keeps pulling client bytes after the handler has
// counted them — and after the handler has returned, when the Request.Body is
// no longer the handler's to read. release ends that: no read starts after it,
// and the one still running is interrupted through the connection's read
// deadline and waited for, so the count it returns is final and exact.
type clientBody struct {
	r        io.Reader
	mu       sync.Mutex
	n        int64
	active   int
	released bool
	idle     chan struct{} // made by release while reads run; closed when the last one returns
}

func (b *clientBody) Read(p []byte) (int, error) {
	b.mu.Lock()
	if b.released {
		b.mu.Unlock()
		return 0, errClientBodyReleased
	}
	b.active++
	b.mu.Unlock()
	n, err := b.r.Read(p)
	b.mu.Lock()
	b.n += int64(n)
	b.active--
	if b.active == 0 && b.idle != nil {
		close(b.idle)
		b.idle = nil
	}
	b.mu.Unlock()
	return n, err
}

// release takes the body back and returns how many bytes were read from it.
// A read still running is interrupted (interrupt sets the connection's read
// deadline, which also ends the request's context) and waited for, at most
// wait; if it outlasts that — only possible where the deadline cannot be set —
// the handler stops waiting rather than hang, and what that read returns later
// is logged as unbilled. Calling release again returns the count so far.
func (b *clientBody) release(interrupt func() error, wait time.Duration) int64 {
	b.mu.Lock()
	if b.released {
		defer b.mu.Unlock()
		return b.n
	}
	b.released = true
	var idle chan struct{}
	if b.active > 0 {
		b.idle = make(chan struct{})
		idle = b.idle
	}
	b.mu.Unlock()
	if idle != nil {
		if err := interrupt(); err != nil {
			log.Printf("upload: cannot interrupt the request body read still running (%v); waiting up to %v", err, wait)
		}
		t := time.NewTimer(wait)
		defer t.Stop()
		select {
		case <-idle:
		case <-t.C:
			log.Printf("upload: a request body read outlasted %v; bytes it returns later are not billed", wait)
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.n
}

// interruptBodyRead makes a body read still blocked on the client's connection
// return now, by moving the connection's read deadline to the present.
func interruptBodyRead(w http.ResponseWriter) func() error {
	return func() error { return http.NewResponseController(w).SetReadDeadline(time.Now()) }
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
	// The third public per-object route, and the only one that WRITES: a pair-room
	// receiver reporting that it has the file, which is what lets a joined room
	// end (pairroom_complete.go). Unauthenticated for the same reason the two
	// above are — the receiver of a code-first transfer has no account — and
	// authorized by a proof derived from the file key rather than by a session.
	mux.HandleFunc("POST /api/files/{id}/complete", s.handleFileComplete)
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

	st := s.ResolveSettings(r.Context())
	// Purpose and retention are resolved together (see resolveUploadRetention):
	// a task-purpose object must be unlimited-until-TTL, so an explicit
	// burn/limited request — or an unknown purpose — is refused here rather
	// than rewritten into something the caller did not ask for.
	purpose, ttl, maxDL, okp := resolveUploadRetention(r.URL.Query(), st)
	if !okp {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Pre-upload is resumable-only, and refused here rather than half-supported.
	//
	// A pairing room's deadline moves when a chunk COMMITS, and this route commits
	// exactly once, at the end: a single-shot pre-upload long enough to be worth
	// doing is long enough to let its own room expire while it is in flight, and
	// the user would pay for every byte of an upload that could never bind. One
	// explicit refusal is honest; a path that works for small objects and silently
	// fails for large ones is not.
	if purpose == StoredPurposePairRoom {
		http.Error(w, "pre-upload requires the resumable upload API (POST /api/uploads)", http.StatusBadRequest)
		return
	}
	if capSecs := s.planRetentionCap(r.Context(), u.ID); capSecs > 0 && ttl > capSecs {
		ttl = capSecs
	}

	body := &clientBody{r: r.Body}
	br := bufio.NewReader(body)
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

	blobKey := authx.RandToken()
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
	// Monthly traffic is what moved, so once bs.Put starts reading the body,
	// every way out of this handler bills the ciphertext read from the client —
	// everything past the manifest framing, never the declared Content-Length —
	// exactly once. The count is final only once the body is released (see
	// clientBody), which happens as soon as Put returns. A cancelled or
	// oversize upload that fails inside Put, and one refused after Put by a
	// later gate (traffic, daily quota, storage caps, a failed persist, a client
	// that hung up after the last byte), all used to be free or partly free:
	// the body crossed the network and the disk absorbed it, but no stored file
	// was created, so nothing was metered — free bandwidth for anyone willing
	// to be refused. The success path calls it explicitly, before answering;
	// every other return reaches it through the defer, which runs after the
	// post-Put traffic check, so that check still judges this upload against
	// the traffic that existed before it. Own-node uploads (billable=false) are
	// never metered: they use the user's own disk.
	framing := 4 + int64(mlen)
	releaseBody := func() int64 {
		return body.release(interruptBodyRead(w), clientBodyReleaseWait) - framing
	}
	metered := false
	meterConsumed := func() {
		if metered {
			return
		}
		metered = true
		// Released again here only for a panic out of Put; otherwise this is
		// the count taken when Put returned.
		if sent := releaseBody(); billable && sent > 0 {
			s.recordUploadTraffic(r.Context(), u.ID, sent, now)
		}
	}
	defer meterConsumed()
	size, err := bs.Put(r.Context(), blobKey, capped)
	// Nothing reads the client's body past this point. Interrupting a read
	// still running — which only a node answering before the body ended
	// leaves behind — ends the request's context too: a refusal then only
	// drops the blob and meters, both detached, and a node claiming success
	// early fails the gates below closed.
	releaseBody()
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
	var reservedUploadID string
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
		reservedUploadID = authx.NewID()
		ok, err := s.store.ReserveUpload(r.Context(),
			UploadEvent{ID: reservedUploadID, UserID: u.ID, Bytes: billed, UploadedAt: now},
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
	// refundReserved undoes the daily-quota reservation above when a LATER gate
	// (the authoritative storage-cap check) rejects the upload — otherwise the
	// user is charged daily quota for a file that never landed.
	refundReserved := func() {
		s.refundUploadReservation(r.Context(), reservedUploadID)
	}
	id := authx.NewID()
	// resolveRetention above turns request params + admin default policy into
	// (ttl, maxDL); maxDL==1 is the burn-equivalent slot count, so the
	// generalized ClaimDownloadSlot enforcement (files.go handleFileBlob) covers
	// burn without a separate code path. BurnAfterRead itself is kept for
	// back-compat/display only.
	sf := StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
		Size: size, BurnAfterRead: maxDL == 1, CreatedAt: now, ExpiresAt: now + ttl, NodeID: nodeID,
		MaxDownloads: maxDL, Purpose: purpose,
	}
	// Atomic, fail-closed storage-cap enforcement + insert. This is what actually
	// stops N concurrent uploads from collectively busting the plan/global cap
	// (the over* pre-checks race and fail open).
	switch persisted, err := s.persistStoredFile(r.Context(), sf, billable); {
	case err != nil:
		s.dropBlob(bs, blobKey, nodeID)
		refundReserved()
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	case persisted.Reason == "global":
		s.dropBlob(bs, blobKey, nodeID)
		refundReserved()
		http.Error(w, "server storage is full", http.StatusInsufficientStorage)
		return
	case persisted.Reason == "storage":
		s.dropBlob(bs, blobKey, nodeID)
		refundReserved()
		http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
		return
	}
	// Lifetime stats are best-effort: a stats write failure must not fail the
	// upload the user already completed.
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
	// Own-node uploads (billable=false) are not metered against the plan — the
	// pre-checks already skip them, and the relay side likewise only counts
	// billable traffic. Metering them here (as it used to) let a user's own-node
	// traffic eat their plan's monthly cap, contradicting that contract.
	meterConsumed()
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": id, "expiresAt": sf.ExpiresAt})
}

// uploadMeterBudget bounds recordUploadTraffic's detached context.
const uploadMeterBudget = 5 * time.Second

// recordUploadTraffic bills n bytes of single-shot upload traffic to userID.
// It runs on a detached context — values kept, cancellation dropped, bounded
// by uploadMeterBudget — because the client's own hangup is one of the ways
// an upload that already moved its bytes ends. It records once and never
// retries; a failure is logged with who and how much, and those bytes stay
// unbilled rather than being guessed at later.
func (s *Service) recordUploadTraffic(ctx context.Context, userID string, n, at int64) {
	mctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadMeterBudget)
	defer cancel()
	if err := s.store.RecordMeter(mctx, userID, MeterUpload, n, at); err != nil {
		log.Printf("upload: recording %d bytes of upload traffic for user %s failed; they stay unbilled: %v", n, userID, err)
	}
}

// uploadRefundBudget bounds refundUploadReservation's detached context.
const uploadRefundBudget = 5 * time.Second

// refundUploadReservation deletes the daily-quota event eventID after a gate
// later than ReserveUpload refused the upload; "" (nothing reserved) is a
// no-op. Both upload handlers used to refund on the request's context, so a
// client that hung up after the reservation committed failed the persist AND
// the refund: the event stayed, the user was charged daily quota for a file
// that never landed, and the error was discarded. The refund therefore runs
// on a detached context — values kept, cancellation dropped, bounded by
// uploadRefundBudget — and a failure is logged, never reported as a refund.
// A refund that fails leaves the event to expire with the 24h window.
func (s *Service) refundUploadReservation(ctx context.Context, eventID string) {
	if eventID == "" {
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadRefundBudget)
	defer cancel()
	if err := s.store.RefundUpload(rctx, eventID); err != nil {
		log.Printf("upload: refunding daily-quota reservation %s failed; it stays charged until it leaves the 24h window: %v", eventID, err)
	}
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
	// 同 handleBlob：加密的 manifest（文件名、大小）不该在任何中间缓存里留副本，
	// 尤其是 burn-after-read 的那些——元数据滞留同样泄漏"这里曾经有过什么"。
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"encManifest":   base64.StdEncoding.EncodeToString(sf.EncManifest),
		"size":          sf.Size,
		"burnAfterRead": sf.BurnAfterRead,
		"expiresAt":     sf.ExpiresAt,
	})
}

// redirectToNode 302s the client to fetch a blob straight from the node holding
// it, with a short-lived token signed by the node's secret (the node verifies it
// with no round-trip to central). Central leaves the data path.
func (s *Service) redirectToNode(w http.ResponseWriter, r *http.Request, node Node, blobKey string) {
	exp := s.now().Add(2 * time.Minute).Unix()
	tok := dltoken.Sign(node.StorageSecret, blobKey, exp, authx.RandToken())
	loc := strings.TrimRight(node.DownloadURL, "/") + "/dl/" + blobKey + "?t=" + url.QueryEscape(tok)
	http.Redirect(w, r, loc, http.StatusFound)
}

// byoUpdateExempt reports whether sf's proxied download should be exempt from
// METERING (not the traffic gate — see the call site) because it is being
// served through central only because WE are mid-restart of the owner's own
// BYO node to update it. The exemption is deliberately narrow: it only ever
// applies to a download that would otherwise have taken the free BYO
// own-node direct path (see directCapable above) — exempt only what the
// update actually cost them. All of the following must hold:
//  1. this file is even eligible for direct-download in the first place
//     (s.directDownload && sf.MaxDownloads == 0 — the exact same predicate
//     the direct-download branch above gates on): a burn/limited file is
//     ALWAYS proxied by design regardless of node health, and a deployment
//     with directDownload globally off ALWAYS proxies every file — in both
//     cases the update caused nothing, so there is nothing to exempt.
//  2. the file lives on the file owner's OWN node — same ownership shape as
//     the free-direct path above (directNode.OwnerType == "user" &&
//     directNode.OwnerUserID == sf.UserID); a fleet node's egress is an
//     operator cost either way and is never exempt.
//  3. that node has a genuine self-update in flight and still within
//     byoUpdateExemptWindow of being commanded — bounded so a node that never
//     came back (stuck/broken, not updating) resumes being metered rather
//     than earning permanent free egress.
func (s *Service) byoUpdateExempt(ctx context.Context, sf StoredFile) bool {
	if !(s.directDownload && sf.MaxDownloads == 0 && directDownloadEligible(sf.Purpose)) {
		return false
	}
	if sf.NodeID == "" {
		return false
	}
	// Fetched after io.Copy at the call site: an update that finishes
	// mid-transfer loses the exemption for that request even though the
	// update did cause the proxy fallback. Fails toward over-metering
	// (the safe direction), so this skew is left as a known, deliberate one.
	n, ok, err := s.store.GetNode(ctx, sf.NodeID)
	if err != nil || !ok {
		return false
	}
	if !(n.OwnerType == "user" && n.OwnerUserID == sf.UserID) {
		return false
	}
	if n.UpdateStartedAt == 0 {
		return false
	}
	return s.now().Unix()-n.UpdateStartedAt <= int64(byoUpdateExemptWindow/time.Second)
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
	// Per-file / per-IP download rate limit (defence-in-depth). EVERY blob
	// download is proxied through central (node -> central -> client), so central
	// bears egress on each request. This blunts a single source hammering a public
	// link to amplify that egress faster than the (eventually-consistent) monthly
	// traffic gate below can react. nil = unlimited (tests / self-host).
	if s.downloadLimiter != nil && !s.downloadLimiter.Allow(s.clientIP(r)) {
		http.Error(w, "too many download requests, slow down", http.StatusTooManyRequests)
		return
	}
	// Relayium's resumable clients use exactly one open-ended range. Silently
	// treating an explicit end, suffix, multi-range, or out-of-bounds request as
	// a full 200 response is a bandwidth amplifier and can consume a limited
	// download the caller never asked for. Validate after the request limiter, but
	// before traffic metering, direct-node authorization, storage I/O, or a
	// limited-file slot claim.
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" &&
		!validResumeRange(rangeHeader, sf.Size) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", sf.Size))
		http.Error(w, "unsupported range", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	// Resolve whether this download can be served DIRECT from the node holding it
	// (central leaves the data path). Only for UNLIMITED files (burn/limited stay
	// proxied so central still deletes the blob after serving); the node must
	// advertise a public https DownloadURL and hold the shared secret. The only
	// direct route left is the BYO own-node one below: nothing central bills for
	// leaves the data path, so this stays a free-path predicate, never a
	// metered one. byoUpdateExempt reads the same predicate.
	var directNode Node
	directCapable := false
	if s.directDownload && sf.MaxDownloads == 0 && directDownloadEligible(sf.Purpose) {
		// A node that has stopped heartbeating may be restarting (an update) or
		// gone; redirecting there just hands the downloader a dead origin. Fall
		// back to central proxying, which is always correct if slower.
		// A node that has been uninstalled (RemovedAt != 0) is likewise never a
		// redirect target: its last heartbeat can still be inside the window for a
		// minute after the uninstaller deregistered it, and 302ing there sends the
		// downloader to a host that is in the middle of being torn down.
		online := s.now().Add(-nodeOnlineWindow).Unix()
		if n, ok, nerr := s.store.GetNode(r.Context(), sf.NodeID); nerr == nil && ok &&
			n.RemovedAt == 0 && n.DownloadURL != "" && n.StorageSecret != "" && n.LastSeenAt >= online {
			directNode, directCapable = n, true
		}
	}

	// BYO own-node direct (P2): the file lives on the OWNER's own node and is
	// served straight from it — central pays no egress and the node's disk is the
	// user's own, so this download is FREE: no traffic gate, no metering. (Contrast
	// a PROXIED own-node download below, which central does pay for and therefore
	// meters.) The BYO user opted in by advertising a DownloadURL, exposing their
	// node's address to downloaders.
	// A browser page is constrained by the app's deliberately narrow CSP and
	// cannot fetch an arbitrary BYO hostname. Native/CLI clients explicitly opt
	// into that cross-origin redirect; the Web client omits the header and stays
	// on the functional same-origin proxy path. Fleet hosts are under
	// *.relayium.com and remain CSP-compatible without the opt-in.
	byoDirectRequested := r.Header.Get("X-Relayium-Direct-Download") == "1"
	if directCapable && directNode.OwnerType == "user" && directNode.OwnerUserID == sf.UserID && byoDirectRequested {
		s.redirectToNode(w, r, directNode, sf.BlobKey)
		return
	}

	// Per-plan traffic gate, charged to the file's OWNER (downloader identity is
	// never read — zero-knowledge). Over quota → the owner's shares pause until
	// the month rolls over or they upgrade. Fail-open on a read error. Applies to
	// every download central pays egress for, which since the fleet-direct
	// withdrawal below is every download except the free BYO own-node case above.
	if over, err := s.overTraffic(r.Context(), sf.UserID, sf.Size); err == nil && over {
		http.Error(w, "this file's account has reached its monthly traffic limit", http.StatusTooManyRequests)
		return
	}
	// A fleet-hosted blob is ALWAYS proxied from here down, even when
	// s.directDownload is on and the node is online and advertising a
	// DownloadURL. Redirecting takes central out of the data path and leaves it
	// unable to observe the egress it pays for, so the withdrawn design charged
	// the whole file size up front and relied on a node's receipt to give back
	// whatever was never served. The pre-charge billed owners for bytes no
	// request delivered, and the give-back was a credit bound to no issued
	// grant and to no reporting node (see handleDownloadReceipt). What replaces
	// both is the invariant below: only bytes central actually wrote are
	// metered. The redirect may return once an issued, node-attributed,
	// durably settled grant can carry actual-byte accounting across it.
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
	// Defence in depth: the payload is opaque AEAD ciphertext (never sniffable as
	// HTML), but a top-level navigation to this endpoint should still never be
	// rendered or MIME-sniffed by the browser.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "attachment")
	// 密文本身是零知识的（没有 URL fragment 里的密钥就解不开），但缓存仍然会
	// 破坏 burn-after-read 的语义：中间缓存留一份，"读后即焚"的文件就还能被再取
	// 一次。存储层的对象本来就是一次性的，一律不缓存。
	w.Header().Set("Cache-Control", "private, no-store")
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
		// Meter the central egress against the owner for every file — own-node
		// included: the bytes are proxied through central regardless of where the
		// blob is stored (see the gate above) — UNLESS this proxy trip only
		// happened because we are mid-restart of the owner's own BYO node to
		// update it (byoUpdateExempt): that bill would exist solely because WE
		// chose to update their machine, so we eat it instead of the owner. This
		// exempts METERING only, never the overTraffic gate above — a genuinely
		// over-quota owner is still refused service during their own update
		// window, the same as any other time.
		if !s.byoUpdateExempt(ctx, sf) {
			_ = s.store.RecordMeter(ctx, sf.UserID, MeterDownload, n, s.now().Unix())
		}
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
			_ = s.store.DeleteStoredFile(ctx, sf.ID, s.now().Unix())
		}
	} else {
		_ = s.store.IncDownloadCount(ctx, sf.ID)
	}
}

// validResumeRange accepts exactly the one open-ended range shape Relayium's
// resumable clients speak. bytes=0- is valid and intentionally equivalent to a
// full response; a nonzero start must remain inside the object.
func validResumeRange(h string, size int64) bool {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || !strings.HasSuffix(spec, "-") || strings.Contains(spec, ",") {
		return false
	}
	n, err := strconv.ParseInt(strings.TrimSuffix(spec, "-"), 10, 64)
	return err == nil && n >= 0 && n < size
}

// parseRangeStart extracts N from a previously validated "bytes=N-" Range
// header. Callers that expose a public HTTP boundary validate with
// validResumeRange first; internal legacy callers retain the defensive zero
// fallback. The returned start is guaranteed to be in (0, size).
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
		// This list is the account's SHARES — the things with a link, a
		// download count and a delete button. A task-purpose object has none of
		// those: it is delivery ciphertext owned by one queued task, and
		// showing it here would offer the user controls that do not apply to it
		// and disclose that a device transfer is in flight. Its truthful
		// surface is the task, not the file list.
		if f.Purpose != StoredPurposeShare {
			continue
		}
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"files": out})
}

func (s *Service) handleDeleteFile(w http.ResponseWriter, r *http.Request, u User) {
	sf, err := s.store.GetStoredFile(r.Context(), r.PathValue("id"))
	if err != nil || sf.UserID != u.ID {
		// Non-owner and missing are indistinguishable: no existence leak.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// This is the account's SHARE delete route. Device Inbox objects are never
	// deleted here — not even when a preceding read says one is unbound — because
	// a concurrent task create could bind it between that read and blob removal.
	// Their task lifecycle and bounded orphan collector own deletion instead.
	// Unknown purposes fail closed rather than inheriting share semantics.
	if sf.Purpose != StoredPurposeShare {
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
	if err := s.store.DeleteStoredFile(r.Context(), sf.ID, s.now().Unix()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// liveFile fetches a stored file that exists, has not expired, and is publicly
// readable — a share, or a pair-room object whose room is still live; ok=false
// maps to a 404 for missing, expired, wrong-purpose, or store errors (fail
// closed).
//
// This is the single resolver behind both unauthenticated endpoints
// (`/api/files/{id}/meta` and `/blob`), which is why the purpose gate lives
// here: a task-purpose object has no capability-link semantics at all, so there
// is exactly one place to say so and no second public path that could be
// updated later and forget.
//
// The refusal is unconditional — it is not relaxed for the owner's own session.
// These endpoints ARE the capability link: the whole contract is that holding
// the id (plus the fragment key the server never sees) is what grants the read.
// Making them answer differently for an authenticated caller would mean the
// public surface had two behaviours, and the sender does not need this route:
// its ciphertext reaches the target device through the task blob endpoint.
func (s *Service) liveFile(r *http.Request, id string) (StoredFile, bool) {
	sf, err := s.store.GetStoredFile(r.Context(), id)
	if err != nil {
		return StoredFile{}, false
	}
	// A pair-room object is the second kind of public capability object: the
	// receiver of a code-first transfer holds its id (and the key the server never
	// saw) and fetches it exactly the way a share is fetched, with no account —
	// which is the whole reason it reuses these endpoints rather than getting an
	// authenticated one of its own.
	//
	// It is checked BEFORE the generic expiry test on purpose. The room gate is
	// what makes a passed deadline true on disk rather than merely 404: it deletes
	// the ciphertext inline. Falling out of the expiry test first would answer
	// correctly and leave the bytes sitting there until a sweep.
	if sf.Purpose == StoredPurposePairRoom {
		if !s.pairRoomObjectReadable(r.Context(), sf) {
			return StoredFile{}, false
		}
	} else if sf.Purpose != StoredPurposeShare {
		return StoredFile{}, false
	}
	if s.now().Unix() >= sf.ExpiresAt {
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
