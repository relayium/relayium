package account

import (
	"context"
	"database/sql"
)

func applyAppleRenewalStateTx(ctx context.Context, tx *sql.Tx, r AppleRenewalState) (bool, error) {
	res, err := tx.ExecContext(ctx, `INSERT INTO apple_renewal_states
 (user_id,external_id,bundle_id,current_product_id,auto_renew_product_id,auto_renew_enabled,in_billing_retry,grace_until,renewal_at,event_at,updated_at,expiration_intent,price_increase_status)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(user_id) DO UPDATE SET external_id=excluded.external_id,bundle_id=excluded.bundle_id,
 current_product_id=excluded.current_product_id,auto_renew_product_id=excluded.auto_renew_product_id,
 auto_renew_enabled=excluded.auto_renew_enabled,in_billing_retry=excluded.in_billing_retry,
 grace_until=excluded.grace_until,renewal_at=excluded.renewal_at,event_at=excluded.event_at,updated_at=excluded.updated_at,
 expiration_intent=excluded.expiration_intent,price_increase_status=excluded.price_increase_status
 WHERE excluded.event_at > apple_renewal_states.event_at`, r.UserID, r.ExternalID, r.BundleID, r.CurrentProductID, r.AutoRenewProductID,
		appleBoolInt(r.AutoRenewEnabled), appleBoolInt(r.IsInBillingRetry), r.GraceUntil, r.RenewalAt, r.EventAt, r.UpdatedAt, r.ExpirationIntent, r.PriceIncreaseStatus)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// ApplyAppleLifecycle advances entitlement and renewal intent in one transaction.
// A conflict, stale source event or write failure leaves both projections unchanged.
func (s *SQLiteStore) ApplyAppleLifecycle(ctx context.Context, ev SourceEvent, r AppleRenewalState) (SubscriptionApply, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubscriptionApply{}, err
	}
	defer tx.Rollback()
	res, err := applySourceTx(ctx, tx, ev)
	if err != nil {
		return SubscriptionApply{}, err
	}
	if res.Applied {
		if _, err = applyAppleRenewalStateTx(ctx, tx, r); err != nil {
			return SubscriptionApply{}, err
		}
	}
	return res, tx.Commit()
}

func (s *SQLiteStore) ApplyAppleRenewalState(ctx context.Context, r AppleRenewalState) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	applied, err := applyAppleRenewalStateTx(ctx, tx, r)
	if err != nil {
		return false, err
	}
	return applied, tx.Commit()
}

func appleBoolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (s *SQLiteStore) GetAppleRenewalState(ctx context.Context, userID string) (AppleRenewalState, bool, error) {
	var r AppleRenewalState
	var retry, autoRenew int
	err := s.reader().QueryRowContext(ctx, `SELECT user_id,external_id,bundle_id,current_product_id,
 auto_renew_product_id,auto_renew_enabled,in_billing_retry,grace_until,renewal_at,event_at,updated_at,expiration_intent,price_increase_status
 FROM apple_renewal_states WHERE user_id=?`, userID).Scan(&r.UserID, &r.ExternalID, &r.BundleID, &r.CurrentProductID,
		&r.AutoRenewProductID, &autoRenew, &retry, &r.GraceUntil, &r.RenewalAt, &r.EventAt, &r.UpdatedAt, &r.ExpirationIntent, &r.PriceIncreaseStatus)
	if err == sql.ErrNoRows {
		return AppleRenewalState{}, false, nil
	}
	if err != nil {
		return AppleRenewalState{}, false, err
	}
	r.IsInBillingRetry = retry != 0
	r.AutoRenewEnabled = autoRenew != 0
	return r, true, nil
}

// LapseAppleSubscription makes a missed terminal notification harmless using
// only durable local paid-through/grace facts. It never calls Apple.
func (s *SQLiteStore) LapseAppleSubscription(ctx context.Context, userID string, now int64) error {
	// The overwhelmingly common path is read-only. Recheck under the writer
	// transaction before changing anything so a renewal racing this pre-read wins.
	pre, err := scanSubscriptionSource(s.reader().QueryRowContext(ctx, `SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id=? AND provider=?`, userID, ProviderApple))
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if !pre.grantsAccess() || pre.PeriodEnd == 0 || pre.PeriodEnd > now {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	src, err := scanSubscriptionSource(tx.QueryRowContext(ctx, `SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id=? AND provider=?`, userID, ProviderApple))
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if !src.grantsAccess() || src.PeriodEnd == 0 || src.PeriodEnd > now {
		return nil
	}
	// This is a derived clock observation, not a new Apple event. Preserve the
	// provider clock so a same-generation canonical grace fact (2P) can restore,
	// while a refund terminal fact (2P+1) still permanently outranks the live JWS.
	_, err = applySourceTx(ctx, tx, SourceEvent{UserID: userID, Provider: ProviderApple, PlanID: freePlanID, Status: "canceled", PeriodEnd: src.PeriodEnd, ExternalID: src.ExternalID, ExternalScope: src.ExternalScope, EventAt: src.EventAt, Now: now})
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) ListAppleSubscriptionSources(ctx context.Context) ([]SubscriptionSource, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE provider=? AND external_id<>''`, ProviderApple)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubscriptionSource
	for rows.Next() {
		src, err := scanSubscriptionSource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, src)
	}
	return out, rows.Err()
}
