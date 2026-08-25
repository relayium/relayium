package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/relayium/relayium/httpx"
)

// POST /api/billing/apple/transaction — the authenticated intake for a signed
// App Store transaction.
//
// THE SHAPE OF THE TRUST. A native client submits `signedTransactionInfo`
// exactly as StoreKit handed it over: one compact JWS, unmodified. The client's
// own StoreKit verification result is not an input and is not asked for — it
// runs on the device, and a device is the thing being authenticated, not the
// thing being trusted. Everything this handler grants comes from three places:
//
//  1. Apple's signature, chained to trust roots THIS server was configured with;
//  2. this server's own product catalog (which tier, which cycle);
//  3. this server's own app-account token (which Relayium account).
//
// Nothing else. There is no field in the request body but the JWS, so there is
// nothing else a client could assert.
//
// WHAT IT IS NOT, YET. No purchase happens here — this is intake for a
// StoreKit flow that does not exist in this batch, and with no trust roots and
// no product mappings configured (the shipping default) it answers 503 and
// changes nothing.
const appleTransactionBodyLimit = 16 << 10

// appleTransactionResult is the whole success body: the effective entitlement
// the caller now holds. It deliberately echoes nothing back — not the JWS, not
// the account token, not the transaction ids — because a response is the one
// place where returning an identifier is indistinguishable from confirming it.
type appleTransactionResult struct {
	// Applied is false when the transaction was correct but older than what is
	// already recorded (a redelivery of a previous period). The state reported
	// alongside it is then the CURRENT one, not what the stale event would have
	// produced.
	Applied                   bool   `json:"applied"`
	PlanID                    string `json:"planId"`
	Status                    string `json:"status"`
	ExpiresAt                 int64  `json:"expiresAt"`
	Provider                  string `json:"provider"`
	CurrentProductID          string `json:"currentProductId"`
	AutoRenewProductID        string `json:"autoRenewProductId"`
	RenewalAt                 int64  `json:"renewalAt"`
	DispatchPending           bool   `json:"dispatchPending"`
	DispatchResolved          bool   `json:"dispatchResolved"`
	DispatchResolvedAttemptID string `json:"dispatchResolvedAttemptId"`
}

func writeAppleTransactionError(w http.ResponseWriter, status int, code string) {
	httpx.WriteJSON(w, status, map[string]string{"error": code})
}

// handleAppleTransaction verifies one submitted transaction and, only then,
// applies an Apple subscription source to the AUTHENTICATED caller.
//
// The error vocabulary is deliberately coarse where verification is concerned:
// every cryptographic, identity and catalog refusal is one `invalid_transaction`
// (400), because a per-reason answer is a tool for shaping the next attempt.
// The specific reason is logged as a fixed code that quotes none of the
// submitted material. The three answers that ARE distinct describe situations a
// client must handle differently: `token_mismatch` (403 — this purchase belongs
// to another account), `subscription_owned` (409 — this subscription already
// belongs to another Relayium account), `apple_subscription_conflict` (409 —
// this Relayium account already has another live Apple subscription), and
// `verifier_unavailable` (503 — this deployment cannot verify anything). An
// unexpected storage failure stays a 500.
func (s *Service) handleAppleTransaction(w http.ResponseWriter, r *http.Request, u User) {
	verifier := s.appleTx
	if verifier == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "verifier_unavailable")
		return
	}
	var in struct {
		SignedTransactionInfo string `json:"signedTransactionInfo"`
		SignedRenewalInfo     string `json:"signedRenewalInfo"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, appleTransactionBodyLimit))
	// One field, and only that field: an unknown key is either a client sending
	// something this endpoint does not implement, or an attempt to smuggle a
	// second assertion alongside the JWS. Both are better refused than ignored.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// One JSON document per request. A second Decode that does not report EOF
	// found something after it — dec.More() would miss trailing bytes that do
	// not begin another value, and either way the meaning of the request would
	// depend on where the reader stopped.
	if err := dec.Decode(new(json.RawMessage)); err != io.EOF {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// NOT trimmed. Verifying a normalized copy of what the client sent means the
	// bytes checked are not the bytes submitted; the compact serialization has
	// no whitespace in it, so a request carrying some is malformed, not untidy.
	signed := in.SignedTransactionInfo
	if signed == "" || strings.TrimSpace(signed) != signed || strings.TrimSpace(in.SignedRenewalInfo) != in.SignedRenewalInfo {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	now := s.now()
	tx, err := verifier.Verify(signed, now)
	if err != nil {
		// The code names the rule that refused it; the material that broke the
		// rule never reaches the log.
		log.Printf("billing: apple transaction refused for user %s (%s)", u.ID, appleRejectionCode(err))
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_transaction")
		return
	}
	// signedRenewalInfo is accepted on the wire for released clients, but never
	// decides this request. It describes FUTURE renewal intent and the client can
	// select any genuine status JWS it can read. CanonicalSubscription below
	// obtains and verifies the current renewal projection directly from Apple;
	// only that server-fetched value may update renewal state or billing grace.
	if in.SignedRenewalInfo != "" {
		if _, renewalErr := verifier.VerifyRenewalInfo(in.SignedRenewalInfo, tx, now); renewalErr != nil {
			log.Printf("billing: apple renewal info ignored for user %s (%s)", u.ID, appleRejectionCode(renewalErr))
		}
	}
	preOwner, ok, err := s.appleTokenOwner(r.Context(), tx.AppAccountToken)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || preOwner.ID != u.ID {
		writeAppleTransactionError(w, http.StatusForbidden, "token_mismatch")
		return
	}
	if s.appleSubscriptions == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "reconciliation_unavailable")
		return
	}
	canonical, err := s.appleSubscriptions.CanonicalSubscription(r.Context(), tx, now)
	if err != nil {
		log.Printf("billing: canonical apple subscription refresh for user %s failed: %v", u.ID, err)
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "reconciliation_unavailable")
		return
	}
	if canonical.Transaction.OriginalTransactionID != tx.OriginalTransactionID ||
		canonical.Transaction.Environment != tx.Environment || canonical.Transaction.BundleID != tx.BundleID || canonical.Transaction.AppAccountToken != tx.AppAccountToken {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "reconciliation_unavailable")
		return
	}
	tx = canonical.Transaction

	// WHOSE PURCHASE IS THIS? The token inside the verified payload is an
	// attribution key the server issued; it is resolved here and compared with
	// the caller resolved by RequireAuth. Possession is not authority: an
	// unauthenticated submitter never reaches this line, and an authenticated one
	// may claim only the token their own account holds.
	//
	// The resolution is stable rather than transactional by construction:
	// EnsureAppleAccountToken is first-write-wins and never rebinds, so the
	// answer cannot move between this lookup and the write below. What DOES need
	// to be atomic — binding this subscription to this user in the same
	// transaction as the entitlement it grants — is ApplySubscriptionSource's
	// contract, used below.
	owner, ok, err := s.appleTokenOwner(r.Context(), tx.AppAccountToken)
	if err != nil {
		log.Printf("billing: resolving an apple account token for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || owner.ID != u.ID {
		log.Printf("billing: apple transaction refused for user %s (app_account_token_owner)", u.ID)
		writeAppleTransactionError(w, http.StatusForbidden, "token_mismatch")
		return
	}

	// WHICH TIER? Only the server's catalog answers that, keyed by bundle AND
	// product id so the macOS and iOS products cannot be confused for each other.
	// An unmapped or retired product is refused: by the time we are here the
	// money has already moved, and there is no safe way to guess a tier.
	product, ok, err := s.Store().AppleProductPlan(r.Context(), tx.BundleID, tx.ProductID)
	if err != nil {
		log.Printf("billing: resolving an apple product for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		log.Printf("billing: apple transaction refused for user %s (product_unmapped)", u.ID)
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_transaction")
		return
	}
	renewalState, err := s.appleRenewalProjection(r.Context(), u.ID, tx, canonical.Renewal, now)
	if err != nil {
		log.Printf("billing: reading apple renewal state for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	atomic, ok := s.Store().(interface {
		ApplyAuthorizedAppleLifecycle(context.Context, SourceEvent, AppleRenewalState, string, string) (SubscriptionApply, error)
		ApplyAuthorizedAppleSource(context.Context, SourceEvent, string, string, string) (SubscriptionApply, error)
	})
	if !ok {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// SourceEvent.AppleDispatchPurchase / .AppleDispatchProductID are no longer
	// set. Resolving a dispatch on transactionReason=="PURCHASE" and an exactly
	// matching product stranded every restore-after-renewal and every
	// already-accounted submission; resolution is now ownership convergence in
	// applyAuthorizedAppleLifecycle. The two fields stay declared in
	// entitlement.go, which is outside this lease's writable scope, and are
	// recorded as a follow-up removal.
	event := appleSourceEvent(u.ID, tx, product, now)
	var res SubscriptionApply
	if renewalState.UserID != "" {
		event = appleSourceEventWithRenewal(u.ID, tx, product, renewalState, now)
		res, err = atomic.ApplyAuthorizedAppleLifecycle(r.Context(), event, renewalState, tx.AppAccountToken, tx.Environment)
	} else {
		res, err = atomic.ApplyAuthorizedAppleSource(r.Context(), event, tx.AppAccountToken, tx.Environment, tx.ProductID)
	}
	switch {
	case errors.Is(err, ErrBillingAuthorityConflict), errors.Is(err, ErrBillingPurchaseAmbiguous):
		writeAppleTransactionError(w, http.StatusConflict, "billing_authority_conflict")
		return
	case errors.Is(err, ErrExternalSubscriptionOwned):
		// One App Store subscription, one Relayium account. The apply wrote
		// nothing, so there is no half-granted tier to undo.
		log.Printf("billing: apple transaction refused for user %s (external_subscription_owned)", u.ID)
		writeAppleTransactionError(w, http.StatusConflict, "subscription_owned")
		return
	case errors.Is(err, ErrAppleSubscriptionConflict):
		// This account already has a live Apple subscription. Calling this
		// "owned by another Relayium account" would send the customer to the
		// wrong recovery path and hide a possible double charge.
		log.Printf("billing: apple transaction refused for user %s (apple_subscription_conflict)", u.ID)
		writeAppleTransactionError(w, http.StatusConflict, "apple_subscription_conflict")
		return
	case err != nil:
		log.Printf("billing: applying an apple subscription for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if res.PurchaseAttemptPending && !res.PurchaseAttemptResolved {
		writeAppleTransactionError(w, http.StatusConflict, "purchase_reconciliation_required")
		return
	}
	// This account has just presented a verified transaction for this
	// subscription under its own attribution token, which is exactly the fact any
	// notification deferred for want of an owner was waiting for. Apple routinely
	// delivers a notification before the purchasing client finishes its own round
	// trip, so this is the ordinary drain point rather than an exceptional one.
	//
	// The drain does NOT rely on the apply above having bound anything — a stale
	// event binds nothing and still reaches this line. It does not need to:
	// every replay goes through ApplySubscriptionSource, which settles ownership
	// of the external subscription id inside the same transaction that would
	// grant on it. A subscription owned by somebody else is refused there and the
	// deferred row stays put, so the worst this can do on a stale event is
	// nothing.
	//
	// Best effort and deliberately after the apply: the caller's own result is
	// already durable, and a failure here leaves every deferred row exactly where
	// it was, still replayable.
	s.reconcileApplePendingNotifications(r.Context(), u.ID, appleSubscriptionKeyOf(tx), now)

	httpx.WriteJSON(w, http.StatusOK, appleTransactionResult{
		Applied:                   res.Applied,
		PlanID:                    res.Effective.PlanID,
		Status:                    res.Effective.Status,
		ExpiresAt:                 res.Effective.PeriodEnd,
		Provider:                  res.Effective.Source,
		CurrentProductID:          tx.ProductID,
		AutoRenewProductID:        renewalState.AutoRenewProductID,
		RenewalAt:                 renewalState.RenewalAt,
		DispatchPending:           res.PurchaseAttemptPending,
		DispatchResolved:          res.PurchaseAttemptResolved,
		DispatchResolvedAttemptID: res.PurchaseAttemptResolvedID,
	})
}

func (s *Service) appleTokenOwner(ctx context.Context, token string) (User, bool, error) {
	subject, found, err := s.Store().AppleBillingSubjectByToken(ctx, token)
	if err != nil {
		return User{}, false, err
	}
	if found {
		if subject.DeletedAt != 0 {
			return User{}, false, ErrAppleBillingSubjectDeleted
		}
		u, err := s.Store().GetUserByID(ctx, subject.UserID)
		if errors.Is(err, ErrNotFound) {
			return User{}, false, ErrAppleBillingSubjectDeleted
		}
		return u, err == nil, err
	}
	return s.Store().UserByAppleAccountToken(ctx, token)
}

func appleSourceEventWithRenewal(userID string, tx VerifiedAppleTransaction, product AppleProduct, renewal AppleRenewalState, now time.Time) SourceEvent {
	ev := appleSourceEvent(userID, tx, product, now)
	if !appleTransactionIsTerminal(tx) && renewal.graceActive(now) && renewal.GraceUntil > ev.PeriodEnd {
		ev.PlanID = product.PlanID
		ev.Status = "active"
		ev.Cycle = product.Cycle
		ev.PeriodEnd = renewal.GraceUntil
	}
	return ev
}

// appleSourceEvent turns a verified transaction plus the server's own product
// mapping into one provider event.
//
// STATUS AND ACCESS come from the verified fields alone. A terminal
// transaction — refunded or superseded by an upgrade — and one whose
// paid-through instant has passed both drop to the free tier with a dead
// status, so grantsAccess() is false for either; only a non-terminal
// transaction whose expiresDate is still ahead of `now` grants the mapped tier.
// The status vocabulary is Stripe's, because that is what
// SubscriptionSource.Status is defined as and what liveSubStatus reads —
// "canceled" is the existing spelling for "this source no longer pays".
//
// THE EVENT CLOCK is appleEventClock below.
//
// THE EXTERNAL ID is the environment-qualified subscription identity
// (apple_identity.go), not the bare originalTransactionId. A transaction whose
// identity cannot be qualified — an environment this server did not verify, or
// an id carrying the namespace separator — yields NO external id, which
// SourceEvent reads as "preserve whatever is recorded". That is the safe
// direction and it is unreachable from either live path: the verifier pins the
// environment to the configured set and refuses a separator in an id, and the
// replay path (reconcileApplePendingNotifications) skips a row it cannot
// qualify before it gets here.
func appleSourceEvent(userID string, tx VerifiedAppleTransaction, product AppleProduct, now time.Time) SourceEvent {
	externalID, _ := appleSubscriptionKeyOf(tx).externalID()
	ev := SourceEvent{
		UserID:        userID,
		Provider:      ProviderApple,
		ExternalScope: tx.BundleID,
		// Bound in the SAME transaction as the state it pays for. Apple's
		// originalTransactionId is the subscription's identity across every renewal
		// within one App Store, which — qualified by that store — is exactly what an
		// external subscription id must be.
		ExternalID:             externalID,
		PeriodEnd:              appleSeconds(tx.ExpiresDateMS),
		EventAt:                appleEventClock(tx),
		Now:                    now.Unix(),
		BillingProductID:       tx.ProductID,
		AppleTransactionReason: tx.TransactionReason,
		ApplePurchaseDateMS:    tx.PurchaseDateMS,
	}
	if !appleTransactionGrants(tx, now) {
		ev.PlanID = freePlanID
		ev.Status = "canceled"
		// '' leaves the recorded cycle alone (see SourceEvent.Cycle): a lapsed
		// subscription is not evidence that we no longer know what it was.
		ev.Cycle = ""
		return ev
	}
	ev.PlanID = product.PlanID
	ev.Status = "active"
	ev.Cycle = product.Cycle
	return ev
}

// appleTransactionGrants reports whether this transaction currently pays for
// anything: not ended by something recorded in it, and not yet past its
// paid-through instant.
//
// Extracted so the notification path can ask the question BEFORE looking up a
// product mapping — a transaction that no longer grants needs no tier, and
// making revocation depend on the catalog would mean a retired mapping silently
// disabled it (see appleNotificationProduct). One predicate, so the branch that
// decides whether a product is REQUIRED and the branch that decides what the
// event SAYS can never disagree about the same transaction.
func appleTransactionGrants(tx VerifiedAppleTransaction, now time.Time) bool {
	return !appleTransactionIsTerminal(tx) && tx.ExpiresDateMS > now.UnixMilli()
}

// appleTransactionIsTerminal reports whether this transaction has been ENDED by
// something recorded in it, as opposed to merely having run out of time.
//
// Two things end one: a refund (revocationDate) and an upgrade that replaced it
// (isUpgraded). Both mean the transaction will never grant again, whatever its
// expiresDate says. Expiry is deliberately NOT terminal — it is a fact about
// the clock, re-evaluated at every submission, and the same transaction is
// live before it and lapsed after.
func appleTransactionIsTerminal(tx VerifiedAppleTransaction) bool {
	return tx.RevocationDateMS > 0 || tx.IsUpgraded
}

// appleEventClock is the per-provider replay/order clock for one transaction.
//
// THE PROBLEM IT SOLVES. `purchaseDate` alone is not enough. A refund does not
// change the purchase date, so with a bare purchaseDate clock the live copy and
// the refunded copy of ONE transaction carry the SAME clock value — and the
// store's guard drops only strictly-older events. Replaying the live JWS after
// the refund would therefore be applied again and resurrect the entitlement
// somebody has already been given their money back for. The same hole exists
// for an upgraded transaction and its pre-upgrade copy.
//
// THE ENCODING. Order by purchaseDate — the GENERATION of the subscription this
// transaction is — and use the low bit as an "ended" flag within that
// generation:
//
//	live:     purchaseDate*2
//	terminal: purchaseDate*2 + 1
//
// Consequences, in the order they matter:
//
//   - replaying the live JWS after a refund is strictly older (2P < 2P+1) and is
//     dropped — the entitlement stays gone;
//   - redelivering the SAME form converges, because equal is not older;
//   - every LATER generation beats every earlier one, terminal or not, because
//     2P' > 2P+1 whenever P' > P. So a renewal supersedes a refunded earlier
//     period, and — the case that matters — a refund of an OLD period that
//     arrives after that renewal cannot cancel it.
//
// The revocation timestamp is deliberately NOT part of the ordering. Ordering
// by when the refund was RECORDED would let a refund of last month's period
// outrank this month's live renewal purely because the refund happened later in
// wall-clock time, cancelling a subscription the user is still paying for. What
// a refund ends is its own generation, and that is exactly what the low bit
// says. (RevocationDateMS is still read and still makes the transaction
// terminal — see appleTransactionIsTerminal; it just does not order anything.)
//
// Range: purchaseDate is bounded by appleMaxMillis (~2.5e14), so the doubled
// value is ~5.1e14 — four orders of magnitude inside int64, with no overflow
// to reason about.
func appleEventClock(tx VerifiedAppleTransaction) int64 {
	if appleTransactionIsTerminal(tx) {
		return tx.PurchaseDateMS*2 + 1
	}
	return tx.PurchaseDateMS * 2
}
