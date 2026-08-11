package account

import (
	"context"
	"net/http"

	"github.com/relayium/relayium/httpx"
)

// Pre-mint admission for a pairing code — B3, decided 2026-08-11: "block before
// entering the room when the account is over quota; fail OPEN on a read error;
// say LAN still works".
//
// WHAT THIS ASKS, AND WHAT IT DELIBERATELY DOES NOT.
//
// One question: is this account's effective MONTHLY COMBINED TRAFFIC allowance
// spent? That single limit is the only one whose exhaustion makes a pairing code
// worthless, because Relayium's meter covers relay AND stored upload/download
// (currentMonthTraffic). With it gone, BOTH cross-network paths are gone: the
// live TURN session is refused by turn.go's own traffic gate, and pre-upload is
// refused by the stored gates. Six digits handed out in that state name a
// rendezvous the account cannot complete by any route the server offers.
//
// It does NOT ask about storage capacity, and it does NOT ask about the rolling
// daily upload quota. Both of those refuse an UPLOAD; neither touches the live
// relay. An account whose disk is full or whose daily quota is spent can still
// pair and still transfer — over the relay, in real time — so refusing to mint
// would be the server inventing a limit the product does not have, and telling
// the user their transfer is impossible when it is not. Those two limits do
// their work later, at the pre-upload gates (pairRoomAdmission), where the
// refusal is true. LAN is unaffected by all three, always.
//
// WHERE IT RUNS. Two callers, one evaluator, on purpose:
//
//   - POST /api/pair, immediately before the registry mint (signal.PairAdmission,
//     wired in main.go). This is the AUTHORITATIVE one. It is the only one a
//     CLI/bearer client passes through, and it is the only one a Web race cannot
//     outrun — the allowance can be spent between the choose screen's preflight
//     and the click.
//   - GET /api/pair/preflight, so the choose screen can replace the mint button
//     with something truthful BEFORE it is clicked, instead of computing the
//     answer itself out of /api/me/usage. A second implementation of "is the
//     allowance spent" living in the client is a second implementation of the
//     mid-month proration rule (monthlyTrafficCap), which is exactly the kind of
//     arithmetic that drifts silently and disagrees with the gate.
//
// FAIL OPEN, on every read error, and unlike the gates that meter real bytes.
// The owner named this behaviour for this decision specifically ("it must fail
// open like turn.go already does"), and it costs nothing: an admitted mint buys
// no bytes, and every byte that then moves passes an authoritative, fail-closed
// gate anyway. The opposite failure is one database hiccup stopping everybody
// from starting a transfer at all.

// PairMintTrafficSpent is the stable, machine-readable refusal a client branches
// on: this account's monthly combined traffic allowance is exhausted, so neither
// cross-network path is available to it.
//
// Exported because it crosses two boundaries — the JSON body of POST /api/pair's
// 429 and of the preflight — and both the Web client and any future first-party
// client have to match it exactly. It must not be reworded: it is an identifier,
// not a message. The human sentence is the client's, in nine locales.
//
// It is a distinct string from the prose the upload gates use for the same
// underlying limit (errPairRoomTrafficSpent) because those are messages shown as
// they are, and this is a token compared with ==.
const PairMintTrafficSpent = "traffic_exhausted"

// pairMintRefusal is THE evaluator. "" admits.
//
// Deliberately tiny, and deliberately the only place the question is asked: the
// two call sites below and the client's blocked screen all have to agree, and the
// way they agree is by there being one answer rather than three that resemble
// each other.
//
// It asks trafficAllowanceSpent, which refuses at `remaining <= 0`. NOT
// overTraffic(…, 0): that helper answers "will N more bytes fit", which is
// `add > remaining`, and with add=0 an account sitting on exactly its cap
// (remaining == 0) answers false — admitted. That is the right answer for a gate
// weighing a zero-byte write, and the wrong one here, where the question is
// whether the allowance is SPENT. Exactly zero left is spent: the next relay
// packet and the next stored byte are both refused, so the six digits would name
// a rendezvous that cannot move anything. The UI copy says the allowance is gone;
// the boundary has to mean it.
//
// The same helper answers for the TURN credential gate (turn.go) and the traffic
// leg of pairRoomAdmission, which is what makes the claim above true rather than
// merely intended: all three close at the same byte. Underneath it,
// remainingTraffic is still the one authority for the arithmetic — it carries the
// effective/prorated cap and the combined meter with it (monthlyTrafficCap +
// currentMonthTraffic) — so a mid-month plan change is handled here exactly as it
// is everywhere else, and `unlimited` (cap <= 0) admits without looking at usage.
func (s *Service) pairMintRefusal(ctx context.Context, userID string) string {
	spent, err := s.trafficAllowanceSpent(ctx, userID)
	if err != nil || !spent {
		return "" // fail open on a read error; an unlimited plan is never spent
	}
	return PairMintTrafficSpent
}

// PairMintRefusal is the evaluator in the shape signal.PairAdmission wants, so
// main.go can hand the mint handler this method value and nothing else.
//
// The seam runs account → signal: the signaling layer states what it needs (a
// func) and this package supplies it. Nothing here imports the registry, and
// nothing in signal learns what a plan is.
func (s *Service) PairMintRefusal(r *http.Request, userID string) string {
	return s.pairMintRefusal(r.Context(), userID)
}

// pairPreflightResponse is the read-only answer the choose screen renders from.
//
// Two fields rather than a bare boolean because "blocked" needs a reason the
// client can key its copy off, and because a future second reason must be
// addable without changing the shape. `allowed` is the field a client branches
// on; `reason` is empty exactly when allowed is true.
type pairPreflightResponse struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

// handlePairPreflight answers whether this account may mint a pairing code right
// now. It MINTS NOTHING, reads no registry state and writes nothing at all — the
// choose screen calls it on render, and a preflight with a side effect would be
// a code shredder.
//
// Authenticated (RequireAuth: session cookie or bearer), so an anonymous caller
// gets a 401 and learns nothing about anybody's usage. It is advisory by
// construction: the allowance can be spent between this answer and the click, so
// POST /api/pair re-asks and is what actually decides.
//
// A read error answers ALLOWED with a 200, not a 500. Same fail-open rule as the
// gate it mirrors — and a preflight that 500s would be a blocked-looking screen
// for a user who is not blocked, which is the failure this whole endpoint exists
// to avoid.
func (s *Service) handlePairPreflight(w http.ResponseWriter, r *http.Request, u User) {
	reason := s.pairMintRefusal(r.Context(), u.ID)
	httpx.WriteJSON(w, http.StatusOK, pairPreflightResponse{Allowed: reason == "", Reason: reason})
}
