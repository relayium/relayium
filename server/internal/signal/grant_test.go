package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

// grantHarness drives a GrantRegistry with a controllable clock, a recording
// issuer and a recording delivery, so every rule can be asserted without a
// socket or a database.
type grantHarness struct {
	t    *testing.T
	reg  *GrantRegistry
	now  int64
	mu   sync.Mutex
	sent []sentReply
	// issues counts ISSUER invocations — the thing a cached replay must not do.
	issues int
	// answer is what the issuer returns; block holds it until released.
	answer RenewIssue
	block  chan struct{}
	// sawCtx records the context the issuer was given, for the cancellation case.
	sawCtx chan context.Context
	// inherited is the continuous credential segment /api/ice is pretending to
	// have issued already, keyed by tag; retained records what the registry
	// asked to be kept for billing.
	inherited map[string]segment
	retained  []retention
}

type sentReply struct {
	room string
	peer string
	body map[string]any
}

func newGrantHarness(t *testing.T) *grantHarness {
	t.Helper()
	h := &grantHarness{t: t, now: 10_000, sawCtx: make(chan context.Context, 8), inherited: map[string]segment{}}
	h.answer = RenewIssue{Status: RenewGranted, Config: map[string]any{"iceServers": []any{}}, Expiry: 0}
	h.reg = NewGrantRegistry(time.Hour, func() int64 { return h.now },
		func(ctx context.Context, owner, tag string) RenewIssue {
			h.mu.Lock()
			h.issues++
			block := h.block
			answer := h.answer
			h.mu.Unlock()
			select {
			case h.sawCtx <- ctx:
			default:
			}
			if block != nil {
				<-block
			}
			if answer.Status == RenewGranted && answer.Expiry == 0 {
				answer.Expiry = h.tick() + 3600
			}
			return answer
		},
		func(room, peer string, data json.RawMessage) {
			var body map[string]any
			if err := json.Unmarshal(data, &body); err != nil {
				t.Errorf("reply is not JSON: %v", err)
				return
			}
			h.mu.Lock()
			h.sent = append(h.sent, sentReply{room, peer, body})
			h.mu.Unlock()
		},
		func(tag string) (int64, int64) {
			h.mu.Lock()
			defer h.mu.Unlock()
			seg := h.inherited[tag]
			return seg.first, seg.latest
		},
		func(tag string, expiry int64) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.retained = append(h.retained, retention{tag, expiry})
		})
	return h
}

type retention struct {
	tag    string
	expiry int64
}

// segment is a continuous run of issuance for one generation: the expiry of
// its first credential and of its latest. The two differ whenever the peers
// fetched at different times, which pre-upload makes ordinary.
type segment struct {
	first  int64
	latest int64
}

// inherit stages a single-fetch segment: both peers' credentials expire
// together, which is the simple case.
func (h *grantHarness) inherit(tag string, expiry int64) {
	h.inheritSegment(tag, expiry, expiry)
}

// inheritSegment stages a segment whose peers fetched at DIFFERENT times —
// first expiring at `first`, latest at `latest`. This is the pre-upload shape
// the rate anchor has to get right.
func (h *grantHarness) inheritSegment(tag string, first, latest int64) {
	h.mu.Lock()
	h.inherited[tag] = segment{first: first, latest: latest}
	h.mu.Unlock()
}

func (h *grantHarness) retentions() []retention {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]retention, len(h.retained))
	copy(out, h.retained)
	return out
}

func (h *grantHarness) tick() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.now
}

func (h *grantHarness) advance(d int64) {
	h.mu.Lock()
	h.now += d
	h.mu.Unlock()
}

func (h *grantHarness) replies() []sentReply {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]sentReply, len(h.sent))
	copy(out, h.sent)
	return out
}

func (h *grantHarness) issueCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.issues
}

func (h *grantHarness) reset() {
	h.mu.Lock()
	h.sent = nil
	h.mu.Unlock()
}

// open creates a grant at the instant a real one would first renew: its
// original /api/ice credential was issued 50 minutes ago and expires in 10, so
// it is past the half-TTL issuance floor and not yet lapsed.
//
// The staged expiry is what the pairing registry would report, and the grant
// recovers the ISSUANCE instant from it. A grant opened with a credential
// issued "just now" is legitimately rate-floored, which is why this is not the
// obvious `now+3600`.
func (h *grantHarness) open(room string) {
	h.inherit("gtag1", h.tick()+600)
	h.reg.Open(room, "owner-1", "gtag1", []string{"peer-a", "peer-b"})
}

// bothAsk drives one complete round and waits for the issuance goroutine.
func (h *grantHarness) bothAsk(room string, round uint32, ridA, ridB uint32) {
	h.t.Helper()
	h.reg.Request(room, "peer-a", RenewRequest{Round: round, RID: ridA})
	h.reg.Request(room, "peer-b", RenewRequest{Round: round, RID: ridB})
	h.settle(2)
}

// settle waits for the asynchronous issuance to publish `want` replies.
func (h *grantHarness) settle(want int) {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(h.replies()) >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %d replies, got %d", want, len(h.replies()))
}

func statusOf(t *testing.T, r sentReply) string {
	t.Helper()
	s, _ := r.body["status"].(string)
	return s
}

// ---------------------------------------------------------------------------
// Authority

func TestGrantIssuesOnlyWhenBothFrozenMembersAsk(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	// One party is never enough, and gets no reply at all: silence is what an
	// old server does, so clients already treat it as unavailable.
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 7})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		t.Fatalf("issuer ran %d times for a one-sided request", n)
	}
	if got := h.replies(); len(got) != 0 {
		t.Fatalf("one-sided request drew %d replies", len(got))
	}

	// The second frozen member completes the round. ONE issuance, delivered to
	// both, each with its own rid.
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 9})
	h.settle(2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("issuer ran %d times for one round", n)
	}
	rids := map[string]uint32{}
	for _, r := range h.replies() {
		if got := statusOf(t, r); got != RenewGranted {
			t.Fatalf("status %q, want granted", got)
		}
		if round, _ := r.body["round"].(float64); uint32(round) != 1 {
			t.Fatalf("round %v, want 1", r.body["round"])
		}
		rid, _ := r.body["rid"].(float64)
		rids[r.peer] = uint32(rid)
	}
	if rids["peer-a"] != 7 || rids["peer-b"] != 9 {
		t.Fatalf("rids not echoed per requester: %v", rids)
	}
}

func TestGrantRefusesStrangersAndUnknownRooms(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	for _, c := range []struct{ room, peer string }{
		{"room-1", "peer-c"}, // in the room, but not a frozen member
		{"room-2", "peer-a"}, // right member id, wrong room
		{"", "peer-a"},       // no room at all
		{"room-1", ""},       // no member id
	} {
		h.reg.Request(c.room, c.peer, RenewRequest{Round: 1, RID: 1})
	}
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		t.Fatalf("issuer ran %d times without two frozen members", n)
	}
	if got := h.replies(); len(got) != 0 {
		t.Fatalf("unauthorised requests drew %d replies", len(got))
	}
}

// A replacement that takes the slot a departure freed inherits nothing. The
// grant is already dead by then, and a second Open cannot revive or re-point it.
func TestDepartureKillsTheGrantAndAReplacementCannotRevriveIt(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	h.reg.Depart("room-1", "peer-a")
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("grant survived a frozen member's departure: %d held", n)
	}
	h.bothAskExpectingNothing("room-1")

	// The room refills with a new peer. Opening again must not resurrect the
	// old authority: the generation's pair has already been and gone.
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-b", "peer-c"})
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		t.Fatalf("a departed member still completed a round (%d issuances)", n)
	}
}

func (h *grantHarness) bothAskExpectingNothing(room string) {
	h.t.Helper()
	h.reg.Request(room, "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request(room, "peer-b", RenewRequest{Round: 1, RID: 2})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		h.t.Fatalf("issuer ran %d times for a dead grant", n)
	}
}

// A second Open for a room that already has a grant is ignored, so a later
// re-observation cannot re-point authority at different ids.
func TestSecondOpenNeverRepointsAuthority(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.reg.Open("room-1", "owner-2", "gtag2", []string{"peer-x", "peer-y"})

	h.reg.Request("room-1", "peer-x", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-y", RenewRequest{Round: 1, RID: 2})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		t.Fatalf("a second Open re-pointed authority (%d issuances)", n)
	}
	h.bothAsk("room-1", 1, 3, 4)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the original members lost their authority (%d issuances)", n)
	}
}

func TestOpenRejectsMalformedMembership(t *testing.T) {
	h := newGrantHarness(t)
	for _, members := range [][]string{nil, {"only-one"}, {"a", "b", "c"}} {
		h.reg.Open("room-bad", "owner-1", "gtag1", members)
	}
	h.reg.Open("room-bad", "", "gtag1", []string{"a", "b"})
	h.reg.Open("room-bad", "owner-1", "", []string{"a", "b"})
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("malformed Open created %d grants", n)
	}
}

// ---------------------------------------------------------------------------
// Lifetime

// UNISSUED is not LAPSED. A grant whose peers paired before either fetched ICE
// cannot renew — zero is not permission — but it must survive to receive the
// initial issuance that is about to arrive. Killing it here strands the room
// with no grant at all, which is what the independent oracle reproduced.
func TestUnissuedGrantIsUnavailableAndSurvivesForItsInitialIssuance(t *testing.T) {
	h := newGrantHarness(t)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 5})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewUnavailable {
		t.Fatalf("status %q, want unavailable", s)
	}
	if n := h.issueCount(); n != 0 {
		t.Fatal("issuer ran for a grant that has never been issued anything")
	}
	if n := h.reg.Len(); n != 1 {
		t.Fatalf("an unissued grant was destroyed by a request: %d held", n)
	}

	// The real /api/ice lands. The grant now has authority, anchored to THIS
	// issuance rather than to anything older.
	h.reset()
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.advance(1800)
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("a fresh initial issuance did not restore authority: %+v", r.body)
		}
	}
}

func TestLapsedGrantIsRefusedAndNeverRevived(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	// Past the last credential's expiry there is nothing left to continue.
	h.advance(3601)
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 3})
	h.settle(1)
	if s := statusOf(t, h.replies()[0]); s != RenewDenied {
		t.Fatalf("status %q, want denied", s)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("lapsed grant retained: %d", n)
	}
	// A late initial-issuance report must not bring it back.
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.reset()
	h.bothAskExpectingNothing("room-1")
}

func TestSweepRetiresLapsedGrants(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.reg.Open("room-2", "owner-2", "gtag2", []string{"peer-c", "peer-d"})
	h.reg.NoteIssued("gtag2", h.tick()+7200)

	h.advance(3601)
	h.reg.Sweep()
	if n := h.reg.Len(); n != 1 {
		t.Fatalf("sweep left %d grants, want the one still in credential", n)
	}
	h.advance(3600)
	h.reg.Sweep()
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("sweep left %d grants", n)
	}
}

func TestNoteIssuedMovesForwardOnlyAndIgnoresUnknownTags(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1") // credential expires at now+600
	h.reg.NoteIssued("gtag1", h.tick()+100)
	h.reg.NoteIssued("unknown-tag", h.tick()+99999)

	h.advance(599)
	h.reg.Sweep()
	if n := h.reg.Len(); n != 1 {
		t.Fatal("a stale issuance pulled the grant's life in")
	}
	// The unknown tag created nothing, and a later /api/ice for the LIVE grant
	// does extend it.
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.advance(601)
	h.reg.Sweep()
	if n := h.reg.Len(); n != 1 {
		t.Fatal("a genuine later issuance failed to extend a live grant")
	}
}

// S5: a fresh /api/ice for a generation whose credentials have ALL expired is a
// new credential, not evidence that the old authority continued. It must not
// resurrect the grant.
func TestNoteIssuedCannotResurrectALapsedGrant(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.advance(601) // past the staged expiry; not swept yet

	h.reg.NoteIssued("gtag1", h.tick()+3600)
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("a late issuance revived a lapsed grant: %d held", n)
	}
	h.bothAskExpectingNothing("room-1")
}

// ---------------------------------------------------------------------------
// Rounds, caching and rate

func TestDuplicateCurrentRoundReplaysTheCacheWithoutReissuing(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.bothAsk("room-1", 1, 1, 2)
	h.reset()

	// A lost reply: the client asks again for the round it already has.
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 42})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewGranted {
		t.Fatalf("replay status %q, want granted", s)
	}
	if rid, _ := got.body["rid"].(float64); uint32(rid) != 42 {
		t.Fatalf("replay echoed rid %v, want the new one", got.body["rid"])
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("a duplicate reissued: %d issuances", n)
	}
}

// A stale reply names the server's CURRENT round, per relay-renew-v1.md §2.2,
// so a client can re-ask for it and retrieve the cached result. The round it
// may newly OPEN is that plus one, which the client derives.
func TestWrongRoundIsToldTheCurrentOne(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	// Nothing issued yet: the current round is 0.
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 9, RID: 2})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewStale {
		t.Fatalf("status %q, want stale", s)
	}
	if round, _ := got.body["round"].(float64); uint32(round) != 0 {
		t.Fatalf("stale reply named round %v, want the current 0", got.body["round"])
	}
	if n := h.issueCount(); n != 0 {
		t.Fatalf("a stale round issued: %d", n)
	}

	// After round 1 lands, a client that overshoots is pointed back at 1 — the
	// round whose cached result it can still retrieve.
	h.bothAsk("room-1", 1, 3, 4)
	h.reset()
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 7, RID: 5})
	h.settle(1)
	if round, _ := h.replies()[0].body["round"].(float64); uint32(round) != 1 {
		t.Fatalf("stale reply named round %v, want the current 1", h.replies()[0].body["round"])
	}
}

func TestNewIssuanceIsFlooredAtHalfACredentialTTL(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.bothAsk("room-1", 1, 1, 2)
	h.reset()

	// Too soon for another round.
	h.advance(1799)
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 2, RID: 3})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 2, RID: 4})
	h.settle(2)
	for _, r := range h.replies() {
		// UNAVAILABLE, not denied: too early is a "not yet", and a client that
		// read it as terminal would abandon a renewal it may make minutes later.
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("status %q, want unavailable", s)
		}
		if reason, _ := r.body["reason"].(string); reason != renewReasonRate {
			t.Fatalf("reason %q, want %q", reason, renewReasonRate)
		}
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the rate floor did not hold: %d issuances", n)
	}
	// Retrieving the cached CURRENT round is exempt from the floor.
	h.reset()
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 5})
	h.settle(1)
	if s := statusOf(t, h.replies()[0]); s != RenewGranted {
		t.Fatal("the rate floor blocked a cached replay")
	}

	// Half a TTL later the next round is admissible.
	h.reset()
	h.advance(2)
	h.bothAsk("room-1", 2, 6, 7)
	if n := h.issueCount(); n != 2 {
		t.Fatalf("second round did not issue: %d", n)
	}
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("status %q, want granted", s)
		}
	}
}

// The FIRST renewal obeys the same floor as every later one, measured from the
// ORIGINAL /api/ice issuance rather than from grant creation. A grant created
// moments after its credentials were issued may not immediately renew; one
// created long afterwards may, because the floor tracks the issuance and not
// the bookkeeping.
func TestFirstRenewalIsFlooredFromTheOriginalIssuance(t *testing.T) {
	h := newGrantHarness(t)
	// Original credential issued right now (expires in a full hour).
	h.inherit("gtag1", h.tick()+3600)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("status %q, want unavailable", s)
		}
		if reason, _ := r.body["reason"].(string); reason != renewReasonRate {
			t.Fatalf("reason %q, want %q", reason, renewReasonRate)
		}
	}
	if n := h.issueCount(); n != 0 {
		t.Fatalf("the first renewal ignored the floor: %d issuances", n)
	}

	// Half a TTL after that issuance, it is admissible.
	h.reset()
	h.advance(1800)
	h.bothAsk("room-1", 1, 3, 4)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the first renewal was still refused past the floor: %d", n)
	}
	// And it is billed for retention only once it is ACCEPTED.
	if got := h.retentions(); len(got) != 1 || got[0].tag != "gtag1" {
		t.Fatalf("accepted round did not record retention: %+v", got)
	}
}

// S2: the issuer stamps an expiry before anything decides to publish, so it
// must not be what keeps the authority alive. A grant that lapses while the
// issuer is running is retired and its result discarded, however good it was.
func TestGrantLapsingDuringIssuanceDiscardsTheResult(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1") // expires at now+600
	h.mu.Lock()
	h.block = make(chan struct{})
	h.mu.Unlock()

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	select {
	case <-h.sawCtx:
	case <-time.After(time.Second):
		t.Fatal("issuer never started")
	}
	// The original credential expires while the database read is in flight.
	h.advance(601)
	h.mu.Lock()
	close(h.block)
	h.block = nil
	h.mu.Unlock()

	time.Sleep(50 * time.Millisecond)
	if got := h.replies(); len(got) != 0 {
		t.Fatalf("a lapsed grant was published credentials: %+v", got)
	}
	if got := h.retentions(); len(got) != 0 {
		t.Fatalf("a discarded issuance recorded retention: %+v", got)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("lapsed grant retained: %d", n)
	}
}

func TestDeniedAndUnavailableDoNotAdvanceIssuance(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	for _, answer := range []RenewIssue{
		{Status: RenewDenied, Reason: renewReasonQuota, RelayDenied: "quota"},
		{Status: RenewUnavailable, Reason: renewReasonBusy},
	} {
		h.mu.Lock()
		h.answer = answer
		h.mu.Unlock()
		h.reset()
		// Past the issuer cooldown each time. A refusal costs no round and no
		// issuance floor, but it DOES spend the grant's database budget, so the
		// next attempt has to wait — which is the whole point of the cooldown
		// and is asserted directly in the cooldown tests below.
		h.advance(grantIssuerCooldown + 1)
		h.bothAsk("room-1", 1, 1, 2) // STILL round 1: nothing advanced
		for _, r := range h.replies() {
			if s := statusOf(t, r); s != answer.Status {
				t.Fatalf("status %q, want %q", s, answer.Status)
			}
			// The reply names the round it refused; what must NOT have moved
			// is the server's issuance, which the next case proves by opening
			// round 1 again and succeeding.
			if round, _ := r.body["round"].(float64); uint32(round) != 1 {
				t.Fatalf("a refusal named round %v, want the refused 1", r.body["round"])
			}
			if _, carries := r.body["iceServers"]; carries {
				t.Fatal("a refusal carried credentials")
			}
		}
	}
	// A quota denial reports the field /api/ice uses, so the client needs no
	// second vocabulary.
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewDenied, Reason: renewReasonQuota, RelayDenied: "quota"}
	h.mu.Unlock()
	h.reset()
	h.advance(grantIssuerCooldown + 1)
	h.bothAsk("room-1", 1, 1, 2)
	if d, _ := h.replies()[0].body["relayDenied"].(string); d != "quota" {
		t.Fatalf("relayDenied %q, want quota", d)
	}

	// Issuance never advanced through any of those refusals: round 1 is still
	// the round to open, and it still works once the issuer says yes.
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewGranted, Config: map[string]any{"iceServers": []any{}}}
	h.mu.Unlock()
	h.reset()
	h.advance(grantIssuerCooldown + 1)
	h.bothAsk("room-1", 1, 7, 8)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("round 1 was consumed by a refusal: %+v", r.body)
		}
	}
}

func TestOneInflightIssuancePerGrant(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.block = make(chan struct{})
	h.mu.Unlock()

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	// Wait for the issuance goroutine to actually be inside the issuer before
	// flooding; the point is concurrency, not scheduling luck.
	select {
	case <-h.sawCtx:
	case <-time.After(time.Second):
		t.Fatal("issuer never started")
	}
	// While that one is stuck in the issuer, a flood must not start more.
	for i := 0; i < 50; i++ {
		h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: uint32(100 + i)})
		h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: uint32(200 + i)})
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("%d concurrent issuances", n)
	}
	h.mu.Lock()
	close(h.block)
	h.block = nil
	h.mu.Unlock()
	h.settle(2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the flood produced %d issuances", n)
	}
}

// A result computed for a grant that has since died is discarded, not
// published: the credentials would otherwise go to a link the server no longer
// believes in.
func TestLateResultForADeadGrantIsDiscarded(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.block = make(chan struct{})
	h.mu.Unlock()

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	// The issuance is in flight; a member leaves.
	h.reg.Depart("room-1", "peer-b")
	// The issuer's context must have been cancelled by that departure.
	select {
	case ctx := <-h.sawCtx:
		deadline := time.Now().Add(time.Second)
		for ctx.Err() == nil && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if ctx.Err() == nil {
			t.Fatal("departure did not cancel the in-flight issuance context")
		}
	case <-time.After(time.Second):
		t.Fatal("issuer never ran")
	}
	h.mu.Lock()
	close(h.block)
	h.block = nil
	h.mu.Unlock()

	time.Sleep(50 * time.Millisecond)
	if got := h.replies(); len(got) != 0 {
		t.Fatalf("a dead grant received %d replies: %+v", len(got), got)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("dead grant retained: %d", n)
	}
}

// A collection window that lapses does not carry a stale half-round into the
// next attempt.
func TestStaleCollectionWindowStartsOver(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.advance(grantCollectWindow + 1)
	// peer-b arrives far too late: its request starts a FRESH window rather
	// than completing the abandoned one.
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	time.Sleep(20 * time.Millisecond)
	if n := h.issueCount(); n != 0 {
		t.Fatalf("a lapsed window still completed: %d issuances", n)
	}
	// Both inside one window works.
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 3})
	h.settle(2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("%d issuances", n)
	}
}

// The configuration the issuer returns can never overwrite the protocol fields
// the server decided.
func TestIssuedConfigCannotOverwriteProtocolFields(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.answer = RenewIssue{
		Status: RenewGranted,
		Config: map[string]any{
			"iceServers": []any{},
			"status":     "denied",
			"round":      uint32(99),
			"rid":        uint32(99),
		},
		Expiry: h.now + 3600,
	}
	h.mu.Unlock()

	h.bothAsk("room-1", 1, 5, 6)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("configuration overwrote status: %q", s)
		}
		if round, _ := r.body["round"].(float64); uint32(round) != 1 {
			t.Fatalf("configuration overwrote round: %v", r.body["round"])
		}
		rid, _ := r.body["rid"].(float64)
		if uint32(rid) != 5 && uint32(rid) != 6 {
			t.Fatalf("configuration overwrote rid: %v", r.body["rid"])
		}
	}
}

func TestGrantRegistryIsBounded(t *testing.T) {
	h := newGrantHarness(t)
	h.reg.mu.Lock()
	h.reg.max = 2
	h.reg.mu.Unlock()
	for _, room := range []string{"r1", "r2", "r3", "r4"} {
		h.reg.Open(room, "owner", "tag-"+room, []string{"a", "b"})
	}
	if n := h.reg.Len(); n != 2 {
		t.Fatalf("registry held %d grants past its cap", n)
	}
}

// ---------------------------------------------------------------------------
// The three cases root's independent oracle reproduced RED against the first
// draft. Each is kept verbatim in shape so a regression reports as the exact
// failure that was found, not as a derived one.

// S1. /api/ice issues BEFORE the second peer joins. The grant is created
// afterwards and must inherit that credential rather than look like it has
// nothing to renew.
func TestOracleInitialIssuedBeforePair(t *testing.T) {
	h := newGrantHarness(t)
	h.now = 4000
	// The credential was issued at 1000 and runs to 4600: still live, and far
	// enough back to clear the issuance floor.
	h.inherit("gtag1", 4600)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	// One member at a time, so a refusal is observable as itself. Without the
	// inheritance the grant looks like it has nothing to renew and denies the
	// FIRST request outright, which is the shape root reproduced.
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	time.Sleep(20 * time.Millisecond)
	for _, r := range h.replies() {
		t.Fatalf("legitimate before-pair initial credential should remain renewable: %+v", r.body)
	}
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	h.settle(2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("legitimate before-pair initial credential should remain renewable: %+v", r.body)
		}
	}
}

// S2. The grant's last credential expires WHILE the issuer is running. The
// result must be discarded; an expired authority is never resurrected by the
// answer to a question it had already lost the right to ask.
func TestOracleExpiresDuringIssuer(t *testing.T) {
	h := newGrantHarness(t)
	h.now = 4000
	h.inherit("gtag1", 4001)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})
	h.mu.Lock()
	h.block = make(chan struct{})
	h.mu.Unlock()

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	select {
	case <-h.sawCtx:
	case <-time.After(time.Second):
		t.Fatal("issuer never started")
	}
	h.now = 4002 // the original credential has now expired
	h.mu.Lock()
	close(h.block)
	h.block = nil
	h.mu.Unlock()

	time.Sleep(50 * time.Millisecond)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s == RenewGranted {
			t.Fatalf("expired original grant resurrected during async issuer: %+v", r.body)
		}
	}
}

// S3. A grant whose original credential was issued moments ago may not renew
// immediately: the floor is half a credential TTL from the ACTUAL issuance.
func TestOracleFirstRenewalHalfTTL(t *testing.T) {
	h := newGrantHarness(t)
	h.inherit("gtag1", h.tick()+3600) // issued right now
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s == RenewGranted {
			t.Fatalf("newly created grant immediately renews before halfTTL: %+v", r.body)
		}
	}
}

// ---------------------------------------------------------------------------
// Strict wire

func TestParseRenewRequestIsStrict(t *testing.T) {
	if req, ok := ParseRenewRequest([]byte(`{"round":1,"rid":2}`)); !ok || req.Round != 1 || req.RID != 2 {
		t.Fatalf("well-formed payload rejected: %+v %v", req, ok)
	}
	if req, ok := ParseRenewRequest([]byte(`{"round":4294967295,"rid":4294967295}`)); !ok || req.Round != 4294967295 {
		t.Fatalf("uint32 maximum rejected: %+v %v", req, ok)
	}
	for _, bad := range []string{
		``,                                 // nothing
		`null`,                             // a JSON null decodes to a zero struct
		`{}`,                               // both absent
		`{"round":1}`,                      // rid absent
		`{"rid":1}`,                        // round absent
		`{"round":0,"rid":1}`,              // round 0 is the original grant
		`{"round":1,"rid":0}`,              // rid 0 is indistinguishable from absent
		`{"round":null,"rid":1}`,           // explicit null
		`{"round":1,"rid":null}`,           //
		`{"round":-1,"rid":1}`,             // negative
		`{"round":1.5,"rid":1}`,            // not an integer
		`{"round":1.0,"rid":1}`,            // integral, but not an integer LITERAL
		`{"round":1e3,"rid":1}`,            // exponent form
		`{"round":4294967296,"rid":1}`,     // past uint32
		`{"round":"1","rid":1}`,            // string
		`{"round":1,"rid":1,"extra":true}`, // unknown key
		`{"round":1,"rid":1} {"round":2}`,  // trailing value
		`[1,2]`,                            // not an object
	} {
		if _, ok := ParseRenewRequest([]byte(bad)); ok {
			t.Errorf("ParseRenewRequest(%s) accepted", bad)
		}
	}
}

// A verdict names the round it is a verdict on; only a resynchronisation names
// the server's own. Without that split a client cannot tell "round 2 was
// refused" from "round 2 does not exist yet".
func TestRefusalsNameTheRoundTheyRefuse(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")

	// Rate: both asked for round 1 too soon after the original issuance.
	h.inherit("gtag1", h.tick()+3600)
	h.reg.Depart("room-1", "peer-a")
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if statusOf(t, r) != RenewUnavailable {
			t.Fatalf("expected a rate refusal: %+v", r.body)
		}
		if round, _ := r.body["round"].(float64); uint32(round) != 1 {
			t.Fatalf("a rate refusal named round %v, want the refused 1", r.body["round"])
		}
	}

	// Expired: the verdict still names the round asked for, not the server's.
	h.reset()
	h.advance(3601)
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 4, RID: 9})
	h.settle(1)
	got := h.replies()[0]
	if statusOf(t, got) != RenewDenied {
		t.Fatalf("expected an expired denial: %+v", got.body)
	}
	if round, _ := got.body["round"].(float64); uint32(round) != 4 {
		t.Fatalf("an expired denial named round %v, want the refused 4", got.body["round"])
	}
}

// ---------------------------------------------------------------------------
// R1: the continuous-segment anchor.

// THE LIVENESS COUNTEREXAMPLE. Pre-upload holds a code open, so the two peers'
// initial fetches can be far apart while both credentials are live: A at minute
// 0 (to minute 60), B at 25, 40 or 59. The pair is only observed when B joins.
//
// A must be able to renew in its own margin — minute 49 or 50 — and an anchor
// on the LATEST issuance refuses exactly that, because minute 49 is inside half
// a TTL of minute 59. This was dismissed once on the grounds that the early
// peer would have lapsed hours earlier. It would not have: its credential has
// ten minutes left, which is precisely when it is due to renew.
func TestEarlierPeerRenewsWhileALaterPeerJoinedTheSameSegment(t *testing.T) {
	const minute = int64(60)
	for _, bJoin := range []int64{25, 40, 59} {
		t.Run(fmt.Sprintf("b-at-%dmin", bJoin), func(t *testing.T) {
			h := newGrantHarness(t)
			start := h.tick()
			// A fetched at minute 0, B at bJoin; the segment's first credential
			// expires at 60, its latest at bJoin+60.
			h.inheritSegment("gtag1", start+60*minute, start+(bJoin+60)*minute)
			// Paired when B joined.
			h.advance(bJoin * minute)
			h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

			// On to A's margin.
			h.advance((50 - bJoin) * minute)
			h.bothAsk("room-1", 1, 1, 2)
			for _, r := range h.replies() {
				if s := statusOf(t, r); s != RenewGranted {
					t.Fatalf("A fetched at 0 / B at %d: renewal at minute 50 refused: %+v", bJoin, r.body)
				}
			}
		})
	}
}

// The other side of the same anchor: when the segment's FIRST issuance is only
// now, round 1 is not admissible yet. Per the framing clarification this test
// must place that issuance at the same instant as Open — using an older one
// would assert the very behaviour the case above forbids.
func TestImmediatelyAfterOpenIsFlooredWhenIssuanceIsAlsoNow(t *testing.T) {
	h := newGrantHarness(t)
	h.inherit("gtag1", h.tick()+3600) // issued NOW, expiring in a full hour
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("status %q, want unavailable", s)
		}
		if reason, _ := r.body["reason"].(string); reason != renewReasonRate {
			t.Fatalf("reason %q, want rate", reason)
		}
	}
	// Half a TTL after that issuance it becomes admissible.
	h.reset()
	h.advance(1800)
	h.bothAsk("room-1", 1, 3, 4)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("still refused past the floor: %d issuances", n)
	}
}

// A later peer joining a LIVE segment must not push the anchor forward. This is
// the unit-level statement of the counterexample above.
func TestALaterIssuanceDoesNotMoveALiveSegmentAnchor(t *testing.T) {
	h := newGrantHarness(t)
	start := h.tick()
	h.inherit("gtag1", start+3600) // A: issued now, expires in an hour
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	// B fetches 25 minutes later, joining the same live segment.
	h.advance(1500)
	h.reg.NoteIssued("gtag1", h.tick()+3600)

	// Half a TTL after the SEGMENT's first issuance — not after B's.
	h.advance(300) // now = start + 1800
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("a later peer's fetch pushed the anchor: %+v", r.body)
		}
	}
}

// Two lapse shapes, kept apart because they have opposite outcomes.
//
// A generation whose credentials all expired BEFORE the peers ever met has no
// authority to inherit, and inheriting it would anchor a future floor to an
// ancient instant. It hydrates as unissued, survives, and gains authority from
// the next real issuance.
func TestFirstEverPairAfterHistoricalLapseHydratesAsUnissued(t *testing.T) {
	h := newGrantHarness(t)
	// A credential issued long ago and long expired. The clock is pushed out
	// first so "ancient" is a positive instant: an expiry that happens to land
	// on zero would be indistinguishable from "never issued" and would make
	// this test pass for the wrong reason.
	h.advance(100_000)
	h.inherit("gtag1", h.tick()-10_000)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.settle(1)
	if s := statusOf(t, h.replies()[0]); s != RenewUnavailable {
		t.Fatalf("status %q, want unavailable for a never-authoritative grant", s)
	}
	if n := h.reg.Len(); n != 1 {
		t.Fatalf("expired history destroyed the grant: %d held", n)
	}

	// The real first issuance arrives. Its floor runs from NOW, not from the
	// ancient expiry — so it is not immediately renewable...
	h.reset()
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("an ancient expiry anchored the new segment's floor: %+v", r.body)
		}
	}
	// ...and is, half a TTL later.
	h.reset()
	h.advance(1800)
	h.bothAsk("room-1", 1, 3, 4)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the fresh segment never became renewable: %d issuances", n)
	}
}

// A grant that WAS authoritative and then lapsed is terminal, and no later
// issuance revives it. The opposite outcome to the case above, from a state
// that looks superficially similar.
func TestFormerlyActiveGrantExpiryIsTerminal(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1") // live, expiring in 600s
	h.advance(601)

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewDenied {
		t.Fatalf("status %q, want denied for a formerly-active lapse", s)
	}
	if reason, _ := got.body["reason"].(string); reason != renewReasonExpired {
		t.Fatalf("reason %q, want expired", reason)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("a lapsed grant was kept: %d", n)
	}
	// A fresh /api/ice afterwards cannot bring it back.
	h.reset()
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.bothAskExpectingNothing("room-1")
}

// After a renewal is accepted the anchor moves to THAT issuance, so the floor
// tracks what the server actually did rather than the original segment.
func TestAcceptedRenewalBecomesTheNewAnchor(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.bothAsk("room-1", 1, 1, 2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("round 1 did not issue: %d", n)
	}
	// Immediately after, round 2 is floored from the accepted renewal.
	h.reset()
	h.bothAsk("room-1", 2, 3, 4)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("round 2 was not floored from the accepted renewal: %+v", r.body)
		}
	}
	h.reset()
	h.advance(1800)
	h.bothAsk("room-1", 2, 5, 6)
	if n := h.issueCount(); n != 2 {
		t.Fatalf("round 2 refused past its floor: %d issuances", n)
	}
}

// ---------------------------------------------------------------------------
// Observer ordering. Issuances are RECORDED under the pairing registry's lock
// but ANNOUNCED outside it, so the two orders need not agree.

// Reordered callbacks must not move the anchor. The index knows which issuance
// came first; the callback does not, so the grant asks rather than assuming
// whichever arrived first was earliest.
func TestReorderedInitialNotificationsStillAnchorTheEarliest(t *testing.T) {
	h := newGrantHarness(t)
	start := h.tick()
	aExpiry := start + 3600 // recorded first
	bExpiry := start + 5100 // recorded second, 25 minutes later
	// The registry's own snapshot — the authority on ordering.
	h.inheritSegment("gtag1", aExpiry, bExpiry)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	// The callbacks arrive in the OPPOSITE order.
	h.reg.NoteIssued("gtag1", bExpiry)
	h.reg.NoteIssued("gtag1", aExpiry)

	// The anchor is A's issuance (start), so half a TTL later the round is
	// admissible. Anchored to B it would be refused until start+3300.
	h.advance(1800)
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("reordered callbacks moved the anchor to the later issuance: %+v", r.body)
		}
	}
}

// The same ordering hazard for a grant that was opened UNISSUED: the first
// callback to arrive must not become the anchor by default.
func TestUnissuedGrantAnchorsFromTheSnapshotNotTheFirstCallback(t *testing.T) {
	h := newGrantHarness(t)
	start := h.tick()
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	aExpiry := start + 3600
	bExpiry := start + 5100
	h.inheritSegment("gtag1", aExpiry, bExpiry)
	h.reg.NoteIssued("gtag1", bExpiry) // the LATER issuance announced first

	h.advance(1800)
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("an unissued grant anchored on the first callback rather than the snapshot: %+v", r.body)
		}
	}
}

// A late callback describing an ALREADY-EXPIRED credential confers nothing. On
// an unissued grant it would otherwise activate authority against dead history
// — authoritative-looking until the next sweep happened to notice.
func TestExpiredNotificationNeverActivatesAnUnissuedGrant(t *testing.T) {
	h := newGrantHarness(t)
	h.advance(100_000)
	h.reg.Open("room-1", "owner-1", "gtag1", []string{"peer-a", "peer-b"})

	h.reg.NoteIssued("gtag1", h.tick()-100) // expired before it was announced

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.settle(1)
	if s := statusOf(t, h.replies()[0]); s != RenewUnavailable {
		t.Fatalf("an expired notification activated an unissued grant: %+v", h.replies()[0].body)
	}
	if n := h.reg.Len(); n != 1 {
		t.Fatalf("the unissued grant was destroyed: %d held", n)
	}
	// And it is still able to receive a real issuance afterwards.
	h.reset()
	h.inherit("gtag1", h.tick()+3600)
	h.reg.NoteIssued("gtag1", h.tick()+3600)
	h.advance(1800)
	h.bothAsk("room-1", 1, 1, 2)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewGranted {
			t.Fatalf("a real issuance after an expired one was refused: %+v", r.body)
		}
	}
}

// An expired notification must not revive a grant that HAS lapsed either — that
// path retires it, which is the opposite outcome and must stay so.
func TestExpiredNotificationStillRetiresALapsedGrant(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.advance(601) // past the staged expiry
	h.reg.NoteIssued("gtag1", h.tick()-10)
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("a lapsed grant survived: %d held", n)
	}
}

// ---------------------------------------------------------------------------
// Issuer cooldown: bounded DATABASE work, distinct from the issuance floor.

// The reproduction. `denied` and `unavailable` advance no round and charge no
// issuance floor, so without a cooldown the same two members can re-collect and
// re-run the issuer immediately — an independent probe drove twenty issuer
// invocations at one instant where one was correct.
func TestRepeatedRefusalsRunTheIssuerOncePerCooldown(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewDenied, Reason: renewReasonQuota, RelayDenied: "quota"}
	h.mu.Unlock()

	h.bothAsk("room-1", 1, 1, 2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("first attempt ran the issuer %d times", n)
	}

	// Twenty more attempts at the SAME instant must reach the database no more.
	for i := 0; i < 20; i++ {
		h.reset()
		h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: uint32(100 + i)})
		h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: uint32(200 + i)})
		h.settle(2)
		for _, r := range h.replies() {
			if s := statusOf(t, r); s != RenewUnavailable {
				t.Fatalf("attempt %d: status %q, want unavailable", i, s)
			}
			if reason, _ := r.body["reason"].(string); reason != renewReasonRate {
				t.Fatalf("attempt %d: reason %q, want %q", i, reason, renewReasonRate)
			}
			if round, _ := r.body["round"].(float64); uint32(round) != 1 {
				t.Fatalf("attempt %d: named round %v, want the refused 1", i, r.body["round"])
			}
		}
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("twenty refused attempts ran the issuer %d times, want 1", n)
	}
}

// The boundary, from both sides.
func TestIssuerCooldownBoundary(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewUnavailable, Reason: renewReasonBusy}
	h.mu.Unlock()
	h.bothAsk("room-1", 1, 1, 2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("issuer ran %d times", n)
	}

	// One second short: still refused without a read.
	h.reset()
	h.advance(grantIssuerCooldown - 1)
	h.bothAsk("room-1", 1, 3, 4)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the issuer ran inside the cooldown: %d", n)
	}
	if reason, _ := h.replies()[0].body["reason"].(string); reason != renewReasonRate {
		t.Fatalf("reason %q inside the cooldown, want %q", reason, renewReasonRate)
	}

	// At the boundary it runs again.
	h.reset()
	h.advance(1)
	h.bothAsk("room-1", 1, 5, 6)
	if n := h.issueCount(); n != 2 {
		t.Fatalf("the issuer did not run at the cooldown boundary: %d", n)
	}
}

// A run that TIMED OUT has already spent the work the cooldown protects, so it
// starts the clock exactly as a fast refusal does.
func TestTimedOutIssuerStillChargesTheCooldown(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.block = make(chan struct{})
	h.mu.Unlock()

	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 1})
	h.reg.Request("room-1", "peer-b", RenewRequest{Round: 1, RID: 2})
	select {
	case <-h.sawCtx:
	case <-time.After(time.Second):
		t.Fatal("issuer never started")
	}
	// It is released only after the grant has lapsed, so its result is
	// discarded — the late-result path must not resurrect anything, and the
	// cooldown must still have been charged.
	h.advance(601)
	h.mu.Lock()
	close(h.block)
	h.block = nil
	h.mu.Unlock()
	time.Sleep(50 * time.Millisecond)

	if got := h.replies(); len(got) != 0 {
		t.Fatalf("a lapsed grant was answered: %+v", got)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("lapsed grant retained: %d", n)
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("issuer ran %d times", n)
	}
}

// Cooldown is per grant. One room exhausting its budget must not silence
// another.
func TestIssuerCooldownIsPerGrant(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.inherit("gtag2", h.tick()+600)
	h.reg.Open("room-2", "owner-2", "gtag2", []string{"peer-a", "peer-b"})
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewDenied, Reason: renewReasonQuota, RelayDenied: "quota"}
	h.mu.Unlock()

	h.bothAsk("room-1", 1, 1, 2)
	h.reset()
	h.bothAsk("room-1", 1, 3, 4) // room-1 is now in cooldown
	if n := h.issueCount(); n != 1 {
		t.Fatalf("room-1 ran the issuer %d times", n)
	}
	h.reset()
	h.bothAsk("room-2", 1, 5, 6)
	if n := h.issueCount(); n != 2 {
		t.Fatalf("room-2 was blocked by room-1's cooldown: %d issuances", n)
	}
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewDenied {
			t.Fatalf("room-2 got %q rather than its own issuer's answer", s)
		}
	}
}

// A cached success is replayed from ahead of the cooldown, so a client that
// lost a reply is never told to wait for work that has already been done.
func TestCachedSuccessIsReplayedDuringTheCooldown(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.bothAsk("room-1", 1, 1, 2)
	if n := h.issueCount(); n != 1 {
		t.Fatalf("round 1 did not issue: %d", n)
	}

	// Immediately, well inside the cooldown.
	h.reset()
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 42})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewGranted {
		t.Fatalf("the cooldown masked a cached success: %+v", got.body)
	}
	if rid, _ := got.body["rid"].(float64); uint32(rid) != 42 {
		t.Fatalf("replay echoed rid %v", got.body["rid"])
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the replay reissued: %d", n)
	}
}

// Membership and expiry still answer ahead of the cooldown: a stranger learns
// nothing, and a lapsed grant is told the truth rather than "wait".
func TestMembershipAndExpiryOutrankTheCooldown(t *testing.T) {
	h := newGrantHarness(t)
	h.open("room-1")
	h.mu.Lock()
	h.answer = RenewIssue{Status: RenewUnavailable, Reason: renewReasonBusy}
	h.mu.Unlock()
	h.bothAsk("room-1", 1, 1, 2) // charge the cooldown

	h.reset()
	h.reg.Request("room-1", "peer-c", RenewRequest{Round: 1, RID: 9})
	time.Sleep(20 * time.Millisecond)
	if got := h.replies(); len(got) != 0 {
		t.Fatalf("a stranger drew a reply during the cooldown: %+v", got)
	}

	h.advance(601) // the credential lapses, still inside no cooldown of its own
	h.reg.Request("room-1", "peer-a", RenewRequest{Round: 1, RID: 10})
	h.settle(1)
	got := h.replies()[0]
	if s := statusOf(t, got); s != RenewDenied {
		t.Fatalf("a lapsed grant answered %q rather than a truthful denial", s)
	}
	if reason, _ := got.body["reason"].(string); reason != renewReasonExpired {
		t.Fatalf("reason %q, want %q", reason, renewReasonExpired)
	}
	if n := h.reg.Len(); n != 0 {
		t.Fatalf("lapsed grant retained: %d", n)
	}
}

// The cooldown must never be what lets a credential be issued sooner: it is
// strictly shorter than the half-TTL floor, so the floor still governs success.
func TestCooldownNeverShortensTheIssuanceFloor(t *testing.T) {
	if grantIssuerCooldown >= int64((time.Hour / 2).Seconds()) {
		t.Fatalf("cooldown %ds is not strictly shorter than a production half-TTL", grantIssuerCooldown)
	}
	h := newGrantHarness(t)
	h.open("room-1")
	h.bothAsk("room-1", 1, 1, 2) // accepted; floor now runs from here
	h.reset()
	h.advance(grantIssuerCooldown + 1)
	h.bothAsk("room-1", 2, 3, 4)
	for _, r := range h.replies() {
		if s := statusOf(t, r); s != RenewUnavailable {
			t.Fatalf("past the cooldown but inside the floor: %+v", r.body)
		}
	}
	if n := h.issueCount(); n != 1 {
		t.Fatalf("the cooldown let an issuance through the floor: %d", n)
	}
}
