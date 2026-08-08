package inboxclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storecrypto"
)

// One delivery, end to end: claim material in, a committed file tree out.
//
// The pipeline is ordered so that nothing observable is produced until
// everything has been proven:
//
//	unseal -> decrypt+validate manifest -> plan destinations -> journal the plan
//	  -> preflight space -> stream ciphertext into STAGING -> verify the WHOLE
//	  authenticated stream -> report `verifying` -> commit -> report `saved`
//
// Nothing is written outside the staging area before the last authenticated
// frame has been accepted and the total length has been checked, so a tampered,
// truncated or wrongly-keyed blob can never leave an apparently complete file
// where the user will find it.

// streamAttempts bounds reconnects for ONE delivery attempt. Beyond this the
// task is failed retryable and central's own backoff and attempt budget
// (inbox.MaxTaskAttempts) take over, which is the layer that decides when a
// delivery is hopeless — the worker must not out-retry it.
const streamAttempts = 5

// defaultIdleTimeout bounds how long a ciphertext body may stall with no bytes
// arriving. Without it a server that accepts the request and then freezes the
// body would hold the worker forever, and the resume loop — which only reacts to
// read errors — would never engage.
const defaultIdleTimeout = 60 * time.Second

// Logger receives operational lines. It is deliberately format-based and the
// call sites are audited: a log line may carry a task id, a state, a closed
// error code, byte and file COUNTS, and nothing else. Manifest names and
// destination paths are plaintext-derived and never appear (invariant 6);
// TestWorkerLogsNoFileNames asserts it.
type Logger func(format string, args ...any)

func (l Logger) logf(format string, args ...any) {
	if l != nil {
		l(format, args...)
	}
}

// Clock is the worker's view of time. Injecting it keeps the polling, backoff
// and lease-renewal schedules testable without wall-clock sleeps.
type Clock interface {
	Now() time.Time
	// Sleep returns early with ctx.Err() if the context is cancelled, which is
	// what makes cancellation immediate rather than "after the current backoff".
	Sleep(ctx context.Context, d time.Duration) error
}

// RealClock is the production Clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Receiver executes one delivery at a time into a fixed receive directory.
type Receiver struct {
	Client *Client
	Store  *Store
	Root   string
	Clock  Clock
	Log    Logger
	// IdleTimeout bounds a stalled ciphertext body; 0 uses defaultIdleTimeout.
	IdleTimeout time.Duration
	// Renew is called periodically while a delivery is in progress so central's
	// five-minute lease is refreshed well before it expires. It returns an error
	// when the lease is gone, which aborts the delivery immediately rather than
	// finishing work no longer authorised.
	Renew func(ctx context.Context, state string) error
	// RenewInterval is how often Renew is called; 0 uses a third of the lease.
	RenewInterval time.Duration
}

func (r *Receiver) now() time.Time { return r.clock().Now() }

// clock defaults to the real one so a Receiver constructed without an explicit
// Clock still sleeps between resume attempts rather than panicking.
func (r *Receiver) clock() Clock {
	if r.Clock != nil {
		return r.Clock
	}
	return RealClock{}
}

func (r *Receiver) renewInterval() time.Duration {
	if r.RenewInterval > 0 {
		return r.RenewInterval
	}
	// A third of the lease: two renewals may be lost before the lease is at risk,
	// which matches how presence tolerates two missed heartbeats.
	return inbox.TaskLeaseTTL / 3
}

// Deliver runs one task to completion and returns nil on a durable commit.
//
// Every error it returns is a *Failure carrying the closed error code and the
// state to report, so the caller never has to interpret a local error to decide
// what to tell central.
func (r *Receiver) Deliver(ctx context.Context, d Delivery) error {
	journals := r.Store.Journals()

	// A journal that already says "completed" means this device committed these
	// exact destinations in an earlier run whose `saved` report did not land.
	// Re-downloading would duplicate the delivery; the correct action is to
	// re-assert what already happened.
	if j, found, err := journals.Load(d.ID); err != nil {
		return retryable(inbox.TaskErrInternal, err)
	} else if found && j.Completed {
		r.Log.logf("inbox: task %s already committed locally (%d file(s)); re-reporting saved", d.ID, len(j.Plan))
		return nil
	}

	key, cleanup, err := r.unsealKey(d)
	if err != nil {
		return err
	}
	defer cleanup()

	manifest, total, err := r.openManifest(d, key)
	if err != nil {
		return err
	}

	j, err := r.planAndJournal(d, manifest, journals)
	if err != nil {
		return err
	}

	if err := checkFreeSpace(r.Root, total); err != nil {
		return attention(inbox.TaskErrDiskFull, err)
	}

	staging, serr := PrepareStaging(r.Root, d.ID)
	if serr != nil {
		return classifyFS(serr)
	}
	j.Staging = staging
	if err := journals.Save(&j, r.now()); err != nil {
		return retryable(inbox.TaskErrInternal, err)
	}

	if err := r.stream(ctx, d, key, j.Plan, staging, total); err != nil {
		// Nothing outside staging exists yet, so removing it leaves no trace.
		_ = os.RemoveAll(staging)
		return err
	}

	// The bytes are proven. Tell central we are verifying and committing before
	// touching the user's directory, so the sender's UI never shows a gap
	// between "downloaded" and "landed".
	if r.Renew != nil {
		if err := r.Renew(ctx, inbox.TaskVerifying); err != nil {
			// The staged bytes are complete and verified but nothing is visible
			// yet, so abandoning here costs a re-download and risks nothing.
			// Committing under a lease central has already reassigned could let
			// two workers deliver the same task into two directories.
			_ = os.RemoveAll(staging)
			return fmt.Errorf("%w: could not report verifying: %v", ErrAbandon, err)
		}
	}

	lastCommitRenew := r.now()
	c := &Committer{
		Store: journals, Root: r.Root, Now: r.now, Staging: staging,
		BeforeEach: func() error {
			if r.Renew == nil || r.now().Sub(lastCommitRenew) < r.renewInterval() {
				return nil
			}
			if err := r.Renew(ctx, inbox.TaskVerifying); err != nil {
				return fmt.Errorf("%w: lease renewal failed during commit: %v", ErrAbandon, err)
			}
			lastCommitRenew = r.now()
			return nil
		},
	}
	if err := c.Commit(&j); err != nil {
		if errors.Is(err, ErrAbandon) {
			return err
		}
		// Files already committed stay committed and stay journalled: they are
		// real, verified deliveries. The task is reported against the reason the
		// REMAINING ones could not be placed, and a later attempt resumes from
		// the journal rather than re-creating what exists.
		return classifyFS(err)
	}
	r.Log.logf("inbox: task %s committed %d file(s), %d byte(s)", d.ID, len(j.Plan), total)
	return nil
}

// unsealKey resolves the device private key the task names and opens the sealed
// content key. The returned cleanup zeroes the content key: it is the one secret
// in this process that can decrypt the user's file, and it should not outlive
// the delivery in a heap that may be swapped or cored.
func (r *Receiver) unsealKey(d Delivery) ([]byte, func(), error) {
	kp, found, err := r.Store.Keys().ByKeyID(d.TargetKeyID)
	if err != nil {
		return nil, func() {}, retryable(inbox.TaskErrInternal, err)
	}
	if !found {
		// Central sealed to a key this machine does not hold — a re-login that
		// minted a new device, a restored-from-backup config, or a key history
		// that was destroyed. Nothing here can ever open it.
		return nil, func() {}, terminal(inbox.TaskErrDecryptFailed,
			errors.New("no local private key for the key this task was sealed to"))
	}
	key, err := UnsealContentKey(d.WrapAlgorithm, d.WrappedKey, kp)
	if err != nil {
		if errors.Is(err, ErrUnseal) {
			return nil, func() {}, classifyCrypto(err)
		}
		return nil, func() {}, terminal(inbox.TaskErrUnsupported, err)
	}
	return key, func() { zero(key) }, nil
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// openManifest decrypts and validates the copied encrypted manifest.
func (r *Receiver) openManifest(d Delivery, key []byte) (storecrypto.Manifest, int64, error) {
	enc, err := DecodeEncManifest(d.EncManifest)
	if err != nil {
		return storecrypto.Manifest{}, 0, terminal(inbox.TaskErrVerifyFailed, err)
	}
	m, err := storecrypto.DecryptManifest(key, enc)
	if err != nil {
		// A manifest that does not authenticate under the unsealed key means the
		// manifest and the ciphertext disagree, or one of them was tampered
		// with. Neither improves on retry.
		return storecrypto.Manifest{}, 0, classifyCrypto(fmt.Errorf("%w: manifest: %v", ErrDecryptFailed, err))
	}
	total, err := checkManifest(m, d.CiphertextBytes)
	if err != nil {
		return storecrypto.Manifest{}, 0, classifyCrypto(err)
	}
	return m, total, nil
}

// planAndJournal computes the destination plan and makes it durable BEFORE any
// destination can exist. A resumed task keeps its original plan: recomputing it
// against a directory that now contains this task's own earlier output would
// walk the collision suffix forward and deliver the same file twice.
func (r *Receiver) planAndJournal(d Delivery, m storecrypto.Manifest, journals *JournalStore) (Journal, error) {
	existing, found, err := journals.Load(d.ID)
	if err != nil {
		return Journal{}, retryable(inbox.TaskErrInternal, err)
	}
	if found && len(existing.Plan) > 0 {
		if existing.Root != r.Root {
			// The receive directory changed under an unfinished task. The old
			// plan describes paths that no longer mean anything, and inventing a
			// new one would risk delivering into two places.
			return Journal{}, attention(inbox.TaskErrDirectoryUnavailabl,
				errors.New("the receive directory changed while this task was unfinished"))
		}
		return existing, nil
	}
	plan, err := PlanDestinations(r.Root, m.Files, PathExists)
	if err != nil {
		return Journal{}, classifyFS(err)
	}
	j := Journal{
		TaskID: d.ID, StoredFileID: d.StoredFileID, TargetKeyID: d.TargetKeyID,
		Root: r.Root, Plan: plan, PlanAt: r.now().Unix(),
	}
	if err := journals.Save(&j, r.now()); err != nil {
		return Journal{}, retryable(inbox.TaskErrInternal, err)
	}
	return j, nil
}

// stream fetches the ciphertext, authenticates every frame, and lands the
// plaintext in staging — resuming from the last COMPLETE frame boundary across
// transport failures.
//
// The resume offset comes from Decryptor.ConsumedCipher, which only advances
// past frames that already authenticated, so a resumed request never re-feeds a
// partial frame and never skips one.
func (r *Receiver) stream(ctx context.Context, d Delivery, key []byte, plan []PlanEntry, staging string, total int64) error {
	w := &stagingWriter{dir: staging, plan: plan}
	defer w.closeAll()
	dec := storecrypto.NewDecryptor(key)
	idle := r.IdleTimeout
	if idle <= 0 {
		idle = defaultIdleTimeout
	}
	lastRenew := r.now()

	for attempt := 1; ; attempt++ {
		err := r.streamOnce(ctx, d, dec, w, idle, &lastRenew)
		if err == nil {
			break
		}
		if errors.Is(err, ErrAbandon) {
			return err // central took the task away; report nothing
		}
		if ferr := AsFailure(err); ferr != nil {
			return ferr // already classified and non-retryable within this attempt
		}
		if ctx.Err() != nil {
			return retryable(inbox.TaskErrDownloadFailed, ctx.Err())
		}
		if attempt >= streamAttempts {
			return classifyTransport(fmt.Errorf("ciphertext stream failed after %d attempts: %w", attempt, err))
		}
		if errors.Is(err, errRangeIgnored) {
			// The server answered a resume with a full body. Restarting the whole
			// delivery is the only safe response: splicing a fresh start into the
			// middle of a stream would produce authenticated-looking garbage.
			return retryable(inbox.TaskErrDownloadFailed, err)
		}
		dec.ResetBuffer()
		r.Log.logf("inbox: task %s ciphertext stream interrupted, resuming (attempt %d)", d.ID, attempt+1)
		if serr := r.clock().Sleep(ctx, streamBackoff(attempt)); serr != nil {
			return retryable(inbox.TaskErrDownloadFailed, serr)
		}
	}

	// End() is the completeness proof: it rejects trailing bytes (a truncated
	// final frame) and any total length other than what the manifest declared.
	if err := dec.End(total); err != nil {
		return classifyCrypto(fmt.Errorf("%w: %v", ErrTruncatedStream, err))
	}
	if err := w.finish(); err != nil {
		return classifyFS(err)
	}
	// Independent of the writer's own accounting: stat every staged file and
	// compare it against the manifest. The writer could be wrong; the filesystem
	// cannot be, and this is the last chance to notice before anything becomes
	// visible to the user.
	if err := w.verifySizes(); err != nil {
		return classifyCrypto(fmt.Errorf("%w: %v", ErrTruncatedStream, err))
	}
	return nil
}

// errRangeIgnored marks a resume that was answered with a full 200 body.
var errRangeIgnored = errors.New("relayium inbox: server ignored Range on a resumed ciphertext stream")

// streamBackoff is the delay before the Nth (1-based) reconnect: 300ms doubling
// to a 5s cap, matching the download path's behaviour.
func streamBackoff(attempt int) time.Duration {
	d := 300 * time.Millisecond << (attempt - 1)
	if d > 5*time.Second {
		d = 5 * time.Second
	}
	return d
}

// streamOnce performs one ciphertext GET and feeds it through the decryptor.
// A returned *Failure is final for this delivery; any other error is a transport
// symptom the caller may resume from.
func (r *Receiver) streamOnce(ctx context.Context, d Delivery, dec *storecrypto.Decryptor, w *stagingWriter, idle time.Duration, lastRenew *time.Time) error {
	start := dec.ConsumedCipher()
	resp, err := r.Client.Blob(ctx, d.ID, d.ClaimToken, start)
	if err != nil {
		// A rejection with a machine-readable code is central's judgement and is
		// not something a reconnect fixes.
		switch ErrorCode(err) {
		case "stale_claim", "stored_object_unavailable", "task_terminal":
			return fmt.Errorf("%w: %v", ErrAbandon, err)
		}
		return err
	}
	defer resp.Body.Close()
	if start > 0 && !resp.Partial {
		return errRangeIgnored
	}

	stall := time.AfterFunc(idle, func() { resp.Body.Close() })
	defer stall.Stop()

	buf := make([]byte, storecrypto.ChunkSize)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			stall.Reset(idle)
			if perr := dec.Push(buf[:n], w.write); perr != nil {
				var we *stagingError
				if errors.As(perr, &we) {
					return classifyFS(we.err)
				}
				return classifyCrypto(fmt.Errorf("%w: %v", ErrDecryptFailed, perr))
			}
			if r.Renew != nil && r.now().Sub(*lastRenew) >= r.renewInterval() {
				// A refused renewal means the lease is gone. Finishing the
				// download would be work this worker is no longer authorised to
				// report, so it stops here rather than at the end.
				if err := r.Renew(ctx, inbox.TaskDownloading); err != nil {
					return fmt.Errorf("%w: lease renewal refused: %v", ErrAbandon, err)
				}
				*lastRenew = r.now()
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// stagingError distinguishes a local write failure from a decrypt failure, since
// both surface through the same Decryptor.Push return value.
type stagingError struct{ err error }

func (e *stagingError) Error() string { return e.err.Error() }
func (e *stagingError) Unwrap() error { return e.err }

// stagingWriter fans decrypted plaintext across the staged files in plan order.
//
// The manifest is the ONLY source of per-file boundaries — the ciphertext stream
// carries none — so the declared sizes are consumed exactly, and a stream that
// delivers more data than the manifest accounts for is refused rather than
// spilling into the next file or a new one.
type stagingWriter struct {
	dir  string
	plan []PlanEntry

	idx       int
	cur       *os.File
	remaining int64
}

// openNext opens staged files from idx, creating and closing zero-size entries
// along the way (no ciphertext frames exist for them), until it finds one with
// bytes to receive or exhausts the plan.
func (w *stagingWriter) openNext() error {
	for w.cur == nil && w.idx < len(w.plan) {
		e := w.plan[w.idx]
		p := filepath.Join(w.dir, fmt.Sprintf("%d.part", e.Index))
		// O_EXCL because the staging directory was created empty for this task:
		// anything already at this name means the area is not ours to use.
		// receivedFileMode is set at creation and again below so the committed
		// file's mode never depends on the umask, and never has an exec bit.
		f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|os.O_EXCL|oNoFollow, receivedFileMode)
		if err != nil {
			return err
		}
		if err := f.Chmod(receivedFileMode); err != nil {
			f.Close()
			return err
		}
		w.idx++
		if e.Size == 0 {
			if err := syncClose(f); err != nil {
				return err
			}
			continue
		}
		w.cur = f
		w.remaining = e.Size
	}
	return nil
}

// write is the Decryptor.Push callback.
func (w *stagingWriter) write(pt []byte) error {
	for len(pt) > 0 {
		if w.cur == nil {
			if err := w.openNext(); err != nil {
				return &stagingError{err}
			}
			if w.cur == nil {
				return &stagingError{errors.New("more decrypted data than the manifest declares")}
			}
		}
		n := int64(len(pt))
		if n > w.remaining {
			n = w.remaining
		}
		if _, err := w.cur.Write(pt[:n]); err != nil {
			return &stagingError{err}
		}
		pt = pt[n:]
		w.remaining -= n
		if w.remaining == 0 {
			if err := syncClose(w.cur); err != nil {
				return &stagingError{err}
			}
			w.cur = nil
		}
	}
	return nil
}

// finish flushes trailing zero-size entries, which never receive a write call.
func (w *stagingWriter) finish() error {
	if w.cur != nil {
		if err := syncClose(w.cur); err != nil {
			return err
		}
		w.cur = nil
	}
	return w.openNext()
}

// verifySizes confirms every planned entry exists in staging at exactly its
// declared size, and that none carries an executable bit.
func (w *stagingWriter) verifySizes() error {
	for _, e := range w.plan {
		p := filepath.Join(w.dir, fmt.Sprintf("%d.part", e.Index))
		fi, err := os.Lstat(p)
		if err != nil {
			return fmt.Errorf("staged entry %d missing: %w", e.Index, err)
		}
		if !fi.Mode().IsRegular() {
			return fmt.Errorf("staged entry %d is not a regular file", e.Index)
		}
		if fi.Size() != e.Size {
			return fmt.Errorf("staged entry %d is %d bytes, manifest declares %d", e.Index, fi.Size(), e.Size)
		}
		if fi.Mode().Perm()&0o111 != 0 {
			return fmt.Errorf("staged entry %d has an executable bit set", e.Index)
		}
	}
	return nil
}

func (w *stagingWriter) closeAll() {
	if w.cur != nil {
		_ = w.cur.Close()
		w.cur = nil
	}
}

// syncClose flushes a staged file's contents to stable storage before it is
// closed. The link that later publishes it is only meaningful if the bytes
// behind it survive a crash.
func syncClose(f *os.File) error {
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
