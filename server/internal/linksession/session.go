package linksession

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"time"

	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linkwire"
)

// ---------------------------------------------------------------- bounds (A08-DESIGN §10)

// Every bound the session enforces. Values that link/1 already names come
// from linkwire so the two can never drift.
const (
	CaptureMaxFrames  = linkwire.HeldSignalMax   // early-signal capture, frames
	CaptureMaxBytes   = linkwire.CaptureMaxBytes // early-signal capture AND pre-attach lane capture, bytes
	DiscoveryWait     = 30 * time.Second         // first-frame wait after the room view is complete (ends only)
	HelloInterval     = linkwire.CapsRetryIntervalMs * time.Millisecond
	HelloAttempts     = linkwire.CapsAnnounceAttempts
	DefaultJoinWait   = 10 * time.Minute // waiting for a peer to join the room at all
	LinkRequestRetry  = linkwire.LinkRequestRetryMs * time.Millisecond
	LinkRequestTotal  = linkwire.LinkRequestMs * time.Millisecond
	SetupNoProgress   = linkwire.NoProgressMs * time.Millisecond
	SetupHardCap      = linkwire.SetupHardCapMs * time.Millisecond
	KeyRevealWait     = linkwire.KeyRevealMs * time.Millisecond
	HandshakeDeadline = linkwire.HandshakeDeadlineMs * time.Millisecond
	LeaveMaxAttempts  = linkwire.LeaveMaxAttempts
	MaxICEProgress    = linkwire.MaxCandidateProgress
	LinkIdle          = 10 * time.Minute
	VerifyWait        = LinkIdle // --verify answer, bounded by link idle
	FileConsent       = 10 * time.Minute
	FileDrainWait     = 30 * time.Second
	ReceiveStall      = 60 * time.Second
	SendBufferStall   = 60 * time.Second
	SendProgressStall = 150 * time.Second
	CompleteStall     = 150 * time.Second
	FlowWindow        = linkwire.FlowWindowBytes
	AckInterval       = linkwire.FlowAckIntervalBytes
	TextConsent       = 10 * time.Minute
	TextEndAckWait    = 30 * time.Second
	TextIdle          = linkwire.TextIdleMs * time.Millisecond
	TextRateBurst     = linkwire.TextRateBurst
	TextRatePerSecond = linkwire.TextRatePerSecond
	TextSessionMsgs   = linkwire.TextSessionMaxMessages
	TextSessionBytes  = linkwire.TextSessionMaxBytes
	TextSendBufferMax = linkwire.TextSendBufferMax
	// DefaultMaxFrameBytes is the per-message ceiling the CLI transport sets
	// (A09: SetSCTPMaxMessageSize(262144)); never the negotiated 1 GiB.
	DefaultMaxFrameBytes = 262144
)

// ---------------------------------------------------------------- command, policy, admission

// Cmd is the local command that opened the pairing session.
type Cmd int

const (
	CmdPair Cmd = iota
	CmdSend
	CmdReceive
	CmdText
)

// DiscoveryClass is the discovery table class of the command.
func (c Cmd) DiscoveryClass() int {
	if c == CmdPair {
		return DCPair
	}
	return DCLegacy
}

// Policy is what the LOCAL user authorised for one kind of inbound content.
// It is consulted only after admission; admission alone authorises nothing.
type Policy int

const (
	PolicyPrompt   Policy = iota // ask the user each time (interactive `pair`)
	PolicyAutoOnce               // the command line itself consented to exactly one batch (`receive <code> [dir]`)
	PolicyAutoAll                // the command line consented to every item of this kind (`text` for text)
	PolicyReject                 // this command does not receive this kind (`send` for files, `receive` for text)
)

// Authz is the per-kind authorisation of one command.
type Authz struct{ Files, Text Policy }

// AuthzFor pins the non-interactive entry points to their existing meaning.
func AuthzFor(c Cmd) Authz {
	switch c {
	case CmdSend:
		return Authz{Files: PolicyReject, Text: PolicyReject}
	case CmdReceive:
		return Authz{Files: PolicyAutoOnce, Text: PolicyReject}
	case CmdText:
		return Authz{Files: PolicyReject, Text: PolicyAutoAll}
	default:
		return Authz{Files: PolicyPrompt, Text: PolicyAutoAll}
	}
}

// Admission is whether the HUMAN side is satisfied with a keyed, open link.
type Admission int

const (
	AdmWaitingLink Admission = iota
	AdmPendingSAS            // --verify: SAS shown, local confirmation outstanding; NO consent byte may leave
	AdmAdmitted
	AdmRefused // SAS rejected or never confirmed: nothing is consented, the link ends
)

// Epoch fences every input to the exact room, link and transport that
// produced it. A mismatch is dropped (ErrStale) before any machine sees it.
// Closing a link bumps Link, so late callbacks of a dead link never act.
type Epoch struct{ Room, Link, Transport uint64 }

// Clock is the injected time source. The session never reads wall time.
type Clock interface{ Now() time.Time }

// Config configures one session.
type Config struct {
	Cmd           Cmd
	Verify        bool          // --verify: admission waits for the SAS to be confirmed
	Clock         Clock         // required
	Rand          io.Reader     // key and nonce source; nil means crypto/rand
	MaxFrameBytes int64         // per-message ceiling; 0 means DefaultMaxFrameBytes
	JoinWait      time.Duration // waiting for any peer to join; 0 means DefaultJoinWait
}

// RoomView is the first complete view of the pairing room: our id from the
// welcome, whether the welcome echoed the roster hint, and the peer.
type RoomView struct {
	SelfID      string
	PeerID      string
	ServerHints bool // the welcome echoed "proto":["link/1"]
	PeerHinted  bool // the peer's roster entry lists "link/1"
}

// Errors returned for refused inputs. None of them changes any state.
var (
	ErrStale            = errors.New("linksession: stale input dropped")
	ErrEnded            = errors.New("linksession: session has ended")
	ErrNotOpen          = errors.New("linksession: link is not open")
	ErrNotAdmitted      = errors.New("linksession: link is not admitted")
	ErrStalePrompt      = errors.New("linksession: that prompt is no longer current")
	ErrNotAuthorised    = errors.New("linksession: this command does not accept that interactively")
	ErrWrongState       = errors.New("linksession: not valid in the current lane state")
	ErrWindowFull       = errors.New("linksession: flow window full; wait for an ACK")
	ErrBatchOverrun     = errors.New("linksession: more bytes than the manifest declared")
	ErrDurable          = errors.New("linksession: durable count out of range")
	ErrTextTooLong      = errors.New("linksession: message too long for this connection")
	ErrTextBackpressure = errors.New("linksession: text send buffer full")
	ErrBadRoomView      = errors.New("linksession: invalid room view")
)

// ---------------------------------------------------------------- effects

// EffectKind is what the caller must do. Effects of one call are ordered and
// MUST be executed in order: e.g. EffAttachSink before the EffSendFile that
// carries ACCEPT, EffAttachLanes before the replayed frames' effects.
type EffectKind int

const (
	EffSendSignal        EffectKind = iota + 1 // Bytes to peer To, exactly
	EffBeginLegacy                             // hand the room to the legacy handshake; Bytes = peer's first frame (nil: we speak first)
	EffLegacyFrame                             // Bytes: a later signal belonging to the legacy handshake
	EffCreateChannels                          // create both labelled channels in tuple order
	EffSendOffer                               // create+set an offer; send {link,sdp,commit:Commit,caps:Caps}
	EffSendAnswer                              // apply offer Bytes; answer; send {link,sdp,commit:Commit,caps:Caps}
	EffApplyAnswer                             // apply answer Bytes
	EffAddICE                                  // add the candidate in Bytes
	EffICERestart                              // send one ICE-restart offer with Commit and Caps
	EffApplyRestartOffer                       // apply restart offer Bytes and answer it
	EffCloseChannel                            // close channel Label only
	EffCloseTransport                          // close the peer connection
	EffAttachLanes                             // attach both lane handlers (captured frames follow)
	EffSASReady                                // Session.SAS() is available: show it
	EffAdmitted                                // the link is admitted
	EffSendFile                                // Bytes on the file lane, in order
	EffSendText                                // Bytes on the text lane, in order
	EffPromptFiles                             // ask the user about Files (Prompt id)
	EffPromptWithdrawn                         // prompt Prompt is gone; its answer is now meaningless
	EffAttachSink                              // create the no-clobber sink for Files BEFORE the following ACCEPT
	EffWriteChunk                              // write Bytes to file Index of batch Prompt; report durability
	EffFileVerified                            // file Index's chain verified (success still needs durability)
	EffDiscardPartial                          // delete exactly what batch Prompt created
	EffSendData                                // outbound batch consented: start SendChunk
	EffPromptText                              // ask the user about a conversation (Prompt id)
	EffTextOpened                              // conversation open in both directions
	EffDeliverText                             // show Text
	EffReport                                  // user-visible outcome Code on Lane
	EffLinkClosed                              // the link ended with Code; keys are destroyed
	EffSessionEnded                            // the session ended with Code
)

var effectNames = [...]string{"", "SendSignal", "BeginLegacy", "LegacyFrame", "CreateChannels", "SendOffer",
	"SendAnswer", "ApplyAnswer", "AddICE", "ICERestart", "ApplyRestartOffer", "CloseChannel", "CloseTransport",
	"AttachLanes", "SASReady", "Admitted", "SendFile", "SendText", "PromptFiles", "PromptWithdrawn",
	"AttachSink", "WriteChunk", "FileVerified", "DiscardPartial", "SendData", "PromptText", "TextOpened",
	"DeliverText", "Report", "LinkClosed", "SessionEnded"}

func (k EffectKind) String() string {
	if int(k) > 0 && int(k) < len(effectNames) {
		return effectNames[k]
	}
	return "EffectKind(?)"
}

// Effect is one ordered instruction to the caller. It never carries a key.
type Effect struct {
	Kind   EffectKind
	To     string
	Bytes  []byte
	Commit string
	Caps   []string
	Label  string
	Lane   string
	Code   string
	Prompt uint64
	Index  int
	Files  []linkwire.FileMeta
	Text   string
}

// ---------------------------------------------------------------- timers

type timerID int

const (
	// Order is the tie-break when several fall due at the same instant: a
	// bound that ENDS something precedes a retry it would make pointless.
	tJoin timerID = iota
	tDisc
	tHello
	tReqTotal
	tReqRetry
	tNoProgress
	tHardCap
	tKeyReveal
	tHandshake
	tVerify
	tLinkIdle
	tRelay
	tFileConsent
	tDrain
	tRecvStall
	tSendStall
	tSendProgress
	tCompleteStall
	tTextConsent
	tEndAck
	tTextIdle
	numTimers
)

type timer struct {
	armed bool
	at    time.Time
}

// ---------------------------------------------------------------- session

type tables struct{ disc, link, file, text *Table }

var defaultTables = tables{DiscoveryTable, LinkTable, FileTable, TextTable}

type capturedSignal struct {
	from string
	raw  []byte
}

type laneFrame struct {
	text bool
	raw  []byte
}

// fileIn is the inbound batch being prompted, received or drained.
type fileIn struct {
	files     []linkwire.FileMeta
	total     uint64
	idx       int    // current file
	inFile    uint64 // bytes of the current file received
	received  uint64
	verified  int
	durable   uint64
	acked     uint64
	drainLeft uint64
}

// fileOut is the outbound batch being offered or sent.
type fileOut struct {
	files    []linkwire.FileMeta
	total    uint64
	emitted  uint64
	acked    uint64
	fileIdx  int    // file being sent
	inFile   uint64 // bytes of it sealed
	requeued bool
}

type queuedBatch struct {
	files    []linkwire.FileMeta
	requeued bool
}

// Session composes discovery, link, admission and both lanes for ONE peer.
// It is not safe for concurrent use: the caller serialises every call.
type Session struct {
	cfg   Config
	clock Clock
	rnd   io.Reader
	tabs  tables
	authz Authz

	epoch        Epoch
	selfID, peer string
	ended        bool
	endCode      string

	disc                *Machine
	linkM, fileM, textM *Machine
	lk                  *Link
	caps                *linkwire.PeerCaps

	captured      []capturedSignal
	capturedBytes int
	helloOwed     int

	adm      Admission
	onceUsed bool

	// establishment
	offerRaw     []byte
	cur          *signalInfo // the signal whose row is executing
	pending      *pendingKeys
	iceProgress  int
	progressKeys map[string]bool
	leaveSpent   int
	laneCap      []laneFrame
	laneCapBytes int
	otherPeer    string
	badLabel     string

	// outbound file offer in progress
	pendingManifest [][]byte
	offering        []linkwire.FileMeta
	nextRequeued    bool
	inputErr        error

	// lanes
	fin        fileIn
	fout       fileOut
	queue      []queuedBatch
	filePrompt uint64
	textPrompt uint64
	textMsgs   int
	textBytes  int
	tokens     float64
	tokensAt   time.Time
	pendingAck float64

	timers [numTimers]timer
	out    []Effect

	// discWait is DiscoveryWait; only negative-control tests shorten it.
	discWait time.Duration

	// contentFeeds records the file-lane state every time a protected content
	// frame reached the AEAD receiver; tests and fuzzers assert it only ever
	// holds InRecv/InDrain (P3 at run time, not only over the table).
	contentFeeds []int
}

// NewSession starts a session in discovery Joining.
func NewSession(cfg Config) (*Session, error) { return newSession(cfg, defaultTables) }

func newSession(cfg Config, tabs tables) (*Session, error) {
	if cfg.Clock == nil {
		return nil, errors.New("linksession: Config.Clock is required")
	}
	if cfg.MaxFrameBytes == 0 {
		cfg.MaxFrameBytes = DefaultMaxFrameBytes
	}
	if _, err := linkwire.PiecePlainBytes(cfg.MaxFrameBytes); err != nil {
		return nil, err
	}
	if cfg.JoinWait <= 0 {
		cfg.JoinWait = DefaultJoinWait
	}
	s := &Session{cfg: cfg, clock: cfg.Clock, rnd: cfg.Rand, tabs: tabs, authz: AuthzFor(cfg.Cmd),
		caps: linkwire.NewPeerCaps()}
	if s.rnd == nil {
		s.rnd = rand.Reader
	}
	s.epoch.Room = 1
	s.discWait = DiscoveryWait
	s.disc = NewMachine(tabs.disc, cfg.Cmd.DiscoveryClass(), DJoining)
	s.arm(tJoin, cfg.JoinWait)
	return s, nil
}

// Epoch is the current fence. Transport callbacks must carry the epoch that
// was current when their transport was created.
func (s *Session) Epoch() Epoch { return s.epoch }

// Ended reports whether the session is over, and why.
func (s *Session) Ended() (bool, string) { return s.ended, s.endCode }

// Admission is the current admission state.
func (s *Session) Admission() Admission { return s.adm }

// SAS is the six-digit verification code once derived, else "".
func (s *Session) SAS() string {
	if s.lk == nil {
		return ""
	}
	return s.lk.sas
}

// States names the current state of each machine ("" when absent).
func (s *Session) States() (disc, link, file, text string) {
	name := func(m *Machine) string {
		if m == nil {
			return ""
		}
		return m.StateName()
	}
	return name(s.disc), name(s.linkM), name(s.fileM), name(s.textM)
}

func (s *Session) emit(e Effect) { s.out = append(s.out, e) }

func (s *Session) report(lane, code string) {
	if code != "" {
		s.emit(Effect{Kind: EffReport, Lane: lane, Code: code})
	}
}

// run wraps one input: it fires overdue timers, applies the input, applies
// the authorisation policies, drops timers whose state has gone, and hands
// the ordered effects back. Effects are returned EVEN WITH an error (e.g. a
// deadline that ended the session before the input could apply) and must be
// executed regardless.
func (s *Session) run(f func() error) ([]Effect, error) {
	if s.ended {
		return nil, ErrEnded
	}
	s.out = nil
	// Every input first fires the timers already due: a deadline is a fact
	// of the clock, not of when the caller last ticked. Without this, an
	// ACCEPT clicked after the consent window but before the next Tick
	// would still be honoured.
	s.fireDue()
	var err error
	if !s.ended {
		err = f()
	} else {
		err = ErrEnded
	}
	s.settle()
	out := s.out
	s.out = nil
	return out, err
}

func (s *Session) settle() {
	for i := 0; i < 8; i++ {
		before := len(s.out)
		s.applyPolicies()
		s.drainQueue()
		if len(s.out) == before {
			break
		}
	}
	s.pruneTimers()
}

func (s *Session) endSession(code string) {
	if s.ended {
		return
	}
	s.ended = true
	s.endCode = code
	s.timers = [numTimers]timer{}
	s.emit(Effect{Kind: EffSessionEnded, Code: code})
}

// ---------------------------------------------------------------- room + signals

// Room delivers the first complete room view (welcome + roster).
func (s *Session) Room(ep Epoch, v RoomView) ([]Effect, error) {
	return s.run(func() error {
		if ep.Room != s.epoch.Room {
			return ErrStale
		}
		if s.disc.State == DJoining {
			if v.SelfID == "" || v.PeerID == "" || v.SelfID == v.PeerID {
				return ErrBadRoomView
			}
			s.selfID, s.peer = v.SelfID, v.PeerID
		}
		ev := DPeerUnhinted
		switch {
		case !v.ServerHints:
			ev = DServerNoHints
		case v.PeerHinted:
			ev = DPeerHinted
		}
		s.fireDisc(ev, nil)
		return nil
	})
}

// PeerLeft reports a roster departure.
func (s *Session) PeerLeft(ep Epoch, peer string) ([]Effect, error) {
	return s.run(func() error {
		if ep.Room != s.epoch.Room {
			return ErrStale
		}
		if peer != s.peer || s.peer == "" {
			return nil
		}
		s.fireDisc(DPeerGone, nil)
		return nil
	})
}

// Signal delivers one peer-authored signalling payload from room peer from.
func (s *Session) Signal(ep Epoch, from string, raw []byte) ([]Effect, error) {
	return s.run(func() error {
		if ep.Room != s.epoch.Room {
			return ErrStale
		}
		s.handleSignal(from, bytes.Clone(raw))
		return nil
	})
}

func (s *Session) handleSignal(from string, raw []byte) {
	if s.ended {
		return
	}
	in := classifySignal(raw)
	if s.disc.State == DJoining {
		s.captured = append(s.captured, capturedSignal{from, raw})
		s.capturedBytes += len(raw)
		s.fireDisc(in.event, &in)
		if len(s.captured) > CaptureMaxFrames || s.capturedBytes > CaptureMaxBytes {
			s.captured, s.capturedBytes = nil, 0
			s.fireDisc(DCaptureOverflow, nil)
		}
		return
	}
	if from != s.peer {
		s.foreignSignal(from, in)
		return
	}
	s.fireDisc(in.event, &in)
}

// foreignSignal handles a signal from a room peer that is not ours. Only an
// establishment STARTER (a request or an offer) is answered busy (link §5.3);
// anything else — including another peer's busy, which would otherwise
// ping-pong — is dropped in silence.
func (s *Session) foreignSignal(from string, in signalInfo) {
	if s.disc.State != DLink || s.linkM == nil {
		return
	}
	if in.event != DSigLinkOffer && in.event != DSigLinkOther {
		return
	}
	if sh := classifyLinkShape(in); sh != lsRequest && sh != lsOffer {
		return
	}
	s.otherPeer = from
	s.fireLink(LOtherPeer)
	s.otherPeer = ""
}

func (s *Session) fireDisc(ev int, in *signalInfo) {
	before := s.disc.State
	r := s.disc.Fire(ev)
	bind := r.To == DLink && s.linkM == nil
	if bind {
		s.bindLink()
		if s.ended {
			return
		}
	}
	var replay []capturedSignal
	for _, a := range r.Do {
		switch a {
		case AAnnounce:
			s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: bytes.Clone(helloFrame)})
			s.helloOwed = HelloAttempts - 1
			s.arm(tHello, HelloInterval)
		case AHelloOnce:
			s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: bytes.Clone(helloFrame)})
		case ARetryHello:
			if s.helloOwed > 0 {
				s.helloOwed--
				s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: bytes.Clone(helloFrame)})
				if s.helloOwed > 0 {
					s.arm(tHello, HelloInterval)
				}
			}
		case ARetire:
			s.helloOwed = 0
			s.cancel(tHello)
		case ALegacyCommit:
			var first []byte
			if has(r.Do, ALegacyAfter) && in != nil {
				first = in.raw
			}
			s.emit(Effect{Kind: EffBeginLegacy, To: s.peer, Bytes: first})
		case ALegacyUpgrade:
			s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: bytes.Clone(upgradeFrame)})
		case AReplay:
			replay, s.captured, s.capturedBytes = s.captured, nil, 0
		case ARecordCaps:
			if in != nil {
				s.caps.Record(s.peer, in.sig)
			}
		case ARecordProven:
			if in != nil {
				s.caps.RecordProvenLink(s.peer, in.sig)
			}
		case AFeedLink:
			s.feedLink(ev, in)
		case AFeedLegacy:
			if in != nil {
				s.emit(Effect{Kind: EffLegacyFrame, To: s.peer, Bytes: in.raw})
			}
		case AResetEpoch:
			s.epoch.Room++
			s.peer, s.selfID = "", ""
			s.captured, s.capturedBytes, s.helloOwed = nil, 0, 0
			s.caps = linkwire.NewPeerCaps()
		}
	}
	if s.disc.State != before {
		switch s.disc.State {
		case DJoining:
			s.arm(tJoin, s.cfg.JoinWait)
		case DPassive, DGreeting:
			s.arm(tDisc, s.discWait)
		}
	}
	if r.Result == FailSess {
		s.report("session", reportOf(r.Do))
		s.endSession(reportOf(r.Do))
		return
	}
	if bind {
		s.fireLink(LStart)
	}
	for _, c := range replay {
		s.handleSignal(c.from, c.raw)
	}
}

// ---------------------------------------------------------------- link

// bindLink creates the link machine, both lanes and a fresh handshake
// identity for the bound peer. The role is fixed for the link's life.
func (s *Session) bindLink() {
	role := LCResponder
	if linkwire.LinkRole(s.selfID, s.peer) == linkcrypto.Initiator {
		role = LCInitiator
	}
	s.epoch.Link++
	s.epoch.Transport = 1
	s.linkM = NewMachine(s.tabs.link, role, LIdle)
	s.fileM = NewMachine(s.tabs.file, role, FIdle)
	s.textM = NewMachine(s.tabs.text, role, TIdle)
	s.adm = AdmWaitingLink
	lk, err := newLink(s.rnd, s.peer, role, s.epoch)
	if err != nil {
		// No random source: nothing can be established. End truthfully.
		s.report("link", "no-randomness")
		s.endSession("no-randomness")
		return
	}
	s.lk = lk
}

// feedLink turns a discovery-routed input into exactly one link event, using
// linkwire's classifiers and the handshake state. Frames that name no link
// event are dropped here, silently, before any table.
func (s *Session) feedLink(discEv int, in *signalInfo) {
	if s.linkM == nil || s.lk == nil {
		return
	}
	switch discEv {
	case DSigHelloNoLink:
		s.fireLink(LCapsRevoked)
		return
	case DSigResume:
		s.fireLink(LResume)
		return
	case DPeerGone:
		s.fireLink(LPeerGone)
		return
	case DSigLinkOffer, DSigLinkOther:
	default:
		return
	}
	ev, ok := s.classifyLink(*in)
	if !ok {
		return
	}
	s.cur = in
	s.fireLink(ev)
	s.cur = nil
	s.pending.wipe()
	s.pending = nil
}

func (s *Session) classifyLink(in signalInfo) (int, bool) {
	switch classifyLinkShape(in) {
	case lsRequest:
		return LPeerRequest, true
	case lsOffer:
		if s.offerRaw != nil && bytes.Equal(in.raw, s.offerRaw) {
			return LPeerOfferDup, true
		}
		c, ok := signalCommit(in)
		if !ok {
			return 0, false // an offer without a commit can never be answered safely
		}
		if s.lk.peerCommit != nil && bytes.Equal(c, s.lk.peerCommit) {
			return LPeerRestartOffer, true
		}
		return LPeerOffer, true
	case lsAnswer:
		c, ok := signalCommit(in)
		if !ok || (s.lk.peerCommit != nil && !bytes.Equal(c, s.lk.peerCommit)) {
			return 0, false
		}
		return LPeerAnswer, true
	case lsReveal:
		if s.lk.peerCommit == nil {
			return LPeerRevealInvalid, true // no commit recorded: hard error (link §5.1 step 6)
		}
		if s.lk.keys != nil {
			return LPeerRevealDup, true
		}
		pub, nonce, ok := signalReveal(in)
		if !ok || !linkcrypto.VerifyCommit(s.lk.peerCommit, pub, nonce) {
			return LPeerRevealInvalid, true
		}
		pk, err := derive(s.lk, pub)
		if err != nil {
			return LPeerRevealInvalid, true // e.g. a low-order peer key
		}
		s.pending = pk
		return LPeerRevealValid, true
	case lsIce:
		return LPeerIce, true
	case lsBusy:
		return LPeerBusy, true
	case lsLeave:
		return s.classifyLeave(in), true
	}
	return 0, false
}

// classifyLeave runs link §4.6's cheap checks before any HMAC and spends the
// per-link budget only on an HMAC actually computed.
func (s *Session) classifyLeave(in signalInfo) int {
	tag, ok := linkwire.LeaveAuth(in.sig)
	if !ok {
		return LLeaveInvalid
	}
	if st := s.linkM.State; st != LOpen && st != LRestarting {
		return LLeaveInvalid
	}
	if s.lk.resumeAuth == nil || s.leaveSpent >= LeaveMaxAttempts {
		return LLeaveInvalid
	}
	s.leaveSpent++
	if linkwire.VerifyLeave(s.lk.resumeAuth, s.peer, s.selfID, tag) {
		return LLeaveValid
	}
	return LLeaveInvalid
}

func (s *Session) fireLink(ev int) {
	if s.linkM == nil {
		return
	}
	before := s.linkM.State
	r := s.linkM.Fire(ev)
	replayLanes := false
	for _, a := range r.Do {
		switch a {
		case ACreateChans:
			s.emit(Effect{Kind: EffCreateChannels, Label: linkwire.ChannelLabels[0] + "," + linkwire.ChannelLabels[1]})
		case ASendOffer:
			s.emit(Effect{Kind: EffSendOffer, To: s.peer, Commit: b64(s.lk.commit), Caps: []string{linkwire.Capability}})
		case ASendRequest:
			s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: linkwire.RequestSignal()})
			if s.linkM.State == LRequesting {
				s.arm(tReqRetry, LinkRequestRetry)
			}
		case ARecordCommit:
			if s.cur != nil {
				c, _ := signalCommit(*s.cur)
				s.lk.peerCommit = c
				if ev == LPeerOffer {
					s.offerRaw = s.cur.raw
				} else {
					s.emit(Effect{Kind: EffApplyAnswer, To: s.peer, Bytes: s.cur.raw})
				}
			}
		case ASendAnswer:
			var offer []byte
			if s.cur != nil {
				offer = s.cur.raw
			}
			s.emit(Effect{Kind: EffSendAnswer, To: s.peer, Bytes: offer, Commit: b64(s.lk.commit), Caps: []string{linkwire.Capability}})
		case AArmSetup:
			s.iceProgress, s.progressKeys = 0, map[string]bool{}
			s.arm(tNoProgress, SetupNoProgress)
			s.arm(tHardCap, SetupHardCap)
			s.arm(tHandshake, HandshakeDeadline)
		case ASendReveal:
			s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: revealFrame(s.lk.self.PublicKey(), s.lk.nonce)})
		case ADerive:
			s.lk.install(s.pending)
			s.pending = nil
			s.emit(Effect{Kind: EffSASReady})
		case AAttach:
			s.emit(Effect{Kind: EffAttachLanes})
			replayLanes = true
		case AAdmission:
			if s.cfg.Verify {
				s.adm = AdmPendingSAS
				s.arm(tVerify, VerifyWait)
			} else {
				s.adm = AdmAdmitted
				s.emit(Effect{Kind: EffAdmitted})
			}
		case AAddIce:
			if s.cur != nil {
				s.emit(Effect{Kind: EffAddICE, To: s.peer, Bytes: s.cur.raw})
			}
			if s.iceProgress < MaxICEProgress && s.timers[tNoProgress].armed {
				s.iceProgress++
				s.arm(tNoProgress, SetupNoProgress)
			}
		case ASendBusy:
			to := s.otherPeer
			if to == "" {
				to = s.peer
			}
			s.emit(Effect{Kind: EffSendSignal, To: to, Bytes: linkwire.BusySignal()})
		case ACloseChan:
			s.emit(Effect{Kind: EffCloseChannel, Label: s.badLabel})
		case ASendLeave:
			if s.lk.resumeAuth != nil {
				if tag, err := linkwire.SignLeave(s.lk.resumeAuth, s.selfID, s.peer); err == nil {
					if f, err := linkwire.LeaveSignal(tag); err == nil {
						s.emit(Effect{Kind: EffSendSignal, To: s.peer, Bytes: f})
					}
				}
			}
		case ADestroy:
			s.lk.destroy()
		case ARestartOffer:
			s.emit(Effect{Kind: EffICERestart, To: s.peer, Commit: b64(s.lk.commit), Caps: []string{linkwire.Capability}})
		case AApplyAnswer:
			if s.cur != nil {
				s.emit(Effect{Kind: EffApplyAnswer, To: s.peer, Bytes: s.cur.raw})
			}
		case AApplyRestart:
			if s.cur != nil {
				s.emit(Effect{Kind: EffApplyRestartOffer, To: s.peer, Bytes: s.cur.raw})
			}
		case ACloseTx:
			// linkClosed emits EffCloseTransport on every entry to Closed.
		}
	}
	if code := reportOf(r.Do); code != "" {
		s.report("link", code)
	}
	if s.linkM.State != before {
		switch s.linkM.State {
		case LRequesting:
			s.arm(tReqRetry, LinkRequestRetry)
			s.arm(tReqTotal, LinkRequestTotal)
		case LLanesKeyPending:
			s.arm(tKeyReveal, KeyRevealWait)
		case LOpen:
			s.arm(tLinkIdle, LinkIdle)
		case LRestarting:
			s.arm(tHardCap, SetupHardCap)
		case LClosed:
			s.linkClosed(reportOf(r.Do))
			return
		}
	}
	if replayLanes {
		cap := s.laneCap
		s.laneCap, s.laneCapBytes = nil, 0
		for _, f := range cap {
			if s.linkM.State != LOpen {
				break
			}
			if f.text {
				s.textFrame(f.raw)
			} else {
				s.fileFrame(f.raw)
			}
		}
	}
}

// linkClosed ends both lanes truthfully, destroys every key and codec, bumps
// the link epoch so late callbacks are stale, and ends the session: a pair
// session is bound to one link for its life.
func (s *Session) linkClosed(code string) {
	s.lk.destroy()
	s.pending.wipe()
	s.pending = nil
	s.laneCap, s.laneCapBytes = nil, 0
	if s.fileM != nil {
		s.fireFile(FLinkClosed)
	}
	if s.textM != nil {
		s.fireText(TLinkClosed)
	}
	s.epoch.Link++
	if code == "" {
		code = "closed"
	}
	s.emit(Effect{Kind: EffCloseTransport})
	s.emit(Effect{Kind: EffLinkClosed, Code: code})
	s.endSession(code)
}

func (s *Session) transportInput(ep Epoch, f func()) ([]Effect, error) {
	return s.run(func() error {
		if s.linkM == nil || ep != s.epoch {
			return ErrStale
		}
		s.inputErr = nil
		f()
		err := s.inputErr
		s.inputErr = nil
		return err
	})
}

// LanesOpen reports both labelled channels open with the exact tuple.
func (s *Session) LanesOpen(ep Epoch) ([]Effect, error) {
	return s.transportInput(ep, func() { s.fireLink(LLanesOpen) })
}

// ChannelBad reports an unknown or duplicate channel label.
func (s *Session) ChannelBad(ep Epoch, label string) ([]Effect, error) {
	return s.transportInput(ep, func() {
		s.badLabel = label
		s.fireLink(LLaneBad)
		s.badLabel = ""
	})
}

// TransportProgress re-arms the setup no-progress timer once per distinct key
// ("sdp:offer", "sdp:answer", "state:<state>"), link §5.2. ICE progress is
// counted by the session itself.
func (s *Session) TransportProgress(ep Epoch, key string) ([]Effect, error) {
	return s.transportInput(ep, func() {
		if s.timers[tNoProgress].armed && !s.progressKeys[key] {
			s.progressKeys[key] = true
			s.arm(tNoProgress, SetupNoProgress)
		}
	})
}

// Disconnected reports a transient ICE disconnection.
func (s *Session) Disconnected(ep Epoch) ([]Effect, error) {
	return s.transportInput(ep, func() { s.fireLink(LDisconnected) })
}

// Reconnected reports ICE connectivity restored.
func (s *Session) Reconnected(ep Epoch) ([]Effect, error) {
	return s.transportInput(ep, func() { s.fireLink(LReconnected) })
}

// TransportLost reports the transport failed or closed.
func (s *Session) TransportLost(ep Epoch) ([]Effect, error) {
	return s.transportInput(ep, func() { s.fireLink(LTransportLost) })
}

// SetRelayDeadline arms the relay-credential end (A09/A11): the link ends
// truthfully at t. The caller subtracts its own skew.
func (s *Session) SetRelayDeadline(t time.Time) {
	if s.linkM == nil || s.ended {
		return
	}
	s.timers[tRelay] = timer{armed: true, at: t}
}

// Close is the explicit local end (quit, ctrl-C, one-shot command done): a
// best-effort authenticated leave on an open link, then destroy.
func (s *Session) Close() ([]Effect, error) {
	return s.run(func() error {
		if s.linkM == nil {
			s.report("session", "local-close")
			s.endSession("local-close")
			return nil
		}
		s.fireLink(LLocalClose)
		if !s.ended {
			s.endSession("local-close")
		}
		return nil
	})
}

// ---------------------------------------------------------------- admission

// ConfirmSAS is the local human answer under --verify.
func (s *Session) ConfirmSAS(ok bool) ([]Effect, error) {
	return s.run(func() error {
		if s.adm != AdmPendingSAS {
			return ErrWrongState
		}
		s.cancel(tVerify)
		if !ok {
			s.refuseAdmission("sas-rejected")
			return nil
		}
		s.adm = AdmAdmitted
		s.emit(Effect{Kind: EffAdmitted})
		return nil
	})
}

// refuseAdmission rejects everything pending, sends an authenticated leave
// and destroys the keys.
func (s *Session) refuseAdmission(code string) {
	s.adm = AdmRefused
	s.report("link", code)
	if s.fileM.State == FInPrompt {
		s.fireFile(FLocalReject)
	}
	if s.textM.State == TIncoming {
		s.fireText(TLocalReject)
	}
	s.fireLink(LLocalClose)
}

// applyPolicies turns an AUTOMATIC authorisation into a local decision, only
// once admitted. PolicyReject answers at once, even before admission: a
// refusal is not consent, and a command that does not receive this kind must
// not leave the peer waiting out a ten-minute consent window.
func (s *Session) applyPolicies() {
	if s.ended || s.fileM == nil {
		return
	}
	if s.fileM.State == FInPrompt {
		switch s.authz.Files {
		case PolicyReject:
			s.fireFile(FLocalReject)
		case PolicyAutoOnce:
			if s.onceUsed {
				s.fireFile(FLocalReject)
			} else if s.adm == AdmAdmitted {
				s.onceUsed = true
				s.fireFile(FLocalAccept)
			}
		case PolicyAutoAll:
			if s.adm == AdmAdmitted {
				s.fireFile(FLocalAccept)
			}
		}
	}
	if s.textM.State == TIncoming {
		switch s.authz.Text {
		case PolicyReject:
			s.fireText(TLocalReject)
		case PolicyAutoAll, PolicyAutoOnce:
			if s.adm == AdmAdmitted {
				s.fireText(TLocalAccept)
			}
		}
	}
}

// ---------------------------------------------------------------- lane inputs

// FileFrame delivers one message received on the file lane.
func (s *Session) FileFrame(ep Epoch, raw []byte) ([]Effect, error) {
	return s.transportInput(ep, func() { s.laneInput(false, bytes.Clone(raw)) })
}

// TextFrame delivers one message received on the text lane.
func (s *Session) TextFrame(ep Epoch, raw []byte) ([]Effect, error) {
	return s.transportInput(ep, func() { s.laneInput(true, bytes.Clone(raw)) })
}

// laneInput routes a lane message: to the lanes once Open, into the bounded
// pre-attach capture while the link is being established (link §2.2), and
// nowhere once the link is idle or closed.
func (s *Session) laneInput(text bool, raw []byte) {
	switch s.linkM.State {
	case LOpen, LRestarting:
		if text {
			s.textFrame(raw)
		} else {
			s.fileFrame(raw)
		}
	case LIdle, LClosed:
	default:
		s.laneCap = append(s.laneCap, laneFrame{text, raw})
		s.laneCapBytes += len(raw)
		if s.laneCapBytes > CaptureMaxBytes {
			s.laneCap, s.laneCapBytes = nil, 0
			s.fireLink(LCaptureOverflow)
		}
	}
}

func (s *Session) touchLink() {
	if s.linkM != nil && (s.linkM.State == LOpen || s.linkM.State == LRestarting) {
		s.arm(tLinkIdle, LinkIdle)
	}
}

// lanesQuiet reports that no batch and no conversation is live. Link idle
// counts only then: every live lane state has its own bound (consent, stall,
// drain, END ack, text idle), so a pending prompt ends as a PROMPT, not by
// taking the whole link down at the same instant.
func (s *Session) lanesQuiet() bool {
	return (s.fileM == nil || in(s.fileM.State, FIdle, FEnded)) && (s.textM == nil || in(s.textM.State, TIdle, TFailed))
}

// laneSettled re-arms link idle when the last live lane goes quiet.
func (s *Session) laneSettled() {
	if s.lanesQuiet() {
		s.touchLink()
	}
}

// ---------------------------------------------------------------- clock

// Tick fires every due timer, earliest first. Call it at NextDeadline.
func (s *Session) Tick() ([]Effect, error) {
	effs, err := s.run(func() error { return nil }) // run fires everything due
	if errors.Is(err, ErrEnded) && len(effs) > 0 {
		err = nil // this Tick ended the session: that is its result, not a refusal
	}
	return effs, err
}

func (s *Session) fireDue() {
	now := s.clock.Now()
	for i := 0; i < 4*int(numTimers) && !s.ended; i++ {
		id, ok := s.due(now)
		if !ok {
			break
		}
		s.timers[id].armed = false
		s.fireTimer(id)
		s.settle()
	}
}

// NextDeadline is the earliest armed timer, if any.
func (s *Session) NextDeadline() (time.Time, bool) {
	var at time.Time
	found := false
	for id := timerID(0); id < numTimers; id++ {
		t := s.timers[id]
		if t.armed && s.timerValid(id) && (!found || t.at.Before(at)) {
			at, found = t.at, true
		}
	}
	return at, found
}

func (s *Session) due(now time.Time) (timerID, bool) {
	best, found := timerID(0), false
	for id := timerID(0); id < numTimers; id++ {
		t := s.timers[id]
		if !t.armed || t.at.After(now) || !s.timerValid(id) {
			continue
		}
		if !found || t.at.Before(s.timers[best].at) {
			best, found = id, true
		}
	}
	return best, found
}

func (s *Session) arm(id timerID, d time.Duration) {
	s.timers[id] = timer{armed: true, at: s.clock.Now().Add(d)}
}

func (s *Session) cancel(id timerID) { s.timers[id].armed = false }

func (s *Session) pruneTimers() {
	for id := timerID(0); id < numTimers; id++ {
		if s.timers[id].armed && !s.timerValid(id) {
			s.timers[id].armed = false
		}
	}
}

func in(st int, set ...int) bool {
	for _, x := range set {
		if st == x {
			return true
		}
	}
	return false
}

// timerValid is the set of states in which a timer means anything. Every
// timer is armed on entry to (one of) its states, so a stale arm from an
// earlier visit is always overwritten, and a timer whose state is gone is
// pruned instead of firing.
func (s *Session) timerValid(id timerID) bool {
	if s.ended {
		return false
	}
	d := s.disc.State
	switch id {
	case tJoin:
		return d == DJoining
	case tDisc:
		return in(d, DPassive, DGreeting)
	case tHello:
		return d == DGreeting
	}
	if s.linkM == nil {
		return false
	}
	l := s.linkM.State
	switch id {
	case tReqRetry, tReqTotal:
		return l == LRequesting
	case tNoProgress:
		return in(l, LOffering, LAnswered, LRevealed, LKeyedLanesPending)
	case tHardCap:
		return in(l, LOffering, LAnswered, LRevealed, LKeyedLanesPending, LRestarting)
	case tKeyReveal:
		return l == LLanesKeyPending
	case tHandshake:
		return in(l, LOffering, LAnswered, LRevealed, LLanesKeyPending)
	case tLinkIdle:
		return in(l, LOpen, LRestarting) && s.lanesQuiet()
	case tVerify:
		return s.adm == AdmPendingSAS && in(l, LOpen, LRestarting)
	case tRelay:
		return l != LIdle && l != LClosed
	}
	f, t := s.fileM.State, s.textM.State
	switch id {
	case tFileConsent:
		return in(f, FOutWait, FInPrompt)
	case tDrain:
		return in(f, FInDrain, FInExpired)
	case tRecvStall:
		return f == FInRecv
	case tSendStall, tSendProgress:
		return f == FOutSend
	case tCompleteStall:
		return f == FOutFinish
	case tTextConsent:
		return in(t, TWaitAccept, TIncoming)
	case tEndAck:
		return t == TEndWait
	case tTextIdle:
		return t == TOpen
	}
	return false
}

func (s *Session) fireTimer(id timerID) {
	switch id {
	case tJoin, tDisc:
		s.fireDisc(DDeadline, nil)
	case tHello:
		s.fireDisc(DRetryTick, nil)
	case tReqRetry:
		s.fireLink(LRequestTick)
	case tReqTotal:
		s.fireLink(LRequestTimeout)
	case tNoProgress:
		s.fireLink(LSetupNoProgress)
	case tHardCap:
		s.fireLink(LSetupHardCap)
	case tKeyReveal:
		s.fireLink(LKeyRevealTimeout)
	case tHandshake:
		s.fireLink(LHandshakeDeadline)
	case tLinkIdle:
		s.fireLink(LIdleTimeout)
	case tVerify:
		// Never confirmed: nothing was consented. End silently (like idle):
		// a leave is reserved for an explicit user disconnect (link §4.6).
		s.adm = AdmRefused
		s.report("link", "verify-timeout")
		s.fireLink(LIdleTimeout)
	case tRelay:
		s.fireLink(LRelayDeadline)
	case tFileConsent:
		s.fireFile(FConsentTimeout)
	case tDrain:
		s.fireFile(FDrainTimeout)
	case tRecvStall:
		s.fireFile(FReceiveStall)
	case tSendStall, tSendProgress:
		s.fireFile(FSendStall)
	case tCompleteStall:
		s.fireFile(FCompleteStall)
	case tTextConsent:
		s.fireText(TConsentTimeout)
	case tEndAck:
		s.fireText(TEndAckTimeout)
	case tTextIdle:
		s.fireText(TIdleTimeout)
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
