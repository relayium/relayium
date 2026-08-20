package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/signal"
)

// Pair-room Stored Objects (code-first pairing, Phase 2).
//
// A pairing code used to be pure rendezvous: two peers met in room "c:<code>"
// and every byte went over the live link. Pre-upload adds a second thing a code
// can name — ciphertext the SENDER uploaded while the room was still waiting for
// someone to join — so that the wait, which was going to be idle anyway, is
// spent moving bytes.
//
// This file owns that object's whole lifecycle. It is a third StoredFile purpose
// alongside `share` and `device_task`, and like `device_task` it exists only to
// be delivered once, not to be a link the account manages. What makes it its own
// kind rather than a share with a short TTL is the deadline: a pair-room object
// is void the moment its room stops being joinable, and "joinable" is not a
// constant — it follows the upload.
//
// INVARIANTS. Each is asserted by a test in pairroom_test.go.
//
//  1. THE SERVER NEVER HOLDS A KEY. Nothing here reads, stores or forwards a
//     file key or a plaintext name. The room binds an OPAQUE ciphertext object
//     to a rendezvous; the key reaches the receiver over the peers' own
//     end-to-end DataChannel (docs/protocol/relayium-pair-room-v1.md). A room
//     row has no column that could hold one.
//  2. SAME MACHINERY. Placement, daily quota, storage cap, traffic cap,
//     max-file-size, expiry and GC are the share path's, byte for byte. Nothing
//     about a pair-room object is cheaper or free. The one deliberate exception
//     is retention, and only after a join: a share's plan retention cap is a
//     deadline, and invariant 5 says a joined transfer has none.
//  3. EVERY ACCEPTED BYTE IS BILLED. Traffic is metered per committed append
//     (uploads_resumable.go), so a cancelled, failed or never-joined upload is
//     billed for exactly what moved. The abuse argument for rule 4 depends on
//     this: weakening one weakens the other.
//  4. BOUNDED JOINABILITY, IN BOTH PLACES IT IS WRITTEN DOWN. The room stays
//     joinable while the upload is genuinely progressing, then for
//     pairRoomJoinWindow after the last accepted byte — and never past
//     pairRoomMaxJoinable from the moment it opened, whatever the client does.
//     That deadline lives in the database AND in the pairing code's own registry
//     entry (PairCodes, syncPairCode), because the code is what an upload's
//     owner check and a receiver's WebSocket actually resolve. Held in one place
//     only, the rule is unobservable: the ciphertext outlives the sole
//     credential that can reach it. Extension is owner-bound, forward-only and
//     never a resurrection, so it can neither steal nor revive somebody else's
//     six digits.
//  5. JOINING ENDS EVERY CLOCK. Once a second participant is in the room there
//     is NO deadline of any kind on the ciphertext — not a transfer deadline and
//     not a readability one. This is the owner's rule taken literally, which is
//     why it is expensive, and it leaves EXACTLY THREE ways a joined room's bytes
//     go — none of them a clock, and every one of them somebody acting:
//     · the RECEIVER completes it (pairroom_complete.go): it proves it holds the
//     file key, the object goes, and the room goes with it when that was the
//     last one;
//     · the OWNING ACCOUNT releases the whole room (pairroom_owner.go), by id,
//     once, having been shown what it is holding;
//     · the account is deleted (PurgeTransientUserData / ArchiveAndPurgeUser).
//     There is no fourth, and in particular no admin route that removes one and
//     no sweep that ages one out. Both of the first two are capabilities
//     somebody exercises rather than clocks — they add nothing that expires — so
//     this invariant is exactly what it always was. What is still open is what
//     becomes of a joined room whose owner never looks: pre-upload therefore
//     stays off unless a deployment turns it on (Service.SetPreUpload). See
//     invariant 8.
//  6. VOID MEANS GONE, NOW — AND GONE MEANS EVERYTHING THE ROOM HELD. Every
//     truth-bearing read or write of a pair-room object re-derives the room's
//     liveness and, if the room is over, closes it. The close is ONE database
//     transaction and it is authoritative: it settles and DELETES every upload
//     session bound to the room, whatever state it was in — open, terminally
//     claimed by a finalize that may never come back, or holding unresolved
//     accounting evidence — removes the object rows, and queues a durable delete
//     intent for every blob from both halves (ClosePairRoom). Slots, quota and
//     bindings are free when it commits, not when a node answers. Deleting the
//     bytes is the separate, bounded, best-effort half, and whatever it does not
//     finish GC finishes from the intents. The code goes with them
//     (revokePairCode). GC is a backstop for rooms nobody touches again, never
//     the thing that makes expiry true. The one thing that defers a void is an
//     observed-but-unwritten join (pairJoinQueue): a deadline that should
//     already have stopped is not a reason to delete a receiver's bytes.
//  7. THE RECEIVER STAYS ACCOUNT-FREE. A pair-room object is fetched through the
//     same unauthenticated /api/files/{id}/meta and /blob endpoints a share uses.
//     Holding the id (and the key the server never saw) is the whole capability.
//  8. OFF UNLESS TURNED ON. A deployment must opt in (Service.SetPreUpload)
//     before a single room can be created.
//     Both feature-specific exits from rule 5 are now BUILT AND WIRED: a sender
//     records a completion capability at finalize and the Web receiver spends it
//     (pairroom_complete.go), and the owning account can see every joined room it
//     is holding and release one (pairroom_owner.go). Production still stays OFF,
//     and the reasons are specific rather than caution:
//     · MOST RECEIVERS CANNOT COMPLETE AT ALL. A completion may only be spent
//       when the destination itself commits the bytes to disk — a File System
//       Access writable or a chosen directory. A Blob download, a bundled ZIP or
//       a service-worker stream hands the bytes to the BROWSER and the client
//       never learns whether they landed, so it must not speak for them. That
//       covers Firefox, Safari and every phone: they save perfectly and complete
//       nothing (docs/protocol/relayium-pair-room-v1.md §7.6). Those rooms end
//       when their owner releases them, or not at all.
//     · THE RESIDUAL LIFETIME IS AN OWNER DECISION AND IS STILL OPEN. What
//       happens to a joined room whose receiver never completes — declines,
//       closes the tab, never arrives at all — is unanswered, and
//       pairroom_owner.go is NOT that answer: it is a control the account
//       operates, so a room whose owner never looks is exactly where it was. It
//       is deliberately still unanswered here: a decline is not a completion, and
//       inventing a fallback expiry would be exactly the reinterpretation of rule
//       5 this file already refused once.
//     · THE ROLLOUT GATES ARE NOT CLOSED. Enabling this is a storage commitment
//       whose shape depends on both of the above.
//     So the gate is still not a feature flag for a half-built feature: every
//     half is finished on its own terms. It is the honest way to hold rule 5 as
//     written instead of quietly trading it for a number.

// StoredPurposePairRoom is ciphertext uploaded during a pairing code's wait, to
// be handed to whoever joins that code's room. Bound to one room for its whole
// life; void when the room is.
const StoredPurposePairRoom = "pair_room"

// PairCodes is the live pairing-code registry (signal.PairRegistry) as this
// lifecycle needs to see it.
//
// It exists because a room's deadline and its code's expiry are ONE deadline
// stored in two places: the room in the database, the code in the signaling
// layer's memory. The room's is the rule (pairRoomJoinDeadline); the code's is
// what an upload's ownership check and a receiver's WebSocket are actually
// resolved against. Left unsynchronized the room rule is unobservable — a
// ten-minute pre-upload pushes its row's deadline out chunk by chunk while its
// code dies five minutes after the mint, so nobody can join to collect the
// ciphertext it was uploading.
//
// An interface rather than the concrete registry so this package keeps stating
// what it needs (three questions about a code) rather than depending on how the
// signaling layer stores it — and so a test can watch every call.
type PairCodes interface {
	// OwnerOf resolves a LIVE code to the account that minted it.
	OwnerOf(code string) (string, bool)
	// ExtendFor pushes a live code's expiry out to `until`, for its minter only,
	// forward only, and never for a code that has already expired. The CEILING is
	// this package's: `until` is always a pairRoomJoinDeadline, which is already
	// bounded by pairRoomMaxJoinable from the moment the room opened.
	ExtendFor(code, owner string, until int64) bool
	// RevokeFor takes the code away, for its minter only, and only while it has
	// not been extended past `notAfter` — which would mean these digits have been
	// minted again since and now name somebody else's transfer.
	RevokeFor(code, owner string, notAfter int64) bool
}

// pairRoomJoinWindow is how long a room stays joinable after the last upload
// byte the server accepted for it — and, when nothing was uploaded at all, after
// the room was opened.
//
// It is signal.CodeTTLSeconds and must stay that: this IS the owner's rule
// ("after I upload, the other side has five minutes to join"), and the pairing
// code's own registry TTL is the same five minutes measured from mint. Two
// different numbers here would mean the code and its ciphertext died at
// different times, which is precisely the confusion B1 in the plan was about.
//
// Note what it is measured from. Not the mint, and not the upload's start: the
// LAST accepted byte. That single choice is both halves of the rule — while an
// upload keeps committing chunks the deadline keeps being pushed out (so a
// ten-minute upload does not kill its own code at T+5), and when the upload
// finishes the last chunk is the last extension, so the final five minutes start
// at completion exactly as promised.
var pairRoomJoinWindow = signal.CodeTTLSeconds

// pairRoomMaxJoinable is the absolute ceiling on how long a room may stay
// joinable, measured from the moment it opened.
//
// AUTONOMOUS DECISION, not an owner one, and recorded as such: the owner asked
// for a bound on a trickled upload ("define 'genuinely progressing' or the
// window is unbounded", B1) without naming a number. Six hours is that bound.
//
// pairRoomJoinWindow alone is an IDLE bound, and an idle bound is not a bound
// when the client picks the idle: committing one byte every four minutes renews
// it forever. This is the cap that makes "upload duration + 5 minutes" a number
// the server chooses rather than the attacker.
//
// Six hours is deliberately far above any real pre-upload. The largest object a
// plan allows, on an uplink slow enough to be worth pre-uploading at all, still
// lands inside it; a batch that cannot is not the flow this feature is for, and
// the sender can always send it over the live link instead. Making it tight
// enough to matter to an abuser would start cutting off honest slow uploads,
// which is the wrong trade for a resource whose real cost is one code out of
// 10^6 held by an account that is being billed for every byte it uploads.
const pairRoomMaxJoinable int64 = 6 * 3600

// pairRoomLegacyNoDeadline is what a joined room's expiry USED to be: none.
//
// An earlier version of this file read the owner's rule — "once a peer has
// joined, a long transfer is never cut off by that clock" — as "a joined room
// has no clock at all", and materialized that as math.MaxInt64 on the room and
// on every object inside it. It argued that a 24-hour storage backstop is a
// deadline whatever it is called, and it was right about that; what it missed is
// that the alternative is not "no rule" but "no bound", and an unbounded object
// is not something this product sells.
//
// That reading is retired by an explicit owner decision (2026-08-20): ALL stored
// ciphertext follows the account plan's retention, pair rooms included — Free
// 86400, Plus 259200, Pro 604800, Max 1209600. Production had four current-Free
// pair-room objects sitting at MaxInt64, days past the one day their account was
// entitled to, which is what the old reading cost in practice.
//
// What the owner's original rule bought is kept, but paid for differently: see
// pairRoomJoinedExpiry, where the deadline is measured from genuine accepted
// upload progress, so a transfer that is still moving bytes still cannot be cut
// off by the clock. The bound is on ABANDONMENT, which is the case the old rule
// never had an answer for.
//
// The constant survives its own rule for exactly one reason: it is the sentinel
// the one-time migration recognizes. A row still carrying this value was written
// under the old invariant, and is the only kind of row the backfill is permitted
// to move BACKWARDS (migratePairRoomRetention). Nothing derives a deadline from
// it any more.
const pairRoomLegacyNoDeadline int64 = math.MaxInt64

// pairRoomFreeRetention is the Free plan's retention window, and the value the
// lifecycle falls back to when a room's snapshot is missing or nonsensical — a
// row written before retention_secs existed, or one whose snapshot did not
// survive whatever wrote it. Conservative on purpose: a room that cannot prove
// it was entitled to more gets the floor every account is entitled to, and that
// floor is a real bound rather than "never".
const pairRoomFreeRetention int64 = 86400

// pairRoomMaxRetention is the ceiling any single room's snapshot may express:
// the longest retention any plan sells (Max, 14 days), which is also the
// server's RELAYIUM_FILE_TTL_MAX default. It bounds the SNAPSHOT rather than
// trusting whatever the plans table happens to hold, so an admin typo in
// retention_secs cannot reintroduce an effectively immortal object through the
// one path that has no client-supplied TTL to clamp.
const pairRoomMaxRetention int64 = 1209600

// pairRoomPurgeAfter is how long a CLOSED room row is kept before GC drops it.
// The ciphertext is already gone by then (closing deletes it); this is only the
// few dozen bytes of the row, kept briefly so a late request against a room that
// just ended can still be answered "this room is over" rather than "no such
// room" — the two are indistinguishable to the client, but a log line is not.
const pairRoomPurgeAfter int64 = 3600

// PairRoom is one pairing code's pre-upload lifecycle.
//
// Note what it does NOT contain: no key, no filename, no plaintext size, no
// receiver identity. It is a deadline and an owner, and that is the entire
// server-side view of a pre-uploaded transfer.
type PairRoom struct {
	// ID is the room INSTANCE. Codes are recycled — a six-digit code is free
	// again five minutes after it was minted — so nothing may be bound to the
	// code string itself. Objects reference this.
	ID string
	// Code is the six digits this room was opened for. Not unique over time,
	// and deliberately not a key: resolution is always "the newest live room
	// with this code", so a code reissued to somebody else opens a new room and
	// can never reach the previous one's ciphertext.
	Code string
	// UserID is the account that minted the code. It owns, and is billed for,
	// every object in the room. The receiver is anonymous and is never recorded.
	UserID string
	// CreatedAt is when the room opened (the first pre-upload for this code).
	CreatedAt int64
	// LastUploadAt is the last time the server committed upload bytes for this
	// room. 0 until the first chunk lands.
	LastUploadAt int64
	// JoinedAt is when a second participant entered the code's signaling room,
	// 0 while nobody has. Set from the signaling layer, never from a client
	// claim (see Service.MarkPairRoomJoined).
	JoinedAt int64
	// ClosedAt is when the room was voided or ended, 0 while it is open. A
	// closed room's ciphertext is already deleted.
	ClosedAt int64
	// ExpiresAt is the materialized deadline: exactly the value every object in
	// this room carries in stored_files.expires_at. Derived by pairRoomExpiry
	// and written by the same call that changes an input to it, so SQL never has
	// to re-derive the rule and the two can never disagree.
	ExpiresAt int64
	// RetentionSecs is the account plan's retention window, in seconds, SNAPSHOT
	// at the instant this room was created and never re-read for it again.
	//
	// A snapshot rather than a join back to the account, because the owner's rule
	// is that a plan change must not act retroactively: ciphertext stored under
	// Pro does not lose four days because the account downgraded to Plus an hour
	// later, and it does not gain seven because the account upgraded to Max. The
	// room is billed and bounded by what its owner was entitled to when it opened.
	//
	// 0 on rows written before this column existed. pairRoomRetention, not this
	// field, is what the lifecycle reads — it supplies the floor and the ceiling
	// so no caller has to remember either.
	RetentionSecs int64
}

// pairRoomJoinDeadline is the instant after which nobody may still join this
// room. Pure: the whole timing rule, in one expression, so the tests that pin
// invariants 4 and 5 do not need a database.
func pairRoomJoinDeadline(r PairRoom) int64 {
	deadline := max(r.CreatedAt, r.LastUploadAt) + pairRoomJoinWindow
	return min(deadline, r.CreatedAt+pairRoomMaxJoinable)
}

// pairRoomExpiry is the instant this room's ciphertext stops being readable —
// the value projected onto every one of its objects.
//
// Before anyone joins it is the join deadline, unchanged: nobody came, so there
// is nothing left to deliver and the bytes are void.
//
// After a join it is the room's own plan retention measured from the last thing
// that really happened to it (pairRoomJoinedExpiry), replacing the "no instant
// at all" this used to return. Pair-room ciphertext is stored ciphertext, and
// all stored ciphertext follows the account plan's retention.
func pairRoomExpiry(r PairRoom) int64 {
	if r.JoinedAt > 0 {
		return pairRoomJoinedExpiry(r)
	}
	return pairRoomJoinDeadline(r)
}

// pairRoomRetention is the room's snapshotted retention window, floored and
// capped — the whole rule in one inclusive clamp to [Free, Max].
//
// Both bounds live HERE, on the read, rather than only at the write, so that no
// row already in the database can express a window the product does not sell —
// whatever put it there. A pre-migration row (0), a snapshot taken from a plans
// row an admin has since edited, and a negative value from a corrupted write all
// land inside the same window every plan lives in, and every one of them is a
// row some future caller will read without knowing its provenance.
//
// The floor is Free rather than the row's own claim because a room that cannot
// prove an entitlement gets the entitlement every account has. That is why the
// floor applies to a POSITIVE snapshot below Free too, and not only to 0 or to a
// negative: an admin typo that writes 3600 into a plans row is exactly as
// unentitled to shorten a Free room's ciphertext to an hour as a corrupted write
// is, and the product sells four windows of which the shortest is a day. The
// clamp is inclusive at both ends, so every real plan value passes through it
// unchanged.
func pairRoomRetention(r PairRoom) int64 {
	return max(pairRoomFreeRetention, min(r.RetentionSecs, pairRoomMaxRetention))
}

// pairRoomJoinedExpiry is the deadline a JOINED room carries: its snapshotted
// retention, measured from the later of the join and the last committed byte.
//
// Both halves of that base are load-bearing:
//
//   - last_upload_at is how the owner's original rule survives the change. The
//     server moves it only when it has actually COMMITTED bytes for the room
//     (touchPairRoomOn), so it cannot be advanced by a client's claim, by a
//     reconnect, by a probe, or by a request that uploaded nothing. Genuine
//     progress therefore buys another full retention window every time it lands,
//     and an upload that is still running is still never cut off by this clock.
//     What IS now bounded is abandonment — the case the old rule answered with
//     "wait for an owner who may never look".
//   - joined_at is the floor for the room that has been joined but has no
//     committed bytes yet. Without it that room's base is 0 and its ciphertext
//     would be born expired in 1970.
//
// pairRoomJoinDeadline is a second floor, so that JOINING can never move a
// room's expiry BACKWARDS. It cannot today — every plan's retention is at least
// 86400 against a join deadline capped at MAX_JOINABLE, six hours — but the room
// row and its objects are projected atomically from this single number, and a
// monotonicity that holds only by arithmetic coincidence stops holding the first
// time somebody prices a plan below six hours. Cheap here, and it is the kind of
// thing nobody re-derives when they change a number in the plans table.
//
// It is never pairRoomLegacyNoDeadline and no input makes it so: the base is a
// real timestamp and pairRoomRetention is bounded above.
func pairRoomJoinedExpiry(r PairRoom) int64 {
	base := max(r.JoinedAt, r.LastUploadAt)
	return max(base+pairRoomRetention(r), pairRoomJoinDeadline(r))
}

// pairRoomCodeDeadline is the instant this room's pairing CODE may be kept alive
// until — the single answer every authoritative write hands back for
// syncPairCodeTo, and the only thing entitled to move a registry entry.
//
// It is pairRoomJoinDeadline while nobody has joined, and NOTHING once somebody
// has. The second half is invariant 5 read for what it costs rather than for what
// it grants: joining ends every clock, so there is no later instant a receiver
// may still arrive at, and a code extended past the join would hold six of a
// million digits out of circulation while buying nothing at all — the room it
// names is full and its two peers are already connected. 0 is "extend nothing",
// which syncPairCodeTo already treats as a no-op.
//
// Distinct from pairRoomExpiry, which answers the other question about the same
// joined room: its ciphertext still has a retention window to live out, while
// its code has no future at all. One is measured in days and the other is over,
// and collapsing them either strands the receiver or immortalizes the digits.
func pairRoomCodeDeadline(r PairRoom) int64 {
	if r.JoinedAt > 0 {
		return 0
	}
	return pairRoomJoinDeadline(r)
}

// pairRoomProgressExpiry is the deadline a room carries once the server has
// committed bytes for it at `at`. Pure, so the two callers that record progress
// (the append transaction and finalize) cannot derive it differently.
func pairRoomProgressExpiry(r PairRoom, at int64) int64 {
	if at > r.LastUploadAt {
		r.LastUploadAt = at
	}
	return pairRoomExpiry(r)
}

// pairRoomProgressJoinDeadline is the JOIN deadline a room carries once the
// server has committed bytes for it at `at` — the instant after which nobody may
// still join, which is exactly the instant the CODE is extended to.
//
// Its own function rather than an expression inlined at each site because the
// answer must be identical wherever it is produced: a client counting down a
// number derived even slightly differently from the one the registry holds is a
// client that announces a dead code while the receiver can still join, or the
// reverse.
//
// It is a PROJECTION — "where a room with this snapshot would land if progress
// were recorded at `at`" — so it belongs only to a caller whose snapshot cannot
// be wrong. Exactly ONE qualifies: syncPairCode, at the moment a room is created,
// where the room was built by this request an instant earlier and nothing else
// has seen it yet. Every other site reports what a row HOLDS
// (UploadProgressResult.RoomJoinDeadline, PairRoomTouch.CodeDeadline,
// StoredFileWrite.RoomJoinDeadline, persistedRoomJoinDeadline) rather than what
// this projects, for two reasons that are both ordinary rather than exotic:
// overlapping siblings move the row underneath a snapshot, and this function
// cannot see a JOIN at all — it happily projects a join deadline for a room
// somebody is already in, which is not a window that exists (pairRoomCodeDeadline).
//
// It is deliberately the join deadline and never pairRoomExpiry: a joined room's
// expiry is a retention window measured in DAYS (pairRoomJoinedExpiry), and a
// code extended to that would hold six of a million digits out of circulation
// for the length of a plan's retention while the room it names is already full.
func pairRoomProgressJoinDeadline(r PairRoom, at int64) int64 {
	if at > r.LastUploadAt {
		r.LastUploadAt = at
	}
	return pairRoomJoinDeadline(r)
}

// pairRoomJoinable reports whether a receiver may still join and be given the
// pre-uploaded batch.
func pairRoomJoinable(r PairRoom, now int64) bool {
	return r.ClosedAt == 0 && r.JoinedAt == 0 && now < pairRoomJoinDeadline(r)
}

// pairRoomLive reports whether the room's ciphertext is still readable. A joined
// room is live even though it is no longer joinable — that is the whole point of
// joining.
func pairRoomLive(r PairRoom, now int64) bool {
	return r.ClosedAt == 0 && now < pairRoomExpiry(r)
}

// syncPairCode makes the pairing code live exactly as long as the room it names.
//
// This is the other half of invariant 4, and without it the first half is
// unobservable. The room's deadline is in the database and follows the last
// accepted byte; the CODE's expiry is in the signaling layer's memory and, left
// alone, is CodeTTLSeconds from the mint and nothing else. Both an upload's
// ownership check (pairRoomForUpload → PairCodes.OwnerOf) and a receiver's
// WebSocket (signal.RoomFor → Validate) resolve the code, not the room — so a
// ten-minute pre-upload used to push its row's deadline out chunk by chunk while
// the only credential that could reach it had already died at T+5.
//
// Called at exactly ONE moment now: when the room opens, by the request that
// just created it. Never from a bare read, because a read moves nothing — and no
// longer from finalize either, which used to project a deadline off its own
// snapshot here and now syncs to the touch transaction's own answer instead
// (notePairRoomUpload, PairRoomTouch). A room this caller did not itself create
// one statement ago has no business being projected from.
//
// It targets the JOIN deadline, never pairRoomExpiry. For an unjoined room they
// are the same number. For a joined one the room's expiry is its plan retention
// window (pairRoomJoinedExpiry) and a code extended to that would hold six of a
// million digits out of circulation for days — while buying nothing, since the
// room it names is full and the peers are already connected.
//
// The ceiling comes for free: pairRoomJoinDeadline is already bounded by
// pairRoomMaxJoinable from the moment the room opened, so a trickled upload
// cannot buy its code more time than the room itself has.
//
// A refusal is not an error here, and is deliberately not propagated. It means
// the registry no longer has that code for this owner — reaped, or reissued to
// somebody else — and neither is a reason to fail an upload whose ROOM is
// demonstrably alive: the room's own deadline is what governs the ciphertext,
// and the registry's refusal is precisely what stops this from resurrecting
// digits that now belong to a stranger.
func (s *Service) syncPairCode(room PairRoom, at int64) {
	s.syncPairCodeTo(room, pairRoomProgressJoinDeadline(room, at))
}

// syncPairCodeTo is the same thing for a caller that has been HANDED the room's
// code deadline instead of deriving it — every path that writes through a store
// transaction, each reporting what its own row actually held
// (UploadProgressResult.RoomJoinDeadline for an append,
// PairRoomTouch.CodeDeadline for finalize's touch,
// StoredFileWrite.RoomJoinDeadline for the object it then inserts).
//
// The two are the same call with different sources for one number, and this is
// the one to reach for unless the caller CREATED the room a statement ago. A
// snapshot goes stale where requests overlap, and it is blind to a join
// (pairRoomCodeDeadline) whether or not anything overlaps.
//
// A non-positive deadline is nothing to sync — the room is gone, there is no
// room, or somebody has joined it and there is no window left to name — and
// moving the code on the strength of it would be inventing one.
func (s *Service) syncPairCodeTo(room PairRoom, until int64) {
	if s.pairCodes == nil || room.Code == "" || until <= 0 {
		return
	}
	s.pairCodes.ExtendFor(room.Code, room.UserID, until)
}

// revokePairCode ends the code a voided room was opened for, at the moment the
// room's ciphertext goes.
//
// THE RULE: a room that is void takes its code with it. Not "the code expires
// too" — it is removed. The two clocks agree today (syncPairCode keeps the code's
// expiry at the room's join deadline, so a room can only be voided once its code
// has expired as well), and this is what stops that agreement from being the
// thing the property rests on. A code that still validated after its room was
// voided would admit a receiver into a rendezvous whose ciphertext has already
// been deleted — six digits describing a transfer that does not exist, which is
// exactly what "void means gone, now" says must not happen.
//
// It also returns the digits to circulation immediately rather than at the next
// reap, which matters more as the code space is only 10^6.
//
// Bounded by identity, like every other operation here: only the room's OWNER,
// and only while the entry has not been extended past this room's own join
// deadline — a later expiry means those digits were minted again after this room
// was already over, and belong to a different transfer now. A void can run long
// after the deadline that caused it (GC's sweep is ten minutes behind), so that
// case is real, not theoretical.
func (s *Service) revokePairCode(room PairRoom) {
	if s.pairCodes == nil || room.Code == "" {
		return
	}
	s.pairCodes.RevokeFor(room.Code, room.UserID, pairRoomJoinDeadline(room))
}

// errPairRoom is a refusal the upload routes turn into an HTTP status. Kept as
// values rather than free-form strings so the two upload paths cannot describe
// the same refusal differently.
type pairRoomError struct {
	msg    string
	status int
}

func (e pairRoomError) Error() string { return e.msg }

var (
	// errPairRoomCode: no live pairing code, or one this account does not own.
	// Deliberately one error for both: telling an unauthenticated guesser apart
	// from an authenticated one would make this endpoint a code-validity oracle
	// with no rate limit of its own.
	errPairRoomCode = pairRoomError{"unknown or expired pairing code", 403}
	// errPairRoomJoined: the peer is already here. Pre-upload is for the wait;
	// once someone has joined, anything new goes over the live link (never split
	// one file across the two transports).
	errPairRoomJoined = pairRoomError{"someone already joined this pairing code — send over the live link", 409}
	// errPairRoomOver: the room's deadline passed. Its ciphertext is gone.
	errPairRoomOver = pairRoomError{"this pairing code's transfer expired", 410}
	// errPairRoomUnavailable: pre-upload is not wired or not enabled on this
	// deployment. Never silently treated as "code invalid".
	errPairRoomUnavailable = pairRoomError{"pre-upload is unavailable", 503}
	// The three admission refusals. A room is durable lifecycle state and an
	// account that is ALREADY over one of its limits must not create one — the
	// owner's B3 rule, applied at the only place the server can apply it. Their
	// wording and status match the ordinary upload gates so a client does not
	// have to learn a second vocabulary for the same refusal.
	errPairRoomStorageFull  = pairRoomError{"storage limit reached — free up space or upgrade", 413}
	errPairRoomTrafficSpent = pairRoomError{"monthly traffic limit reached — upgrade to continue", 429}
	errPairRoomQuotaSpent   = pairRoomError{"daily quota exceeded", 429}
)

// pairRoomAdmission refuses to OPEN a room for an account already over one of
// its limits. B3, at the server: "block before entering the room when the
// account is over quota".
//
// Zero additional bytes on purpose. This is not "will this upload fit" — the
// init and finalize gates answer that, with the real size — it is "is this
// account over its limits right now", which is the only question that can be
// asked before a single byte has been described honestly.
//
// FAILS OPEN, deliberately and unlike the upload gates that follow it: a quota
// read that errors admits the room. The owner named that behaviour for this
// decision specifically ("it must fail open like turn.go already does"), and it
// costs nothing, because every byte that then arrives passes the authoritative
// gates anyway. The failure mode of failing closed here is the opposite and
// worse: one database hiccup and nobody can start a transfer at all.
func (s *Service) pairRoomAdmission(ctx context.Context, userID string) error {
	if over, err := s.overStorage(ctx, userID, 0); err == nil && over {
		return errPairRoomStorageFull
	}
	if spent, err := s.trafficAllowanceSpent(ctx, userID); err == nil && spent {
		return errPairRoomTrafficSpent
	}
	if remaining, err := s.remainingDailyQuota(ctx, userID); err == nil && remaining <= 0 {
		return errPairRoomQuotaSpent
	}
	return nil
}

// pairRoomRetentionFor snapshots the account plan's retention window for a room
// that is about to be created. Read ONCE, written onto the room, and never
// re-read for that room again — see PairRoom.RetentionSecs for why a plan change
// must not reach backwards into ciphertext already stored.
//
// A plan-read failure falls back to the LONGEST retention any plan sells rather
// than to Free. planRetentionCap's fail-open reasoning applies here unchanged: a
// transient read error must not silently clamp a paying account's ciphertext to
// the free window, where it would disappear a day later with no signal. What is
// different is where "open" stops. planRetentionCap can return 0 for "no cap"
// because its callers are clamping a TTL the client supplied, which the global
// clampTTL bounds anyway; this path has no client TTL and no other clamp behind
// it, so an uncapped answer here is precisely the unbounded object this change
// exists to remove. The longest bounded window is therefore the fail-open value.
//
// The asymmetry is deliberate and worth stating: the cost of being wrong upward
// is at most thirteen extra days of storage for one room whose plan read failed;
// the cost of being wrong downward is a paying customer's transfer deleted
// thirteen days early.
//
// A SUCCESSFUL read is clamped to the same [Free, Max] window pairRoomRetention
// enforces, floor included. planRetentionCap returns whatever the plans table
// holds, and a plans row an admin has typoed to something below the Free day
// would otherwise be snapshotted verbatim and delete that room's ciphertext
// early — the one failure this path can cause that no later read can undo,
// because the snapshot is taken once and never re-read.
func (s *Service) pairRoomRetentionFor(ctx context.Context, userID string) int64 {
	secs := s.planRetentionCap(ctx, userID)
	if secs <= 0 {
		return pairRoomMaxRetention
	}
	return max(pairRoomFreeRetention, min(secs, pairRoomMaxRetention))
}

// pairRoomForUpload resolves — creating it if this is the first pre-upload — the
// room that an upload presenting `code` binds to.
//
// The ownership check is the load-bearing line: pairCodeOwner is the live
// signaling registry, so an account can only pre-upload into a code IT minted.
// Without it, any signed-in account could push ciphertext into a stranger's room
// and have the stranger's receiver download it.
func (s *Service) pairRoomForUpload(ctx context.Context, userID, code string) (PairRoom, error) {
	// pairCodes as well as the lookup: a deployment with the room lifecycle but
	// no way to move a code's expiry would hand out rooms whose codes keep dying
	// at five minutes, which is a half-built feature presented as a working one.
	// Refusing is the same 503 an unwired deployment already gets.
	if !s.preUpload || s.pairCodeOwner == nil || s.pairCodes == nil {
		return PairRoom{}, errPairRoomUnavailable
	}
	if !signal.ValidCodeFormat(code) {
		return PairRoom{}, errPairRoomCode
	}
	owner, ok := s.pairCodeOwner(code)
	if !ok || owner != userID {
		return PairRoom{}, errPairRoomCode
	}
	// At most two passes. The second exists for exactly one situation: another
	// request for the same code created the room between this one's lookup and
	// its insert. The insert is REFUSED by the partial unique index in that case
	// rather than quietly making a second open room, so losing the race is a
	// re-resolve, not a stranded file. Two files uploaded concurrently as the
	// first two of a batch is the ordinary way to reach it, not an attack.
	for attempt := 0; attempt < 2; attempt++ {
		now := s.now().Unix()
		room, found, err := s.store.LivePairRoomByCode(ctx, code)
		if err != nil {
			return PairRoom{}, err
		}
		// A room kept alive only by a join nobody has managed to write down still
		// occupies its code's one-open-room slot, and everything below would read it
		// as an unjoined room. Land the join first: a JOINED room leaves the slot
		// (the unique index excludes it), so this is also what stops a database blip
		// during one transfer's join from burning those six digits for the next
		// person issued them.
		if found && s.flushHeldJoin(ctx, room) {
			if room, found, err = s.store.LivePairRoomByCode(ctx, code); err != nil {
				return PairRoom{}, err
			}
		}
		if found && room.UserID == userID {
			if s.endPairRoomIfOver(ctx, room) {
				return PairRoom{}, errPairRoomOver
			}
			if !pairRoomJoinable(room, now) {
				return PairRoom{}, errPairRoomJoined
			}
			return room, nil
		}
		if found {
			// An open row for these digits belonging to a PREVIOUS holder. If it is
			// past its own deadline its ciphertext is void either way, and voiding it
			// now also stops it occupying the one-open-room-per-code slot this account
			// needs. (A previous holder's room that is still live is a JOINED room,
			// which the index does not count — a live transfer is never collateral
			// here.)
			s.endPairRoomIfOver(ctx, room)
		}
		if aerr := s.pairRoomAdmission(ctx, userID); aerr != nil {
			return PairRoom{}, aerr
		}
		candidate := PairRoom{ID: authx.NewID(), Code: code, UserID: userID, CreatedAt: now}
		candidate.RetentionSecs = s.pairRoomRetentionFor(ctx, userID)
		candidate.ExpiresAt = pairRoomExpiry(candidate)
		got, created, err := s.store.CreatePairRoomIfAbsent(ctx, candidate)
		if err != nil {
			return PairRoom{}, err
		}
		if created {
			// The room's first deadline is 300s from NOW, and the code's is 300s from
			// the MINT — which was however long the sender spent picking files ago. The
			// room is the rule, so the code follows it from the very first moment,
			// rather than starting its life already the shorter of the two.
			s.syncPairCode(got, now)
			return got, nil
		}
		if got.UserID == userID && pairRoomJoinable(got, now) {
			return got, nil // lost the race to a sibling upload of the same batch
		}
	}
	return PairRoom{}, errPairRoomCode
}

// pairRoomStillOpen re-reads the room an in-flight upload is bound to and
// refuses the write if it is over, voiding it on the way out.
//
// Called on every append and at finalize, not only at init: an upload that
// started inside the window can run past the deadline, and continuing to accept
// bytes for ciphertext nobody will ever be able to read is exactly the "billed
// for nothing" case the immediate-void rule exists to prevent.
func (s *Service) pairRoomStillOpen(ctx context.Context, roomID string) (PairRoom, error) {
	room, found, err := s.store.GetPairRoom(ctx, roomID)
	if err != nil {
		return PairRoom{}, err
	}
	if !found {
		return PairRoom{}, errPairRoomOver
	}
	if s.endPairRoomIfOver(ctx, room) {
		return PairRoom{}, errPairRoomOver
	}
	return room, nil
}

// notePairRoomUpload records that the server just committed bytes for this room:
// the deadline moves to `at + pairRoomJoinWindow` (bounded by the ceiling), on
// the room row and on every object already in it.
//
// This is what keeps an earlier file in the batch alive while a later one is
// still uploading — without it, a three-file batch would silently lose file one
// while file three was still going up. So its failure is NOT ignorable: a
// dropped deadline move expires ciphertext the client is still paying to send.
// Retried, and returned to a caller that turns it into a visible failure.
//
// The append path does not come through here — it records progress inside the
// same transaction that advances the offset (Store.CommitUploadProgress), which
// is stronger. This is finalize's path, where the deadline move is the only
// write left.
//
// It is ALWAYS called, even when `at` is not newer than the progress the room
// already has, and that is not a wasted write: TouchPairRoomUpload's real job
// here is the precondition. Finalize's own liveness check is a separate
// statement, so skipping this when the deadline needs no moving — which is the
// common case, since the last chunk usually lands in the same second — left the
// window where a room ends between the two with nothing at all to notice. A
// deadline move that is merely redundant succeeds silently; a room that is over
// comes back as ErrPairRoomClosed.
//
// THE CODE IS SYNCED TO THE TRANSACTION'S OWN ANSWER, never to a projection off
// `room`. That distinction is the whole reason TouchPairRoomUpload returns
// anything (PairRoomTouch). `room` is a snapshot this caller read in an earlier
// statement, and pairRoomProgressJoinDeadline — the projection that used to
// stand here — answers "where would a room with this snapshot land", which is a
// different question from "where is this room" in two reachable ways. A sibling
// append can move the row after the snapshot was taken; and a room somebody has
// JOINED has no join deadline at all, while the projection computes one anyway
// from created/last_upload and buys the registry another window of six digits
// for a rendezvous that is already full.
//
// Note what changed under the retention rule and what did not. The touch's write
// is no longer a no-op for a joined room — genuine progress now legitimately
// pushes its RETENTION deadline out (pairRoomJoinedExpiry), where it used to
// match nothing against an immortal expires_at. So the argument no longer rests
// on "the database write never happened"; it rests on the only thing it should
// ever have rested on, which is that the transaction's own answer for the CODE
// is 0 for a joined room (pairRoomCodeDeadline) whatever its storage deadline
// did. The projection would still invent a window here; the row still refuses
// to.
//
// THE HANDOFF IS STILL TWO STEPS, and no distributed transaction closes it. The
// room lives in the database and the code lives in the signaling layer's memory;
// the extension therefore happens AFTER the commit, deliberately, so a credential
// can never claim a window the room does not hold. What can still be lost is the
// other order: the transaction commits and the process dies before the registry
// is moved, leaving a code SHORTER than its room. That failure is the safe one
// (the ciphertext outlives the credential rather than the reverse, and the code
// is in that same process's memory, so it dies with it), and it is bounded by the
// same fact invariant 4 already rests on — the registry is per-process, so
// "the code" and "the process that could have extended it" are the same thing.
func (s *Service) notePairRoomUpload(ctx context.Context, room PairRoom, at int64) error {
	var touch PairRoomTouch
	if err := retryStore(func() error {
		var terr error
		touch, terr = s.store.TouchPairRoomUpload(ctx, room.ID, at, pairRoomProgressExpiry(room, at))
		return terr
	}); err != nil {
		return err
	}
	// The last chunk is the last extension, and this is where the promised final
	// five minutes begin — for the ciphertext AND for the code that reaches it.
	// After the database, never before: the code may not claim a deadline the
	// room does not have.
	s.syncPairCodeTo(room, touch.CodeDeadline)
	return nil
}

// MarkPairRoomJoined is the signaling layer telling the account layer that a
// second participant entered a pairing code's room.
//
// It is deliberately driven from the SERVER's own observation of the room's
// membership rather than from anything a client says. A client-asserted "they
// joined" would be a free jump from a five-minute deadline to no deadline at
// all, which would make the product's one visible promise about pre-upload
// untrue at the request of the party it constrains.
//
// A code with no pre-upload has no room row and this is a no-op — the
// overwhelmingly common case, and why it must be cheap and must never fail a
// join.
//
// It RETURNS its error, and a failed write is QUEUED (pairJoins), not merely
// logged. A dropped join is not a cosmetic loss: the room keeps the five-minute
// deadline it should have just shed, so ciphertext the receiver is at that
// moment fetching expires underneath them. Nothing can conjure the event back —
// its only witness is a live websocket — so the observation is held in memory
// until it lands, and while it is held the room is not voided on a deadline
// that should already have stopped. The live join itself is never rejected: the
// caller logs and carries on, and RetryPairRoomJoins finishes the job.
func (s *Service) MarkPairRoomJoined(ctx context.Context, code string) error {
	return s.markPairRoomJoined(ctx, observedJoin{code: code, observedAt: s.now().Unix()})
}

// markPairRoomJoined is MarkPairRoomJoined with the observation passed in, so a
// retry judges the deadline by when the receiver actually arrived rather than by
// when the database finally came back. A retry that used "now" would reject a
// join that was in time and then void the very ciphertext it was queued to save.
func (s *Service) markPairRoomJoined(ctx context.Context, j observedJoin) error {
	if s.store == nil || !signal.ValidCodeFormat(j.code) {
		return nil
	}
	room, found, err := s.resolveJoinedRoom(ctx, j)
	if err != nil {
		s.pairJoins.hold(j)
		return fmt.Errorf("resolving the joined code: %w", err)
	}
	if !found {
		s.pairJoins.release(j.code) // no room to move: nothing left to retry
		return nil
	}
	if room.JoinedAt > 0 || room.ClosedAt != 0 {
		s.pairJoins.release(j.code)
		return nil // already paired: the deadline is long gone, nothing to move
	}
	if !pairRoomJoinable(room, j.observedAt) {
		// Somebody arrived after the deadline. The ciphertext is void and goes
		// now rather than at the next sweep; the live link still works, so the
		// transfer is not lost, only its head start.
		s.pairJoins.release(j.code)
		s.voidPairRoom(ctx, room)
		return nil
	}
	joined := room
	joined.JoinedAt = j.observedAt
	if rerr := retryStore(func() error {
		return s.store.JoinPairRoom(ctx, room.ID, j.observedAt, pairRoomExpiry(joined))
	}); rerr != nil {
		j.roomID = room.ID // now known: a retry must not resolve the digits afresh
		s.pairJoins.hold(j)
		return fmt.Errorf("persisting the join to pair room %s: %w", room.ID, rerr)
	}
	s.pairJoins.release(j.code)
	return nil
}

// resolveJoinedRoom finds the room an observation belongs to.
//
// By id whenever the id is known, because six digits are reused minutes after
// they are minted and a queued retry that re-resolved them could stamp the next
// holder's room as joined — handing a stranger's ciphertext the unbounded
// storage window that joining grants. When only the digits are known, a room
// opened AFTER the join was observed is rejected for the same reason: it cannot
// be the room somebody joined.
func (s *Service) resolveJoinedRoom(ctx context.Context, j observedJoin) (PairRoom, bool, error) {
	var room PairRoom
	var found bool
	err := retryStore(func() error {
		var e error
		if j.roomID != "" {
			room, found, e = s.store.GetPairRoom(ctx, j.roomID)
			return e
		}
		room, found, e = s.store.LivePairRoomByCode(ctx, j.code)
		return e
	})
	if err != nil || !found {
		return room, false, err
	}
	if j.roomID == "" && room.CreatedAt > j.observedAt {
		log.Printf("pair room: code %s was reissued before its observed join could be recorded; the original room keeps the join deadline", j.code)
		return PairRoom{}, false, nil
	}
	return room, true, nil
}

// flushHeldJoin writes an observed-but-unwritten join for THIS room right now,
// rather than waiting for the retry ticker. Reports whether it tried, so the
// caller can re-read what it changed.
//
// The caller that needs this is the one resolving a code for a new pre-upload:
// a held room is indistinguishable from an unjoined one in the database, and it
// holds the one-open-room-per-code slot until its join lands.
func (s *Service) flushHeldJoin(ctx context.Context, room PairRoom) bool {
	if !s.pairJoins.heldFor(room) {
		return false
	}
	j, ok := s.pairJoins.pending(room.Code)
	if !ok {
		return false
	}
	j.roomID = room.ID
	if err := s.markPairRoomJoined(ctx, j); err != nil {
		log.Printf("pair room %s: landing its queued join before reusing code %s: %v", room.ID, room.Code, err)
	}
	return true
}

// RetryPairRoomJoins re-attempts every join the server observed but could not
// write down. Wired to a short ticker (see RunPairJoinRetries).
//
// The ticker is short because a held join costs something every second it is
// held — the room keeps its one-open-room-per-code slot, so the sender cannot
// reuse those digits — not because the observation goes stale. It does not: an
// entry is kept until a terminal answer releases it, and while it is held the
// room is not voided on the deadline it should already have shed
// (pendingJoins, endPairRoomIfOver). Landing late is landing.
func (s *Service) RetryPairRoomJoins(ctx context.Context) {
	for _, j := range s.pairJoins.pendingJoins() {
		if err := s.markPairRoomJoined(ctx, j); err != nil {
			log.Printf("pair room: retrying the join of code %s: %v", j.code, err)
		}
	}
}

// RunPairJoinRetries drains the observed-join queue on a ticker until ctx ends.
func (s *Service) RunPairJoinRetries(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.RetryPairRoomJoins(ctx)
		}
	}
}

// pairJoinQueue holds joins the server SAW and has not managed to persist.
//
// It is memory, not a table, and that is not a compromise: the write that
// failed is the database write, so a durable queue would need the thing that is
// broken. What it has to survive is a database outage, and it does. What it
// cannot survive is this process dying — but the join's only witness is a
// websocket that dies with it, so there is nothing left to replay either way.
//
// Its second job matters as much as the retry: while a code is held, the room
// it names is NOT voided (endPairRoomIfOver). The deadline on disk is a clock
// that should already have stopped, and deleting ciphertext on the strength of
// it would destroy exactly the transfer the queue exists to protect.
type pairJoinQueue struct {
	mu     sync.Mutex
	queued map[string]observedJoin // code -> the observation still to be written
}

// observedJoin is one join the server saw. Keyed by code because that is all the
// signaling layer knows, but it carries the ROOM wherever the room was resolved
// before the write failed — six digits are recycled minutes after they are
// minted, and a retry that resolved the digits afresh could otherwise stamp a
// stranger's room as joined and hand it an unbounded storage window.
type observedJoin struct {
	code       string
	observedAt int64
	// roomID is "" only when the failure was the lookup itself, so nothing knows
	// which room these digits meant at that instant.
	roomID string
}

func (q *pairJoinQueue) hold(j observedJoin) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.queued == nil {
		q.queued = map[string]observedJoin{}
	}
	if prev, ok := q.queued[j.code]; ok {
		// Keep the EARLIEST observation — that is when the receiver arrived — but
		// take a room id if this attempt learned one and the earlier one had none.
		if prev.roomID == "" {
			prev.roomID = j.roomID
		}
		if prev.observedAt <= j.observedAt {
			q.queued[j.code] = prev
			return
		}
		j.roomID = prev.roomID
	}
	q.queued[j.code] = j
}

func (q *pairJoinQueue) release(code string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.queued, code)
}

// heldFor reports whether an unwritten join is holding THIS room open.
//
// The room, not merely the digits: a code reissued after the observation names a
// different transfer, and protecting it would extend a stranger's ciphertext on
// the strength of somebody else's join. When the room could not be identified at
// all, the fallback is the only sound one available — a room opened after the
// join was seen cannot be the room that was joined.
func (q *pairJoinQueue) heldFor(r PairRoom) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	j, ok := q.queued[r.Code]
	if !ok {
		return false
	}
	if j.roomID != "" {
		return j.roomID == r.ID
	}
	return r.CreatedAt <= j.observedAt
}

// held reports whether these digits have an unwritten join at all. Test-only:
// production asks heldFor, which is about a ROOM, because that is the question
// a recycled code makes different.
func (q *pairJoinQueue) held(code string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	_, ok := q.queued[code]
	return ok
}

// pending returns the queued observation for these digits, if any.
func (q *pairJoinQueue) pending(code string) (observedJoin, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	j, ok := q.queued[code]
	return j, ok
}

// pendingJoins snapshots the queue.
//
// It has NO time bound, and that is the point. Every clock this feature has is
// a clock on joining, and an entry in here is the server's own proof that
// somebody joined — judged timely at observedAt, by pairRoomJoinable, before it
// was ever queued. Time passing afterwards changes nothing about that
// judgement: it is the database that is late, not the receiver. An earlier
// version dropped observations older than pairRoomMaxJoinable on the argument
// that they "could not have been timely anyway", which is simply false, and its
// effect was to hand the room back the five-minute deadline the join had
// already ended — so the next sweep deleted a receiver's ciphertext on a clock
// that stopped hours before. Joining ends every clock (invariant 5); an
// unwritten join may not quietly restart one.
//
// What makes holding an entry indefinitely SAFE is not time but identity: a
// retry resolves the room by id when the id is known, and otherwise refuses a
// room opened after the observation (resolveJoinedRoom), so a recycled code can
// never inherit somebody else's join. And an entry is not immortal in practice
// — every terminal answer releases it (the room is gone, already joined, or the
// join lands), so the queue drains as soon as the database can answer at all.
// Its size is bounded by the number of distinct codes whose join failed to
// persist during one outage.
func (q *pairJoinQueue) pendingJoins() []observedJoin {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]observedJoin, 0, len(q.queued))
	for _, j := range q.queued {
		out = append(out, j)
	}
	return out
}

// retryStore runs a store write that must not be lost, retrying a busy or
// briefly-unavailable database before giving up.
//
// It exists for the two pair-room writes whose loss is silent and expensive (the
// deadline move and the join stamp) — everything else on these paths either
// fails a request the client can retry or is genuinely best-effort. Deliberately
// tiny: three tries a few milliseconds apart covers a lock contended by another
// writer, which is the failure this actually sees, and covers nothing else.
//
// ErrPairRoomClosed is returned immediately: it is a precondition that failed,
// not a database that was busy, and no amount of retrying makes a closed room
// open again.
func retryStore(fn func() error) error {
	var err error
	for i := 0; i < storeRetryAttempts; i++ {
		if err = fn(); err == nil || errors.Is(err, ErrPairRoomClosed) {
			return err
		}
		if i+1 < storeRetryAttempts {
			time.Sleep(storeRetryDelay)
		}
	}
	return err
}

const storeRetryAttempts = 3

// storeRetryDelay is a var only so tests that inject a permanently failing store
// do not pay the backoff; production never reassigns it.
var storeRetryDelay = 20 * time.Millisecond

// endPairRoomIfOver is the ONE place a room's on-disk deadline is turned into a
// deletion. It reports whether the room is over, voiding it if so.
//
// The extra clause is the pending-join hold. A room whose join the server SAW
// but has not been able to write down still carries the five-minute deadline it
// should have shed at that instant, and every void path would read that
// deadline and delete ciphertext the receiver is entitled to. The observation is
// the truth; the row is stale. So while the join is queued (pairJoinQueue) the
// room survives, and the retry that lands stops the clock properly.
func (s *Service) endPairRoomIfOver(ctx context.Context, room PairRoom) bool {
	if pairRoomLive(room, s.now().Unix()) {
		return false
	}
	if s.pairJoins.heldFor(room) {
		return false
	}
	s.voidPairRoom(ctx, room)
	return true
}

// endPairRoomByID re-reads the room a STORE precondition just refused and ends
// it if it really is over, reporting whether the caller should refuse too.
//
// The re-read is the point: the caller's copy of the room was fetched before
// the write it was refused for, so it may still look live. Only a caller whose
// transaction has ALREADY refused the write asks this, so the default answer is
// "over" — including when the row cannot be read, where refusing is the
// fail-closed choice and deleting nothing is the safe one. The single thing
// that overturns it is a confirmed pending join (endPairRoomIfOver), because
// there the deadline on disk is the stale value and the observation is the
// truth.
func (s *Service) endPairRoomByID(ctx context.Context, id string) bool {
	room, found, err := s.store.GetPairRoom(ctx, id)
	if err != nil || !found {
		return true
	}
	return s.endPairRoomIfOver(ctx, room)
}

// pairRoomBlobHold is how long a room's void keeps its delete intents on the
// books after the delete itself has succeeded — the answer to the one race
// deleting a blob cannot win on its own.
//
// The race: the close removes the upload session's row, so no NEW append can
// ever be authorised for that blob (handleUploadChunk resolves the session
// first and 404s). But an append that read the row a moment earlier is still
// streaming its body to the node, and it lands AFTER the delete — re-creating
// the key with up to one chunk's worth of bytes (maxAppendBytes), or with an
// empty file when its offset no longer matches. Nothing central holds points at
// that key any more: no session, no stored_files row, nothing a generic sweep
// could find. Retiring the intent on the first successful delete would hand
// those bytes no owner at all.
//
// So the intent outlives the delete. Every sweep in the window asks the node
// again — which is what actually removes a re-created blob, usually within one
// GC tick — and only a success taken at or after the hold retires the row. The
// cost is a handful of extra idempotent DELETEs per voided blob, spread over the
// window; the thing it buys is that the responsibility survives the process
// dying between the append and the cleanup that answers it.
//
// WHAT MAKES THE WINDOW LONG ENOUGH. Not this constant on its own — an hour is
// only a bound if "an append that is still streaming" has one, and it did not:
// the server sets no ReadTimeout, DiskStore.Append ignored its context, and a
// merely slow client never cancels the request context. The bound is
// maxAppendLifetime + appendSettlementSlack, roughly ten and a half minutes,
// enforced on every PATCH by a connection read deadline and two context
// deadlines. That is the number this hold has to exceed, and
// TestAnAppendCannotOutliveTheHoldOnItsBlob is what keeps it exceeding it.
//
// pendingUploadTTL is the length because it is the same bound, arrived at from
// the same side: an hour is already this server's answer to "how long may one
// upload be in flight before we stop believing in it". An append still writing
// after that has had its session declared abandoned by every other pass here —
// and, now, cannot exist at all.
//
// A CRASH is covered by the row rather than by the clock. If the process dies
// mid-append the intent is already committed (ClosePairRoom wrote it before the
// blob was touched), no surviving request can append to that blob — its session
// row went in the same transaction — and GC keeps asking the node for the whole
// window. Restarting does not restart the append.
const pairRoomBlobHold = pendingUploadTTL

// pairRoomCloseBudget bounds the DATABASE phase of a void. It is generous
// because nothing in that phase talks to a node — it exists so a wedged database
// cannot pin a request goroutine, not to make the close optional.
const pairRoomCloseBudget = 10 * time.Second

// pairRoomReclaimBudget bounds the PHYSICAL phase: probing blobs for their real
// size and deleting them. Everything in this phase is best-effort by
// construction, so running out is a loss of billing accuracy on the residual,
// never a loss of ciphertext or of a row.
//
// A var only so a test can shrink it to reach the exhausted-budget path without
// stalling for ten seconds; production never reassigns it.
var pairRoomReclaimBudget = 10 * time.Second

// voidPairRoom ends a room and deletes every byte of ciphertext it holds, right
// now.
//
// TWO PHASES, and the split is the whole design. The FIRST is authoritative and
// touches nothing but the database: the room closes, every session's meter is
// settled and its row deleted, every object row deleted, and every blob — from
// both halves — gets a durable delete intent (ClosePairRoom). When it commits,
// the room holds no row, no session slot and no storage quota anywhere, and
// every byte it was responsible for has an owner that survives this process.
//
// The SECOND is physical, bounded and best-effort: ask each blob how big it
// really is (so the last bytes can be billed), then delete it. A node that is
// slow, unreachable or hostile can only cost this phase, and this phase can only
// make the outcome more accurate — the intents queued in phase one are what GC
// retries when it does not finish.
//
// That ordering is what an earlier version got backwards. It reclaimed one
// artifact at a time under a single ten-second budget, doing node I/O between
// each authoritative write, so a fan-out of unreachable nodes left real session
// rows, real open-session slots and real ciphertext alive until the generic
// one-hour reaper — twelve times the window the room exists to enforce.
//
// Callers that are acting on an EXPIRY go through endPairRoomIfOver, which is
// where the pending-join hold is honoured. This is the unconditional form, for
// callers that already know the room is over for a reason no clock can be wrong
// about.
func (s *Service) voidPairRoom(ctx context.Context, room PairRoom) error {
	// The code goes FIRST, before anything that can fail. Reclaiming ciphertext
	// is best-effort — a node may be unreachable — but "nobody else may join this
	// rendezvous" must not be. Doing it here means a store that refuses the close
	// still leaves a room nobody new can walk into.
	s.revokePairCode(room)
	now := s.now().Unix()
	// Detached: the usual caller is a request being answered 404/410, and a
	// client that hangs up the instant it reads that status must not be able to
	// cancel the deletion its own request triggered.
	base := context.WithoutCancel(ctx)

	dbCtx, cancelDB := context.WithTimeout(base, pairRoomCloseBudget)
	closed, err := s.store.ClosePairRoom(dbCtx, room.ID, now, now+pairRoomBlobHold)
	if err != nil {
		// Logged rather than swallowed: the room is still open, so its ciphertext
		// is still readable past a deadline that has passed. GC's sweep is the
		// backstop that will try again, and it must be possible to see that it had
		// to.
		log.Printf("pair room %s: void failed, ciphertext survives until the next sweep: %v", room.ID, err)
		cancelDB()
		return err
	}
	cancelDB()
	return s.reclaimPairRoomClosure(base, room, closed, now)
}

// reclaimPairRoomClosure performs only the physical, best-effort half after an
// authoritative close transaction has already committed.
func (s *Service) reclaimPairRoomClosure(base context.Context, room PairRoom, closed PairRoomClosure, now int64) error {
	// PHASE TWO. Budget checked before each artifact rather than during one: a
	// probe or a delete against an unreachable node can take its own short
	// timeout, and a fan-out of them must not make a request that is answering
	// 410 wait on all of them. Whatever is left has already been paid for in full
	// by phase one — a durable delete intent — so stopping here costs only the
	// chance to bill an unrecorded residual, which is the write-off the owner's
	// rule already grants a timed-out room.
	pctx, cancel := context.WithTimeout(base, pairRoomReclaimBudget)
	defer cancel()
	for i, sf := range closed.Objects {
		if pctx.Err() != nil {
			log.Printf("pair room %s: out of reclaim budget with %d of %d object blob(s) left; every one of them is queued for deletion and GC retries until it lands",
				room.ID, len(closed.Objects)-i, len(closed.Objects))
			return nil
		}
		s.dropReclaimedBlob(pctx, sf.BlobKey, sf.NodeID)
	}
	for i, r := range closed.Sessions {
		if pctx.Err() != nil {
			log.Printf("pair room %s: out of reclaim budget with %d of %d upload session(s) left; their rows are already gone and their blobs are queued for deletion, so what is lost is the chance to bill an unrecorded residual",
				room.ID, len(closed.Sessions)-i, len(closed.Sessions))
			return nil
		}
		s.settleReclaimedUpload(pctx, r, now)
	}
	return nil
}

// settleReclaimedUpload does the physical half of reclaiming ONE upload a room's
// void interrupted: bill what the blob really holds beyond what any append
// recorded, then delete it.
//
// Its row is already gone and its known bytes are already billed (ClosePairRoom
// did both, in one transaction). What is left is the question only the blob can
// answer — `received` is as good as the last append that survived to write it
// down, and a node that committed bytes and died before it could say so leaves
// the truth on the blob and nowhere else. The probe has to come before the
// delete, because the delete destroys the answer.
//
// WHEN THE NODE CANNOT BE REACHED, THIS DOES NOT KEEP THE EVIDENCE. The ordinary
// reaper moves such a session to the durable recovery state and holds its row
// and its blob indefinitely, because `received` is only a lower bound and
// writing the session off against it permanently underbills bytes the node
// really took. That is the right answer for an abandoned upload. It is the wrong
// answer here: the room's deadline passed, and the promise attached to that
// deadline is that the ciphertext is deleted — "we are still holding your
// encrypted file because a machine of ours is offline" is not a deletion, and no
// amount of billing accuracy buys it back.
//
// So the precedence inverts, exactly as it does when an account asks to be
// deleted (PurgeTransientUserData): what is KNOWN stays billed, the blob is
// queued for deletion so GC keeps trying, the session and its binding to the
// room stop existing, and the unknown residual is written off. The write-off is
// bounded by one append (maxAppendBytes) and is logged with the number, so it is
// visible rather than silent.
func (s *Service) settleReclaimedUpload(ctx context.Context, r UploadSessionRow, now int64) {
	size, probed := s.probeUploadForReclaim(ctx, r)
	if !probed {
		log.Printf("pair room %s: node %s cannot say how big upload %s's partial blob %s really is, and the room's deadline has passed, so the %d bytes it acknowledged stay billed, anything beyond them is written off, and the blob is queued for deletion",
			r.PairRoomID, nodeLabelForLog(r.NodeID), r.ID, r.BlobKey, r.Received)
		return
	}
	// Bytes the node committed that no append survived to record. This is the last
	// moment anything can charge them, and the session's own ledger is gone, so
	// they go straight onto the account's meter.
	//
	// CLAMPED to the write budget this server authorized at init, for the reason
	// every other blob-reported number is: a malicious BYO or fleet node is free
	// to answer with anything, and max_size is the most this upload was ever
	// allowed to send. Non-billable (own-node) uploads spend the user's own disk
	// and are never metered at all.
	if to := min(size, r.MaxSize); r.Billable && to > r.Received {
		// Through settleBlobBillingDurably, not RecordMeter. The probe above is the
		// last time anything will ever know this number — the session row is gone —
		// so the bill must be DURABLE (metered, or journaled with the intent row's
		// floor advanced) before the delete on the next line destroys the evidence.
		//
		// This is the difference between the two halves of the write-off rule below.
		// UNKNOWN (the node could not be asked) is written off, deliberately. KNOWN
		// (the node answered) is billed, and stays billed through a database that is
		// briefly refusing writes and through this process dying.
		if !s.settleBlobBillingDurably(ctx, r.BlobKey, r.NodeID, to, now,
			"bytes blob "+r.BlobKey+" held when pair room "+r.PairRoomID+" ended") {
			// Nothing durable could be written, so the BLOB is the bill now. It
			// stays — with its intent row as the durable owner — and GC settles
			// the obligation before it deletes; deleting here would destroy the
			// only remaining copy of the number.
			return
		}
	}
	s.dropReclaimedBlob(ctx, r.BlobKey, r.NodeID)
}

// dropReclaimedBlob deletes one blob a room's void already took durable
// responsibility for.
//
// It does NOT enqueue on failure and does NOT retire on success, and both are
// the point. Not enqueue, because the intent was written inside the close
// transaction, before this could be attempted at all — there is no ordering in
// which the responsibility is younger than the attempt. Not retire, because an
// append that read this upload's session before the close may still be
// streaming, and would re-create the key after this delete returns; the row is
// what GC uses to come back for that, and it is retired on its own hold (see
// pairRoomBlobHold).
func (s *Service) dropReclaimedBlob(ctx context.Context, blobKey, nodeID string) {
	bs, err := s.blobFor(ctx, nodeID)
	if err != nil {
		return
	}
	_ = bs.Delete(ctx, blobKey)
}

// probeUploadForReclaim asks a room-bound upload's blob how many bytes it really
// holds. ok=false means nothing could ask — the node is unreachable — which is
// "unknown", never "unchanged".
func (s *Service) probeUploadForReclaim(ctx context.Context, r UploadSessionRow) (int64, bool) {
	bs, err := s.blobFor(ctx, r.NodeID)
	if err != nil {
		return 0, false
	}
	return s.probeBlobSize(ctx, bs, r)
}

// deleteStoredObjectNow removes one object's blob and row immediately, queuing
// the blob for GC if its node is unreachable. Shared by the void paths so
// "deleted" means the same thing in all of them.
//
// Detached and bounded. Detached because the caller is usually answering a
// request with 404/410 and the client hangs up on reading it — its cancelled
// context must not cancel the deletion that status is claiming. Bounded because
// the node holding the blob may be unreachable, and an unbounded reclaim on a
// request goroutine is a way to run out of them.
func (s *Service) deleteStoredObjectNow(ctx context.Context, sf StoredFile) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if bs, err := s.blobFor(ctx, sf.NodeID); err == nil {
		if derr := bs.Delete(ctx, sf.BlobKey); derr != nil {
			_ = s.store.EnqueueNodeDelete(ctx, sf.BlobKey, sf.NodeID, s.now().Unix())
		}
	} else {
		_ = s.store.EnqueueNodeDelete(ctx, sf.BlobKey, sf.NodeID, s.now().Unix())
	}
	_ = s.store.DeleteStoredFile(ctx, sf.ID, s.now().Unix())
}

// pairRoomObjectReadable is the gate every public read of a pair-room object
// passes through (liveFile). It answers "may this be served" and, when the
// answer is no because the room is over, makes that true on disk before
// returning.
//
// True here is not by itself a 200: liveFile still applies the object's own
// expires_at. The two only differ while a join is queued but unwritten, and
// there the difference is the whole point — the object is briefly unreadable
// (its row still carries the deadline the join should have removed) but it is
// NOT deleted, so the retry that lands makes it readable again rather than
// finding an empty blob store.
func (s *Service) pairRoomObjectReadable(ctx context.Context, sf StoredFile) bool {
	if sf.PairRoomID == "" {
		// A pair-room object with no room is unreachable ciphertext: no deadline
		// can be evaluated for it, so nothing can ever make it readable again.
		// Fail closed and reclaim it.
		s.deleteStoredObjectNow(ctx, sf)
		return false
	}
	room, found, err := s.store.GetPairRoom(ctx, sf.PairRoomID)
	if err != nil {
		return false // fail closed: an unreadable deadline is not an open door
	}
	if !found {
		s.deleteStoredObjectNow(ctx, sf)
		return false
	}
	if s.endPairRoomIfOver(ctx, room) {
		// ...and this object explicitly. The void above collects everything the
		// room holds, and an object can no longer be inserted into a room that is
		// already closed (insertPairRoomObjectOn shares the insert's transaction),
		// so this is belt and braces rather than a race — but blob deletion is
		// idempotent, so being sure costs nothing, and "the room is over" must
		// never mean "GC gets it eventually" for the object actually being asked
		// for.
		s.deleteStoredObjectNow(ctx, sf)
		return false
	}
	return true
}

// SweepPairRooms is GC's pair-room pass: void rooms whose deadline has passed
// (so their ciphertext goes even if nobody ever requests it again), then drop
// long-closed rows.
//
// It is a BACKSTOP. Every read and write path above already voids on the spot;
// this exists for the room nobody touches again, and its correctness must never
// be what makes the five-minute rule true.
func (s *Service) SweepPairRooms(ctx context.Context, now int64) {
	dead, err := s.store.ListDeadPairRooms(ctx, now, pairRoomSweepBatch)
	if err == nil {
		for _, room := range dead {
			// Through the guard, not straight to the void: a room whose join was
			// observed but not yet written down looks dead to this query and is not.
			s.endPairRoomIfOver(ctx, room)
		}
	}
	// Hygiene for the one room shape neither a deadline nor a completion can
	// reach: JOINED, open, and holding nothing at all.
	//
	// A joined room has no deadline (invariant 5), so the pass above cannot see
	// it, and a completion closes the room only when the completion is what
	// empties it. What falls between them is ordinary rather than exotic: the last
	// object is completed while an upload is still in flight — which correctly
	// leaves the room open, because that upload is entitled to finish — and the
	// upload is then abandoned instead of finalized, so the generic reaper takes
	// its session and nothing is left. Without this the row is immortal.
	//
	// It reclaims no bytes, because there are none: a room that holds no object and
	// no session has no ciphertext, no blob and no slot left. What it does still owe
	// is the OTHER half of a void — a room that is over takes its code with it —
	// which is why the store hands back the rooms it closed rather than a count.
	// The revoke runs AFTER the transaction committed, never before: a code taken
	// away for a close that then failed to commit would be a live room nobody can
	// reach. Each is bounded by that room's own owner and join deadline
	// (revokePairCode), so a sweep can never take digits that have been minted
	// again since. The grace period is what keeps this from racing the interval
	// between a room being created and the first upload session binding to it.
	if closed, err := s.store.CloseEmptyJoinedPairRooms(ctx, now-pairRoomEmptyGrace, now, pairRoomSweepBatch); err != nil {
		log.Printf("pair rooms: closing joined rooms that hold nothing: %v", err)
	} else if len(closed) > 0 {
		for _, room := range closed {
			s.revokePairCode(room)
		}
		log.Printf("pair rooms: closed %d joined room(s) with nothing left in them", len(closed))
	}
	_ = s.store.PurgeClosedPairRooms(ctx, now-pairRoomPurgeAfter)
}

// pairRoomEmptyGrace is how long a JOINED room must have existed before the
// sweep is willing to read "holds nothing" as settled rather than momentary.
//
// The interval it guards is small and real: a room is created by the request
// that starts the first pre-upload, and that upload's session row is inserted a
// statement later. A sweep landing in between, on a room joined in that same
// instant, would close a room whose upload is about to bind to it — turning a
// hygiene pass into a 410 for a transfer that was doing nothing wrong.
//
// pairRoomJoinWindow is the length because it is already this feature's unit of
// "long enough that nothing in flight is still in flight", and it is five orders
// of magnitude above the gap being covered. Nothing is lost by waiting: the row
// being collected is a few dozen bytes that no longer describe anything.
//
// A var only because pairRoomJoinWindow is one (it is signal.CodeTTLSeconds);
// production never reassigns it.
var pairRoomEmptyGrace = pairRoomJoinWindow

// pairRoomSweepBatch bounds one sweep so a backlog is drained over several ticks
// instead of holding the writer for an unbounded pass.
const pairRoomSweepBatch = 500
