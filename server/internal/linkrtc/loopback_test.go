package linkrtc

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkwire"
)

// L1: both lanes open by exact tuple, the budget is clamped to the local
// ceiling (Pion's peer advertises 262 144 here, not 1 GiB), the selected
// host↔host loopback pair is "lan", whole-chunk frames move both ways on both
// lanes, and an over-budget frame is refused before the transport.
func TestLoopbackLanesOpenAndCarryFrames(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	ba, bb := open(t, a, b)
	want := Budget{MaxFrameBytes: LocalMaxMessageSize, PiecePlainBytes: linkwire.ChunkSize, TextPlainLimit: linkwire.TextMaxBytes}
	if ba != want || bb != want {
		t.Fatalf("budgets %+v / %+v, want %+v", ba, bb, want)
	}
	if got := sdpAttr(b.c.pc.RemoteDescription().SDP, "max-message-size"); got != "262144" {
		t.Fatalf("initiator advertised max-message-size %q, want 262144", got)
	}

	if err := a.c.Write(LaneFile, []byte{1}); !errors.Is(err, ErrNotAttached) {
		t.Fatalf("write before attach: %v, want ErrNotAttached", err)
	}
	sa, sb := newSink(), newSink()
	sa.attach(t, a.c)
	sb.attach(t, b.c)
	if err := a.c.Attach(sa.handler(LaneFile), sa.handler(LaneText)); !errors.Is(err, ErrAttached) {
		t.Fatalf("second attach: %v", err)
	}

	chunk := bytes.Repeat([]byte{0x5a}, linkwire.ChunkSize+linkwire.ChunkOverhead) // 196 629
	text := bytes.Repeat([]byte{0x33}, linkwire.TextMaxBytes+linkwire.ChunkOverhead)
	for _, w := range []struct {
		from *peer
		lane Lane
		data []byte
	}{{a, LaneFile, chunk}, {a, LaneText, text}, {b, LaneFile, chunk}, {b, LaneText, text}, {a, LaneFile, []byte{}}} {
		if err := w.from.c.Write(w.lane, w.data); err != nil {
			t.Fatalf("%s write %s: %v", w.from.name, w.lane, err)
		}
	}
	gotB := sb.waitN(t, 3, 10*time.Second)
	gotA := sa.waitN(t, 2, 10*time.Second)
	check := func(who string, got []capturedFrame, lane Lane, want ...[]byte) {
		t.Helper()
		var on [][]byte
		for _, f := range got {
			if f.lane == lane {
				on = append(on, f.data)
			}
		}
		if len(on) != len(want) {
			t.Fatalf("%s %s: %d frames, want %d", who, lane, len(on), len(want))
		}
		for i := range want {
			if !bytes.Equal(on[i], want[i]) {
				t.Fatalf("%s %s frame %d: %d bytes, corrupted or reordered", who, lane, i, len(on[i]))
			}
		}
	}
	check("responder", gotB, LaneFile, chunk, []byte{})
	check("responder", gotB, LaneText, text)
	check("initiator", gotA, LaneFile, chunk)
	check("initiator", gotA, LaneText, text)

	if err := a.c.Write(LaneFile, make([]byte, LocalMaxMessageSize+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("over-budget write: %v, want ErrFrameTooLarge", err)
	}

	for _, p := range []*peer{a, b} {
		info, err := p.c.SelectedPath()
		if err != nil || info.Path != PathLAN || info.LocalType != "host" || info.RemoteType != "host" {
			t.Fatalf("%s selected path %+v err=%v, want lan host/host", p.name, info, err)
		}
		if ev := p.waitFor(EventPathChanged, 5*time.Second); ev.Path.Path != PathLAN {
			t.Fatalf("%s PathChanged %+v", p.name, ev.Path)
		}
		if n := p.count(EventLaneBad) + p.count(EventTransportLost) + p.count(EventCaptureOverflow); n != 0 {
			t.Fatalf("%s unexpected failure events: %v", p.name, p.kinds())
		}
	}
}

// Link §2.1: a channel outside the tuple, a duplicate, and a non-reliable
// lane are closed on their own (LaneBad) while the required pair still opens;
// a lane the responder opens towards the initiator is refused the same way.
func TestExactLaneTupleCollection(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	zero := uint16(0)
	unordered := false
	if _, err := a.c.pc.CreateDataChannel("relayium-extra", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := a.c.pc.CreateDataChannel("relayium-text", nil); err != nil { // duplicate
		t.Fatal(err)
	}
	if _, err := a.c.pc.CreateDataChannel("relayium", &webrtc.DataChannelInit{Ordered: &unordered, MaxRetransmits: &zero}); err != nil {
		t.Fatal(err)
	}
	open(t, a, b)
	deadline := time.Now().Add(10 * time.Second)
	for b.count(EventLaneBad) < 3 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	var got []string
	for _, e := range b.events(EventLaneBad) {
		got = append(got, e.Label+": "+strings.TrimPrefix(e.Err.Error(), ErrLaneProtocol.Error()+": "))
	}
	sort.Strings(got)
	want := []string{
		"relayium-extra: label outside the lane tuple",
		"relayium-text: duplicate lane",
		"relayium: lane is not ordered and reliable",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("responder LaneBad = %q, want %q", got, want)
	}

	// Responder-created lane towards the initiator (no renegotiation needed:
	// the SCTP association exists).
	if _, err := b.c.pc.CreateDataChannel("relayium", nil); err != nil {
		t.Fatal(err)
	}
	if e := a.waitFor(EventLaneBad, 10*time.Second); e.Label != "relayium" || !strings.Contains(e.Err.Error(), "responder opened a lane") {
		t.Fatalf("initiator LaneBad = %+v", e)
	}
	// The link itself is unaffected.
	sa, sb := newSink(), newSink()
	sa.attach(t, a.c)
	sb.attach(t, b.c)
	if err := a.c.Write(LaneText, []byte("still up")); err != nil {
		t.Fatal(err)
	}
	if f := sb.waitN(t, 1, 5*time.Second); string(f[0].data) != "still up" || f[0].lane != LaneText {
		t.Fatalf("after LaneBad: %+v", f)
	}
	if a.count(EventTransportLost)+b.count(EventTransportLost) != 0 {
		t.Fatal("LaneBad must not end the transport")
	}
}

// Link §2.2: frames that arrive before Attach are captured on both lanes and
// replayed in arrival order before any live frame.
func TestCaptureReplaysInArrivalOrderBeforeLiveFrames(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	open(t, a, b)
	sa := newSink()
	sa.attach(t, a.c)
	var sent []capturedFrame
	for i := range 6 {
		lane := Lane(i % 2)
		f := []byte(fmt.Sprintf("%s-%d", lane, i))
		sent = append(sent, capturedFrame{lane, f})
		if err := a.c.Write(lane, f); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for n, _ := capturedCount(b.c); n < 6; n, _ = capturedCount(b.c) {
		if time.Now().After(deadline) {
			t.Fatalf("responder captured %d frames, want 6", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	b.c.mu.Lock()
	arrival := append([]capturedFrame(nil), b.c.captured...)
	b.c.mu.Unlock()

	sb := newSink()
	// A live frame racing the replay must still come after it.
	go func() { _ = a.c.Write(LaneFile, []byte("live")) }()
	sb.attach(t, b.c)
	got := sb.waitN(t, 7, 5*time.Second)
	for i := range arrival {
		if got[i].lane != arrival[i].lane || !bytes.Equal(got[i].data, arrival[i].data) {
			t.Fatalf("replay[%d] = %s %q, arrival was %s %q", i, got[i].lane, got[i].data, arrival[i].lane, arrival[i].data)
		}
	}
	if string(got[6].data) != "live" {
		t.Fatalf("live frame delivered at the wrong position: %q", got[6].data)
	}
	// Per-lane order equals send order.
	for _, lane := range []Lane{LaneFile, LaneText} {
		var s, g []string
		for _, f := range sent {
			if f.lane == lane {
				s = append(s, string(f.data))
			}
		}
		for _, f := range got[:6] {
			if f.lane == lane {
				g = append(g, string(f.data))
			}
		}
		if fmt.Sprint(s) != fmt.Sprint(g) {
			t.Fatalf("%s order %v, sent %v", lane, g, s)
		}
	}
}

// Overflow of the 256 KiB combined capture is fail-closed: an event, and
// Attach refuses, rather than dropping a frame the peer already counted.
func TestCaptureOverflowFailsClosed(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	open(t, a, b)
	newSink().attach(t, a.c)
	big := make([]byte, linkwire.ChunkSize+linkwire.ChunkOverhead)
	if err := a.c.Write(LaneFile, big); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Write(LaneText, make([]byte, 70*1024)); err != nil { // 196 629 + 71 680 > 262 144
		t.Fatal(err)
	}
	b.waitFor(EventCaptureOverflow, 10*time.Second)
	if err := b.c.Attach(func([]byte) {}, func([]byte) {}); !errors.Is(err, ErrCaptureOverflow) {
		t.Fatalf("attach after overflow: %v", err)
	}
	if n, bytes := capturedCount(b.c); n != 0 || bytes != 0 {
		t.Fatalf("capture retained after overflow: %d frames %d bytes", n, bytes)
	}
}

// A09-DESIGN §2.3: against a peer that advertises 65 536, the budget is
// 65 536 and the text limit 65 515. A 65 515-byte message seals to exactly
// 65 536 and arrives; 65 516 is refused before seal, and its 65 537-byte
// frame would be refused by linkrtc before the transport anyway.
func TestForced65536PeerTextBoundary(t *testing.T) {
	a, b := newPair(t, pairOpts{
		apiB: testAPI(t, func(o *Options) { o.maxMessageSize = 65536 }),
		maxB: 65536,
	})
	ba, bb := open(t, a, b)
	want := Budget{MaxFrameBytes: 65536, PiecePlainBytes: 65536 - linkwire.ChunkOverhead, TextPlainLimit: 65515}
	if ba != want || bb != want {
		t.Fatalf("budgets %+v / %+v, want %+v", ba, bb, want)
	}
	if got := sdpAttr(a.c.pc.RemoteDescription().SDP, "max-message-size"); got != "65536" {
		t.Fatalf("responder advertised %q", got)
	}
	sb := newSink()
	newSink().attach(t, a.c)
	sb.attach(t, b.c)

	key := bytes.Repeat([]byte{7}, 32)
	snd, err := linkwire.NewTextSender(key)
	if err != nil {
		t.Fatal(err)
	}
	rcv, err := linkwire.NewTextReceiver(key)
	if err != nil {
		t.Fatal(err)
	}
	msg := strings.Repeat("a", 65515)
	if !ba.FitsText(len(msg)) {
		t.Fatal("65 515 must fit")
	}
	f, err := snd.Seal([]byte(msg))
	if err != nil || len(f) != 65536 {
		t.Fatalf("sealed %d bytes err=%v", len(f), err)
	}
	if err := a.c.Write(LaneText, f); err != nil {
		t.Fatalf("65 536-byte frame: %v", err)
	}
	got := sb.waitN(t, 1, 10*time.Second)
	if s, err := rcv.Open(got[0].data); err != nil || s != msg {
		t.Fatalf("open: %d bytes err=%v", len(s), err)
	}
	if ba.FitsText(65516) {
		t.Fatal("65 516 must be refused before seal")
	}
	tooBig, err := (&linkwire.TextSender{}).Seal(make([]byte, 65516)) // zero key: shape only
	if err == nil {
		if werr := a.c.Write(LaneText, tooBig); !errors.Is(werr, ErrFrameTooLarge) {
			t.Fatalf("65 537-byte frame: %v, want ErrFrameTooLarge", werr)
		}
	}
	if werr := a.c.Write(LaneText, make([]byte, 65537)); !errors.Is(werr, ErrFrameTooLarge) {
		t.Fatalf("65 537-byte frame: %v, want ErrFrameTooLarge", werr)
	}
}

// Link §2.1 send pacing: a writer that outruns a stalled reader blocks once
// the lane's SCTP buffer passes the 8 MiB low-water mark, and resumes when
// the reader drains.
func TestWriteBackpressure(t *testing.T) {
	if testing.Short() {
		t.Skip("moves ~24 MiB")
	}
	a, b := newPair(t, pairOpts{})
	open(t, a, b)
	newSink().attach(t, a.c)
	gate := make(chan struct{})
	var received atomic.Int64
	if err := b.c.Attach(func(f []byte) {
		<-gate
		received.Add(int64(len(f)))
	}, func([]byte) {}); err != nil {
		t.Fatal(err)
	}
	frame := make([]byte, linkwire.ChunkSize+linkwire.ChunkOverhead)
	const frames = 128 // ~24 MiB
	var written atomic.Int64
	done := make(chan error, 1)
	go func() {
		for range frames {
			if err := a.c.Write(LaneFile, frame); err != nil {
				done <- err
				return
			}
			written.Add(int64(len(frame)))
		}
		done <- nil
	}()
	time.Sleep(2 * time.Second)
	w := written.Load()
	buffered := a.c.dcs[LaneFile].BufferedAmount()
	t.Logf("while stalled: written=%d buffered=%d", w, buffered)
	if w >= frames*int64(len(frame)) {
		t.Fatal("writer never blocked against a stalled reader")
	}
	if buffered > SendLowWaterBytes+uint64(len(frame)) {
		t.Fatalf("buffered %d exceeds low-water mark + one frame", buffered)
	}
	close(gate)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(60 * time.Second):
		t.Fatalf("writer did not resume: written=%d", written.Load())
	}
	deadline := time.Now().Add(60 * time.Second)
	for received.Load() < frames*int64(len(frame)) {
		if time.Now().After(deadline) {
			t.Fatalf("received %d of %d", received.Load(), frames*len(frame))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Link §5.2: ICE restart is initiator-only and once; after it the link still
// carries frames on a new ICE generation.
func TestICERestartOnce(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	open(t, a, b)
	sa, sb := newSink(), newSink()
	sa.attach(t, a.c)
	sb.attach(t, b.c)
	if err := b.c.RestartICE(); !errors.Is(err, ErrWrongRole) {
		t.Fatalf("responder restart: %v", err)
	}
	firstUfrag := sdpAttr(a.c.pc.LocalDescription().SDP, "ice-ufrag")
	if err := a.c.RestartICE(); err != nil {
		t.Fatal(err)
	}
	if err := a.c.RestartICE(); !errors.Is(err, ErrRestartUsed) {
		t.Fatalf("second restart: %v", err)
	}
	// Wait for the restart answer to land.
	deadline := time.Now().Add(10 * time.Second)
	for len(b.events(EventLocalDescription)) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("no restart answer: %v", b.kinds())
		}
		time.Sleep(20 * time.Millisecond)
	}
	for a.c.pc.RemoteDescription() == nil || sdpAttr(a.c.pc.RemoteDescription().SDP, "ice-ufrag") ==
		sdpAttr(b.events(EventLocalDescription)[0].Description.SDP, "ice-ufrag") {
		if time.Now().After(deadline) {
			t.Fatal("restart answer not applied")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if newUfrag := sdpAttr(a.c.pc.LocalDescription().SDP, "ice-ufrag"); newUfrag == firstUfrag {
		t.Fatal("restart offer kept the old ufrag")
	}
	if a.events(EventLocalDescription)[1].Description.Type != webrtc.SDPTypeOffer {
		t.Fatal("restart did not signal an offer")
	}
	time.Sleep(500 * time.Millisecond)
	if err := a.c.Write(LaneFile, []byte("after restart")); err != nil {
		t.Fatal(err)
	}
	if err := b.c.Write(LaneText, []byte("back")); err != nil {
		t.Fatal(err)
	}
	if f := sb.waitN(t, 1, 10*time.Second); string(f[0].data) != "after restart" {
		t.Fatalf("%q", f[0].data)
	}
	if f := sa.waitN(t, 1, 10*time.Second); string(f[0].data) != "back" {
		t.Fatalf("%q", f[0].data)
	}
	if info, err := a.c.SelectedPath(); err != nil || info.Path != PathLAN {
		t.Fatalf("after restart: %+v %v", info, err)
	}
	if a.count(EventTransportLost)+b.count(EventTransportLost) != 0 {
		t.Fatalf("transport lost across restart: %v / %v", a.kinds(), b.kinds())
	}
}

// Candidates that arrive before the remote description are held and added
// once it is applied (the Web's holdRemoteCandidate); the offer SDP carries no
// candidates, so the link opening proves the flush happened.
func TestEarlyRemoteCandidatesAreHeldThenFlushed(t *testing.T) {
	a, b := newPair(t, pairOpts{holdA: true})
	gathered := webrtc.GatheringCompletePromise(a.c.pc)
	if err := a.c.Offer(); err != nil {
		t.Fatal(err)
	}
	<-gathered
	time.Sleep(100 * time.Millisecond)
	a.mu.Lock()
	held := a.holdBuf
	a.holdBuf = nil
	a.hold = false
	a.mu.Unlock()
	if len(held) < 2 || held[0].Kind != EventLocalDescription {
		t.Fatalf("expected description then candidates, got %d events", len(held))
	}
	if strings.Contains(held[0].Description.SDP, "a=candidate:") {
		t.Fatal("offer already carries candidates; test would prove nothing")
	}
	for _, e := range held[1:] {
		a.forward(e) // candidates first
	}
	if n := len(b.c.heldRemote); n != len(held)-1 {
		t.Fatalf("responder holds %d candidates, want %d", n, len(held)-1)
	}
	a.forward(held[0]) // then the offer
	a.waitFor(EventLanesOpen, 20*time.Second)
	b.waitFor(EventLanesOpen, 20*time.Second)
	var keys []string
	for _, e := range b.events(EventProgress) {
		keys = append(keys, e.Key)
	}
	if len(keys) == 0 || keys[0] != "sdp:offer" || !strings.Contains(strings.Join(keys, ","), "ice:0") {
		t.Fatalf("responder progress keys %v", keys)
	}
}

func TestHeldCandidateOverflowFailsTransport(t *testing.T) {
	_, b := newPair(t, pairOpts{})
	cand := webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host"}
	for i := range MaxHeldCandidates {
		if err := b.c.AddICE(cand); err != nil {
			t.Fatalf("held #%d: %v", i, err)
		}
	}
	if err := b.c.AddICE(cand); !errors.Is(err, ErrHeldCandidates) {
		t.Fatalf("overflow: %v", err)
	}
	if e := b.waitFor(EventTransportLost, 5*time.Second); !errors.Is(e.Err, ErrHeldCandidates) {
		t.Fatalf("TransportLost cause %v", e.Err)
	}
}

// Link §5.2 timers: no-progress fires without progress; the hard cap fires
// even while progress keeps coming; accepted ICE progress counts at most six;
// nothing fires after the lanes opened.
func TestSetupTimers(t *testing.T) {
	t.Run("no-progress", func(t *testing.T) {
		_, b := newPair(t, pairOpts{noProg: 200 * time.Millisecond, hard: 5 * time.Second})
		b.waitFor(EventSetupNoProgress, 3*time.Second)
		time.Sleep(300 * time.Millisecond)
		if b.count(EventSetupHardCap) != 0 || b.count(EventSetupNoProgress) != 1 {
			t.Fatalf("events %v", b.kinds())
		}
	})
	t.Run("hard-cap", func(t *testing.T) {
		_, b := newPair(t, pairOpts{noProg: 5 * time.Second, hard: 200 * time.Millisecond})
		b.waitFor(EventSetupHardCap, 3*time.Second)
	})
	t.Run("ice-progress-cap", func(t *testing.T) {
		a, b := newPair(t, pairOpts{holdA: true, noProg: 30 * time.Second})
		if err := a.c.Offer(); err != nil {
			t.Fatal(err)
		}
		offer := a.waitFor(EventLocalDescription, 5*time.Second)
		if err := b.c.SetRemote(*offer.Description); err != nil {
			t.Fatal(err)
		}
		// The same candidate ten times: a count, not a de-duplication.
		cand := webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host"}
		for range 10 {
			if err := b.c.AddICE(cand); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(100 * time.Millisecond)
		var ice []string
		for _, e := range b.events(EventProgress) {
			if strings.HasPrefix(e.Key, "ice:") {
				ice = append(ice, e.Key)
			}
		}
		if fmt.Sprint(ice) != "[ice:0 ice:1 ice:2 ice:3 ice:4 ice:5]" {
			t.Fatalf("ice progress %v", ice)
		}
	})
	t.Run("cleared-on-open", func(t *testing.T) {
		a, b := newPair(t, pairOpts{noProg: 1500 * time.Millisecond, hard: 2 * time.Second})
		open(t, a, b)
		time.Sleep(2500 * time.Millisecond)
		for _, p := range []*peer{a, b} {
			if p.count(EventSetupNoProgress)+p.count(EventSetupHardCap) != 0 {
				t.Fatalf("%s: setup timer fired after open: %v", p.name, p.kinds())
			}
		}
	})
}

// Close is final: no event after it, writes refuse, and it is idempotent.
func TestCloseIsFinal(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	open(t, a, b)
	newSink().attach(t, a.c)
	a.c.Close()
	a.c.Close()
	n := len(a.kinds())
	if err := a.c.Write(LaneFile, []byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after close: %v", err)
	}
	b.waitFor(EventTransportLost, 30*time.Second) // the peer sees its transport end
	time.Sleep(200 * time.Millisecond)
	if len(a.kinds()) != n {
		t.Fatalf("events after Close: %v", a.kinds()[n:])
	}
}

func sdpAttr(sdp, key string) string {
	for _, l := range strings.Split(sdp, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "a="+key+":"); ok {
			return v
		}
	}
	return ""
}
