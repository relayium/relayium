package linksession

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linkwire"
)

// Fake-clock evidence for every bound in A08-DESIGN §10. Each test checks
// the bound's edge: nothing at bound-1ns, the ending at the bound.

const ns = time.Nanosecond

func tickOne(t *testing.T, s *Session, clk *fakeClock, d time.Duration) []Effect {
	t.Helper()
	clk.Advance(d)
	effs, _ := s.Tick()
	return effs
}

func signalsSent(effs []Effect, substr string) int {
	n := 0
	for _, e := range effs {
		if e.Kind == EffSendSignal && strings.Contains(string(e.Bytes), substr) {
			n++
		}
	}
	return n
}

// initiatorOffering returns an initiator session that has just sent its offer.
func initiatorOffering(t *testing.T) (*Session, *fakeClock) {
	t.Helper()
	clk := newClock()
	s, _ := NewSession(Config{Cmd: CmdPair, Clock: clk, Rand: newRand(9)})
	s.Room(s.Epoch(), RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true})
	s.Signal(s.Epoch(), "b", []byte(`{"caps":["link/1"]}`))
	if s.linkM.State != LOffering {
		t.Fatalf("not offering: %v", s)
	}
	return s, clk
}

// ---------------------------------------------------------------- discovery

func TestBoundEarlySignalCapture(t *testing.T) {
	clk := newClock()
	s, _ := NewSession(Config{Cmd: CmdPair, Clock: clk})
	for i := 0; i < CaptureMaxFrames; i++ {
		if _, err := s.Signal(s.Epoch(), "p", []byte(`{"x":1}`)); err != nil {
			t.Fatal(err)
		}
	}
	if ended, _ := s.Ended(); ended {
		t.Fatal("64 frames overflowed")
	}
	effs, _ := s.Signal(s.Epoch(), "p", []byte(`{"x":1}`))
	if !hasReport(effs, "capture-overflow") {
		t.Fatalf("65th frame: %s", kinds(effs))
	}
	s, _ = NewSession(Config{Cmd: CmdPair, Clock: clk})
	big := []byte(`{"pad":"` + strings.Repeat("a", CaptureMaxBytes/2) + `"}`)
	s.Signal(s.Epoch(), "p", big)
	if ended, _ := s.Ended(); ended {
		t.Fatal("128 KiB overflowed")
	}
	effs, _ = s.Signal(s.Epoch(), "p", big)
	if !hasReport(effs, "capture-overflow") {
		t.Fatalf("256 KiB+: %s", kinds(effs))
	}
}

func TestBoundJoinAndDiscoveryWait(t *testing.T) {
	clk := newClock()
	s, _ := NewSession(Config{Cmd: CmdPair, Clock: clk})
	if effs := tickOne(t, s, clk, DefaultJoinWait-ns); len(effs) != 0 {
		t.Fatal("join wait ended early")
	}
	if effs := tickOne(t, s, clk, ns); !hasReport(effs, "no-peer-joined") {
		t.Fatalf("join wait: %s", kinds(effs))
	}
	// Passive: 30 s after the room view, ends; never chooses a wire.
	s, _ = NewSession(Config{Cmd: CmdSend, Clock: clk})
	s.Room(s.Epoch(), RoomView{SelfID: "a", PeerID: "b", ServerHints: true})
	if effs := tickOne(t, s, clk, DiscoveryWait-ns); len(effs) != 0 {
		t.Fatal("discovery wait ended early")
	}
	effs := tickOne(t, s, clk, ns)
	if !hasReport(effs, "peer-never-spoke") || count(effs, EffSendSignal, -1) != 0 || count(effs, EffBeginLegacy, -1) != 0 {
		t.Fatalf("discovery wait chose something: %s", kinds(effs))
	}
}

func TestBoundHelloCadence(t *testing.T) {
	clk := newClock()
	s, _ := NewSession(Config{Cmd: CmdPair, Clock: clk})
	var all []Effect
	effs, _ := s.Room(s.Epoch(), RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true})
	all = append(all, effs...)
	at := map[time.Duration]int{0: signalsSent(effs, `"caps"`)}
	for el := 500 * time.Millisecond; el <= 29*time.Second; el += 500 * time.Millisecond {
		effs := tickOne(t, s, clk, 500*time.Millisecond)
		if n := signalsSent(effs, `"caps"`); n > 0 {
			at[el] = n
		}
		all = append(all, effs...)
	}
	if len(at) != 3 || at[0] != 1 || at[HelloInterval] != 1 || at[2*HelloInterval] != 1 {
		t.Fatalf("hello cadence: %v", at)
	}
	// hearing the peer retires the announcer
	s, _ = NewSession(Config{Cmd: CmdPair, Clock: clk, Rand: newRand(2)})
	s.Room(s.Epoch(), RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true})
	s.Signal(s.Epoch(), "b", []byte(`{"caps":["link/1"]}`))
	if effs := tickOne(t, s, clk, 10*time.Second); signalsSent(effs, `"caps"`) != 0 {
		t.Fatal("hello after hearing the peer")
	}
}

// ---------------------------------------------------------------- link

func TestBoundLinkRequest(t *testing.T) {
	s, clk := responderAt(t)
	n := 1 // the request sent on entering Requesting
	for el := time.Duration(0); el < LinkRequestTotal-LinkRequestRetry; el += LinkRequestRetry {
		effs := tickOne(t, s, clk, LinkRequestRetry)
		n += signalsSent(effs, `"linkRequest"`)
	}
	if n != int(LinkRequestTotal/LinkRequestRetry) || s.linkM.State != LRequesting {
		t.Fatalf("requests by 27 s: %d (state %s)", n, s.linkM.StateName())
	}
	effs := tickOne(t, s, clk, LinkRequestRetry)
	if !hasReport(effs, "request-timeout") || signalsSent(effs, `"linkRequest"`) != 0 {
		t.Fatalf("request timeout at 30 s: %s", kinds(effs))
	}
}

func TestBoundSetupNoProgressAndHardCap(t *testing.T) {
	s, clk := initiatorOffering(t)
	if effs := tickOne(t, s, clk, SetupNoProgress-ns); len(effs) != 0 {
		t.Fatal("no-progress early")
	}
	if effs := tickOne(t, s, clk, ns); !hasReport(effs, "setup-failed") {
		t.Fatalf("no-progress: %s", kinds(effs))
	}
	// six ICE candidates re-arm it, the seventh does not
	s, clk = initiatorOffering(t)
	ice := []byte(`{"link":true,"ice":{"candidate":"c"}}`)
	for i := 0; i < MaxICEProgress; i++ {
		clk.Advance(SetupNoProgress - time.Second)
		s.Signal(s.Epoch(), "b", ice)
	}
	// 6 x 29 s = 174 s of re-armed progress, WITHOUT any Tick: the hard cap
	// (90 s) is never re-armed, and the first input past it fires it first.
	var closedBy string
	for _, st := range s.linkM.Trace {
		if st.To == "Closed" && closedBy == "" {
			closedBy = st.On
		}
	}
	if s.linkM.State != LClosed || closedBy != "SetupHardCap" {
		t.Fatalf("hard cap not enforced before a late input: %s by %q", s.linkM.StateName(), closedBy)
	}
	s, clk = initiatorOffering(t)
	for i := 0; i < 3; i++ { // 29+29+29 = 87 s of re-armed progress
		clk.Advance(SetupNoProgress - time.Second)
		s.Signal(s.Epoch(), "b", ice)
		s.TransportProgress(s.Epoch(), fmt.Sprintf("state:%d", i))
	}
	if effs := tickOne(t, s, clk, SetupHardCap-87*time.Second-ns); len(effs) != 0 {
		t.Fatal("hard cap early")
	}
	if effs := tickOne(t, s, clk, ns); !hasReport(effs, "setup-failed") {
		t.Fatalf("hard cap: %s", kinds(effs))
	}
	// the seventh ICE does not extend
	s, clk = initiatorOffering(t)
	for i := 0; i < MaxICEProgress; i++ {
		s.Signal(s.Epoch(), "b", ice)
	}
	clk.Advance(time.Second)
	s.Signal(s.Epoch(), "b", ice) // 7th: no re-arm
	if effs := tickOne(t, s, clk, SetupNoProgress-time.Second); !hasReport(effs, "setup-failed") {
		t.Fatalf("seventh candidate extended the deadline: %s", kinds(effs))
	}
	// distinct progress keys re-arm once each
	s, clk = initiatorOffering(t)
	clk.Advance(20 * time.Second)
	s.TransportProgress(s.Epoch(), "sdp:answer")
	clk.Advance(20 * time.Second)
	s.TransportProgress(s.Epoch(), "sdp:answer") // duplicate: no re-arm
	if effs := tickOne(t, s, clk, 10*time.Second); !hasReport(effs, "setup-failed") {
		t.Fatalf("duplicate progress key extended the deadline: %s", kinds(effs))
	}
}

func TestBoundKeyRevealAndHandshake(t *testing.T) {
	s, clk := responderAt(t)
	commit := make([]byte, 32)
	commit[1] = 1
	s.Signal(s.Epoch(), "a", fakeOffer(commit, "x"))
	s.LanesOpen(s.Epoch())
	if s.linkM.State != LLanesKeyPending {
		t.Fatal(s.linkM.StateName())
	}
	if effs := tickOne(t, s, clk, KeyRevealWait-ns); len(effs) != 0 {
		t.Fatal("key reveal early")
	}
	if effs := tickOne(t, s, clk, ns); !hasReport(effs, "key-reveal-failed") {
		t.Fatalf("key reveal: %s", kinds(effs))
	}
	// handshake deadline: 90 s from the answer, whatever re-armed setup
	s, clk = responderAt(t)
	s.Signal(s.Epoch(), "a", fakeOffer(commit, "x"))
	ice := []byte(`{"link":true,"ice":{"candidate":"c"}}`)
	clk.Advance(25 * time.Second)
	s.Signal(s.Epoch(), "a", ice)
	clk.Advance(25 * time.Second)
	s.Signal(s.Epoch(), "a", ice)
	clk.Advance(20 * time.Second) // 70 s
	s.LanesOpen(s.Epoch())        // key reveal would end at 100 s
	if effs := tickOne(t, s, clk, 20*time.Second-ns); len(effs) != 0 {
		t.Fatal("handshake early")
	}
	if effs := tickOne(t, s, clk, ns); !hasReport(effs, "key-reveal-failed") || s.linkM.State != LClosed {
		t.Fatalf("handshake deadline at 90 s: %s", kinds(effs))
	}
}

func TestBoundPreAttachCapture(t *testing.T) {
	s, _ := responderAt(t)
	commit := make([]byte, 32)
	s.Signal(s.Epoch(), "a", fakeOffer(commit, "x"))
	s.LanesOpen(s.Epoch())
	half := make([]byte, CaptureMaxBytes/2)
	half[0] = linkwire.KindChunk
	if _, err := s.FileFrame(s.Epoch(), half); err != nil || s.linkM.State != LLanesKeyPending {
		t.Fatal("half the capture failed")
	}
	if _, err := s.TextFrame(s.Epoch(), half); err != nil || s.linkM.State != LLanesKeyPending {
		t.Fatal("exactly the capture bound failed")
	}
	effs, _ := s.TextFrame(s.Epoch(), []byte{linkwire.CtrlTextRequest}) // combined across both lanes
	if s.linkM.State != LClosed || !hasReport(effs, "key-reveal-failed") {
		t.Fatalf("capture overflow: %s", kinds(effs))
	}
}

func TestBoundLeaveBudget(t *testing.T) {
	forged := []byte(`{"link":true,"leave":true,"auth":"` + strings.Repeat("B", 43) + `="}`)
	valid := func(l *loop) []byte {
		tag, err := linkwire.SignLeave(l.b.s.lk.resumeAuth, "b", "a")
		if err != nil {
			t.Fatal(err)
		}
		f, _ := linkwire.LeaveSignal(tag)
		return f
	}
	l := openLoop(t, CmdPair, CmdPair)
	for i := 0; i < LeaveMaxAttempts; i++ {
		l.a.s.Signal(l.a.s.Epoch(), "b", forged)
	}
	l.a.s.Signal(l.a.s.Epoch(), "b", valid(l))
	if l.a.s.linkM.State != LOpen || l.a.s.leaveSpent != LeaveMaxAttempts {
		t.Fatal("a genuine leave verified after the budget was spent")
	}
	l = openLoop(t, CmdPair, CmdPair)
	for i := 0; i < LeaveMaxAttempts-1; i++ {
		l.a.s.Signal(l.a.s.Epoch(), "b", forged)
	}
	effs, _ := l.a.s.Signal(l.a.s.Epoch(), "b", valid(l))
	if l.a.s.linkM.State != LClosed || !hasReport(effs, "peer-ended-session") {
		t.Fatalf("the 8th HMAC was not spent on a genuine leave: %s", kinds(effs))
	}
}

func TestBoundVerifyAnswer(t *testing.T) {
	l := newLoop(t, CmdPair, CmdPair, true, false)
	l.start()
	before := len(l.a.effs)
	l.clk.Advance(VerifyWait - ns)
	l.on(l.a)(l.a.s.Tick())
	if l.a.s.Admission() != AdmPendingSAS {
		t.Fatal("verify wait ended early")
	}
	l.clk.Advance(ns)
	l.on(l.a)(l.a.s.Tick())
	effs := l.a.effs[before:]
	if !hasReport(effs, "verify-timeout") || l.a.s.lk.alive() || signalsSent(effs, `"leave"`) != 0 {
		t.Fatalf("verify timeout must end silently and destroy: %s", kinds(effs))
	}
}

func TestBoundLinkIdle(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.tick(LinkIdle - time.Minute)
	l.sendBatch(l.a, payload(10, 1)) // traffic re-arms idle (at settle)
	accept(t, l, l.b)
	l.pushData(l.a, payload(10, 1))
	l.tick(LinkIdle - ns)
	if l.a.s.linkM.State != LOpen {
		t.Fatal("idle despite traffic")
	}
	l.tick(ns)
	if l.a.s.linkM.State != LClosed || !hasReport(l.a.effs, "idle-closed") || signalsSent(l.a.effs, `"leave"`) != 0 {
		t.Fatalf("idle close: %s", kinds(l.a.effs))
	}
}

func TestBoundRelayDeadline(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.a.s.SetRelayDeadline(l.clk.Now().Add(5 * time.Minute))
	l.clk.Advance(5*time.Minute - ns)
	l.on(l.a)(l.a.s.Tick())
	if l.a.s.linkM.State != LOpen {
		t.Fatal("relay deadline early")
	}
	l.clk.Advance(ns)
	l.on(l.a)(l.a.s.Tick())
	if !hasReport(l.a.effs, "relay-credential-ended") {
		t.Fatalf("relay deadline: %s", kinds(l.a.effs))
	}
}

// ---------------------------------------------------------------- file lane

func TestBoundFileConsent(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.sendBatch(l.a, payload(10, 1))
	l.tick(FileConsent - ns)
	wantStates(t, l.a, "OutWait", "")
	wantStates(t, l.b, "InPrompt", "")
	l.tick(ns)
	wantStates(t, l.a, "Idle", "")
	wantStates(t, l.b, "Idle", "")
	if !hasReport(l.a.effs, "no-answer") || count(l.b.effs, EffSendFile, int(linkwire.CtrlReject)) != 0 {
		t.Fatal("consent expiry not truthful")
	}
}

func TestBoundDrainAndExpiredWait(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.sendBatch(l.a, payload(10, 1))
	accept(t, l, l.b)
	l.dropLanes = true // the sender's BATCH_ABORT never arrives
	l.on(l.b)(l.b.s.CancelIncoming())
	wantStates(t, l.b, "InDrain", "")
	l.clk.Advance(FileDrainWait - ns)
	l.on(l.b)(l.b.s.Tick())
	wantStates(t, l.b, "InDrain", "")
	l.clk.Advance(ns)
	l.on(l.b)(l.b.s.Tick())
	if !hasReport(l.b.effs, "drain-failed") {
		t.Fatalf("drain: %s", kinds(l.b.effs))
	}

	x := openLoop(t, CmdPair, CmdPair)
	x.sendBatch(x.a, payload(10, 1))
	x.dropLanes = true
	x.clk.Advance(FileConsent)
	x.on(x.b)(x.b.s.Tick())
	wantStates(t, x.b, "InExpired", "")
	x.clk.Advance(FileDrainWait - ns)
	x.on(x.b)(x.b.s.Tick())
	wantStates(t, x.b, "InExpired", "")
	x.clk.Advance(ns)
	x.on(x.b)(x.b.s.Tick())
	if !hasReport(x.b.effs, "sender-never-withdrew") {
		t.Fatalf("expired wait: %s", kinds(x.b.effs))
	}
}

func TestBoundStalls(t *testing.T) {
	// receive stall 60 s
	l := openLoop(t, CmdPair, CmdPair)
	l.sendBatch(l.a, payload(10, 1))
	accept(t, l, l.b)
	l.dropLanes = true
	l.clk.Advance(ReceiveStall - ns)
	l.on(l.b)(l.b.s.Tick())
	wantStates(t, l.b, "InRecv", "")
	l.clk.Advance(ns)
	l.on(l.b)(l.b.s.Tick())
	if !hasReport(l.b.effs, "stalled") {
		t.Fatalf("receive stall: %s", kinds(l.b.effs))
	}
	// send-buffer stall 60 s
	x := openLoop(t, CmdPair, CmdPair)
	x.sendBatch(x.a, payload(10, 1))
	accept(t, x, x.b)
	x.dropLanes = true
	x.clk.Advance(SendBufferStall - ns)
	x.on(x.a)(x.a.s.Tick())
	wantStates(t, x.a, "OutSend", "")
	x.clk.Advance(ns)
	x.on(x.a)(x.a.s.Tick())
	if !hasReport(x.a.effs, "send-stalled") {
		t.Fatalf("send-buffer stall: %s", kinds(x.a.effs))
	}
	// send progress 150 s: buffer progress keeps the 60 s timer alive, but
	// without an ACK advance the batch still ends at 150 s
	y := openLoop(t, CmdPair, CmdPair)
	y.sendBatch(y.a, payload(10, 1))
	accept(t, y, y.b)
	y.dropLanes = true
	for i := 0; i < 2; i++ {
		y.clk.Advance(50 * time.Second)
		y.on(y.a)(y.a.s.Tick())
		y.on(y.a)(y.a.s.FileSendProgress(y.a.s.Epoch()))
	}
	y.clk.Advance(50*time.Second - ns)
	y.on(y.a)(y.a.s.Tick())
	y.on(y.a)(y.a.s.FileSendProgress(y.a.s.Epoch()))
	wantStates(t, y.a, "OutSend", "")
	y.clk.Advance(ns)
	y.on(y.a)(y.a.s.Tick())
	if !hasReport(y.a.effs, "send-stalled") {
		t.Fatalf("send progress stall: %s", kinds(y.a.effs))
	}
	// completion stall 150 s
	z := openLoop(t, CmdPair, CmdPair)
	z.b.holdDurable = true
	z.sendBatch(z.a, payload(10, 1))
	accept(t, z, z.b)
	z.pushData(z.a, payload(10, 1))
	wantStates(t, z.a, "OutFinish", "")
	z.dropLanes = true
	z.clk.Advance(CompleteStall - ns)
	z.on(z.a)(z.a.s.Tick())
	wantStates(t, z.a, "OutFinish", "")
	z.clk.Advance(ns)
	z.on(z.a)(z.a.s.Tick())
	if !hasReport(z.a.effs, "no-completion") {
		t.Fatalf("completion stall: %s", kinds(z.a.effs))
	}
}

func TestBoundFlowWindowAndAckInterval(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.b.holdDurable = true
	total := FlowWindow + 3*linkwire.ChunkSize
	p := payload(total, 3)
	l.sendBatch(l.a, p)
	accept(t, l, l.b)
	off := 0
	for ; off+linkwire.ChunkSize <= FlowWindow; off += linkwire.ChunkSize {
		if err := l.on(l.a)(l.a.s.SendChunk(p[off : off+linkwire.ChunkSize])); err != nil {
			t.Fatalf("within window at %d: %v", off, err)
		}
	}
	if err := l.on(l.a)(l.a.s.SendChunk(p[off : off+linkwire.ChunkSize])); !errors.Is(err, ErrWindowFull) {
		t.Fatalf("window not enforced at %d: %v", off, err)
	}
	// a forged ACK beyond what was emitted opens nothing
	f, _ := linkwire.AckFrame(uint64(total))
	l.on(l.a)(l.a.s.FileFrame(l.a.s.Epoch(), f))
	if l.a.s.SendCredit() != FlowWindow-uint64(off) {
		t.Fatal("forged ACK opened credit")
	}
	// the receiver reports durability; ACKs come at least every 512 KiB
	var acks []uint64
	for d := uint64(0); d < uint64(off); {
		d = min(d+uint64(linkwire.ChunkSize), uint64(off))
		effs, _ := l.b.s.FileDurable(l.b.s.Epoch(), d)
		for _, e := range effs {
			if v, ok := linkwire.ParseAck(e.Bytes); ok && e.Kind == EffSendFile {
				acks = append(acks, uint64(v))
			}
		}
		l.on(l.b)(effs, nil)
	}
	prev := uint64(0)
	for _, a := range acks {
		if a-prev < AckInterval {
			t.Fatalf("ACK interval too small: %v", acks)
		}
		prev = a
	}
	if uint64(off)-prev >= AckInterval || l.a.s.fout.acked != prev {
		t.Fatalf("durable bytes un-ACKed past the interval: acks=%v durable=%d", acks, off)
	}
	if err := l.on(l.a)(l.a.s.SendChunk(p[off : off+linkwire.ChunkSize])); err != nil {
		t.Fatalf("credit not restored: %v", err)
	}
	// durability can never be claimed beyond what was received
	if _, err := l.b.s.FileDurable(l.b.s.Epoch(), uint64(total)); !errors.Is(err, ErrDurable) {
		t.Fatal("durable beyond received accepted")
	}
}

func TestBoundManifest(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	many := make([]linkwire.FileMeta, linkwire.MaxFiles+1)
	for i := range many {
		many[i] = linkwire.FileMeta{Name: fmt.Sprint(i), Size: 1}
	}
	if _, err := l.a.s.OfferFiles(many); err == nil {
		t.Fatal("1001 files offered")
	}
	if _, err := l.a.s.OfferFiles([]linkwire.FileMeta{{Name: strings.Repeat("n", linkwire.MaxNameBytes+1)}}); err == nil {
		t.Fatal("oversize name offered")
	}
	if _, err := l.a.s.OfferFiles(many[:linkwire.MaxFiles]); err != nil {
		t.Fatalf("1000 files refused: %v", err)
	}
	// an inbound manifest past the bound fails the lane (sealed by the peer's
	// real key, so only the manifest check can refuse it)
	x := openLoop(t, CmdPair, CmdPair)
	var sb strings.Builder
	sb.WriteString(`{"files":[`)
	for i := 0; i <= linkwire.MaxFiles; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"name":"%d","size":1}`, i)
	}
	sb.WriteString(`]}`)
	seq := x.a.s.lk.fileRx.ExpectedSeq()
	ct, err := linkcrypto.Seal(x.b.s.lk.keys.Send(), seq, []byte(sb.String()))
	if err != nil {
		t.Fatal(err)
	}
	frame := append([]byte{linkwire.KindBatchEnc, 0, 0, 0, 0}, ct...)
	binary.BigEndian.PutUint32(frame[1:5], uint32(seq))
	x.on(x.a)(x.a.s.FileFrame(x.a.s.Epoch(), frame))
	wantStates(t, x.a, "Ended", "Idle")
	if count(x.a.effs, EffPromptFiles, -1) != 0 {
		t.Fatal("oversize manifest prompted")
	}
}

// ---------------------------------------------------------------- text lane

func TestBoundTextConsentEndAckIdle(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.b.s.authz.Text = PolicyPrompt // make b ask, so a waits for consent
	l.on(l.a)(l.a.s.RequestText())
	l.tick(TextConsent - ns)
	wantStates(t, l.a, "", "WaitAccept")
	l.tick(ns)
	if count(l.a.effs, EffSendText, int(linkwire.CtrlTextEnd)) != 1 {
		t.Fatalf("consent expiry did not END: %s", kinds(l.a.effs))
	}

	x := openLoop(t, CmdPair, CmdPair)
	x.on(x.a)(x.a.s.RequestText())
	x.dropLanes = true
	x.on(x.a)(x.a.s.EndText())
	x.clk.Advance(TextEndAckWait - ns)
	x.on(x.a)(x.a.s.Tick())
	wantStates(t, x.a, "", "EndWait")
	x.clk.Advance(ns)
	x.on(x.a)(x.a.s.Tick())
	if !hasReport(x.a.effs, "end-unacknowledged(codecs-not-reusable)") {
		t.Fatalf("END ack: %s", kinds(x.a.effs))
	}

	y := openLoop(t, CmdPair, CmdPair)
	y.on(y.a)(y.a.s.RequestText())
	y.tick(TextIdle - ns)
	wantStates(t, y.a, "", "Open")
	y.tick(ns)
	wantStates(t, y.a, "", "Idle") // END sent at idle, acknowledged
	wantStates(t, y.b, "", "Idle")
}

func TestBoundTextRateSessionBuffer(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.on(l.a)(l.a.s.RequestText())
	for i := 0; i < TextRateBurst; i++ {
		l.on(l.b)(l.b.s.SendText([]byte("m"), 0))
	}
	wantStates(t, l.a, "", "Open")
	l.clk.Advance(time.Second) // refills TextRatePerSecond tokens
	for i := 0; i < TextRatePerSecond; i++ {
		l.on(l.b)(l.b.s.SendText([]byte("m"), 0))
	}
	wantStates(t, l.a, "", "Open")
	l.on(l.b)(l.b.s.SendText([]byte("m"), 0))
	if !hasReport(l.a.effs, "flooding") || len(l.a.texts) != TextRateBurst+TextRatePerSecond {
		t.Fatalf("rate: delivered %d, %s", len(l.a.texts), kinds(l.a.effs[len(l.a.effs)-3:]))
	}

	// 500 messages per conversation
	x := openLoop(t, CmdPair, CmdPair)
	x.on(x.a)(x.a.s.RequestText())
	for i := 0; i < TextSessionMsgs; i++ {
		x.clk.Advance(time.Second / TextRatePerSecond)
		x.on(x.b)(x.b.s.SendText([]byte("m"), 0))
	}
	wantStates(t, x.a, "", "Open")
	x.clk.Advance(time.Second)
	x.on(x.b)(x.b.s.SendText([]byte("m"), 0))
	if len(x.a.texts) != TextSessionMsgs || !hasReport(x.a.effs, "session-limit") {
		t.Fatalf("message bound: %d", len(x.a.texts))
	}

	// 4 MiB per conversation
	y := openLoop(t, CmdPair, CmdPair)
	y.on(y.a)(y.a.s.RequestText())
	big := make([]byte, linkwire.TextMaxBytes)
	n := 0
	for n+len(big) <= TextSessionBytes {
		y.clk.Advance(time.Second / TextRatePerSecond)
		y.on(y.b)(y.b.s.SendText(big, 0))
		n += len(big)
	}
	wantStates(t, y.a, "", "Open")
	y.clk.Advance(time.Second)
	y.on(y.b)(y.b.s.SendText(big, 0))
	if !hasReport(y.a.effs, "session-limit") || len(y.a.texts) != TextSessionBytes/linkwire.TextMaxBytes {
		t.Fatalf("byte bound: %d delivered", len(y.a.texts))
	}

	// send buffer 1 MiB and oversize: refused before sealing, no seq burned
	z := openLoop(t, CmdPair, CmdPair)
	z.on(z.a)(z.a.s.RequestText())
	seq := z.a.s.lk.textTx.NextSeq()
	if _, err := z.a.s.SendText([]byte("x"), TextSendBufferMax); !errors.Is(err, ErrTextBackpressure) {
		t.Fatalf("buffer: %v", err)
	}
	if _, err := z.a.s.SendText(make([]byte, linkwire.TextMaxBytes+1), 0); !errors.Is(err, ErrTextTooLong) {
		t.Fatalf("oversize: %v", err)
	}
	if _, err := z.a.s.SendText([]byte{0xff}, 0); err == nil {
		t.Fatal("invalid UTF-8 sealed")
	}
	if z.a.s.lk.textTx.NextSeq() != seq {
		t.Fatal("a refused message burned a sequence number")
	}
	wantStates(t, z.a, "", "Open")
}
