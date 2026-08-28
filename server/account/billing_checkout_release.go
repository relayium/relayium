package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Releasing an abandoned Stripe Checkout Session.
//
// A dispatched attempt is the one thing standing between a user and a second
// live subscription, so the existing code never retires it: a user who closed
// the Checkout tab is handed the same dead URL forever, and a user who comes
// back for a different tier is refused forever. Both are real, reported
// dead ends.
//
// The fix retires exactly one dead attempt, and only against canonical provider
// truth. Every rule below exists because the alternative is a double charge:
//
//   - Local state proves nothing. An attempt's age, its stored URL, and any
//     webhook we did or did not receive are all consistent with a Session the
//     customer is paying on RIGHT NOW. Stripe's own Session record is the only
//     authority, so the release is gated on a live GET of it.
//   - Terminal means terminal on Stripe's terms: `expired` AND `unpaid` AND
//     subscription mode AND our own livemode. An `open` Session is still
//     payable; a `complete` one already bought something.
//   - Absence of liability must be PROVEN, not assumed. `subscription`,
//     `invoice`, `payment_intent` and `setup_intent` must each be absent or
//     literally null. Anything else — a string, an expanded object, an empty
//     string — is a shape we did not predict, and an unpredicted shape next to
//     money is a block, not a default.
//   - Recovery lineage is liability too. `after_expiration` means Stripe may
//     hand the customer a recovery URL for this very Session after it expires,
//     and `recovered_from` means one already did. This client does not request
//     recovery today, but that is a property of one call site, not a guarantee
//     about the Session in front of us. The code makes no assumption about how
//     recovery is or is not configured: it reads the canonical field and blocks
//     on any non-null value.
//
// Anything short of that complete proof — a provider error, a missing field, an
// unexpected shape, a local mismatch — preserves the existing block WITHOUT
// touching local state. Fail-closed here costs a user one confused retry;
// fail-open costs them a duplicate subscription.
//
// The release itself grants nothing. It resolves one attempt and advances the
// authority generation in a single CAS, which is what re-opens the ordinary
// dispatch path. Entitlement, plan and subscription state are untouched: only a
// verified provider event may ever move those.

// canonicalAbandonedCheckout is the strict projection of a Stripe Checkout
// Session that the release predicate is allowed to reason about. It carries
// only proven-present values; every nullable liability field has already been
// proven absent-or-null by the parser, because a struct cannot represent the
// difference between "field was null" and "field was an object we ignored".
type canonicalAbandonedCheckout struct {
	ID                string
	Customer          string
	ClientReferenceID string
	MetadataUserID    string
	BillingAttemptID  string
	Status            string
	PaymentStatus     string
	Mode              string
	LiveMode          bool
	Created           int64
	ExpiresAt         int64
}

// canonicalCheckoutReader is an OPTIONAL provider capability, deliberately kept
// off the Biller interface. A Biller that cannot make this canonical read is
// not asked to fake one: it simply keeps the existing block. That is also why
// the release path treats a missing capability as "blocked" rather than as an
// error — no biller is ever forced into a release it cannot justify.
type canonicalCheckoutReader interface {
	// canonicalAbandonedCheckoutSession GETs the Session unexpanded and returns
	// it only when every field it must reason about is present in an expected
	// shape.
	canonicalAbandonedCheckoutSession(ctx context.Context, sessionID string) (canonicalAbandonedCheckout, error)
	// liveBillingMode is the mode this provider's configured key implies, so a
	// test-mode Session can never retire a live-mode attempt or vice versa.
	liveBillingMode() bool
}

func (c *stripeClient) liveBillingMode() bool { return c.wantLive }

func (c *stripeClient) canonicalAbandonedCheckoutSession(ctx context.Context, sessionID string) (canonicalAbandonedCheckout, error) {
	if !strings.HasPrefix(sessionID, "cs_") {
		return canonicalAbandonedCheckout{}, errors.New("stripe: abandoned checkout read needs a session id")
	}
	// No `expand`: the unexpanded shape is the one whose null fields carry the
	// meaning this decision depends on.
	body, err := c.request(ctx, http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(sessionID), nil)
	if err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	return parseCanonicalAbandonedCheckout(body)
}

// rawCheckoutSession keeps every field the decision touches as RawMessage, so
// the parser — not encoding/json's zero values — decides what an unexpected
// shape means. A `null` subscription and an expanded subscription object both
// unmarshal happily into a string field's zero value; only the raw bytes tell
// them apart, and here that difference is the difference between a dead Session
// and a live one.
type rawCheckoutSession struct {
	ID                json.RawMessage `json:"id"`
	Object            json.RawMessage `json:"object"`
	Customer          json.RawMessage `json:"customer"`
	ClientReferenceID json.RawMessage `json:"client_reference_id"`
	Status            json.RawMessage `json:"status"`
	PaymentStatus     json.RawMessage `json:"payment_status"`
	Mode              json.RawMessage `json:"mode"`
	LiveMode          json.RawMessage `json:"livemode"`
	Created           json.RawMessage `json:"created"`
	ExpiresAt         json.RawMessage `json:"expires_at"`

	Subscription    json.RawMessage `json:"subscription"`
	Invoice         json.RawMessage `json:"invoice"`
	PaymentIntent   json.RawMessage `json:"payment_intent"`
	SetupIntent     json.RawMessage `json:"setup_intent"`
	AfterExpiration json.RawMessage `json:"after_expiration"`
	RecoveredFrom   json.RawMessage `json:"recovered_from"`

	Metadata struct {
		UserID           json.RawMessage `json:"user_id"`
		BillingAttemptID json.RawMessage `json:"billing_attempt_id"`
	} `json:"metadata"`
}

// parseCanonicalAbandonedCheckout converts a raw Session body into the strict
// projection, refusing anything it cannot prove. Every return here is a block.
func parseCanonicalAbandonedCheckout(body []byte) (canonicalAbandonedCheckout, error) {
	var raw rawCheckoutSession
	if err := json.Unmarshal(body, &raw); err != nil {
		return canonicalAbandonedCheckout{}, fmt.Errorf("stripe: read abandoned checkout session: %w", err)
	}
	if object, err := requiredRawString(raw.Object, "object"); err != nil {
		return canonicalAbandonedCheckout{}, err
	} else if object != "checkout.session" {
		return canonicalAbandonedCheckout{}, fmt.Errorf("stripe: abandoned checkout read returned object %q", object)
	}
	// These four are the liability chain: any one of them being present means
	// Stripe has, or may still create, something chargeable for this Session.
	// after_expiration/recovered_from are the recovery lineage: a Session that
	// can be resurrected, or that already resurrected another, is not terminal.
	for _, field := range []struct {
		name string
		raw  json.RawMessage
	}{
		{"subscription", raw.Subscription},
		{"invoice", raw.Invoice},
		{"payment_intent", raw.PaymentIntent},
		{"setup_intent", raw.SetupIntent},
		{"after_expiration", raw.AfterExpiration},
		{"recovered_from", raw.RecoveredFrom},
	} {
		if !absentOrNull(field.raw) {
			return canonicalAbandonedCheckout{}, fmt.Errorf("stripe: abandoned checkout session carries %s", field.name)
		}
	}
	out := canonicalAbandonedCheckout{}
	var err error
	if out.ID, err = requiredRawString(raw.ID, "id"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.Customer, err = requiredRawString(raw.Customer, "customer"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.ClientReferenceID, err = requiredRawString(raw.ClientReferenceID, "client_reference_id"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.Status, err = requiredRawString(raw.Status, "status"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.PaymentStatus, err = requiredRawString(raw.PaymentStatus, "payment_status"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.Mode, err = requiredRawString(raw.Mode, "mode"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.MetadataUserID, err = requiredRawString(raw.Metadata.UserID, "metadata.user_id"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.BillingAttemptID, err = requiredRawString(raw.Metadata.BillingAttemptID, "metadata.billing_attempt_id"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.LiveMode, err = requiredRawBool(raw.LiveMode, "livemode"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.Created, err = requiredPositiveRawInt(raw.Created, "created"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	if out.ExpiresAt, err = requiredPositiveRawInt(raw.ExpiresAt, "expires_at"); err != nil {
		return canonicalAbandonedCheckout{}, err
	}
	return out, nil
}

// absentOrNull reports whether a field was omitted entirely or sent as literal
// null. An empty string, a string id and an expanded object are all "present"
// and therefore all block.
func absentOrNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

// requiredRawString accepts only a present, non-empty JSON string.
func requiredRawString(raw json.RawMessage, field string) (string, error) {
	if absentOrNull(raw) {
		return "", fmt.Errorf("stripe: abandoned checkout session has no %s", field)
	}
	var out string
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("stripe: abandoned checkout session %s is not a string", field)
	}
	if out == "" {
		return "", fmt.Errorf("stripe: abandoned checkout session %s is empty", field)
	}
	return out, nil
}

func requiredRawBool(raw json.RawMessage, field string) (bool, error) {
	if absentOrNull(raw) {
		return false, fmt.Errorf("stripe: abandoned checkout session has no %s", field)
	}
	var out bool
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, fmt.Errorf("stripe: abandoned checkout session %s is not a boolean", field)
	}
	return out, nil
}

// requiredPositiveRawInt accepts only a present, strictly positive JSON integer.
// A float, a numeric string, zero and any negative value are all refused.
func requiredPositiveRawInt(raw json.RawMessage, field string) (int64, error) {
	if absentOrNull(raw) {
		return 0, fmt.Errorf("stripe: abandoned checkout session has no %s", field)
	}
	var out int64
	if err := json.Unmarshal(raw, &out); err != nil {
		return 0, fmt.Errorf("stripe: abandoned checkout session %s is not an integer", field)
	}
	if out <= 0 {
		return 0, fmt.Errorf("stripe: abandoned checkout session %s is not positive", field)
	}
	return out, nil
}

// checkoutAttemptReleasable is the complete release predicate: it must be able
// to say, from canonical provider state alone, that this exact attempt's exact
// Session is dead and can never become chargeable. Every clause is an AND, and
// there is deliberately no "or the attempt is old enough" escape.
func checkoutAttemptReleasable(session canonicalAbandonedCheckout, attempt BillingPurchaseAttempt, userID, customerID string, wantLive bool) bool {
	if customerID == "" || !localCheckoutAttemptReleasable(attempt, userID) {
		return false
	}
	// Identity: this is the Session this attempt dispatched, for this customer,
	// this user and this attempt. Stripe returns whatever id was asked for, so
	// the ownership proof has to be read back off the response, not assumed
	// from the request.
	if session.ID != attempt.ProviderSessionID ||
		session.Customer != customerID ||
		session.ClientReferenceID != userID ||
		session.MetadataUserID != userID ||
		session.BillingAttemptID != attempt.ID {
		return false
	}
	// Terminality: expired and unpaid, in the mode we dispatched, on our side of
	// the live/test boundary.
	return session.Status == "expired" &&
		session.PaymentStatus == "unpaid" &&
		session.Mode == "subscription" &&
		session.LiveMode == wantLive &&
		session.Created > 0 &&
		session.ExpiresAt > 0
}

// localCheckoutAttemptReleasable is the half of the predicate that needs no
// provider call. It runs first so an attempt that could never be released — a
// prepared one, an Apple one, one with no Session, one that already carries a
// subscription — costs no Stripe request and, more importantly, can never
// reach the release CAS.
//
// The bound Stripe customer is deliberately NOT part of it: the store CAS has
// no customer to compare against, and inventing a placeholder to pass in would
// make this read like a check that is not actually happening. The customer
// belongs to the caller-side predicate, which is the only side that knows it.
func localCheckoutAttemptReleasable(attempt BillingPurchaseAttempt, userID string) bool {
	return userID != "" &&
		attempt.ID != "" &&
		attempt.UserID == userID &&
		attempt.Provider == ProviderStripe &&
		attempt.State == "dispatched" &&
		strings.HasPrefix(attempt.ProviderSessionID, "cs_") &&
		attempt.ProviderSubscriptionID == ""
}

// checkoutReleaseOutcome is what a release attempt actually established. The
// three cases must stay distinct because they imply three different safe
// responses, and collapsing the last two is a correctness bug: once the
// canonical read has PROVEN the stored Session expired, handing that Session's
// URL back to the browser is knowingly sending the user to a dead page.
type checkoutReleaseOutcome int

const (
	// checkoutReleaseBlocked: nothing was proven. The provider call failed, the
	// shape was unexpected, or the attempt was never a candidate. The stored
	// Session may well still be live, so the caller keeps exactly the behaviour
	// that shipped before this file existed.
	checkoutReleaseBlocked checkoutReleaseOutcome = iota
	// checkoutReleaseDone: this caller retired the attempt and advanced the
	// generation, so it may dispatch once.
	checkoutReleaseDone
	// checkoutReleaseLost: the Session was proven dead, but the CAS did not
	// apply — a concurrent release won, a webhook bound a subscription, the
	// account froze, or the authority moved. The old URL is known-dead and the
	// reason for the loss is NOT known, so the caller must neither return that
	// URL nor dispatch on an assumption about which of those happened.
	checkoutReleaseLost
)

// releaseAbandonedStripeCheckout retires one canonically dead attempt so the
// ordinary dispatch path can run again.
//
// Only a local write failure — where we cannot tell what the database did —
// surfaces as an error, and that fails the request closed rather than
// dispatching on top of an unknown state.
func (s *Service) releaseAbandonedStripeCheckout(ctx context.Context, u User, authority BillingAuthority, attempt BillingPurchaseAttempt, customerID string) (checkoutReleaseOutcome, error) {
	reader, ok := s.biller.(canonicalCheckoutReader)
	if !ok {
		return checkoutReleaseBlocked, nil
	}
	releaser, ok := s.Store().(interface {
		ReleaseAbandonedStripeCheckout(context.Context, BillingAuthority, BillingPurchaseAttempt, int64) (bool, error)
	})
	if !ok {
		return checkoutReleaseBlocked, nil
	}
	if authority.Provider != ProviderStripe || authority.UserID != u.ID || attempt.Epoch != authority.Epoch {
		return checkoutReleaseBlocked, nil
	}
	if customerID == "" || !localCheckoutAttemptReleasable(attempt, u.ID) {
		return checkoutReleaseBlocked, nil
	}
	session, err := reader.canonicalAbandonedCheckoutSession(ctx, attempt.ProviderSessionID)
	if err != nil {
		// Timeout, 5xx, 404, malformed body, unexpected field shape: we do not
		// know that this Session is dead, so the block stands and nothing local
		// moves.
		return checkoutReleaseBlocked, nil
	}
	if !checkoutAttemptReleasable(session, attempt, u.ID, customerID, reader.liveBillingMode()) {
		return checkoutReleaseBlocked, nil
	}
	// Past this line the Session is proven dead. Whatever the CAS does now, the
	// stored URL must never be served again.
	released, err := releaser.ReleaseAbandonedStripeCheckout(ctx, authority, attempt, s.Now().Unix())
	if err != nil {
		return checkoutReleaseBlocked, err
	}
	if released {
		return checkoutReleaseDone, nil
	}
	return checkoutReleaseLost, nil
}

// ReleaseAbandonedStripeCheckout is the single write of the whole recovery
// path: one IMMEDIATE transaction (the write pool's DSN sets _txlock=immediate)
// that resolves exactly the dispatched attempt the caller proved dead AND
// advances that exact authority generation, or does neither.
//
// Both halves must be one transaction. Resolving the attempt without advancing
// the epoch would leave the generation with no unresolved attempt and let a
// second dispatch open on it; advancing the epoch without resolving the attempt
// would strand a dispatched row that no later CAS can match. Both CASes are
// fully qualified, so a concurrent release, a webhook that resolved the attempt
// first, or an authority that moved underneath us all land on rows-affected 0
// and report "not released" — never a second release.
//
// It writes nothing else. No entitlement, plan, subscription, customer or
// source row is touched here, by design: this function ends a dead dispatch,
// it does not grant anything.
func (s *SQLiteStore) ReleaseAbandonedStripeCheckout(ctx context.Context, authority BillingAuthority, attempt BillingPurchaseAttempt, now int64) (bool, error) {
	if authority.Provider != ProviderStripe || authority.UserID == "" ||
		attempt.UserID != authority.UserID || attempt.Epoch != authority.Epoch ||
		!localCheckoutAttemptReleasable(attempt, authority.UserID) {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	// A frozen account is mid-deletion; it must not acquire a fresh dispatch
	// slot, even a legitimately earned one.
	frozen, err := billingUserFrozenTx(ctx, tx, authority.UserID, now)
	if err != nil {
		return false, err
	}
	if frozen {
		return false, nil
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts
 SET state='resolved'
 WHERE id=? AND user_id=? AND provider=? AND state='dispatched' AND epoch=?
   AND product_id=? AND provider_session_id=? AND provider_subscription_id=''`,
		attempt.ID, attempt.UserID, ProviderStripe, attempt.Epoch, attempt.ProductID, attempt.ProviderSessionID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n != 1 {
		return false, nil
	}
	if err := advanceBillingAuthorityGenerationTx(ctx, tx, authority, now); err != nil {
		if errors.Is(err, ErrBillingAuthorityConflict) {
			return false, nil
		}
		return false, err
	}
	// A commit error leaves the outcome unknown, which is the one thing the
	// caller must not treat as "blocked, carry on": it fails the request closed.
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}
