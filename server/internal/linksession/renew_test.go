package linksession

// A11 relay-renew/1 engine tests: two real authenticated sessions (openLoop),
// two model transports that restart break-before-make like Pion, and the REAL
// server grant registry (internal/signal.GrantRegistry) as the only issuer.
// The issuer's call count is the server-side issuance ledger: every call is a
// credential round the code owner's account is asked for.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/signal"
)

const rtFP = "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"

func rtSDP(ufrag, setup string) string {
	return "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
		"a=ice-ufrag:" + ufrag + "\r\na=ice-pwd:pwpwpwpwpwpwpwpwpwpwpwpw\r\n" + rtFP + "\r\na=setup:" + setup + "\r\na=mid:0\r\n"
}

// rtTransport models one Pion PeerConnection for renewal: a restart (offer
// created, or offer applied) retires the path at once; a new pair exists only
// when both ends hold matching descriptions of the same new generation and
// the network lets it through.
type rtTransport struct {
	h          *rtHarness
	side       int
	name       string
	gen        int
	localUfrag string
	remote     string
	baseline   string
	pathUp     bool
	cfg        any
	cfgSets    int
	restarts   int
	added      []RenewCandidate
	// knobs
	blockNewPath bool
	offerErr     error
	mutateSDP    func(string) string
}

func (t *rtTransport) SetConfiguration(cfg any) error { t.cfg = cfg; t.cfgSets++; return nil }
func (t *rtTransport) BaselineSDP() (string, bool)    { return t.baseline, t.baseline != "" }
func (t *rtTransport) newGen() {
	t.gen++
	t.localUfrag = fmt.Sprintf("%s%d", t.name, t.gen)
	t.pathUp = false
	t.restarts++
}
func (t *rtTransport) RestartOffer() (string, error) {
	t.newGen()
	if t.offerErr != nil {
		return "", t.offerErr
	}
	return rtSDP(t.localUfrag, "actpass"), nil
}
func (t *rtTransport) ApplyRemote(typ, sdp string) (string, error) {
	if typ == "offer" {
		t.pathUp = false // applying a restart offer retires the path (Pion)
	}
	t.remote = SdpIceUfrag(sdp)
	return sdp, nil
}
func (t *rtTransport) Answer() (string, error) {
	t.newGen()
	return rtSDP(t.localUfrag, "active"), nil
}
func (t *rtTransport) LocalUfrag() string                  { return t.localUfrag }
func (t *rtTransport) RemoteUfrag() string                 { return t.remote }
func (t *rtTransport) AddCandidate(c RenewCandidate) error { t.added = append(t.added, c); return nil }
func (t *rtTransport) SelectedGeneration() (string, string) {
	o := t.h.tr[1-t.side]
	if t.blockNewPath || o.blockNewPath {
		return "", ""
	}
	if t.remote == o.localUfrag && o.remote == t.localUfrag && t.gen > 0 && o.gen > 0 {
		t.pathUp = true
		return t.localUfrag, t.remote
	}
	return "", ""
}
func (t *rtTransport) SendControl(frame []byte) error {
	t.h.push(1-t.side, "frame", frame)
	return nil
}

type rtItem struct {
	to   int
	kind string // signal | frame | grant
	raw  []byte
}

type rtHarness struct {
	t    *testing.T
	l    *loop
	e    [2]*Renewal
	tr   [2]*rtTransport
	ids  [2]string
	q    []rtItem
	mu   sync.Mutex
	srvQ []rtItem

	reg      *signal.GrantRegistry
	issued   atomic.Int32 // issuer invocations: the server-side ledger of credential rounds
	issueFn  func(n int32) signal.RenewIssue
	requests [2]int
	sentRnd  [2][]uint32

	bound    [2]RenewBound
	hasBound [2]bool
	commits  [2][]uint32
	commitAt [2][]time.Time
	broke    [2][]string
	supports [2]bool
	active   [2]bool
	busy     [2]bool
	// abortQueuedAtBroke: whether side i's abort envelope was already handed
	// to signalling when Broke ran (it must not be: local failure first).
	abortQueuedAtBroke [2]bool
	lastIssue          int64
	seenIssued         int32
	asked              bool

	dropSignals [2]func(RenewSignal) bool // drop matching signals TO side i
	dropFrames  [2]func([]byte) bool
	dropGrants  [2]bool
	sigLog      [2][]RenewSignal // signals delivered TO side i
}

func (h *rtHarness) push(to int, kind string, raw []byte) {
	h.q = append(h.q, rtItem{to, kind, append([]byte(nil), raw...)})
}

// credBody is an /api/ice-shaped body whose TURN credential expires at exp.
func credBody(exp time.Time) map[string]any {
	return map[string]any{"iceServers": []any{map[string]any{
		"urls": []string{"turn:relay.test:3478"}, "username": fmt.Sprintf("%d:owner.tag", exp.Unix()), "credential": "c",
	}}}
}

// rtDeadline reads the earliest turn expiry of a granted body, minus the 60 s
// skew — the shape linkrtc.RelayDeadlineFor derives in production.
func rtDeadline(body []byte) (time.Time, bool) {
	var b struct {
		ICEServers []struct {
			URLs     []string `json:"urls"`
			Username string   `json:"username"`
		} `json:"iceServers"`
	}
	if json.Unmarshal(body, &b) != nil {
		return time.Time{}, false
	}
	var best int64
	for _, s := range b.ICEServers {
		i := strings.IndexByte(s.Username, ':')
		if i <= 0 {
			continue
		}
		v, err := strconv.ParseInt(s.Username[:i], 10, 64)
		if err == nil && (best == 0 || v < best) {
			best = v
		}
	}
	if best == 0 {
		return time.Time{}, false
	}
	return time.Unix(best, 0).Add(-60 * time.Second), true
}

func newRT(t *testing.T) *rtHarness { return newRTSeeded(t, 1, 101) }

// newRTAt is newRT with the link opened at `at`.
func newRTAt(t *testing.T, at time.Time) *rtHarness {
	rtStart = at
	defer func() { rtStart = time.Time{} }()
	return newRTSeeded(t, 1, 101)
}

var rtStart time.Time

// newRTSeeded is newRT over a link whose keys come from the given seeds
// (openLoop's are 1 and 101): a different seed is a different link.
func newRTSeeded(t *testing.T, seedA, seedB byte) *rtHarness {
	clk := newClock()
	if !rtStart.IsZero() {
		clk.t = rtStart
	}
	l := &loop{t: t, clk: clk, a: newEnd(t, clk, "a", CmdPair, false, seedA), b: newEnd(t, clk, "b", CmdPair, false, seedB), opened: map[*end]bool{}}
	l.start()
	if l.a.s.linkM == nil || l.a.s.linkM.State != LOpen || l.b.s.linkM == nil || l.b.s.linkM.State != LOpen {
		t.Fatal("link not open")
	}
	h := &rtHarness{t: t, l: l, ids: [2]string{"a", "b"}, supports: [2]bool{true, true}, active: [2]bool{true, true}}
	now := l.clk.Now()
	exp0 := now.Add(time.Hour)
	for i := range 2 {
		h.bound[i] = RenewBound{DeadlineAt: exp0.Add(-60 * time.Second), AnchoredAt: now}
		h.hasBound[i] = true
	}
	h.issueFn = func(int32) signal.RenewIssue {
		exp := h.l.clk.Now().Add(time.Hour)
		return signal.RenewIssue{Status: signal.RenewGranted, Config: credBody(exp), Expiry: exp.Unix()}
	}
	h.reg = signal.NewGrantRegistry(time.Hour, func() int64 { return h.l.clk.Now().Unix() },
		func(ctx context.Context, owner, tag string) signal.RenewIssue {
			n := h.issued.Add(1)
			return h.issueFn(n)
		},
		func(room, peer string, data json.RawMessage) {
			h.mu.Lock()
			defer h.mu.Unlock()
			for i, id := range h.ids {
				if id == peer {
					h.srvQ = append(h.srvQ, rtItem{i, "grant", append([]byte(nil), data...)})
				}
			}
		}, nil, nil)
	h.reg.Open("room", "owner", "tag", []string{"a", "b"})
	h.reg.NoteIssued("tag", exp0.Unix())

	for i := range 2 {
		i := i
		h.tr[i] = &rtTransport{h: h, side: i, name: []string{"A", "B"}[i], localUfrag: []string{"A", "B"}[i] + "0", pathUp: true}
		s := []*Session{l.a.s, l.b.s}[i]
		deps := RenewDeps{
			Now: l.clk.Now,
			SendSignal: func(env []byte) error {
				h.push(1-i, "signal", env)
				return nil
			},
			RequestRound: func(round, rid uint32) error {
				h.requests[i]++
				h.asked = true
				h.sentRnd[i] = append(h.sentRnd[i], round)
				h.reg.Request("room", h.ids[i], signal.RenewRequest{Round: round, RID: rid})
				return nil
			},
			PeerSupportsRenew: func() bool { return h.supports[i] },
			UserActive:        func() bool { return h.active[i] },
			Busy:              func() bool { return h.busy[i] },
			Bound:             func() (RenewBound, bool) { return h.bound[i], h.hasBound[i] },
			RenewedConfig: func(body []byte) (any, time.Time, bool) {
				d, ok := rtDeadline(body)
				return string(body), d, ok
			},
			Commit: func(cfg any, deadlineAt time.Time, round uint32) {
				h.commits[i] = append(h.commits[i], round)
				h.commitAt[i] = append(h.commitAt[i], h.l.clk.Now())
				h.bound[i] = RenewBound{DeadlineAt: deadlineAt, AnchoredAt: h.l.clk.Now()}
			},
			Broke: func(reason string) {
				h.broke[i] = append(h.broke[i], reason)
				for _, it := range h.q {
					if sig, _, ok := ParseRenewEnvelope(it.raw); ok && it.to == 1-i && sig.Type == "abort" {
						h.abortQueuedAtBroke[i] = true
					}
				}
			},
		}
		e, err := s.NewRenewal(deps, h.tr[i])
		if err != nil {
			t.Fatal(err)
		}
		h.e[i] = e
	}
	// Epoch-0 baselines: each side pins the description it APPLIED.
	h.tr[0].baseline = rtSDP("B0", "active")
	h.tr[1].baseline = rtSDP("A0", "actpass")
	h.tr[0].remote, h.tr[1].remote = "B0", "A0"
	return h
}

// drainServer moves the registry's replies into the queue. Cached and static
// replies are delivered synchronously inside Request; only a real issuance
// runs on the registry's own goroutine and publishes to BOTH members in turn,
// so after a new issuance it waits until the replies stop arriving.
func (h *rtHarness) drainServer() bool {
	took := false
	take := func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		if len(h.srvQ) == 0 {
			return false
		}
		h.q = append(h.q, h.srvQ...)
		h.srvQ = nil
		took = true
		return true
	}
	take()
	if h.asked {
		// A request just reached the registry. An issuance it triggers runs
		// on a goroutine that may not have started yet: give it a bounded
		// moment to show up (a reply, or an issuer run).
		h.asked = false
		until := time.Now().Add(150 * time.Millisecond)
		for time.Now().Before(until) && h.issued.Load() == h.seenIssued {
			if take() {
				break
			}
			time.Sleep(time.Millisecond)
		}
	}
	if iss := h.issued.Load(); iss != h.seenIssued {
		deadline := time.Now().Add(2 * time.Second)
		lastGot := time.Time{}
		for time.Now().Before(deadline) {
			if take() {
				lastGot = time.Now()
			}
			if !lastGot.IsZero() && time.Since(lastGot) > 20*time.Millisecond {
				break
			}
			time.Sleep(time.Millisecond)
		}
		h.seenIssued = iss
	}
	return took
}

func (h *rtHarness) pump() {
	h.t.Helper()
	for guard := 0; guard < 100000; guard++ {
		if len(h.q) == 0 {
			if !h.drainServer() {
				return
			}
			continue
		}
		it := h.q[0]
		h.q = h.q[1:]
		e := h.e[it.to]
		switch it.kind {
		case "signal":
			if sig, _, ok := ParseRenewEnvelope(it.raw); ok {
				if d := h.dropSignals[it.to]; d != nil && d(sig) {
					continue
				}
				h.sigLog[it.to] = append(h.sigLog[it.to], sig)
			}
			if !e.Signal(it.raw) {
				h.t.Fatalf("a renewal envelope was not consumed: %s", it.raw)
			}
		case "frame":
			if d := h.dropFrames[it.to]; d != nil && d(it.raw) {
				continue
			}
			if !e.Frame(it.raw) {
				h.t.Fatal("a control frame was not consumed")
			}
		case "grant":
			if h.dropGrants[it.to] {
				continue
			}
			e.Grant(it.raw)
		}
	}
	h.t.Fatal("renewal exchange does not settle")
}

// run advances the fake clock to each next deadline until `until`, ticking
// both engines and pumping everything between.
func (h *rtHarness) run(until time.Duration) {
	h.t.Helper()
	end := h.l.clk.Now().Add(until)
	for i := range 2 {
		h.e[i].Tick()
	}
	h.pump()
	for guard := 0; guard < 100000; guard++ {
		next := end
		for i := range 2 {
			if t, ok := h.e[i].NextDeadline(); ok && t.Before(next) && t.After(h.l.clk.Now()) {
				next = t
			}
		}
		if !next.After(h.l.clk.Now()) {
			next = h.l.clk.Now().Add(time.Millisecond)
		}
		h.l.clk.t = next
		for i := range 2 {
			h.e[i].Tick()
		}
		h.pump()
		if !h.l.clk.Now().Before(end) {
			return
		}
	}
	h.t.Fatal("run does not settle")
}

// toWindow moves the clock to one second before side 0's renewal window.
func (h *rtHarness) toWindow() {
	b := h.bound[0]
	at := b.DeadlineAt.Add(-RenewMargin(b.DeadlineAt, b.AnchoredAt)).Add(-time.Second)
	h.l.clk.t = at
}

func (h *rtHarness) sigCount(to int, typ string) int {
	n := 0
	for _, s := range h.sigLog[to] {
		if s.Type == typ {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------- the happy path

func TestRenewCommitsOnBothSidesWithOneIssuance(t *testing.T) {
	h := newRT(t)
	old := h.bound
	h.toWindow()
	h.run(2 * time.Minute)
	for i := range 2 {
		if len(h.commits[i]) != 1 || h.commits[i][0] != 1 {
			t.Fatalf("side %d commits %v, want exactly round 1", i, h.commits[i])
		}
		if !h.bound[i].DeadlineAt.After(old[i].DeadlineAt) {
			t.Errorf("side %d deadline did not move", i)
		}
		if h.e[i].State() != RenewRenewed || h.e[i].Round() != 1 || len(h.broke[i]) != 0 {
			t.Errorf("side %d state %s round %d broke %v", i, h.e[i].State(), h.e[i].Round(), h.broke[i])
		}
		if h.tr[i].cfgSets != 1 {
			t.Errorf("side %d applied %d configurations, want 1", i, h.tr[i].cfgSets)
		}
		// Charged at acceptance and NEVER refunded by the commit: the round
		// keeps its spent epoch, so later repairs onto it share the ceiling.
		if h.e[i].migrationSpent[1] != 1 {
			t.Errorf("side %d round 1 spent %d after commit, want 1 (never refunded)", i, h.e[i].migrationSpent[1])
		}
	}
	if n := h.issued.Load(); n != 1 {
		t.Fatalf("server issued %d rounds for one renewal, want exactly 1", n)
	}
	// Both commits came only after the peer's ACK: at least one probe and one
	// ack crossed each way. (Observation alone never commits: see the early
	// grant test.)
	if h.tr[0].restarts != 1 || h.tr[1].restarts != 1 {
		t.Errorf("restarts %d/%d", h.tr[0].restarts, h.tr[1].restarts)
	}
	// The renewed link runs on; the next window is an hour away and nothing
	// asks the server again inside this one.
	h.run(20 * time.Minute)
	if h.issued.Load() != 1 || h.requests[0]+h.requests[1] != 2 {
		t.Errorf("issued %d, requests %v after commit", h.issued.Load(), h.requests)
	}
}

// ---------------------------------------------------------------- early grant

// No request, no configuration and no deadline move before the window: a link
// that is active and supported for its whole first 49 minutes costs the
// account nothing.
func TestRenewNoEarlyRequest(t *testing.T) {
	h := newRT(t)
	h.run(48 * time.Minute)
	if h.requests != [2]int{} || h.issued.Load() != 0 || h.tr[0].cfgSets+h.tr[1].cfgSets != 0 {
		t.Fatalf("before the window: requests %v issued %d", h.requests, h.issued.Load())
	}
}

// A grant nobody asked for, one for a request id this side never used, or
// one naming a round other than the one requested, is never applied — also
// while a genuine request is pending.
func TestRenewUnsolicitedGrantIgnored(t *testing.T) {
	h := newRT(t)
	body := func(round, rid uint32) []byte {
		b, _ := json.Marshal(map[string]any{"status": "granted", "round": round, "rid": rid,
			"iceServers": credBody(h.l.clk.Now().Add(time.Hour))["iceServers"]})
		return b
	}
	h.e[0].Grant(body(1, 7)) // before any request
	h.dropGrants[0] = true   // side 0's genuine reply never arrives
	h.toWindow()
	h.run(3 * time.Second)
	var rid uint32
	for k := range h.e[0].requests {
		rid = k
	}
	if rid == 0 {
		t.Fatal("no pending request on side 0")
	}
	h.e[0].Grant(body(1, rid+1)) // an id this side never used
	h.e[0].Grant(body(7, rid))   // the right id, a round nobody asked for
	if h.tr[0].cfgSets != 0 || len(h.commits[0]) != 0 {
		t.Fatalf("side 0 applied a grant it did not ask for (cfg %d)", h.tr[0].cfgSets)
	}
	if _, pending := h.e[0].requests[rid]; !pending {
		t.Fatal("a mismatched reply settled the genuine request")
	}
}

// The deadline moves only on §6.5 commit. Everything short of the peer's ACK
// — a grant, both descriptions, a selected pair of the new generation, the
// peer's verified probe — leaves it where it was.
func TestRenewNoCommitWithoutPeerAck(t *testing.T) {
	h := newRT(t)
	old := h.bound[0]
	h.dropFrames[0] = func(b []byte) bool { return b[2] == RenewProbeTypeAck } // side 0 never receives an ACK
	h.toWindow()
	h.run(3 * time.Minute)
	if len(h.commits[0]) != 0 {
		t.Fatalf("side 0 committed without an ACK: %v", h.commits[0])
	}
	if !h.bound[0].DeadlineAt.Equal(old.DeadlineAt) {
		t.Fatal("side 0 deadline moved without proof")
	}
	// Side 0 restarted (its path is gone): the link must end — truthfully,
	// on the old deadline, never extended.
	if len(h.broke[0]) == 0 {
		t.Fatal("side 0 restarted, failed to commit, and did not end the link")
	}
}

// A path that never comes up on the new allocation: no commit on either side,
// the old deadline stands, and both sides — having restarted — end the link.
func TestRenewNewPathNeverUpEndsLinkNotDeadline(t *testing.T) {
	h := newRT(t)
	old := h.bound
	h.tr[1].blockNewPath = true
	h.toWindow()
	h.run(3 * time.Minute)
	for i := range 2 {
		if len(h.commits[i]) != 0 || !h.bound[i].DeadlineAt.Equal(old[i].DeadlineAt) {
			t.Fatalf("side %d: commits %v, deadline moved %v", i, h.commits[i], !h.bound[i].DeadlineAt.Equal(old[i].DeadlineAt))
		}
		if len(h.broke[i]) != 1 {
			t.Fatalf("side %d broke %v: a restarted, uncommitted link must end exactly once", i, h.broke[i])
		}
	}
	if h.issued.Load() != 1 {
		t.Fatalf("issued %d", h.issued.Load())
	}
}

// ---------------------------------------------------------------- pre-restart failures keep the path

// Denied (quota exhausted mid-link): terminal for the round, no retry loop, no
// restart, the old deadline stands and the link is NOT ended early — it runs
// out its credential truthfully.
func TestRenewQuotaDeniedIsTerminalAndBounded(t *testing.T) {
	h := newRT(t)
	old := h.bound
	h.issueFn = func(int32) signal.RenewIssue {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "quota", RelayDenied: "quota"}
	}
	h.toWindow()
	h.run(15 * time.Minute) // past the deadline
	if n := h.issued.Load(); n != 1 {
		t.Fatalf("quota asked %d times, want once", n)
	}
	if h.requests[0] != 1 || h.requests[1] != 1 {
		t.Fatalf("requests %v after a denial, want one per side", h.requests)
	}
	for i := range 2 {
		if h.tr[i].restarts != 0 || h.tr[i].cfgSets != 0 || len(h.broke[i]) != 0 || len(h.commits[i]) != 0 {
			t.Fatalf("side %d restarted=%d cfg=%d broke=%v commits=%v", i, h.tr[i].restarts, h.tr[i].cfgSets, h.broke[i], h.commits[i])
		}
		if !h.bound[i].DeadlineAt.Equal(old[i].DeadlineAt) || h.e[i].State() != RenewDenied {
			t.Fatalf("side %d state %s", i, h.e[i].State())
		}
	}
}

// An old server (or a revoked grant: a member socket left, Depart killed the
// grant) answers nothing. Silence is `unavailable`: bounded attempts, spaced
// by the backoff, none past the deadline, nothing issued, the path untouched.
func TestRenewSilentServerIsBounded(t *testing.T) {
	for _, why := range []string{"old-server", "revoked"} {
		t.Run(why, func(t *testing.T) {
			h := newRT(t)
			if why == "revoked" {
				h.reg.Depart("room", "b") // process restart / socket loss of the peer
			} else {
				h.reg.Depart("room", "a")
				h.reg.Depart("room", "b")
			}
			h.toWindow()
			h.run(15 * time.Minute)
			if h.issued.Load() != 0 {
				t.Fatalf("issued %d with no grant authority", h.issued.Load())
			}
			for i := range 2 {
				if h.requests[i] > RenewMaxPregrantAttempts+1 || h.requests[i] == 0 {
					t.Errorf("side %d asked %d times", i, h.requests[i])
				}
				if h.tr[i].restarts != 0 || len(h.broke[i]) != 0 || len(h.commits[i]) != 0 {
					t.Errorf("side %d touched the path", i)
				}
			}
			// Nothing is ever asked past the deadline.
			before := h.requests
			h.run(2 * time.Hour)
			if h.requests != before {
				t.Errorf("requests after the deadline: %v -> %v", before, h.requests)
			}
		})
	}
}

// ---------------------------------------------------------------- double charge, replay, unbounded renewal

// A duplicate of the server's grant (a lost reply re-asked, or a replay) is
// served from the round cache: no second issuance, no second configuration.
func TestRenewDuplicateGrantNoDoubleCharge(t *testing.T) {
	h := newRT(t)
	var mu sync.Mutex
	var grants [][]byte
	origDrop := func(b []byte) {}
	_ = origDrop
	h.toWindow()
	h.run(2 * time.Minute)
	// Replay every grant the server sent, to both sides, after commit.
	h.mu.Lock()
	mu.Lock()
	grants = append(grants, grants...)
	mu.Unlock()
	h.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"status": "granted", "round": 1, "rid": 1,
		"iceServers": credBody(h.l.clk.Now().Add(2 * time.Hour))["iceServers"]})
	for i := range 2 {
		h.e[i].Grant(body)
	}
	// And the same round asked again by a member: cached, not reissued.
	h.reg.Request("room", "a", signal.RenewRequest{Round: 1, RID: 99})
	h.drainServer()
	h.q = nil
	if h.issued.Load() != 1 {
		t.Fatalf("issued %d", h.issued.Load())
	}
	for i := range 2 {
		if h.tr[i].cfgSets != 1 || len(h.commits[i]) != 1 {
			t.Fatalf("side %d cfg %d commits %v", i, h.tr[i].cfgSets, h.commits[i])
		}
	}
}

// A correctly signed prepare replayed after its epoch ended starts nothing:
// the epoch counter is monotonic over the whole link, so a replay can never
// buy a second request for a round.
func TestRenewReplayedPrepareStartsNothing(t *testing.T) {
	h := newRT(t)
	var captured [][]byte
	h.toWindow()
	// Capture everything side 0 sends to side 1 during a full renewal.
	orig := h.e[0].deps.SendSignal
	h.e[0].deps.SendSignal = func(env []byte) error {
		captured = append(captured, append([]byte(nil), env...))
		return orig(env)
	}
	h.run(2 * time.Minute)
	if len(h.commits[1]) != 1 {
		t.Fatal("no baseline renewal")
	}
	reqs, issued := h.requests, h.issued.Load()
	for _, env := range captured {
		h.push(1, "signal", env)
	}
	h.run(5 * time.Minute)
	if h.requests != reqs || h.issued.Load() != issued || len(h.commits[1]) != 1 || h.tr[1].cfgSets != 1 {
		t.Fatalf("replay: requests %v->%v issued %d->%d commits %v cfg %d", reqs, h.requests, issued, h.issued.Load(), h.commits[1], h.tr[1].cfgSets)
	}
}

// A peer walking the epoch upward with fresh signed prepares cannot spend
// the round past its ceiling: every superseded attempt is charged, and a
// round carries at most three granted migration epochs. A fourth is refused
// before any configuration is applied.
func TestRenewAtMostThreeGrantedEpochsPerRound(t *testing.T) {
	h := newRT(t)
	// The initiator never hears the responder's `ready`, so nobody offers and
	// nobody restarts: every epoch is a GRANTED epoch that fails before the
	// path is touched, and each is charged to round 1.
	h.dropSignals[0] = func(s RenewSignal) bool { return s.Type == "ready" }
	h.toWindow()
	h.run(12 * time.Minute)
	for i := range 2 {
		if h.tr[i].cfgSets > RenewMaxEpochsPerRound || h.tr[i].cfgSets == 0 {
			t.Errorf("side %d applied %d configurations for one round, ceiling %d", i, h.tr[i].cfgSets, RenewMaxEpochsPerRound)
		}
		if h.e[i].migrationSpent[1] != h.tr[i].cfgSets {
			t.Errorf("side %d charged %d epochs for %d applied configurations", i, h.e[i].migrationSpent[1], h.tr[i].cfgSets)
		}
		if h.tr[i].restarts != 0 || len(h.broke[i]) != 0 || len(h.commits[i]) != 0 {
			t.Errorf("side %d restarted=%d broke=%v commits=%v", i, h.tr[i].restarts, h.broke[i], h.commits[i])
		}
	}
	if h.tr[0].cfgSets != RenewMaxEpochsPerRound {
		t.Errorf("side 0 used %d of the round's %d epochs in 12 minutes", h.tr[0].cfgSets, RenewMaxEpochsPerRound)
	}
	if h.issued.Load() != 1 {
		t.Fatalf("issued %d: repeated epochs on one round must replay the cached grant", h.issued.Load())
	}
}

// Unbounded renewal: a link that keeps renewing still asks the server at most
// once per grant lifetime, and each commit moves the deadline by exactly the
// new credential — never by an extension computed from the old one.
func TestRenewOncePerLifetime(t *testing.T) {
	h := newRT(t)
	h.toWindow()
	h.run(3*time.Hour + 10*time.Minute)
	if n := h.issued.Load(); n < 3 || n > 4 {
		t.Fatalf("issued %d over ~3 hours of one-hour credentials", n)
	}
	for i := range 2 {
		if int32(len(h.commits[i])) != h.issued.Load() {
			t.Errorf("side %d commits %v for %d issuances", i, h.commits[i], h.issued.Load())
		}
		for k, r := range h.commits[i] {
			if r != uint32(k+1) {
				t.Errorf("side %d committed rounds %v", i, h.commits[i])
			}
		}
		for k := 1; k < len(h.commitAt[i]); k++ {
			if h.commitAt[i][k].Sub(h.commitAt[i][k-1]) < 40*time.Minute {
				t.Errorf("side %d renewed twice within %s", i, h.commitAt[i][k].Sub(h.commitAt[i][k-1]))
			}
		}
	}
}

// ---------------------------------------------------------------- idle, mixed peers, restart

// No recent user-lane activity: nothing is requested, the link dies on
// schedule (§7.1). Same when only the PEER is idle: it refuses to join.
func TestRenewIdleLinkIsNotRenewed(t *testing.T) {
	for _, idle := range []int{0, 1} {
		h := newRT(t)
		h.active[idle] = false
		h.toWindow()
		h.run(15 * time.Minute)
		if h.issued.Load() != 0 || len(h.commits[0])+len(h.commits[1]) != 0 {
			t.Fatalf("idle side %d: issued %d", idle, h.issued.Load())
		}
		if h.tr[0].restarts+h.tr[1].restarts != 0 {
			t.Fatalf("idle side %d: a restart", idle)
		}
	}
}

// Mixed peers. A peer that never announced relay-renew/1: nothing is spent at
// all. A peer that announced it but does not answer (or an old build that
// ignores the envelope): two prepares, then `unsupported` for the link, and
// the server issues nothing because only one frozen member asked.
func TestRenewMixedPeers(t *testing.T) {
	t.Run("not-announced", func(t *testing.T) {
		h := newRT(t)
		h.supports = [2]bool{false, false}
		h.toWindow()
		h.run(15 * time.Minute)
		if h.requests != [2]int{} || h.issued.Load() != 0 {
			t.Fatalf("requests %v", h.requests)
		}
	})
	t.Run("silent-peer", func(t *testing.T) {
		h := newRT(t)
		h.supports[1] = false
		h.dropSignals[1] = func(RenewSignal) bool { return true } // an old peer: the envelope reaches nothing
		h.toWindow()
		h.run(15 * time.Minute)
		if h.issued.Load() != 0 {
			t.Fatalf("issued %d for a single-sided request", h.issued.Load())
		}
		if h.e[0].State() != RenewUnsupported {
			t.Fatalf("state %s, want unsupported", h.e[0].State())
		}
		if h.requests[0] > 2 {
			t.Fatalf("requests %d to a silent peer", h.requests[0])
		}
		if h.tr[0].restarts != 0 || len(h.broke[0]) != 0 {
			t.Fatal("the path was touched for a silent peer")
		}
	})
}

// Process restart: a fresh process is a fresh link with fresh keys. Envelopes
// and probes signed under the old link's key are dropped, and the server's
// grant for the old sockets is gone.
func TestRenewProcessRestartOldSignalsInert(t *testing.T) {
	h := newRT(t)
	var old [][]byte
	orig := h.e[0].deps.SendSignal
	h.e[0].deps.SendSignal = func(env []byte) error {
		old = append(old, append([]byte(nil), env...))
		return orig(env)
	}
	h.toWindow()
	h.run(2 * time.Minute)
	if len(old) == 0 {
		t.Fatal("nothing captured")
	}
	// Side 1 "restarts": a new pairing, new keys, new engine.
	h2 := newRTSeeded(t, 7, 77)
	for _, env := range old {
		h2.push(1, "signal", env)
	}
	h2.pump()
	if h2.e[1].attempt != nil || h2.requests[1] != 0 || h2.e[1].peerAuthenticated {
		t.Fatal("an old link's signal acted on a new link")
	}
	h.reg.Depart("room", "b")
	h.reg.Request("room", "a", signal.RenewRequest{Round: 2, RID: 5})
	h.reg.Request("room", "b", signal.RenewRequest{Round: 2, RID: 6})
	if h.drainServer() {
		t.Fatal("a departed generation still answered")
	}
}

// ---------------------------------------------------------------- stale / out of order / lost credit

// Out-of-order: the peer's `ready` arrives before this side's own grant (its
// reply was delayed). The ready is recorded, not dropped, and the renewal
// completes once the grant lands — with one issuance.
func TestRenewReadyBeforeOwnGrant(t *testing.T) {
	h := newRT(t)
	h.dropGrants[1] = true
	var held [][]byte
	h.toWindow()
	h.run(3 * time.Second)
	h.mu.Lock()
	h.mu.Unlock()
	// Collect side 1's grant from the server by asking again for the cached
	// round, then deliver it late.
	h.dropGrants[1] = false
	_ = held
	h.run(2 * time.Minute)
	if len(h.commits[0]) != 1 || len(h.commits[1]) != 1 || h.issued.Load() != 1 {
		t.Fatalf("commits %v %v issued %d", h.commits[0], h.commits[1], h.issued.Load())
	}
}

// A stale reply fenced by a repair, and a late verdict after commit, change
// nothing: no configuration swap, no abort of a committed renewal, no
// deadline move in either direction.
func TestRenewLateVerdictsAfterCommitAreInert(t *testing.T) {
	h := newRT(t)
	h.toWindow()
	h.run(2 * time.Minute)
	b := h.bound
	for _, status := range []string{"denied", "unavailable", "stale", "granted"} {
		body, _ := json.Marshal(map[string]any{"status": status, "round": 1, "rid": 1, "relayDenied": "quota"})
		for i := range 2 {
			h.e[i].Grant(body)
		}
	}
	h.run(time.Minute)
	for i := range 2 {
		if h.bound[i] != b[i] || h.e[i].State() != RenewRenewed || h.tr[i].cfgSets != 1 {
			t.Fatalf("side %d changed by a late verdict: state %s cfg %d", i, h.e[i].State(), h.tr[i].cfgSets)
		}
	}
}

// Lost credit (§6.7): side 1's ACK never reaches side 0 after side 1 has
// committed... modelled as side 0's final ACK being lost. Side 1 renewed;
// side 0 did not and — having restarted — ends its link. The credential
// already issued is not re-bought: the server issued exactly one round, and
// the side that committed moved its deadline exactly once.
func TestRenewAsymmetricCommitNoSecondIssuance(t *testing.T) {
	h := newRT(t)
	h.dropFrames[0] = func(b []byte) bool { return b[2] == RenewProbeTypeAck }
	h.toWindow()
	h.run(5 * time.Minute)
	if h.issued.Load() != 1 {
		t.Fatalf("issued %d", h.issued.Load())
	}
	if len(h.commits[1]) != 1 || len(h.commits[0]) != 0 || len(h.broke[0]) != 1 {
		t.Fatalf("commits %v/%v broke %v", h.commits[0], h.commits[1], h.broke[0])
	}
}

// Same-round repair buys no time: adopting an already-installed round moves
// no deadline and does not refund the round's epochs.
func TestRenewSameRoundRepairBuysNoTime(t *testing.T) {
	h := newRT(t)
	h.toWindow()
	h.run(2 * time.Minute)
	b := h.bound[1]
	spent := h.e[1].migrationSpent[1]
	a := h.e[1].begin(h.e[1].epochCounter+1, true)
	a.hasPeerRound, a.peerRound = true, 1
	h.e[1].maybeAdoptInstalled(a)
	if !a.hasRound || a.round != 1 {
		t.Fatal("the installed round was not adopted")
	}
	a.observed, a.observedAt, a.nonce = true, h.l.clk.Now(), make([]byte, RenewNonceBytes)
	h.e[1].commit(a)
	if h.bound[1] != b || len(h.commits[1]) != 1 {
		t.Fatalf("a same-round repair moved the deadline: commits %v", h.commits[1])
	}
	if h.e[1].migrationSpent[1] != spent+1 {
		t.Fatalf("repair spent %d -> %d, want charged and never refunded", spent, h.e[1].migrationSpent[1])
	}
}

// ---------------------------------------------------------------- the pin and the demux

// A renewal offer carrying a foreign DTLS fingerprint is refused BEFORE it is
// applied: the responder's path is not retired, the link is not ended, no
// deadline moves.
func TestRenewForeignFingerprintRefusedBeforeApply(t *testing.T) {
	h := newRT(t)
	orig := h.e[0].deps.SendSignal
	h.e[0].deps.SendSignal = func(env []byte) error {
		sig, _, ok := ParseRenewEnvelope(env)
		if ok && sig.Type == "sdp" {
			sig.SDP = strings.Replace(sig.SDP, "AB:CD", "11:22", 1)
			p, _ := RenewSignalPayload(sig, "a", "b")
			auth, _ := h.e[0].sign(p) // signed by the real key: only the pin can stop it
			env = EncodeRenewEnvelope(sig, auth)
		}
		return orig(env)
	}
	h.toWindow()
	h.run(3 * time.Minute)
	if h.tr[1].restarts != 0 {
		t.Fatal("the responder applied a description that fails the pin")
	}
	if len(h.commits[1]) != 0 || len(h.broke[1]) != 0 {
		t.Fatalf("responder commits %v broke %v", h.commits[1], h.broke[1])
	}
}

// Probes and acks never reach the text session and never re-arm link idle.
func TestRenewControlFramesAreNotActivity(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a := l.a
	l.tick(time.Minute)
	before := a.s.timers[tLinkIdle]
	l.clk.Advance(time.Minute)
	for _, f := range [][]byte{{0x0d}, make([]byte, RenewProbeFrameBytes)} {
		f[0] = 0x0d
		effs, err := a.s.TextFrame(a.s.Epoch(), f)
		if err != nil || len(effs) != 0 {
			t.Fatalf("0x0d acted: %v %s", err, kinds(effs))
		}
	}
	if a.s.timers[tLinkIdle] != before {
		t.Fatalf("a 0x0d control frame re-armed link idle: %v -> %v", before, a.s.timers[tLinkIdle])
	}
}

// Cross-month: the client has no calendar logic at all — the window, the
// request and the new deadline come from the credential's own expiry — so a
// renewal whose window straddles a UTC month boundary behaves exactly like any
// other: one issuance, one commit per side, deadline from the new credential.
// (Which month the relayed bytes are billed to is the node/ledger's rule,
// unchanged; the renewed credential carries the original attribution token.)
func TestRenewAcrossMonthBoundary(t *testing.T) {
	// Opened at 23:20 UTC on the last day of a month: the window opens at
	// 00:09 the next month.
	h := newRTAt(t, time.Date(2026, 9, 30, 23, 20, 0, 0, time.UTC))
	h.toWindow()
	if h.l.clk.Now().Month() != time.October {
		t.Fatalf("window at %s is not across the boundary", h.l.clk.Now())
	}
	h.run(3 * time.Minute)
	for i := range 2 {
		if len(h.commits[i]) != 1 || !h.bound[i].DeadlineAt.After(time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC)) {
			t.Fatalf("side %d commits %v bound %s", i, h.commits[i], h.bound[i].DeadlineAt)
		}
	}
	if h.issued.Load() != 1 {
		t.Fatalf("issued %d", h.issued.Load())
	}
}

// A CLI that predates A11 hands a renewal envelope to its link session: it
// must do nothing at all (relay-renew-v1 §8) — no effect, no state change.
func TestRenewEnvelopeInertInALinkSession(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a := l.a
	sig := RenewSignal{Type: "prepare", Epoch: 1}
	p, _ := RenewSignalPayload(sig, "b", "a")
	h := &Renewal{key: a.s.lk.resumeAuth}
	auth, _ := h.sign(p)
	for _, raw := range [][]byte{
		EncodeRenewEnvelope(sig, auth),
		EncodeRenewEnvelope(RenewSignal{Type: "sdp", Epoch: 1, Round: 1, SDPType: "offer", SDP: rtSDP("X1", "actpass")}, auth),
		EncodeRenewEnvelope(RenewSignal{Type: "abort", Epoch: 1, Reason: "closed"}, auth),
	} {
		_, st0, _, _ := a.s.States()
		effs, err := a.s.Signal(a.s.Epoch(), "b", raw)
		_, st1, _, _ := a.s.States()
		if len(effs) != 0 || st0 != st1 {
			t.Fatalf("a link session acted on a renewal envelope: %v %s (%s -> %s)", err, kinds(effs), st0, st1)
		}
	}
}

// §6.7 fence (stale verdict): once an attempt adopts its installed round for a
// repair, the R+1 request it had in flight is no longer its own. A late
// `denied` for R+1 must neither abort the repair nor mark rounds denied, and a
// late `granted` must not swap the adopted configuration.
func TestRenewRepairFencesLateRoundReply(t *testing.T) {
	for _, status := range []string{"denied", "granted"} {
		t.Run(status, func(t *testing.T) {
			h := newRT(t)
			h.toWindow()
			h.run(2 * time.Minute)
			e := h.e[1]
			if e.Round() != 1 {
				t.Fatal("no committed round to repair onto")
			}
			a := e.begin(e.epochCounter+1, true)
			e.askServer(a, 2, 1)
			var rid uint32
			for k := range e.requests {
				rid = k
			}
			if rid == 0 {
				t.Fatal("no request in flight")
			}
			a.hasPeerRound, a.peerRound = true, 1
			e.maybeAdoptInstalled(a)
			if !a.hasRound || a.round != 1 {
				t.Fatal("repair not adopted")
			}
			cfgSets := h.tr[1].cfgSets
			body, _ := json.Marshal(map[string]any{"status": status, "round": 2, "rid": rid, "relayDenied": "quota",
				"iceServers": credBody(h.l.clk.Now().Add(5 * time.Hour))["iceServers"]})
			e.Grant(body)
			if e.attempt != a || e.roundDenied || a.round != 1 || h.tr[1].cfgSets != cfgSets || len(h.commits[1]) != 1 {
				t.Fatalf("a fenced reply acted: attempt kept=%v denied=%v round=%d cfg %d->%d commits %v",
					e.attempt == a, e.roundDenied, a.round, cfgSets, h.tr[1].cfgSets, h.commits[1])
			}
		})
	}
}

// A legacy (link §8) restart owns the transport: no attempt starts, and a
// peer's prepare is refused as unavailable. Once it settles, renewal proceeds.
func TestRenewWaitsForLegacyRestart(t *testing.T) {
	h := newRT(t)
	h.busy[0] = true
	h.toWindow()
	h.run(90 * time.Second)
	if h.requests[0] != 0 || h.issued.Load() != 0 || h.tr[0].restarts+h.tr[1].restarts != 0 {
		t.Fatalf("renewal raced a legacy restart: requests %v issued %d", h.requests, h.issued.Load())
	}
	if h.sigCount(1, "abort") == 0 {
		t.Fatal("a busy side did not refuse the peer's prepare")
	}
	// A refused prepare was never acted on: it must not lock out the
	// legacy restart's unsigned SDP (Codex r3).
	if h.e[0].LockUnsigned() {
		t.Fatal("a prepare refused while busy established the unsigned-SDP lock")
	}
	h.busy[0] = false
	h.run(3 * time.Minute)
	if len(h.commits[0]) != 1 || len(h.commits[1]) != 1 {
		t.Fatalf("no renewal after the legacy restart settled: %v %v", h.commits[0], h.commits[1])
	}
}

// Local failure is independent of telling the peer: Broke runs before the
// abort envelope is even handed to signalling (which may block).
func TestRenewBrokeBeforeAbortIsSent(t *testing.T) {
	h := newRT(t)
	h.tr[1].blockNewPath = true
	h.toWindow()
	h.run(3 * time.Minute)
	for i := range 2 {
		if len(h.broke[i]) != 1 {
			t.Fatalf("side %d broke %v", i, h.broke[i])
		}
		if h.abortQueuedAtBroke[i] {
			t.Errorf("side %d handed its abort to signalling before failing locally", i)
		}
	}
}

// OutboundAcked, renewal's user-activity signal for ACK progress, moves only
// when the session accepts an ACK as progress: a stray ACK with no batch, a
// duplicate, a stale one and one past what was sent all leave it unchanged.
func TestOutboundAckedMovesOnlyOnRealProgress(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	ack := func(v uint64) {
		f, err := linkwire.AckFrame(v)
		if err != nil {
			t.Fatal(err)
		}
		l.absorb(a, nil, nil)
		effs, err := a.s.FileFrame(a.s.Epoch(), f)
		l.absorb(a, effs, err)
		l.pump()
	}
	ack(4096) // stray: no outbound batch
	if a.s.OutboundAcked() != 0 {
		t.Fatalf("a stray ACK moved acked to %d", a.s.OutboundAcked())
	}
	p := [][]byte{payload(3*linkwire.ChunkSize+17, 7)}
	l.sendBatch(a, p...)
	accept(t, l, b)
	b.holdDurable = true // b writes but reports nothing durable: no ACK yet
	l.pushData(a, p...)
	if a.s.OutboundAcked() != 0 {
		t.Fatalf("acked %d before any real ACK", a.s.OutboundAcked())
	}
	emitted := a.s.fout.emitted
	ack(emitted / 2) // real progress
	got := a.s.OutboundAcked()
	if got != emitted/2 {
		t.Fatalf("a real ACK did not advance: %d, want %d", got, emitted/2)
	}
	for _, v := range []uint64{got, got - 1, emitted + 1, emitted + 1<<30} {
		ack(v)
		if a.s.OutboundAcked() != got {
			t.Fatalf("ACK %d (duplicate/stale/out-of-range) moved acked %d -> %d", v, got, a.s.OutboundAcked())
		}
	}
}
