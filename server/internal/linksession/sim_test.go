package linksession

import (
	"encoding/json"
	"fmt"
	"sort"
	"testing"
	"time"
)

// A discrete-event simulation of one pairing-code room: a signalling server
// that relays in order with a fixed one-way latency, optionally supports the
// additive roster hint, and delivers each side's roster after an optional
// extra delay (the hub coalesces rosters for up to 200 ms). Every message is
// real JSON. Peer models encode the SHIPPED behaviour of every client a new
// CLI can meet (A08-DESIGN §3.1):
//
//   old CLI  sends {kind:commit[,mode]} the moment its Join returns; exits on
//            the first non-kind frame (ErrPeerNotCLI) or on any other kind.
//   Web      hello ["link/1","preupload/1"] at roster gain, +1.5 s, +3.0 s;
//            any top-level string kind latches "CLI peer" and ends.
//   Android  as Web (first hello immediately); kind ends the session.
//   Apple    hello at roster gain, retries 1.5/3.0/4.5 s; decides "legacy"
//            5 s after roster without a link hello; kind ends. AppleDoc is the
//            link-v1 §1.3 variant (first hello on the 1.5 s tick). AppleLinkOff
//            announces [] (link mode inactive).
//   NewCLI   a real Session: RoomView, Signal and Tick in, effects out.

type actor interface {
	label() string
	hints() bool // puts "link/1" on its join
	peerKnown(now int, serverHints, peerHint bool) [][]byte
	recv(now int, raw []byte) [][]byte
	tick(now int) [][]byte
	outcome() string
}

func obj(raw []byte) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

func strField(m map[string]json.RawMessage, k string) (string, bool) {
	v, ok := m[k]
	if !ok || len(v) == 0 || v[0] != '"' {
		return "", false
	}
	var s string
	return s, json.Unmarshal(v, &s) == nil
}

func legacyCommit(mode string) []byte {
	if mode == "file" || mode == "" {
		return []byte(`{"kind":"commit","commit":"AAAA"}`)
	}
	return []byte(`{"kind":"commit","commit":"AAAA","mode":"` + mode + `"}`)
}

func commitMode(m map[string]json.RawMessage) string {
	if md, ok := strField(m, "mode"); ok {
		return md
	}
	return "file"
}

// ---- old CLI
type oldCLI struct {
	mode string
	out  string
}

func (o *oldCLI) label() string { return "oldCLI(" + o.mode + ")" }
func (o *oldCLI) hints() bool   { return false }
func (o *oldCLI) peerKnown(int, bool, bool) [][]byte {
	return [][]byte{legacyCommit(o.mode)}
}
func (o *oldCLI) recv(_ int, raw []byte) [][]byte {
	if o.out != "" {
		return nil
	}
	m := obj(raw)
	kind, isKind := strField(m, "kind")
	switch {
	case isKind && kind == "commit":
		if commitMode(m) == o.mode {
			o.out = "legacy-ok"
		} else {
			o.out = "fail:mode-mismatch"
		}
	case isKind:
		o.out = "fail:exit-quoting-kind"
	default:
		o.out = "fail:peer-not-cli(exit)"
	}
	return nil
}
func (o *oldCLI) tick(int) [][]byte { return nil }
func (o *oldCLI) outcome() string   { return o.out }

// ---- apps
type app struct {
	name     string
	caps     []string
	first    int // ms after roster for the first hello (0 = immediately)
	windowMs int // 0 = no settle window
	known    int
	knownSet bool
	sent     int
	heard    bool
	out      string
}

func (a *app) hello() []byte {
	b, _ := json.Marshal(map[string][]string{"caps": a.caps})
	return b
}
func (a *app) label() string { return a.name }
func (a *app) hints() bool   { return false }
func (a *app) peerKnown(now int, _, _ bool) [][]byte {
	a.known, a.knownSet = now, true
	if a.first == 0 {
		a.sent = 1
		return [][]byte{a.hello()}
	}
	return nil
}
func (a *app) recv(_ int, raw []byte) [][]byte {
	if a.out != "" {
		return nil
	}
	m := obj(raw)
	if _, isKind := strField(m, "kind"); isKind {
		a.out = "fail:cli-latched"
		return nil
	}
	if string(m["link"]) == "true" {
		if contains(a.caps, "link/1") {
			a.out = "link"
		}
		return nil
	}
	var caps []string
	if json.Unmarshal(m["caps"], &caps) == nil && m["caps"] != nil {
		a.heard = true
		if contains(caps, "link/1") && contains(a.caps, "link/1") {
			a.out = "link"
		}
	}
	return nil
}
func (a *app) tick(now int) [][]byte {
	if !a.knownSet {
		return nil
	}
	if a.windowMs > 0 && now-a.known >= a.windowMs && a.out == "" {
		a.out = "fail:legacy-lane(no link hello in window)"
	}
	// The FIRST announcement is owed by roster gain alone; hearing the peer
	// first never suppresses it, only the retries retire.
	if a.sent < 3 {
		due := a.known + a.first + 1500*a.sent
		if a.first == 0 {
			due = a.known + 1500*a.sent
		}
		first := a.first > 0 && a.sent == 0
		if now >= due && (first || !a.heard) {
			a.sent++
			return [][]byte{a.hello()}
		}
	}
	return nil
}
func (a *app) outcome() string { return a.out }

func web() actor     { return &app{name: "Web", caps: []string{"link/1", "preupload/1"}} }
func android() actor { return &app{name: "Android", caps: []string{"link/1"}} }
func apple() actor   { return &app{name: "Apple", caps: []string{"text/1", "link/1"}, windowMs: 5000} }
func appleOff() actor {
	return &app{name: "AppleLinkOff", caps: []string{}, windowMs: 5000}
}
func appleDoc() actor {
	return &app{name: "Apple(doc:first@1.5s)", caps: []string{"text/1", "link/1"}, first: 1500, windowMs: 5000}
}

// ---- the new CLI: a real Session plus a stub of the legacy handshake that
// rzvous would run after EffBeginLegacy (send own commit, read the peer's).
type newCLI struct {
	cmd                   Cmd
	mode                  string
	clk                   *fakeClock
	t0                    time.Time
	s                     *Session
	self, peer            string
	sentCommit, gotCommit bool
	peerMode              string
	out                   string
}

func newNew(cmd Cmd) *newCLI { return newNewWith(cmd, defaultTables, 0) }

func newNewWith(cmd Cmd, tb tables, discWait time.Duration) *newCLI {
	mode := map[Cmd]string{CmdPair: "", CmdSend: "file", CmdReceive: "file", CmdText: "text"}[cmd]
	clk := newClock()
	s, err := newSession(Config{Cmd: cmd, Clock: clk, Rand: newRand(byte(cmd) + 7)}, tb)
	if err != nil {
		panic(err)
	}
	if discWait > 0 {
		s.discWait = discWait
	}
	return &newCLI{cmd: cmd, mode: mode, clk: clk, t0: clk.t, s: s}
}

func (n *newCLI) label() string {
	return "NewCLI(" + map[Cmd]string{CmdPair: "pair", CmdSend: "send", CmdReceive: "receive", CmdText: "text"}[n.cmd] + ")"
}
func (n *newCLI) hints() bool { return true }

func (n *newCLI) at(now int) { n.clk.t = n.t0.Add(time.Duration(now) * time.Millisecond) }

func (n *newCLI) apply(effs []Effect) [][]byte {
	var out [][]byte
	for _, e := range effs {
		switch e.Kind {
		case EffSendSignal:
			out = append(out, e.Bytes)
		case EffSendOffer:
			out = append(out, offerJSON(e, "offer"))
		case EffSendAnswer:
			out = append(out, offerJSON(e, "answer"))
		case EffBeginLegacy:
			n.sentCommit = true
			out = append(out, legacyCommit(n.mode))
			if e.Bytes != nil {
				n.legacyFrame(e.Bytes)
			}
		case EffLegacyFrame:
			n.legacyFrame(e.Bytes)
		case EffSessionEnded:
			if n.out == "" {
				n.out = "fail:" + e.Code
			}
		}
	}
	if n.out == "" && n.s.disc.State == DLink {
		n.out = "link"
	}
	n.legacyProgress()
	return out
}

func (n *newCLI) legacyFrame(raw []byte) {
	if n.out != "" {
		return
	}
	m := obj(raw)
	kind, isKind := strField(m, "kind")
	switch {
	case isKind && kind == "commit":
		n.gotCommit, n.peerMode = true, commitMode(m)
	case isKind:
		n.out = "fail:protocol"
	default:
		n.out = "fail:peer-not-cli(server-predates-app-pairing)"
	}
}

func (n *newCLI) legacyProgress() {
	if n.out == "" && n.s.disc.State == DLegacy && n.sentCommit && n.gotCommit {
		if n.mode == n.peerMode {
			n.out = "legacy-ok"
		} else {
			n.out = "fail:mode-mismatch"
		}
	}
}

func (n *newCLI) peerKnown(now int, serverHints, peerHint bool) [][]byte {
	n.at(now)
	effs, _ := n.s.Room(n.s.Epoch(), RoomView{SelfID: n.self, PeerID: n.peer, ServerHints: serverHints, PeerHinted: peerHint})
	return n.apply(effs)
}

func (n *newCLI) recv(now int, raw []byte) [][]byte {
	n.at(now)
	effs, _ := n.s.Signal(n.s.Epoch(), n.peer, raw)
	return n.apply(effs)
}

func (n *newCLI) tick(now int) [][]byte {
	n.at(now)
	effs, _ := n.s.Tick()
	return n.apply(effs)
}
func (n *newCLI) outcome() string { return n.out }

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// ---- engine
type simDelivery struct {
	at   int
	to   int
	seq  int
	raw  []byte
	know bool
}

type simResult struct {
	a, b      string
	decidedAt int
}

func simulate(A, B actor, serverHints bool, latency, rosterExtraA, rosterExtraB, horizon int) simResult {
	actors := []actor{A, B}
	ids := []string{"id-A", "id-B"}
	for i, ac := range actors {
		if n, ok := ac.(*newCLI); ok {
			n.self, n.peer = ids[i], ids[1-i]
		}
	}
	var q []simDelivery
	seq := 0
	push := func(d simDelivery) { seq++; d.seq = seq; q = append(q, d) }
	push(simDelivery{at: latency + rosterExtraA, to: 0, know: true})
	push(simDelivery{at: latency + rosterExtraB, to: 1, know: true})
	send := func(now, from int, ms [][]byte) {
		for _, m := range ms {
			push(simDelivery{at: now + 2*latency, to: 1 - from, raw: m}) // client->server->client
		}
	}
	decided := -1
	for now := 0; now <= horizon; now += 10 {
		sort.SliceStable(q, func(i, j int) bool {
			if q[i].at != q[j].at {
				return q[i].at < q[j].at
			}
			return q[i].seq < q[j].seq
		})
		for len(q) > 0 && q[0].at <= now {
			d := q[0]
			q = q[1:]
			if d.know {
				peerHint := serverHints && actors[1-d.to].hints()
				send(now, d.to, actors[d.to].peerKnown(now, serverHints, peerHint))
			} else {
				send(now, d.to, actors[d.to].recv(now, d.raw))
			}
		}
		for i, a := range actors {
			send(now, i, a.tick(now))
		}
		if decided < 0 && A.outcome() != "" && B.outcome() != "" {
			decided = now
		}
	}
	return simResult{a: A.outcome(), b: B.outcome(), decidedAt: decided}
}

type mk func() actor

type matrixKey struct {
	hints bool
	a, b  string
}

func simPeers() map[string]mk {
	newc := func(c Cmd) mk { return func() actor { return newNew(c) } }
	old := func(mode string) mk { return func() actor { return &oldCLI{mode: mode} } }
	return map[string]mk{
		"NewCLI(pair)": newc(CmdPair), "NewCLI(send)": newc(CmdSend), "NewCLI(receive)": newc(CmdReceive), "NewCLI(text)": newc(CmdText),
		"oldCLI(file)": old("file"), "oldCLI(text)": old("text"),
		"Web": web, "Android": android, "Apple": apple, "AppleDoc": appleDoc, "AppleLinkOff": appleOff,
	}
}

// expectedMatrix is written independently of the tables (A08-DESIGN §3.4).
func expectedMatrix() map[matrixKey][2]string {
	exp := map[matrixKey][2]string{}
	news := []string{"NewCLI(pair)", "NewCLI(send)", "NewCLI(receive)", "NewCLI(text)"}
	for _, a := range news {
		for _, b := range news {
			exp[matrixKey{true, a, b}] = [2]string{"link", "link"}
		}
		for _, app := range []string{"Web", "Android", "Apple", "AppleDoc"} {
			exp[matrixKey{true, a, app}] = [2]string{"link", "link"}
			if a == "NewCLI(pair)" {
				exp[matrixKey{false, a, app}] = [2]string{"link", "link"}
			} else {
				exp[matrixKey{false, a, app}] = [2]string{"fail:peer-not-cli(server-predates-app-pairing)", "fail:cli-latched"}
			}
		}
		exp[matrixKey{true, a, "AppleLinkOff"}] = [2]string{"fail:peer-app-cannot-link", "fail:legacy-lane(no link hello in window)"}
	}
	for _, h := range []bool{true, false} {
		exp[matrixKey{h, "NewCLI(send)", "oldCLI(file)"}] = [2]string{"legacy-ok", "legacy-ok"}
		exp[matrixKey{h, "NewCLI(receive)", "oldCLI(file)"}] = [2]string{"legacy-ok", "legacy-ok"}
		exp[matrixKey{h, "NewCLI(text)", "oldCLI(text)"}] = [2]string{"legacy-ok", "legacy-ok"}
		exp[matrixKey{h, "NewCLI(send)", "oldCLI(text)"}] = [2]string{"fail:mode-mismatch", "fail:mode-mismatch"}
		exp[matrixKey{h, "NewCLI(text)", "oldCLI(file)"}] = [2]string{"fail:mode-mismatch", "fail:mode-mismatch"}
	}
	exp[matrixKey{true, "NewCLI(pair)", "oldCLI(file)"}] = [2]string{"fail:peer-is-older-cli", "fail:exit-quoting-kind"}
	exp[matrixKey{true, "NewCLI(pair)", "oldCLI(text)"}] = [2]string{"fail:peer-is-older-cli", "fail:exit-quoting-kind"}
	exp[matrixKey{false, "NewCLI(pair)", "oldCLI(file)"}] = [2]string{"fail:peer-used-legacy-after-our-hello", "fail:peer-not-cli(exit)"}
	exp[matrixKey{false, "NewCLI(pair)", "oldCLI(text)"}] = [2]string{"fail:peer-used-legacy-after-our-hello", "fail:peer-not-cli(exit)"}
	for _, a := range news[1:] {
		for _, b := range news[1:] {
			ma := map[string]string{"NewCLI(send)": "file", "NewCLI(receive)": "file", "NewCLI(text)": "text"}
			if ma[a] == ma[b] {
				exp[matrixKey{false, a, b}] = [2]string{"legacy-ok", "legacy-ok"}
			} else {
				exp[matrixKey{false, a, b}] = [2]string{"fail:mode-mismatch", "fail:mode-mismatch"}
			}
		}
		exp[matrixKey{false, "NewCLI(pair)", a}] = [2]string{"fail:peer-used-legacy-after-our-hello", "fail:peer-not-cli(server-predates-app-pairing)"}
		exp[matrixKey{false, a, "NewCLI(pair)"}] = [2]string{"fail:peer-not-cli(server-predates-app-pairing)", "fail:peer-used-legacy-after-our-hello"}
		exp[matrixKey{false, a, "AppleLinkOff"}] = [2]string{"fail:peer-not-cli(server-predates-app-pairing)", "fail:cli-latched"}
	}
	exp[matrixKey{false, "NewCLI(pair)", "NewCLI(pair)"}] = [2]string{"link", "link"}
	exp[matrixKey{false, "NewCLI(pair)", "AppleLinkOff"}] = [2]string{"fail:peer-app-cannot-link", "fail:legacy-lane(no link hello in window)"}
	return exp
}

// runMatrix returns every mismatch; build overrides how each NewCLI is made.
func runMatrix(t *testing.T, build func(name string) actor) (mismatches []string, runs, worst int) {
	exp := expectedMatrix()
	keys := make([]matrixKey, 0, len(exp))
	for k := range exp {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return fmt.Sprint(keys[i]) < fmt.Sprint(keys[j]) })
	for _, k := range keys {
		want := exp[k]
		for _, lat := range []int{5, 100, 400, 800} {
			for _, extra := range [][2]int{{0, 0}, {200, 0}, {0, 200}} {
				for _, swap := range []bool{false, true} {
					A, B := build(k.a), build(k.b)
					var r simResult
					if swap {
						r = simulate(B, A, k.hints, lat, extra[1], extra[0], 16000)
						r.a, r.b = r.b, r.a
					} else {
						r = simulate(A, B, k.hints, lat, extra[0], extra[1], 16000)
					}
					runs++
					if r.a != want[0] || r.b != want[1] {
						mismatches = append(mismatches, fmt.Sprintf("hints=%v %s <-> %s lat=%d extra=%v swap=%v: got (%q,%q) want (%q,%q)",
							k.hints, k.a, k.b, lat, extra, swap, r.a, r.b, want[0], want[1]))
						continue
					}
					if r.decidedAt < 0 || r.decidedAt > 7000 {
						mismatches = append(mismatches, fmt.Sprintf("hints=%v %s <-> %s lat=%d: decided at %d ms", k.hints, k.a, k.b, lat, r.decidedAt))
					}
					worst = max(worst, r.decidedAt)
				}
			}
		}
	}
	return
}

func TestPairingMatrix(t *testing.T) {
	peers := simPeers()
	mm, runs, worst := runMatrix(t, func(name string) actor { return peers[name]() })
	for _, m := range mm {
		t.Error(m)
	}
	t.Logf("pairing matrix (real Session, real JSON): %d combinations x 24 timing variants = %d runs; slowest decision %d ms; none reached the %v discovery deadline",
		runs/24, runs, worst, DiscoveryWait)
}

// The one timing MARGIN this design inherits (it never classifies by time):
// an Apple app decides "legacy" 5 s after roster gain; in the doc's model it
// first speaks at +1.5 s, so our reply must arrive within 3.5 s of that hello.
func TestAppleWindowMargin(t *testing.T) {
	for _, c := range []struct {
		lat  int
		want string
	}{{800, "link"}, {870, "link"}, {880, "fail:legacy-lane(no link hello in window)"}} {
		A, B := newNew(CmdSend), appleDoc()
		r := simulate(A, B, true, c.lat, 0, 0, 16000)
		if r.b != c.want {
			t.Errorf("server one-way %d ms (c2c RTT %d ms): Apple %q want %q", c.lat, 4*c.lat, r.b, c.want)
		}
		t.Logf("server one-way %d ms, client-to-client RTT %d ms: NewCLI=%q Apple=%q", c.lat, 4*c.lat, r.a, r.b)
	}
}

// Negative control for the simulator: a discovery table in which two new CLIs
// are both passive (the first design counterexample) must deadlock until the
// deadline. If this ever passes as "link", the matrix proves nothing.
func TestSimDetectsPassiveDeadlock(t *testing.T) {
	mut := defaultTables
	mut.disc = DiscoveryTable.clone("discovery-both-passive")
	for c := range mut.disc.Classes {
		k := [3]int{c, DJoining, DPeerHinted}
		r := mut.disc.rows[k]
		r.To, r.Do = DPassive, []string{AReplay}
		mut.disc.rows[k] = r
	}
	a, b := newNewWith(CmdPair, mut, 0), newNewWith(CmdSend, mut, 0)
	r := simulate(a, b, true, 100, 0, 0, 32000)
	if r.a != "fail:peer-never-spoke" || r.b != "fail:peer-never-spoke" || r.decidedAt < int(DiscoveryWait/time.Millisecond) {
		t.Fatalf("mutant not detected: %+v", r)
	}
	t.Logf("mutant (both passive) deadlocks until the %v deadline as expected: %+v", DiscoveryWait, r)
}

// Negative control for the rejected timing guess ("wait 1.5 s for an old
// CLI's commit, else send a hello"): with that mutant the matrix must go red
// on a slow old CLI, and the adopted design must stay green on the same run.
func TestSimDetectsGraceGuess(t *testing.T) {
	mut := mutate(defaultTables, "disc", DCLegacy, DPassive, DDeadline, DGreeting, OK, AAnnounce)
	slow := func(tb tables, wait time.Duration) simResult {
		// one-way 800 ms: the old CLI's commit reaches us 1.6 s after we
		// learned of it, just past the 1.5 s guess.
		return simulate(newNewWith(CmdSend, tb, wait), &oldCLI{mode: "file"}, true, 800, 0, 0, 16000)
	}
	good := slow(defaultTables, 0)
	if good.a != "legacy-ok" || good.b != "legacy-ok" {
		t.Fatalf("adopted design failed a slow old CLI: %+v", good)
	}
	bad := slow(mut, 1500*time.Millisecond)
	if bad.b != "fail:peer-not-cli(exit)" {
		t.Fatalf("grace-guess mutant not caught: %+v", bad)
	}
	t.Logf("adopted: %+v; 1.5 s grace mutant breaks the slow old CLI: %+v", good, bad)
}
