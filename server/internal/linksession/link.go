package linksession

// Link establishment and lifecycle for ONE link/1 with ONE peer (link §§3–5, 8.4).
// Class is the deterministic role: smaller room id = initiator (offers), larger
// id = responder (requests, answers). The role is fixed for the link's life.
//
// First stage (A08/A09) refuses recovery (link §8.4): a dead transport ends the
// link truthfully; resume-generation signals are dropped in silence.

import (
	"encoding/base64"
	"encoding/json"

	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linkwire"
)

// Link classes: the deterministic establishment role (linkwire.LinkRole).
const (
	LCInitiator = iota
	LCResponder
)

// Link states.
const (
	LIdle              = iota
	LRequesting        // responder: linkRequest sent, waiting for the offer
	LOffering          // initiator: offer (+commit,+caps) sent, waiting for the answer
	LAnswered          // responder: peer commit RECORDED before the answer went out; waiting for the peer's reveal
	LRevealed          // initiator: answer's commit recorded, own key revealed; waiting for the peer's reveal
	LKeyedLanesPending // keys verified, both channels not yet open
	LLanesKeyPending   // both channels open (captured), peer key not yet verified
	LOpen              // usable: both lanes attached, keys verified; admission starts here
	LRestarting        // initiator only: one ICE restart offer in flight
	LClosed            // absorbing; codecs destroyed and never reused
)

// Link events.
const (
	LStart = iota
	LPeerRequest
	LPeerOffer        // an offer carrying a commit different from any recorded one
	LPeerRestartOffer // same peer, same recorded commit: an initiator-driven ICE restart
	LPeerOfferDup     // byte-identical duplicate of the held/applied offer (link §5.3)
	LPeerAnswer
	LPeerRevealValid
	LPeerRevealInvalid // mismatch, or no commit recorded (hard error, link §5.1 step 6)
	LPeerRevealDup
	LPeerIce
	LPeerBusy
	LCapsRevoked // peer's newest hello snapshot lacks link/1
	LOtherPeer   // link-generation arrival from a DIFFERENT peer id
	LLanesOpen   // both labelled channels open, exact tuple
	LLaneBad     // unknown label or duplicate label collected
	LCaptureOverflow
	LRequestTick
	LRequestTimeout
	LSetupNoProgress
	LSetupHardCap
	LKeyRevealTimeout
	LHandshakeDeadline
	LLeaveValid   // exact shape, current link with this sender, budget left, HMAC verified
	LLeaveInvalid // any leave failing shape / link / status / budget / HMAC
	LResume
	LDisconnected
	LReconnected
	LTransportLost
	LLocalClose // explicit user disconnect
	LIdleTimeout
	LPeerGone // roster departure; DataChannels are independent of signalling
	LRelayDeadline
)

const (
	ACreateChans  = "create:channels[relayium,relayium-text]"
	ASendOffer    = "send:offer(sdp,commit,caps)"
	ASendRequest  = "send:link-request"
	ASendAnswer   = "send:answer(sdp,commit,caps)"
	ARecordCommit = "record:peer-commit-before-answer"
	ASendReveal   = "send:reveal(key,nonce)"
	ADerive       = "derive:session-keys+sas"
	AAttach       = "attach:both-lanes-then-replay-capture"
	AAdmission    = "begin:admission"
	AArmSetup     = "arm:setup(30s-progress,90s-cap)+handshake(90s)"
	AArmKey       = "arm:key-reveal(30s)"
	AClearSetup   = "clear:setup-timers"
	ACapLanes     = "capture:both-lanes(256KiB)"
	AAddIce       = "add:ice(progress<=6)"
	ASendBusy     = "send:busy(link)"
	ACloseChan    = "close:offending-channel-only"
	ADestroy      = "destroy:codecs+keys"
	ASendLeave    = "send:leave(signed,best-effort)"
	ALeaveBudget  = "spend:leave-budget(<=8)"
	ARestartOffer = "send:ice-restart-offer(once)"
	AApplyAnswer  = "apply:restart-answer"
	AApplyRestart = "apply:restart-offer+send:answer"
	ACloseTx      = "close:transport"
)

// LinkTable is the link-establishment and lifecycle machine.
var LinkTable = buildLink()

func buildLink() *Table {
	t := newTable("link",
		[]string{"initiator", "responder"},
		[]string{"Idle", "Requesting", "Offering", "Answered", "Revealed", "KeyedLanesPending", "LanesKeyPending", "Open", "Restarting", "Closed"},
		[]string{"Start", "PeerRequest", "PeerOffer", "PeerRestartOffer", "PeerOfferDup", "PeerAnswer",
			"PeerRevealValid", "PeerRevealInvalid", "PeerRevealDup", "PeerIce", "PeerBusy", "CapsRevoked",
			"OtherPeer", "LanesOpen", "LaneBad", "CaptureOverflow", "RequestTick", "RequestTimeout",
			"SetupNoProgress", "SetupHardCap", "KeyRevealTimeout", "HandshakeDeadline", "LeaveValid",
			"LeaveInvalid", "Resume", "Disconnected", "Reconnected", "TransportLost", "LocalClose",
			"IdleTimeout", "PeerGone", "RelayDeadline"})
	all := t.all()
	ini, rsp := ints(LCInitiator), ints(LCResponder)
	offerStart := []string{ACreateChans, ASendOffer, AArmSetup}
	preOpen := ints(LRequesting, LOffering, LAnswered, LRevealed, LKeyedLanesPending, LLanesKeyPending)

	// ---- Idle
	t.add(ini, LIdle, ints(LStart, LPeerRequest), LOffering, OK, offerStart...)
	t.add(rsp, LIdle, ints(LStart), LRequesting, OK, ASendRequest, "arm:request(3s-retry,30s)")
	t.add(rsp, LIdle, ints(LPeerRequest), Same, Drop) // a request only travels larger->smaller
	t.add(rsp, LIdle, ints(LPeerOffer), LAnswered, OK, ARecordCommit, ASendAnswer, AArmSetup)
	t.add(ini, LIdle, ints(LPeerOffer), Same, Drop) // the smaller id never answers
	t.add(all, LIdle, ints(LPeerRestartOffer, LPeerOfferDup, LPeerAnswer, LPeerRevealValid, LPeerRevealInvalid,
		LPeerRevealDup, LPeerIce, LPeerBusy, LLeaveValid, LLeaveInvalid, LResume), Same, Drop)
	t.add(all, LIdle, ints(LCapsRevoked), LClosed, FailLink, "report:peer-revoked-link")
	t.add(all, LIdle, ints(LOtherPeer), Same, OK, ASendBusy)
	t.add(all, LIdle, ints(LLanesOpen, LLaneBad, LCaptureOverflow, LRequestTick, LRequestTimeout, LSetupNoProgress,
		LSetupHardCap, LKeyRevealTimeout, LHandshakeDeadline, LDisconnected, LReconnected, LTransportLost,
		LIdleTimeout, LPeerGone, LRelayDeadline), Same, Ignore)
	t.add(all, LIdle, ints(LLocalClose), LClosed, OK)

	// ---- rows shared by every pre-open state
	for _, s := range preOpen {
		t.add(all, s, ints(LOtherPeer), Same, OK, ASendBusy)
		t.add(all, s, ints(LPeerBusy), LClosed, FailLink, ADestroy, "report:peer-busy(requeue)")
		t.add(all, s, ints(LCapsRevoked), LClosed, FailLink, ADestroy, "report:peer-revoked-link")
		t.add(all, s, ints(LLeaveValid, LLeaveInvalid, LResume), Same, Drop) // no open/interrupted link
		t.add(all, s, ints(LTransportLost, LPeerGone, LRelayDeadline), LClosed, FailLink, ADestroy, "report:establishment-failed")
		t.add(all, s, ints(LLocalClose), LClosed, OK, ACloseTx, ADestroy)
		t.add(all, s, ints(LIdleTimeout, LDisconnected, LReconnected), Same, Ignore)
		t.add(all, s, ints(LStart), Same, Ignore) // a second local intent joins the phase in flight
	}

	// ---- Requesting (responder only; initiator never enters)
	t.add(rsp, LRequesting, ints(LPeerOffer), LAnswered, OK, ARecordCommit, ASendAnswer, "clear:request-timers", AArmSetup)
	t.add(rsp, LRequesting, ints(LPeerRequest, LPeerRestartOffer, LPeerOfferDup, LPeerAnswer, LPeerIce), Same, Drop)
	t.add(rsp, LRequesting, ints(LPeerRevealValid, LPeerRevealInvalid, LPeerRevealDup), LClosed, FailLink, ADestroy, "report:reveal-without-commit")
	t.add(rsp, LRequesting, ints(LRequestTick), Same, OK, ASendRequest)
	t.add(rsp, LRequesting, ints(LRequestTimeout), LClosed, FailLink, "report:request-timeout")
	t.add(rsp, LRequesting, ints(LLanesOpen, LLaneBad, LCaptureOverflow, LSetupNoProgress, LSetupHardCap,
		LKeyRevealTimeout, LHandshakeDeadline), Same, Ignore)
	unreachable(t, ini, LRequesting)

	// ---- Offering (initiator only)
	t.add(ini, LOffering, ints(LPeerAnswer), LRevealed, OK, ARecordCommit, ASendReveal)
	t.add(ini, LOffering, ints(LPeerRequest), Same, Ignore) // duplicate request joins the offer in flight
	t.add(ini, LOffering, ints(LPeerOffer, LPeerRestartOffer, LPeerOfferDup), Same, Drop)
	t.add(ini, LOffering, ints(LPeerRevealValid, LPeerRevealInvalid, LPeerRevealDup), LClosed, FailLink, ADestroy, "report:reveal-before-commit")
	t.add(ini, LOffering, ints(LPeerIce), Same, OK, AAddIce)
	t.add(ini, LOffering, ints(LLanesOpen, LLaneBad), Same, Ignore) // cannot open before an answer
	t.add(ini, LOffering, ints(LCaptureOverflow, LSetupNoProgress, LSetupHardCap, LHandshakeDeadline), LClosed, FailLink, ADestroy, "report:setup-failed")
	t.add(ini, LOffering, ints(LRequestTick, LRequestTimeout, LKeyRevealTimeout), Same, Ignore)
	unreachable(t, rsp, LOffering)

	// ---- Answered (responder) / Revealed (initiator): waiting for the peer's reveal
	t.add(rsp, LAnswered, ints(LPeerRevealValid), LKeyedLanesPending, OK, ASendReveal, ADerive)
	t.add(ini, LRevealed, ints(LPeerRevealValid), LKeyedLanesPending, OK, ADerive)
	for _, pr := range [][2]int{{LCResponder, LAnswered}, {LCInitiator, LRevealed}} {
		c, s := ints(pr[0]), pr[1]
		t.add(c, s, ints(LPeerRevealInvalid), LClosed, FailLink, ADestroy, "report:commit-mismatch")
		t.add(c, s, ints(LPeerRevealDup, LPeerRequest), Same, Ignore)
		t.add(c, s, ints(LPeerOffer, LPeerRestartOffer, LPeerOfferDup), Same, Drop)
		t.add(c, s, ints(LPeerIce), Same, OK, AAddIce)
		t.add(c, s, ints(LLanesOpen), LLanesKeyPending, OK, AClearSetup, ACapLanes, AArmKey)
		t.add(c, s, ints(LLaneBad), Same, OK, ACloseChan)
		t.add(c, s, ints(LCaptureOverflow, LSetupNoProgress, LSetupHardCap, LHandshakeDeadline), LClosed, FailLink, ADestroy, "report:setup-failed")
		t.add(c, s, ints(LRequestTick, LRequestTimeout, LKeyRevealTimeout), Same, Ignore)
	}
	t.add(rsp, LAnswered, ints(LPeerAnswer), Same, Drop)
	t.add(ini, LRevealed, ints(LPeerAnswer), Same, Ignore) // duplicate answer
	unreachable(t, ini, LAnswered)
	unreachable(t, rsp, LRevealed)

	// ---- KeyedLanesPending
	t.add(all, LKeyedLanesPending, ints(LLanesOpen), LOpen, OK, AClearSetup, AAttach, AAdmission)
	t.add(all, LKeyedLanesPending, ints(LPeerRevealDup, LPeerRequest, LPeerAnswer), Same, Ignore)
	t.add(all, LKeyedLanesPending, ints(LPeerRevealValid, LPeerRevealInvalid, LPeerOffer, LPeerRestartOffer, LPeerOfferDup), Same, Drop)
	t.add(all, LKeyedLanesPending, ints(LPeerIce), Same, OK, AAddIce)
	t.add(all, LKeyedLanesPending, ints(LLaneBad), Same, OK, ACloseChan)
	t.add(all, LKeyedLanesPending, ints(LCaptureOverflow, LSetupNoProgress, LSetupHardCap), LClosed, FailLink, ADestroy, "report:setup-failed")
	t.add(all, LKeyedLanesPending, ints(LRequestTick, LRequestTimeout, LKeyRevealTimeout, LHandshakeDeadline), Same, Ignore)

	// ---- LanesKeyPending: lanes captured; the key-reveal window runs from open
	t.add(rsp, LLanesKeyPending, ints(LPeerRevealValid), LOpen, OK, ASendReveal, ADerive, AAttach, AAdmission)
	t.add(ini, LLanesKeyPending, ints(LPeerRevealValid), LOpen, OK, ADerive, AAttach, AAdmission)
	t.add(all, LLanesKeyPending, ints(LPeerRevealInvalid), LClosed, FailLink, ADestroy, "report:commit-mismatch")
	t.add(all, LLanesKeyPending, ints(LPeerRevealDup, LPeerRequest, LLanesOpen), Same, Ignore)
	t.add(rsp, LLanesKeyPending, ints(LPeerAnswer), Same, Drop)
	t.add(ini, LLanesKeyPending, ints(LPeerAnswer), Same, Ignore)
	t.add(all, LLanesKeyPending, ints(LPeerOffer, LPeerRestartOffer, LPeerOfferDup), Same, Drop)
	t.add(all, LLanesKeyPending, ints(LPeerIce), Same, OK, AAddIce)
	t.add(all, LLanesKeyPending, ints(LLaneBad), Same, OK, ACloseChan)
	t.add(all, LLanesKeyPending, ints(LCaptureOverflow, LKeyRevealTimeout, LHandshakeDeadline), LClosed, FailLink, ADestroy, "report:key-reveal-failed")
	t.add(all, LLanesKeyPending, ints(LRequestTick, LRequestTimeout, LSetupNoProgress, LSetupHardCap), Same, Ignore)

	// ---- Open
	openCommon := func(s int) {
		t.add(all, s, ints(LStart, LPeerRequest, LPeerRevealDup, LPeerBusy, LCapsRevoked, LLanesOpen, LCaptureOverflow,
			LRequestTick, LRequestTimeout, LSetupNoProgress, LKeyRevealTimeout, LHandshakeDeadline, LPeerGone), Same, Ignore)
		t.add(all, s, ints(LPeerOffer, LPeerOfferDup, LPeerRevealValid, LPeerRevealInvalid, LResume), Same, Drop)
		t.add(all, s, ints(LPeerIce), Same, OK, AAddIce)
		t.add(all, s, ints(LOtherPeer), Same, OK, ASendBusy)
		t.add(all, s, ints(LLaneBad), Same, OK, ACloseChan)
		t.add(all, s, ints(LLeaveValid), LClosed, OK, ADestroy, "report:peer-ended-session")
		t.add(all, s, ints(LLeaveInvalid), Same, Drop, ALeaveBudget)
		t.add(all, s, ints(LTransportLost), LClosed, FailLink, ADestroy, "report:connection-lost(no-recovery)")
		t.add(all, s, ints(LLocalClose), LClosed, OK, ASendLeave, ADestroy)
		t.add(all, s, ints(LIdleTimeout), LClosed, OK, ADestroy, "report:idle-closed")
		t.add(all, s, ints(LRelayDeadline), LClosed, OK, ADestroy, "report:relay-credential-ended")
	}
	openCommon(LOpen)
	t.add(rsp, LOpen, ints(LPeerRestartOffer), Same, OK, AApplyRestart)
	t.add(ini, LOpen, ints(LPeerRestartOffer), Same, Drop)
	t.add(all, LOpen, ints(LPeerAnswer), Same, Drop)
	t.add(ini, LOpen, ints(LDisconnected), LRestarting, OK, ARestartOffer)
	t.add(rsp, LOpen, ints(LDisconnected), Same, OK, "await:initiator-restart")
	t.add(all, LOpen, ints(LReconnected), Same, Ignore)
	t.add(all, LOpen, ints(LSetupHardCap), Same, Ignore)

	// ---- Restarting (initiator only; one restart per link)
	openCommon(LRestarting)
	t.add(ini, LRestarting, ints(LPeerAnswer), LOpen, OK, AApplyAnswer)
	t.add(ini, LRestarting, ints(LReconnected), LOpen, OK)
	t.add(ini, LRestarting, ints(LPeerRestartOffer), Same, Drop)
	t.add(ini, LRestarting, ints(LDisconnected), Same, Ignore) // only ONE restart
	t.add(ini, LRestarting, ints(LSetupHardCap), LClosed, FailLink, ADestroy, "report:restart-failed")
	// Responder never enters Restarting.
	t.add(rsp, LRestarting, ints(LPeerRestartOffer, LPeerAnswer, LDisconnected, LReconnected, LSetupHardCap), Same, Ignore)

	// ---- Closed: absorbing. Late callbacks of a destroyed link never act.
	for e := range t.Events {
		res := Ignore
		if e == LLeaveValid || e == LLeaveInvalid || e == LResume || e == LPeerOffer || e == LPeerRestartOffer {
			res = Drop
		}
		t.add(all, LClosed, ints(e), Same, res)
	}
	return t
}

// unreachable declares every event Ignore for a (class,state) pair the role can
// never occupy, so totality stays explicit rather than defaulted.
func unreachable(t *Table, class []int, s int) {
	for e := range t.Events {
		if _, ok := t.Lookup(class[0], s, e); ok {
			continue
		}
		t.add(class, s, ints(e), Same, Ignore, "unreachable:role")
	}
}

// ---------------------------------------------------------------- inbound link signals

// linkSig is a link-generation signal from the bound peer, classified against
// the current handshake state into exactly one link event, or none.
type linkSig int

const (
	lsNone linkSig = iota // not a frame this machine acts on: dropped before the table, silently
	lsRequest
	lsOffer
	lsAnswer
	lsReveal
	lsIce
	lsBusy
	lsLeave
)

// classifyLinkShape reads only the SHAPE of a link-generation signal (link
// §4.2). The leave allow-list runs first: a frame carrying `leave` is either an
// exact leave or nothing, so a smuggled commit/busy/sdp cannot ride it (§4.6).
func classifyLinkShape(in signalInfo) linkSig {
	if in.fields == nil {
		return lsNone
	}
	if _, ok := linkwire.LeaveAuth(in.sig); ok {
		return lsLeave
	}
	if _, ok := in.fields["leave"]; ok {
		return lsLeave // wrong shape: refused as an invalid leave, never re-read as anything else
	}
	if linkwire.IsLinkRequest(in.sig) {
		return lsRequest
	}
	if linkwire.IsLinkOffer(in.sig) {
		return lsOffer
	}
	if sdp, ok := in.fields["sdp"]; ok {
		var d struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(sdp, &d) == nil && d.Type == "answer" {
			return lsAnswer
		}
		return lsNone
	}
	if _, ok := in.fields["reveal"]; ok {
		return lsReveal
	}
	if _, ok := in.fields["ice"]; ok {
		return lsIce
	}
	if string(in.fields["busy"]) == "true" {
		return lsBusy
	}
	return lsNone
}

// signalCommit reads the `commit` an offer or answer carries: standard base64
// of exactly linkcrypto.CommitSize bytes.
func signalCommit(in signalInfo) ([]byte, bool) {
	var c string
	if json.Unmarshal(in.fields["commit"], &c) != nil {
		return nil, false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(c)
	if err != nil || len(b) != linkcrypto.CommitSize {
		return nil, false
	}
	return b, true
}

// signalReveal reads {"reveal":{"key":<b64 32>,"nonce":<b64 32>}}.
func signalReveal(in signalInfo) (pub, nonce []byte, ok bool) {
	var r struct {
		Key   *string `json:"key"`
		Nonce *string `json:"nonce"`
	}
	if json.Unmarshal(in.fields["reveal"], &r) != nil || r.Key == nil || r.Nonce == nil {
		return nil, nil, false
	}
	pub, err1 := base64.StdEncoding.Strict().DecodeString(*r.Key)
	nonce, err2 := base64.StdEncoding.Strict().DecodeString(*r.Nonce)
	if err1 != nil || err2 != nil || len(pub) != linkcrypto.PublicKeySize || len(nonce) != linkcrypto.CommitNonceSize {
		return nil, nil, false
	}
	return pub, nonce, true
}

// revealFrame is {"link":true,"reveal":{"key":<b64>,"nonce":<b64>}}. Both
// values are public by design once revealed.
func revealFrame(pub, nonce []byte) []byte {
	b, _ := json.Marshal(struct {
		Link   bool `json:"link"`
		Reveal struct {
			Key   string `json:"key"`
			Nonce string `json:"nonce"`
		} `json:"reveal"`
	}{Link: true, Reveal: struct {
		Key   string `json:"key"`
		Nonce string `json:"nonce"`
	}{base64.StdEncoding.EncodeToString(pub), base64.StdEncoding.EncodeToString(nonce)}})
	return b
}
