package linksession

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/linkwire"
)

// fakeClock is the injected clock every test drives by hand.
type fakeClock struct{ t time.Time }

func newClock() *fakeClock                   { return &fakeClock{t: time.Unix(1_800_000_000, 0)} }
func (c *fakeClock) Now() time.Time          { return c.t }
func (c *fakeClock) Advance(d time.Duration) { c.t = c.t.Add(d) }

// seededRand is a deterministic key source so failures reproduce.
type seededRand struct{ r *rand.ChaCha8 }

func newRand(seed byte) *seededRand {
	var s [32]byte
	for i := range s {
		s[i] = seed + byte(i)
	}
	return &seededRand{rand.NewChaCha8(s)}
}
func (r *seededRand) Read(p []byte) (int, error) { return r.r.Read(p) }

// ---------------------------------------------------------------- loopback harness

// end is one side of a loopback pair.
type end struct {
	name string
	s    *Session
	effs []Effect // every effect this side produced, in order
	// sink state
	written map[uint64]map[int][]byte
	texts   []string
	// manual durability: when true, WriteChunk is NOT reported durable
	holdDurable bool
	pendingDur  uint64
	autoLanes   bool
}

type delivery struct {
	to   *end
	from *end
	kind string // signal | file | text | lanes
	raw  []byte
	ep   Epoch // epoch captured at SEND time for lane frames (a stale transport keeps its epoch)
}

// loop wires two sessions through an in-order signalling relay and an
// in-order two-lane transport. Nothing here re-implements the protocol: it
// only moves bytes and plays the transport's "lanes open" callback.
type loop struct {
	t          testing.TB
	clk        *fakeClock
	a, b       *end
	q          []delivery
	lanesFirst bool // deliver LanesOpen before the reveals are processed
	opened     map[*end]bool
	dropLanes  bool // hold lane frames (used to model a stalled peer)
	held       []delivery
}

func newEnd(t testing.TB, clk *fakeClock, name string, cmd Cmd, verify bool, seed byte) *end {
	s, err := NewSession(Config{Cmd: cmd, Verify: verify, Clock: clk, Rand: newRand(seed)})
	if err != nil {
		t.Fatal(err)
	}
	return &end{name: name, s: s, written: map[uint64]map[int][]byte{}}
}

// newLoop builds a pair; aID < bID makes a the initiator.
func newLoop(t testing.TB, cmdA, cmdB Cmd, verifyA, verifyB bool) *loop {
	clk := newClock()
	return &loop{t: t, clk: clk, a: newEnd(t, clk, "a", cmdA, verifyA, 1), b: newEnd(t, clk, "b", cmdB, verifyB, 101), opened: map[*end]bool{}}
}

func (l *loop) other(e *end) *end {
	if e == l.a {
		return l.b
	}
	return l.a
}

func offerJSON(e Effect, typ string) []byte {
	b, _ := json.Marshal(map[string]any{
		"link":   true,
		"sdp":    map[string]string{"type": typ, "sdp": "v=0 fake " + typ},
		"commit": e.Commit,
		"caps":   e.Caps,
	})
	return b
}

// absorb records one side's effects and turns wire effects into deliveries.
func (l *loop) absorb(e *end, effs []Effect, err error) {
	l.t.Helper()
	_ = err
	peer := l.other(e)
	for _, f := range effs {
		e.effs = append(e.effs, f)
		switch f.Kind {
		case EffSendSignal:
			l.q = append(l.q, delivery{to: peer, from: e, kind: "signal", raw: f.Bytes})
		case EffSendOffer:
			l.q = append(l.q, delivery{to: peer, from: e, kind: "signal", raw: offerJSON(f, "offer")})
		case EffSendAnswer:
			l.q = append(l.q, delivery{to: peer, from: e, kind: "signal", raw: offerJSON(f, "answer")})
			// The transport connects once the answer is applied on both sides.
			if l.lanesFirst {
				l.q = append(l.q, delivery{to: e, kind: "lanes"}, delivery{to: peer, kind: "lanes"})
			}
		case EffSASReady:
			if !l.lanesFirst {
				l.q = append(l.q, delivery{to: e, kind: "lanes"})
			}
		case EffSendFile:
			l.q = append(l.q, delivery{to: peer, from: e, kind: "file", raw: f.Bytes, ep: peer.s.Epoch()})
		case EffSendText:
			l.q = append(l.q, delivery{to: peer, from: e, kind: "text", raw: f.Bytes, ep: peer.s.Epoch()})
		case EffWriteChunk:
			m := e.written[f.Prompt]
			if m == nil {
				m = map[int][]byte{}
				e.written[f.Prompt] = m
			}
			m[f.Index] = append(m[f.Index], f.Bytes...)
			e.pendingDur += uint64(len(f.Bytes))
			if !e.holdDurable {
				l.q = append(l.q, delivery{to: e, kind: "durable", raw: nil})
			}
		case EffAttachSink:
			e.pendingDur = 0
		case EffDeliverText:
			e.texts = append(e.texts, f.Text)
		}
	}
}

// start runs discovery: both see each other, hinted, on a hint-aware server.
func (l *loop) start() {
	l.startWith(RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true},
		RoomView{SelfID: "b", PeerID: "a", ServerHints: true, PeerHinted: true})
}

func (l *loop) startWith(va, vb RoomView) {
	effs, err := l.a.s.Room(l.a.s.Epoch(), va)
	l.absorb(l.a, effs, err)
	effs, err = l.b.s.Room(l.b.s.Epoch(), vb)
	l.absorb(l.b, effs, err)
	l.pump()
}

// pump delivers everything queued, in order, until quiet.
func (l *loop) pump() {
	l.t.Helper()
	for i := 0; len(l.q) > 0; i++ {
		if i > 200000 {
			l.t.Fatal("loop does not settle")
		}
		l.stepOne()
	}
}

// stepOne delivers the head of the queue.
func (l *loop) stepOne() {
	l.t.Helper()
	d := l.q[0]
	l.q = l.q[1:]
	if l.dropLanes && (d.kind == "file" || d.kind == "text") {
		l.held = append(l.held, d)
		return
	}
	var effs []Effect
	var err error
	switch d.kind {
	case "signal":
		effs, err = d.to.s.Signal(d.to.s.Epoch(), d.from.name, d.raw)
	case "lanes":
		if l.opened[d.to] {
			return
		}
		l.opened[d.to] = true
		effs, err = d.to.s.LanesOpen(d.to.s.Epoch())
	case "file":
		effs, err = d.to.s.FileFrame(d.ep, d.raw)
	case "text":
		effs, err = d.to.s.TextFrame(d.ep, d.raw)
	case "durable":
		if d.to.s.fileM != nil && d.to.s.fileM.State == FInRecv {
			effs, err = d.to.s.FileDurable(d.to.s.Epoch(), d.to.s.fin.received)
		}
	}
	l.absorb(d.to, effs, err)
}

// hold records one local call's effects on e WITHOUT pumping, so several
// sides can act "at once" before anything is delivered.
func (l *loop) hold(e *end) func([]Effect, error) {
	return func(effs []Effect, err error) { l.absorb(e, effs, err) }
}

// on returns a sink for one local call's results on e: it records the
// effects, pumps the loop and returns the call's error. Usage:
// l.on(e)(e.s.OfferFiles(files)).
func (l *loop) on(e *end) func([]Effect, error) error {
	return func(effs []Effect, err error) error {
		l.t.Helper()
		l.absorb(e, effs, err)
		l.pump()
		return err
	}
}

// tick advances the clock and ticks both sides.
func (l *loop) tick(d time.Duration) {
	l.t.Helper()
	l.clk.Advance(d)
	for _, e := range []*end{l.a, l.b} {
		effs, err := e.s.Tick()
		l.absorb(e, effs, err)
	}
	l.pump()
}

// open builds a pair with a and b both admitted and open.
func openLoop(t testing.TB, cmdA, cmdB Cmd) *loop {
	t.Helper()
	l := newLoop(t, cmdA, cmdB, false, false)
	l.start()
	for _, e := range []*end{l.a, l.b} {
		if e.s.linkM == nil || e.s.linkM.State != LOpen {
			t.Fatalf("%s link not open: %v", e.name, e.s)
		}
	}
	return l
}

// sendBatch drives a's outbound batch of files (payloads) through the real
// sender API: chunks of ChunkSize, DONE per file, then AllSent.
func (l *loop) sendBatch(e *end, payloads ...[]byte) {
	l.t.Helper()
	var files []linkwire.FileMeta
	for i, p := range payloads {
		files = append(files, linkwire.FileMeta{Name: fmt.Sprintf("f%d.bin", i), Size: uint64(len(p))})
	}
	if err := l.on(e)(e.s.OfferFiles(files)); err != nil {
		l.t.Fatalf("offer: %v", err)
	}
	l.pushData(e, payloads...)
}

func (l *loop) pushData(e *end, payloads ...[]byte) {
	l.t.Helper()
	if e.s.fileM.State != FOutSend {
		return // not consented (yet)
	}
	for _, p := range payloads {
		for off := 0; off < len(p); off += linkwire.ChunkSize {
			c := p[off:min(off+linkwire.ChunkSize, len(p))]
			if err := l.on(e)(e.s.SendChunk(c)); err != nil {
				l.t.Fatalf("chunk: %v", err)
			}
		}
		if err := l.on(e)(e.s.EndFile()); err != nil {
			l.t.Fatalf("done: %v", err)
		}
	}
}

// ---------------------------------------------------------------- effect helpers

func kinds(effs []Effect) string {
	var b strings.Builder
	for i, e := range effs {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(e.Kind.String())
		switch e.Kind {
		case EffSendFile, EffSendText:
			if len(e.Bytes) == 1 {
				fmt.Fprintf(&b, "(%#02x)", e.Bytes[0])
			} else if len(e.Bytes) > 0 {
				fmt.Fprintf(&b, "(k%d)", e.Bytes[0])
			}
		case EffReport, EffLinkClosed, EffSessionEnded:
			b.WriteString("(" + e.Code + ")")
		}
	}
	return b.String()
}

func count(effs []Effect, kind EffectKind, oneByte int) int {
	n := 0
	for _, e := range effs {
		if e.Kind != kind {
			continue
		}
		if oneByte >= 0 && !(len(e.Bytes) == 1 && int(e.Bytes[0]) == oneByte) {
			continue
		}
		n++
	}
	return n
}

func hasReport(effs []Effect, code string) bool {
	for _, e := range effs {
		if (e.Kind == EffReport || e.Kind == EffSessionEnded || e.Kind == EffLinkClosed) && e.Code == code {
			return true
		}
	}
	return false
}

func lastPrompt(effs []Effect, kind EffectKind) uint64 {
	for i := len(effs) - 1; i >= 0; i-- {
		if effs[i].Kind == kind {
			return effs[i].Prompt
		}
	}
	return 0
}

func payload(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = seed + byte(i*7)
	}
	return b
}

func sameBytes(a, b []byte) bool { return bytes.Equal(a, b) }
