package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/relayium/relayium/authx"
)

// ErrBillingAuthorityConflict means this account is already bound to another
// money-moving channel. It is permanent until server-verified provider facts or
// an audited operator migration explicitly change the authority.
var ErrBillingAuthorityConflict = errors.New("account: billing authority conflict")

type BillingAuthorityRequest struct {
	UserID, Provider, ExternalScope, AppleAccountToken string
	Now                                                int64
}

type BillingAuthority struct {
	UserID, Provider, ExternalScope, AppleEnvironment, AppleAccountToken, IntentID string
	Epoch, CreatedAt, UpdatedAt                                                    int64
}

type billingHistory struct {
	Provider, ExternalScope, AppleAccountToken string
}

const billingUnknownAppleScope = "legacy-unknown"

func billingHistoryTx(ctx context.Context, tx *sql.Tx, userID string) (billingHistory, error) {
	var planSource, stripeCustomerID, stripeSubscriptionID, appleAccountToken string
	if err := tx.QueryRowContext(ctx, `SELECT plan_source,stripe_customer_id,stripe_subscription_id,apple_account_token FROM users WHERE id=?`, userID).
		Scan(&planSource, &stripeCustomerID, &stripeSubscriptionID, &appleAccountToken); err != nil {
		return billingHistory{}, err
	}
	out := billingHistory{AppleAccountToken: appleAccountToken}
	rows, err := tx.QueryContext(ctx, `SELECT provider,external_scope FROM subscription_sources WHERE user_id=?`, userID)
	if err != nil {
		return billingHistory{}, err
	}
	for rows.Next() {
		var provider, scope string
		if err := rows.Scan(&provider, &scope); err != nil {
			rows.Close()
			return billingHistory{}, err
		}
		if !knownProvider(provider) || (out.Provider != "" && out.Provider != provider) {
			rows.Close()
			return billingHistory{}, ErrBillingAuthorityConflict
		}
		out.Provider = provider
		if provider == ProviderApple && scope != "" {
			if out.ExternalScope != "" && out.ExternalScope != scope {
				rows.Close()
				return billingHistory{}, ErrBillingAuthorityConflict
			}
			out.ExternalScope = scope
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return billingHistory{}, err
	}
	if err := rows.Close(); err != nil {
		return billingHistory{}, err
	}
	if stripeCustomerID != "" || stripeSubscriptionID != "" || planSource == ProviderStripe {
		if out.Provider != "" && out.Provider != ProviderStripe {
			return billingHistory{}, ErrBillingAuthorityConflict
		}
		out.Provider = ProviderStripe
	}
	if planSource == ProviderApple {
		if out.Provider != "" && out.Provider != ProviderApple {
			return billingHistory{}, ErrBillingAuthorityConflict
		}
		out.Provider = ProviderApple
	}
	if appleAccountToken != "" {
		if out.Provider != "" && out.Provider != ProviderApple {
			return billingHistory{}, ErrBillingAuthorityConflict
		}
		out.Provider = ProviderApple
	}
	if out.Provider == ProviderApple && out.ExternalScope == "" {
		out.ExternalScope = billingUnknownAppleScope
	}
	if out.Provider == ProviderApple && out.AppleAccountToken == "" {
		return billingHistory{}, ErrBillingAuthorityConflict
	}
	return out, nil
}

func backfillBillingAuthorities(ctx context.Context, db *sql.DB, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM users
 WHERE NOT EXISTS(SELECT 1 FROM billing_authorities WHERE user_id=users.id)
	   AND (stripe_customer_id<>'' OR stripe_subscription_id<>'' OR apple_account_token<>'' OR plan_source IN ('stripe','apple')
        OR EXISTS(SELECT 1 FROM subscription_sources WHERE user_id=users.id))`)
	if err != nil {
		return err
	}
	var userIDs []string
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return err
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, userID := range userIDs {
		history, err := billingHistoryTx(ctx, tx, userID)
		if err != nil {
			return fmt.Errorf("account: backfill billing authority for %s: %w", userID, err)
		}
		if history.Provider == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_authorities(user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`,
			userID, history.Provider, history.ExternalScope, "", history.AppleAccountToken, authx.NewID(), now, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// backfillLegacyAppleBillingSubjects retains pre-dispatch appAccountTokens as
// sticky ownership tombstones. They deliberately point at no real purchase
// attempt: a later renewal may update the same Apple authority, but it can
// never be mistaken for proof that a newly dispatched purchase completed.
func backfillLegacyAppleBillingSubjects(ctx context.Context, db *sql.DB, now int64) error {
	_, err := db.ExecContext(ctx, `INSERT INTO apple_billing_subjects
 (app_account_token,user_id,attempt_id,bundle_id,authority_epoch,created_at)
 SELECT lower(u.apple_account_token),u.id,'legacy:' || u.id,
        COALESCE(NULLIF(a.external_scope,''),?),COALESCE(a.epoch,0),?
 FROM users u LEFT JOIN billing_authorities a ON a.user_id=u.id AND a.provider='apple'
 WHERE u.apple_account_token<>''
	ON CONFLICT(app_account_token) DO NOTHING`, billingUnknownAppleScope, now)
	return err
}

func validateBillingPurchaseAttempts(ctx context.Context, db *sql.DB) error {
	var unsafe int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM billing_purchase_attempts
 WHERE provider='apple' AND state IN ('prepared','dispatched') AND apple_account_token=''`).Scan(&unsafe); err != nil {
		return err
	}
	if unsafe != 0 {
		return fmt.Errorf("account: %d unresolved Apple purchase attempts lack dispatch identity; manual isolation required", unsafe)
	}
	return nil
}

func backfillAppleBillingExternalSubjects(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `INSERT INTO apple_billing_external_subjects(environment,external_id,user_id,bundle_id)
 SELECT CASE WHEN external_id LIKE ? THEN ? ELSE ? END,external_id,user_id,external_scope
 FROM subscription_sources WHERE provider='apple' AND external_id<>'' AND external_scope<>''
 ON CONFLICT(environment,external_id) DO NOTHING`, appleSandboxExternalPrefix+"%", appleEnvSandbox, appleEnvProduction)
	return err
}

func acquireStoreBillingAuthority(ctx context.Context, store Store, in BillingAuthorityRequest) (BillingAuthority, error) {
	authorities, ok := store.(interface {
		AcquireBillingAuthority(context.Context, BillingAuthorityRequest) (BillingAuthority, error)
	})
	if !ok {
		return BillingAuthority{}, errors.New("account: billing authority store unavailable")
	}
	return authorities.AcquireBillingAuthority(ctx, in)
}

func (s *SQLiteStore) AcquireBillingAuthority(ctx context.Context, in BillingAuthorityRequest) (BillingAuthority, error) {
	if in.UserID == "" || (in.Provider != ProviderStripe && in.Provider != ProviderApple) ||
		(in.Provider == ProviderApple) != (in.ExternalScope != "") ||
		(in.Provider == ProviderApple) != (in.AppleAccountToken != "") {
		return BillingAuthority{}, fmt.Errorf("account: invalid billing authority request")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingAuthority{}, err
	}
	defer tx.Rollback()
	out, err := acquireBillingAuthorityTx(ctx, tx, in)
	if err != nil {
		return BillingAuthority{}, err
	}
	return out, tx.Commit()
}

func acquireBillingAuthorityTx(ctx context.Context, tx *sql.Tx, in BillingAuthorityRequest) (BillingAuthority, error) {
	if frozen, err := billingUserFrozenTx(ctx, tx, in.UserID, in.Now); err != nil {
		return BillingAuthority{}, err
	} else if frozen {
		return BillingAuthority{}, ErrBillingAuthorityConflict
	}
	var existing BillingAuthority
	err := tx.QueryRowContext(ctx, `SELECT user_id, provider, external_scope, apple_environment, apple_account_token, epoch, intent_id, created_at, updated_at FROM billing_authorities WHERE user_id=?`, in.UserID).
		Scan(&existing.UserID, &existing.Provider, &existing.ExternalScope, &existing.AppleEnvironment, &existing.AppleAccountToken, &existing.Epoch, &existing.IntentID, &existing.CreatedAt, &existing.UpdatedAt)
	if err == nil {
		// A pre-authority App Store token proves that Apple may already have
		// accepted an Ask-to-Buy purchase, but it cannot name the bundle until a
		// verified transaction arrives. Bind that deliberately sticky unknown
		// scope exactly once from the signed transaction; never use this path to
		// move a known bundle or a different token.
		if existing.Provider == ProviderApple && existing.ExternalScope == billingUnknownAppleScope &&
			in.Provider == ProviderApple && in.ExternalScope != "" &&
			existing.AppleAccountToken == in.AppleAccountToken {
			res, updateErr := tx.ExecContext(ctx, `UPDATE billing_authorities
 SET external_scope=?,updated_at=?
 WHERE user_id=? AND provider=? AND external_scope=? AND apple_account_token=? AND epoch=? AND intent_id=?`,
				in.ExternalScope, in.Now, existing.UserID, ProviderApple, billingUnknownAppleScope,
				existing.AppleAccountToken, existing.Epoch, existing.IntentID)
			if updateErr != nil {
				return BillingAuthority{}, updateErr
			}
			if n, updateErr := res.RowsAffected(); updateErr != nil || n != 1 {
				if updateErr != nil {
					return BillingAuthority{}, updateErr
				}
				return BillingAuthority{}, ErrBillingAuthorityConflict
			}
			existing.ExternalScope = in.ExternalScope
			existing.UpdatedAt = in.Now
		}
		if existing.Provider != in.Provider || existing.ExternalScope != in.ExternalScope ||
			(existing.Provider == ProviderStripe && existing.AppleAccountToken != in.AppleAccountToken) {
			return BillingAuthority{}, ErrBillingAuthorityConflict
		}
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return BillingAuthority{}, err
	}

	var planID, planSource string
	if err := tx.QueryRowContext(ctx, `SELECT plan_id,plan_source FROM users WHERE id=?`, in.UserID).Scan(&planID, &planSource); err != nil {
		return BillingAuthority{}, err
	}
	if planSource == SourceAdmin && planID != "" && planID != freePlanID {
		return BillingAuthority{}, ErrBillingAuthorityConflict
	}
	history, err := billingHistoryTx(ctx, tx, in.UserID)
	if err != nil {
		return BillingAuthority{}, err
	}
	if history.Provider != "" {
		if history.Provider != in.Provider ||
			(history.Provider == ProviderApple && history.ExternalScope != billingUnknownAppleScope && history.ExternalScope != in.ExternalScope) {
			return BillingAuthority{}, ErrBillingAuthorityConflict
		}
	}
	authorityToken := in.AppleAccountToken
	if history.Provider == ProviderApple && history.AppleAccountToken != "" {
		authorityToken = history.AppleAccountToken
	}
	intentID := authx.NewID()
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_authorities(user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`, in.UserID, in.Provider, in.ExternalScope, "", authorityToken, intentID, in.Now, in.Now); err != nil {
		return BillingAuthority{}, err
	}
	out := BillingAuthority{UserID: in.UserID, Provider: in.Provider, ExternalScope: in.ExternalScope, AppleAccountToken: authorityToken, Epoch: 1, IntentID: intentID, CreatedAt: in.Now, UpdatedAt: in.Now}
	return out, nil
}

var ErrBillingPurchaseAmbiguous = errors.New("account: billing purchase does not match dispatched intent")
var ErrAppleBillingSubjectDeleted = errors.New("account: apple billing subject belongs to a purged account")

func advanceBillingAuthorityGenerationTx(ctx context.Context, tx *sql.Tx, authority BillingAuthority, now int64) error {
	nextIntent := authx.NewID()
	res, err := tx.ExecContext(ctx, `UPDATE billing_authorities SET epoch=epoch+1,intent_id=?,updated_at=? WHERE user_id=? AND provider=? AND external_scope=? AND apple_environment=? AND apple_account_token=? AND epoch=? AND intent_id=?`,
		nextIntent, now, authority.UserID, authority.Provider, authority.ExternalScope,
		authority.AppleEnvironment, authority.AppleAccountToken, authority.Epoch, authority.IntentID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrBillingAuthorityConflict
	}
	return nil
}

func (s *SQLiteStore) BillingAuthority(ctx context.Context, userID string) (BillingAuthority, bool, error) {
	var out BillingAuthority
	err := s.reader().QueryRowContext(ctx, `SELECT user_id, provider, external_scope, apple_environment, apple_account_token, epoch, intent_id, created_at, updated_at FROM billing_authorities WHERE user_id=?`, userID).
		Scan(&out.UserID, &out.Provider, &out.ExternalScope, &out.AppleEnvironment, &out.AppleAccountToken, &out.Epoch, &out.IntentID, &out.CreatedAt, &out.UpdatedAt)
	if err == sql.ErrNoRows {
		return BillingAuthority{}, false, nil
	}
	return out, err == nil, err
}

// ApplyAuthorizedStripeLifecycle is the only Stripe source write path. It
// adopts a legacy canonical Stripe fact into the durable authority when no
// authority exists, and otherwise refuses cross-provider/admin writes before
// either entitlement or attempt state can move.
func (s *SQLiteStore) ApplyAuthorizedStripeLifecycle(ctx context.Context, ev SourceEvent) (SubscriptionApply, error) {
	if ev.Provider != ProviderStripe || ev.UserID == "" {
		return SubscriptionApply{}, ErrBillingAuthorityConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubscriptionApply{}, err
	}
	defer tx.Rollback()
	authority, err := acquireBillingAuthorityTx(ctx, tx, BillingAuthorityRequest{UserID: ev.UserID, Provider: ProviderStripe, Now: ev.Now})
	if err != nil {
		return SubscriptionApply{}, err
	}
	result, err := applySourceTx(ctx, tx, ev)
	if err != nil {
		return SubscriptionApply{}, err
	}
	if result.Applied && stripeAttemptMayConverge(ev.Status) && ev.BillingAttemptID != "" && ev.ExternalID != "" {
		res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts
 SET state='resolved', provider_subscription_id=CASE WHEN provider_subscription_id='' THEN ? ELSE provider_subscription_id END
 WHERE id=? AND user_id=? AND epoch=? AND provider=? AND state='dispatched'
   AND provider_session_id<>''
   AND (provider_subscription_id='' OR provider_subscription_id=?)
   AND (?='' OR product_id=?)`, ev.ExternalID, ev.BillingAttemptID, ev.UserID, authority.Epoch, ProviderStripe, ev.ExternalID, ev.BillingProductID, ev.BillingProductID)
		if err != nil {
			return SubscriptionApply{}, err
		}
		_, _ = res.RowsAffected()
	}
	return result, tx.Commit()
}

func stripeAttemptMayConverge(status string) bool {
	switch status {
	case "active", "trialing", "past_due", "incomplete_expired", "canceled":
		return true
	default:
		return false
	}
}

type BillingPurchaseAttempt struct {
	ID, UserID, Provider, ExternalScope, ProductID, State, ProviderURL, ProviderSessionID, ProviderSubscriptionID string
	AppleAccountToken                                                                                             string
	Epoch, CreatedAt                                                                                              int64
}

type AppleBillingSubject struct {
	AppAccountToken, UserID, AttemptID, BundleID, Environment string
	AuthorityEpoch, CreatedAt, DeletedAt                      int64
}

type AppleBillingExternalSubject struct {
	ExternalID, Environment, UserID, BundleID string
	DeletedAt                                 int64
}

// DispatchBillingPurchase atomically grants the one external dispatch allowed
// for an authority generation. A retry receives the existing attempt with
// created=false and must reconcile it instead of calling the provider again.
func (s *SQLiteStore) DispatchBillingPurchase(ctx context.Context, authority BillingAuthority, productID string, now int64) (BillingPurchaseAttempt, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	defer tx.Rollback()
	if frozen, err := billingUserFrozenTx(ctx, tx, authority.UserID, now); err != nil || frozen {
		if err != nil {
			return BillingPurchaseAttempt{}, false, err
		}
		return BillingPurchaseAttempt{}, false, ErrBillingAuthorityConflict
	}
	var current BillingAuthority
	if err := tx.QueryRowContext(ctx, `SELECT user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at FROM billing_authorities WHERE user_id=?`, authority.UserID).
		Scan(&current.UserID, &current.Provider, &current.ExternalScope, &current.AppleEnvironment, &current.AppleAccountToken, &current.Epoch, &current.IntentID, &current.CreatedAt, &current.UpdatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	if current != authority {
		return BillingPurchaseAttempt{}, false, ErrBillingAuthorityConflict
	}
	var out BillingPurchaseAttempt
	err = tx.QueryRowContext(ctx, `SELECT id,user_id,provider,external_scope,product_id,state,provider_ref,provider_session_id,provider_subscription_id,apple_account_token,epoch,created_at FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND state IN ('prepared','dispatched')`, authority.UserID, authority.Epoch).
		Scan(&out.ID, &out.UserID, &out.Provider, &out.ExternalScope, &out.ProductID, &out.State, &out.ProviderURL, &out.ProviderSessionID, &out.ProviderSubscriptionID, &out.AppleAccountToken, &out.Epoch, &out.CreatedAt)
	if err == nil {
		return out, false, nil
	}
	if err != sql.ErrNoRows {
		return BillingPurchaseAttempt{}, false, err
	}
	out = BillingPurchaseAttempt{ID: authx.NewID(), UserID: authority.UserID, Provider: authority.Provider, ExternalScope: authority.ExternalScope, ProductID: productID, State: "dispatched", Epoch: authority.Epoch, CreatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_purchase_attempts(id,user_id,provider,external_scope,product_id,state,provider_ref,epoch,created_at) VALUES(?,?,?,?,?,'dispatched','',?,?)`, out.ID, out.UserID, out.Provider, out.ExternalScope, out.ProductID, out.Epoch, out.CreatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	return out, true, tx.Commit()
}

// DispatchAppleBillingPurchase and the Apple attempt state machine live in
// billing_apple_attempt.go: what may re-open a StoreKit sheet is now a bound
// continuation capability rather than a bare retry, and keeping that decision in
// one auditable file is the point.

func appleBillingSubjectTx(ctx context.Context, tx *sql.Tx, token string) (AppleBillingSubject, bool, error) {
	if !validAppAccountToken(token) {
		return AppleBillingSubject{}, false, nil
	}
	var out AppleBillingSubject
	err := tx.QueryRowContext(ctx, `SELECT app_account_token,user_id,attempt_id,bundle_id,authority_epoch,environment,created_at,deleted_at FROM apple_billing_subjects WHERE app_account_token=?`, strings.ToLower(token)).Scan(&out.AppAccountToken, &out.UserID, &out.AttemptID, &out.BundleID, &out.AuthorityEpoch, &out.Environment, &out.CreatedAt, &out.DeletedAt)
	if err == sql.ErrNoRows {
		return AppleBillingSubject{}, false, nil
	}
	return out, err == nil, err
}

func (s *SQLiteStore) AppleBillingSubjectByToken(ctx context.Context, token string) (AppleBillingSubject, bool, error) {
	if !validAppAccountToken(token) {
		return AppleBillingSubject{}, false, nil
	}
	var out AppleBillingSubject
	err := s.reader().QueryRowContext(ctx, `SELECT app_account_token,user_id,attempt_id,bundle_id,authority_epoch,environment,created_at,deleted_at FROM apple_billing_subjects WHERE app_account_token=?`, strings.ToLower(token)).Scan(&out.AppAccountToken, &out.UserID, &out.AttemptID, &out.BundleID, &out.AuthorityEpoch, &out.Environment, &out.CreatedAt, &out.DeletedAt)
	if err == sql.ErrNoRows {
		return AppleBillingSubject{}, false, nil
	}
	return out, err == nil, err
}

func (s *SQLiteStore) AppleBillingExternalSubjectByIdentity(ctx context.Context, environment, externalID string) (AppleBillingExternalSubject, bool, error) {
	if !appleSupportedEnvironment(environment) || externalID == "" {
		return AppleBillingExternalSubject{}, false, nil
	}
	var out AppleBillingExternalSubject
	err := s.reader().QueryRowContext(ctx, `SELECT external_id,environment,user_id,bundle_id,deleted_at FROM apple_billing_external_subjects WHERE environment=? AND external_id=?`, environment, externalID).
		Scan(&out.ExternalID, &out.Environment, &out.UserID, &out.BundleID, &out.DeletedAt)
	if err == sql.ErrNoRows {
		return AppleBillingExternalSubject{}, false, nil
	}
	return out, err == nil, err
}

func (s *SQLiteStore) SetBillingPurchaseProviderSession(ctx context.Context, userID, attemptID, sessionID, checkoutURL string) error {
	if !strings.HasPrefix(sessionID, "cs_") || checkoutURL == "" {
		return errors.New("account: invalid billing provider session")
	}
	res, err := s.db.ExecContext(ctx, `UPDATE billing_purchase_attempts SET provider_session_id=?,provider_ref=? WHERE id=? AND user_id=? AND state='dispatched' AND (provider_session_id='' OR provider_session_id=?) AND (provider_ref='' OR provider_ref=?)`, sessionID, checkoutURL, attemptID, userID, sessionID, checkoutURL)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrBillingAuthorityConflict
	}
	return nil
}

func (s *SQLiteStore) BindStripePurchaseSubscription(ctx context.Context, userID, attemptID, sessionID, subscriptionID string) error {
	if attemptID == "" || !strings.HasPrefix(sessionID, "cs_") || !strings.HasPrefix(subscriptionID, "sub_") {
		return ErrBillingPurchaseAmbiguous
	}
	res, err := s.db.ExecContext(ctx, `UPDATE billing_purchase_attempts SET provider_subscription_id=? WHERE id=? AND user_id=? AND provider='stripe' AND state='dispatched' AND provider_session_id=? AND (provider_subscription_id='' OR provider_subscription_id=?)`, subscriptionID, attemptID, userID, sessionID, subscriptionID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}
	// The dispatched CAS matched nothing. That is normally genuine ambiguity,
	// but Stripe does not order webhook deliveries: customer.subscription.*
	// can arrive first, and ApplyAuthorizedStripeLifecycle may already have
	// moved this exact attempt to 'resolved' with this exact subscription. A
	// later — or redelivered — checkout.session.completed would then find
	// nothing in 'dispatched' and fail forever. So prove the attempt is
	// already exactly what this event asks for (same user, attempt, Stripe
	// provider, session, and the same subscription, both ids prefix-validated
	// above and therefore non-empty) and report idempotent success.
	//
	// 'resolved' is deliberately NOT folded into the UPDATE above: this read
	// grants nothing and writes nothing. A resolved attempt whose subscription
	// is empty or different stays ErrBillingPurchaseAmbiguous, so an abandoned
	// Checkout can never acquire a subscription through this path.
	var bound int
	readErr := s.reader().QueryRowContext(ctx, `SELECT 1 FROM billing_purchase_attempts WHERE id=? AND user_id=? AND provider='stripe' AND state='resolved' AND provider_session_id=? AND provider_subscription_id=?`, attemptID, userID, sessionID, subscriptionID).Scan(&bound)
	if readErr == nil && bound == 1 {
		return nil
	}
	if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
		return readErr
	}
	return ErrBillingPurchaseAmbiguous
}

// PrepareBillingPurchase creates at most one unresolved provider dispatch for
// the current authority generation. A retry receives the existing attempt and
// must reconcile it; it is not permission to call the provider again.
func (s *SQLiteStore) PrepareBillingPurchase(ctx context.Context, authority BillingAuthority, productID string, now int64) (BillingPurchaseAttempt, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	defer tx.Rollback()
	if frozen, err := billingUserFrozenTx(ctx, tx, authority.UserID, now); err != nil || frozen {
		if err != nil {
			return BillingPurchaseAttempt{}, false, err
		}
		return BillingPurchaseAttempt{}, false, ErrBillingAuthorityConflict
	}
	var current BillingAuthority
	if err := tx.QueryRowContext(ctx, `SELECT user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at FROM billing_authorities WHERE user_id=?`, authority.UserID).
		Scan(&current.UserID, &current.Provider, &current.ExternalScope, &current.AppleEnvironment, &current.AppleAccountToken, &current.Epoch, &current.IntentID, &current.CreatedAt, &current.UpdatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	if current != authority {
		return BillingPurchaseAttempt{}, false, ErrBillingAuthorityConflict
	}
	var out BillingPurchaseAttempt
	err = tx.QueryRowContext(ctx, `SELECT id,user_id,provider,external_scope,product_id,state,provider_ref,provider_session_id,provider_subscription_id,apple_account_token,epoch,created_at FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND state IN ('prepared','dispatched')`, authority.UserID, authority.Epoch).
		Scan(&out.ID, &out.UserID, &out.Provider, &out.ExternalScope, &out.ProductID, &out.State, &out.ProviderURL, &out.ProviderSessionID, &out.ProviderSubscriptionID, &out.AppleAccountToken, &out.Epoch, &out.CreatedAt)
	if err == nil {
		return out, false, nil
	}
	if err != sql.ErrNoRows {
		return BillingPurchaseAttempt{}, false, err
	}
	out = BillingPurchaseAttempt{ID: authx.NewID(), UserID: authority.UserID, Provider: authority.Provider, ExternalScope: authority.ExternalScope, ProductID: productID, State: "prepared", Epoch: authority.Epoch, CreatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_purchase_attempts(id,user_id,provider,external_scope,product_id,state,provider_ref,epoch,created_at) VALUES(?,?,?,?,?,'prepared','',?,?)`, out.ID, out.UserID, out.Provider, out.ExternalScope, out.ProductID, out.Epoch, out.CreatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	return out, true, tx.Commit()
}

func (s *SQLiteStore) MarkBillingPurchaseDispatched(ctx context.Context, userID, attemptID string, epoch int64) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var now int64
	if err := tx.QueryRowContext(ctx, `SELECT unixepoch()`).Scan(&now); err != nil {
		return false, err
	}
	frozen, err := billingUserFrozenTx(ctx, tx, userID, now)
	if err != nil {
		return false, err
	}
	if frozen {
		return false, ErrBillingAuthorityConflict
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts SET state='dispatched' WHERE id=? AND user_id=? AND epoch=? AND state='prepared'`, attemptID, userID, epoch)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return n == 1, nil
}
