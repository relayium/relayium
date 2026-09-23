package main

// A11 relay-renew/1 end to end: two CLI ends in process, the REAL signalling
// hub with the REAL renewal grant registry wired exactly as server/main.go
// wires it (Join→Open, Leave→Depart, Renew→Request, deliver→hub.Relay as
// ice-grant), and the in-process patched TURN server with node-style REST auth
// checked on EVERY request and per-allocation byte counting (A09b's L2).
//
// The issuer's call count is the server-side issuance ledger; the TURN
// counters are the provider side. Every credential either issues carries the
// same attribution token, so every relayed byte is billed to the code owner.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/relayium/relayium/internal/signal"
)

const ldRenewToken = "owner1.tagA"

type ldRenewHub struct {
	*ldHub
	reg      *signal.GrantRegistry
	issued   atomic.Int32 // issuer runs: credential rounds asked of the account
	requests atomic.Int32 // ice-renew frames that reached the registry
	mu       sync.Mutex
	first    int64 // first /api/ice expiry (the segment anchor)
	latest   int64
}

// startLinkDevRenewHub: /api/ice issues a TURN credential for lt that expires
// initialTTL after the request; the registry renews with issue(n).
func startLinkDevRenewHub(t *testing.T, lt *ldTURN, initialTTL time.Duration, issue func(n int32) signal.RenewIssue) *ldRenewHub {
	t.Helper()
	h := &ldRenewHub{ldHub: &ldHub{joins: make(chan string, 16)}}
	hub := signal.NewHub()
	// Registry TTL twice the credential's: the half-TTL issuance floor then
	// opens at the first issuance, so an accelerated credential can renew
	// inside its own final margin exactly as a one-hour one does at minute 50.
	h.reg = signal.NewGrantRegistry(2*initialTTL, func() int64 { return time.Now().Unix() },
		func(ctx context.Context, owner, tag string) signal.RenewIssue {
			if owner != "owner1" || tag != "tagA" {
				t.Errorf("issuer asked for %s/%s", owner, tag)
			}
			return issue(h.issued.Add(1))
		},
		func(room, peer string, data json.RawMessage) {
			hub.Relay(room, signal.Envelope{Type: signal.TypeICEGrant, To: peer, Data: data})
		},
		func(tag string) (int64, int64) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.first, h.latest
		}, nil)
	var seq int32
	handle := signal.ServeWSHooked(hub, func() string { return fmt.Sprintf("peer%d", atomic.AddInt32(&seq, 1)) }, signal.WSHooks{
		Join: func(room, id string, peers int, members []string) {
			h.joins <- id
			if peers == 2 {
				h.reg.Open(room, "owner1", "tagA", members)
			}
		},
		Leave: func(room, id string) { h.reg.Depart(room, id) },
		Renew: func(room, id string, req signal.RenewRequest) {
			h.requests.Add(1)
			h.reg.Request(room, id, req)
		},
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "coderoom", 2, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	mux.HandleFunc("/api/ice", func(w http.ResponseWriter, r *http.Request) {
		exp := time.Now().Add(initialTTL)
		h.mu.Lock()
		if h.first == 0 {
			h.first = exp.Unix()
		}
		h.latest = max(h.latest, exp.Unix())
		h.iceCodes = append(h.iceCodes, r.URL.Query().Get("code"))
		h.mu.Unlock()
		h.reg.NoteIssued("tagA", exp.Unix())
		b, _ := json.Marshal(map[string]any{"iceServers": []any{map[string]any{"urls": "stun:" + lt.addr}, lt.cred(exp, ldRenewToken)}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	h.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	return h
}

// ldGrantFor is the account's granted answer: a fresh credential for lt,
// same attribution token.
func ldGrantFor(lt *ldTURN, ttl time.Duration) func(int32) signal.RenewIssue {
	return func(int32) signal.RenewIssue {
		exp := time.Now().Add(ttl)
		return signal.RenewIssue{Status: signal.RenewGranted, Expiry: exp.Unix(),
			Config: map[string]any{"iceServers": []any{map[string]any{"urls": "stun:" + lt.addr}, lt.cred(exp, ldRenewToken)}}}
	}
}

// ldPairUpWithin is ldPairUp with a caller-chosen ceiling.
func ldPairUpWithin(t *testing.T, hub *ldHub, first, second ldPeer, d time.Duration) (ldResult, ldResult) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	a := ldStart(ctx, t, "", first)
	select {
	case <-hub.joins:
	case <-ctx.Done():
		t.Fatal("first peer never joined")
	}
	b := ldStart(ctx, t, "", second)
	var ra, rb ldResult
	for i := 0; i < 2; i++ {
		select {
		case ra = <-a:
			a = nil
		case rb = <-b:
			b = nil
		case <-ctx.Done():
			t.Fatalf("pairing did not end within %s", d)
		}
	}
	t.Logf("first:\n%s\nsecond:\n%s", ra, rb)
	return ra, rb
}

type ldAllocSample struct {
	at     time.Time
	live   int
	counts []int64
}

// sampleAllocations records the provider side every 100 ms; the returned
// stop ends sampling and returns the samples (after the sampler exited).
func sampleAllocations(lt *ldTURN) (stop func() []ldAllocSample) {
	var out []ldAllocSample
	quit, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(100 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-quit:
				return
			case <-tk.C:
				out = append(out, ldAllocSample{time.Now(), lt.srv.AllocationCount(), lt.counters()})
			}
		}
	}()
	return func() []ldAllocSample {
		close(quit)
		<-done
		return out
	}
}

// Relayed CLI↔CLI crossing ONE renewal, reconciled against the provider.
//
// A 100 s credential puts the deadline at +40 s and the renewal window at
// about +27 s. Both ends exchange a message (user activity), wait for their
// own commit, then wait PAST the old deadline and move a file each way over
// the renewed allocation. Asserted:
//
//   - one credential round issued, one ice-renew per end; both ends committed
//     round 1 and printed the renewed deadline; both exit 0 with exact trees;
//   - four allocations in total, two per credential; the old two stopped
//     counting and were gone before the old deadline, and no allocation ever
//     outlived its credential (no refresh was refused);
//   - every allocation authenticated under the code owner's token (the
//     ledger attribution), and the relay's byte counters reconcile with the
//     payload both ends report: each end's allocations carry that end's
//     payload in both directions plus framing, across the renewal.
func TestLinkRenewRelayedAcrossOneRenewal(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevRenewHub(t, lt, 100*time.Second, ldGrantFor(lt, 300*time.Second))
	srcA := ldTree(t, "renewA", map[string]int{"a.bin": 3 << 20})
	srcB := ldTree(t, "renewB", map[string]int{"b.bin": 3 << 20})
	destA, destB := t.TempDir(), t.TempDir()
	script := func(src, msg1, msg2 string) string {
		return ldScript(t, "text "+msg1, "wait-texts 1", "wait-renewed 1", "sleep 16s", "send "+src, "text "+msg2, "wait-texts 2", "wait-files 1", "wait-sent")
	}
	stopSampling := sampleAllocations(lt)
	start := time.Now()
	ra, rb := ldPairUpWithin(t, hub.ldHub,
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", destA, "--script", script(srcA, "a-before", "a-after"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", destB, "--script", script(srcB, "b-before", "b-after"), ldCode}},
		4*time.Minute)
	samples := stopSampling()
	oldDeadline := start.Add(40 * time.Second)

	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 || !strings.Contains(r.stderr, "batches sent=1 received=1 texts received=2") {
			t.Errorf("want a complete session across the renewal\n%s", r)
		}
		if !strings.Contains(r.stderr, "relay renewal committed round 1") || !strings.Contains(r.stderr, "relay renewed: this link may now run until") {
			t.Errorf("no committed renewal\n%s", r)
		}
		if strings.Contains(r.stderr, "relay-credential-ended") || strings.Contains(r.stderr, "relay-renewal-failed") {
			t.Errorf("the link ended at the old deadline or failed its renewal\n%s", r)
		}
		if ps := ldPaths(r); len(ps) == 0 || ps[0] != "relay" {
			t.Errorf("paths %v\n%s", ps, r)
		}
	}
	ldSameTree(t, srcA, destB)
	ldSameTree(t, srcB, destA)
	if n := hub.issued.Load(); n != 1 {
		t.Errorf("issuer ran %d times for one renewal", n)
	}
	if n := hub.requests.Load(); n != 2 {
		t.Errorf("%d ice-renew requests reached the server, want one per end", n)
	}
	// The old deadline is /api/ice time + 40 s (start precedes it): a session
	// that ended before that did not cross it.
	if time.Since(start) < 41*time.Second {
		t.Errorf("the session ended at %s, before it crossed the old deadline", time.Since(start))
	}
	lt.waitAllocations(t, 0, 10*time.Second)

	// ---- the provider side
	counts := lt.counters()
	if len(counts) != 4 {
		t.Fatalf("allocations %v, want exactly two per credential round", counts)
	}
	lookups, denied := lt.auths()
	for u := range lookups {
		if !strings.HasSuffix(u, ":"+ldRenewToken) {
			t.Errorf("an allocation authenticated as %q: not billed to the code owner", u)
		}
	}
	if len(lookups) != 2 {
		t.Errorf("usernames %v: want the original and the renewed credential", lookups)
	}
	for u, n := range denied {
		t.Errorf("the relay refused %q %d time(s): an allocation outlived its credential", u, n)
	}
	// The old allocations (created first) stopped moving bytes and were gone
	// before the old deadline; the renewed ones carried the post-renewal files.
	var atOld *ldAllocSample
	for i := range samples {
		s := &samples[i]
		if s.at.After(oldDeadline) {
			atOld = s
			break
		}
	}
	if atOld == nil {
		t.Fatal("no provider sample after the old deadline")
	}
	if atOld.live > 2 {
		t.Errorf("%d allocations live at the old deadline: the old ones did not exit", atOld.live)
	}
	for i := 0; i < 2 && i < len(atOld.counts); i++ {
		if atOld.counts[i] != counts[i] {
			t.Errorf("old allocation %d moved %d more bytes after the old deadline", i, counts[i]-atOld.counts[i])
		}
	}
	as, _ := ldMoved(t, ra)
	bs, _ := ldMoved(t, rb)
	payload := as + bs
	var total int64
	for i, n := range counts {
		total += n
		t.Logf("allocation %d relayed %d bytes", i, n)
	}
	// Each end's allocations (old + new) relay all of the payload once in
	// each direction; the two ends' sets together carry it twice.
	if total < 2*payload || total > 2*(payload+payload/5+512<<10) {
		t.Errorf("relayed %d bytes in total for %d payload bytes (want 2x payload plus framing <= 20%% + 512 KiB per end)", total, payload)
	}
	if counts[2] < 2*(3<<20) || counts[3] < 2*(3<<20) {
		t.Errorf("renewed allocations %d/%d did not carry the post-renewal files (%d each way)", counts[2], counts[3], 3<<20)
	}
	t.Logf("payload %d, provider total %d (x%.4f of 2x payload); old allocations %d/%d, renewed %d/%d",
		payload, total, float64(total)/float64(2*payload), counts[0], counts[1], counts[2], counts[3])
}

// Both ends script a 75 s session: a link that was (wrongly) renewed would
// finish it normally and fail the assertions below by name, rather than hang.
//
// A peer without relay-renew/1 (a build that predates it; stood in for by
// --no-renew) never gets an epoch: nothing is asked of the server, nothing is
// issued, both ends run to the ORIGINAL deadline and end truthfully.
func TestLinkRenewNonRenewingPeerExpiresHonestly(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevRenewHub(t, lt, 100*time.Second, ldGrantFor(lt, 300*time.Second))
	start := time.Now()
	ra, rb := ldPairUpWithin(t, hub.ldHub,
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text a", "wait-texts 1", "sleep 75s"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--no-renew", "--script", ldScript(t, "text b", "wait-texts 1", "sleep 75s"), ldCode}},
		2*time.Minute)
	ended := time.Since(start)
	for _, r := range []ldResult{ra, rb} {
		if !strings.Contains(r.stderr, "report link relay-credential-ended") {
			t.Errorf("want the truthful end at the original deadline\n%s", r)
		}
		if strings.Contains(r.stderr, "relay renewed") {
			t.Errorf("claimed a renewal\n%s", r)
		}
	}
	if hub.requests.Load() != 0 || hub.issued.Load() != 0 {
		t.Errorf("requests %d issued %d for a non-renewing peer", hub.requests.Load(), hub.issued.Load())
	}
	if ended < 38*time.Second || ended > 55*time.Second {
		t.Errorf("ended after %s; the original deadline is +40 s", ended)
	}
	if n := lt.created(); n != 2 {
		t.Errorf("%d allocations, want the original two only", n)
	}
	lt.waitAllocations(t, 0, 10*time.Second)
}

// Quota exhausted mid-link: the account's allowance is spent when the
// renewal is asked for. One issuer run, no retry loop, no restart, and the
// link runs out its ORIGINAL deadline and ends truthfully.
func TestLinkRenewQuotaDeniedRunsOutOriginalDeadline(t *testing.T) {
	lt := startLinkDevTURN(t)
	hub := startLinkDevRenewHub(t, lt, 100*time.Second, func(int32) signal.RenewIssue {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "quota", RelayDenied: "quota"}
	})
	start := time.Now()
	ra, rb := ldPairUpWithin(t, hub.ldHub,
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text a", "wait-texts 1", "sleep 75s"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text b", "wait-texts 1", "sleep 75s"), ldCode}},
		2*time.Minute)
	ended := time.Since(start)
	for _, r := range []ldResult{ra, rb} {
		if !strings.Contains(r.stderr, "report link relay-credential-ended") || strings.Contains(r.stderr, "relay renewed") {
			t.Errorf("want the truthful original-deadline end and no renewal claim\n%s", r)
		}
		if !strings.Contains(r.stderr, "relay renewal: denied") {
			t.Errorf("the denial was not recorded\n%s", r)
		}
		if strings.Contains(r.stderr, "relay-renewal-failed") {
			t.Errorf("a pre-restart denial must not end the link early\n%s", r)
		}
	}
	if n := hub.issued.Load(); n != 1 {
		t.Errorf("issuer ran %d times after a quota denial, want once", n)
	}
	if n := hub.requests.Load(); n != 2 {
		t.Errorf("%d ice-renew requests, want one per end", n)
	}
	if ended < 38*time.Second || ended > 55*time.Second {
		t.Errorf("ended after %s; the original deadline is +40 s", ended)
	}
	if n := lt.created(); n != 2 {
		t.Errorf("%d allocations after a denial", n)
	}
}

// Option A: the renewal is granted, both ends restart onto it, and the new
// allocation can never carry the path (the relay refuses the renewed
// credential). Pion already retired the old path, so each end ends the link
// with the truthful renewal-failed line — never a silent stall, never past the
// original deadline, and the deadline was never moved.
func TestLinkRenewFailureAfterSwitchEndsLinkTruthfully(t *testing.T) {
	lt := startLinkDevTURN(t)
	// The renewed credential is well-formed and stamped for a future expiry,
	// but carries a password the relay does not accept.
	bad := func(int32) signal.RenewIssue {
		exp := time.Now().Add(300 * time.Second)
		c := lt.cred(exp, ldRenewToken)
		c["credential"] = "not-the-hmac"
		return signal.RenewIssue{Status: signal.RenewGranted, Expiry: exp.Unix(),
			Config: map[string]any{"iceServers": []any{c}}}
	}
	hub := startLinkDevRenewHub(t, lt, 200*time.Second, bad)
	start := time.Now()
	ra, rb := ldPairUpWithin(t, hub.ldHub,
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text a", "wait-texts 1", "hold"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text b", "wait-texts 1", "hold"), ldCode}},
		4*time.Minute)
	ended := time.Since(start)
	originalDeadline := 140 * time.Second
	for _, r := range []ldResult{ra, rb} {
		if strings.Contains(r.stderr, "relay renewed") {
			t.Errorf("claimed a renewal that never carried the path\n%s", r)
		}
		if !strings.Contains(r.stderr, "the relay renewal did not complete after the relay path was switched") &&
			!strings.Contains(r.stderr, "report link peer-ended-session") {
			t.Errorf("want the truthful renewal-failed end (or the peer's authenticated end of it)\n%s", r)
		}
	}
	if !strings.Contains(ra.stderr+rb.stderr, "the relay renewal did not complete") {
		t.Errorf("neither end reported the failed renewal")
	}
	// Ended by the failed renewal itself, not by the original deadline
	// arriving later (which a silent stall would have waited for).
	if ended > originalDeadline-5*time.Second {
		t.Errorf("ended after %s; the failed renewal must end the link before the original deadline %s", ended, originalDeadline)
	}
	if n := hub.issued.Load(); n != 1 {
		t.Errorf("issuer ran %d times", n)
	}
	_, denied := lt.auths()
	if len(denied) != 0 {
		t.Logf("refused outright: %v", denied)
	}
	lt.waitAllocations(t, 0, 10*time.Second)
}

// Option A, with the transport HEALTHY: the renewed allocation carries ICE,
// but every probe and ack is lost, so neither end can prove the migration.
// Both have already restarted onto the new credential, so both end the link
// themselves at the end of the epoch — with the truthful line and an
// authenticated leave — rather than letting a link whose renewal failed run on
// to the original deadline. No deadline moved; one round was issued.
func TestLinkRenewLostProofEndsLinkTruthfully(t *testing.T) {
	lt := startLinkDevTURN(t)
	var dropped atomic.Int32
	ldHookRenewFrame = func(*linkDevDriver, []byte) bool { dropped.Add(1); return true }
	t.Cleanup(func() { ldHookRenewFrame = nil })
	hub := startLinkDevRenewHub(t, lt, 200*time.Second, ldGrantFor(lt, 300*time.Second))
	start := time.Now()
	ra, rb := ldPairUpWithin(t, hub.ldHub,
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text a", "wait-texts 1", "hold"), ldCode}},
		ldPeer{cmd: "pair", via: hub.url, args: []string{"--script", ldScript(t, "text b", "wait-texts 1", "hold"), ldCode}},
		4*time.Minute)
	ended := time.Since(start)
	for _, r := range []ldResult{ra, rb} {
		if strings.Contains(r.stderr, "relay renewed") {
			t.Errorf("claimed a renewal without proof\n%s", r)
		}
		if strings.Contains(r.stderr, "report link relay-credential-ended") {
			t.Errorf("the failed renewal did not end the link; the original deadline did\n%s", r)
		}
		if r.code == 0 {
			t.Errorf("a failed renewal exited 0\n%s", r)
		}
	}
	if !strings.Contains(ra.stderr+rb.stderr, "the relay renewal did not complete after the relay path was switched") {
		t.Errorf("neither end reported the failed renewal")
	}
	if dropped.Load() == 0 {
		t.Fatal("no control frame was ever sent: the test proves nothing")
	}
	if ended > 135*time.Second {
		t.Errorf("ended after %s; the failed renewal must end the link before the original deadline (140 s)", ended)
	}
	if n := hub.issued.Load(); n != 1 {
		t.Errorf("issuer ran %d times", n)
	}
	if n := lt.created(); n != 4 {
		t.Errorf("%d allocations, want the original two and the renewed two", n)
	}
	lt.waitAllocations(t, 0, 10*time.Second)
}
