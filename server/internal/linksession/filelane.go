package linksession

import (
	"github.com/relayium/relayium/internal/linkwire"
)

// File lane ("relayium") and text lane ("relayium-text") of one open link.
// Classes are the establishment role, which is the deterministic glare keeper:
// the initiator keeps its outbound; the responder yields (file) or converts its
// intent into the incoming prompt (text). Codecs are link-owned and continue
// across batches and conversations (link §5.5); nothing here constructs one.
//
// One batch at a time on the file lane, in either direction (the Web's rule:
// an inbound manifest while any batch is live is answered BUSY or yielded).

const (
	FIdle      = iota
	FOutWait   // our manifest sent; waiting for ACCEPT/REJECT/BUSY
	FOutSend   // consented; sending data under the 8 MiB durable-ACK window
	FOutFinish // every DONE sent; waiting for COMPLETE
	FInPrompt  // peer manifest decoded; awaiting a LOCAL decision (admission-gated)
	FInRecv    // ACCEPT sent after the sink was attached; protected content admitted
	FInDrain   // we stopped an accepted batch (REJECT sent); authenticate-and-discard until BATCH_ABORT
	FInExpired // consent window elapsed at the prompt; send NOTHING, wait for the sender's BATCH_ABORT
	FEnded     // lane dead or link closed; absorbing
)

const (
	FLocalOffer = iota
	FPeerManifest
	FPeerManifestBad // decode / validation / bound failure of BATCH_ENC(+PARTs)
	FPeerContent     // CHUNK_PART / CHUNK / DONE_ENC by frame CLASS (before any decrypt)
	FPeerContentBad  // failed AEAD, seq != expected, fragment rule, over-bound piece
	FPeerDoneMismatch
	FAllVerified // internal: every file's chain verified AND durably written
	FPeerAccept
	FPeerReject
	FPeerBusy
	FPeerComplete
	FPeerBatchAbort
	FPeerAck
	FPeerResumeStart
	FPeerResumeReq
	FPeerLegacy     // kinds 2 / 3
	FPeerUnroutable // total classifier said unroutable (incl. kind 12 when preupload/1 not announced)
	FLocalAccept    // produced only when admitted AND authorised (policy or prompt)
	FLocalReject
	FLocalCancelOut
	FLocalCancelIn
	FConsentTimeout
	FDrainTimeout
	FReceiveStall
	FSendStall
	FCompleteStall
	FAllSent
	FDrainOverBound
	FLinkClosed
)

const (
	ASendManifest = "send:manifest(BATCH_PART*,BATCH_ENC)+arm:consent(10m)"
	APrompt       = "decode:manifest+sanitize:names+prompt|policy"
	AAttachAccept = "attach:sink(no-clobber,owned-paths)->send:ACCEPT+arm:receive-stall(60s)"
	ASendData     = "send:data(window<=8MiB-ahead-of-durable-ACK,backpressure)"
	ABatchAbort   = "send:BATCH_ABORT(ordered-after-in-flight)"
	AFBusy        = "send:BUSY(file)"
	AFReject      = "send:REJECT(file)"
	AComplete     = "send:COMPLETE"
	ARxAbort      = "receiver:abort-batch(seq-continues)"
	ADecryptWrite = "decrypt(seq==expected)+write+ack-when-durable"
	ADrain        = "authenticate+discard(bounded-by-manifest-remaining)"
	ADiscard      = "discard:partial(owned-files-only)"
	ANoDecrypt    = "no-decrypt"
	AQueue        = "queue:local-batch"
	ARequeue      = "requeue:once"
	AAckClamp     = "ack:advance-if(>current && <=emitted)"
)

// FileTable is the file-lane machine.
var FileTable = buildFile()

func buildFile() *Table {
	t := newTable("file-lane",
		[]string{"initiator", "responder"},
		[]string{"Idle", "OutWait", "OutSend", "OutFinish", "InPrompt", "InRecv", "InDrain", "InExpired", "Ended"},
		[]string{"LocalOffer", "PeerManifest", "PeerManifestBad", "PeerContent", "PeerContentBad", "PeerDoneMismatch",
			"AllVerified", "PeerAccept", "PeerReject", "PeerBusy", "PeerComplete", "PeerBatchAbort", "PeerAck",
			"PeerResumeStart", "PeerResumeReq", "PeerLegacy", "PeerUnroutable", "LocalAccept", "LocalReject",
			"LocalCancelOut", "LocalCancelIn", "ConsentTimeout", "DrainTimeout", "ReceiveStall", "SendStall",
			"CompleteStall", "AllSent", "DrainOverBound", "LinkClosed"})
	all := t.all()
	ini, rsp := ints(LCInitiator), ints(LCResponder)
	live := ints(FIdle, FOutWait, FOutSend, FOutFinish, FInPrompt, FInRecv, FInDrain, FInExpired)

	// Rows identical in every live state.
	for _, s := range live {
		t.add(all, s, ints(FPeerManifestBad, FPeerResumeStart, FPeerResumeReq, FPeerUnroutable), FEnded, FailLane, "report:protocol")
		t.add(all, s, ints(FPeerLegacy), FEnded, FailLane, "report:peer-older-version")
	}
	// States without an inbound batch: protected content is a hard failure and is NEVER decrypted.
	for _, s := range ints(FIdle, FOutWait, FOutSend, FOutFinish, FInPrompt, FInExpired) {
		t.add(all, s, ints(FPeerContent, FPeerContentBad), FEnded, FailLane, ANoDecrypt, "report:content-before-consent")
		t.add(all, s, ints(FPeerDoneMismatch, FAllVerified, FDrainOverBound), Same, Ignore, "unreachable:no-inbound-decrypt")
	}
	// States without an outbound batch: stray receiver->sender controls change nothing (Web-compatible).
	for _, s := range ints(FIdle, FInPrompt, FInRecv, FInDrain, FInExpired) {
		t.add(all, s, ints(FPeerAccept, FPeerReject, FPeerBusy, FPeerComplete, FPeerAck), Same, Ignore)
		t.add(all, s, ints(FLocalCancelOut, FSendStall, FCompleteStall, FAllSent), Same, Ignore)
	}

	// ---- Idle
	t.add(all, FIdle, ints(FLocalOffer), FOutWait, OK, ASendManifest)
	t.add(all, FIdle, ints(FPeerManifest), FInPrompt, OK, APrompt, "arm:consent(10m-from-receipt)")
	t.add(all, FIdle, ints(FPeerBatchAbort), Same, OK, ARxAbort)
	t.add(all, FIdle, ints(FLocalAccept, FLocalReject, FLocalCancelIn, FConsentTimeout, FDrainTimeout, FReceiveStall), Same, Ignore)
	t.add(all, FIdle, ints(FLinkClosed), FEnded, OK)

	// ---- OutWait
	t.add(all, FOutWait, ints(FPeerAccept), FOutSend, OK, ASendData)
	t.add(all, FOutWait, ints(FPeerReject), FIdle, OK, "report:declined")
	t.add(all, FOutWait, ints(FPeerBusy), FIdle, OK, ARequeue)
	t.add(ini, FOutWait, ints(FPeerManifest), Same, OK, AFBusy)                              // glare: the initiator keeps
	t.add(rsp, FOutWait, ints(FPeerManifest), FInPrompt, OK, ABatchAbort, ARequeue, APrompt) // glare: the responder yields
	t.add(all, FOutWait, ints(FPeerComplete, FPeerAck), Same, Ignore)
	t.add(all, FOutWait, ints(FPeerBatchAbort), Same, OK, ARxAbort)
	t.add(all, FOutWait, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FOutWait, ints(FLocalCancelOut), FIdle, OK, ABatchAbort)
	t.add(all, FOutWait, ints(FConsentTimeout), FIdle, OK, ABatchAbort, "report:no-answer")
	t.add(all, FOutWait, ints(FLocalAccept, FLocalReject, FLocalCancelIn, FDrainTimeout, FReceiveStall, FSendStall, FCompleteStall, FAllSent), Same, Ignore)
	t.add(all, FOutWait, ints(FLinkClosed), FEnded, FailLane, "report:batch-not-delivered")

	// ---- OutSend
	t.add(all, FOutSend, ints(FPeerAck), Same, OK, AAckClamp)
	t.add(all, FOutSend, ints(FPeerReject), FIdle, OK, ABatchAbort, "report:stopped-by-receiver")
	t.add(all, FOutSend, ints(FPeerAccept, FPeerBusy), Same, Ignore)
	t.add(all, FOutSend, ints(FPeerComplete), FEnded, FailLane, "report:complete-before-done")
	t.add(all, FOutSend, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FOutSend, ints(FPeerBatchAbort), Same, OK, ARxAbort)
	t.add(all, FOutSend, ints(FAllSent), FOutFinish, OK, "arm:complete-stall(150s)")
	t.add(all, FOutSend, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FOutSend, ints(FLocalCancelOut), FIdle, OK, ABatchAbort, "report:cancelled-partial-not-delivered")
	t.add(all, FOutSend, ints(FSendStall), FIdle, OK, ABatchAbort, "report:send-stalled")
	t.add(all, FOutSend, ints(FLocalAccept, FLocalReject, FLocalCancelIn, FConsentTimeout, FDrainTimeout, FReceiveStall, FCompleteStall), Same, Ignore)
	t.add(all, FOutSend, ints(FLinkClosed), FEnded, FailLane, "report:partial-not-delivered")

	// ---- OutFinish
	t.add(all, FOutFinish, ints(FPeerComplete), FIdle, OK, "report:delivered-and-verified")
	t.add(all, FOutFinish, ints(FPeerReject), FIdle, OK, ABatchAbort, "report:receiver-failed-to-save")
	t.add(all, FOutFinish, ints(FPeerAck), Same, OK, AAckClamp)
	t.add(all, FOutFinish, ints(FPeerAccept, FPeerBusy, FAllSent), Same, Ignore)
	t.add(all, FOutFinish, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FOutFinish, ints(FPeerBatchAbort), Same, OK, ARxAbort)
	t.add(all, FOutFinish, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FOutFinish, ints(FLocalCancelOut), FIdle, OK, ABatchAbort, "report:cancelled-after-all-sent(receiver-may-have-saved)")
	t.add(all, FOutFinish, ints(FCompleteStall), FEnded, FailLane, "report:no-completion")
	t.add(all, FOutFinish, ints(FLocalAccept, FLocalReject, FLocalCancelIn, FConsentTimeout, FDrainTimeout, FReceiveStall, FSendStall), Same, Ignore)
	t.add(all, FOutFinish, ints(FLinkClosed), FEnded, FailLane, "report:delivery-unconfirmed")

	// ---- InPrompt (admission != authorisation: LocalAccept exists only when both hold)
	t.add(all, FInPrompt, ints(FLocalAccept), FInRecv, OK, AAttachAccept)
	t.add(all, FInPrompt, ints(FLocalReject), FIdle, OK, AFReject)
	t.add(all, FInPrompt, ints(FConsentTimeout), FInExpired, OK, "hide:prompt(no-ACCEPT/REJECT:untagged-controls-could-answer-a-later-batch)", "arm:drain(30s)")
	t.add(all, FInPrompt, ints(FPeerBatchAbort), FIdle, OK, ARxAbort, "report:sender-withdrew")
	t.add(all, FInPrompt, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FInPrompt, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FInPrompt, ints(FLocalCancelIn), FIdle, OK, AFReject)
	t.add(all, FInPrompt, ints(FDrainTimeout, FReceiveStall), Same, Ignore)
	t.add(all, FInPrompt, ints(FLinkClosed), FEnded, OK, "report:offer-lost")

	// ---- InRecv
	t.add(all, FInRecv, ints(FPeerContent), Same, OK, ADecryptWrite)
	t.add(all, FInRecv, ints(FPeerContentBad), FEnded, FailLane, ADiscard, "report:integrity")
	t.add(all, FInRecv, ints(FPeerDoneMismatch), FInDrain, OK, AFReject, ADiscard, "report:integrity")
	t.add(all, FInRecv, ints(FAllVerified), FIdle, OK, AComplete, "report:saved(verified,durable)")
	t.add(all, FInRecv, ints(FPeerBatchAbort), FIdle, OK, ARxAbort, ADiscard, "report:sender-cancelled")
	t.add(all, FInRecv, ints(FLocalCancelIn), FInDrain, OK, AFReject, "close:sink-after-pending-writes", ADiscard)
	t.add(all, FInRecv, ints(FReceiveStall), FInDrain, OK, AFReject, ADiscard, "report:stalled")
	t.add(all, FInRecv, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FInRecv, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FInRecv, ints(FDrainOverBound, FLocalAccept, FLocalReject, FConsentTimeout, FDrainTimeout), Same, Ignore)
	t.add(all, FInRecv, ints(FLinkClosed), FEnded, FailLane, ADiscard, "report:partial-not-saved")

	// ---- InDrain
	t.add(all, FInDrain, ints(FPeerContent, FPeerDoneMismatch), Same, OK, ADrain)
	t.add(all, FInDrain, ints(FPeerContentBad, FDrainOverBound, FDrainTimeout), FEnded, FailLane, "report:drain-failed")
	t.add(all, FInDrain, ints(FPeerBatchAbort), FIdle, OK, ARxAbort)
	t.add(all, FInDrain, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FInDrain, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FInDrain, ints(FAllVerified, FLocalAccept, FLocalReject, FLocalCancelIn, FConsentTimeout, FReceiveStall), Same, Ignore)
	t.add(all, FInDrain, ints(FLinkClosed), FEnded, OK)

	// ---- InExpired
	t.add(all, FInExpired, ints(FPeerBatchAbort), FIdle, OK, ARxAbort)
	t.add(all, FInExpired, ints(FDrainTimeout), FEnded, FailLane, "report:sender-never-withdrew")
	t.add(all, FInExpired, ints(FPeerManifest), Same, OK, AFBusy)
	t.add(all, FInExpired, ints(FLocalOffer), Same, OK, AQueue)
	t.add(all, FInExpired, ints(FLocalAccept, FLocalReject, FLocalCancelIn, FConsentTimeout, FReceiveStall), Same, Ignore)
	t.add(all, FInExpired, ints(FLinkClosed), FEnded, OK)

	for e := range t.Events {
		t.add(all, FEnded, ints(e), Same, Ignore)
	}
	return t
}

// Action strings of the file table that are not constants above.
const (
	FAArmConsentIn = "arm:consent(10m-from-receipt)"
	FAArmComplete  = "arm:complete-stall(150s)"
	FAHidePrompt   = "hide:prompt(no-ACCEPT/REJECT:untagged-controls-could-answer-a-later-batch)"
	FAArmDrain     = "arm:drain(30s)"
	FACloseSink    = "close:sink-after-pending-writes"
	FAUnreachable  = "unreachable:no-inbound-decrypt"
)

// ---------------------------------------------------------------- file-lane runtime

// fireFile applies one file-lane event. Wire bytes leave only through the
// row's actions; content decryption is decided in fileFrame from the row that
// WOULD fire (Peek), so the table is the only place consent is decided.
func (s *Session) fireFile(ev int) {
	s.fireFileWith(ev, nil, 0)
}

func (s *Session) fireFileWith(ev int, manifest []linkwire.FileMeta, ackValue float64) {
	if s.fileM == nil {
		return
	}
	before := s.fileM.State
	r := s.fileM.Fire(ev)
	for _, a := range r.Do {
		switch a {
		case ASendManifest:
			// Frames were sealed by offerNow before the row fired.
			for _, f := range s.pendingManifest {
				s.emit(Effect{Kind: EffSendFile, Bytes: f})
			}
			s.pendingManifest = nil
		case APrompt:
			s.filePrompt++
			s.fin = fileIn{files: manifest}
			for _, f := range manifest {
				s.fin.total += f.Size
			}
			if s.authz.Files == PolicyPrompt {
				s.emit(Effect{Kind: EffPromptFiles, Prompt: s.filePrompt, Files: manifest})
			}
		case AAttachAccept:
			s.emit(Effect{Kind: EffAttachSink, Prompt: s.filePrompt, Files: s.fin.files})
			s.emit(Effect{Kind: EffSendFile, Bytes: []byte{linkwire.CtrlAccept}})
		case ASendData:
			s.emit(Effect{Kind: EffSendData})
		case ABatchAbort:
			if s.lk.alive() {
				s.lk.fileTx.AbortBatch()
			}
			s.emit(Effect{Kind: EffSendFile, Bytes: []byte{linkwire.CtrlBatchAbort}})
		case AFBusy:
			s.emit(Effect{Kind: EffSendFile, Bytes: []byte{linkwire.CtrlBusy}})
		case AFReject:
			s.emit(Effect{Kind: EffSendFile, Bytes: []byte{linkwire.CtrlReject}})
		case AComplete:
			s.emit(Effect{Kind: EffSendFile, Bytes: []byte{linkwire.CtrlComplete}})
		case ARxAbort:
			if s.lk.alive() {
				s.lk.fileRx.AbortBatch()
			}
		case ADiscard:
			s.emit(Effect{Kind: EffDiscardPartial, Prompt: s.filePrompt})
		case AQueue:
			if s.offering != nil {
				s.queue = append(s.queue, queuedBatch{files: s.offering})
			}
		case ARequeue:
			if !s.fout.requeued {
				s.queue = append([]queuedBatch{{files: s.fout.files, requeued: true}}, s.queue...)
			} else {
				s.report("file", "peer-busy(batch-not-sent)")
			}
		case AAckClamp:
			if next := linkwire.AdvanceAck(s.fout.acked, s.fout.emitted, ackValue); next != s.fout.acked {
				s.fout.acked = next
				if s.fileM.State == FOutSend {
					s.arm(tSendStall, SendBufferStall)
					s.arm(tSendProgress, SendProgressStall)
				} else if s.fileM.State == FOutFinish {
					s.arm(tCompleteStall, CompleteStall)
				}
			}
		case FAHidePrompt:
			s.withdrawPrompt()
		}
	}
	if code := reportOf(r.Do); code != "" {
		s.report("file", code)
	}
	if s.fileM.State != before {
		switch s.fileM.State {
		case FOutWait, FInPrompt:
			s.arm(tFileConsent, FileConsent)
		case FOutSend:
			s.arm(tSendStall, SendBufferStall)
			s.arm(tSendProgress, SendProgressStall)
		case FOutFinish:
			s.arm(tCompleteStall, CompleteStall)
		case FInRecv:
			s.arm(tRecvStall, ReceiveStall)
		case FInDrain:
			s.fin.drainLeft = s.fin.total - s.fin.received
			s.arm(tDrain, FileDrainWait)
		case FInExpired:
			s.arm(tDrain, FileDrainWait)
		}
		s.laneSettled()
		if before == FInPrompt && s.fileM.State != FInRecv && !has(r.Do, FAHidePrompt) {
			s.withdrawPrompt()
		}
	}
}

// withdrawPrompt retracts a prompt the user was shown; its answer is now
// meaningless (AcceptFiles/RejectFiles return ErrStalePrompt).
func (s *Session) withdrawPrompt() {
	if s.authz.Files == PolicyPrompt {
		s.emit(Effect{Kind: EffPromptWithdrawn, Prompt: s.filePrompt})
	}
}

// fileFrame demuxes one file-lane message with linkwire's total partition.
func (s *Session) fileFrame(raw []byte) {
	if s.fileM.State == FEnded || !s.lk.alive() {
		return
	}
	s.touchLink()
	cls, ctl := linkwire.ClassifyFileFrame(raw)
	switch cls {
	case linkwire.ClassLifecycle:
		switch ctl {
		case linkwire.FileAccept:
			s.fireFile(FPeerAccept)
		case linkwire.FileReject:
			s.fireFile(FPeerReject)
		case linkwire.FileComplete:
			s.fireFile(FPeerComplete)
		case linkwire.FileBusy:
			s.fireFile(FPeerBusy)
		case linkwire.FileBatchAbort:
			s.fireFile(FPeerBatchAbort)
		}
	case linkwire.ClassAck:
		v, _ := linkwire.ParseAck(raw)
		s.fireFileWith(FPeerAck, nil, v)
	case linkwire.ClassResumeRequest:
		s.fireFile(FPeerResumeReq)
	case linkwire.ClassResumeStart:
		s.fireFile(FPeerResumeStart)
	case linkwire.ClassProtected:
		switch raw[0] {
		case linkwire.KindBatchLegacy, linkwire.KindDoneLegacy:
			s.fireFile(FPeerLegacy) // never parsed
		case linkwire.KindBatchEnc, linkwire.KindBatchPart:
			s.manifestFrame(raw)
		default:
			s.contentFrame(raw)
		}
	default:
		s.fireFile(FPeerUnroutable)
	}
}

// manifestFrame feeds a manifest piece. The manifest is the consent prompt, so
// it is decrypted in every live state (link §6.3 receiver step 1).
func (s *Session) manifestFrame(raw []byte) {
	e, err := s.lk.fileRx.Feed(raw)
	switch {
	case err != nil:
		s.fireFile(FPeerManifestBad)
	case e.Kind == linkwire.EventManifest:
		s.fireFileWith(FPeerManifest, e.Manifest, 0)
	}
}

// contentFrame handles CHUNK_PART / CHUNK / DONE_ENC. The row that would fire
// for FPeerContent decides whether the AEAD receiver may see the frame at all:
// only a decrypt or drain row lets it through (P3).
func (s *Session) contentFrame(raw []byte) {
	row := s.fileM.Peek(FPeerContent)
	write, drain := has(row.Do, ADecryptWrite), has(row.Do, ADrain)
	if !write && !drain {
		s.fireFile(FPeerContent) // fail-lane, no-decrypt
		return
	}
	s.contentFeeds = append(s.contentFeeds, s.fileM.State)
	if len(s.contentFeeds) > 64 {
		s.contentFeeds = s.contentFeeds[32:]
	}
	s.arm(tRecvStall, ReceiveStall)
	e, err := s.lk.fileRx.Feed(raw)
	if err != nil {
		s.fireFile(FPeerContentBad)
		return
	}
	in := &s.fin
	if drain {
		if e.Kind == linkwire.EventChunk {
			if uint64(len(e.Chunk)) > in.drainLeft {
				s.fireFile(FDrainOverBound)
				return
			}
			in.drainLeft -= uint64(len(e.Chunk))
		}
		s.fireFile(FPeerContent)
		return
	}
	switch e.Kind {
	case linkwire.EventPart:
		s.fireFile(FPeerContent)
	case linkwire.EventChunk:
		if in.idx >= len(in.files) || in.inFile+uint64(len(e.Chunk)) > in.files[in.idx].Size {
			s.fireFile(FPeerContentBad) // more bytes than the manifest declared
			return
		}
		in.inFile += uint64(len(e.Chunk))
		in.received += uint64(len(e.Chunk))
		s.fireFile(FPeerContent)
		s.emit(Effect{Kind: EffWriteChunk, Prompt: s.filePrompt, Index: in.idx, Bytes: e.Chunk})
	case linkwire.EventDone:
		if in.idx >= len(in.files) {
			s.fireFile(FPeerContentBad)
			return
		}
		if !e.Verified || in.inFile != in.files[in.idx].Size {
			s.fireFile(FPeerDoneMismatch)
			return
		}
		s.fireFile(FPeerContent)
		s.emit(Effect{Kind: EffFileVerified, Prompt: s.filePrompt, Index: in.idx})
		in.idx++
		in.inFile = 0
		in.verified++
		s.maybeComplete()
	default:
		s.fireFile(FPeerContentBad)
	}
}

// maybeComplete fires AllVerified once every file's chain verified AND every
// byte is durable (link §9.3): COMPLETE is a claim, not a hope.
func (s *Session) maybeComplete() {
	in := &s.fin
	if s.fileM.State == FInRecv && in.verified == len(in.files) && in.durable >= in.total {
		s.fireFile(FAllVerified)
	}
}

// FileDurable reports the cumulative bytes of the current inbound batch that
// have reached the file descriptor. ACKs are paced from it (link §9.1).
func (s *Session) FileDurable(ep Epoch, total uint64) ([]Effect, error) {
	return s.transportInput(ep, func() {
		in := &s.fin
		if s.fileM.State != FInRecv || total < in.durable || total > in.received {
			s.inputErr = ErrDurable
			return
		}
		in.durable = total
		if in.durable-in.acked >= AckInterval || in.durable == in.total {
			if f, err := linkwire.AckFrame(in.durable); err == nil && in.durable != in.acked {
				in.acked = in.durable
				s.emit(Effect{Kind: EffSendFile, Bytes: f})
			}
		}
		s.maybeComplete()
	})
}

// ---------------------------------------------------------------- local file actions

func (s *Session) openAndAdmitted() error {
	if s.linkM == nil || (s.linkM.State != LOpen && s.linkM.State != LRestarting) || !s.lk.alive() {
		return ErrNotOpen
	}
	if s.adm != AdmAdmitted {
		return ErrNotAdmitted
	}
	return nil
}

// OfferFiles offers a batch. When the lane is busy the batch is queued and
// offered once the lane is idle again.
func (s *Session) OfferFiles(files []linkwire.FileMeta) ([]Effect, error) {
	return s.run(func() error {
		if err := s.openAndAdmitted(); err != nil {
			return err
		}
		if _, err := linkwire.EncodeManifest(files); err != nil {
			return err
		}
		return s.offerNow(append([]linkwire.FileMeta(nil), files...))
	})
}

// offerNow seals the manifest only if the row that will fire sends it, so a
// queued batch never burns sequence numbers it does not transmit.
func (s *Session) offerNow(files []linkwire.FileMeta) error {
	row := s.fileM.Peek(FLocalOffer)
	if row.Result != OK {
		return ErrWrongState // the lane is dead: nothing would send or queue it
	}
	if has(row.Do, ASendManifest) {
		frames, err := s.lk.fileTx.BatchFrames(files, s.cfg.MaxFrameBytes)
		if err != nil {
			return err
		}
		s.pendingManifest = frames
		requeued := s.nextRequeued
		s.fout = fileOut{files: files, requeued: requeued}
		for _, f := range files {
			s.fout.total += f.Size
		}
	}
	s.offering = files
	s.fireFile(FLocalOffer)
	s.offering, s.nextRequeued = nil, false
	return nil
}

// drainQueue offers the next queued batch once the lane is idle.
func (s *Session) drainQueue() {
	if s.ended || s.fileM == nil || s.fileM.State != FIdle || len(s.queue) == 0 || s.openAndAdmitted() != nil {
		return
	}
	b := s.queue[0]
	s.queue = s.queue[1:]
	s.nextRequeued = b.requeued
	_ = s.offerNow(b.files)
}

// SendChunk seals one LOGICAL chunk of the current outbound file, honouring
// the 8 MiB flow window over the clamped durable ACK.
func (s *Session) SendChunk(chunk []byte) ([]Effect, error) {
	return s.run(func() error {
		if err := s.openAndAdmitted(); err != nil {
			return err
		}
		if s.fileM.State != FOutSend {
			return ErrWrongState
		}
		n := uint64(len(chunk))
		o := &s.fout
		if o.fileIdx >= len(o.files) || o.inFile+n > o.files[o.fileIdx].Size {
			return ErrBatchOverrun
		}
		if s.fout.emitted+n-s.fout.acked > FlowWindow {
			return ErrWindowFull
		}
		frames, err := s.lk.fileTx.ChunkFrames(chunk, s.cfg.MaxFrameBytes)
		if err != nil {
			return err
		}
		o.emitted += n
		o.inFile += n
		for _, f := range frames {
			s.emit(Effect{Kind: EffSendFile, Bytes: f})
		}
		s.arm(tSendStall, SendBufferStall)
		s.touchLink()
		return nil
	})
}

// EndFile seals the current outbound file's DONE_ENC. The file must be
// complete. Sealing the batch's last DONE fires AllSent in the same call, so a
// fast receiver's COMPLETE can never arrive "before all DONEs" through a gap
// between the last DONE and a separate driver call.
func (s *Session) EndFile() ([]Effect, error) {
	return s.run(func() error {
		if err := s.openAndAdmitted(); err != nil {
			return err
		}
		o := &s.fout
		if s.fileM.State != FOutSend || o.fileIdx >= len(o.files) || o.inFile != o.files[o.fileIdx].Size {
			return ErrWrongState
		}
		f, err := s.lk.fileTx.DoneFrame()
		if err != nil {
			return err
		}
		s.emit(Effect{Kind: EffSendFile, Bytes: f})
		o.fileIdx++
		o.inFile = 0
		s.touchLink()
		if o.fileIdx == len(o.files) {
			s.fireFile(FAllSent)
		}
		return nil
	})
}

// SendCredit is how many more plaintext bytes the window allows now.
func (s *Session) SendCredit() uint64 {
	inFlight := s.fout.emitted - s.fout.acked
	if inFlight >= FlowWindow {
		return 0
	}
	return FlowWindow - inFlight
}

// FileSendProgress reports that the transport's send buffer drained (SCTP
// bufferedAmount progress); it re-arms the send-buffer stall.
func (s *Session) FileSendProgress(ep Epoch) ([]Effect, error) {
	return s.transportInput(ep, func() {
		if s.fileM.State == FOutSend {
			s.arm(tSendStall, SendBufferStall)
		}
	})
}

// CancelOutgoing withdraws the outbound batch (BATCH_ABORT, ordered).
func (s *Session) CancelOutgoing() ([]Effect, error) {
	return s.run(func() error {
		if s.fileM == nil {
			return ErrNotOpen
		}
		s.fireFile(FLocalCancelOut)
		return nil
	})
}

// AcceptFiles is the interactive yes to prompt. It is refused before
// admission, for a prompt that is no longer current, and for a command whose
// policy is not interactive.
func (s *Session) AcceptFiles(prompt uint64) ([]Effect, error) {
	return s.run(func() error {
		if s.fileM == nil {
			return ErrNotOpen
		}
		if s.authz.Files != PolicyPrompt {
			return ErrNotAuthorised
		}
		if s.fileM.State != FInPrompt || prompt != s.filePrompt {
			return ErrStalePrompt
		}
		if s.adm != AdmAdmitted {
			return ErrNotAdmitted
		}
		s.fireFile(FLocalAccept)
		return nil
	})
}

// RejectFiles is the interactive no. A refusal is allowed before admission.
func (s *Session) RejectFiles(prompt uint64) ([]Effect, error) {
	return s.run(func() error {
		if s.fileM == nil {
			return ErrNotOpen
		}
		if s.fileM.State != FInPrompt || prompt != s.filePrompt {
			return ErrStalePrompt
		}
		s.fireFile(FLocalReject)
		return nil
	})
}

// CancelIncoming stops an inbound batch being received (REJECT, then drain).
func (s *Session) CancelIncoming() ([]Effect, error) {
	return s.run(func() error {
		if s.fileM == nil {
			return ErrNotOpen
		}
		s.fireFile(FLocalCancelIn)
		return nil
	})
}
