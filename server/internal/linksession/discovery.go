package linksession

import (
	"encoding/json"

	"github.com/relayium/relayium/internal/linkwire"
)

// Discovery decides, per pairing-code room, which wire this session speaks with
// its one peer: link/1, or the legacy CLI commit/reveal handshake. It never
// uses elapsed time to CHOOSE a wire. The only inputs that choose are:
//
//   - the server's additive roster hint (welcome echoes it; the peer's roster
//     entry carries "link/1" when that peer promises to accept a link hello as
//     its first inbound frame), and
//   - the CONTENT of the peer's first frame, classified by ClassifySignal.
//
// This works because every deployed non-hinting peer speaks first: an old CLI
// sends {kind:"commit"} the moment its Join returns, and every shipped app
// sends its capability hello on roster gain. Two NEW CLIs, the only pair that
// would both wait, find each other through the roster hint instead. Deadline
// exists only to END a session whose peer never spoke; no row lets a timer
// select link or legacy (property P1).

// Discovery classes: what the local command can fall back to.
const (
	DCPair   = iota // `relayium pair`: link/1 only; cannot answer a legacy handshake (no preselected mode)
	DCLegacy        // `send` / `receive` / `text`: may complete the legacy handshake with its preselected mode
)

// Discovery states.
const (
	DJoining  = iota // welcome + peer roster not both known yet; peer signals are CAPTURED (bounded)
	DPassive         // server hints supported, peer carries none: old CLI or an app; wait for its first frame
	DGreeting        // we announced link/1 (bounded cadence); waiting for the peer's hello or link frame
	DLink            // handed to link establishment; link signals are fed there
	DLegacy          // handed to the legacy commit/reveal handshake
	DFailed          // absorbing
)

// Discovery events. Inbound signals are classified by ClassifySignal BEFORE
// this table runs; roster facts come from RoomView, timers from the clock.
const (
	DPeerHinted      = iota // welcome echoed hint support AND the peer's roster entry lists exactly "link/1"
	DPeerUnhinted           // welcome echoed support; peer entry has no "link/1"
	DServerNoHints          // welcome has no echo: server predates roster hints (e.g. old self-hosted)
	DSigLegacyCommit        // object with top-level string kind == "commit"
	DSigLegacyOther         // object with top-level string kind != "commit"
	DSigHelloLink           // {"caps":[...]} snapshot containing exactly "link/1"
	DSigHelloNoLink         // {"caps":[...]} snapshot without "link/1" ([] / ["text/1"] / ["link/2"])
	DSigLinkOffer           // link generation with an SDP offer (proven link, link §1.5)
	DSigLinkOther           // any other link-generation frame (request, answer, ice, reveal, busy, leave)
	DSigResume              // resume generation (first stage refuses recovery, link §8.4)
	DSigAppLegacyGen        // untagged file / text generation SDP: an app predating link/1
	DSigIgnorable           // none of the above (relayRtt, rename, not-a-hello, not JSON)
	DRetryTick              // bounded hello cadence tick (3 attempts, 1.5 s)
	DPeerGone               // the peer left the roster / server "left"
	DCaptureOverflow        // pre-classification capture exceeded 64 frames or 256 KiB
	DDeadline               // pairing wait bound expired (never selects a wire)
)

// Discovery actions.
const (
	AAnnounce      = "send:hello(link/1)+arm:cadence" // Web-conforming 3 x 1.5 s, retired on hearing
	AHelloOnce     = "send:hello(link/1)-once"        // one reply to a proactive non-hinting peer; never re-armed
	ARetryHello    = "send:hello-if-owed"
	ARetire        = "retire:announcer"
	ALegacyCommit  = "send:legacy-commit(mode)"
	ALegacyAfter   = "legacy:continue-after-peer-commit"
	ALegacyUpgrade = `send:{"kind":"pair-needs-newer-relayium"}` // old CLI exits at once quoting this kind
	AReplay        = "replay:captured"
	ACapture       = "capture:signal"
	ARecordCaps    = "record:caps-snapshot"
	ARecordProven  = "record:proven-link"
	AFeedLink      = "feed:establishment"
	AFeedLegacy    = "feed:legacy-handshake"
	AResetEpoch    = "reset:room-epoch"
	RPeerOldCLI    = "report:peer-is-older-cli"
	RPeerNoLink    = "report:peer-app-cannot-link"
	RPeerAppOld    = "report:peer-app-too-old"
	RProtocol      = "report:protocol-violation"
	RSilent        = "report:peer-never-spoke"
	RNoPeer        = "report:no-peer-joined"
	RCapture       = "report:capture-overflow"
	RLegacyAfterHi = "report:peer-used-legacy-after-our-hello"
)

// DiscoveryTable is the discovery machine.
var DiscoveryTable = buildDiscovery()

func buildDiscovery() *Table {
	t := newTable("discovery",
		[]string{"pair", "send|receive|text"},
		[]string{"Joining", "Passive", "Greeting", "Link", "Legacy", "Failed"},
		[]string{"PeerHinted", "PeerUnhinted", "ServerNoHints", "SigLegacyCommit", "SigLegacyOther",
			"SigHelloLink", "SigHelloNoLink", "SigLinkOffer", "SigLinkOther", "SigResume",
			"SigAppLegacyGen", "SigIgnorable", "RetryTick", "PeerGone", "CaptureOverflow", "Deadline"})
	all := t.all()
	pair, legacy := ints(DCPair), ints(DCLegacy)
	sigs := ints(DSigLegacyCommit, DSigLegacyOther, DSigHelloLink, DSigHelloNoLink, DSigLinkOffer,
		DSigLinkOther, DSigResume, DSigAppLegacyGen, DSigIgnorable)

	// Joining: nothing is interpreted until both welcome and roster are known.
	// An old CLI's commit can beat our own roster, so signals are captured.
	t.add(all, DJoining, ints(DPeerHinted), DGreeting, OK, AAnnounce, AReplay)
	t.add(all, DJoining, ints(DPeerUnhinted), DPassive, OK, AReplay)
	t.add(pair, DJoining, ints(DServerNoHints), DGreeting, OK, AAnnounce, AReplay)
	t.add(legacy, DJoining, ints(DServerNoHints), DLegacy, OK, ALegacyCommit, AReplay)
	t.add(all, DJoining, sigs, Same, Capture, ACapture)
	t.add(all, DJoining, ints(DRetryTick, DPeerGone), Same, Ignore)
	t.add(all, DJoining, ints(DCaptureOverflow), DFailed, FailSess, RCapture)
	t.add(all, DJoining, ints(DDeadline), DFailed, FailSess, RNoPeer)

	// Passive: the peer is an old CLI or an app, and both speak first.
	t.add(pair, DPassive, ints(DSigLegacyCommit), DFailed, FailSess, ALegacyUpgrade, RPeerOldCLI)
	t.add(legacy, DPassive, ints(DSigLegacyCommit), DLegacy, OK, ALegacyCommit, ALegacyAfter)
	t.add(all, DPassive, ints(DSigLegacyOther), DFailed, FailSess, RProtocol)
	t.add(all, DPassive, ints(DSigHelloLink), DLink, OK, ARecordCaps, AHelloOnce)
	t.add(all, DPassive, ints(DSigHelloNoLink), DFailed, FailSess, ARecordCaps, RPeerNoLink)
	t.add(all, DPassive, ints(DSigLinkOffer, DSigLinkOther), DLink, OK, ARecordProven, AHelloOnce, AFeedLink)
	t.add(all, DPassive, ints(DSigResume), Same, Drop)
	t.add(all, DPassive, ints(DSigAppLegacyGen), DFailed, FailSess, RPeerAppOld)
	t.add(all, DPassive, ints(DSigIgnorable, DRetryTick, DCaptureOverflow), Same, Ignore)
	t.add(all, DPassive, ints(DPeerGone), DJoining, OK, AResetEpoch)
	t.add(all, DPassive, ints(DDeadline), DFailed, FailSess, RSilent)

	// Greeting: our hello is out. A legacy frame now means the peer is (or chose
	// to be) a legacy CLI; our hello has already made an old CLI exit.
	t.add(all, DGreeting, ints(DSigLegacyCommit), DFailed, FailSess, RLegacyAfterHi)
	t.add(all, DGreeting, ints(DSigLegacyOther), DFailed, FailSess, RProtocol)
	t.add(all, DGreeting, ints(DSigHelloLink), DLink, OK, ARecordCaps, ARetire)
	t.add(all, DGreeting, ints(DSigHelloNoLink), DFailed, FailSess, ARecordCaps, ARetire, RPeerNoLink)
	t.add(all, DGreeting, ints(DSigLinkOffer, DSigLinkOther), DLink, OK, ARecordProven, ARetire, AFeedLink)
	t.add(all, DGreeting, ints(DSigResume), Same, Drop)
	t.add(all, DGreeting, ints(DSigAppLegacyGen), DFailed, FailSess, RPeerAppOld)
	t.add(all, DGreeting, ints(DSigIgnorable, DCaptureOverflow), Same, Ignore)
	t.add(all, DGreeting, ints(DRetryTick), Same, OK, ARetryHello)
	t.add(all, DGreeting, ints(DPeerGone), DJoining, OK, AResetEpoch)
	t.add(all, DGreeting, ints(DDeadline), DFailed, FailSess, RSilent)

	// Link: discovery is done; link-generation traffic belongs to establishment,
	// which owns revocation (a pre-open [] snapshot aborts it) and departure.
	//
	// Divergence from the prototype draft (D1): a legacy `kind` frame after the
	// wire was chosen is dropped rather than ending the session. Signalling is
	// unauthenticated: a relay-injected frame must not end an authenticated
	// link, and before the link opens the establishment deadlines bound a peer
	// that keeps talking legacy.
	t.add(all, DLink, ints(DSigLegacyCommit, DSigLegacyOther), Same, Drop)
	t.add(all, DLink, ints(DSigHelloLink), Same, Ignore, ARecordCaps)
	t.add(all, DLink, ints(DSigHelloNoLink), Same, OK, ARecordCaps, AFeedLink)
	t.add(all, DLink, ints(DSigLinkOffer, DSigLinkOther, DSigResume, DPeerGone), Same, OK, AFeedLink)
	t.add(all, DLink, ints(DSigAppLegacyGen), Same, Drop)
	t.add(all, DLink, ints(DSigIgnorable, DRetryTick, DCaptureOverflow, DDeadline), Same, Ignore)
	t.add(all, DLink, ints(DPeerHinted, DPeerUnhinted, DServerNoHints), Same, Ignore)

	// Legacy: the existing rzvous handshake owns everything; unchanged semantics.
	t.add(all, DLegacy, sigs, Same, OK, AFeedLegacy)
	t.add(all, DLegacy, ints(DPeerGone), Same, OK, AFeedLegacy)
	t.add(all, DLegacy, ints(DRetryTick, DCaptureOverflow, DDeadline), Same, Ignore)
	t.add(all, DLegacy, ints(DPeerHinted, DPeerUnhinted, DServerNoHints), Same, Ignore)

	// Roster facts arriving again after classification change nothing: the
	// choice was made from the first complete view and is never re-litigated.
	t.add(all, DPassive, ints(DPeerHinted, DPeerUnhinted, DServerNoHints), Same, Ignore)
	t.add(all, DGreeting, ints(DPeerHinted, DPeerUnhinted, DServerNoHints), Same, Ignore)

	// Failed is absorbing.
	for e := range t.Events {
		t.add(all, DFailed, ints(e), Same, Ignore)
	}
	return t
}

// signalInfo is one inbound signal after classification. The raw bytes are
// kept so that the transport can apply SDP/ICE exactly as received.
type signalInfo struct {
	event  int // discovery event (DSig*)
	raw    []byte
	sig    linkwire.Signal
	fields map[string]json.RawMessage // nil unless the payload is a JSON object
	caps   []string                   // hello snapshot when event is DSigHello*
}

// ClassifySignal maps one peer-authored signalling payload onto a discovery
// event. It is total and never panics: bytes that are not acceptable JSON, or
// not an object, are DSigIgnorable.
//
// Precedence: a top-level string `kind` first (every shipped app latches
// "legacy CLI" on it, so it must be recognised before anything else), then the
// generation tags in link §4.1 order (resume, link), then a capability hello,
// then an untagged SDP from an app that predates link/1.
func ClassifySignal(raw []byte) int { return classifySignal(raw).event }

func classifySignal(raw []byte) signalInfo {
	in := signalInfo{event: DSigIgnorable, raw: raw}
	s, err := linkwire.ParseSignal(raw)
	if err != nil || !s.IsObject() {
		return in
	}
	in.sig = s
	// ParseSignal accepted the bytes as a JSON object, so this cannot fail;
	// encoding/json also keeps the LAST duplicated key, as ParseSignal does.
	if json.Unmarshal(raw, &in.fields) != nil {
		in.fields = nil
		return in
	}
	if k, ok := in.fields["kind"]; ok && len(k) > 0 && k[0] == '"' {
		var kind string
		if json.Unmarshal(k, &kind) == nil {
			if kind == "commit" {
				in.event = DSigLegacyCommit
			} else {
				in.event = DSigLegacyOther
			}
			return in
		}
	}
	switch linkwire.SignalGeneration(s) {
	case linkwire.GenerationResume:
		in.event = DSigResume
		return in
	case linkwire.GenerationLink:
		if linkwire.IsLinkOffer(s) {
			in.event = DSigLinkOffer
		} else {
			in.event = DSigLinkOther
		}
		return in
	}
	if caps, ok := linkwire.ParseHello(s); ok {
		in.caps = caps
		if linkwire.CapsIncludeLink(caps) {
			in.event = DSigHelloLink
		} else {
			in.event = DSigHelloNoLink
		}
		return in
	}
	if v, ok := in.fields["sdp"]; ok && string(v) != "null" {
		in.event = DSigAppLegacyGen
	}
	return in
}

// Frames discovery sends. None but the upgrade notice carries a top-level
// `kind`, and that one is only ever sent to a peer proven to be an old CLI.
var (
	helloFrame   = []byte(`{"caps":["link/1"]}`)
	upgradeFrame = []byte(`{"kind":"pair-needs-newer-relayium"}`)
)
