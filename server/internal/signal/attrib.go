package signal

import (
	"crypto/rand"
	"encoding/hex"
)

// Relay attribution tags: the immutable name a relayed byte is billed under.
//
// A TURN REST username is "<expiry>:<userID>.<token>" and the node heartbeat
// (server/account/nodes.go) and the coturn metering worker
// (server/internal/metering) both split that token back into (userID, token) to
// decide whose monthly relay allowance the bytes come out of.
//
// That token USED to be the six-digit pairing code, and that is a billing bug,
// not a naming detail. A code lives CodeTTLSeconds and is then free to be minted
// again for somebody else, while the credential issued under it lives
// TURNCredTTL — an hour. For the ~55 minutes those two windows do not overlap,
// the attribution guard in nodes.go asks "who owns these digits NOW", gets the
// NEW owner, sees a mismatch against the reported (original, correct) owner and
// drops the report as forged. The bytes are relayed at our expense and billed to
// nobody. Reproduced against real issuance and a real authenticated heartbeat:
// the original owner's month-to-date stops at the last pre-recycle report.
//
// A tag fixes that by construction. It is drawn fresh at MINT, one per code
// generation, and it never recycles, so "who owns this token" has exactly one
// answer for as long as anybody can still report bytes under it.
//
// Three properties are load-bearing, and each has a test:
//
//   - INDEPENDENTLY RANDOM. The tag is 128 bits from crypto/rand, drawn for the
//     tag alone. It is NOT derived from the room generation — pair.go's
//     codeEntry says the generation is never persisted or logged, and the tag IS
//     persisted, in usage_events.token. Deriving one from the other would put a
//     function of the generation in the ledger and quietly retire that rule.
//   - SHAPED SO IT CANNOT BE A CODE. The "g" prefix alone means ValidCodeFormat
//     is false for every tag, so a tag can never be resolved by the
//     six-digit-code lookup — which is the recycling hazard this exists to
//     remove.
//   - OUTLIVES ITS ROOM. Retention follows the last CREDENTIAL issued under the
//     tag, not the code and not the signaling room. A room that empties has
//     final bytes still to be reported; dropping the tag with the room would
//     reintroduce the same lost-billing shape from the other end.
//
// What a tag deliberately does NOT do: it does not authenticate the node that
// reports it. A node holding a valid credential's username can still report
// bytes under it, and a tag central has never heard of is still accepted on the
// reporter's word exactly as an unknown code is today (see nodes.go). That is
// the M1 residual, unchanged here on purpose — making unknown tags fail closed
// would drop real billing on every restart and every late report past the
// grace, which is the same loss this change exists to stop.

// relayAttribTagPrefix marks a token as an attribution tag rather than a
// pairing code. One character, and it is what makes ValidCodeFormat false.
const relayAttribTagPrefix = "g"

// relayAttribTagBytes is the tag's entropy: 128 bits, the same width as the
// room generation, drawn separately from it.
const relayAttribTagBytes = 16

// relayAttribTagLen is the exact on-the-wire length of a tag: the prefix plus
// hex of relayAttribTagBytes.
const relayAttribTagLen = len(relayAttribTagPrefix) + 2*relayAttribTagBytes

// relayAttribGraceSeconds is how much longer a tag stays LOOKUPABLE after the
// last credential issued under it expires.
//
// **It is a lookup-retention window, not a metering deadline.** Nothing about
// billing stops at it. Past it a report is still recorded and still billed to
// the account its username names; what is lost is only the ability to
// CONTRADICT a mismatched claim, which puts the report back on exactly the
// accept-on-the-reporter's-word path an expired code has always taken.
//
// **The derivation below holds for OUR OWN pion nodes and nothing else.**
//
//   - On a relayium-node the path does stop near the expiry: pion
//     re-authenticates Refresh, CreatePermission and ChannelBind (pion/turn
//     internal/server/turn.go) and the node rejects an expired username
//     (cmd/relayium-node/relay.go). An allocation's final cumulative total is
//     published when its relay socket closes, landing on the next heartbeat
//     (+30s, nodeHeartbeatInterval), plus catch-up for a brief node outage.
//     Fifteen minutes covers that with room for clock skew.
//   - **The third-party TURN server does not behave this way.** A credential
//     expiry does not compel it to retire an allocation that is already
//     running, so a report for one can arrive long after this window. The
//     details and the measurements behind that are in the project's internal
//     records rather than in this comment.
//
// Such a late report is not a lost byte: past the grace the token is simply
// unknown, and an unknown token is billed to the account its username names,
// which is the same accept-as-reported path an expired code has always taken.
// What lapses is only the ability to CONTRADICT a mismatched claim.
//
// Stretching the window would buy a contradiction check for rarer and rarer
// reports while holding index slots, against a fallback that is already safe.
const relayAttribGraceSeconds int64 = 15 * 60

// maxRelayAttribTags bounds the index.
//
// At ~150 bytes an entry (33-byte key, 32-byte owner, two int64s, map
// overhead) a full index is ~15 MB.
//
// What it takes to fill, and why the answer is two different numbers:
//
//   - A tag that was NEVER ISSUED A CREDENTIAL is retained only to its code's
//     own expiry — five minutes for an ordinary mint (see create's caller). It
//     gets no grace, because a tag that has never been in a username cannot
//     appear in a report, so there is nothing for a grace to protect. Filling
//     100k slots with those needs ~333 successful mints a second, sustained.
//   - A tag that HAS been issued a credential keeps the grace, so it can live
//     the credential's hour plus fifteen minutes (or longer if pre-upload keeps
//     extending its code). Filling the index with those needs ~23 a second.
//
// Either figure is orders of magnitude above this product's load, and every one
// of those mints is a signed-in account past the pre-mint admission gate and
// the 10/min/IP limiter. The cap is a safety valve rather than a tuning knob.
//
// EXHAUSTION FAILS THE MINT. It does not fall back to issuing a raw code: that
// would silently restore the recycling bug precisely when the server is under
// the most mint pressure. PairHandler already turns a failed mint into a
// truthful 503, which is a visible, recoverable error.
//
// A full index does NOT rescan on every attempt — see create.
const maxRelayAttribTags = 100_000

// attribEntry is one generation's billing identity.
type attribEntry struct {
	// owner is the account that minted the code this tag was drawn for. It is
	// written once and never updated: a tag names one generation, and that
	// generation has one payer for its whole life.
	owner string
	// retireAfter is the instant this tag stops being LOOKUPABLE — not the
	// instant its bytes stop being billed (see relayAttribGraceSeconds). Moved
	// forward only, by a code extension and by every credential issued under
	// it, and never pulled in.
	//
	// At mint it is the code's own expiry, with no grace: a tag that has never
	// been put in a credential cannot appear in a report, so there is nothing
	// for a grace to protect and holding the slot only lowers the bar for
	// filling the index. The first issuance is what buys the grace.
	retireAfter int64
	// firstIssuedExpiry is the expiry of the FIRST credential of the current
	// continuous segment — the anchor the renewal rate floor is measured from.
	//
	// A "segment" is a run of issuance with no gap: while some credential for
	// this generation is still live, every further issuance joins the same
	// segment and this value does not move. It only restarts when issuance
	// resumes after everything previously issued has expired.
	//
	// Keeping it separate from the latest expiry is what makes the floor
	// correct for BOTH peers. Their initial fetches are not simultaneous: with
	// pre-upload holding a code open, one peer can fetch at minute 0 and the
	// other at minute 25, 40 or 59, and the pair is only observed at the
	// second one. Anchoring the floor to the LATEST issuance would then measure
	// half a TTL from minute 59 and refuse the first peer's renewal at minute
	// 50 — while its credential, issued at minute 0, has ten minutes left. The
	// earliest issuance of the live segment is the only anchor under which both
	// peers' renewals are admissible exactly when they are due.
	firstIssuedExpiry int64
	// lastIssuedExpiry is the expiry of the ACTUAL latest credential issued
	// under this tag, or 0 when none ever was.
	//
	// Deliberately NOT derivable from retireAfter. Those two answer different
	// questions and diverge in both directions: at mint retireAfter is the
	// code's expiry with no credential behind it at all, and after an issuance
	// it carries a reporting grace that has nothing to do with how long the
	// credential is usable. Renewal authority is measured against THIS one, so
	// subtracting a grace from the other would either invent an hour of
	// authority that was never issued or quietly extend one that has lapsed.
	lastIssuedExpiry int64
}

// attribIndex maps attribution tags to the account that owns them.
//
// It has no lock of its own: PairRegistry owns it and every method below is
// called with PairRegistry.mu held. That is deliberate — the mint has to place
// the code entry and its tag in one critical section, and a second lock taken
// inside the first is a lock-ordering rule nobody would remember. Method
// comments restate the requirement individually.
type attribIndex struct {
	tags map[string]attribEntry
	max  int
	// draw returns a fresh tag, or ("", false) when the system entropy source
	// failed. A field so a test can force both the failure and a collision.
	draw func() (string, bool)
	// lastSweep is the second in which the index last scanned itself, and the
	// whole of the rate bound described on create.
	lastSweep int64
	// sweeps counts full scans. Instrumentation, read only by the test that
	// pins the rate bound — a bound nothing else can observe, because a scan
	// and a fast refusal produce the same answer.
	sweeps int
}

func newAttribIndex() *attribIndex {
	return &attribIndex{tags: make(map[string]attribEntry), max: maxRelayAttribTags, draw: drawRelayAttribTag}
}

// drawRelayAttribTag returns a fresh 128-bit tag, or ("", false) if crypto/rand
// failed.
//
// It reports failure rather than panicking (which is what randCode does for a
// pairing code) because its caller has a correct answer for it: refuse the mint.
// A panic here would take the whole server down over one unlucky read on a path
// that has a clean, truthful 503.
func drawRelayAttribTag() (string, bool) {
	b := make([]byte, relayAttribTagBytes)
	if _, err := rand.Read(b); err != nil {
		return "", false
	}
	return relayAttribTagPrefix + hex.EncodeToString(b), true
}

// validRelayAttribTag reports whether s has the exact shape this package issues.
//
// Checked before the map lookup for the same reason ValidCodeFormat is: the
// reverse lookup is reachable from a node's heartbeat body, so an attacker
// picks the string. Rejecting anything but the issued shape keeps arbitrary
// attacker-chosen keys out of the lookup path.
func validRelayAttribTag(s string) bool {
	if len(s) != relayAttribTagLen || s[:len(relayAttribTagPrefix)] != relayAttribTagPrefix {
		return false
	}
	for i := len(relayAttribTagPrefix); i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// create draws and registers a tag for owner, retained until retireAfter.
//
// Caller holds PairRegistry.mu.
//
// Returns ("", false) when entropy failed, when the drawn tag somehow collides
// with a live one, or when the index is full — see maxRelayAttribTags for why a
// full index refuses rather than degrades.
//
// **A full index scans itself at most once a second.** That bound is a
// latency property, not tidiness. This runs under PairRegistry.mu, which is the
// same lock every /ws admission (RoomFor), every /api/ice issuance (AttribFor)
// and every heartbeat entry (OwnerForTag) takes. Scanning 100k entries on every
// refused mint would turn a mint flood into a stall of all three, so a caller
// that arrives in a second the index has already scanned is refused
// immediately: nothing can have expired since, because expiry is measured in
// whole seconds. Recovery of expired slots is unaffected — the scheduled reap
// sweeps every minute regardless, and the first mint of each new second still
// scans.
func (a *attribIndex) create(owner string, retireAfter, now int64) (string, bool) {
	if len(a.tags) >= a.max {
		if now <= a.lastSweep {
			return "", false
		}
		a.sweep(now)
		if len(a.tags) >= a.max {
			return "", false
		}
	}
	tag, ok := a.draw()
	if !ok {
		return "", false
	}
	// 128 bits makes this unreachable in practice, but "unreachable" and
	// "silently reassigns another account's billing identity" are different
	// enough that it is checked rather than assumed.
	if _, taken := a.tags[tag]; taken {
		return "", false
	}
	a.tags[tag] = attribEntry{owner: owner, retireAfter: retireAfter}
	return tag, true
}

// keepUntil pushes a tag's retention out to retireAfter. Forward only, and a
// no-op for a tag that is not (or is no longer) registered: a late issuance
// report must never resurrect an identity that has already been retired and
// could by then belong to nothing at all.
//
// Caller holds PairRegistry.mu.
func (a *attribIndex) keepUntil(tag string, retireAfter int64) {
	e, ok := a.tags[tag]
	if !ok || retireAfter <= e.retireAfter {
		return
	}
	e.retireAfter = retireAfter
	a.tags[tag] = e
}

// noteIssued records a credential issued under tag at `now`: it moves the
// lookup retention forward, records the credential expiry, and maintains the
// continuous-segment anchor. Forward only, and a no-op for an unregistered tag.
//
// Caller holds PairRegistry.mu.
func (a *attribIndex) noteIssued(tag string, expiry, now int64) {
	e, ok := a.tags[tag]
	if !ok {
		return
	}
	if r := expiry + relayAttribGraceSeconds; r > e.retireAfter {
		e.retireAfter = r
	}
	// A NEW segment starts when nothing was ever issued, or when everything
	// previously issued has already expired. Otherwise this issuance joins the
	// live segment and leaves its anchor exactly where it is — a later peer
	// fetching its own credential must not push the floor past the earlier
	// peer's renewal.
	if e.lastIssuedExpiry == 0 || e.lastIssuedExpiry <= now {
		e.firstIssuedExpiry = expiry
	}
	if expiry > e.lastIssuedExpiry {
		e.lastIssuedExpiry = expiry
	}
	a.tags[tag] = e
}

// issuedSegment reports the current continuous segment's FIRST and LATEST
// credential expiries, or (0, 0) for an unknown, retired or never-issued tag.
//
// Both in one call, deliberately. They are read together to decide renewal
// authority, and two separate calls could straddle a segment reset and pair a
// new anchor with an old latest — a combination that never existed.
//
// Caller holds PairRegistry.mu.
func (a *attribIndex) issuedSegment(tag string) (first, latest int64) {
	e, ok := a.tags[tag]
	if !ok {
		return 0, 0
	}
	return e.firstIssuedExpiry, e.lastIssuedExpiry
}

// ownerOf resolves a tag to the account it was minted for. Reports false for an
// unknown, retired or malformed tag — which the caller must treat as "cannot be
// contradicted", not as "forged".
//
// Caller holds PairRegistry.mu.
func (a *attribIndex) ownerOf(tag string, now int64) (string, bool) {
	if !validRelayAttribTag(tag) {
		return "", false
	}
	e, ok := a.tags[tag]
	if !ok || e.retireAfter <= now {
		return "", false
	}
	return e.owner, true
}

// sweep drops tags whose retention has run out, and records that this second
// has been scanned (see create's rate bound).
//
// Caller holds PairRegistry.mu.
func (a *attribIndex) sweep(now int64) {
	a.lastSweep = now
	a.sweeps++
	for tag, e := range a.tags {
		if e.retireAfter <= now {
			delete(a.tags, tag)
		}
	}
}
