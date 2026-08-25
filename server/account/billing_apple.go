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
// exactly one dispatch for the authority generation.
//
// A LEGACY request -- one carrying no `appInstanceId` -- is unchanged in every
// respect: it gets exactly one dispatch, and its retry after any client outcome
// gets 409 `purchase_reconciliation_required` and must reconcile through
// Transaction.updates/restore. Old released clients stay strict one-shot
// clients, which is the whole point of delivering this server-first.
//
// A NEW-PROTOCOL request additionally binds a continuation capability (see
// billing_apple_attempt.go). If the current arm explicitly reported
// `.userCancelled`, the same capability may resume it, or another authenticated
// app instance may atomically replace the now-zero-charge binding with its own
// pre-persisted capability. Both paths keep the same attempt and attribution
// token and create no row. Account identity never re-arms an armed, locked or
// ambiguous sheet, and possession of the `appAccountToken` is never authority.
//
// Every new-protocol dispatch names its arm with `armRequestId`, the initial one
// included. That name is both the idempotency key for a lost response and the
// identity a later outcome report must present, which is what stops a duplicate
// report from an earlier arm re-opening a second sheet.
func (s *Service) handleApplePurchaseDispatch(w http.ResponseWriter, r *http.Request, u User) {
	if s.appleTx == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "verifier_unavailable")
		return
	}
	var in struct {
		BundleID             string `json:"bundleId"`
		ProductID            string `json:"productId"`
		ContinuationProtocol string `json:"continuationProtocol"`
		// Additive. Absent on every released client, which is exactly what makes
		// them strict one-shot.
		AppInstanceID      string `json:"appInstanceId"`
		ArmRequestID       string `json:"armRequestId"`
		ContinuationSecret string `json:"continuationSecret"`
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
	// `appInstanceId` alone selects the protocol. A new-protocol request must also
	// name the arm it is asking for -- on the INITIAL arm as much as on a resume,
	// because that name is what a later outcome report has to present to prove it
	// belongs to the sheet that is open now. Current clients also send a
	// pre-persisted `continuationSecret` on the initial arm, which makes a lost
	// first response replayable; compatible older clients may omit it once.
	//
	// A malformed shape is a 400 rather than a capability refusal: the client
	// should be told it built the request wrong, not that its capability failed.
	if in.AppInstanceID != "" {
		if (in.ContinuationProtocol != "" && in.ContinuationProtocol != appleContinuationProtocolAttemptIDV2) ||
			!validAppleContinuationID(in.AppInstanceID) || !validAppleContinuationID(in.ArmRequestID) ||
			(in.ContinuationSecret != "" && !validAppleContinuationSecret(in.ContinuationSecret)) {
			writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	} else if in.ContinuationProtocol != "" || in.ArmRequestID != "" || in.ContinuationSecret != "" {
		// A legacy client sends neither. Half a capability with no instance is
		// malformed, and must not be silently downgraded to a one-shot dispatch.
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	existingAuthority, authorityExists, err := s.Store().BillingAuthority(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Refuse an installed continuation client that cannot adopt an authoritative
	// replacement attempt id before creating any durable billing identity. The
	// store repeats this check as defence in depth, but it is deliberately too
	// late to prevent AcquireBillingAuthority from committing an otherwise empty
	// Apple authority and blocking a later Stripe checkout.
	if in.AppInstanceID != "" && in.ContinuationProtocol != appleContinuationProtocolAttemptIDV2 && !authorityExists {
		writeAppleTransactionError(w, http.StatusForbidden, appleRefusalCapabilityCode)
		return
	}
	// An exact initial-arm replay outranks every gate that can have changed
	// since the original request. Otherwise a lost 200 followed by a catalog
	// pause, product retirement or manage-with-Apple transition would answer a
	// deterministic refusal for an arm the server had in fact created, leaving
	// the client unable either to open the sheet or safely retire its prepared
	// identity.
	if in.AppInstanceID != "" && in.ContinuationSecret != "" {
		if authorityExists && existingAuthority.Provider == ProviderApple && existingAuthority.ExternalScope == in.BundleID {
			replayer, ok := s.Store().(interface {
				ReplayAppleBillingPurchase(context.Context, BillingAuthority, AppleDispatchRequest) (AppleDispatchOutcome, bool, error)
			})
			if !ok {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			outcome, replayed, err := replayer.ReplayAppleBillingPurchase(r.Context(), existingAuthority, AppleDispatchRequest{
				ProductID: in.ProductID, ContinuationProtocol: in.ContinuationProtocol,
				AppInstanceID:      in.AppInstanceID,
				ContinuationSecret: in.ContinuationSecret, ArmRequestID: in.ArmRequestID,
			})
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if replayed {
				httpx.WriteJSON(w, http.StatusOK, map[string]string{
					"appAccountToken": outcome.Attempt.AppleAccountToken,
					"attemptId":       outcome.Attempt.ID,
				})
				return
			}
		}
	}
	if enabled, err := s.applePurchasesEnabled(r.Context()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	} else if !enabled {
		writeAppleTransactionError(w, http.StatusConflict, "purchases_paused")
		return
	}
	target, ok, err := s.Store().AppleProductPlan(r.Context(), in.BundleID, in.ProductID)
	if err != nil {
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
	manage, err := s.applePurchaseMustBeManagedByApple(r.Context(), u.ID, target)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if manage {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "manage_with_apple", "provider": ProviderApple})
		return
	}
	candidate, err := newAppAccountToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	authorities, ok := s.Store().(interface {
		AcquireBillingAuthority(context.Context, BillingAuthorityRequest) (BillingAuthority, error)
		ArmAppleBillingPurchase(context.Context, BillingAuthority, AppleDispatchRequest) (AppleDispatchOutcome, error)
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
	outcome, err := authorities.ArmAppleBillingPurchase(r.Context(), authority, AppleDispatchRequest{
		ProductID: in.ProductID, CandidateToken: candidate,
		ContinuationProtocol: in.ContinuationProtocol,
		AppInstanceID:        in.AppInstanceID, ContinuationSecret: in.ContinuationSecret,
		ArmRequestID: in.ArmRequestID, Now: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if outcome.Refusal != "" {
		// `purchase_outcome_required` deliberately does NOT say this account has a
		// subscription. The attempt it names has moved no money: the sheet was
		// authorized and the client has not yet said what StoreKit did.
		status := http.StatusConflict
		if outcome.Refusal == appleRefusalCapabilityCode {
			status = http.StatusForbidden
		}
		httpx.WriteJSON(w, status, map[string]string{"error": outcome.Refusal, "provider": ProviderApple})
		return
	}
	body := map[string]string{"appAccountToken": outcome.Attempt.AppleAccountToken, "attemptId": outcome.Attempt.ID}
	// Only a compatible older initial request receives a server-minted raw
	// continuation secret. Current clients sent and persisted theirs before this
	// request, and neither an initial replay nor a resume echoes it.
	if outcome.Secret != "" {
		body["continuationSecret"] = outcome.Secret
	}
	httpx.WriteJSON(w, http.StatusOK, body)
}

// handleApplePurchaseOutcome records what StoreKit actually did with a sheet
// this server authorized.
//
// It accepts ONLY the exact continuation capability -- same user, bundle,
// attempt, authority generation, app instance, a secret whose SHA-256 matches
// the stored verifier under crypto/subtle, and the `armRequestId` of the arm
// that is CURRENTLY open. Account authentication alone is not enough, and
// neither is possession of the appAccountToken.
//
// The arm id is what makes this a report about one SHEET rather than about one
// client: every other fact survives a resume unchanged, so a duplicate report
// issued before an earlier resume would otherwise still authenticate and could
// move a live armed attempt back to cancelled, authorizing a second sheet while
// the first could still charge. A report naming any previous arm is refused with
// the same uniform answer as a wrong secret.
//
// The report is a capability-authored ASSERTION, not signed provider proof:
// Apple signs transactions, never the absence of one. It is therefore trusted
// for exactly one thing -- releasing a dispatch the same capability holder
// armed -- and grants, finishes and prices nothing. Only `userCancelled` becomes
// resumable; `pending`, an error, an unknown result and silence stay locked.
func (s *Service) handleApplePurchaseOutcome(w http.ResponseWriter, r *http.Request, u User) {
	if s.appleTx == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "verifier_unavailable")
		return
	}
	var in struct {
		BundleID           string `json:"bundleId"`
		AttemptID          string `json:"attemptId"`
		AppInstanceID      string `json:"appInstanceId"`
		ArmRequestID       string `json:"armRequestId"`
		ContinuationSecret string `json:"continuationSecret"`
		Outcome            string `json:"outcome"`
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
	if in.AttemptID == "" || !validAppleOutcome(in.Outcome) ||
		!validAppleContinuationID(in.AppInstanceID) || !validAppleContinuationID(in.ArmRequestID) ||
		in.ContinuationSecret == "" {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	outcomes, ok := s.Store().(interface {
		RecordAppleBillingPurchaseOutcome(context.Context, AppleOutcomeRequest) (AppleOutcomeResult, error)
	})
	if !ok {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	res, err := outcomes.RecordAppleBillingPurchaseOutcome(r.Context(), AppleOutcomeRequest{
		UserID: u.ID, AttemptID: in.AttemptID, BundleID: in.BundleID,
		AppInstanceID: in.AppInstanceID, ContinuationSecret: in.ContinuationSecret,
		ArmRequestID: in.ArmRequestID, Outcome: in.Outcome, Now: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !res.Accepted {
		// One uniform answer for every capability failure, so this endpoint is not
		// an oracle for which particular fact was wrong. No part of the presented
		// material is logged.
		writeAppleTransactionError(w, http.StatusForbidden, appleRefusalCapabilityCode)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"resumable": res.Resumable})
}

// applePurchaseMustBeManagedByApple keeps unproven deferred subscription-group
// transitions out of Relayium's purchase dispatch. A new subscription is safe;
// for an existing Apple subscription only a strictly higher tier is an
// immediate StoreKit purchase. Same-tier cycle changes and lower tiers take
// effect at renewal and must be changed in Apple's own management surface until
// their real Sandbox token/JWS shape has been observed and reviewed.
func (s *Service) applePurchaseMustBeManagedByApple(ctx context.Context, userID string, target AppleProduct) (bool, error) {
	source, ok, err := s.Store().GetSubscriptionSource(ctx, userID, ProviderApple)
	if err != nil || !ok || !source.stillBillingAt(s.now().Unix()) {
		return false, err
	}
	if source.ExternalScope != target.BundleID {
		return true, nil
	}
	if source.PlanID == target.PlanID {
		return true, nil
	}
	plans, err := s.applePlanFacts(ctx)
	if err != nil {
		return false, err
	}
	current, currentOK := plans[source.PlanID]
	next, nextOK := plans[target.PlanID]
	if !currentOK || !nextOK {
		return false, errors.New("apple purchase tier ordering unavailable")
	}
	return next.SortOrder <= current.SortOrder, nil
}
