package signal

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Renewal grants: who may ask for a fresh relay credential for a transfer that
// is already running, and what the server will hand them.
//
// ## Why this exists at all
//
// A relay credential lives TURNCredTTL — an hour — and a transfer does not
// stop caring at the end of it. pion re-authenticates every Refresh and
// CreatePermission, so ON OUR OWN NODES a relayed path simply stops moving
// bytes shortly after its credential lapses, with the data channel still
// reporting `open`. That is a property of OUR OWN nodes and not a general one:
// a credential expiry does not compel the third-party TURN server to retire an
// allocation that is already running, so a credential lifetime bounds what may
// be newly allocated and not how long an existing allocation lives.
//
// **Grant authority expires on its own clock regardless.** It is a server-side
// rule about what may be ISSUED, deliberately independent of whatever a TURN
// engine does with an allocation it already has. Until now the only honest answer was to end the link before
// that happened and make the two people pair again. The owner's decision is
// that a legitimately paired, progressing transfer should be able to get a
// fresh credential instead, while every existing quota still applies.
//
// ## What the authority is, and what it is NOT
//
// The authority is the ORIGINAL generation: the opaque room a mint produced,
// the account that minted it, the attribution tag its bytes are billed under,
// and — frozen at the instant the room first held two connections — the exact
// two hub peer ids that were in it.
//
// It is deliberately NOT any of these:
//
//   - **Not the pairing code.** Those six digits are recycled five minutes
//     after they expire. A renewal that re-presented them would hand somebody
//     else's credential to whoever now owns them, and would spend the shared
//     guess budget on every attempt. No code is ever read here.
//   - **Not a bearer token.** Nothing new is minted for the client to hold,
//     so there is nothing to steal, replay or leak. The capability IS the
//     admitted websocket, which the server itself stamped.
//   - **Not "the room currently holds two peers".** A peer that leaves frees a
//     slot, and while the code is still live somebody else can take it. Room
//     occupancy would therefore let a replacement inherit the original pair's
//     authority. The two ids are captured under the same lock that admitted the
//     second one and never move afterwards.
//
// ## Why both peers must ask
//
// One frozen member asking proves one endpoint wants to continue. It does not
// prove the transfer exists: that peer could be holding credentials open
// against its own account's quota with nobody on the other end. Requiring both
// frozen members to ask for the same round makes "the link is still there"
// something the server can decide from two independent sockets rather than from
// one client's assertion about traffic it alone can see.
//
// The server cannot observe activity directly and does not pretend to. Relay
// telemetry is not a gate here: a transfer that migrates from one of our pion
// nodes to coturn goes quiet in the metering stream while being perfectly
// healthy, because coturn publishes an allocation's total only when it is
// deleted. Treating that silence as idleness would refuse exactly the
// legitimate case this feature exists for. Activity remains a property honest
// clients enforce with their own user-data clock; the server's gates are
// membership, account policy, quota and rate.
//
// ## What bounds it
//
// A grant dies the moment either frozen member's socket leaves, and it cannot
// be revived — a reconnect is a new id, which is the same rule the clients
// already apply to link recovery. It also dies when the last credential it
// issued expires, because at that point there is nothing left to renew. New
// issuance is refused sooner than half a credential's TTL after the previous
// one, so a pair that keeps asking cannot turn one generation into an unbounded
// stream of credentials. Every account check — existence, email verification,
// plan quota, strict-node policy, node budgets — runs on every round and fails
// CLOSED.

// grantCollectWindow is how long the first frozen member's request waits for
// the second one.
//
// There is no timer behind it and no reply when it lapses. The client protocol
// already defines silence as "unavailable" (docs/protocol/relay-renew-v1.md
// §2.4), because an old server ignores the frame entirely — so a server that
// answered a half-collected round with a status would be inventing a state the
// clients must handle anyway. Expiry is evaluated lazily, when the next request
// arrives or when the sweep runs, which is what keeps this free of per-grant
// timers and dangling callbacks.
const grantCollectWindow int64 = 30

// grantIssueTimeout bounds the database work one issuance may do.
const grantIssueTimeout = 10 * time.Second

// grantIssuerCooldown is the minimum gap between two ISSUER RUNS for one grant,
// whatever the first one answered.
//
// The half-TTL floor bounds how often credentials may be ISSUED, and that is a
// money rule. This is a different rule with a different job: bounding how often
// the database may be ASKED. Without it a refusal costs nothing to repeat —
// `denied` and `unavailable` neither advance the round nor charge the floor, so
// the same two members can immediately collect another round and run the issuer
// again. Two frames buy a full policy read, and the per-connection frame budget
// (burst 50, refill 10/s) allows a great many of them; an independent probe
// drove twenty issuer invocations at a single instant where one was correct.
//
// That path loses no money — every one of those runs fails closed — but it
// violates the bounded-database-work invariant, and it does so hardest exactly
// when the database is already degraded, which is when the retry pressure
// arrives. Thirty seconds bounds it to one run per grant per half-minute.
//
// It cannot affect an honest client: their backoff after an `unavailable` is
// sixty seconds, twice this. And it is deliberately NOT a money gate — it is
// strictly shorter than the half-TTL floor, so it can never be what lets a
// credential be issued sooner.
const grantIssuerCooldown int64 = 30

// grantUnissuedWindow bounds a grant that has never seen a credential.
//
// It is NOT a renewal window: such a grant cannot renew at all, because zero
// issued credentials is not permission to issue. It exists only so the map
// cannot hold an entry forever for a room whose peers never fetched ICE.
//
// Six hours, matching the outer bound on how long a pairing code can stay
// joinable when pre-upload keeps extending it (account.pairRoomMaxJoinable) —
// which is the longest a legitimate late first fetch can arrive after the two
// peers met. Departure is the ordinary end of such a grant and fires
// immediately; this only catches a room that somehow outlives it.
const grantUnissuedWindow int64 = 6 * 3600

// maxGrants bounds the registry.
//
// Tied to maxRooms because a grant cannot exist without a signalling room that
// held two peers, so the hub's own room cap is the real ceiling; this is the
// same number said again so a future change to one is visible against the
// other. At the cap, creation is refused: a transfer that never gets a grant
// keeps exactly today's behaviour, which is to run out its credential and end
// truthfully.
const maxGrants = maxRooms

// RenewRequest is the client's `ice-renew` payload: exactly two keys.
type RenewRequest struct {
	// Round is the issuance round being asked for. Round 0 is the original
	// /api/ice grant, so the first renewal asks for 1.
	Round uint32 `json:"round"`
	// RID correlates the reply. It is the requester's own number and the server
	// only echoes it.
	RID uint32 `json:"rid"`
}

// ParseRenewRequest decodes an `ice-renew` payload STRICTLY, or reports that it
// is not one.
//
// The protocol fixes the payload at exactly two keys, both positive uint32
// (docs/protocol/relay-renew-v1.md §2.1). Accepting anything looser would be a
// standing invitation for three different clients to send three different
// shapes and for the server to have opinions about which it likes — so an extra
// key, a missing one, a null, a float, a negative or a zero is refused here,
// before any grant state is touched.
//
// Zero is refused for both fields rather than treated as a default. Round 0 is
// the ORIGINAL /api/ice grant, which this endpoint never issues and has no
// cached result for, and rid 0 is indistinguishable from an absent field in a
// client that forgot to set it; in both cases a request that was going to be
// answered wrongly is better refused.
//
// The frame has already been charged against the connection's budget by the
// time this runs, so a flood of malformed payloads costs exactly what a flood
// of well-formed ones costs.
func ParseRenewRequest(data []byte) (RenewRequest, bool) {
	var raw struct {
		Round *json.RawMessage `json:"round"`
		RID   *json.RawMessage `json:"rid"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		return RenewRequest{}, false
	}
	// Exactly one JSON value, nothing trailing.
	if dec.More() {
		return RenewRequest{}, false
	}
	round, ok := positiveU32(raw.Round)
	if !ok {
		return RenewRequest{}, false
	}
	rid, ok := positiveU32(raw.RID)
	if !ok {
		return RenewRequest{}, false
	}
	return RenewRequest{Round: round, RID: rid}, true
}

// positiveU32 accepts only a bare integer literal in [1, math.MaxUint32].
//
// It inspects the RAW bytes rather than decoding into a number type, because
// the decoder's coercions are exactly what a strict wire must not inherit: a
// quoted "1", a 1.0, a 1e3 and a -1 all become something usable somewhere in
// encoding/json, and none of them is what the protocol specifies. ParseUint on
// the literal accepts one shape and no other.
func positiveU32(raw *json.RawMessage) (uint32, bool) {
	if raw == nil {
		return 0, false
	}
	lit := strings.TrimSpace(string(*raw))
	if lit == "" {
		return 0, false
	}
	for i := 0; i < len(lit); i++ {
		if lit[i] < '0' || lit[i] > '9' {
			return 0, false // a sign, a point, an exponent, a quote — none of them
		}
	}
	v, err := strconv.ParseUint(lit, 10, 32)
	if err != nil || v == 0 {
		return 0, false
	}
	return uint32(v), true
}

// Grant reply statuses. These are the exact strings on the wire.
const (
	// RenewGranted carries credentials for the requested round.
	RenewGranted = "granted"
	// RenewDenied is terminal for that round: policy refused.
	RenewDenied = "denied"
	// RenewUnavailable means the server could not answer; bounded retry is
	// allowed and issuance has NOT advanced.
	RenewUnavailable = "unavailable"
	// RenewStale means the client asked for the wrong round; the reply names
	// the round it may ask for.
	RenewStale = "stale"
)

// Diagnostic reasons. Never routed on by a client and never shown as prose.
const (
	renewReasonQuota      = "quota"
	renewReasonUnverified = "unverified"
	renewReasonExpired    = "expired"
	renewReasonMembership = "membership"
	renewReasonRate       = "rate"
	renewReasonBusy       = "unavailable"
)

// RenewIssue is what the account layer answers with for one issuance.
//
// Config is the /api/ice-shaped body — `iceServers` and optionally `relays`.
// This package never interprets it; it only merges it into the reply, so there
// is exactly one credential format on the wire and the clients' existing
// sanitiser handles both.
type RenewIssue struct {
	Status      string
	Reason      string
	RelayDenied string
	Config      map[string]any
	// Expiry is the credential expiry the issuer stamped, used to keep the
	// grant alive exactly as long as something it issued can still be used.
	Expiry int64
}

// RenewIssuer produces credentials for a generation. It is given the ORIGINAL
// frozen owner and attribution tag — never a pairing code, which by then may
// name somebody else entirely.
//
// It must fail closed: any lookup it cannot complete is `unavailable` with no
// credentials, never a default-allow.
type RenewIssuer func(ctx context.Context, owner, tag string) RenewIssue

// GrantDeliver sends one reply to one peer in one room. Production wires it to
// Hub.Relay, which resolves the target under the hub's own lock and drops the
// send if that peer has gone.
type GrantDeliver func(room, peerID string, data json.RawMessage)

// grant is one generation's renewal authority.
type grant struct {
	// room is the opaque per-mint generation. It is a map key and a delivery
	// address and nothing else: never serialised to a client, never logged.
	room string
	// owner and tag are frozen at creation from the mint's own snapshot. The
	// issuer is given these, so a recycled code can never redirect billing.
	owner string
	tag   string
	// members are the two hub peer ids the room held when it first held two.
	// Frozen: a departure kills the grant rather than replacing an entry.
	members [2]string

	// seq identifies THIS grant among every grant this registry has ever held.
	// An asynchronous issuance carries it and compares on completion, so a
	// result computed for a generation that has since died — and whose room was
	// then re-opened — can never be published into its successor.
	seq uint64
	// openedAt bounds a grant that never learns of any credential at all; see
	// grantUnissuedWindow.
	openedAt int64

	// issued is the highest round the SERVER has issued. 0 means only the
	// original /api/ice credentials exist.
	issued uint32
	// cache is the exact result of round `issued`, replayed for a duplicate
	// request so a lost reply costs no reissuance and no rate charge.
	cache *RenewIssue
	// latestExpiry is the ACTUAL latest credential expiry for this generation,
	// initial /api/ice issuance included. 0 means nothing was ever issued,
	// which is not permission to issue — it is the opposite.
	latestExpiry int64
	// segmentFirstAt is when the CURRENT continuous credential segment began —
	// recovered as `firstIssuedExpiry - ttl`. 0 means nothing is outstanding.
	//
	// It is the rate floor's anchor until a renewal is accepted, and it is the
	// earliest issuance rather than the latest for a reason the liveness case
	// makes concrete. With pre-upload holding a code open, peer A can fetch at
	// minute 0 (credential to minute 60) and peer B at minute 25, 40 or 59; the
	// pair is only observed when B joins. Anchored to B's issuance, A's renewal
	// at minute 49 or 50 would be refused for being inside half a TTL of minute
	// 59 — while A's own credential has ten minutes left and A is exactly in the
	// margin where it must renew. Anchored to the segment's first issuance, both
	// peers become admissible when they are due.
	segmentFirstAt int64
	// lastRenewAt is when the last ACCEPTED renewal issued. 0 = none yet; until
	// then the floor is measured from segmentFirstAt.
	lastRenewAt int64
	// lastIssuerRunAt is when the issuer was last STARTED for this grant,
	// whatever it answered. Bounds database work rather than issuance; see
	// grantIssuerCooldown.
	lastIssuerRunAt int64

	// pending maps a frozen member id to the rid it is waiting on, for the
	// round currently being collected (issued+1).
	pending      map[string]uint32
	pendingSince int64

	// inflight is the single outstanding issuance, with the cancel that ends it
	// when membership dies.
	inflight bool
	cancel   context.CancelFunc

	dead bool
}

// GrantRegistry holds renewal authority for live generations.
type GrantRegistry struct {
	mu     sync.Mutex
	grants map[string]*grant // room -> grant
	byTag  map[string]*grant // attribution tag -> the same grant
	// ttl is the credential lifetime; halfTTL the minimum gap between
	// successful issuances for one generation.
	ttl     int64
	halfTTL int64
	now     func() int64
	issue   RenewIssuer
	deliver GrantDeliver
	// issuedSegment recovers the current continuous segment's FIRST and LATEST
	// credential expiries, so a grant created on the paired admission inherits
	// what /api/ice handed out before (or after) the two peers met. One call,
	// so the pair it returns is a snapshot that really existed.
	issuedSegment func(tag string) (first, latest int64)
	// retain records an ACCEPTED round's expiry for attribution retention only.
	// Called after publication, never before: see PairRegistry.RetainTag.
	retain func(tag string, expiry int64)
	max    int
	seq    uint64
}

// NewGrantRegistry builds a registry for credentials of lifetime credTTL.
//
// issuedSegment and retain connect it to the pairing registry's attribution
// index: one to inherit what has already been issued for a generation, the
// other to record what this registry itself accepted. Both may be nil in an
// isolated test, in which case a grant simply starts with nothing inherited.
func NewGrantRegistry(credTTL time.Duration, now func() int64, issue RenewIssuer, deliver GrantDeliver,
	issuedSegment func(tag string) (first, latest int64), retain func(tag string, expiry int64)) *GrantRegistry {
	ttl := int64(credTTL.Seconds())
	if ttl < 2 {
		ttl = 2
	}
	return &GrantRegistry{
		grants: make(map[string]*grant), byTag: make(map[string]*grant),
		ttl: ttl, halfTTL: ttl / 2, now: now, issue: issue, deliver: deliver,
		issuedSegment: issuedSegment, retain: retain, max: maxGrants,
	}
}

// Open freezes a generation's renewal authority at the instant its room first
// held two connections.
//
// KNOWN, DEFERRED: in a very narrow race this can run AFTER a member's Depart
// — the join observer and the teardown hook are independent — leaving a grant
// whose frozen pair can never both be present. It issues nothing (two distinct
// live members are required for every round), costs one of maxGrants slots,
// and is reclaimed by its unissued window or by the departure of whoever
// remains. Recorded rather than fixed: closing it means ordering two hub
// callbacks against each other, which is a larger change than the bounded,
// harmless state it would remove.
//
// members must be exactly the two ids the hub reported under the lock that
// admitted the second one. Anything else — one id, three, a re-observation of a
// room that already has a grant — is ignored, so a later join into a slot a
// departure freed can never re-open or re-point authority.
func (g *GrantRegistry) Open(room, owner, tag string, members []string) {
	if room == "" || owner == "" || tag == "" || len(members) != 2 {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, exists := g.grants[room]; exists {
		return
	}
	if len(g.grants) >= g.max {
		return
	}
	g.seq++
	now := g.now()
	gr := &grant{room: room, owner: owner, tag: tag, seq: g.seq, openedAt: now, pending: make(map[string]uint32)}
	gr.members[0], gr.members[1] = members[0], members[1]
	// HYDRATE. /api/ice issues to each peer independently and can do so before
	// the second one ever joins, so by the time this runs there is usually
	// already an hour of credential outstanding that this registry never saw.
	// Read under g.mu, so an issuance notification racing this either lands
	// first and is inherited here, or lands second and finds the grant.
	//
	// The ACTUAL issued expiry, not the attribution index's retention: those
	// differ by a reporting grace and, before any issuance, by the whole
	// question. See attribEntry.lastIssuedExpiry.
	if g.issuedSegment != nil {
		first, latest := g.issuedSegment(tag)
		// EXPIRED HISTORY HYDRATES AS UNISSUED. A generation whose credentials
		// have all lapsed before the two peers ever met has no authority to
		// inherit, and inheriting it would anchor a future floor to an ancient
		// instant. It is left at zero, which is not permission to issue: a
		// fresh /api/ice starts a new segment and the floor starts with it.
		//
		// That is a different case from a grant that WAS live and then lapsed,
		// which NoteIssued and Sweep retire outright and never revive.
		if latest > now {
			gr.latestExpiry = latest
			gr.segmentFirstAt = first - g.ttl
		}
	}
	g.grants[room] = gr
	g.byTag[tag] = gr
}

// NoteIssued records a credential expiry against the generation that owns tag.
//
// It is wired to the pairing registry's issuance notification, so the INITIAL
// /api/ice credentials count too — which matters in both directions. A grant
// whose only credentials came from /api/ice still has something to renew, and a
// grant that has issued nothing at all has nothing to renew and says so.
//
// Forward only, and a no-op for an unknown or dead generation: initial issuance
// can land either side of the paired admission, and a late one must never
// resurrect a grant whose members have gone.
func (g *GrantRegistry) NoteIssued(tag string, expiry int64) {
	// cancel is run AFTER the lock is released, like every other kill path
	// here: it belongs to an in-flight issuance whose goroutine may be about to
	// take this same lock, and cancelling under it would be an ordering nobody
	// else obeys.
	var cancel context.CancelFunc
	defer func() {
		if cancel != nil {
			cancel()
		}
	}()
	g.mu.Lock()
	defer g.mu.Unlock()
	gr := g.byTag[tag]
	if gr == nil || gr.dead {
		return
	}
	now := g.now()
	// A grant that has ALREADY lapsed is not extended back into life. Its
	// generation's credentials all expired, which ends renewal authority; a
	// fresh /api/ice fetch afterwards — possible while the code is still live,
	// and longer still with pre-upload extending it — is a NEW credential for
	// the same generation, not evidence that the old authority continued.
	// Treating it as an extension is exactly the resurrection the lifetime rule
	// forbids, so the grant is retired here instead.
	if gr.latestExpiry > 0 && gr.latestExpiry <= now {
		cancel = g.killLocked(gr)
		return
	}
	// AN ALREADY-EXPIRED NOTIFICATION CONFERS NOTHING. Observers fire outside
	// the pairing registry's lock, so one can arrive late — describing a
	// credential that has since expired, or one from a run that ended before
	// this grant was ever opened. For a grant that has authority it is simply
	// stale and would change nothing; for an unissued one it would ACTIVATE the
	// grant against dead history, which then looks authoritative until the next
	// sweep notices. Neither is a state worth having.
	if expiry <= now {
		return
	}
	if gr.latestExpiry == 0 {
		// FIRST AUTHORITY: hydrate from the registry's own atomic snapshot,
		// not from this callback's expiry.
		//
		// The two peers' issuances are recorded under the pairing registry's
		// lock but OBSERVED outside it, so the order they are recorded in and
		// the order they are announced in need not agree. Anchoring to
		// whichever callback happens to arrive first would then pick the later
		// issuance about half the time, and that is exactly the anchor that
		// refuses the earlier peer's renewal. The index knows which came
		// first; this does not, so it asks.
		if g.issuedSegment != nil {
			first, latest := g.issuedSegment(tag)
			if latest > now {
				gr.latestExpiry = latest
				gr.segmentFirstAt = first - g.ttl
				return
			}
			// The snapshot says nothing is outstanding even though this
			// callback describes a live credential — the tag has been retired
			// from the index. Fall through to the callback's own value rather
			// than losing the issuance.
		}
		gr.segmentFirstAt = expiry - g.ttl
		gr.latestExpiry = expiry
		return
	}
	// Already authoritative: a later issuance extends the run and never moves
	// its anchor. Forward only, so callback order cannot matter here.
	if expiry > gr.latestExpiry {
		gr.latestExpiry = expiry
	}
}

// Depart kills the grant a leaving connection belonged to.
//
// Immediate and irreversible. A reconnect arrives with a new server-stamped id
// and is therefore a different member, which is the same conclusion the clients
// reach from their own `establishedSelfId`. Anything in flight is cancelled:
// its result will fail revalidation anyway, and cancelling stops it holding a
// database context open for a link that no longer exists.
func (g *GrantRegistry) Depart(room, peerID string) {
	g.mu.Lock()
	gr := g.grants[room]
	if gr == nil || (gr.members[0] != peerID && gr.members[1] != peerID) {
		g.mu.Unlock()
		return
	}
	cancel := g.killLocked(gr)
	g.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// killLocked marks a grant dead and removes it, returning any cancel the caller
// must run after releasing the lock.
func (g *GrantRegistry) killLocked(gr *grant) context.CancelFunc {
	gr.dead = true
	gr.pending = map[string]uint32{}
	gr.cache = nil
	delete(g.grants, gr.room)
	if g.byTag[gr.tag] == gr {
		delete(g.byTag, gr.tag)
	}
	cancel := gr.cancel
	gr.cancel = nil
	return cancel
}

// Sweep drops grants whose last credential has expired. Called from the same
// tick that reaps codes, so there is no timer per grant.
func (g *GrantRegistry) Sweep() {
	now := g.now()
	var cancels []context.CancelFunc
	g.mu.Lock()
	for _, gr := range g.grants {
		if gr.inflight {
			continue // its own completion will find the grant lapsed
		}
		lapsed := gr.latestExpiry > 0 && gr.latestExpiry <= now
		// A grant that has never learned of ANY credential is not lapsed — it
		// may still be waiting for a legitimate late /api/ice — but it must not
		// be immortal either. Bounded generously, because the fetch it is
		// waiting for is only possible while the code is live and pre-upload
		// can keep a code live for hours (account.pairRoomMaxJoinable).
		stillborn := gr.latestExpiry == 0 && now-gr.openedAt > grantUnissuedWindow
		if lapsed || stillborn {
			if c := g.killLocked(gr); c != nil {
				cancels = append(cancels, c)
			}
		}
	}
	g.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// Run sweeps every interval until ctx is cancelled.
func (g *GrantRegistry) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.Sweep()
		}
	}
}

// Len reports how many grants are held. Test instrumentation for the teardown
// rules; nothing in production reads it.
func (g *GrantRegistry) Len() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.grants)
}

// Request handles one `ice-renew` frame from an admitted connection.
//
// It never blocks: the only database work runs on its own bounded goroutine,
// and at most one of those exists per grant. Called on the connection's read
// goroutine, so nothing here may wait on anything.
func (g *GrantRegistry) Request(room, peerID string, req RenewRequest) {
	now := g.now()
	g.mu.Lock()
	gr := g.grants[room]
	// Not a grant, or not one of the two frozen members. Silence: an
	// unauthorised asker learns nothing, and an honest client already treats
	// silence as unavailable.
	if gr == nil || gr.dead || (gr.members[0] != peerID && gr.members[1] != peerID) {
		g.mu.Unlock()
		return
	}
	// UNISSUED is not LAPSED, and the two must not share an outcome.
	//
	// A grant with nothing outstanding has simply not had its initial /api/ice
	// yet — the peers paired before either fetched, or the fetch is in flight.
	// It cannot renew (zero is not permission), but killing it would throw away
	// the authority that the imminent, entirely legitimate first issuance is
	// about to give it, and the room would then have no grant at all. So it is
	// answered `unavailable` and left alone, bounded by its unissued window and
	// by membership like any other.
	if gr.latestExpiry == 0 {
		reply := staticReply(RenewUnavailable, req.Round, req.RID, renewReasonBusy, "")
		g.mu.Unlock()
		g.deliver(room, peerID, reply)
		return
	}
	// Lapsed: every credential this generation ever had has expired, so there
	// is nothing to continue and never will be. Terminal, and retired here so
	// no later issuance can revive it.
	//
	// A verdict names the round it is a verdict ON — the one the client asked
	// for. Only `stale` names the server's current round, because only `stale`
	// is a resynchronisation rather than an answer.
	if gr.latestExpiry <= now {
		reply := staticReply(RenewDenied, req.Round, req.RID, renewReasonExpired, "")
		cancel := g.killLocked(gr)
		g.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		g.deliver(room, peerID, reply)
		return
	}

	next := gr.issued + 1
	switch {
	case req.Round == gr.issued && gr.cache != nil:
		// A duplicate of the current round: replay the exact cached result with
		// THIS requester's rid. No reissuance, no rate charge — a lost reply
		// must cost nothing.
		reply := issueReply(gr.cache, gr.issued, req.RID)
		g.mu.Unlock()
		g.deliver(room, peerID, reply)
		return
	case req.Round != next:
		// Anything else is a resynchronisation. The protocol says a stale reply
		// names the server's CURRENT round (relay-renew-v1.md §2.2), so a client
		// can re-ask for it and retrieve the cached result; the round it may
		// newly open is that plus one. Naming `next` here instead would tell a
		// client to open a round it has not seen the result of.
		reply := staticReply(RenewStale, gr.issued, req.RID, "", "")
		g.mu.Unlock()
		g.deliver(room, peerID, reply)
		return
	}

	if gr.inflight {
		g.mu.Unlock()
		return // one issuance per grant; the result goes to both members
	}
	// Collection window. A first request that has gone stale starts a fresh
	// window rather than counting towards one nobody completed.
	if len(gr.pending) > 0 && now-gr.pendingSince > grantCollectWindow {
		gr.pending = map[string]uint32{}
	}
	if len(gr.pending) == 0 {
		gr.pendingSince = now
	}
	gr.pending[peerID] = req.RID
	if len(gr.pending) < 2 {
		g.mu.Unlock()
		return // wait for the other frozen member; see grantCollectWindow
	}
	// Both asked. Rate is checked HERE rather than on the first request, so a
	// refusal names the round both peers actually tried to open.
	//
	// THE ANCHOR. Until a renewal is accepted the floor runs from the current
	// segment's FIRST issuance; afterwards from the last accepted renewal. Not
	// from the latest issuance, and not from grant creation:
	//
	//   - Latest issuance is wrong because pre-upload lets the two peers fetch
	//     far apart. A at minute 0 (to minute 60) and B at minute 59 is a
	//     legitimate, live pairing, and flooring from minute 59 refuses A's
	//     renewal at minute 50 while A has ten minutes left. That is the
	//     liveness counterexample, and it is not exotic — it is what pre-upload
	//     is for.
	//   - Grant creation is wrong in both directions: a grant created long
	//     after its credentials were issued could renew at once, and one
	//     created promptly would be blocked for half a TTL it had already spent.
	//
	// The bound the financial review asked for is preserved either way: one
	// generation cannot obtain credentials more often than every half TTL, and
	// the anchor only ever moves forward.
	floorFrom := gr.segmentFirstAt
	if gr.lastRenewAt != 0 {
		floorFrom = gr.lastRenewAt
	}
	if floorFrom != 0 && now < floorFrom+g.halfTTL {
		// UNAVAILABLE, not denied. Too early is a "not yet", and a client that
		// read it as terminal would abandon a renewal it is entitled to make
		// minutes later — while its credential is still live and its margin has
		// not run out. Nothing was issued, no round advanced, no database was
		// touched, so a bounded retry costs the account nothing.
		rids := gr.pending
		gr.pending = map[string]uint32{}
		g.mu.Unlock()
		for id, rid := range rids {
			g.deliver(room, id, staticReply(RenewUnavailable, next, rid, renewReasonRate, ""))
		}
		return
	}

	// ISSUER COOLDOWN. Reached only after membership, expiry, cache replay and
	// the issuance floor have all had their say, so it can never mask a cached
	// success or a terminal refusal — it only ever stops the database from
	// being asked the same question again too soon.
	//
	// Same shape as the floor above: `unavailable` with reason `rate`, nothing
	// issued, no round advanced, no read performed.
	if gr.lastIssuerRunAt != 0 && now < gr.lastIssuerRunAt+grantIssuerCooldown {
		rids := gr.pending
		gr.pending = map[string]uint32{}
		g.mu.Unlock()
		for id, rid := range rids {
			g.deliver(room, id, staticReply(RenewUnavailable, next, rid, renewReasonRate, ""))
		}
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), grantIssueTimeout)
	gr.inflight = true
	gr.cancel = cancel
	// Recorded at START rather than at completion: the bound is on how often
	// the issuer may RUN, and a run that times out has already spent the
	// database work this is protecting.
	gr.lastIssuerRunAt = now
	owner, tag := gr.owner, gr.tag
	members := gr.members
	seq := gr.seq
	g.mu.Unlock()

	go g.complete(ctx, cancel, room, owner, tag, members, seq, next)
}

// complete runs one issuance and publishes it, or discards it.
func (g *GrantRegistry) complete(ctx context.Context, cancel context.CancelFunc, room, owner, tag string, members [2]string, seq uint64, round uint32) {
	defer cancel()
	issue := g.issue(ctx, owner, tag)
	if ctx.Err() != nil {
		// Timed out or cancelled by a departure. Treat as unavailable and let
		// the revalidation below decide whether anyone is still there to tell.
		issue = RenewIssue{Status: RenewUnavailable, Reason: renewReasonBusy}
	}

	now := g.now()
	g.mu.Lock()
	gr := g.grants[room]
	// Revalidate EVERYTHING the decision rested on. A database read can take
	// seconds, and in those seconds the authority it was computed against can
	// die, be replaced or move on.
	//
	//   - `seq` is grant IDENTITY, not a resemblance. A room whose grant died
	//     and was opened again holds a DIFFERENT generation that happens to
	//     share a key, and matching on members alone would publish one
	//     generation's credentials into the other's.
	//   - `inflight` and `issued+1 == round` say this result is still the one
	//     being awaited rather than a straggler from an abandoned attempt.
	//   - the EXPIRY re-check is the one that cannot be skipped: the whole
	//     authority rests on "this generation still has a live credential", and
	//     that can lapse while the issuer is running. The issuer deliberately
	//     records nothing itself (see PairRegistry.RetainTag) precisely so it
	//     cannot extend the authority its own result is about to be judged
	//     against.
	if gr == nil || gr.dead || gr.seq != seq || !gr.inflight || gr.issued+1 != round {
		if gr != nil && gr.seq == seq && gr.inflight && !gr.dead {
			gr.inflight = false
			gr.cancel = nil
			gr.pending = map[string]uint32{}
		}
		g.mu.Unlock()
		return
	}
	if gr.latestExpiry <= 0 || gr.latestExpiry <= now {
		// Lapsed mid-issuance. Discard the result and retire the grant: a
		// refused or cancelled issuance must never be the thing that brings an
		// expired authority back.
		//
		// The cancel killLocked hands back is THIS goroutine's own, already
		// deferred at the top, so there is nothing further to run.
		_ = g.killLocked(gr)
		g.mu.Unlock()
		return
	}
	gr.inflight = false
	gr.cancel = nil
	rids := gr.pending
	gr.pending = map[string]uint32{}

	// Every reply from here names the round that was requested: for a grant it
	// is the round now issued, and for a refusal it is the round refused. The
	// two are the same number, which is why there is only one.
	replyRound := round
	granted := issue.Status == RenewGranted
	if granted {
		// Only a granted round advances issuance, caches, moves the rate floor
		// and extends the grant's own life.
		gr.issued = round
		cached := issue
		gr.cache = &cached
		gr.lastRenewAt = now
		if issue.Expiry > gr.latestExpiry {
			gr.latestExpiry = issue.Expiry
		}
	}
	g.mu.Unlock()

	// Attribution retention, only now that the round is ACCEPTED. Outside the
	// lock: it reaches into the pairing registry, whose own issuance
	// notification comes back this way.
	if granted && g.retain != nil {
		g.retain(tag, issue.Expiry)
	}

	for id, rid := range rids {
		var data json.RawMessage
		if granted {
			data = issueReply(&issue, replyRound, rid)
		} else {
			data = staticReply(issue.Status, replyRound, rid, issue.Reason, issue.RelayDenied)
		}
		g.deliver(room, id, data)
	}
}

// staticReply builds a reply that carries no credentials.
func staticReply(status string, round, rid uint32, reason, relayDenied string) json.RawMessage {
	out := map[string]any{"status": status, "round": round, "rid": rid}
	if reason != "" {
		out["reason"] = reason
	}
	if relayDenied != "" {
		out["relayDenied"] = relayDenied
	}
	return mustJSON(out)
}

// issueReply merges an issued configuration with the envelope fields.
//
// The configuration is copied in FIRST and the four protocol keys written
// after, so a configuration that somehow carried a `status` of its own could
// not overwrite the one the server decided.
func issueReply(issue *RenewIssue, round, rid uint32) json.RawMessage {
	out := make(map[string]any, len(issue.Config)+4)
	for k, v := range issue.Config {
		out[k] = v
	}
	out["status"] = issue.Status
	out["round"] = round
	out["rid"] = rid
	if issue.Reason != "" {
		out["reason"] = issue.Reason
	}
	return mustJSON(out)
}

// mustJSON encodes a reply. A reply that cannot be encoded is sent as a bare
// unavailable rather than as nothing: the client's bounded retry then runs,
// which is the behaviour it already has for an old server.
func mustJSON(v map[string]any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{"status":"unavailable"}`)
	}
	return b
}
