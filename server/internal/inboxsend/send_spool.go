package inboxsend

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/relayium/relayium/internal/termtext"
)

// Stage R — `inbox send --resumable` and its resume (see spool.go).
//
// Order, each step durable before the next:
//
//	lock → spool (single sealing pass, fsync) → closeSealing → record v2
//	(phase planned: wrapped key + spool hash) → init from the spool → record
//	uploading (upload id, chunk size) → appends from the spool → record
//	finalizing → finalize → record finalized → create → remove record → remove
//	spool.
//
// A restart anywhere resumes from the record: planned re-opens an upload from
// the spool (N8: no byte was appended to any session while the record said
// planned, so nothing can be counted twice); uploading asks the server where
// its session stands and continues from there; finalizing/finalized never
// upload at all. A session the server no longer has is never replaced by a
// new upload automatically.

// sendSpooled is Send after planning and key wrapping, for a resumable send.
// The caller holds id's lock, so no other command can see a half-written copy.
func (s *Session) sendSpooled(ctx context.Context, j *Journal, plan *Plan, sl *sealer, encManifest []byte, targetName string) (Result, error) {
	j.V = journalVersionSpooled
	s.notef("Encrypting into a local copy before uploading (%d bytes)…", projectedSpoolBytes(plan))
	gen := newFrameSource(plan.files, sl)
	next := func() ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return gen.next()
	}
	size, sum, err := s.store.writeSpool(j.ID, encManifest, plan.CiphertextBytes, next)
	gen.close()
	// The one sealing pass is over, successful or not: from here nothing can
	// be sealed under this key again. It can still be wrapped to a rotated
	// device key while this process runs.
	sl.closeSealing()
	if err != nil {
		switch {
		case ctxErr(err) != nil:
			e := ctxErr(err)
			e.Msg = "interrupted while encrypting; nothing was sent"
			return Result{}, e
		case errors.Is(err, errSourceChanged):
			return Result{}, local(CodeSourceChanged, "a file changed, grew, shrank or was replaced while it was being "+
				"encrypted; nothing was sent")
		}
		return Result{}, localf(CodeSpoolUnavailable, "cannot write the local encrypted copy (%s); nothing was sent",
			termtext.Safe(err.Error()))
	}
	j.SpoolBytes, j.SpoolSHA256, j.HeaderBytes = size, sum, int64(4+len(encManifest))
	// N6: the wrapped key is durable before any network write. A record that
	// never reached its name leaves the copy evidence of nothing, so the copy
	// goes with the failure. One that did (the failure came after the rename,
	// e.g. the directory fsync) is visible now and names the copy, so both
	// stay: never a record pointing at a copy that was removed.
	if renamed, err := s.store.saveReporting(j); err != nil {
		if !renamed {
			_ = s.store.removeSpool(j.ID)
			return Result{}, failed(CodeLocalState, "cannot write the local send record: "+termtext.Safe(err.Error())+"; nothing was sent")
		}
		e := failed(CodeJournalWrite, fmt.Sprintf("cannot make the local send record durable (%s), so nothing was sent. "+
			"The record and the local encrypted copy were kept: `relayium inbox retry %s` starts the upload from the copy, "+
			"and `relayium inbox retry --discard %s` removes them.", termtext.Safe(err.Error()), j.ID, j.ID))
		e.LocalSendID = j.ID
		return Result{}, e
	}
	// From here on no source file is opened again: every byte uploaded, now or
	// after a restart, comes from the copy.
	res := Result{LocalSendID: j.ID, TargetDeviceID: j.TargetDeviceID, TargetName: targetName, CiphertextBytes: j.CiphertextBytes}
	if err := s.uploadSpooled(ctx, j); err != nil {
		return res, err
	}
	return s.finish(ctx, j, sl, res)
}

// uploadSpooled takes a spooled record in phase planned or uploading to a
// durable phase finalizing, uploading only bytes read from its verified local
// copy. It never seals and never re-reads a source file.
func (s *Session) uploadSpooled(ctx context.Context, j *Journal) error {
	var from int64
	if j.Phase == PhaseUploading {
		// Where the session stands first: a session the server no longer has
		// ends the send whatever the copy holds, and one that already has
		// every byte needs nothing from the copy.
		n, err := s.client.UploadStatus(ctx, j.UploadID)
		switch {
		case err == nil:
			from = n
		case statusOf(err) == http.StatusNotFound:
			// The session this send was uploading into is gone. Its bytes cannot
			// be moved into a new upload without uploading (and counting) them
			// again, which only an explicit new send may do.
			s.drop(j)
			return uploadFailure(errUploadLost)
		case ctxErr(err) != nil:
			return s.interrupted(j, err)
		default:
			return readErr(err)
		}
		if from == j.CiphertextBytes {
			return s.checkpointFinalizing(j)
		}
	}
	sp, err := s.store.openSpool(j)
	if err != nil {
		return s.spoolUnusable(j, err)
	}
	defer sp.close()
	switch j.Phase {
	case PhasePlanned:
		uploadID, chunk, err := s.client.InitUpload(ctx, j.TTL, j.CiphertextBytes, sp.encManifest)
		if err != nil {
			if ctxErr(err) != nil {
				return s.spoolKept(j, ClassInterrupted, CodeCancelled, "interrupted while starting the upload.", err)
			}
			if isTransport(err) || statusOf(err) >= 500 {
				// The server may have opened a session whose id never arrived.
				// It holds no data (nothing is appended before the id is
				// recorded) and cleanup discards it; a retry opens a new one.
				return s.spoolKept(j, ClassFailed, CodeNetwork, "the upload could not be started: "+
					termtext.Safe(err.Error())+". If the server did open it, that empty upload is discarded by cleanup.", err)
			}
			s.drop(j)
			return uploadRefusal(err, "")
		}
		j.Phase, j.UploadID, j.ChunkSize = PhaseUploading, uploadID, chunk
		// N8: no byte is appended to a session the record does not name.
		if err := s.checkpoint(j); err != nil {
			j.Phase, j.UploadID, j.ChunkSize = PhasePlanned, "", 0
			e := recordFailed(err, fmt.Sprintf("so the send was stopped before any file data was uploaded. Nothing was queued; "+
				"the empty upload the server opened is discarded by cleanup. The local encrypted copy was kept: once the "+
				"configuration directory can be written again, `relayium inbox retry %s` starts the upload again from it.", j.ID))
			e.LocalSendID = j.ID
			return e
		}
	case PhaseUploading:
		if from > 0 {
			s.notef("Resuming the upload at %d of %d bytes from the local encrypted copy.", from, j.CiphertextBytes)
		}
	default:
		return nil
	}
	err = spoolUpload(ctx, s.client, j.UploadID, j.ChunkSize, j.CiphertextBytes, from, sp.body)
	if err != nil {
		switch {
		case ctxErr(err) != nil:
			return s.spoolKept(j, ClassInterrupted, CodeCancelled, "interrupted during the upload.", err)
		case errors.Is(err, errSpoolRead):
			e := newErr(ClassFailed, CodeSpoolCorrupt, fmt.Sprintf("the local encrypted copy could not be read during the "+
				"upload, so it was stopped. The record and the copy were kept; `relayium inbox retry %s` checks the copy "+
				"again and resumes if it is intact. ", j.ID)+msgMetered, err)
			e.LocalSendID = j.ID
			return e
		case isTransport(err) || statusOf(err) >= 500:
			return s.spoolKept(j, ClassFailed, CodeNetwork, "the upload was stopped after repeated network or server "+
				"failures.", err)
		}
		s.drop(j)
		return uploadFailure(err)
	}
	return s.checkpointFinalizing(j)
}

// spoolKept ends a resumable send whose record and local copy stay, so
// `inbox retry` resumes it.
func (s *Session) spoolKept(j *Journal, class Class, code, what string, cause error) *Error {
	e := newErr(class, code, what+fmt.Sprintf(" Nothing will be uploaded again automatically. The local encrypted copy "+
		"was kept: `relayium inbox retry %s` continues the upload from it without encrypting again — from where the "+
		"server's upload stands, while the server still holds it (an upload that receives no data for about an hour "+
		"is removed; the send then fails and is not uploaded again automatically). ", j.ID)+
		msgMetered, cause)
	e.LocalSendID = j.ID
	return e
}

// spoolUnusable is a spooled record whose copy is missing, damaged or
// unreadable: nothing is uploaded from it, and nothing is removed — the user
// decides with `inbox retry --discard`.
func (s *Session) spoolUnusable(j *Journal, cause error) *Error {
	msg := fmt.Sprintf("the local encrypted copy of this send is missing or does not match its record, so nothing was "+
		"uploaded from it and it was left as it was. It cannot be resumed: run `relayium inbox retry --discard %s` "+
		"to remove it, then `relayium inbox send` again (a new upload, counted again).", j.ID)
	if j.Phase == PhaseUploading {
		msg += " " + msgOrphanPartial
	}
	e := newErr(ClassFailed, CodeSpoolCorrupt, msg, cause)
	e.LocalSendID = j.ID
	return e
}

// collectSpools removes orphaned local copies and expires old spooled
// records (see LocalSends), reporting what it removed on Notice.
func (s *Session) collectSpools() {
	_ = s.LocalSends()
}

// expireSpooled applies spoolMaxAge to one spooled record under its lock:
// a record that still needed its copy (planned, uploading) is removed with
// it; a record past its upload keeps going without the copy it no longer
// needs. It reports whether the record itself was removed.
func (s *Session) expireSpooled(j *Journal) bool {
	if !j.Spooled() || s.now().Sub(time.Unix(j.CreatedAt, 0)) <= spoolMaxAge {
		return false
	}
	if has, err := s.store.hasSpool(j.ID); err != nil || (!has && j.Phase != PhasePlanned && j.Phase != PhaseUploading) {
		return false
	}
	lk, err := s.store.lock(j.ID)
	if err != nil {
		return false
	}
	defer lk.release()
	cur, err := s.store.load(j.ID)
	if err != nil {
		return false
	}
	when := time.Unix(cur.CreatedAt, 0).UTC().Format(time.RFC3339)
	switch cur.Phase {
	case PhasePlanned, PhaseUploading:
		if s.store.remove(cur.ID) != nil {
			return false
		}
		_ = s.store.removeSpool(cur.ID)
		msg := "removed the local encrypted copy and record of a resumable send from %s (%s); it can no longer be resumed"
		if cur.Phase == PhaseUploading {
			msg += ". " + msgOrphanPartial
		}
		s.notef(msg, when, cur.ID)
		return true
	default:
		if s.store.removeSpool(cur.ID) == nil {
			s.notef("removed the local encrypted copy of send %s from %s; it was fully uploaded, so the copy is no longer needed",
				cur.ID, when)
		}
		return false
	}
}

// DiscardResult is what an explicit discard removed.
type DiscardResult struct {
	LocalSendID string
	Phase       string
	// Message says, honestly for the phase, what was left on the server.
	Message string
}

// Discard removes one unfinished local send — its record and, for a
// resumable send, its local encrypted copy — at the user's explicit request.
// It is local only: it needs no login, sends nothing, and cannot undo what
// the server already holds, which Message states. A record another command
// holds, or one that cannot be read, is refused and left as it is.
func Discard(cfgDir, id string) (DiscardResult, error) {
	if !ValidLocalSendID(id) {
		return DiscardResult{}, local(CodeNoSuchSend, "not a local send id (32 lowercase hex characters, as printed by `inbox send`)")
	}
	store := newJournalStore(cfgDir)
	if has, err := store.exists(id); err != nil {
		return DiscardResult{}, unsafeRecords(err)
	} else if !has {
		return DiscardResult{}, local(CodeNoSuchSend, "no unfinished local send has that id (a finished send leaves no record)")
	}
	lk, err := store.lock(id)
	if errors.Is(err, errLocked) {
		return DiscardResult{}, failed(CodeJournalBusy, "another relayium command is working on this send right now")
	}
	if err != nil {
		return DiscardResult{}, failed(CodeLocalState, "cannot lock the local send record: "+termtext.Safe(err.Error()))
	}
	defer lk.release()
	j, err := store.load(id)
	if errors.Is(err, errNoJournal) {
		return DiscardResult{}, local(CodeNoSuchSend, "no unfinished local send has that id (a finished send leaves no record)")
	}
	if err != nil {
		return DiscardResult{}, failed(CodeJournalInvalid, "the local send record is unreadable and was left untouched: "+termtext.Safe(err.Error()))
	}
	if err := store.remove(id); err != nil {
		return DiscardResult{}, failed(CodeLocalState, "cannot remove the local send record: "+termtext.Safe(err.Error()))
	}
	if j.Spooled() {
		if err := store.removeSpool(id); err != nil {
			return DiscardResult{LocalSendID: id, Phase: j.Phase}, failed(CodeLocalState,
				"the record was removed, but its local encrypted copy could not be ("+termtext.Safe(err.Error())+
					"); a later `relayium inbox sent` removes it")
		}
	}
	return DiscardResult{LocalSendID: id, Phase: j.Phase, Message: discardMessage(j.Phase)}, nil
}

func discardMessage(phase string) string {
	switch phase {
	case PhasePlanned:
		return "Nothing had been uploaded for it. If the server had opened an upload, cleanup discards that empty upload."
	case PhaseUploading:
		return "Nothing was queued. " + msgOrphanPartial
	case PhaseFinalizing:
		return "Nothing was queued by this send. Every byte had been uploaded, and the upload may have been completed " +
			"and counted; without the record it can no longer be finished. Whatever the server holds for it stays " +
			"there until cleanup removes it; cleanup runs periodically and can be delayed. " + msgMetered
	default:
		return "The upload was completed and counted. The delivery may or may not have been queued — check " +
			"`relayium inbox sent`. If it was not, the uploaded ciphertext stays on the server until cleanup removes it."
	}
}
