package inboxsend

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/termtext"
)

// Session is one logged-in sender: the account from --config-dir and a client
// bound to that credential's server and nowhere else.
//
// A Session keeps no copy of the bearer: the only one lives inside the
// client's closure (see Client). Format below additionally redacts a Session
// under every verb, pointer or value, because fmt prints an enclosing struct's
// unexported fields without consulting their own Format methods.
type Session struct {
	accountEmail string
	client       *Client
	store        journalStore
	// Notice receives human progress and caveats (stderr). Never data.
	Notice io.Writer
	now    func() time.Time
}

// Format redacts a Session under every verb.
func (s Session) Format(f fmt.State, _ rune) { io.WriteString(f, "inboxsend.Session{redacted}") }

// Open loads the credential in cfgDir. transport is nil outside tests.
func Open(cfgDir string, transport http.RoundTripper) (*Session, error) {
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return nil, failed(CodeLocalState, "cannot read the stored credential: "+termtext.Safe(err.Error()))
	}
	if !ok || creds.AccessToken == "" {
		return nil, failed(CodeSignedOut, "not logged in — run `relayium login` first")
	}
	c, err := NewClient(creds.Server, creds.AccessToken, transport)
	if err != nil {
		return nil, failed(CodeLocalState, err.Error()+" — run `relayium login` again")
	}
	return &Session{accountEmail: creds.AccountEmail, client: c, store: newJournalStore(cfgDir),
		Notice: io.Discard, now: time.Now}, nil
}

func (s *Session) notef(format string, a ...any) { fmt.Fprintf(s.Notice, format+"\n", a...) }

// Result is a send's outcome as reported to the user. It carries no key, no
// upload id, no stored object id and no idempotency key.
type Result struct {
	LocalSendID     string
	TaskID          string
	TargetDeviceID  string
	TargetName      string
	State           string
	ErrorCode       string
	Created         bool
	CiphertextBytes int64
	ExpiresAt       int64
	SavedAt         int64
}

// SendRequest is one `inbox send`.
type SendRequest struct {
	To    string
	Paths []string
	TTL   int64 // requested retention in seconds; 0 = the server's default
}

// readErr maps a failed READ (device list, keys) onto a report.
func readErr(err error) *Error {
	if e := ctxErr(err); e != nil {
		return e
	}
	switch st := statusOf(err); {
	case st == http.StatusUnauthorized || st == http.StatusForbidden:
		return newErr(ClassFailed, CodeSignedOut, "the server no longer accepts this login — run `relayium login` again", err)
	case codeOf(err) == CodeRedirectRefused:
		return newErr(ClassFailed, CodeRedirectRefused, "the server answered with a redirect; nothing was sent to the redirect target", err)
	case st >= 500:
		return newErr(ClassFailed, CodeServerError, fmt.Sprintf("the server could not answer (HTTP %d); try again later", st), err)
	case st != 0:
		return newErr(ClassFailed, CodeUnknown, fmt.Sprintf("the server refused the request (HTTP %d)", st), err)
	}
	return newErr(ClassFailed, CodeNetwork, "could not reach the server: "+termtext.Safe(err.Error()), err)
}

func ctxErr(err error) *Error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return newErr(ClassInterrupted, CodeCancelled, "interrupted", err)
	}
	return nil
}

// resolveSelf reads the device list and the row this bearer is.
func (s *Session) resolveSelf(ctx context.Context) ([]inboxclient.Device, inboxclient.Device, error) {
	devs, err := s.client.ListDevices(ctx)
	if err != nil {
		return nil, inboxclient.Device{}, readErr(err)
	}
	cur, ok := currentDevice(devs)
	if !ok || !isInertID(cur.ID) {
		return nil, inboxclient.Device{}, failed(CodeSignedOut,
			"this credential is not bound to a device — run `relayium login` again")
	}
	return devs, cur, nil
}

// Send plans, encrypts, uploads and queues one delivery.
func (s *Session) Send(ctx context.Context, req SendRequest) (Result, error) {
	// Local refusals first: nothing on the network is touched for a delivery
	// that could never be accepted.
	plan, err := BuildPlan(req.Paths)
	if err != nil {
		return Result{}, err
	}
	for _, f := range plan.EmptyFolders {
		s.notef("not sent (empty folder): %s", f)
	}

	devs, _, err := s.resolveSelf(ctx)
	if err != nil {
		return Result{}, err
	}
	picked, err := resolveTarget(devs, req.To)
	if err != nil {
		return Result{}, err
	}

	// A FRESH read immediately before the first write, so a device that turned
	// receiving off or rotated its key a moment ago costs nothing.
	devs, cur, err := s.resolveSelf(ctx)
	if err != nil {
		return Result{}, err
	}
	var target inboxclient.Device
	found := false
	for _, d := range devs {
		if d.ID == picked.ID {
			target, found = d, true
		}
	}
	if !found {
		return Result{}, failed(CodeNoSuchTarget, "the device is no longer in this account; nothing was sent")
	}
	av := Evaluate(target)
	name := termtext.Safe(target.Name)
	if !av.Sendable {
		e := failed(CodeTargetUnavailable, fmt.Sprintf("cannot send to %s: %s; nothing was sent", name, blockSentence(av.Block)))
		e.err = errors.New(av.Block)
		return Result{}, e
	}
	s.notef("Sending %d file(s) to %s (%s)", plan.Items(), name, termtext.Safe(target.ID))
	for _, c := range av.Caveats {
		s.notef("note: %s", CaveatSentence(c))
	}

	sl, err := newSealer()
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot generate an encryption key")
	}
	defer sl.discard()
	encManifest, err := sl.sealManifest(plan.manifest)
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot encrypt the manifest")
	}
	key := target.Inbox.Key
	wrapped, err := sl.wrapTo(key.Algorithm, key.PublicKey)
	if err != nil {
		return Result{}, failed(CodeUnsupportedKey, "the device's receiving key cannot be used; nothing was sent")
	}

	id, err := newRandomHex()
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot generate a local send id")
	}
	idem, err := newRandomHex()
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot generate an idempotency key")
	}
	mh := plan.ManifestSHA256()
	j := &Journal{
		V: journalVersion, ID: id, Phase: PhasePlanned,
		Server: s.client.Server(), AccountEmail: s.accountEmail,
		SourceDeviceID: cur.ID, TargetDeviceID: target.ID,
		TargetKeyID: key.ID, TargetKeyGeneration: key.Generation, WrappedKey: wrapped,
		IdempotencyKey: "cli-" + idem, TTL: req.TTL, CiphertextBytes: plan.CiphertextBytes,
		ManifestSHA256: hex.EncodeToString(mh[:]), CreatedAt: s.now().Unix(),
	}
	lk, err := s.store.lock(id)
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot create the local send record: "+termtext.Safe(err.Error()))
	}
	defer lk.release()
	// N6: the wrapped key is durable before any network write, let alone the
	// first create.
	if err := s.store.save(j); err != nil {
		return Result{}, failed(CodeLocalState, "cannot write the local send record: "+termtext.Safe(err.Error()))
	}
	res := Result{LocalSendID: id, TargetDeviceID: target.ID, TargetName: target.Name, CiphertextBytes: plan.CiphertextBytes}

	uploadID, chunk, err := s.client.InitUpload(ctx, req.TTL, plan.CiphertextBytes, encManifest)
	if err != nil {
		s.drop(j)
		if e := ctxErr(err); e != nil {
			return res, e
		}
		if isTransport(err) {
			return res, newErr(ClassFailed, CodeNetwork, "the upload could not be started: "+termtext.Safe(err.Error())+". "+
				"If the server did open it, that empty upload is discarded by cleanup.", err)
		}
		return res, uploadRefusal(err, "")
	}
	j.Phase, j.UploadID = PhaseUploading, uploadID
	// N8: no byte is appended to a session the record does not name. The
	// record as it stands (planned) is kept: it is still true.
	if err := s.checkpoint(j); err != nil {
		e := recordFailed(err, "so the send was stopped before any file data was uploaded. Nothing was queued; "+
			"the empty upload the server opened is discarded by cleanup.")
		e.LocalSendID = j.ID
		return res, e
	}

	gen := newFrameSource(plan.files, sl)
	err = streamUpload(ctx, s.client, uploadID, chunk, plan.CiphertextBytes, gen.next)
	gen.close()
	if err != nil {
		if e := ctxErr(err); e != nil {
			e.LocalSendID = id
			e.Msg = "interrupted during the upload. " + msgOrphanPartial
			return res, e
		}
		s.drop(j)
		return res, uploadFailure(err)
	}
	if sl.frames() == 0 && plan.CiphertextBytes != 0 {
		s.drop(j)
		return res, failed(CodeSourceChanged, "the files did not read back as planned")
	}

	j.Phase = PhaseFinalizing
	// N8: finalize is not sent unless the record says it may have been.
	if err := s.checkpoint(j); err != nil {
		e := recordFailed(err, fmt.Sprintf("so the upload was stopped before it was completed and nothing was queued. "+
			"Every byte was uploaded: once the configuration directory can be written again, "+
			"`relayium inbox retry %s` completes it without uploading again. Otherwise ", j.ID)+lowerFirst(msgOrphanPartial))
		e.LocalSendID = j.ID
		return res, e
	}
	storedID, expiresAt, err := s.finalize(ctx, j, false)
	if err != nil {
		return res, err
	}
	j.Phase, j.StoredFileID, j.ExpiresAt = PhaseFinalized, storedID, expiresAt
	// N8: the create is not sent unless the record can replay it.
	if err := s.checkpoint(j); err != nil {
		return res, s.finalizedNotRecorded(j, err)
	}
	res.ExpiresAt = expiresAt

	task, created, err := s.create(ctx, j, sl, false)
	if err != nil {
		return res, err
	}
	s.drop(j)
	res.TaskID, res.State, res.ErrorCode, res.Created, res.SavedAt = task.ID, task.State, task.ErrorCode, created, task.SavedAt
	return res, nil
}

// checkpoint persists a phase change (N8). Its failure is never a warning: the
// caller stops before the request the new phase describes, because a later
// retry would otherwise act on the older phase as if that request had never
// been sent.
func (s *Session) checkpoint(j *Journal) error { return s.store.save(j) }

// recordFailed reports a checkpoint that could not be written.
func recordFailed(err error, consequence string) *Error {
	return newErr(ClassFailed, CodeJournalWrite,
		"cannot update the local send record ("+termtext.Safe(err.Error())+"), "+consequence, err)
}

// finalizedNotRecorded is a completed upload whose stored object id could not
// be recorded: the create is NOT sent (N8), so the delivery is definitely not
// queued by this command. The earlier record (phase finalizing) is KEPT, never
// removed because newer state could not be written: it is the only local
// evidence of a committed upload, a later retry of it answers honestly (today
// that is "unknown", never a new upload), and a server that can confirm a
// finalized upload could let it finish.
func (s *Session) finalizedNotRecorded(j *Journal, err error) *Error {
	e := recordFailed(err, fmt.Sprintf("so the delivery was NOT queued: nothing was sent to the device. "+
		"The upload itself was completed and was counted like any completed upload. The local record was kept; "+
		"`relayium inbox retry %s` never uploads again, but because the record predates the completed upload "+
		"it may only be able to report the outcome as unknown. A new `relayium inbox send` is a new upload "+
		"and is counted again. The uploaded ciphertext is not attached to any delivery and stays on the server "+
		"until cleanup removes it; cleanup runs periodically and can be delayed.", j.ID))
	e.LocalSendID = j.ID
	return e
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]|0x20) + s[1:]
}

func (s *Session) drop(j *Journal) {
	if err := s.store.remove(j.ID); err != nil {
		s.notef("warning: cannot remove the local send record %s: %s", j.ID, termtext.Safe(err.Error()))
	}
}

// uploadRefusal maps a definitive init/append/finalize refusal. left says
// what the refused request left behind ("" when nothing was uploaded).
func uploadRefusal(err error, left string) *Error {
	tail := ""
	if left != "" {
		tail = " " + left
	}
	switch st := statusOf(err); {
	case codeOf(err) == CodeRedirectRefused:
		return newErr(ClassFailed, CodeRedirectRefused, "the server answered with a redirect; nothing was re-sent to the redirect target."+tail, err)
	case st == http.StatusUnauthorized || st == http.StatusForbidden:
		return newErr(ClassFailed, CodeSignedOut, "the server no longer accepts this login — run `relayium login` again."+tail, err)
	case st == http.StatusRequestEntityTooLarge || st == http.StatusInsufficientStorage:
		return newErr(ClassFailed, CodeUploadTooLarge, fmt.Sprintf("the server refused the upload as too large for this account's limits (HTTP %d).", st)+tail, err)
	case st == http.StatusTooManyRequests:
		return newErr(ClassFailed, CodeQuotaExceeded, "the server refused the upload: a usage limit was reached (HTTP 429)."+tail, err)
	case st >= 500:
		return newErr(ClassFailed, CodeServerError, fmt.Sprintf("the server failed (HTTP %d).", st)+tail, err)
	case st != 0:
		return newErr(ClassFailed, CodeUnknown, fmt.Sprintf("the server refused the upload (HTTP %d).", st)+tail, err)
	}
	return newErr(ClassFailed, CodeNetwork, "network error: "+termtext.Safe(err.Error())+"."+tail, err)
}

func uploadFailure(err error) *Error {
	switch {
	case errors.Is(err, errSourceChanged):
		return newErr(ClassFailed, CodeSourceChanged, "a file changed, grew, shrank or was replaced while it was being read, "+
			"so the upload was stopped before it was completed. "+msgOrphanPartial, err)
	case errors.Is(err, errUploadLost):
		return newErr(ClassFailed, CodeUploadLost, "the server no longer has this upload (it ended before it was completed). "+
			"Run `relayium inbox send` again; that is a new upload and is counted again.", err)
	case errors.Is(err, errUploadDesync):
		return newErr(ClassFailed, CodeProtocol, "the server reported an upload position this client cannot continue from, "+
			"so it stopped rather than re-encrypt anything. "+msgOrphanPartial, err)
	case errors.Is(err, errSealerSpent):
		return newErr(ClassFailed, CodeLocalState, "internal error: the encryption key is gone", err)
	}
	return uploadRefusal(err, msgOrphanPartial)
}

// finalizeAttempts bounds finalize replays after an ambiguous answer.
const finalizeAttempts = 3

// finalize completes the upload. It NEVER re-uploads (N5): an answer that
// cannot be established ends as ClassUnknown with the journal kept.
//
// resumed is true when a previous process may already have sent a finalize
// (retry in phase finalizing), which makes even the first 409 ambiguous. sent
// also becomes true here after any ambiguous attempt. From then on a
// definitive refusal describes only the request it answers, never the earlier
// one that may have committed, so it ends as unknown with the record kept.
func (s *Session) finalize(ctx context.Context, j *Journal, resumed bool) (string, int64, error) {
	sent := resumed
	for attempt := 0; attempt < finalizeAttempts; attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, uploadBackoff(attempt)); err != nil {
				return "", 0, s.interrupted(j, err)
			}
		}
		id, exp, err := s.client.Finalize(ctx, j.UploadID)
		if err == nil {
			return id, exp, nil
		}
		if ctx.Err() != nil {
			return "", 0, s.interrupted(j, err)
		}
		st := statusOf(err)
		switch {
		case isTransport(err) || st >= 500:
			sent = true
			continue
		case st == http.StatusConflict || (st == http.StatusNotFound && sent):
			// Today's server answers a repeated finalize 409 `already finalized`
			// with no id, and a purged session 404. Either way the object may
			// exist; this server cannot say. Unknown — never a second upload.
			return "", 0, s.unknown(j, err)
		case st == http.StatusNotFound:
			s.drop(j)
			return "", 0, uploadFailure(errUploadLost)
		case sent:
			// A refusal of THIS finalize (a revoked login, a quota gate) says
			// nothing about an earlier one that may have committed.
			return "", 0, s.refusedAfterAmbiguity(j, err)
		default:
			// The server refused the only finalize ever sent. At its finalize
			// gates (quota, storage) central drops the blob and refunds any
			// reservation itself; a refusal before the handler (auth) leaves
			// the session to cleanup. Either way nothing was completed.
			s.drop(j)
			return "", 0, uploadRefusal(err, msgFinalizeRefused)
		}
	}
	return "", 0, s.unknown(j, errors.New("finalize answers were all ambiguous"))
}

func (s *Session) unknown(j *Journal, cause error) *Error {
	msg := msgUnknownOutcome
	if j.Phase == PhaseFinalized {
		// The upload is known to be complete; what is unknown is the delivery.
		msg = msgUnknownDelivery
	}
	e := newErr(ClassUnknown, CodeUnknownOutcome, fmt.Sprintf(msg, j.ID), cause)
	e.LocalSendID = j.ID
	return e
}

// refusedAfterAmbiguity is a definitive refusal of a finalize or create that
// replays one which may already have taken effect. It is unknown, record kept:
// the refusal is reported, but never as the outcome of the earlier request.
func (s *Session) refusedAfterAmbiguity(j *Journal, cause error) *Error {
	e := s.unknown(j, cause)
	st := statusOf(cause)
	if st == 0 {
		return e
	}
	e.Msg += fmt.Sprintf(" A later attempt was refused (HTTP %d); that refusal answers only that attempt, "+
		"not whether the earlier one took effect.", st)
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		e.Msg += " If this login was signed out, `relayium inbox retry` cannot finish this send: " +
			"logging in again creates a new device."
	}
	return e
}

func (s *Session) interrupted(j *Journal, cause error) *Error {
	e := newErr(ClassInterrupted, CodeCancelled,
		fmt.Sprintf("interrupted before the outcome was known. Nothing will be uploaded again automatically; "+
			"run `relayium inbox retry %s` to finish it.", j.ID), cause)
	e.LocalSendID = j.ID
	return e
}

// createAttempts bounds byte-identical replays of an ambiguous create.
const createAttempts = 3

func createBytes(j *Journal) ([]byte, error) {
	return json.Marshal(createBody{
		IdempotencyKey: j.IdempotencyKey, StoredFileID: j.StoredFileID,
		ProtocolVersion: inbox.ProtocolV3, WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1,
		WrappedKey: j.WrappedKey, TargetKeyID: j.TargetKeyID, TargetKeyGeneration: j.TargetKeyGeneration,
	})
}

// create queues the task (N6). sl is the live sealer when this process
// generated the key, nil after a restart — in which case a stale device key
// cannot be recovered from.
//
// mayHaveLanded is true when an earlier process may already have sent this
// create (retry of a finalized record); it also becomes true here after any
// ambiguous attempt. From then on a definitive refusal describes only the
// request it answers, not the earlier one, so it cannot prove the delivery
// was not queued: the task is looked up and, failing that, the outcome is
// unknown with the record kept.
//
// stale_target_key is no exception. Central answers an existing idempotency
// key before it checks the key, so the refusal proves that no task holds this
// key NOW — not that none ever did: a task that landed may since have been
// cancelled, or saved and pruned after its retention. The first stale refusal
// still licenses one re-wrap while this process holds the content key (the
// re-wrapped create cannot bind an object an earlier task already took), but
// what finally ends the send is judged by mayHaveLanded like any refusal.
func (s *Session) create(ctx context.Context, j *Journal, sl *sealer, mayHaveLanded bool) (inboxclient.Task, bool, error) {
	body, err := createBytes(j)
	if err != nil {
		return inboxclient.Task{}, false, failed(CodeLocalState, "cannot build the delivery request")
	}
	staleRetried := false
	for attempt := 0; attempt < createAttempts; {
		task, created, err := s.client.CreateTask(ctx, j.TargetDeviceID, body)
		if err == nil {
			if task.TargetDeviceID != j.TargetDeviceID || task.StoredFileID != j.StoredFileID ||
				task.IdempotencyKey != j.IdempotencyKey {
				return inboxclient.Task{}, false, s.unknown(j, errors.New("the server returned a different delivery"))
			}
			return task, created, nil
		}
		if ctx.Err() != nil {
			return inboxclient.Task{}, false, s.interrupted(j, err)
		}
		code, st := codeOf(err), statusOf(err)
		switch {
		case isTransport(err) || st >= 500:
			// Ambiguous: the create may have landed. Replay the SAME bytes; a
			// landed create converges (200, created:false).
			mayHaveLanded = true
			attempt++
			if attempt < createAttempts {
				if serr := sleepCtx(ctx, uploadBackoff(attempt)); serr != nil {
					return inboxclient.Task{}, false, s.interrupted(j, serr)
				}
			}
			continue
		case code == CodeStaleTargetKey && sl != nil && !staleRetried:
			// An explicit refusal of THIS create: its transaction rolled back.
			// Re-wrapping the same content key is safe while this process still
			// holds it, and only once.
			staleRetried = true
			next, refusal, rerr := s.rewrap(ctx, j, sl)
			if rerr != nil {
				return inboxclient.Task{}, false, rerr
			}
			if refusal != nil {
				if mayHaveLanded {
					return s.afterAmbiguity(ctx, j, err, refusal.why)
				}
				s.drop(j)
				return inboxclient.Task{}, false, failed(refusal.code, refusal.why+"; the delivery was not queued. "+msgOrphanObject)
			}
			body = next
			continue
		case code == CodeIdempotencyKeyConflict:
			// A different request already owns this key. The only honest ways out
			// are finding our own delivery, or saying we cannot tell.
			if t, ok := s.lookup(ctx, j); ok {
				return t, false, nil
			}
			return inboxclient.Task{}, false, s.unknown(j, err)
		case mayHaveLanded:
			// A refusal of THIS request (a revoked login, a device that
			// stopped receiving, a key that changed) says nothing about an
			// earlier one that may have landed.
			return s.afterAmbiguity(ctx, j, err, "")
		case code == CodeStaleTargetKey && sl == nil:
			// The only create ever sent for this record was refused, and the
			// content key did not survive the restart.
			s.drop(j)
			return inboxclient.Task{}, false, newErr(ClassFailed, CodeStaleAfterRestart, msgStaleAfterRestart+" "+msgOrphanObject, err)
		case code == CodeStaleTargetKey:
			// Both the original and the re-wrapped create were refused, and
			// neither can have landed.
			s.drop(j)
			return inboxclient.Task{}, false, newErr(ClassFailed, CodeStaleTargetKey,
				"the device's receiving key keeps changing; the delivery was not queued. "+msgOrphanObject, err)
		default:
			s.drop(j)
			return inboxclient.Task{}, false, createRefusal(err)
		}
	}
	if t, ok := s.lookup(ctx, j); ok {
		return t, false, nil
	}
	return inboxclient.Task{}, false, s.unknown(j, errors.New("create answers were all ambiguous"))
}

// afterAmbiguity ends a create whose earlier attempt may have landed: the
// task is looked up by idempotency key and, failing that, the outcome is
// unknown with the record kept. note, when set, says what else stopped this
// attempt.
func (s *Session) afterAmbiguity(ctx context.Context, j *Journal, cause error, note string) (inboxclient.Task, bool, error) {
	if t, ok := s.lookup(ctx, j); ok {
		return t, false, nil
	}
	e := s.refusedAfterAmbiguity(j, cause)
	if note != "" {
		e.Msg += " The delivery could not be re-sealed to the device's current key: " + note + "."
	}
	return inboxclient.Task{}, false, e
}

// rewrapRefusal is why a re-wrap did not happen, without any claim about the
// delivery: create adds that, knowing whether an earlier attempt may have
// landed.
type rewrapRefusal struct{ code, why string }

// rewrap seals the SAME content key to the device's current key and persists
// the new wrapped key before it is sent.
//
// A refusal (no usable key, a key it cannot seal to, a record it cannot
// write) is returned for create to judge, because only create knows whether
// an earlier attempt may have landed; the record is left exactly as it was on
// disk. err is an interruption or an unknown outcome, record kept.
func (s *Session) rewrap(ctx context.Context, j *Journal, sl *sealer) (body []byte, refusal *rewrapRefusal, err error) {
	keys, err := s.client.ListKeys(ctx, j.TargetDeviceID)
	if err != nil {
		if e := ctxErr(err); e != nil {
			return nil, nil, s.interrupted(j, err)
		}
		return nil, nil, s.unknown(j, err)
	}
	var active *inboxclient.Key
	for i := range keys {
		if keys[i].Active() {
			active = &keys[i]
			break
		}
	}
	if active == nil || !isInertID(active.ID) || active.Generation <= 0 {
		return nil, &rewrapRefusal{CodeStaleTargetKey, "the device no longer has a usable receiving key"}, nil
	}
	wrapped, err := sl.wrapTo(active.Algorithm, active.PublicKey)
	if err != nil {
		return nil, &rewrapRefusal{CodeUnsupportedKey, "the device's new receiving key cannot be used"}, nil
	}
	next := *j
	next.WrappedKey, next.TargetKeyID, next.TargetKeyGeneration = wrapped, active.ID, active.Generation
	// Durable BEFORE it is sent: a crash after this point replays exactly this.
	if err := s.store.save(&next); err != nil {
		return nil, &rewrapRefusal{CodeLocalState, "the re-sealed key could not be recorded locally, so it was not sent"}, nil
	}
	*j = next
	s.notef("note: the device's receiving key changed; the delivery was sealed to its new key")
	body, err = createBytes(j)
	if err != nil {
		return nil, nil, s.unknown(j, err)
	}
	return body, nil, nil
}

// lookup finds this send's task by idempotency key. Absence is not proof (the
// list is bounded), so callers treat "not found" as unknown.
func (s *Session) lookup(ctx context.Context, j *Journal) (inboxclient.Task, bool) {
	tasks, err := s.client.ListTasks(ctx, j.TargetDeviceID, 500)
	if err != nil {
		return inboxclient.Task{}, false
	}
	for _, t := range tasks {
		if t.IdempotencyKey == j.IdempotencyKey && t.StoredFileID == j.StoredFileID &&
			t.TargetDeviceID == j.TargetDeviceID && isInertID(t.ID) {
			return t, true
		}
	}
	return inboxclient.Task{}, false
}

func createRefusal(err error) *Error {
	code := codeOf(err)
	why := map[string]string{
		CodeAutoReceiveDisabled:     "automatic receive is turned off on that device",
		CodeDeviceCannotReceive:     "that device cannot receive deliveries right now",
		CodeDeviceInboxRevoked:      "that device's inbox was revoked",
		CodeStoredObjectUnavailable: "the uploaded ciphertext is no longer available",
		CodeStoredObjectBound:       "the uploaded ciphertext already belongs to another delivery",
		CodeInboxQueueFull:          "that device has too many deliveries waiting",
		CodeSenderDeviceRequired:    "the server does not recognise this login as a device — run `relayium login` again",
	}[code]
	if code == "" || why == "" {
		switch st := statusOf(err); {
		case st == http.StatusUnauthorized || st == http.StatusForbidden:
			code, why = CodeSignedOut, "the server no longer accepts this login — run `relayium login` again"
		case st == http.StatusNotFound:
			code, why = CodeNoSuchTarget, "the device is no longer in this account"
		case codeOf(err) == CodeRedirectRefused:
			code, why = CodeRedirectRefused, "the server answered with a redirect; nothing was re-sent to the redirect target"
		default:
			if code == "" {
				code = CodeUnknown
			}
			why = fmt.Sprintf("the server refused the delivery (HTTP %d)", st)
		}
	}
	// Only an object this refusal left unbound and available is an orphan
	// waiting for cleanup; one that is gone or held by another task is not.
	left := msgOrphanObject
	if code == CodeStoredObjectUnavailable || code == CodeStoredObjectBound {
		left = msgCountedComplete
	}
	return newErr(ClassFailed, code, "the delivery was not queued: "+why+". "+left, err)
}

// Retry finishes an interrupted send from its journal WITHOUT encrypting and
// WITHOUT uploading (N3/N5). Whatever would need an upload is refused.
func (s *Session) Retry(ctx context.Context, id string) (Result, error) {
	if !ValidLocalSendID(id) {
		return Result{}, local(CodeNoSuchSend, "not a local send id (32 lowercase hex characters, as printed by `inbox send`)")
	}
	// Checked before locking, so asking about an id that has no record leaves
	// nothing behind (the lock would create the directory and a lock file).
	if _, err := os.Lstat(s.store.path(id)); errors.Is(err, os.ErrNotExist) {
		return Result{}, local(CodeNoSuchSend, "no unfinished local send has that id (a finished send leaves no record)")
	}
	lk, err := s.store.lock(id)
	if errors.Is(err, errLocked) {
		return Result{}, failed(CodeJournalBusy, "another relayium command is working on this send right now")
	}
	if err != nil {
		return Result{}, failed(CodeLocalState, "cannot lock the local send record: "+termtext.Safe(err.Error()))
	}
	defer lk.release()
	j, err := s.store.load(id)
	if errors.Is(err, errNoJournal) {
		return Result{}, local(CodeNoSuchSend, "no unfinished local send has that id (a finished send leaves no record)")
	}
	if err != nil {
		return Result{}, failed(CodeJournalInvalid, "the local send record is unreadable and was left untouched: "+termtext.Safe(err.Error()))
	}
	// The record names where and as whom it was made. The bearer goes only to
	// the logged-in server, and only when the record agrees with it.
	if j.Server != s.client.Server() || j.AccountEmail != s.accountEmail {
		return Result{}, failed(CodeJournalMismatch, "this send was started under a different login or server; "+
			"log in as that account on that server to finish it")
	}
	_, cur, err := s.resolveSelf(ctx)
	if err != nil {
		return Result{}, err
	}
	if cur.ID != j.SourceDeviceID {
		return Result{}, failed(CodeJournalMismatch, "this send was started from a login that no longer exists here "+
			"(logging in again creates a new device); it cannot be finished from this one")
	}
	res := Result{LocalSendID: id, TargetDeviceID: j.TargetDeviceID, CiphertextBytes: j.CiphertextBytes, ExpiresAt: j.ExpiresAt}

	// Only a record already in phase finalizing may have had a finalize sent by
	// the earlier process; an open session seen by the status read below had not.
	// Likewise only a record already in phase finalized may have had a create
	// sent (N8 records that phase before the create).
	finalizeMayHaveBeenSent := j.Phase == PhaseFinalizing
	createMayHaveBeenSent := j.Phase == PhaseFinalized
	switch j.Phase {
	case PhasePlanned:
		s.drop(j)
		return res, failed(CodeNotResumable, "this send never got past the start of its upload, so there is nothing to finish. "+
			"Run `relayium inbox send` again. If an upload had been opened, cleanup discards it.")
	case PhaseUploading:
		n, err := s.client.UploadStatus(ctx, j.UploadID)
		switch {
		case err == nil && n == j.CiphertextBytes:
			j.Phase = PhaseFinalizing
			if err := s.checkpoint(j); err != nil {
				e := recordFailed(err, fmt.Sprintf("so the upload was not completed and nothing was queued; "+
					"the record was left as it was. Run `relayium inbox retry %s` again once the configuration "+
					"directory can be written.", j.ID))
				e.LocalSendID = j.ID
				return res, e
			}
		case err == nil:
			s.drop(j)
			return res, failed(CodeNotResumable, "this send stopped part-way through its upload, which cannot be resumed "+
				"(the encryption key no longer exists). Run `relayium inbox send` again; that is a new upload and is counted again. "+msgOrphanPartial)
		case statusOf(err) == http.StatusNotFound:
			s.drop(j)
			return res, uploadFailure(errUploadLost)
		default:
			if e := ctxErr(err); e != nil {
				return res, s.interrupted(j, err)
			}
			return res, readErr(err)
		}
		fallthrough
	case PhaseFinalizing:
		storedID, exp, err := s.finalize(ctx, j, finalizeMayHaveBeenSent)
		if err != nil {
			return res, err
		}
		j.Phase, j.StoredFileID, j.ExpiresAt = PhaseFinalized, storedID, exp
		if err := s.checkpoint(j); err != nil {
			return res, s.finalizedNotRecorded(j, err)
		}
		res.ExpiresAt = exp
	}
	task, created, err := s.create(ctx, j, nil, createMayHaveBeenSent)
	if err != nil {
		return res, err
	}
	s.drop(j)
	res.TaskID, res.State, res.ErrorCode, res.Created, res.SavedAt = task.ID, task.State, task.ErrorCode, created, task.SavedAt
	return res, nil
}
