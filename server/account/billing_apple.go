package account

import (
	"log"
	"net/http"

	"github.com/relayium/relayium/httpx"
)

// handleAppleAccountToken returns this account's stable App Store
// `appAccountToken`, minting it on first request.
//
// WHAT IT IS. Apple lets a purchase carry one opaque RFC 4122 UUID chosen by
// the app, and hands it back inside the signed transaction. It is the only
// server-side link between an App Store subscription and a Relayium account
// that does not depend on the Apple ID the purchase was made with — which we
// neither see nor want. So the SERVER issues it (never the client, which could
// otherwise pick another account's), keeps it for the life of the account, and
// the app attaches it to every purchase.
//
// WHAT IT IS NOT. It is not a credential. Possession proves nothing and
// authorizes nothing: this endpoint requires an authenticated session or
// bearer, and the later notification path will still verify Apple's signature
// before believing anything the token is attached to. It is also not logged —
// an identifier that maps to exactly one account does not belong in a log line
// that outlives the request.
//
// WHY POST. It may create state (the first call mints the token), and it is
// reached by the native apps with a bearer token rather than a cookie, hence
// RequireAuth rather than RequireSession. A GET would additionally be
// cacheable, which is the wrong property for a per-account identifier.
func (s *Service) handleAppleAccountToken(w http.ResponseWriter, r *http.Request, u User) {
	candidate, err := newAppAccountToken()
	if err != nil {
		// crypto/rand failing is not a "try again" condition for a value that
		// must be unguessable; refuse rather than fall back to anything weaker.
		log.Printf("billing: minting an app account token for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// First write wins: two devices asking at once converge on one token, and a
	// candidate already held by another account is refused by the unique index
	// rather than silently rebinding.
	token, err := s.Store().EnsureAppleAccountToken(r.Context(), u.ID, candidate)
	if err != nil {
		log.Printf("billing: binding an app account token for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"appAccountToken": token})
}
