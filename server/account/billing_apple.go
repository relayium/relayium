package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// handleApplePurchaseDispatch is the one server permission that may precede a
// StoreKit sheet. It binds the account permanently to this Apple app and emits
// exactly one dispatch for the authority generation. A retry after any client
// outcome must reconcile Transaction.updates/restore; it never gets a second
// permission to call Product.purchase.
func (s *Service) handleApplePurchaseDispatch(w http.ResponseWriter, r *http.Request, u User) {
	if s.appleTx == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "verifier_unavailable")
		return
	}
	var in struct {
		BundleID  string `json:"bundleId"`
		ProductID string `json:"productId"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || dec.Decode(new(json.RawMessage)) != io.EOF {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	app, ok := s.appleTx.ConfiguredApp(in.BundleID)
	if !ok || app.BundleID != in.BundleID {
		writeAppleTransactionError(w, http.StatusBadRequest, "unknown_bundle")
		return
	}
	if enabled, err := s.applePurchasesEnabled(r.Context()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	} else if !enabled {
		writeAppleTransactionError(w, http.StatusConflict, "purchases_paused")
		return
	}
	if _, ok, err := s.Store().AppleProductPlan(r.Context(), in.BundleID, in.ProductID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	} else if !ok {
		writeAppleTransactionError(w, http.StatusBadRequest, "product_unavailable")
		return
	}
	eligible, err := s.appleCatalogEligibility(r.Context(), u, in.BundleID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !eligible.Allowed {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_authority_conflict", "provider": eligible.BlockedBy})
		return
	}
	candidate, err := newAppAccountToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	authorities, ok := s.Store().(interface {
		AcquireBillingAuthority(context.Context, BillingAuthorityRequest) (BillingAuthority, error)
		DispatchAppleBillingPurchase(context.Context, BillingAuthority, string, string, int64) (BillingPurchaseAttempt, bool, error)
	})
	if !ok {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	authority, err := authorities.AcquireBillingAuthority(r.Context(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: in.BundleID, AppleAccountToken: candidate, Now: s.now().Unix()})
	if errors.Is(err, ErrBillingAuthorityConflict) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_authority_conflict", "provider": "existing"})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	attempt, created, err := authorities.DispatchAppleBillingPurchase(r.Context(), authority, in.ProductID, candidate, s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !created {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "purchase_reconciliation_required", "provider": ProviderApple})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"appAccountToken": attempt.AppleAccountToken, "attemptId": attempt.ID})
}
