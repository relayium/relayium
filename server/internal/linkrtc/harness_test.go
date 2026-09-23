package linkrtc

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// loopbackOnly keeps L1 candidates on 127.0.0.1/::1 so a host with a public
// IPv6 address cannot turn a "lan" expectation into "direct".
func loopbackOnly(ip net.IP) bool { return ip.IsLoopback() }

func testAPI(t *testing.T, mutate func(*Options)) *webrtc.API {
	t.Helper()
	o := Options{includeLoopback: true, ipFilter: loopbackOnly}
	if mutate != nil {
		mutate(&o)
	}
	api, err := NewAPI(o)
	if err != nil {
		t.Fatal(err)
	}
	return api
}

// peer is one side of an in-process link. Signals it emits are routed to its
// partner in emission order on its own dispatcher goroutine.
type peer struct {
	t     *testing.T
	name  string
	c     *Conn
	other *peer

	mu     sync.Mutex
	log    []Event
	notify chan struct{}
	// hold, when set, keeps outbound signals instead of forwarding them.
	hold    bool
	holdBuf []Event
}

func (p *peer) handle(e Event) {
	p.mu.Lock()
	p.log = append(p.log, e)
	hold := p.hold
	if hold && (e.Kind == EventLocalDescription || e.Kind == EventLocalCandidate) {
		p.holdBuf = append(p.holdBuf, e)
	}
	p.mu.Unlock()
	select {
	case p.notify <- struct{}{}:
	default:
	}
	if hold {
		return
	}
	p.forward(e)
}

func (p *peer) forward(e Event) {
	switch e.Kind {
	case EventLocalDescription:
		if err := p.other.c.SetRemote(*e.Description); err != nil && err != ErrClosed {
			p.t.Errorf("%s -> %s SetRemote: %v", p.name, p.other.name, err)
		}
	case EventLocalCandidate:
		_ = p.other.c.AddICE(*e.Candidate) // a rejected candidate is non-fatal by contract
	}
}

// waitFor returns the first event of kind at or after index from.
func (p *peer) waitFor(kind EventKind, d time.Duration) Event {
	p.t.Helper()
	deadline := time.After(d)
	for {
		p.mu.Lock()
		for _, e := range p.log {
			if e.Kind == kind {
				p.mu.Unlock()
				return e
			}
		}
		p.mu.Unlock()
		select {
		case <-p.notify:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			p.t.Fatalf("%s: no %s within %v; events: %v", p.name, kind, d, p.kinds())
		}
	}
}

func (p *peer) count(kind EventKind) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.log {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (p *peer) events(kind EventKind) []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []Event
	for _, e := range p.log {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

func (p *peer) kinds() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, e := range p.log {
		s := e.Kind.String()
		if e.Key != "" {
			s += "(" + e.Key + ")"
		}
		if e.Err != nil {
			s += "(" + e.Err.Error() + ")"
		}
		out = append(out, s)
	}
	return out
}

type pairOpts struct {
	apiA, apiB   *webrtc.API
	cfgA, cfgB   webrtc.Configuration
	maxA, maxB   uint32
	noProg, hard time.Duration
	holdA        bool
}

// newPair builds initiator a and responder b without starting signalling.
func newPair(t *testing.T, o pairOpts) (a, b *peer) {
	t.Helper()
	if o.apiA == nil {
		o.apiA = testAPI(t, nil)
	}
	if o.apiB == nil {
		o.apiB = testAPI(t, nil)
	}
	if o.noProg == 0 {
		o.noProg = noProgressTimeout
	}
	if o.hard == 0 {
		o.hard = setupHardCap
	}
	a = &peer{t: t, name: "initiator", notify: make(chan struct{}, 1), hold: o.holdA}
	b = &peer{t: t, name: "responder", notify: make(chan struct{}, 1)}
	a.other, b.other = b, a
	var err error
	if a.c, err = newConn(o.apiA, o.cfgA, Initiator, a.handle, o.maxA, o.noProg, o.hard); err != nil {
		t.Fatal(err)
	}
	if b.c, err = newConn(o.apiB, o.cfgB, Responder, b.handle, o.maxB, o.noProg, o.hard); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.c.Close(); b.c.Close() })
	return a, b
}

// open runs signalling until both sides report LanesOpen.
func open(t *testing.T, a, b *peer) (Budget, Budget) {
	t.Helper()
	if err := a.c.Offer(); err != nil {
		t.Fatal(err)
	}
	ea := a.waitFor(EventLanesOpen, 20*time.Second)
	eb := b.waitFor(EventLanesOpen, 20*time.Second)
	return ea.Budget, eb.Budget
}

// sink collects delivered frames per lane, in order.
type sink struct {
	mu     sync.Mutex
	order  []capturedFrame // both lanes, delivery order
	notify chan struct{}
}

func newSink() *sink { return &sink{notify: make(chan struct{}, 1)} }

func (s *sink) handler(l Lane) func([]byte) {
	return func(f []byte) {
		s.mu.Lock()
		s.order = append(s.order, capturedFrame{lane: l, data: f})
		s.mu.Unlock()
		select {
		case s.notify <- struct{}{}:
		default:
		}
	}
}

func (s *sink) attach(t *testing.T, c *Conn) {
	t.Helper()
	if err := c.Attach(s.handler(LaneFile), s.handler(LaneText)); err != nil {
		t.Fatal(err)
	}
}

func (s *sink) waitN(t *testing.T, n int, d time.Duration) []capturedFrame {
	t.Helper()
	deadline := time.After(d)
	for {
		s.mu.Lock()
		if len(s.order) >= n {
			out := append([]capturedFrame(nil), s.order...)
			s.mu.Unlock()
			return out
		}
		got := len(s.order)
		s.mu.Unlock()
		select {
		case <-s.notify:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatalf("delivered %d frames, want %d within %v", got, n, d)
		}
	}
}

func capturedCount(c *Conn) (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.captured), c.capturedBytes
}
