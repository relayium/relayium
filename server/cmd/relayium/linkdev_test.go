package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	turnv4 "github.com/pion/turn/v4"

	"github.com/relayium/relayium/internal/linkrtc"
	"github.com/relayium/relayium/internal/linksession"
	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/signal"
)

// The hidden `__link` command against the REAL signalling hub (signal.ServeWS,
// with the A08a roster hint), against a hub that predates the hint (a proxy
// that strips it), and against a real CLI binary built from 723481c78, the
// last commit before any link-pairing code: every release in the field speaks
// what that binary speaks.

const ldCode = "483920" // the test hub ignores the code; it must only be well-formed

// ldOldCommit is the old peer. Override with RELAYIUM_OLD_CLI=/path/to/binary.
const ldOldCommit = "723481c78"

// ldHub is the real hub in one pairing-code room (two members, hints honoured
// as on production). Ids are deterministic: peer1, peer2, ... in join order.
//
// It also serves /api/ice, because the link transport asks the same server
// for its ICE configuration (A09b). The handler is the test's; every request
// is counted and its code recorded, because the count IS the M1 assertion
// (credentials are issued to the code owner once per link end, never for a
// legacy pairing, never again after a denial).
type ldHub struct {
	url   string
	joins chan string

	ice      http.HandlerFunc
	iceMu    sync.Mutex
	iceCodes []string

	// Diagnostics only, read when a pairing overruns (ldAwait): a timeline of
	// joins and /api/ice requests, plus the relay's state when the test runs
	// one. Nothing here feeds an assertion.
	trail ldTrail
	diag  func() string
}

// ldTrail is a bounded, timestamped event log that is safe to read while the
// fixture is still writing it.
type ldTrail struct {
	mu     sync.Mutex
	t0     time.Time
	events []string
	lost   int
}

const ldTrailMax = 256

func (l *ldTrail) note(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.t0.IsZero() {
		l.t0 = now
	}
	if len(l.events) >= ldTrailMax {
		l.lost++
		return
	}
	l.events = append(l.events, fmt.Sprintf("+%.3fs ", now.Sub(l.t0).Seconds())+fmt.Sprintf(format, args...))
}

func (l *ldTrail) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, e := range l.events {
		b.WriteString("  " + e + "\n")
	}
	if l.lost > 0 {
		fmt.Fprintf(&b, "  (%d later events not kept)\n", l.lost)
	}
	if len(l.events) == 0 {
		b.WriteString("  (none)\n")
	}
	return b.String()
}

// diagnostics is the fixture's side of an overrun: what the hub saw and, when
// set, what the relay saw.
func (h *ldHub) diagnostics() string {
	var b strings.Builder
	b.WriteString("hub events (joins, /api/ice):\n" + h.trail.String())
	if h.diag != nil {
		b.WriteString(h.diag())
	}
	return b.String()
}

func (h *ldHub) iceHits() []string {
	h.iceMu.Lock()
	defer h.iceMu.Unlock()
	return append([]string(nil), h.iceCodes...)
}

// ldNoRelayICE is a code room the server issued nothing for: STUN-less, no
// TURN (the Web's "none").
func ldNoRelayICE(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"iceServers":[]}`))
}

func startLinkDevHub(t *testing.T) *ldHub { return startLinkDevHubICE(t, ldNoRelayICE) }

func startLinkDevHubICE(t *testing.T, ice http.HandlerFunc) *ldHub {
	t.Helper()
	h := &ldHub{joins: make(chan string, 16), ice: ice}
	hub := signal.NewHub()
	var seq int32
	handle := signal.ServeWSObserved(hub, func() string { return fmt.Sprintf("peer%d", atomic.AddInt32(&seq, 1)) },
		func(room, id string, peers int, members []string) {
			h.trail.note("join %s room=%s peers=%d members=%v", id, room, peers, members)
			h.joins <- id
		})
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "testroom", 2, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	mux.HandleFunc("/api/ice", func(w http.ResponseWriter, r *http.Request) {
		h.iceMu.Lock()
		h.iceCodes = append(h.iceCodes, r.URL.Query().Get("code"))
		h.iceMu.Unlock()
		h.trail.note("/api/ice code=%q from %s", r.URL.Query().Get("code"), r.RemoteAddr)
		h.ice(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	h.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	return h
}

// startLinkDevProxy is a TEST-ONLY WebSocket relay in front of the real hub.
//
//   - strip: deletes every `proto` from welcome and peers frames, i.e. a hub
//     that predates A08a (no echo, no roster hint).
//   - holdRoster: holds every `peers` frame toward its client until one
//     `signal` frame has passed, then releases them after it. That makes the
//     race the hub's roster debounce opens in production -- the peer's first
//     signal overtaking our roster -- happen on every run.
func startLinkDevProxy(t *testing.T, upstream string, strip, holdRoster bool) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		down, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer down.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		u := upstream + "/ws"
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		up, _, err := websocket.Dial(ctx, u, nil)
		if err != nil {
			return
		}
		defer up.Close(websocket.StatusNormalClosure, "")
		go func() {
			defer cancel()
			for {
				typ, b, err := down.Read(ctx)
				if err != nil {
					return
				}
				if err := up.Write(ctx, typ, b); err != nil {
					return
				}
			}
		}()
		var held [][]byte
		released := !holdRoster
		for {
			typ, b, err := up.Read(ctx)
			if err != nil {
				return
			}
			env, _ := signal.DecodeEnvelope(b)
			if strip && (env.Type == signal.TypeWelcome || env.Type == signal.TypePeers) {
				b = ldStripProto(b)
			}
			if !released && env.Type == signal.TypePeers {
				held = append(held, b)
				continue
			}
			if err := down.Write(ctx, typ, b); err != nil {
				return
			}
			if !released && env.Type == signal.TypeSignal {
				released = true
				for _, h := range held {
					if err := down.Write(ctx, websocket.MessageText, h); err != nil {
						return
					}
				}
				held = nil
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func ldStripProto(b []byte) []byte {
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return b
	}
	delete(m, "proto")
	if peers, ok := m["peers"].([]any); ok {
		for _, p := range peers {
			if pm, ok := p.(map[string]any); ok {
				delete(pm, "proto")
			}
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return b
	}
	return out
}

// ldOrder is the delivery order an ordered proxy (startLinkDevOrderedProxy)
// forces on the ONE end that dials it.
type ldOrder int

const (
	// ldOrderFree forwards every frame as it arrives.
	ldOrderFree ldOrder = iota
	// ldOrderHelloFirst holds the roster toward the end until the peer's first
	// signal has been delivered, so the end's JoinRoom captures that signal
	// before its room view is complete (room.Captured, linkdev.go run).
	ldOrderHelloFirst
	// ldOrderCommitFirst holds every peer signal toward the end until the end
	// has sent its own first signal, so a legacy end's commit is on the wire
	// before the peer's hello reaches it.
	ldOrderCommitFirst
)

// ldFrame is one frame an ordered proxy saw on one end's connection: which
// end, the direction ("down" hub→end written to the end, "held" hub→end
// kept back, "up" end→hub written to the hub; a frame is recorded "down" or
// "up" only after its write succeeded), the envelope type, for a signal its
// discovery class (never its payload), and for a roster its size.
type ldFrame struct {
	end, dir, typ, class string
	roster               int
}

func (f ldFrame) String() string {
	s := f.end + " " + f.dir + " " + f.typ
	if f.class != "" {
		s += " " + f.class
	}
	if f.typ == signal.TypePeers {
		s += fmt.Sprintf(" roster=%d", f.roster)
	}
	return s
}

// ldFrames is the ordered record of every frame the ordered proxies of one
// test saw, in the order each proxy delivered or forwarded it.
type ldFrames struct {
	mu sync.Mutex
	fs []ldFrame
}

func (l *ldFrames) add(f ldFrame) {
	l.mu.Lock()
	l.fs = append(l.fs, f)
	l.mu.Unlock()
}

// of is the record of one end's connection.
func (l *ldFrames) of(end string) []ldFrame {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []ldFrame
	for _, f := range l.fs {
		if f.end == end {
			out = append(out, f)
		}
	}
	return out
}

func (l *ldFrames) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for i, f := range l.fs {
		fmt.Fprintf(&b, "%3d %s\n", i, f)
	}
	return b.String()
}

// ldSignalClass names a signal payload by the discovery event it would be:
// the class only, so a record never holds a commitment, SDP or address.
func ldSignalClass(data json.RawMessage) string {
	switch linksession.ClassifySignal(data) {
	case linksession.DSigHelloLink:
		return "hello(link/1)"
	case linksession.DSigLegacyCommit:
		return "legacy-commit"
	case linksession.DSigLegacyOther:
		return "legacy-other"
	}
	return "other"
}

// ldFrameAt is the index of the first frame in fs with this direction and
// type (and class, when not empty), or -1.
func ldFrameAt(fs []ldFrame, dir, typ, class string) int {
	for i, f := range fs {
		if f.dir == dir && f.typ == typ && (class == "" || f.class == class) {
			return i
		}
	}
	return -1
}

// ldRosterAt is the index of the first roster delivered to the end that
// names both members, or -1.
func ldRosterAt(fs []ldFrame) int {
	for i, f := range fs {
		if f.dir == "down" && f.typ == signal.TypePeers && f.roster == 2 {
			return i
		}
	}
	return -1
}

// startLinkDevOrderedProxy is a TEST-ONLY WebSocket relay in front of the
// real hub for ONE end, as a hub that predates hints (every `proto` is
// stripped, as startLinkDevProxy's strip). It forces order on that end's
// connection and records every frame class into frames under the name end.
// It holds frames back and releases them; it never rewrites or invents one,
// and every frame it reads is forwarded unless a read or write error ends the
// connection (which then ends both directions).
func startLinkDevOrderedProxy(t *testing.T, upstream, end string, order ldOrder, frames *ldFrames) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		down, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer down.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		u := upstream + "/ws"
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		up, _, err := websocket.Dial(ctx, u, nil)
		if err != nil {
			return
		}
		defer up.Close(websocket.StatusNormalClosure, "")

		type heldFrame struct {
			typ websocket.MessageType
			b   []byte
			f   ldFrame
		}
		// mu orders every write toward the end with the hold state, so the
		// record is the delivery order.
		var (
			mu             sync.Mutex
			held           []heldFrame
			endSpoke       bool // the end has sent a signal (ldOrderCommitFirst)
			peerSignalSent bool // a peer signal was delivered (ldOrderHelloFirst)
		)
		classify := func(dir string, env signal.Envelope) ldFrame {
			f := ldFrame{end: end, dir: dir, typ: env.Type, roster: len(env.Peers)}
			if env.Type == signal.TypeSignal {
				f.class = ldSignalClass(env.Data)
			}
			return f
		}
		release := func() error { // mu held
			for _, h := range held {
				if err := down.Write(ctx, h.typ, h.b); err != nil {
					return err
				}
				h.f.dir = "down"
				frames.add(h.f)
			}
			held = nil
			return nil
		}
		go func() {
			defer cancel()
			for {
				typ, b, err := down.Read(ctx)
				if err != nil {
					return
				}
				env, _ := signal.DecodeEnvelope(b)
				mu.Lock()
				err = up.Write(ctx, typ, b)
				if err == nil {
					frames.add(classify("up", env))
					if order == ldOrderCommitFirst && !endSpoke && env.Type == signal.TypeSignal {
						endSpoke = true
						err = release()
					}
				}
				mu.Unlock()
				if err != nil {
					return
				}
			}
		}()
		for {
			typ, b, err := up.Read(ctx)
			if err != nil {
				return
			}
			env, _ := signal.DecodeEnvelope(b)
			if env.Type == signal.TypeWelcome || env.Type == signal.TypePeers {
				b = ldStripProto(b)
			}
			f := classify("down", env)
			mu.Lock()
			hold := (order == ldOrderHelloFirst && !peerSignalSent && env.Type == signal.TypePeers) ||
				(order == ldOrderCommitFirst && !endSpoke && env.Type == signal.TypeSignal)
			if hold {
				f.dir = "held"
				frames.add(f)
				f.dir = "down"
				held = append(held, heldFrame{typ, b, f})
				mu.Unlock()
				continue
			}
			err = down.Write(ctx, typ, b)
			if err == nil {
				frames.add(f)
			}
			if err == nil && order == ldOrderHelloFirst && !peerSignalSent && env.Type == signal.TypeSignal {
				peerSignalSent = true
				err = release()
			}
			mu.Unlock()
			if err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// ldPeer is one end: the new CLI in process (`__link <cmd>`), or the old
// binary as a real process (`<cmd>`).
type ldPeer struct {
	old  bool
	cmd  string
	args []string
	via  string // the server URL this end dials (hub or proxy)
}

type ldResult struct {
	code           int
	stdout, stderr string
}

func (r ldResult) String() string {
	return fmt.Sprintf("exit %d\n--- stderr\n%s--- stdout\n%s", r.code, r.stderr, r.stdout)
}

// ldBuf is an end's stdout or stderr: a bytes.Buffer behind a mutex, so a
// diagnostic can read what an end has written so far while it is still
// writing. The result an end returns is still the complete buffer, read after
// it finished, exactly as before.
type ldBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *ldBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *ldBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// ldLive is a running end's output so far.
type ldLive struct{ out, errb ldBuf }

// pending is the end as it stands while still running: code -9 and whatever
// it has written up to now.
func (l *ldLive) pending() ldResult {
	return ldResult{-9, l.out.String(), l.errb.String()}
}

func ldStart(ctx context.Context, t *testing.T, bin string, p ldPeer) <-chan ldResult {
	t.Helper()
	ch, _ := ldStartLive(ctx, t, bin, p)
	return ch
}

// ldStartLive is ldStart that also hands back the end's live output.
func ldStartLive(ctx context.Context, t *testing.T, bin string, p ldPeer) (<-chan ldResult, *ldLive) {
	t.Helper()
	ch := make(chan ldResult, 1)
	live := &ldLive{}
	if !p.old {
		argv := append([]string{"__link", p.cmd, "--server", p.via}, p.args...)
		go func() {
			code := Run(argv, &live.out, &live.errb)
			ch <- ldResult{code, live.out.String(), live.errb.String()}
		}()
		return ch, live
	}
	cmd := exec.CommandContext(ctx, bin, append([]string{p.cmd, "--server", p.via}, p.args...)...)
	out, errb := &live.out, &live.errb
	cmd.Stdout, cmd.Stderr = out, errb
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "XDG_CONFIG_HOME="+t.TempDir())
	if p.cmd == "text" {
		cmd.Stdin = strings.NewReader(ldOldText)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start old CLI: %v", err)
	}
	go func() {
		_ = cmd.Wait()
		ch <- ldResult{cmd.ProcessState.ExitCode(), out.String(), errb.String()}
	}()
	return ch, live
}

// ldPairUp runs first until the hub has admitted it, then second, and waits
// for both.
func ldPairUp(t *testing.T, hub *ldHub, bin string, first, second ldPeer) (ldResult, ldResult) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	a, la := ldStartLive(ctx, t, bin, first)
	select {
	case <-hub.joins:
	case <-ctx.Done():
		t.Fatal("first peer never joined")
	}
	b, lb := ldStartLive(ctx, t, bin, second)
	ra, rb, report, late := ldAwait(ctx, 5*time.Second, a, b, la, lb, hub.diagnostics)
	if late {
		t.Logf("%s", report)
		t.Fatalf("pairing did not end in time\nfirst: %s\nsecond: %s", ra, rb)
	}
	t.Logf("first:\n%s\nsecond:\n%s", ra, rb)
	return ra, rb
}

// ldAwait waits for both ends. When ctx expires first it gives them grace to
// finish (an old binary is killed by ctx; an in-process end cannot be), and
// returns late with each end's result -- or, for an end still running, code
// -9 and the output it had written so far -- and a diagnostic report: the
// fixture snapshots requested at the deadline and after the wait, and every
// goroutine's stack (bounded) while anything is still running. A pairing
// that ends in time returns the ends' own results untouched and no report.
//
// The grace starts the moment ctx expires, before any diagnostic work, and
// fixture snapshots are best-effort and asynchronous, off that path: each is
// REQUESTED at the labelled point, but the callback may take its snapshot
// later (scheduling, the fixture's own locks), so a section shows the state
// at some moment after its request, not exactly at it. A slow capture never
// moves the grace, and a capture whose result is not obtained within the
// shared ldFixtureWait budget after the wait is reported as unavailable
// rather than holding the failure back.
func ldAwait(ctx context.Context, grace time.Duration, a, b <-chan ldResult, la, lb *ldLive, fixture func() string) (ra, rb ldResult, report string, late bool) {
	ra, rb = ldResult{code: -9}, ldResult{code: -9} // -9: still running
	for i := 0; i < 2; i++ {
		select {
		case ra = <-a:
			a = nil
		case rb = <-b:
			b = nil
		case <-ctx.Done():
			after := time.After(grace)
			atDeadline := ldStartCapture(fixture)
			stuck := false
		wait:
			for a != nil || b != nil {
				select {
				case ra = <-a:
					a = nil
				case rb = <-b:
					b = nil
				case <-after:
					stuck = true
					break wait
				}
			}
			if stuck {
				if a != nil {
					ra = la.pending()
				}
				if b != nil {
					rb = lb.pending()
				}
			}
			// One bound for every capture still outstanding.
			bound, cancel := context.WithTimeout(context.Background(), ldFixtureWait)
			defer cancel()
			var r strings.Builder
			r.WriteString("=== link-dev pairing overran its deadline: diagnostics ===\n")
			atDeadline.section(&r, "fixture capture requested at the deadline", bound)
			if stuck {
				fmt.Fprintf(&r, "--- after %s grace: first still running=%t, second still running=%t\n", grace, a != nil, b != nil)
				ldStartCapture(fixture).section(&r, "fixture capture requested after the grace", bound)
				r.WriteString("--- goroutines\n" + ldStacks(ldStackMax))
			} else {
				fmt.Fprintf(&r, "--- both ends returned within the %s grace\n", grace)
				ldStartCapture(fixture).section(&r, "fixture capture requested after both ends returned", bound)
			}
			r.WriteString("=== end link-dev diagnostics ===")
			return ra, rb, r.String(), true
		}
	}
	return ra, rb, "", false
}

// ldFixtureWait is the shared budget an overrun report spends, after the
// ends' wait is over, waiting for fixture capture results not yet obtained.
const ldFixtureWait = time.Second

// ldCapture is one fixture capture running on its own goroutine; nil when
// the test has no fixture to capture.
type ldCapture struct{ ch chan string }

func ldStartCapture(fixture func() string) *ldCapture {
	if fixture == nil {
		return nil
	}
	c := &ldCapture{ch: make(chan string, 1)}
	go func() { c.ch <- fixture() }()
	return c
}

// section writes the capture's result under title, waiting for it until
// bound ends. If no result was obtained by then it is reported as
// unavailable; that says only that this report did not get a result within
// the budget (the select may even pick the expired bound when a result is
// ready at the same moment), not that the callback had not returned.
func (c *ldCapture) section(r *strings.Builder, title string, bound context.Context) {
	if c == nil {
		return
	}
	select {
	case s := <-c.ch:
		r.WriteString("--- " + title + "\n" + s)
	case <-bound.Done():
		fmt.Fprintf(r, "--- %s: unavailable (no capture result was obtained within the shared %s budget after the wait)\n", title, ldFixtureWait)
	}
}

// ldStackMax bounds the goroutine dump an overrun logs.
const ldStackMax = 1 << 20

// ldStacks is every goroutine's stack, at most max bytes of it.
func ldStacks(max int) string {
	buf := make([]byte, max)
	n := runtime.Stack(buf, true)
	s := string(buf[:n])
	if n == max {
		s += fmt.Sprintf("\n[goroutine dump truncated at %d bytes]\n", max)
	}
	return s
}

var ldSASLine = regexp.MustCompile(`verification code \(SAS\): (\S+)`)

func ldSAS(r ldResult) string {
	if m := ldSASLine.FindStringSubmatch(r.stderr); m != nil {
		return m[1]
	}
	return ""
}

// ldWantLink: discovery chose link/1 and the link ran to a clean end over the
// real transport (A09b): exit 0, a path reported from the selected pair, and
// never the legacy handshake.
func ldWantLink(t *testing.T, who string, r ldResult, serverHints bool) {
	t.Helper()
	if r.code != 0 || !strings.Contains(r.stderr, "link-dev: link admitted") {
		t.Errorf("%s: want a completed link (exit 0)\n%s", who, r)
	}
	if want := fmt.Sprintf("serverHints=%t", serverHints); !strings.Contains(r.stderr, want) {
		t.Errorf("%s: room view lacks %q\n%s", who, want, r)
	}
	if strings.Contains(r.stderr, "legacy handshake") {
		t.Errorf("%s: a link outcome must not run the legacy handshake\n%s", who, r)
	}
	if !ldPathLine.MatchString(r.stderr) {
		t.Errorf("%s: no path line from the selected pair\n%s", who, r)
	}
}

var ldPathLine = regexp.MustCompile(`(?m)^path: (relay|lan|direct) \(selected pair local=(\w+) remote=(\w+) (\w+)\)$`)

// ldPaths lists every path a run reported, in order.
func ldPaths(r ldResult) []string {
	var out []string
	for _, m := range ldPathLine.FindAllStringSubmatch(r.stderr, -1) {
		out = append(out, m[1])
	}
	return out
}

// ldWantLegacy: both ends completed today's commit/reveal handshake with each
// other -- the same SAS on both, which only a completed commit/reveal with the
// right fingerprints produces -- and then ran today's direct race.
//
// The race itself is out of A08d's scope and is NOT asserted beyond "ended
// with status 0 or 1": between two processes on one host that has TUN or CGNAT
// addresses (a VPN, Tailscale) today's RaceDirect loses the TLS handshake to
// connection glare about one run in five, old binary against old binary alike
// (measured 4/20, a08d-wiring/03-scratch-old-old-direct-race.log), and on a
// host with no public address it fails with "no direct connection". When the
// race succeeds, the callers check the bytes that crossed.
func ldWantLegacy(t *testing.T, ra, rb ldResult) {
	t.Helper()
	sa, sb := ldSAS(ra), ldSAS(rb)
	if sa == "" || sa != sb {
		t.Fatalf("legacy handshake did not complete with one shared SAS (%q vs %q)\n%s\n%s", sa, sb, ra, rb)
	}
	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 && r.code != 1 {
			t.Errorf("after the handshake: want exit 0 or 1\n%s", r)
		}
		if r.code != 0 {
			t.Logf("direct race after the shared SAS did not complete (today's behaviour, not A08d's):\n%s", r)
		}
	}
}

// ldOldText is what the old binary's `text` sends from its (piped) stdin.
const ldOldText = "hello from the old CLI\n"

// ldCheckText: when the direct race succeeded, the new side's `text` printed
// what the old binary sent.
func ldCheckText(t *testing.T, rn ldResult) {
	t.Helper()
	if rn.code == 0 && !strings.Contains(rn.stdout, strings.TrimSpace(ldOldText)) {
		t.Errorf("text session finished but the old side's message never arrived\n%s", rn)
	}
}

func ldSrc(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "payload.txt")
	if err := os.WriteFile(p, []byte("a08d legacy payload\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func ldCheckReceived(t *testing.T, sender, receiver ldResult, dest string) {
	t.Helper()
	if receiver.code != 0 {
		return
	}
	b, err := os.ReadFile(filepath.Join(dest, "payload.txt"))
	if err != nil || string(b) != "a08d legacy payload\n" {
		t.Errorf("transfer reported success but the file is %q (%v)", b, err)
	}
}

// ---------------------------------------------------------------- old binary

// ldOldCLI returns a relayium binary built from ldOldCommit into dir, from
// `git archive` (no worktree is created and the checkout is not touched).
// Skips when the commit is not in the local history (e.g. a shallow CI clone)
// and RELAYIUM_OLD_CLI is unset.
func ldOldCLI(t *testing.T, dir string) string {
	t.Helper()
	if p := os.Getenv("RELAYIUM_OLD_CLI"); p != "" {
		return p
	}
	top, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not in a git checkout; set RELAYIUM_OLD_CLI")
	}
	root := strings.TrimSpace(string(top))
	if exec.Command("git", "-C", root, "cat-file", "-e", ldOldCommit+"^{commit}").Run() != nil {
		t.Skip(ldOldCommit + " is not in the local history (shallow clone?); set RELAYIUM_OLD_CLI")
	}
	if err := ldExtract(root, dir); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "relayium-old")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", out, "./cmd/relayium")
	build.Dir = filepath.Join(dir, "server")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOFLAGS=-mod=readonly")
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build old CLI: %v\n%s", err, b)
	}
	// Guard against testing the new CLI by mistake: the old one has no hidden
	// __link and must reject it as an unknown command.
	probe := exec.Command(out, "__link")
	if b, _ := probe.CombinedOutput(); probe.ProcessState.ExitCode() != 2 || !strings.Contains(string(b), "unknown command") {
		t.Fatalf("the binary built from %s knows __link: %s", ldOldCommit, b)
	}
	return out
}

func ldExtract(root, dir string) error {
	cmd := exec.Command("git", "-C", root, "archive", "--format=tar", ldOldCommit, "server")
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	tr := tar.NewReader(pipe)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Join(dir, filepath.FromSlash(h.Name))
		if !strings.HasPrefix(name, dir+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry escapes: %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(name, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			_, cerr := io.Copy(f, tr)
			f.Close()
			if cerr != nil {
				return cerr
			}
		}
	}
	return cmd.Wait()
}

// ---------------------------------------------------------------- tests

func TestLinkDevIsHidden(t *testing.T) {
	var out, errb bytes.Buffer
	Run(nil, &out, &errb)
	Run([]string{"--help"}, &out, &errb)
	if strings.Contains(out.String()+errb.String(), "__link") {
		t.Fatal("the hidden __link command appears in the usage text")
	}
	if _, ok := commandUsage["__link"]; ok {
		t.Fatal("__link has a help entry")
	}
}

func TestLinkDevRefusesBadInvocations(t *testing.T) {
	cases := [][]string{
		{"__link"},
		{"__link", "bogus", ldCode},
		{"__link", "pair"},
		{"__link", "pair", ""},           // the code-less LAN room is refused
		{"__link", "pair", "not-a-code"}, // made-up code: never dialled
		{"__link", "receive"},
		{"__link", "text", ldCode, "extra"},
		{"__link", "send", ldSrc(t)}, // __link never mints
	}
	for _, argv := range cases {
		var out, errb bytes.Buffer
		if rc := Run(argv, &out, &errb); rc != 2 {
			t.Errorf("%q: exit %d, want 2\n%s", argv, rc, errb.String())
		}
	}
}

// New ↔ new on the real hub with hints: every combination of commands links,
// and the two ends take opposite link roles. The room view comes from the real
// A08a hub (welcome echo, peer hint), not a stand-in.
func TestLinkDevNewToNewWithHints(t *testing.T) {
	pairs := [][2]string{{"pair", "pair"}, {"send", "receive"}, {"receive", "send"}, {"text", "text"}, {"pair", "text"}}
	for _, pc := range pairs {
		t.Run(pc[0]+"-"+pc[1], func(t *testing.T) {
			t.Parallel()
			hub := startLinkDevHub(t)
			a := ldPeer{cmd: pc[0], via: hub.url}
			b := ldPeer{cmd: pc[1], via: hub.url}
			var dest string
			for i, p := range []*ldPeer{&a, &b} {
				switch p.cmd {
				case "send":
					p.args = []string{ldSrc(t), ldCode}
				case "receive":
					dest = t.TempDir()
					p.args = []string{ldCode, dest}
				case "text":
					// A script, not stdin: in-process ends share os.Stdin.
					p.args = []string{"--script", ldScript(t, fmt.Sprintf("text hello from end %d", i), "wait-texts 1"), ldCode}
				default:
					p.args = []string{ldCode}
					if pc[0] == "pair" && pc[1] == "text" {
						p.args = []string{"--script", ldScript(t, "text hello from end 0", "wait-texts 1"), ldCode}
					}
				}
			}
			ra, rb := ldPairUp(t, hub, "", a, b)
			ldWantLink(t, "first", ra, true)
			ldWantLink(t, "second", rb, true)
			if sa, sb := ldSAS(ra), ldSAS(rb); sa == "" || sa != sb {
				t.Errorf("link SAS differs: %q vs %q", sa, sb)
			}
			if dest != "" {
				ldCheckReceived(t, ra, rb, dest)
				if b, err := os.ReadFile(filepath.Join(dest, "payload.txt")); err != nil || len(b) == 0 {
					t.Errorf("the receiving end saved nothing: %v", err)
				}
			}
			if pc[0] == "text" || pc[1] == "text" {
				if !strings.Contains(ra.stdout, "hello from end 1") || !strings.Contains(rb.stdout, "hello from end 0") {
					t.Errorf("messages did not cross\nfirst: %s\nsecond: %s", ra, rb)
				}
			}
			// M1: one /api/ice request per link end, for this code, and only
			// because discovery chose link/1.
			if hits := hub.iceHits(); len(hits) != 2 || hits[0] != ldCode || hits[1] != ldCode {
				t.Errorf("/api/ice requests %q, want exactly one per end for %s", hits, ldCode)
			}
			for _, r := range []ldResult{ra, rb} {
				if n := strings.Count(r.stderr, "relay unavailable:"); n != 1 {
					t.Errorf("want one truthful no-relay line, got %d\n%s", n, r)
				}
				if !strings.Contains(r.stderr, "ice policy=all") {
					t.Errorf("no TURN issued, so policy must be all\n%s", r)
				}
				for _, p := range ldPaths(r) {
					if p == "relay" {
						t.Errorf("reported relay with no TURN configured\n%s", r)
					}
				}
			}
			for _, r := range []ldResult{ra, rb} {
				if !strings.Contains(r.stderr, "peerHint=true") {
					t.Errorf("the real hub did not carry the peer's hint\n%s", r)
				}
			}
			roles := ldRole(ra) + "/" + ldRole(rb)
			if roles != "initiator/responder" && roles != "responder/initiator" {
				t.Errorf("link roles %s, want one of each", roles)
			}
		})
	}
}

// N-0928-13: Pion's selected-pair notification comes from its own
// goroutine and can arrive after a short session ended; the end that leaves
// first then never printed its path. Held back 300 ms here, both ends of a
// `pair` link must still report the selected pair exactly once.
func TestLinkDevPathReportedDespiteLateNotification(t *testing.T) {
	ldHookPathNotifyDelay = func() { time.Sleep(300 * time.Millisecond) }
	t.Cleanup(func() { ldHookPathNotifyDelay = nil })
	for _, hinted := range []bool{false, true} {
		t.Run(fmt.Sprintf("serverHints=%t", hinted), func(t *testing.T) {
			hub := startLinkDevHub(t)
			via := hub.url
			if !hinted {
				via = startLinkDevProxy(t, hub.url, true, false)
			}
			ra, rb := ldPairUp(t, hub, "",
				ldPeer{cmd: "pair", args: []string{ldCode}, via: via},
				ldPeer{cmd: "pair", args: []string{ldCode}, via: via})
			ldWantLink(t, "first", ra, hinted)
			ldWantLink(t, "second", rb, hinted)
			for _, r := range []ldResult{ra, rb} {
				if ps := ldPaths(r); len(ps) != 1 || ps[0] == "relay" {
					t.Errorf("paths %v, want exactly one lan/direct line\n%s", ps, r)
				}
			}
		})
	}
}

func ldRole(r ldResult) string {
	switch {
	case strings.Contains(r.stderr, "link/1 initiator"):
		return "initiator"
	case strings.Contains(r.stderr, "link/1 responder"):
		return "responder"
	}
	return "?"
}

// New ↔ new on a hub that predates hints (proxy strips them): `pair` still
// links (both greet); `send`/`receive`/`text` keep today's legacy wire; a
// `pair` meeting a legacy-mode CLI ends on both sides at once.
func TestLinkDevNewToNewWithoutHints(t *testing.T) {
	t.Run("pair-pair", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "pair", args: []string{ldCode}, via: via},
			ldPeer{cmd: "pair", args: []string{ldCode}, via: via})
		ldWantLink(t, "first", ra, false)
		ldWantLink(t, "second", rb, false)
	})
	// M1: a pairing that went legacy never asks /api/ice (no credential is
	// issued to the code owner for a link that never exists).
	t.Run("legacy-never-fetches-ice", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		dest := t.TempDir()
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "send", args: []string{ldSrc(t), ldCode}, via: via},
			ldPeer{cmd: "receive", args: []string{ldCode, dest}, via: via})
		ldWantLegacy(t, ra, rb)
		if hits := hub.iceHits(); len(hits) != 0 {
			t.Fatalf("legacy pairing requested /api/ice %d time(s)", len(hits))
		}
	})
	t.Run("send-receive", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		dest := t.TempDir()
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "send", args: []string{ldSrc(t), ldCode}, via: via},
			ldPeer{cmd: "receive", args: []string{ldCode, dest}, via: via})
		for _, r := range []ldResult{ra, rb} {
			if !strings.Contains(r.stderr, "serverHints=false") {
				t.Errorf("stripped hub read as hinted\n%s", r)
			}
		}
		ldWantLegacy(t, ra, rb)
		ldCheckReceived(t, ra, rb, dest)
	})
	t.Run("text-text", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "text", args: []string{ldCode}, via: via},
			ldPeer{cmd: "text", args: []string{ldCode}, via: via})
		ldWantLegacy(t, ra, rb)
	})
	// `pair` meeting a legacy-mode `receive` has two orders, and the hub's
	// scheduling chooses between them. Each is forced here and asserted with
	// its own outcome; neither accepts the other's.
	//
	// Commit first: receive's room view is complete before pair's hello
	// reaches it, so receive sends its commit, pair reads that commit after
	// its hello (legacy-after-hello) and receive refuses the hello it then
	// reads in place of the peer's commit.
	t.Run("pair-receive", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		frames := &ldFrames{}
		viaPair := startLinkDevOrderedProxy(t, hub.url, "pair", ldOrderFree, frames)
		viaRecv := startLinkDevOrderedProxy(t, hub.url, "receive", ldOrderCommitFirst, frames)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "pair", args: []string{ldCode}, via: viaPair},
			ldPeer{cmd: "receive", args: []string{ldCode, t.TempDir()}, via: viaRecv})
		t.Logf("frames:\n%s", frames)
		if ra.code != 1 || !strings.Contains(ra.stderr, "legacy CLI handshake after our link hello") {
			t.Errorf("pair: want the legacy-after-hello refusal\n%s", ra)
		}
		if rb.code != 1 || !strings.Contains(rb.stderr, "app or the web page") {
			t.Errorf("receive: want today's not-a-CLI refusal for a link hello\n%s", rb)
		}
		// The order this case is about actually happened: receive saw the
		// whole room, committed, and only then got pair's hello.
		if !strings.Contains(rb.stderr, "captured=0") || !strings.Contains(rb.stderr, "sending our commit first") {
			t.Errorf("receive: want a complete room with nothing captured, then our commit first\n%s", rb)
		}
		fr := frames.of("receive")
		roster := ldRosterAt(fr)
		commit := ldFrameAt(fr, "up", signal.TypeSignal, "")
		hello := ldFrameAt(fr, "down", signal.TypeSignal, "")
		if roster < 0 || commit < 0 || hello < 0 || !(roster < commit && commit < hello) ||
			fr[commit].class != "legacy-commit" || fr[hello].class != "hello(link/1)" {
			t.Errorf("receive: want roster, then our legacy-commit, then pair's hello(link/1)\n%s", frames)
		}
		if i := ldFrameAt(frames.of("pair"), "down", signal.TypeSignal, ""); i < 0 ||
			frames.of("pair")[i].class != "legacy-commit" {
			t.Errorf("pair: want receive's legacy-commit as the first signal it got\n%s", frames)
		}
	})
	// Hello first: pair's hello reaches receive before receive's roster, so
	// JoinRoom captures it and the legacy handshake starts from it as the
	// peer's "commit". DoHandshakeFromPeerCommit refuses a non-commit before
	// sending anything (rzvous TestDoHandshakeFromPeerCommitRefusesBeforeSpeaking),
	// so pair hears nothing at all and ends on its own bounded first-frame
	// wait (linksession.DiscoveryWait) as "never spoke". This is the order of
	// the hosted failure in run 37175317336 (Go job 111356704691). Its real
	// cost is that wait; it is the outcome under test, so it is waited for.
	t.Run("pair-receive-hello-captured", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		frames := &ldFrames{}
		viaPair := startLinkDevOrderedProxy(t, hub.url, "pair", ldOrderFree, frames)
		viaRecv := startLinkDevOrderedProxy(t, hub.url, "receive", ldOrderHelloFirst, frames)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "pair", args: []string{ldCode}, via: viaPair},
			ldPeer{cmd: "receive", args: []string{ldCode, t.TempDir()}, via: viaRecv})
		t.Logf("frames:\n%s", frames)
		if rb.code != 1 || !strings.Contains(rb.stderr, "captured=1") ||
			!strings.Contains(rb.stderr, "continuing from the peer's commit") ||
			!strings.Contains(rb.stderr, "app or the web page") {
			t.Errorf("receive: want the captured hello refused as not-a-CLI\n%s", rb)
		}
		if ra.code != 1 || !strings.Contains(ra.stderr, linkDevEndMessage("peer-never-spoke")) ||
			strings.Contains(ra.stderr, "legacy CLI handshake after our link hello") {
			t.Errorf("pair: want the bounded never-spoke end, with no answer to its hello\n%s", ra)
		}
		fr := frames.of("receive")
		hello := ldFrameAt(fr, "down", signal.TypeSignal, "hello(link/1)")
		if roster := ldRosterAt(fr); hello < 0 || roster < 0 || hello > roster {
			t.Errorf("receive: want pair's hello(link/1) delivered before its complete roster\n%s", frames)
		}
		// Refused without a commit: receive sent no signal of any kind.
		if i := ldFrameAt(fr, "up", signal.TypeSignal, ""); i >= 0 {
			t.Errorf("receive: sent a %s after refusing the captured hello\n%s", fr[i].class, frames)
		}
		if i := ldFrameAt(frames.of("pair"), "down", signal.TypeSignal, ""); i >= 0 {
			t.Errorf("pair: got a %s, want no answer at all\n%s", frames.of("pair")[i].class, frames)
		}
	})
}

// New ↔ a real old CLI binary, both modes, both roles and both join orders,
// on the hinted hub and on a hub without hints. Legacy must be exactly today's
// wire: one shared SAS from the unchanged old handshake.
func TestLinkDevAgainstOldCLI(t *testing.T) {
	bin := ldOldCLI(t, t.TempDir())
	t.Run("matrix", func(t *testing.T) { ldOldMatrix(t, bin) })
	t.Run("capture", func(t *testing.T) { ldOldCapture(t, bin) })
	t.Run("piped-text-new-to-old", func(t *testing.T) { ldOldPipedText(t, bin) })
}

// ldOldPipedText: new `text` with PIPED stdin against an old `text`. The new
// end must not read stdin before discovery picked the wire: on the legacy
// outcome, pumpText is stdin's one and only reader, and the old end prints
// what was piped in. Sequential (it swaps the process's text stdin), and
// repeated until today's direct race connects (it loses ~1 in 5 on hosts with
// TUN/CGNAT addresses, A08d finding): the claim is about the bytes once the
// legacy wire exists, and the race is not this code.
func ldOldPipedText(t *testing.T, bin string) {
	const piped = "from the new CLI, piped"
	for _, newFirst := range []bool{true, false} {
		name := "old-first"
		if newFirst {
			name = "new-first"
		}
		t.Run(name, func(t *testing.T) {
			in := strings.NewReader(piped + "\n")
			oldIn, oldTTY := textStdin, textStdinIsTTY
			textStdin = func() io.Reader { return in } // ONE reader, as os.Stdin is
			textStdinIsTTY = func() bool { return false }
			t.Cleanup(func() { textStdin, textStdinIsTTY = oldIn, oldTTY })
			for attempt := 1; attempt <= 6; attempt++ {
				in.Reset(piped + "\n")
				hub := startLinkDevHub(t)
				newP := ldPeer{cmd: "text", via: hub.url, args: []string{ldCode}}
				oldP := ldPeer{old: true, cmd: "text", via: hub.url, args: []string{ldCode}}
				var rn, ro ldResult
				if newFirst {
					rn, ro = ldPairUp(t, hub, bin, newP, oldP)
				} else {
					ro, rn = ldPairUp(t, hub, bin, oldP, newP)
				}
				ldWantLegacy(t, rn, ro)
				if strings.Contains(rn.stderr, "link/1 ") {
					t.Fatalf("new side linked against an old CLI\n%s", rn)
				}
				if rn.code != 0 || ro.code != 0 {
					t.Logf("attempt %d: direct race did not connect; retrying", attempt)
					continue
				}
				if !strings.Contains(ro.stdout, piped) {
					t.Fatalf("the old CLI never received the piped text\nnew: %s\nold: %s", rn, ro)
				}
				if !strings.Contains(rn.stdout, strings.TrimSpace(ldOldText)) {
					t.Fatalf("the new CLI never printed the old side's text\n%s", rn)
				}
				if len(hub.iceHits()) != 0 {
					t.Fatalf("legacy text requested /api/ice")
				}
				return
			}
			t.Skip("today's direct race never connected in 6 attempts on this host")
		})
	}
}

func ldOldMatrix(t *testing.T, bin string) {
	type tc struct {
		name     string
		strip    bool
		newFirst bool
		newCmd   string
		oldCmd   string
		check    func(t *testing.T, rn, ro ldResult, dest string)
	}
	legacy := func(t *testing.T, rn, ro ldResult, dest string) {
		ldWantLegacy(t, rn, ro)
		if strings.Contains(rn.stderr, "link/1 ") || strings.Contains(rn.stderr, "link admitted") {
			t.Errorf("new side chose link against an old CLI\n%s", rn)
		}
	}
	var cases []tc
	for _, strip := range []bool{false, true} {
		for _, newFirst := range []bool{true, false} {
			hub := "hints"
			if strip {
				hub = "nohints"
			}
			order := "old-first"
			if newFirst {
				order = "new-first"
			}
			for _, c := range [][2]string{{"receive", "send"}, {"send", "receive"}, {"text", "text"}} {
				cases = append(cases, tc{name: fmt.Sprintf("%s/%s/new-%s-old-%s", hub, order, c[0], c[1]),
					strip: strip, newFirst: newFirst, newCmd: c[0], oldCmd: c[1], check: legacy})
			}
		}
	}
	// Mode mismatch is still refused exactly as today, on both ends.
	cases = append(cases, tc{name: "hints/new-send-old-text", newFirst: true, newCmd: "send", oldCmd: "text",
		check: func(t *testing.T, rn, ro ldResult, dest string) {
			if rn.code != 1 || !strings.Contains(rn.stderr, "the other side is running `relayium text`, not `relayium send`/`relayium receive`") {
				t.Errorf("new: want today's mode refusal\n%s", rn)
			}
			if ro.code != 1 || !strings.Contains(ro.stderr, "the other side is running `relayium send`/`relayium receive`, not `relayium text`") {
				t.Errorf("old: want its mode refusal\n%s", ro)
			}
		}})
	// A `pair` meeting an old CLI: both end within one round trip; the old one
	// quotes the notice it cannot understand.
	for _, strip := range []bool{false, true} {
		for _, oldCmd := range []string{"send", "text"} {
			name := "hints"
			if strip {
				name = "nohints"
			}
			strip, oldCmd := strip, oldCmd
			cases = append(cases, tc{name: name + "/new-pair-old-" + oldCmd, strip: strip, newFirst: false, newCmd: "pair", oldCmd: oldCmd,
				check: func(t *testing.T, rn, ro ldResult, dest string) {
					if rn.code != 1 {
						t.Errorf("new pair: want a refusal\n%s", rn)
					}
					if !strip {
						if !strings.Contains(rn.stderr, "older relayium CLI") {
							t.Errorf("new pair: want the older-CLI report\n%s", rn)
						}
						if ro.code != 1 || !strings.Contains(ro.stderr, "pair-needs-newer-relayium") {
							t.Errorf("old: want it to quote pair-needs-newer-relayium\n%s", ro)
						}
					} else {
						if !strings.Contains(rn.stderr, "legacy CLI handshake after our link hello") {
							t.Errorf("new pair: want the legacy-after-hello report\n%s", rn)
						}
						if ro.code != 1 || !strings.Contains(ro.stderr, "app or the web page") {
							t.Errorf("old: want its not-a-CLI refusal of our hello\n%s", ro)
						}
					}
				}})
		}
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			hub := startLinkDevHub(t)
			via := hub.url
			if c.strip {
				via = startLinkDevProxy(t, hub.url, true, false)
			}
			dest := t.TempDir()
			newP := ldPeer{cmd: c.newCmd, via: via}
			oldP := ldPeer{old: true, cmd: c.oldCmd, via: hub.url}
			src := ldSrc(t)
			for _, p := range []*ldPeer{&newP, &oldP} {
				switch p.cmd {
				case "send":
					p.args = []string{src, ldCode}
				case "receive":
					p.args = []string{ldCode, dest}
				default:
					p.args = []string{ldCode}
				}
			}
			var rn, ro ldResult
			if c.newFirst {
				rn, ro = ldPairUp(t, hub, bin, newP, oldP)
			} else {
				ro, rn = ldPairUp(t, hub, bin, oldP, newP)
			}
			want := "serverHints=" + fmt.Sprint(!c.strip) + " peerHint=false"
			if !strings.Contains(rn.stderr, want) {
				t.Errorf("new side's room view lacks %q\n%s", want, rn)
			}
			c.check(t, rn, ro, dest)
			// M1: against an old CLI no link exists, so no relay credential
			// may be issued to the code owner — discovery waits here (the
			// peer's roster lacks the hint), and must not fetch while it does.
			if hits := hub.iceHits(); len(hits) != 0 {
				t.Errorf("/api/ice requested %d time(s) for a pairing that never linked", len(hits))
			}
			if c.newCmd == "text" && c.oldCmd == "text" {
				ldCheckText(t, rn)
			}
			if c.newCmd == "receive" {
				ldCheckReceived(t, ro, rn, dest)
			} else if c.oldCmd == "receive" {
				ldCheckReceived(t, rn, ro, dest)
			}
		})
	}
}

// Capture ordering: the old CLI's commit reaches the new side BEFORE the new
// side's roster (forced by the roster-holding proxy on every run). The new
// side must capture it and continue the legacy handshake from it, on a hinted
// hub (discovery Passive) and on one without hints (discovery commits first
// and the captured commit is replayed after).
func ldOldCapture(t *testing.T, bin string) {
	for _, strip := range []bool{false, true} {
		name := "hints"
		if strip {
			name = "nohints"
		}
		for _, newCmd := range []string{"receive", "text"} {
			strip, newCmd := strip, newCmd
			t.Run(name+"/"+newCmd, func(t *testing.T) {
				t.Parallel()
				hub := startLinkDevHub(t)
				via := startLinkDevProxy(t, hub.url, strip, true)
				dest := t.TempDir()
				oldCmd, newArgs, oldArgs := "text", []string{ldCode}, []string{ldCode}
				if newCmd == "receive" {
					oldCmd, newArgs, oldArgs = "send", []string{ldCode, dest}, []string{ldSrc(t), ldCode}
				}
				rn, ro := ldPairUp(t, hub, bin,
					ldPeer{cmd: newCmd, args: newArgs, via: via},
					ldPeer{old: true, cmd: oldCmd, args: oldArgs, via: hub.url})
				if !strings.Contains(rn.stderr, "captured=1") {
					t.Errorf("the proxy did not put the commit ahead of the roster\n%s", rn)
				}
				if !strings.Contains(rn.stderr, "continuing from the peer's commit") {
					t.Errorf("the captured commit was not the handshake's first message\n%s", rn)
				}
				ldWantLegacy(t, rn, ro)
				if newCmd == "receive" {
					ldCheckReceived(t, ro, rn, dest)
				} else {
					ldCheckText(t, rn)
				}
			})
		}
	}
}

// ================================================================ A09b: the link transport

// ldScript writes a __link script and returns its path.
func ldScript(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "script.txt")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// ldTree writes files (relative path -> size) of random bytes under a fresh
// directory named root and returns the directory's path.
func ldTree(t *testing.T, root string, files map[string]int) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), root)
	for rel, n := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		b := make([]byte, n)
		if _, err := rand.Read(b); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// ldSameTree: every file under src (a sent root) is byte-identical under
// dest/<base(src)>, and nothing else was written there.
func ldSameTree(t *testing.T, src, dest string) {
	t.Helper()
	base := filepath.Base(src)
	n := 0
	_ = filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		want, _ := os.ReadFile(p)
		got, gerr := os.ReadFile(filepath.Join(dest, base, rel))
		if gerr != nil || !bytes.Equal(got, want) {
			t.Errorf("%s/%s: received %d bytes (%v), sent %d", base, rel, len(got), gerr, len(want))
		}
		n++
		return nil
	})
	if n == 0 {
		t.Fatalf("empty source tree %s", src)
	}
}

// ---------------------------------------------------------------- in-process TURN (patched turn/v4)

// ldTURN is the PATCHED pion TURN v4 server (third_party/pion-turn, via the
// go.mod replace) configured like relayium-node: TURN REST credentials
// ("<unix-expiry>:<token>", password = base64(HMAC-SHA1(secret, username))),
// an expired or malformed username refused, and every relay socket wrapped in
// a per-allocation byte counter that tallies ReadFrom and WriteTo exactly as
// cmd/relayium-node/counter.go's countingPacketConn does. Those counters are
// the provider-side truth the relayed runs are checked against (M2).
type ldTURN struct {
	srv    *turnv4.Server
	addr   string
	secret string

	mu     sync.Mutex
	allocs []*ldCountingConn
	// authOK counts key LOOKUPS for a username the relay did not refuse
	// outright; a lookup is not a successful authentication (the request's
	// MESSAGE-INTEGRITY is checked against the key afterwards).
	authOK   map[string]int
	authDeny map[string]int

	// trail is diagnostics only (ldAwait): when each key lookup, refusal and
	// allocation happened.
	trail ldTrail
}

type ldCountingConn struct {
	net.PacketConn
	n atomic.Int64
}

func (c *ldCountingConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, a, err := c.PacketConn.ReadFrom(p)
	c.n.Add(int64(n))
	return n, a, err
}

func (c *ldCountingConn) WriteTo(p []byte, a net.Addr) (int, error) {
	n, err := c.PacketConn.WriteTo(p, a)
	c.n.Add(int64(n))
	return n, err
}

type ldCountingGen struct {
	inner turnv4.RelayAddressGenerator
	t     *ldTURN
}

func (g *ldCountingGen) Validate() error { return g.inner.Validate() }
func (g *ldCountingGen) AllocateConn(network string, port int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, port)
}

func (g *ldCountingGen) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.inner.AllocatePacketConn(network, port)
	if err != nil {
		return pc, addr, err
	}
	c := &ldCountingConn{PacketConn: pc}
	g.t.mu.Lock()
	g.t.allocs = append(g.t.allocs, c)
	g.t.mu.Unlock()
	g.t.trail.note("allocation %s/%d relay %s", network, port, addr)
	return c, addr, nil
}

func ldRESTExpired(username string, now int64) bool {
	i := strings.IndexByte(username, ':')
	if i <= 0 {
		return true
	}
	exp, err := strconv.ParseInt(username[:i], 10, 64)
	return err != nil || exp < now
}

func ldRESTPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func startLinkDevTURN(t *testing.T) *ldTURN {
	t.Helper()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lt := &ldTURN{addr: udp.LocalAddr().String(), secret: "a09b-test-secret",
		authOK: map[string]int{}, authDeny: map[string]int{}}
	gen := &ldCountingGen{t: lt, inner: &turnv4.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1", MinPort: 49152, MaxPort: 65535,
	}}
	const realm = "relayium.test"
	srv, err := turnv4.NewServer(turnv4.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, realm string, _ net.Addr) ([]byte, bool) {
			lt.mu.Lock()
			defer lt.mu.Unlock()
			if ldRESTExpired(username, time.Now().Unix()) {
				lt.authDeny[username]++
				lt.trail.note("auth lookup %q refused", username)
				return nil, false
			}
			lt.authOK[username]++
			lt.trail.note("auth lookup %q", username)
			return turnv4.GenerateAuthKey(username, realm, ldRESTPassword(lt.secret, username)), true
		},
		PacketConnConfigs: []turnv4.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen}},
	})
	if err != nil {
		t.Fatal(err)
	}
	lt.srv = srv
	t.Cleanup(func() { _ = srv.Close() })
	return lt
}

// cred is a TURN REST credential as account.turnCredentials mints it.
func (lt *ldTURN) cred(expiry time.Time, token string) map[string]any {
	u := fmt.Sprintf("%d:%s", expiry.Unix(), token)
	return map[string]any{"urls": []string{"turn:" + lt.addr + "?transport=udp"}, "username": u, "credential": ldRESTPassword(lt.secret, u)}
}

func (lt *ldTURN) counters() []int64 {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	var out []int64
	for _, c := range lt.allocs {
		out = append(out, c.n.Load())
	}
	return out
}

func (lt *ldTURN) created() int {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	return len(lt.allocs)
}

func (lt *ldTURN) auths() (ok, deny map[string]int) {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	ok, deny = map[string]int{}, map[string]int{}
	for k, v := range lt.authOK {
		ok[k] = v
	}
	for k, v := range lt.authDeny {
		deny[k] = v
	}
	return
}

// diagnostics is the relay's side of an overrun (ldAwait): live and created
// allocations, each allocation's byte counter, key lookups and refusals per
// username, and their timeline.
func (lt *ldTURN) diagnostics() string {
	ok, deny := lt.auths()
	return fmt.Sprintf("relay %s: live allocations %d, created %d, bytes per allocation %v\n  auth lookups %v, refused %v\nrelay events:\n%s",
		lt.addr, lt.srv.AllocationCount(), lt.created(), lt.counters(), ok, deny, lt.trail.String())
}

func (lt *ldTURN) waitAllocations(t *testing.T, want int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for lt.srv.AllocationCount() != want {
		if time.Now().After(deadline) {
			t.Fatalf("TURN allocations %d, want %d", lt.srv.AllocationCount(), want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func ldJSONICE(body any) http.HandlerFunc {
	b, _ := json.Marshal(body)
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	}
}

var ldMovedLine = regexp.MustCompile(`link-dev: moved sent=(\d+) received=(\d+)`)

func ldMoved(t *testing.T, r ldResult) (sent, recv int64) {
	t.Helper()
	m := ldMovedLine.FindStringSubmatch(r.stderr)
	if m == nil {
		t.Fatalf("no moved line\n%s", r)
	}
	s, _ := strconv.ParseInt(m[1], 10, 64)
	v, _ := strconv.ParseInt(m[2], 10, 64)
	return s, v
}

// ldBidi is the bidirectional multi-batch, multi-text session both ends run:
// two batches (a directory of three files incl. an empty one and a 9 MiB file
// that crosses the 8 MiB flow window) and three messages each way, then the
// scripted finish (wait for everything, end the conversation, leave).
type ldBidi struct {
	a, b         ldPeer
	srcA, srcB   []string
	destA, destB string
	textsA       []string
	textsB       []string
}

func newLDBidi(t *testing.T, via string, bigFile int) *ldBidi {
	t.Helper()
	x := &ldBidi{destA: t.TempDir(), destB: t.TempDir()}
	for i, side := range []string{"A", "B"} {
		d1 := ldTree(t, "dir"+side, map[string]int{"one.bin": 70_000, "sub/two.bin": 200_000, "sub/empty": 0})
		d2 := ldTree(t, "big"+side, map[string]int{"big.bin": bigFile})
		texts := []string{"first from " + side, "second from " + side + " — ünïcödé", "third from " + side}
		script := []string{"send " + d1, "send " + d2}
		for _, m := range texts {
			script = append(script, "text "+m)
		}
		script = append(script, "wait-files 2", "wait-texts 3")
		dest := x.destA
		if i == 1 {
			dest = x.destB
		}
		p := ldPeer{cmd: "pair", via: via, args: []string{"--yes", "--dest", dest, "--script", ldScript(t, script...), ldCode}}
		if i == 0 {
			x.a, x.srcA, x.textsA = p, []string{d1, d2}, texts
		} else {
			x.b, x.srcB, x.textsB = p, []string{d1, d2}, texts
		}
	}
	return x
}

func (x *ldBidi) check(t *testing.T, ra, rb ldResult) {
	t.Helper()
	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 || !strings.Contains(r.stderr, "batches sent=2 received=2 texts received=3") {
			t.Errorf("want a complete bidirectional session\n%s", r)
		}
	}
	for _, src := range x.srcA {
		ldSameTree(t, src, x.destB)
	}
	for _, src := range x.srcB {
		ldSameTree(t, src, x.destA)
	}
	for _, m := range x.textsA {
		if !strings.Contains(rb.stdout, m) {
			t.Errorf("B never printed %q\n%s", m, rb)
		}
	}
	for _, m := range x.textsB {
		if !strings.Contains(ra.stdout, m) {
			t.Errorf("A never printed %q\n%s", m, ra)
		}
	}
	if sa, sb := ldSAS(ra), ldSAS(rb); sa == "" || sa != sb {
		t.Errorf("link SAS differs: %q vs %q", sa, sb)
	}
	// Either end's sent payload is exactly what the other received.
	as, ar := ldMoved(t, ra)
	bs, br := ldMoved(t, rb)
	if as != br || bs != ar {
		t.Errorf("payload bytes do not balance: A sent %d / B received %d, B sent %d / A received %d", as, br, bs, ar)
	}
}

// Loopback CLI↔CLI, no relay issued: a bidirectional multi-batch, multi-text
// session over the real link transport, in both link roles at once.
func TestLinkDevBidirectionalLoopback(t *testing.T) {
	hub := startLinkDevHub(t)
	x := newLDBidi(t, hub.url, 9<<20)
	ra, rb := ldPairUp(t, hub, "", x.a, x.b)
	x.check(t, ra, rb)
	if ldRole(ra)+"/"+ldRole(rb) != "initiator/responder" && ldRole(ra)+"/"+ldRole(rb) != "responder/initiator" {
		t.Errorf("roles %s/%s", ldRole(ra), ldRole(rb))
	}
	for _, r := range []ldResult{ra, rb} {
		ps := ldPaths(r)
		if len(ps) == 0 || ps[len(ps)-1] == "relay" {
			t.Errorf("paths %v: want lan or direct with no relay issued\n%s", ps, r)
		}
	}
	t.Logf("A: %s\nB: %s", ldMovedLine.FindString(ra.stderr), ldMovedLine.FindString(rb.stderr))
}

// Relayed CLI↔CLI through the PATCHED TURN server: the issued TURN forces
// relay-only (the Web's policy, M2), the reported path comes from the
// selected pair and says relay on both ends, and the relay's own per-
// allocation byte counters match the payload that crossed, plus framing.
func TestLinkDevRelayedThroughPatchedTURN(t *testing.T) {
	lt := startLinkDevTURN(t)
	exp := time.Now().Add(time.Hour)
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{
		"iceServers": []any{map[string]any{"urls": "stun:" + lt.addr}, lt.cred(exp, "owner1.tagA")},
	}))
	hub.diag = lt.diagnostics
	x := newLDBidi(t, hub.url, 3<<20)
	ra, rb := ldPairUp(t, hub, "", x.a, x.b)
	x.check(t, ra, rb)
	for _, r := range []ldResult{ra, rb} {
		if !strings.Contains(r.stderr, "ice policy=relay") {
			t.Errorf("TURN was issued: want relay-only\n%s", r)
		}
		if ps := ldPaths(r); len(ps) == 0 || ps[0] != "relay" {
			t.Errorf("paths %v, want relay from the selected pair\n%s", ps, r)
		}
		if strings.Contains(r.stderr, "relay unavailable") {
			t.Errorf("a relay was issued; no denial line expected\n%s", r)
		}
	}
	if hits := hub.iceHits(); len(hits) != 2 {
		t.Errorf("/api/ice requests %q, want one per end", hits)
	}
	lt.waitAllocations(t, 0, 10*time.Second) // both ends closed their allocations

	as, _ := ldMoved(t, ra)
	bs, _ := ldMoved(t, rb)
	payload := as + bs
	counts := lt.counters()
	if len(counts) != 2 {
		t.Fatalf("relay allocations %v, want exactly one per end", counts)
	}
	// Each allocation relays BOTH directions (WriteTo toward the peer's relay
	// address, ReadFrom from it), so each carries all of the payload. What it
	// adds is framing: DTLS records, SCTP chunks and SACKs, linkwire's 21-byte
	// piece header, the manifests, ACK/COMPLETE/END controls, ICE consent.
	for i, n := range counts {
		ratio := float64(n) / float64(payload)
		t.Logf("allocation %d relayed %d bytes for %d payload bytes (x%.4f)", i, n, payload, ratio)
		if n < payload || n > payload+payload/5+512<<10 {
			t.Errorf("allocation %d relayed %d bytes, want payload %d plus framing (<= 20%% + 512 KiB)", i, n, payload)
		}
	}
}

// relayDenied: quota. The server withheld TURN: one truthful line on each end,
// one /api/ice request per end (no refetch loop, M3), policy "all" with the
// STUN it did issue, the transfer still completes directly, and the relay was
// never touched (no allocation at all).
func TestLinkDevRelayDeniedQuota(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{
		"iceServers": []any{map[string]any{"urls": "stun:" + lt.addr}}, "relayDenied": "quota",
	}))
	src := ldTree(t, "q", map[string]int{"f.bin": 300_000})
	destB := t.TempDir()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--script", ldScript(t, "send "+src, "text ping", "wait-texts 1"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", destB, "--script", ldScript(t, "text pong", "wait-files 1", "wait-texts 1"), ldCode}})
	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 {
			t.Errorf("want the link to complete without a relay\n%s", r)
		}
		if n := strings.Count(r.stderr, "relay unavailable: the pairing code owner's monthly relay allowance is used up"); n != 1 {
			t.Errorf("want exactly one quota line, got %d\n%s", n, r)
		}
		if !strings.Contains(r.stderr, "ice policy=all") {
			t.Errorf("relay withheld: want policy all\n%s", r)
		}
		for _, p := range ldPaths(r) {
			if p == "relay" {
				t.Errorf("reported relay after a quota denial\n%s", r)
			}
		}
	}
	ldSameTree(t, src, destB)
	if hits := hub.iceHits(); len(hits) != 2 {
		t.Errorf("/api/ice requests %q, want exactly one per end (a denial is never re-requested)", hits)
	}
	if n := lt.created(); n != 0 {
		t.Errorf("%d relay allocation(s) after a quota denial", n)
	}
}

// Adversarial (M4): an already-expired credential cannot relay anything and
// cannot extend anything. The deadline derived from it is "now", so the link
// ends during establishment with a truthful line; the relay refuses the
// credential itself; no allocation ever exists; no payload moves.
func TestLinkDevExpiredCredentialCannotRelay(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{
		"iceServers": []any{lt.cred(time.Now().Add(-10*time.Second), "owner1.tagOld")},
	}))
	start := time.Now()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text never", "wait-texts 1"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text never", "wait-texts 1"), ldCode}})
	for _, r := range []ldResult{ra, rb} {
		if r.code == 0 || strings.Contains(r.stderr, "link admitted") {
			t.Errorf("an expired credential produced a link\n%s", r)
		}
		if !strings.Contains(r.stderr, "the relay credential for this link ended") {
			t.Errorf("want the truthful credential-ended line\n%s", r)
		}
		if s, v := ldMoved(t, r); s != 0 || v != 0 {
			t.Errorf("payload moved over an expired credential: %d/%d", s, v)
		}
	}
	if el := time.Since(start); el > 20*time.Second {
		t.Errorf("an expired credential took %v to end the link", el)
	}
	if n := lt.created(); n != 0 {
		t.Errorf("%d allocation(s) from an expired credential", n)
	}
}

// Adversarial (M4): a forged relays[] entry — a far-future expiry on a
// credential that cannot authenticate — cannot extend the link. The deadline
// is the EARLIEST expiry (the real, short one, minus the 60 s skew); the link
// runs relayed until exactly then and ends truthfully, long before either the
// real credential or the forged one would have expired; the relay refused
// every attempt to allocate with the forged credential.
func TestLinkDevForgedRelayCannotExtendDeadline(t *testing.T) {
	lt := startLinkDevTURN(t)
	realExp := time.Now().Add(linkrtcSkew() + 12*time.Second)
	forgedUser := "4102444800:attacker.tag"
	forged := map[string]any{"urls": []string{"turn:" + lt.addr + "?transport=udp"}, "username": forgedUser, "credential": "not-the-hmac"}
	// The forged credential rides BOTH lists: beside the real one in the
	// legacy top-level list (after it, so "first wins" would be wrong too) and
	// as a pool entry. The bound must be the earliest across and within both.
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{
		"iceServers": []any{lt.cred(realExp, "owner1.tagShort"), forged},
		"relays":     []any{map[string]any{"id": "forged", "iceServers": []any{forged}}},
	}))
	deadline := realExp.Add(-linkrtcSkew())
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text a", "wait-texts 1", "hold"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text b", "wait-texts 1", "hold"), ldCode}})
	ended := time.Now()
	for _, r := range []ldResult{ra, rb} {
		if !strings.Contains(r.stderr, "link admitted") || !strings.Contains(r.stderr, "path: relay") {
			t.Errorf("want a relayed link before the deadline\n%s", r)
		}
		if !strings.Contains(r.stderr, "report link relay-credential-ended") ||
			!strings.Contains(r.stderr, "the relay credential for this link ended; nothing more can be sent over it") {
			t.Errorf("want the link ended truthfully at the relay deadline\n%s", r)
		}
		if !strings.Contains(r.stderr, "link deadline "+deadline.UTC().Format(time.RFC3339)) &&
			!strings.Contains(r.stderr, "link deadline "+deadline.Local().Format(time.RFC3339)) {
			t.Errorf("the link's deadline is not the real credential's expiry - 60 s (%s)\n%s", deadline.Format(time.RFC3339), r)
		}
	}
	// Ended at the deadline (1 s of whole-second rounding in the expiry, plus
	// scheduling), and well before the real credential itself expired.
	if ended.Before(deadline.Add(-1500*time.Millisecond)) || ended.After(deadline.Add(8*time.Second)) {
		t.Errorf("link ended at %s, deadline %s", ended.Format(time.RFC3339Nano), deadline.Format(time.RFC3339Nano))
	}
	if !ended.Before(realExp) {
		t.Errorf("the link outlived the credential (ended %s, expiry %s)", ended, realExp)
	}
	// The forged entry was really tried (the relay looked its key up), and it
	// produced no allocation: the MESSAGE-INTEGRITY check against the key
	// derived from the relay's secret failed. Only the real credential
	// allocated, once per end.
	lookups, _ := lt.auths()
	if lookups[forgedUser] == 0 {
		t.Errorf("the forged relays[] entry was never tried; the test proves nothing (lookups %v)", lookups)
	}
	if n := lt.created(); n != 2 {
		t.Errorf("%d allocation(s), want exactly the real credential's one per end", n)
	}
	_, denied := lt.auths()
	t.Logf("relay key lookups %v, refused outright %v", lookups, denied)
	lt.waitAllocations(t, 0, 10*time.Second)
}

// linkrtcSkew is the Web's TURN_CLOCK_SKEW_MS, the margin the deadline takes.
func linkrtcSkew() time.Duration { return 60 * time.Second }

// Many small and empty files in one batch: the sender's per-turn burst bound
// must not strand a batch that earns no flow-control ACK to wake it.
func TestLinkDevManySmallFiles(t *testing.T) {
	hub := startLinkDevHub(t)
	files := map[string]int{}
	for i := 0; i < 120; i++ {
		files[fmt.Sprintf("d%d/f%03d.bin", i%7, i)] = i % 3 * 17 // 0, 17 or 34 bytes
	}
	src := ldTree(t, "many", files)
	dest := t.TempDir()
	start := time.Now()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "send", via: hub.url, args: []string{src, ldCode}},
		ldPeer{cmd: "receive", via: hub.url, args: []string{ldCode, dest}})
	if ra.code != 0 || rb.code != 0 {
		t.Fatalf("want both ends to finish\n%s\n%s", ra, rb)
	}
	ldSameTree(t, src, dest)
	if el := time.Since(start); el > 20*time.Second {
		t.Errorf("120 small files took %v (a stalled sender?)", el)
	}
}

// ================================================================ A09b gate-2 fixes

// ldAllocWatch samples the relay's live allocation count until the test ends:
// the peak, and the last instant it was above zero. That instant is the
// provider-side truth for "the relay stopped at the deadline".
type ldAllocWatch struct {
	mu          sync.Mutex
	peak        int
	lastNonZero time.Time
}

func (lt *ldTURN) watch(t *testing.T) *ldAllocWatch {
	w := &ldAllocWatch{}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(10 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				n := lt.srv.AllocationCount()
				w.mu.Lock()
				if n > w.peak {
					w.peak = n
				}
				if n > 0 {
					w.lastNonZero = time.Now()
				}
				w.mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() { close(stop); <-done })
	return w
}

func (w *ldAllocWatch) get() (int, time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.peak, w.lastNonZero
}

// ldShortRelay is a hub issuing one real TURN credential whose link deadline
// (expiry - 60 s skew) falls `in` from now.
func ldShortRelay(t *testing.T, lt *ldTURN, in time.Duration) (*ldHub, time.Time) {
	t.Helper()
	// Credentials state whole seconds: compute the deadline from exactly the
	// expiry the credential will carry.
	exp := time.Now().Add(linkrtcSkew() + in).Truncate(time.Second)
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{"iceServers": []any{lt.cred(exp, "owner1.tagStall")}}))
	return hub, exp.Add(-linkrtcSkew())
}

func ldWantCutAt(t *testing.T, w *ldAllocWatch, deadline time.Time) {
	t.Helper()
	peak, last := w.get()
	if peak == 0 {
		t.Fatal("no relay allocation ever existed; the test proves nothing")
	}
	// The relay's own teardown (Refresh lifetime 0) plus sampling.
	if last.After(deadline.Add(time.Second)) {
		t.Errorf("a relay allocation was still live %v after the deadline", last.Sub(deadline))
	}
	t.Logf("allocations peaked at %d; last live %v relative to the deadline", peak, last.Sub(deadline))
}

// Gate-2 #1a: a lane write stuck on transport backpressure must not hold the
// session loop, nor the relay past the credential. A's file-lane writes stall
// (as a Write waiting for an SCTP buffer that never drains would) for the
// whole run; A's loop still accepts B's conversation and prints its message,
// the session ends the link at the deadline, and the relay is released then.
func TestLinkDevStalledWriteCannotHoldRelayPastDeadline(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub, deadline := ldShortRelay(t, lt, 9*time.Second)
	big := ldTree(t, "stall", map[string]int{"big.bin": 4 << 20})
	destA := t.TempDir()
	ldHookLaneWrite = func(d *linkDevDriver, lane linkrtc.Lane, _ []byte, stop <-chan struct{}) {
		if d.dest == destA && lane == linkrtc.LaneFile {
			<-stop // backpressure that never clears
		}
	}
	t.Cleanup(func() { ldHookLaneWrite = nil })
	w := lt.watch(t)
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--dest", destA, "--script", ldScript(t, "send "+big, "wait-texts 1", "hold"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--script", ldScript(t, "text hello while stalled", "hold"), ldCode}})
	if !strings.Contains(ra.stdout, "hello while stalled") {
		t.Errorf("A's loop did not run while its file lane write was stalled\n%s", ra)
	}
	for _, r := range []ldResult{ra, rb} {
		if !strings.Contains(r.stderr, "path: relay") || !strings.Contains(r.stderr, "report link relay-credential-ended") {
			t.Errorf("want a relayed link ended at the relay deadline\n%s", r)
		}
	}
	ldWantCutAt(t, w, deadline)
	lt.waitAllocations(t, 0, 5*time.Second)
}

// Gate-2 #1b: the relay cutoff does not depend on the loop at all. A's loop
// is held (inside the delivery of B's message) through the deadline; the
// transport, and with it the TURN allocation, is closed at the deadline
// anyway.
func TestLinkDevBlockedLoopCannotHoldRelayPastDeadline(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub, deadline := ldShortRelay(t, lt, 9*time.Second)
	destA := t.TempDir()
	ldHookLoopText = func(d *linkDevDriver, stop <-chan struct{}) {
		if d.dest == destA {
			<-stop // the loop is stuck until the transport is cut
		}
	}
	t.Cleanup(func() { ldHookLoopText = nil })
	w := lt.watch(t)
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--dest", destA, "--script", ldScript(t, "wait-texts 1", "hold"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--script", ldScript(t, "text hold the loop", "hold"), ldCode}})
	if !strings.Contains(ra.stderr, "transport closed at the relay deadline") {
		t.Errorf("A: want the transport cut at the relay deadline\n%s", ra)
	}
	for _, r := range []ldResult{ra, rb} {
		if r.code == 0 {
			t.Errorf("a held link cannot finish its script\n%s", r)
		}
	}
	ldWantCutAt(t, w, deadline)
	lt.waitAllocations(t, 0, 5*time.Second)
}

// Gate-2 #2: the receiver's leave must not overtake its COMPLETE. The
// receiver's COMPLETE is held back 2 s on the file lane while its text lane
// and signalling run freely; the receiver must still not leave until the
// peer's transport acknowledged the file stream, so the sender sees
// delivered-and-verified, never delivery-unconfirmed.
func TestLinkDevLeaveWaitsForFileStreamAck(t *testing.T) {
	hub := startLinkDevHub(t)
	var held atomic.Int32
	ldHookLaneWrite = func(d *linkDevDriver, lane linkrtc.Lane, frame []byte, stop <-chan struct{}) {
		if d.cmd != linksession.CmdReceive || lane != linkrtc.LaneFile {
			return
		}
		if c, ok := linkwire.FileLifecycle(frame); ok && c == linkwire.FileComplete {
			held.Add(1)
			select {
			case <-time.After(2 * time.Second):
			case <-stop:
			}
		}
	}
	t.Cleanup(func() { ldHookLaneWrite = nil })
	dest := t.TempDir()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "send", via: hub.url, args: []string{ldSrc(t), ldCode}},
		ldPeer{cmd: "receive", via: hub.url, args: []string{ldCode, dest}})
	if held.Load() != 1 {
		t.Fatalf("COMPLETE held %d time(s), want 1: the test proves nothing", held.Load())
	}
	if ra.code != 0 || !strings.Contains(ra.stderr, "report file delivered-and-verified") ||
		strings.Contains(ra.stderr, "delivery-unconfirmed") {
		t.Errorf("sender: want delivered-and-verified\n%s", ra)
	}
	if rb.code != 0 || !strings.Contains(rb.stderr, "saved(verified,durable)") {
		t.Errorf("receiver: want a clean save and exit\n%s", rb)
	}
}

// Gate-2 #3: a file whose finalization fails (a delayed write error reported
// at close) is never reported saved, and the peer is never sent COMPLETE for
// it: the batch is withdrawn, the partial discarded, both ends fail.
func TestLinkDevFinalizationFailureNeverCompletes(t *testing.T) {
	hub := startLinkDevHub(t)
	var injected atomic.Int32
	ldHookFinalize = func(d *linkDevDriver, name string) error {
		if strings.HasSuffix(name, "payload.txt") {
			injected.Add(1)
			return errors.New("injected: delayed write failure reported at close")
		}
		return nil
	}
	t.Cleanup(func() { ldHookFinalize = nil })
	dest := t.TempDir()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "send", via: hub.url, args: []string{ldSrc(t), ldCode}},
		ldPeer{cmd: "receive", via: hub.url, args: []string{ldCode, dest}})
	if injected.Load() == 0 {
		t.Fatal("finalization was never reached: the test proves nothing")
	}
	if rb.code == 0 || strings.Contains(rb.stderr, "saved(verified,durable)") || !strings.Contains(rb.stderr, "injected: delayed write failure") {
		t.Errorf("receiver: a failed save must be reported as failed\n%s", rb)
	}
	if ra.code == 0 || strings.Contains(ra.stderr, "delivered-and-verified") ||
		!(strings.Contains(ra.stderr, "receiver-failed-to-save") || strings.Contains(ra.stderr, "stopped-by-receiver")) {
		t.Errorf("sender: must never hear COMPLETE for a failed save\n%s", ra)
	}
	if _, err := os.Stat(filepath.Join(dest, "payload.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the failed file was left behind (%v)", err)
	}
}

// ================================================================ A09b gate-2 round 2

// Round 2 #1: the sender's processing of COMPLETE is delayed AFTER its
// transport accepted (and SCTP-acknowledged) it — the frame waits on the lane
// reader, as it would behind a stalled loop — while the receiver, seeing the
// acknowledgement, leaves over signalling at once. The sender must still
// process COMPLETE before the leave: delivered-and-verified, never
// delivery-unconfirmed.
func TestLinkDevLeaveCannotOvertakeCompleteProcessing(t *testing.T) {
	hub := startLinkDevHub(t)
	var delayed atomic.Int32
	ldHookInbound = func(d *linkDevDriver, lane linkrtc.Lane, frame []byte) {
		if d.cmd != linksession.CmdSend || lane != linkrtc.LaneFile {
			return
		}
		if c, ok := linkwire.FileLifecycle(frame); ok && c == linkwire.FileComplete {
			delayed.Add(1)
			time.Sleep(1500 * time.Millisecond)
		}
	}
	t.Cleanup(func() { ldHookInbound = nil })
	dest := t.TempDir()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "send", via: hub.url, args: []string{ldSrc(t), ldCode}},
		ldPeer{cmd: "receive", via: hub.url, args: []string{ldCode, dest}})
	if delayed.Load() != 1 {
		t.Fatalf("COMPLETE delayed %d time(s), want 1: the test proves nothing", delayed.Load())
	}
	// The peer's end reaches us first either as its leave or as the loss of
	// the transport it closed after it; either must wait for COMPLETE.
	if !strings.Contains(ra.stderr, "holding the peer's leave") && !strings.Contains(ra.stderr, "holding the transport loss") {
		t.Errorf("the peer's end did not arrive while COMPLETE was pending; the race was not produced\n%s", ra)
	}
	if ra.code != 0 || !strings.Contains(ra.stderr, "report file delivered-and-verified") ||
		strings.Contains(ra.stderr, "delivery-unconfirmed") {
		t.Errorf("sender: want delivered-and-verified\n%s", ra)
	}
	if rb.code != 0 || !strings.Contains(rb.stderr, "saved(verified,durable)") {
		t.Errorf("receiver: want a clean save\n%s", rb)
	}
}

// Round 2 #2: `text --verify` answers the SAS question and types messages on
// ONE input. The answer must be read as the answer and the message as a
// message: nothing reads messages before admission is settled.
func TestLinkDevVerifiedTextSharesOneInput(t *testing.T) {
	hub := startLinkDevHub(t)
	in := strings.NewReader("y\nhello after verification\n")
	oldIn, oldTTY := textStdin, textStdinIsTTY
	textStdin = func() io.Reader { return in } // one source, as os.Stdin is
	textStdinIsTTY = func() bool { return true }
	t.Cleanup(func() { textStdin, textStdinIsTTY = oldIn, oldTTY })
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "text", via: hub.url, args: []string{"--verify", ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--script", ldScript(t, "wait-texts 1"), ldCode}})
	if !strings.Contains(ra.stderr, "Do the verification codes match on both ends?") || !strings.Contains(ra.stderr, "link admitted") {
		t.Errorf("text --verify: want the question asked and the link admitted on the answer\n%s", ra)
	}
	if ra.code != 0 || rb.code != 0 {
		t.Errorf("want both ends to finish\nA: %s\nB: %s", ra, rb)
	}
	if !strings.Contains(rb.stdout, "hello after verification") {
		t.Errorf("the message never arrived\n%s", rb)
	}
	for _, line := range strings.Split(rb.stdout, "\n") {
		if strings.TrimSpace(line) == "y" {
			t.Errorf("the SAS answer was sent as a message\n%s", rb)
		}
	}
}

// ================================================================ A09b gate-2 round 3

// ldUseTextInput makes r the `text` command's input for this test.
func ldUseTextInput(t *testing.T, r io.Reader) {
	t.Helper()
	oldIn, oldTTY := textStdin, textStdinIsTTY
	textStdin = func() io.Reader { return r }
	textStdinIsTTY = func() bool { return false }
	t.Cleanup(func() { textStdin, textStdinIsTTY = oldIn, oldTTY })
}

// ldFailingReader yields data, then err.
type ldFailingReader struct {
	data []byte
	err  error
}

func (f *ldFailingReader) Read(p []byte) (int, error) {
	if len(f.data) == 0 {
		return 0, f.err
	}
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

// ldInputLossCannotSucceed: input that could not be read ends the `text` run
// as a failure, and nothing after the unreadable point is sent.
func ldInputLossCannotSucceed(t *testing.T, in io.Reader, why string) {
	t.Helper()
	hub := startLinkDevHub(t)
	ldUseTextInput(t, in)
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "text", via: hub.url, args: []string{ldCode}},
		// The peer holds until WE leave. Leaving after the first text (as it
		// once did) raced our reader: when the peer left before the scan
		// reached the unreadable input, shutdown stopped the reader and the
		// run failed without naming the input (5 in 10 under -race; A10 r5).
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--script", ldScript(t, "hold"), ldCode}})
	if !strings.Contains(rb.stdout, "first line ok") {
		t.Fatalf("the line before the failure never arrived; the test proves nothing\n%s", rb)
	}
	if ra.code == 0 || !strings.Contains(ra.stderr, "input could not be read") || !strings.Contains(ra.stderr, why) {
		t.Errorf("lost input must fail the run (%s)\n%s", why, ra)
	}
	if strings.Contains(rb.stdout, "never sent") {
		t.Errorf("input after the failure was sent\n%s", rb)
	}
}

// Round 3 #1: a line over the 1 MiB input bound.
func TestLinkDevOversizedInputLineFails(t *testing.T) {
	ldInputLossCannotSucceed(t,
		strings.NewReader("first line ok\n"+strings.Repeat("a", 1<<20+10)+"\nnever sent\n"),
		"token too long")
}

// Round 3 #1: a read error on the input.
func TestLinkDevInputReadErrorFails(t *testing.T) {
	ldInputLossCannotSucceed(t,
		&ldFailingReader{data: []byte("first line ok\n"), err: errors.New("injected read failure")},
		"injected read failure")
}

// Round 3 #2: a run whose input read is blocked when its link ends returns
// promptly, and leaves the input to whoever reads it next: nothing of this
// run is still reading it.
func TestLinkDevShutdownReleasesBlockedInput(t *testing.T) {
	hub := startLinkDevHub(t)
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pr.Close(); pw.Close() })
	ldUseTextInput(t, pr)
	start := time.Now()
	ra, rb := ldPairUp(t, hub, "",
		ldPeer{cmd: "text", via: hub.url, args: []string{ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{ldCode}})
	if !strings.Contains(ra.stderr, "link admitted") || rb.code != 0 {
		t.Fatalf("want a link the peer ended while our input was blocked\nA: %s\nB: %s", ra, rb)
	}
	if el := time.Since(start); el > 10*time.Second {
		t.Errorf("the run took %v to return with its input blocked", el)
	}
	if _, err := pw.Write([]byte("later\n")); err != nil {
		t.Fatal(err)
	}
	if err := pr.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	n, err := pr.Read(buf)
	if err != nil || string(buf[:n]) != "later\n" {
		t.Fatalf("the ended run still read the input: next reader got %q (%v)", buf[:n], err)
	}
}

// ---------------------------------------------------------------- overrun diagnostics

// An end's output can be read while the end is still writing it (the
// overrun report reads a running end), and reading never alters it: every
// read is a prefix of the complete output, no write is torn, and the
// complete output is every write, once. Run with -race: the race detector,
// not the number of reads taken, is what checks the reads against the
// concurrent writes (removing either lock in ldBuf makes this test fail).
func TestLinkDevLiveOutputReadableWhileWriting(t *testing.T) {
	const writers, lines = 8, 400
	live := &ldLive{}
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < lines; i++ {
				fmt.Fprintf(&live.errb, "writer %d line %d %s\n", w, i, strings.Repeat("x", i%37))
				if i%50 == 0 {
					fmt.Fprintf(&live.out, "out %d %d\n", w, i)
				}
			}
		}(w)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	var reads []ldResult
	for running := true; running; {
		select {
		case <-done:
			running = false
		default:
		}
		r := live.pending()
		if r.code != -9 {
			t.Fatalf("a running end reads as exit %d, want -9", r.code)
		}
		reads = append(reads, r)
	}
	final := live.pending()
	for i, r := range reads {
		if !strings.HasPrefix(final.stderr, r.stderr) || !strings.HasPrefix(final.stdout, r.stdout) {
			t.Fatalf("read %d is not a prefix of the complete output", i)
		}
	}
	seen := map[string]int{}
	for _, l := range strings.Split(strings.TrimSuffix(final.stderr, "\n"), "\n") {
		seen[l]++
	}
	for w := 0; w < writers; w++ {
		for i := 0; i < lines; i++ {
			if l := fmt.Sprintf("writer %d line %d %s", w, i, strings.Repeat("x", i%37)); seen[l] != 1 {
				t.Fatalf("line %q appears %d times in the complete output", l, seen[l])
			}
		}
	}
	if len(seen) != writers*lines {
		t.Fatalf("%d distinct stderr lines, want %d (a torn write)", len(seen), writers*lines)
	}
	if got := strings.Count(final.stdout, "\n"); got != writers*lines/50 {
		t.Fatalf("%d stdout lines, want %d", got, writers*lines/50)
	}
	t.Logf("%d reads taken while %d writers ran (a count, not a measure of interleaving)", len(reads), writers)
}

// A pairing that ends in time is reported exactly as the ends returned it,
// with no diagnostics.
func TestLinkDevAwaitInTimeIsUntouched(t *testing.T) {
	a, b := make(chan ldResult, 1), make(chan ldResult, 1)
	wa, wb := ldResult{0, "a out\n", "a err\n"}, ldResult{3, "", "b failed\n"}
	a <- wa
	b <- wb
	called := false
	ra, rb, report, late := ldAwait(context.Background(), time.Second, a, b, &ldLive{}, &ldLive{},
		func() string { called = true; return "" })
	if late || report != "" || called || ra != wa || rb != wb {
		t.Fatalf("late=%t report=%q fixture read=%t\nfirst: %s\nsecond: %s", late, report, called, ra, rb)
	}
}

// ldParkedEnd stands in for an end that never returns; its name is what the
// goroutine dump must show.
func ldParkedEnd(release <-chan struct{}, ch chan<- ldResult) {
	<-release
	ch <- ldResult{code: 1}
}

// An overrun is still a failure (late), an end that returned keeps its own
// result, a still-running end reads as -9 with the output it had written,
// and the report carries the fixture captures requested at the deadline and
// after the grace plus a goroutine dump that includes the stuck end. Seconds, not the 95 s of the
// real ceiling.
func TestLinkDevAwaitOverrunReportsWhatIsStuck(t *testing.T) {
	a, b := make(chan ldResult, 1), make(chan ldResult, 1)
	la, lb := &ldLive{}, &ldLive{}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	go ldParkedEnd(release, b)
	fmt.Fprint(&lb.errb, "second: waiting for the peer\n")
	fmt.Fprint(&lb.out, "partial")
	wa := ldResult{0, "first done\n", "first ok\n"}
	var fixtureReads atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	go func() {
		<-ctx.Done()
		a <- wa // the first end finishes inside the grace
	}()
	ra, rb, report, late := ldAwait(ctx, 300*time.Millisecond, a, b, la, lb,
		func() string { return fmt.Sprintf("fixture read %d\n", fixtureReads.Add(1)) })
	if !late {
		t.Fatal("an overrun was not reported as late")
	}
	if ra != wa {
		t.Errorf("the end that returned in the grace lost its result: %s", ra)
	}
	if want := (ldResult{-9, "partial", "second: waiting for the peer\n"}); rb != want {
		t.Errorf("the running end reads %s, want %s", rb, want)
	}
	for _, want := range []string{
		"--- fixture capture requested at the deadline\nfixture read 1\n",
		"first still running=false, second still running=true",
		"--- fixture capture requested after the grace\nfixture read 2\n",
		"--- goroutines\n",
		"cmd/relayium.ldParkedEnd(",
		"=== end link-dev diagnostics ===",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("report lacks %q\n%s", want, report)
		}
	}
}

// ldSlowFixture is a fixture whose first capture (the one at the deadline)
// takes d; later captures return at once.
func ldSlowFixture(d time.Duration) func() string {
	var calls atomic.Int32
	return func() string {
		if calls.Add(1) == 1 {
			time.Sleep(d)
			return "slow capture done\n"
		}
		return "later capture\n"
	}
}

// The grace starts when the deadline passes, not after the deadline capture:
// with a 600 ms capture and a 200 ms grace, an end that finishes 500 ms after
// the deadline is past the grace and is reported still running. (Had the
// grace waited for the capture, it would have run to 800 ms and taken that
// end's result.) The slow capture's result, obtained within the shared
// budget, is still reported.
func TestLinkDevAwaitGraceNotDelayedBySlowCapture(t *testing.T) {
	a, b := make(chan ldResult, 1), make(chan ldResult, 1)
	la := &ldLive{}
	fmt.Fprint(&la.errb, "first: partial\n")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	go func() {
		<-ctx.Done()
		b <- ldResult{code: 0} // the second end ends at the deadline
		time.Sleep(500 * time.Millisecond)
		a <- ldResult{code: 0, stderr: "first: finished late\n"}
	}()
	ra, rb, report, late := ldAwait(ctx, 200*time.Millisecond, a, b, la, &ldLive{}, ldSlowFixture(600*time.Millisecond))
	if !late || rb.code != 0 {
		t.Fatalf("late=%t second=%s", late, rb)
	}
	if want := (ldResult{-9, "", "first: partial\n"}); ra != want {
		t.Errorf("the end that finished after the grace reads %s, want %s (the grace waited for the capture)", ra, want)
	}
	for _, want := range []string{
		"--- fixture capture requested at the deadline\nslow capture done\n",
		"first still running=true, second still running=false",
		"--- fixture capture requested after the grace\nlater capture\n",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("report lacks %q\n%s", want, report)
		}
	}
}

// ldHungFixture is a fixture capture that never returns (until the test
// ends); its name is what the goroutine dump must show.
func ldHungFixture(release <-chan struct{}) func() string {
	return func() string {
		<-release
		return "released\n"
	}
}

// A capture that never returns does not hold the failure back: the report
// arrives within the grace plus ldFixtureWait, reports that no capture
// result was obtained instead of inventing a state, and the dump shows the
// stuck capture.
func TestLinkDevAwaitHungCaptureCannotHoldFailure(t *testing.T) {
	a, b := make(chan ldResult, 1), make(chan ldResult, 1)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	go ldParkedEnd(release, b)
	a <- ldResult{code: 0}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, rb, report, late := ldAwait(ctx, 200*time.Millisecond, a, b, &ldLive{}, &ldLive{}, ldHungFixture(release))
	took := time.Since(start)
	if !late || rb.code != -9 {
		t.Fatalf("late=%t second=%s", late, rb)
	}
	// Deadline 50 ms + grace 200 ms + ldFixtureWait, with generous slack;
	// without the bound this call never returns.
	if limit := 250*time.Millisecond + ldFixtureWait + 3*time.Second; took > limit {
		t.Errorf("the report took %s, want under %s", took, limit)
	}
	for _, want := range []string{
		"--- fixture capture requested at the deadline: unavailable (no capture result was obtained within the shared 1s budget after the wait)",
		"--- fixture capture requested after the grace: unavailable",
		"ldHungFixture.func",
		"cmd/relayium.ldStartCapture.func1(",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("report lacks %q\n%s", want, report)
		}
	}
	if strings.Contains(report, "released") {
		t.Errorf("an unavailable capture was reported with a state\n%s", report)
	}
}

// Both ends returning inside the grace is still late, without a dump.
func TestLinkDevAwaitOverrunWithinGrace(t *testing.T) {
	a, b := make(chan ldResult, 1), make(chan ldResult, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	go func() { time.Sleep(50 * time.Millisecond); a <- ldResult{code: 0}; b <- ldResult{code: 2} }()
	ra, rb, report, late := ldAwait(ctx, 5*time.Second, a, b, &ldLive{}, &ldLive{}, nil)
	if !late || ra.code != 0 || rb.code != 2 {
		t.Fatalf("late=%t first=%d second=%d", late, ra.code, rb.code)
	}
	if strings.Contains(report, "--- goroutines") || !strings.Contains(report, "both ends returned within the 5s grace") {
		t.Errorf("report:\n%s", report)
	}
}

// The goroutine dump is bounded.
func TestLinkDevStacksBounded(t *testing.T) {
	s := ldStacks(512)
	if !strings.HasPrefix(s, "goroutine ") || !strings.Contains(s, "[goroutine dump truncated at 512 bytes]") || len(s) > 512+64 {
		t.Fatalf("%d bytes:\n%s", len(s), s)
	}
	if s := ldStacks(ldStackMax); strings.Contains(s, "truncated") || !strings.Contains(s, "TestLinkDevStacksBounded") {
		t.Fatalf("an unbounded-enough dump was truncated or lacks this goroutine")
	}
}

// The real fixture end to end: a real in-process end against the real hub
// and the patched TURN, with no second end yet, overruns a short deadline.
// The report reads that running end and shows its join, the relay's state
// and the stuck Run; then a second end arrives and both finish, so nothing
// is left running.
func TestLinkDevOverrunDiagnosticsOnRealFixture(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevHubICE(t, ldJSONICE(map[string]any{
		"iceServers": []any{map[string]any{"urls": "stun:" + lt.addr}, lt.cred(time.Now().Add(time.Hour), "owner1.tagA")},
	}))
	hub.diag = lt.diagnostics
	end := func() ldPeer {
		return ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", t.TempDir(),
			"--script", ldScript(t, "text ping", "wait-texts 1"), ldCode}}
	}
	a, la := ldStartLive(context.Background(), t, "", end())
	select {
	case <-hub.joins:
	case <-time.After(30 * time.Second):
		t.Fatal("first peer never joined")
	}
	never := make(chan ldResult)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	ra, _, report, late := ldAwait(ctx, 200*time.Millisecond, a, never, la, &ldLive{}, hub.diagnostics)
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("%s", report)
		}
	})
	fixture, _, _ := strings.Cut(report, "--- goroutines")
	t.Logf("%s(goroutine dump: %d bytes)", fixture, len(report)-len(fixture))
	if !late || ra.code != -9 {
		t.Errorf("late=%t first=%s", late, ra)
	}
	for _, want := range []string{"join peer1 room=testroom peers=1", "relay " + lt.addr + ": live allocations ", "first still running=true", "cmd/relayium.Run("} {
		if !strings.Contains(report, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	b, _ := ldStartLive(context.Background(), t, "", end())
	for i, ch := range []<-chan ldResult{a, b} {
		select {
		case r := <-ch:
			if r.code != 0 || !strings.Contains(r.stdout, "ping") {
				t.Errorf("end %d after the overrun:\n%s", i+1, r)
			}
		case <-time.After(90 * time.Second):
			t.Fatalf("end %d never finished after the overrun", i+1)
		}
	}
}
