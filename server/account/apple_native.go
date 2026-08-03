package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/relayium/relayium/httpx"
)

// The native Sign in with Apple exchange.
//
// Apple's current guidance (Verifying a user; Generate and validate tokens)
// asks a server for TWO independent proofs, not one:
//
//  1. the identity token the app received, verified end to end — signature
//     against Apple's JWKS, `iss`, `aud`, `exp` and the nonce THIS attempt
//     generated; and
//  2. the one-time authorization code, redeemed at Apple's token endpoint. The
//     code is single-use and lives five minutes, so redeeming it proves the
//     authorization is live and belongs to this exchange rather than being a
//     token captured or minted elsewhere and replayed later.
//
// Only the pair is trusted. The route therefore refuses to mint a bearer
// unless the exchange succeeds AND the token Apple returns describes the same
// audience, the same subject and the same nonce as the token the app presented.
//
// Nothing in this file logs the identity token, the authorization code or the
// nonce. They are credentials for the duration of one exchange, and the one
// thing that must never happen to a credential is to become a log line.
//
// # Deferred, and launch-blocking
//
// The exchange CONSUMES the authorization code (that is what makes replay
// impossible) but deliberately keeps nothing from the token response: no Apple
// refresh token, no access token. Apple's account-lifecycle guidance expects a
// server to store the refresh token so it can periodically re-validate the
// authorization and revoke it programmatically when the user deletes their
// account. That storage, the server-to-server revocation notifications, and the
// in-app deletion path built on them are still to do, and they are required
// before an iOS launch — this route being correct is not the same as Apple
// account lifecycle being handled. Recorded here rather than only in the
// decision log so the gap is visible from the code that has it.

// errAppleCodeRejected marks an exchange that Apple ANSWERED and refused — a
// used, expired, forged or wrong-client authorization code. It is separated
// from a transport failure because the two are different facts about the world
// and deserve different answers: a refusal is final for this attempt (401), a
// failure to reach Apple is not the caller's fault and may succeed on a retry
// (502). Collapsing them would tell a user with a perfectly good Apple ID that
// their sign-in was rejected during an Apple outage.
var errAppleCodeRejected = errors.New("apple: authorization code rejected")

// appleNativeConfigured reports whether the server holds everything the native
// route needs to redeem an authorization code: the .p8 signing key and the two
// identifiers that go into the client_secret JWT.
//
// The Web flow has the same requirement plus a Services ID and redirect
// (appleWebConfigured), and its routes stay unregistered without them. The
// native route cannot do that — it is registered on EnableApple alone, and it
// is the mobile app's only way in — so it answers honestly at request time
// instead of failing somewhere inside the signer.
func (s *Service) appleNativeConfigured() bool {
	return s.cfg.AppleTeamID != "" && s.cfg.AppleKeyID != "" && s.cfg.ApplePrivateKey != nil
}

// handleAppleNative logs a native (iOS) app in with a Sign in with Apple
// identity token AND its one-time authorization code, and returns a bearer
// token. Dormant until EnableApple is set.
//
// Account resolution is unchanged and deliberately so: by the stable Apple
// `sub` first (Apple only returns the email on the FIRST authorization),
// falling back to email-based account creation/linking on that first sign-in.
// What changed is everything that has to be true BEFORE resolution starts.
func (s *Service) handleAppleNative(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"idToken"`
		// The one-time code from ASAuthorizationAppleIDCredential. Required:
		// without it there is nothing to prove the authorization is live.
		AuthorizationCode string `json:"authorizationCode"`
		Nonce             string `json:"nonce"`
		Name              string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Fail closed on a missing field rather than degrading to a weaker check.
	// An absent nonce in particular would mean verifying a token that is bound
	// to no attempt at all — which is the replay this route exists to refuse.
	if in.IDToken == "" || in.AuthorizationCode == "" || in.Nonce == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	if !s.appleNativeConfigured() {
		// Truthful rather than "invalid token": the credential was never
		// examined, because this deployment cannot redeem a code at all.
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "apple_not_configured"})
		return
	}

	// 1. The presented identity token, verified end to end against this
	//    attempt's nonce.
	claims, err := s.verifyAppleIDToken(r.Context(), in.IDToken, in.Nonce)
	if err != nil {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return
	}
	// 2. The audience must be an APP audience. cfg.AppleClientIDs is one
	//    cryptographic allowlist shared with the browser flow, so a token minted
	//    for the Web Services ID verifies perfectly here — and a web identity
	//    token exchanged through this route would hand out a long-lived native
	//    bearer for an authorization that was never native. Refused before the
	//    code is spent, so a Web token cannot even consume an exchange.
	if claims.Aud == "" || claims.Aud == s.cfg.AppleServicesID {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_audience"})
		return
	}
	// 3. Redeem the one-time code AS THE VERIFIED AUDIENCE. Using the token's
	//    own aud (rather than a configured native client id) is what keeps the
	//    two halves describing the same client: Apple refuses a code that was
	//    not issued to the client_id presenting it, so a mismatch here cannot
	//    silently succeed.
	exchangedToken, err := s.exchangeAppleNativeCode(r.Context(), claims.Aud, in.AuthorizationCode)
	if err != nil {
		if errors.Is(err, errAppleCodeRejected) {
			httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_code"})
			return
		}
		httpx.WriteJSON(w, http.StatusBadGateway, map[string]string{"error": "apple_unavailable"})
		return
	}
	// 4. The token Apple returned for that code must describe the SAME
	//    authorization. Verifying it re-checks the signature, issuer, expiry and
	//    nonce; the two comparisons below add the parts a second valid Apple
	//    token would otherwise satisfy on its own — pairing a stolen identity
	//    token with an attacker's own fresh authorization code.
	exchanged, err := s.verifyAppleIDToken(r.Context(), exchangedToken, in.Nonce)
	if err != nil || exchanged.Aud != claims.Aud || exchanged.Sub != claims.Sub {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "token_mismatch"})
		return
	}
	// Apple sends the email on the first authorization only, and sends it in
	// both tokens. Preferring the presented one and falling back keeps the one
	// chance to learn the address from depending on which token carried it.
	if claims.Email == "" && exchanged.Email != "" {
		claims.Email = exchanged.Email
		claims.EmailVerified = exchanged.EmailVerified
		claims.IsPrivateEmail = exchanged.IsPrivateEmail
	}

	u, found, err := s.store.GetUserByIdentity(r.Context(), "apple", claims.Sub)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !found {
		// First sign-in for this Apple id. Apple only gives us the email now, so
		// this is our one chance to create/link the account by it.
		if claims.Email == "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "no_email_first_signin"})
			return
		}
		u, err = s.store.UpsertUserByEmail(r.Context(), claims.Email, in.Name)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if s.frozenBlocked(w, u) {
			return
		}
		if err := s.store.LinkIdentity(r.Context(), "apple", claims.Sub, u.ID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if claims.EmailVerified {
			// Pre-hijack defense: drop any password planted on this email while
			// unverified, before Apple verifies it (see dropUnverifiedPassword).
			// Gate verification on the drop succeeding — verifying while a planted
			// password survives is exactly the takeover we're closing, so on error
			// we must NOT flip the account to verified (mirrors oauth.go).
			if err := s.dropUnverifiedPassword(r.Context(), u.ID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if err := s.store.SetEmailVerified(r.Context(), u.ID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
	} else if s.frozenBlocked(w, u) {
		return
	}
	s.finishNativeLogin(w, r, u.ID, "App (Apple)")
}

// frozenBlocked writes the pending-deletion response and reports true when the
// account is scheduled for deletion, so a frozen account never gets a token.
func (s *Service) frozenBlocked(w http.ResponseWriter, u User) bool {
	if u.DeletedAt == 0 {
		return false
	}
	raw, err := s.issueReactivateToken(context.Background(), u.ID, u.Email)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"status": "pending_deletion", "purgeAfter": u.PurgeAfter, "reactivateToken": raw,
	})
	return true
}
