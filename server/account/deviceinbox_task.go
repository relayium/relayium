package account

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storage"
)

// Device Inbox task queue HTTP surface (Phase 1B).
//
// AUTHORIZATION MODEL. The same two halves as deviceinbox.go, applied to the
// queue, and the split is the security decision on this file:
//
//   - ACCOUNT-SCOPED (RequireAuth): create, list, read, delete. Creating a task
//     is an assertion about the SENDER's own account, and a browser session is
//     the primary sender, so it must work from a cookie. MVP scope is
//     same-account only (PRD §8): the target device is resolved under the
//     caller's user id, so there is no request shape that names another
//     account's device. A public capability link authenticates nothing and
//     therefore reaches none of this — that separation is the point of PRD §8
//     and is asserted by test.
//   - DEVICE-SELF (deviceSelf): pending, claim, report, accept. These are
//     assertions about what a MACHINE is doing with a file — that it is
//     downloading, that it verified, that it committed to disk. A cookie is
//     account-wide; letting a signed-in tab report `saved` would let the UI
//     claim a file landed on a server that never received it.
//
// On top of device-self, every report also carries the CLAIM TOKEN issued when
// the task was leased. Device-self says "this machine"; the claim token says
// "this machine's current worker, whose lease has not been reclaimed". Both are
// needed: a device with several workers, or one that was paused and resumed,
// must not be able to overwrite the progress of whoever holds the task now.
//
// JSON casing follows deviceinbox.go: lowerCamel request bodies, Go-default
// capitalization in the Device Inbox response subtree, so a task object has one
// spelling wherever it appears.

// registerDeviceInboxTaskRoutes mounts the queue.
//
// Path shapes are chosen so no literal segment ever competes with a task id:
// the device-side verbs live at .../inbox/pending and .../inbox/claim rather
// than under .../inbox/tasks/, so /inbox/tasks/{taskId} can never be shadowed
// by a fixed word.
func (s *Service) registerDeviceInboxTaskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/devices/{id}/inbox/tasks", s.RequireAuth(s.handleCreateInboxTask))
	mux.HandleFunc("GET /api/devices/{id}/inbox/tasks", s.RequireAuth(s.handleListInboxTasks))
	mux.HandleFunc("GET /api/devices/{id}/inbox/tasks/{taskId}", s.RequireAuth(s.handleGetInboxTask))
	mux.HandleFunc("DELETE /api/devices/{id}/inbox/tasks/{taskId}", s.RequireAuth(s.handleDeleteInboxTask))
	mux.HandleFunc("GET /api/devices/{id}/inbox/pending", s.RequireAuth(s.handleInboxPending))
	mux.HandleFunc("POST /api/devices/{id}/inbox/claim", s.RequireAuth(s.handleClaimInboxTasks))
	mux.HandleFunc("GET /api/devices/{id}/inbox/tasks/{taskId}/blob", s.RequireAuth(s.handleInboxTaskBlob))
	mux.HandleFunc("POST /api/devices/{id}/inbox/tasks/{taskId}/report", s.RequireAuth(s.handleReportInboxTask))
	mux.HandleFunc("POST /api/devices/{id}/inbox/tasks/{taskId}/accept", s.RequireAuth(s.handleAcceptInboxTask))
}

// handleInboxTaskBlob streams ciphertext only to the target device's current
// worker. The account session, public Stored Object id, and device bearer alone
// are each insufficient: the active claim token is required as well.
func (s *Service) handleInboxTaskBlob(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	claimToken := r.Header.Get("X-Relayium-Inbox-Claim")
	if claimToken == "" {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stale_claim"})
		return
	}
	task, err := s.store.AuthorizeInboxTaskBlob(
		r.Context(), r.PathValue("taskId"), deviceID, u.ID, claimToken, s.now().Unix())
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	sf, err := s.store.GetStoredFile(r.Context(), task.StoredFileID)
	// storedObjectServesTask repeats the store's binding condition on the row
	// actually about to be streamed. AuthorizeInboxTaskBlob already refused a
	// mismatch, so this is defence in depth at the one place bytes leave.
	if err != nil || sf.UserID != u.ID || sf.ExpiresAt <= s.now().Unix() || sf.MaxDownloads != 0 ||
		!storedObjectServesTask(sf, task.ID) {
		s.writeInboxTaskError(w, ErrStoredObjectUnavailable)
		return
	}
	if s.downloadLimiter != nil && !s.downloadLimiter.Allow(s.clientIP(r)) {
		http.Error(w, "too many download requests, slow down", http.StatusTooManyRequests)
		return
	}
	if over, err := s.overTraffic(r.Context(), sf.UserID, sf.Size); err == nil && over {
		http.Error(w, "this file's account has reached its monthly traffic limit", http.StatusTooManyRequests)
		return
	}
	bs, err := s.blobFor(r.Context(), sf.NodeID)
	if err != nil {
		http.Error(w, "storage node unavailable", http.StatusServiceUnavailable)
		return
	}
	start := parseRangeStart(r.Header.Get("Range"), sf.Size)
	rc, err := bs.GetRange(r.Context(), sf.BlobKey, start)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			// Heal the crash window where physical deletion completed but the
			// metadata transaction did not: removing the dead row also makes every
			// unfinished task report the truthful terminal outcome.
			_ = s.store.DeleteStoredFile(r.Context(), sf.ID, s.now().Unix())
			s.writeInboxTaskError(w, ErrStoredObjectUnavailable)
			return
		}
		http.Error(w, "storage node offline, try again later", http.StatusServiceUnavailable)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	if start > 0 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, sf.Size-1, sf.Size))
		w.Header().Set("Content-Length", strconv.FormatInt(sf.Size-start, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(sf.Size, 10))
	}
	n, _ := io.Copy(w, rc)
	if n > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.store.AddDownloadStat(ctx, sf.UserID, n)
		_ = s.store.RecordMeter(ctx, sf.UserID, MeterDownload, n, s.now().Unix())
		cancel()
	}
}

// inboxTaskView is what the ACCOUNT sees: enough to tell a sender truthfully
// what happened to their transfer, and nothing a sender does not already have.
//
// It deliberately omits WrappedKey and the encrypted manifest. Both are opaque
// to central either way, but they are DELIVERY material: handing them out on an
// account-scoped read would mean a stolen session leaks every queued task's
// sealed key to a caller that is not the target device. The device gets them
// from the claim response, once, under its lease.
type inboxTaskView struct {
	ID             string `json:"ID"`
	TargetDeviceID string `json:"TargetDeviceID"`
	// SourceDeviceID is the server-derived, authenticated sending installation.
	// It is routing/conversation metadata, never request-body authority.
	SourceDeviceID string `json:"SourceDeviceID"`
	IdempotencyKey string `json:"IdempotencyKey"`
	StoredFileID   string `json:"StoredFileID"`
	// State is one of the PRD §10 SERVER states. `encrypting` and `uploading`
	// are sender-local and never appear here.
	State string `json:"State"`
	// ErrorCode is an opaque token from a closed set, never free text — there is
	// no field here through which a file name could travel.
	ErrorCode           string `json:"ErrorCode"`
	CiphertextBytes     int64  `json:"CiphertextBytes"`
	WrapAlgorithm       string `json:"WrapAlgorithm"`
	TargetKeyID         string `json:"TargetKeyID"`
	TargetKeyGeneration int64  `json:"TargetKeyGeneration"`
	Attempts            int64  `json:"Attempts"`
	NextAttemptAt       int64  `json:"NextAttemptAt"`
	LeaseExpiresAt      int64  `json:"LeaseExpiresAt"`
	CreatedAt           int64  `json:"CreatedAt"`
	UpdatedAt           int64  `json:"UpdatedAt"`
	ExpiresAt           int64  `json:"ExpiresAt"`
	NotifiedAt          int64  `json:"NotifiedAt"`
	// SavedAt is non-zero ONLY after the target device asserted a completed
	// atomic commit. It is not "uploaded at" and cannot be reached from one.
	SavedAt    int64 `json:"SavedAt"`
	TerminalAt int64 `json:"TerminalAt"`
	// Terminal lets a UI stop polling without knowing the state table.
	Terminal bool `json:"Terminal"`
}

func newInboxTaskView(t InboxTask) inboxTaskView {
	return inboxTaskView{
		ID: t.ID, TargetDeviceID: t.TargetDeviceID, SourceDeviceID: t.SourceDeviceID,
		IdempotencyKey: t.IdempotencyKey, StoredFileID: t.StoredFileID,
		State: t.State, ErrorCode: t.ErrorCode, CiphertextBytes: t.CiphertextBytes,
		WrapAlgorithm: t.WrapAlgorithm, TargetKeyID: t.TargetKeyID,
		TargetKeyGeneration: t.TargetKeyGeneration,
		Attempts:            t.Attempts, NextAttemptAt: t.NextAttemptAt,
		LeaseExpiresAt: t.LeaseExpiresAt,
		CreatedAt:      t.CreatedAt, UpdatedAt: t.UpdatedAt, ExpiresAt: t.ExpiresAt,
		NotifiedAt: t.NotifiedAt, SavedAt: t.SavedAt, TerminalAt: t.TerminalAt,
		Terminal: inbox.IsTerminalTaskState(t.State),
	}
}

// inboxDeliveryView is the claim response: the account view plus the material
// only the target device may have — the sealed content key, the encrypted
// manifest, and the claim token that authorizes its progress reports.
//
// Returned by exactly one endpoint (claim), to exactly one caller (the device
// itself), once per lease. The raw claim token is never stored and never
// re-issued: losing it means re-claiming after the lease expires.
type inboxDeliveryView struct {
	inboxTaskView
	// EncManifest is standard base64, matching GET /api/files/{id}/meta so a
	// client has one decoding rule for the manifest wherever it gets it.
	EncManifest string `json:"EncManifest"`
	// WrappedKey is the content key sealed to TargetKeyID. Central cannot open
	// it and never could: it holds no device private key.
	WrappedKey string `json:"WrappedKey"`
	ClaimToken string `json:"ClaimToken"`
}

// handleCreateInboxTask (POST /api/devices/{id}/inbox/tasks) queues one
// encrypted delivery to one of the caller's own devices.
//
// Same-account only (PRD §8, MVP): the target is resolved under the caller's
// user id, so there is no way to name someone else's device and no way for an
// unauthenticated capability-link holder to reach this at all.
//
// What the request may carry is deliberately small: which of the caller's own
// Stored Objects to deliver, the content key sealed to the target's CURRENT
// public key, a sender-chosen idempotency key, and — as of v2 — the integer
// protocol version the sealed manifest was written to. Everything else — the
// encrypted manifest, the ciphertext size, the expiry, the initial state — is
// derived by central from state it can verify, so a sender cannot describe its
// own object dishonestly or start a task in a state that has to be earned.
//
// What v2 deliberately does NOT add is any description of what is being sent.
// There is no `kind`, no `text`, no `name`, no `path` and no key on this
// request, and there must never be one: the whole point of putting content kind
// inside the authenticated encrypted manifest is that central cannot tell a
// message from a file, so a message cannot be read, indexed or logged here. The
// strict decoder below is what enforces that — a create carrying one of those
// fields is a 400, not a field central quietly ignores today and might honour
// after a later, less careful edit to this struct.
func (s *Service) handleCreateInboxTask(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	sourceDeviceID := s.authenticatedSourceDeviceID(r, u.ID)
	if sourceDeviceID == "" {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "sender_device_required"})
		return
	}
	var in struct {
		IdempotencyKey string `json:"idempotencyKey"`
		StoredFileID   string `json:"storedFileId"`
		// ProtocolVersion is REQUIRED from v2 on. Its zero value is not a
		// version, so an omitted field is refused rather than defaulted.
		ProtocolVersion     int    `json:"protocolVersion"`
		WrapAlgorithm       string `json:"wrapAlgorithm"`
		WrappedKey          string `json:"wrappedKey"`
		TargetKeyID         string `json:"targetKeyId"`
		TargetKeyGeneration int64  `json:"targetKeyGeneration"`
	}
	// Strict decoding is load-bearing here, not hygiene: it is what makes a
	// request carrying `contentKey`, `privateKey`, `fileName`, `kind` or `text`
	// a 400 rather than a silently ignored field that a later, less careful
	// version of this struct might start honouring.
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Checked before every other FIELD, and answered like the registration path
	// answers it: 409 with the supported set, so a client that speaks a version
	// central does not can say "upgrade" instead of "the send failed".
	//
	// First among the field checks because it is the one that makes the others
	// pointless: telling a v1 client its idempotency key is malformed would send
	// it to fix something that was never the problem. (A body that does not
	// decode at all is still a 400 above — there is no version to read yet.)
	if err := inbox.ValidateTaskProtocolVersion(in.ProtocolVersion); err != nil {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":              "unsupported_protocol_version",
			"supportedProtocols": inbox.SupportedProtocolVersions(),
		})
		return
	}
	if in.IdempotencyKey == "" || len(in.IdempotencyKey) > inbox.MaxIdempotencyKeyLen ||
		!printableASCIIToken(in.IdempotencyKey) {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_idempotency_key"})
		return
	}
	if in.WrapAlgorithm != inbox.KeyAlgX25519SealedBoxV1 {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":               "unsupported_key_algorithm",
			"supportedAlgorithms": []string{inbox.KeyAlgX25519SealedBoxV1},
		})
		return
	}
	// The sealed box is decoded to prove it is canonical base64url of exactly
	// the length this algorithm produces, then stored in its canonical text
	// form. Central cannot and must not try to interpret what is inside it — the
	// only thing it can check is the shape, and it checks that exactly, so a
	// client sealing something other than the content key fails here rather than
	// on the target device hours later.
	raw, err := base64.RawURLEncoding.Strict().DecodeString(in.WrappedKey)
	if err != nil || len(in.WrappedKey) > inbox.MaxWrappedKeyLen || len(raw) != inbox.SealedBoxBytes {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed_wrapped_key"})
		return
	}
	if in.StoredFileID == "" || in.TargetKeyID == "" || in.TargetKeyGeneration <= 0 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// The starting state is NOT in this request. It is derived inside the store
	// transaction from the target device's own automatic-receive policy: `auto`
	// is a permission the DEVICE's owner granted on that machine, never
	// something a sender may assert, and deriving it under the write lock means
	// a policy switched off a moment ago wins the race.
	now := s.now().Unix()
	saved, created, err := s.store.CreateInboxTask(r.Context(), InboxTask{
		ID: authx.NewID(), UserID: u.ID,
		TargetDeviceID: deviceID,
		SourceDeviceID: sourceDeviceID,
		IdempotencyKey: in.IdempotencyKey,
		StoredFileID:   in.StoredFileID,
		WrapAlgorithm:  in.WrapAlgorithm,
		WrappedKey:     in.WrappedKey,
		TargetKeyID:    in.TargetKeyID, TargetKeyGeneration: in.TargetKeyGeneration,
		CreatedAt: now,
	})
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	code := http.StatusOK // a converged retry is 200; a new task is 201
	if created {
		code = http.StatusCreated
	}
	httpx.WriteJSON(w, code, map[string]any{
		"task":    newInboxTaskView(saved),
		"created": created,
	})
}

// handleListInboxTasks returns a device's tasks, newest first.
//
// Gated on the DEVICE belonging to the caller rather than on it still being
// enrolled. Clearing an enrolment terminates its tasks as `revoked`, and the
// sender still needs to be able to read why their transfer stopped — a 404 there
// would replace a truthful reason with nothing.
func (s *Service) handleListInboxTasks(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.ownsDevice(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	tasks, err := s.store.ListInboxTasks(r.Context(), deviceID, u.ID, s.now().Unix(), limit)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]inboxTaskView, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, newInboxTaskView(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tasks": out})
}

// handleGetInboxTask reads one task. Scoped by user id AND the device in the
// path, so a task id from another account — or from another of the caller's own
// devices — is a 404 rather than a cross-device read.
func (s *Service) handleGetInboxTask(w http.ResponseWriter, r *http.Request, u User) {
	t, ok := s.ownedInboxTask(w, r, u)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"task": newInboxTaskView(t)})
}

// handleDeleteInboxTask cancels/removes one task.
//
// A task that merely REFERENCED a share deletes the task row only: the object
// is the account's own transfer, with its own link and delete control, and
// destroying it here would silently break a link the user may still be sharing.
//
// A task that OWNED its ciphertext (a Phase 1D-A task-purpose object) takes it
// with it — cancelling the send is the only way that ciphertext was ever going
// to be reachable, so keeping it would strand storage the user cannot see. The
// store removes both rows atomically and hands back the object so its blob can
// be dropped here; an unreachable node queues a retry rather than leaking.
func (s *Service) handleDeleteInboxTask(w http.ResponseWriter, r *http.Request, u User) {
	if _, ok := s.ownedInboxTask(w, r, u); !ok {
		return
	}
	deleted, released, err := s.store.DeleteInboxTask(r.Context(), r.PathValue("taskId"), u.ID)
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	if !deleted {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if released.ID != "" {
		s.dropUploadBlob(r.Context(), released.NodeID, released.BlobKey)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ownsDevice reports whether the device in the path belongs to the caller. A
// device that does not is reported as absent, never as forbidden, so the API
// never confirms that another account's device id exists.
func (s *Service) ownsDevice(r *http.Request, userID, deviceID string) bool {
	if deviceID == "" {
		return false
	}
	devices, err := s.store.ListDevices(r.Context(), userID)
	if err != nil {
		return false
	}
	for _, d := range devices {
		if d.ID == deviceID {
			return true
		}
	}
	return false
}

// ownedInboxTask resolves the task named in the path under this account AND the
// device in the path, 404ing otherwise.
func (s *Service) ownedInboxTask(w http.ResponseWriter, r *http.Request, u User) (InboxTask, bool) {
	t, found, err := s.store.GetInboxTask(r.Context(), r.PathValue("taskId"), u.ID, s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return InboxTask{}, false
	}
	if !found || t.TargetDeviceID != r.PathValue("id") {
		http.Error(w, "not found", http.StatusNotFound)
		return InboxTask{}, false
	}
	return t, true
}

// handleInboxPending (GET /api/devices/{id}/inbox/pending) is the device's cheap
// "is there work" poll. It marks queued tasks `notified` — in a polling
// transport, the device asking and central answering IS the notification — and
// returns summaries WITHOUT delivery material. Nothing is leased.
func (s *Service) handleInboxPending(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	tasks, err := s.store.NotifyInboxTasks(r.Context(), deviceID, u.ID, s.now().Unix(), limit)
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	out := make([]inboxTaskView, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, newInboxTaskView(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"tasks":                  out,
		"leaseSeconds":           int(inbox.TaskLeaseTTL.Seconds()),
		"maxClaimBatch":          inbox.MaxClaimBatch,
		"heartbeatIntervalSecs":  int(inbox.HeartbeatInterval.Seconds()),
		"maxPendingPerDeviceRow": inbox.MaxPendingTasksPerDevice,
	})
}

// handleClaimInboxTasks (POST /api/devices/{id}/inbox/claim) leases work.
//
// This is the only endpoint that hands out the sealed content key, and it does
// so under a lease with a one-time claim token. Of two workers racing for the
// same task exactly one wins; the loser simply gets fewer tasks back.
func (s *Service) handleClaimInboxTasks(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		Max int `json:"max"`
	}
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.now().Unix()
	tasks, tokens, err := s.store.ClaimInboxTasks(r.Context(), deviceID, u.ID, now, in.Max)
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	out := make([]inboxDeliveryView, 0, len(tasks))
	for i, t := range tasks {
		out = append(out, inboxDeliveryView{
			inboxTaskView: newInboxTaskView(t),
			EncManifest:   base64.StdEncoding.EncodeToString(t.EncManifest),
			WrappedKey:    t.WrappedKey,
			ClaimToken:    tokens[i],
		})
	}
	// The claim token is a bearer for advancing a task; like the manifest, it
	// must not sit in a shared cache on the way back to the device.
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"tasks":        out,
		"leaseSeconds": int(inbox.TaskLeaseTTL.Seconds()),
	})
}

// handleReportInboxTask (POST .../inbox/tasks/{taskId}/report) records what the
// target device is doing with a task it holds.
//
// `saved` is the one state that cannot be reached by naming it: the request must
// also carry `committed: true`, which is the device stating that authenticated
// decryption, complete verification and the atomic local commit all succeeded.
// Central has no way to observe any of that, so the assertion is explicit and
// its absence is a refusal rather than an assumption.
func (s *Service) handleReportInboxTask(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		ClaimToken string `json:"claimToken"`
		State      string `json:"state"`
		ErrorCode  string `json:"errorCode"`
		Committed  bool   `json:"committed"`
	}
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if in.ClaimToken == "" {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stale_claim"})
		return
	}
	// Sender-local phases are rejected by NAME, with their own code: they are
	// real PRD states, they are simply not central's to store, and saying so is
	// more useful to a client than "unknown state".
	if err := inbox.ValidateServerState(in.State); err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	t, err := s.store.ReportInboxTask(r.Context(), InboxTaskReport{
		TaskID: r.PathValue("taskId"), DeviceID: deviceID, UserID: u.ID,
		RawClaimToken: in.ClaimToken, To: in.State, ErrorCode: in.ErrorCode,
		SavedAssertion: in.Committed, Now: s.now().Unix(),
	})
	if errors.Is(err, ErrTaskTerminal) {
		// The task is over. The current state is echoed so the client stops
		// rather than retrying a transition that can never be legal again.
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "task_terminal", "task": newInboxTaskView(t),
		})
		return
	}
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"task": newInboxTaskView(t)})
}

// handleAcceptInboxTask (POST .../inbox/tasks/{taskId}/accept) resolves an
// `attention_required` task from the target machine.
//
// Device-self and deliberately without a claim token: under the `ask` policy the
// decision belongs to a PERSON at that device, and the task is held by nobody
// until they make it. Accepting queues it for a normal claim; declining ends it.
func (s *Service) handleAcceptInboxTask(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		Accept bool `json:"accept"`
	}
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	t, err := s.store.AcceptInboxTask(r.Context(), r.PathValue("taskId"), deviceID, u.ID, in.Accept, s.now().Unix())
	if errors.Is(err, ErrTaskTerminal) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "task_terminal", "task": newInboxTaskView(t),
		})
		return
	}
	if err != nil {
		s.writeInboxTaskError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"task": newInboxTaskView(t)})
}

// printableASCIIToken bounds the sender-chosen idempotency key to printable
// ASCII without whitespace. It is echoed back in the account view, so it is kept
// to a shape that cannot smuggle control characters into a log or a UI.
func printableASCIIToken(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] <= 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// writeInboxTaskError maps each distinct queue outcome to its own status and
// machine-readable code. They are not collapsed because each implies different
// client behaviour: re-read the key, wait for the backoff, stop entirely, or ask
// a human.
func (s *Service) writeInboxTaskError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, inbox.ErrAutoReceiveDisabled):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "auto_receive_disabled"})
	case errors.Is(err, inbox.ErrUnsupportedAutoAcceptCapability):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "unsupported_auto_accept_capability", "requiredCapabilities": []string{inbox.CapAutoAcceptV1},
		})
	case errors.Is(err, ErrDeviceCannotReceive):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_cannot_receive"})
	case errors.Is(err, ErrDeviceInboxRevoked):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_inbox_revoked"})
	case errors.Is(err, ErrStaleTargetKey):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stale_target_key"})
	case errors.Is(err, ErrIdempotencyKeyConflict):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "idempotency_key_conflict"})
	case errors.Is(err, ErrStoredObjectUnavailable):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stored_object_unavailable"})
	case errors.Is(err, ErrStoredObjectAlreadyBound):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stored_object_already_bound"})
	case errors.Is(err, ErrInboxQueueFull):
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "inbox_queue_full", "maxPendingTasks": inbox.MaxPendingTasksPerDevice,
		})
	case errors.Is(err, ErrStaleClaim):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stale_claim"})
	case errors.Is(err, ErrTaskTerminal):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "task_terminal"})
	case errors.Is(err, ErrInboxTaskInProgress):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "invalid_transition"})
	case errors.Is(err, inbox.ErrSenderLocalState):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "sender_local_state"})
	case errors.Is(err, inbox.ErrSavedNotAsserted):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "saved_not_asserted"})
	case errors.Is(err, inbox.ErrInvalidTransition):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "invalid_transition"})
	case errors.Is(err, inbox.ErrInvalidTaskState):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_task_state"})
	case errors.Is(err, inbox.ErrInvalidErrorCode):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_error_code"})
	case errors.Is(err, inbox.ErrInvalidAutoAccept):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_auto_accept"})
	default:
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}
