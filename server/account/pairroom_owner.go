package account

import (
	"context"
	"net/http"

	"github.com/relayium/relayium/httpx"
)

// The OWNER's half of the pair-room lifecycle: seeing what a pairing transfer
// left on the server, and letting it go.
//
// WHY THIS EXISTS. Invariant 5 in pairroom.go is literal — once a peer joins,
// nothing about the transfer is on a clock — so a joined room's ciphertext has no
// expiry of any kind. Everything else about it is already correct: it is billed
// (invariant 3), it counts against the plan's storage cap (CurrentStorage sums
// it like any other row), and a receiver holding the file key can end it
// (pairroom_complete.go). What was missing is the account's own view. A joined
// room appears in no list — the share list is deliberately shares only
// (handleListFiles) — so an account could be charged, permanently, for storage it
// had no way to see and no way to release. Charged and invisible is the one
// combination an account surface may not leave standing, and it is worth being
// precise about which of the two this fixes: the charge is correct and stays;
// the invisibility is the bug.
//
// WHAT IT IS NOT. It is not a deadline, and nothing here may become one. No
// clock fires, nothing expires, and the server never releases a room on its own
// — a release happens only because the account asked for that room, by id, once.
// That is the same shape as the receiver's completion capability and for the same
// reason: inventing a fallback expiry is exactly the reinterpretation of rule 5
// this feature already refused once (pairroom.go, invariant 8).
//
// WHAT IT IS BOUNDED BY, in one place each:
//
//   - VISIBILITY is bounded by ownership and by shape. The query is defined over
//     user_id (pairRoomHoldingWhere) so there is no request that can see another
//     account's room, and what comes back carries no code, no object id, no blob
//     key, no verifier, no node and nothing about the peer.
//   - RELEASE is bounded by ownership, by the room being JOINED, and by no upload
//     still being bound to it. All three are re-derived here at release time from
//     the row itself — never from what the listing said, which the client may
//     have been holding for an hour.
//   - THE ANSWER is bounded by what it may reveal: absent, someone else's, and
//     already-released are ONE answer, so a caller cannot use this route to learn
//     whether a room id exists.
//
// MOUNTED WHATEVER THE FEATURE FLAG SAYS. Neither route consults s.preUpload, and
// that is deliberate rather than an oversight: the flag stops rooms being
// CREATED, and a deployment that turns it off after a room exists must not
// thereby strand that room's ciphertext on an account with no control over it.
// A kill switch that traps the thing it was meant to contain is not a kill
// switch. With the flag off and no room ever created, both routes simply have
// nothing to report and nothing to release.

// pairRoomHoldingPage bounds one listing.
//
// A hard cap rather than a cursor, and the reason is that the bound exists to
// stop an unbounded result set, not to page through one: a room per pairing
// transfer that was never completed is a number in the tens for a heavy account
// and in the zero-to-one range for everyone else, so two hundred is far past any
// real holding while still being a number the server chose. The aggregate is
// computed over EVERY room regardless (PairRoomHoldings.Total), so an account
// past the cap still sees the true byte count it is being charged for, and
// Truncated says so plainly rather than letting the list read as complete.
//
// If this ever needs to become a real cursor, the ordering is already total
// (created_at DESC, id DESC), which is the part that is hard to add later.
const pairRoomHoldingPage = 200

// pairRoomRelease is what one release attempt did. Values rather than booleans
// because three of the four are refusals with different meanings to the person
// reading the screen, and collapsing any two of them would produce a message
// that is not true of the case it was shown for.
type pairRoomRelease int

const (
	// pairRoomReleased: the room is closed, its quota is released and its
	// ciphertext is queued for deletion.
	pairRoomReleased pairRoomRelease = iota
	// pairRoomReleaseGone: there is nothing here to release. The room does not
	// exist, belongs to somebody else, or was already released. ONE outcome for
	// all three, so this route cannot be used to probe for room ids.
	pairRoomReleaseGone
	// pairRoomReleaseWaiting: the caller's own room, but nobody has joined it. It
	// is on its own deadline and will end without anybody's help — and it is the
	// state a pre-upload is in WHILE it is happening, so releasing it on request
	// would be a way to destroy a transfer that is still being uploaded.
	pairRoomReleaseWaiting
	// pairRoomReleaseUploading: an upload session is still bound to the room — a
	// file of the batch that was already in flight when the peer joined, which the
	// protocol promises is allowed to finish. Releasing would throw away bytes the
	// account is being billed for.
	pairRoomReleaseUploading
)

// releasePairRoom is the owner asking for one whole room back.
//
// WHOLE ROOM, never one object. The account cannot tell its objects apart — it is
// shown a count and a total, because the server holds no name for any of them —
// so an object-level control would be asking somebody to choose between things
// they cannot see. The room is the unit that means something: one pairing
// transfer.
//
// EVERY PRECONDITION IS RE-DERIVED by CloseOwnedPairRoom inside the same writer
// transaction as the close, never taken from the listing the client is acting
// on. A client may have been holding that list for an hour; in between, the
// receiver may have completed the transfer, or another tab may have released it.
//
// THE RACE THAT IS NOT ONE. The eligibility read and the close are two
// statements, so the obvious question is what happens if a session binds between
// them. It cannot: no new upload session can ever bind to a JOINED room
// (pairRoomForUpload refuses one with errPairRoomJoined, and
// CreatePairRoomIfAbsent excludes joined rooms from code resolution), so a joined
// room's session set only ever shrinks. The other direction — a session that
// finishes just after we saw it — costs one refusal the user can repeat.
//
// A FINALIZE LANDING IN THE GAP is the one genuinely concurrent case, and it is
// already handled by the machinery this reuses rather than by anything here: the
// object insert carries the room's open precondition in its own transaction, so
// it fails with ErrPairRoomClosed and the finalize drops its own blob on the way
// to a 410 (see ClosePairRoom's doc). Nothing is left pointing at ciphertext.
//
// THE CLOSE reuses the same close transaction and physical reclaim machinery as
// voidPairRoom, but only after that transaction proves no upload session remains
// bound; otherwise it refuses the release. The room's code is revoked under the
// same owner-and-deadline bound (so a release can never take back digits that
// have since been minted to somebody else), and the close transaction deletes
// the object rows and queues a DURABLE delete intent for every blob before
// anything can fail. Physical deletion is the bounded best-effort half that an
// unreachable node can only delay. Quota is released when that transaction
// commits, not when a node answers.
func (s *Service) releasePairRoom(ctx context.Context, userID, roomID string) (pairRoomRelease, error) {
	room, found, err := s.store.GetPairRoom(ctx, roomID)
	if err != nil {
		return pairRoomReleaseGone, err
	}
	// Missing, somebody else's, and already closed are one answer. Ownership is
	// checked before anything else can differ, so the refusals below — which DO
	// differ from each other — are only ever reachable for the caller's own rooms
	// and disclose nothing about anybody else's.
	if !found || room.UserID != userID || room.ClosedAt != 0 {
		return pairRoomReleaseGone, nil
	}
	now := s.now().Unix()
	base := context.WithoutCancel(ctx)
	dbCtx, cancel := context.WithTimeout(base, pairRoomCloseBudget)
	closed, outcome, err := s.store.CloseOwnedPairRoom(dbCtx, userID, room.ID, now, now+pairRoomBlobHold)
	cancel()
	if err != nil {
		return pairRoomReleaseGone, err
	}
	switch outcome {
	case PairRoomOwnerReleaseWaiting:
		return pairRoomReleaseWaiting, nil
	case PairRoomOwnerReleaseUploading:
		return pairRoomReleaseUploading, nil
	case PairRoomOwnerReleaseGone:
		return pairRoomReleaseGone, nil
	}
	// The close is committed before the in-memory rendezvous is revoked. The
	// identity guard in revokePairCode prevents recycled digits being touched.
	s.revokePairCode(room)
	_ = s.reclaimPairRoomClosure(base, room, closed, now)
	return pairRoomReleased, nil
}

// handlePairRoomHoldings (GET /api/pair-rooms) is the account seeing its own
// pair-room storage.
//
// Authenticated by session cookie OR bearer, like /api/me/usage beside it: this
// is a read of the caller's own account, a bearer request carries no ambient
// authority, and the native apps that hold one have the same right to see what
// they are being charged for as the browser does.
//
// The response names each room by its opaque instance id and reports only what a
// release decision needs. `releasable` is the SERVER's verdict, so the client
// never has to reconstruct an eligibility rule — and cannot get it wrong in a way
// that puts a delete control next to an upload in flight.
func (s *Service) handlePairRoomHoldings(w http.ResponseWriter, r *http.Request, u User) {
	held, err := s.store.ListPairRoomHoldings(r.Context(), u.ID, pairRoomHoldingPage)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	rooms := make([]map[string]any, 0, len(held.Rooms))
	for _, h := range held.Rooms {
		rooms = append(rooms, map[string]any{
			"id":         h.RoomID,
			"createdAt":  h.CreatedAt,
			"joinedAt":   h.JoinedAt,
			"objects":    h.Objects,
			"bytes":      h.Bytes,
			"releasable": h.Releasable,
		})
	}
	// Account-scoped storage figures, exactly like /meta and the blob route: no
	// intermediary may keep a copy, and a cached answer would go on describing
	// storage after it was released.
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"rooms": rooms,
		"totals": map[string]any{
			"rooms":   held.Total.Rooms,
			"objects": held.Total.Objects,
			"bytes":   held.Total.Bytes,
		},
		// The bound, stated rather than implied: a client that shows a list must be
		// able to say honestly that it is showing part of one.
		"limit":     pairRoomHoldingPage,
		"truncated": held.Truncated,
	})
}

// handleReleasePairRoom (DELETE /api/pair-rooms/{id}) is the account letting one
// whole room go.
//
// STATUS CONTRACT:
//
//	200 {"status":"ok"}                  released — or there was nothing to
//	                                     release: absent, another account's, or
//	                                     already gone. One answer for all four, so
//	                                     this is not an existence oracle, and so a
//	                                     retry of a request whose response was
//	                                     lost is a no-op rather than an error.
//	409 {"error":"pair_room_uploading"}  an upload is still arriving into it.
//	409 {"error":"pair_room_waiting"}    nobody has joined it; it is on its own
//	                                     deadline and is not this control's to end.
//	500                                  the store could not be read or written.
//	                                     Never 200: a caller told its ciphertext
//	                                     was released has no reason to ask again.
//
// A real DELETE with no body, so it is CSRF-guarded by Routes() like every other
// state-changing account route and needs no vocabulary of its own.
func (s *Service) handleReleasePairRoom(w http.ResponseWriter, r *http.Request, u User) {
	outcome, err := s.releasePairRoom(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	switch outcome {
	case pairRoomReleaseUploading:
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "pair_room_uploading"})
	case pairRoomReleaseWaiting:
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "pair_room_waiting"})
	default:
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
