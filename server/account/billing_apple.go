package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/relayium/relayium/httpx"
)

// handleAppleAccountToken is a permanently retired compatibility route. Old
// clients used it to obtain a stable token before asking the server for a
// purchase dispatch, which allowed StoreKit to charge outside the durable
// billing authority. Existing tokens remain valid for signed transaction,
// notification and sweep recovery, but this route never returns or mints one.
func (s *Service) handleAppleAccountToken(w http.ResponseWriter, _ *http.Request, _ User) {
	writeAppleTransactionError(w, http.StatusGone, "upgrade_required")
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
