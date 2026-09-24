package linksession

import (
	"github.com/relayium/relayium/internal/linkwire"
)

// ---------------------------------------------------------------- text lane

const (
	TIdle = iota
	TWaitAccept
	TIncoming
	TOpen
	TEndWait // we sent END; peer frames until its END/REJECT are drained (authenticated, discarded)
	TFailed  // text lane dead; the file lane is untouched
)

const (
	TLocalRequest = iota
	TLocalAccept  // only when admitted AND authorised
	TLocalReject
	TLocalEnd
	TLocalSend
	TLocalSendOversize
	TPeerRequest
	TPeerAccept
	TPeerReject
	TPeerEnd
	TPeerContent    // kind 9, >= 21 bytes
	TPeerContentBad // AEAD / seq / strict UTF-8 failure
	TPeerShort9     // starts with 0x09, shorter than 21
	TPeerUnknown    // any other first byte (incl. relay-renew 0x0d): ignored, never fed to AEAD
	TRateExceeded
	TSessionBound
	TConsentTimeout
	TEndAckTimeout
	TIdleTimeout
	TLinkClosed
)

// Text-lane actions.
const (
	TASendRequest  = "send:REQUEST"
	TAArmConsent   = "arm:consent(10m)"
	TAPrompt       = "prompt|policy"
	TANotOpen      = "error:not-open"
	TAStillEnding  = "error:still-ending"
	TATooLong      = "error:too-long(no-seq-burned)"
	TASendEndSym   = "send:END(symmetric)"
	TAKeepLate     = "keep:late-accept-drain-budget"
	TASendEnd      = "send:END"
	TAArmEndAck    = "arm:end-ack(30s)"
	TAAttachAccept = "attach:handler->send:ACCEPT(text)"
	TASendReject   = "send:REJECT(text)"
	TADeliver      = "decrypt(seq==expected)+strict-utf8+deliver"
	TASeal         = "seal(textSend,seq++)+send"
	TAEndAck       = "end-ack:received"
	TADrain        = "authenticate+discard(drain)"
	TADrainAccept  = "drain:late-accept"
	TAConvert      = "convert:intent->prompt"
)

// TextTable is the text-lane machine.
var TextTable = buildText()

func buildText() *Table {
	t := newTable("text-lane",
		[]string{"initiator", "responder"},
		[]string{"Idle", "WaitAccept", "Incoming", "Open", "EndWait", "Failed"},
		[]string{"LocalRequest", "LocalAccept", "LocalReject", "LocalEnd", "LocalSend", "LocalSendOversize",
			"PeerRequest", "PeerAccept", "PeerReject", "PeerEnd", "PeerContent", "PeerContentBad", "PeerShort9",
			"PeerUnknown", "RateExceeded", "SessionBound", "ConsentTimeout", "EndAckTimeout", "IdleTimeout", "LinkClosed"})
	all := t.all()
	ini, rsp := ints(LCInitiator), ints(LCResponder)
	live := ints(TIdle, TWaitAccept, TIncoming, TOpen, TEndWait)
	for _, s := range live {
		t.add(all, s, ints(TPeerUnknown), Same, Ignore)
		t.add(all, s, ints(TPeerShort9), TFailed, FailLane, "report:text-malformed")
		t.add(all, s, ints(TLinkClosed), TFailed, OK, "report:conversation-ended(no-delivery-receipts)")
		t.add(all, s, ints(TLocalSendOversize), Same, Ignore, TATooLong)
	}
	for _, s := range ints(TIdle, TWaitAccept, TIncoming) {
		t.add(all, s, ints(TPeerContent, TPeerContentBad), TFailed, FailLane, ANoDecrypt, "report:text-before-accept")
	}

	// Idle
	t.add(all, TIdle, ints(TLocalRequest), TWaitAccept, OK, TASendRequest, TAArmConsent)
	t.add(all, TIdle, ints(TPeerRequest), TIncoming, OK, TAPrompt, TAArmConsent)
	t.add(all, TIdle, ints(TLocalAccept, TLocalReject, TLocalEnd, TPeerAccept, TPeerReject, TPeerEnd,
		TRateExceeded, TSessionBound, TConsentTimeout, TEndAckTimeout, TIdleTimeout), Same, Ignore)
	t.add(all, TIdle, ints(TLocalSend), Same, Ignore, TANotOpen)

	// WaitAccept
	t.add(all, TWaitAccept, ints(TPeerAccept), TOpen, OK)
	t.add(all, TWaitAccept, ints(TPeerReject), TIdle, OK, "report:declined")
	t.add(ini, TWaitAccept, ints(TPeerRequest), Same, OK, TASendReject)   // glare: initiator keeps
	t.add(rsp, TWaitAccept, ints(TPeerRequest), TIncoming, OK, TAConvert) // glare: responder converts
	t.add(all, TWaitAccept, ints(TPeerEnd), TIdle, OK, TASendEndSym, TAKeepLate)
	t.add(all, TWaitAccept, ints(TConsentTimeout, TLocalEnd), TEndWait, OK, TASendEnd, TAArmEndAck)
	t.add(all, TWaitAccept, ints(TLocalRequest, TLocalAccept, TLocalReject, TRateExceeded, TSessionBound, TEndAckTimeout, TIdleTimeout), Same, Ignore)
	t.add(all, TWaitAccept, ints(TLocalSend), Same, Ignore, TANotOpen)

	// Incoming
	t.add(all, TIncoming, ints(TLocalAccept), TOpen, OK, TAAttachAccept)
	t.add(all, TIncoming, ints(TLocalReject, TConsentTimeout), TIdle, OK, TASendReject)
	t.add(all, TIncoming, ints(TPeerEnd), TIdle, OK, TASendEndSym)
	t.add(all, TIncoming, ints(TLocalEnd), TIdle, OK, TASendReject)
	t.add(all, TIncoming, ints(TPeerRequest, TLocalRequest, TPeerAccept, TPeerReject, TRateExceeded, TSessionBound, TEndAckTimeout, TIdleTimeout), Same, Ignore)
	t.add(all, TIncoming, ints(TLocalSend), Same, Ignore, TANotOpen)

	// Open
	t.add(all, TOpen, ints(TPeerContent), Same, OK, TADeliver)
	t.add(all, TOpen, ints(TPeerContentBad), TFailed, FailLane, "report:text-integrity")
	t.add(all, TOpen, ints(TRateExceeded), TFailed, FailLane, "report:flooding")
	t.add(all, TOpen, ints(TSessionBound), TEndWait, OK, TASendEnd, TAArmEndAck, "report:session-limit")
	t.add(all, TOpen, ints(TLocalSend), Same, OK, TASeal)
	t.add(all, TOpen, ints(TPeerRequest), Same, OK, TASendReject)
	t.add(all, TOpen, ints(TPeerEnd), TIdle, OK, TASendEndSym)
	t.add(all, TOpen, ints(TLocalEnd, TIdleTimeout), TEndWait, OK, TASendEnd, TAArmEndAck)
	t.add(all, TOpen, ints(TLocalRequest, TLocalAccept, TLocalReject, TPeerAccept, TPeerReject, TConsentTimeout, TEndAckTimeout), Same, Ignore)

	// EndWait
	t.add(all, TEndWait, ints(TPeerEnd, TPeerReject), TIdle, OK, TAEndAck)
	t.add(all, TEndWait, ints(TPeerContent), Same, OK, TADrain)
	t.add(all, TEndWait, ints(TPeerContentBad), TFailed, FailLane, "report:text-integrity")
	t.add(all, TEndWait, ints(TPeerRequest), TIncoming, OK, TAPrompt, TAArmConsent)
	t.add(all, TEndWait, ints(TPeerAccept), Same, OK, TADrainAccept)
	t.add(all, TEndWait, ints(TEndAckTimeout), TFailed, FailLane, "report:end-unacknowledged(codecs-not-reusable)")
	t.add(all, TEndWait, ints(TLocalRequest), Same, Ignore, TAStillEnding)
	t.add(all, TEndWait, ints(TLocalSend), Same, Ignore, TANotOpen)
	t.add(all, TEndWait, ints(TLocalAccept, TLocalReject, TLocalEnd, TRateExceeded, TSessionBound, TConsentTimeout, TIdleTimeout), Same, Ignore)

	for e := range t.Events {
		t.add(all, TFailed, ints(e), Same, Ignore)
	}
	return t
}

// ---------------------------------------------------------------- text-lane runtime

func (s *Session) fireText(ev int) {
	if s.textM == nil {
		return
	}
	before := s.textM.State
	r := s.textM.Fire(ev)
	for _, a := range r.Do {
		switch a {
		case TASendRequest:
			s.emit(Effect{Kind: EffSendText, Bytes: []byte{linkwire.CtrlTextRequest}})
		case TAPrompt, TAConvert:
			s.textPrompt++
			if s.authz.Text == PolicyPrompt {
				s.emit(Effect{Kind: EffPromptText, Prompt: s.textPrompt})
			}
		case TASendEnd, TASendEndSym:
			s.emit(Effect{Kind: EffSendText, Bytes: []byte{linkwire.CtrlTextEnd}})
		case TAAttachAccept:
			s.emit(Effect{Kind: EffTextOpened})
			s.emit(Effect{Kind: EffSendText, Bytes: []byte{linkwire.CtrlAccept}})
		case TASendReject:
			s.emit(Effect{Kind: EffSendText, Bytes: []byte{linkwire.CtrlReject}})
		}
	}
	if code := reportOf(r.Do); code != "" {
		s.report("text", code)
	}
	if s.textM.State != before {
		s.laneSettled()
		switch s.textM.State {
		case TWaitAccept, TIncoming:
			s.arm(tTextConsent, TextConsent)
		case TEndWait:
			s.arm(tEndAck, TextEndAckWait)
		case TOpen:
			s.textMsgs, s.textBytes = 0, 0
			s.tokens, s.tokensAt = TextRateBurst, s.clock.Now()
			s.arm(tTextIdle, TextIdle)
			if before == TWaitAccept {
				s.emit(Effect{Kind: EffTextOpened})
			}
		}
	}
}

// textFrame demuxes one text-lane message (link §7.3): a one-byte control,
// then a content frame, then everything else. A frame starting 0x09 that is
// too short fails the text lane; ANY other first byte — including the
// relay-renew/1 0x0d control — is ignored and never reaches the AEAD.
func (s *Session) textFrame(raw []byte) {
	if s.textM.State == TFailed || !s.lk.alive() {
		return
	}
	// relay-renew/1 control (0x0d, relay-renew-v1 §6.2) is demuxed AHEAD of
	// activity: a probe or ack is never user activity, so it must not re-arm
	// the link idle timer. The renewal engine consumes it before the session
	// (IsRenewControlFrame); one that still arrives here is ignored exactly
	// as before, without touching the idle clock.
	if IsRenewControlFrame(raw) {
		s.fireText(TPeerUnknown)
		return
	}
	s.touchLink()
	if c, ok := linkwire.TextLifecycle(raw); ok {
		switch c {
		case linkwire.TextRequest:
			s.fireText(TPeerRequest)
		case linkwire.TextAccept:
			s.fireText(TPeerAccept)
		case linkwire.TextReject:
			s.fireText(TPeerReject)
		case linkwire.TextEnd:
			s.fireText(TPeerEnd)
		}
		return
	}
	if !linkwire.IsTextFrame(raw) {
		if len(raw) > 0 && raw[0] == linkwire.KindText {
			s.fireText(TPeerShort9)
		} else {
			s.fireText(TPeerUnknown)
		}
		return
	}
	row := s.textM.Peek(TPeerContent)
	deliver, drain := has(row.Do, TADeliver), has(row.Do, TADrain)
	if !deliver && !drain {
		s.fireText(TPeerContent) // fail-lane, no-decrypt
		return
	}
	if deliver && !s.takeToken() {
		s.fireText(TRateExceeded) // flood: refused before any decrypt
		return
	}
	body, err := s.lk.textRx.Open(raw)
	if err != nil {
		s.fireText(TPeerContentBad)
		return
	}
	if drain {
		s.fireText(TPeerContent) // authenticated, discarded
		return
	}
	if s.textMsgs+1 > TextSessionMsgs || s.textBytes+len(body) > TextSessionBytes {
		s.fireText(TSessionBound) // authenticated (sequence kept), not delivered
		return
	}
	s.textMsgs++
	s.textBytes += len(body)
	s.fireText(TPeerContent)
	s.emit(Effect{Kind: EffDeliverText, Text: body})
	s.arm(tTextIdle, TextIdle)
}

// takeToken is the inbound flood guard: TextRateBurst tokens refilling at
// TextRatePerSecond, on the injected clock.
func (s *Session) takeToken() bool {
	now := s.clock.Now()
	if el := now.Sub(s.tokensAt).Seconds(); el > 0 {
		s.tokens += el * TextRatePerSecond
		if s.tokens > TextRateBurst {
			s.tokens = TextRateBurst
		}
	}
	s.tokensAt = now
	if s.tokens < 1 {
		return false
	}
	s.tokens--
	return true
}

// ---------------------------------------------------------------- local text actions

// RequestText opens a conversation.
func (s *Session) RequestText() ([]Effect, error) {
	return s.run(func() error {
		if err := s.openAndAdmitted(); err != nil {
			return err
		}
		row := s.textM.Peek(TLocalRequest)
		s.fireText(TLocalRequest)
		if row.Result == Ignore {
			return ErrWrongState
		}
		return nil
	})
}

// AcceptText is the interactive yes to a conversation prompt.
func (s *Session) AcceptText(prompt uint64) ([]Effect, error) {
	return s.run(func() error {
		if s.textM == nil {
			return ErrNotOpen
		}
		if s.authz.Text != PolicyPrompt {
			return ErrNotAuthorised
		}
		if s.textM.State != TIncoming || prompt != s.textPrompt {
			return ErrStalePrompt
		}
		if s.adm != AdmAdmitted {
			return ErrNotAdmitted
		}
		s.fireText(TLocalAccept)
		return nil
	})
}

// RejectText declines a conversation prompt (allowed before admission).
func (s *Session) RejectText(prompt uint64) ([]Effect, error) {
	return s.run(func() error {
		if s.textM == nil {
			return ErrNotOpen
		}
		if s.textM.State != TIncoming || prompt != s.textPrompt {
			return ErrStalePrompt
		}
		s.fireText(TLocalReject)
		return nil
	})
}

// EndText ends the conversation (END, acknowledged within 30 s).
func (s *Session) EndText() ([]Effect, error) {
	return s.run(func() error {
		if s.textM == nil {
			return ErrNotOpen
		}
		s.fireText(TLocalEnd)
		return nil
	})
}

// SendText seals and sends one message. bufferedAmount is the text channel's
// current SCTP buffered amount. An oversize or malformed message is refused
// BEFORE sealing, so no sequence number is burned and the conversation lives.
func (s *Session) SendText(body []byte, bufferedAmount int) ([]Effect, error) {
	return s.run(func() error {
		if err := s.openAndAdmitted(); err != nil {
			return err
		}
		if len(body) > linkwire.TextPlainLimit(s.cfg.MaxFrameBytes) {
			s.fireText(TLocalSendOversize)
			return ErrTextTooLong
		}
		row := s.textM.Peek(TLocalSend)
		if !has(row.Do, TASeal) {
			s.fireText(TLocalSend)
			return ErrWrongState
		}
		if bufferedAmount+len(body) > TextSendBufferMax {
			return ErrTextBackpressure
		}
		f, err := s.lk.textTx.Seal(body)
		if err != nil {
			return err
		}
		s.fireText(TLocalSend)
		s.emit(Effect{Kind: EffSendText, Bytes: f})
		s.arm(tTextIdle, TextIdle)
		s.touchLink()
		return nil
	})
}
