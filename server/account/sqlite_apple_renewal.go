package account

import (
	"context"
	"database/sql"
	"errors"
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
 WHERE excluded.external_id<>apple_renewal_states.external_id
    OR excluded.bundle_id<>apple_renewal_states.bundle_id
    OR excluded.event_at > apple_renewal_states.event_at`, r.UserID, r.ExternalID, r.BundleID, r.CurrentProductID, r.AutoRenewProductID,
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

// ApplyAuthorizedAppleLifecycle binds the verified App Store identity to the
// account's durable billing authority and advances entitlement, renewal intent,
// and the one dispatched purchase attempt in one transaction. Nothing about a
// client outcome can release or move this authority.
func (s *SQLiteStore) ApplyAuthorizedAppleLifecycle(ctx context.Context, ev SourceEvent, r AppleRenewalState, appleAccountToken, environment string) (SubscriptionApply, error) {
	return s.applyAuthorizedAppleLifecycle(ctx, ev, &r, appleAccountToken, environment, r.CurrentProductID, r.AutoRenewProductID)
}

func (s *SQLiteStore) ApplyAuthorizedAppleSource(ctx context.Context, ev SourceEvent, appleAccountToken, environment, productID string) (SubscriptionApply, error) {
	return s.applyAuthorizedAppleLifecycle(ctx, ev, nil, appleAccountToken, environment, productID, "")
}

func (s *SQLiteStore) applyAuthorizedAppleLifecycle(ctx context.Context, ev SourceEvent, renewal *AppleRenewalState, appleAccountToken, environment, currentProductID, autoRenewProductID string) (SubscriptionApply, error) {
	if ev.Provider != ProviderApple || ev.UserID == "" || ev.ExternalScope == "" ||
		(environment != appleEnvProduction && environment != appleEnvSandbox) {
		return SubscriptionApply{}, ErrBillingAuthorityConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubscriptionApply{}, err
	}
	defer tx.Rollback()
	subject, hasSubject, err := appleBillingSubjectTx(ctx, tx, appleAccountToken)
	if err != nil {
		return SubscriptionApply{}, err
	}
	if hasSubject && (subject.UserID != ev.UserID ||
		(subject.BundleID != billingUnknownAppleScope && subject.BundleID != ev.ExternalScope) || subject.DeletedAt != 0) {
		return SubscriptionApply{}, ErrBillingAuthorityConflict
	}
	if hasSubject && subject.BundleID == billingUnknownAppleScope {
		res, bindErr := tx.ExecContext(ctx, `UPDATE apple_billing_subjects SET bundle_id=? WHERE app_account_token=? AND bundle_id=? AND deleted_at=0`, ev.ExternalScope, subject.AppAccountToken, billingUnknownAppleScope)
		if bindErr != nil {
			return SubscriptionApply{}, bindErr
		}
		if n, bindErr := res.RowsAffected(); bindErr != nil || n != 1 {
			if bindErr != nil {
				return SubscriptionApply{}, bindErr
			}
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
		subject.BundleID = ev.ExternalScope
	}
	if appleAccountToken == "" {
		var boundUser string
		if err := tx.QueryRowContext(ctx, `SELECT user_id FROM subscription_sources WHERE provider=? AND external_id=? AND external_scope=?`, ProviderApple, ev.ExternalID, ev.ExternalScope).Scan(&boundUser); err != nil || boundUser != ev.UserID {
			if err != nil {
				return SubscriptionApply{}, err
			}
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
		if err := tx.QueryRowContext(ctx, `SELECT apple_account_token FROM billing_authorities WHERE user_id=? AND provider=?`, ev.UserID, ProviderApple).Scan(&appleAccountToken); err != nil || appleAccountToken == "" {
			if err != nil {
				return SubscriptionApply{}, err
			}
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
	}
	authority, err := acquireBillingAuthorityTx(ctx, tx, BillingAuthorityRequest{
		UserID: ev.UserID, Provider: ProviderApple, ExternalScope: ev.ExternalScope,
		AppleAccountToken: appleAccountToken, Now: ev.Now,
	})
	if err != nil {
		return SubscriptionApply{}, err
	}
	if hasSubject {
		switch {
		case subject.Environment == "":
			if _, err := tx.ExecContext(ctx, `UPDATE apple_billing_subjects SET environment=? WHERE app_account_token=? AND environment=''`, environment, subject.AppAccountToken); err != nil {
				return SubscriptionApply{}, err
			}
		case subject.Environment == appleEnvSandbox && environment == appleEnvProduction:
			if _, err := tx.ExecContext(ctx, `UPDATE apple_billing_subjects SET environment=? WHERE app_account_token=? AND environment=?`, environment, subject.AppAccountToken, appleEnvSandbox); err != nil {
				return SubscriptionApply{}, err
			}
		case subject.Environment == appleEnvProduction && environment == appleEnvSandbox:
			return SubscriptionApply{Applied: false}, tx.Commit()
		case subject.Environment != environment:
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
	}
	if authority.AppleEnvironment == "" {
		res, err := tx.ExecContext(ctx, `UPDATE billing_authorities SET apple_environment=?,updated_at=? WHERE user_id=? AND provider=? AND apple_environment='' AND epoch=?`, environment, ev.Now, ev.UserID, ProviderApple, authority.Epoch)
		if err != nil {
			return SubscriptionApply{}, err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			if err != nil {
				return SubscriptionApply{}, err
			}
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
		authority.AppleEnvironment = environment
	} else if authority.AppleEnvironment == appleEnvSandbox && environment == appleEnvProduction {
		res, err := tx.ExecContext(ctx, `UPDATE billing_authorities SET apple_environment=?,updated_at=? WHERE user_id=? AND provider=? AND apple_environment=? AND epoch=?`, appleEnvProduction, ev.Now, ev.UserID, ProviderApple, appleEnvSandbox, authority.Epoch)
		if err != nil {
			return SubscriptionApply{}, err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			if err != nil {
				return SubscriptionApply{}, err
			}
			return SubscriptionApply{}, ErrBillingAuthorityConflict
		}
		authority.AppleEnvironment = appleEnvProduction
	} else if authority.AppleEnvironment == appleEnvProduction && environment == appleEnvSandbox {
		return SubscriptionApply{Applied: false}, tx.Commit()
	} else if authority.AppleEnvironment != environment {
		return SubscriptionApply{}, ErrBillingAuthorityConflict
	}
	var externalOwner, externalBundle string
	var externalDeleted int64
	externalErr := tx.QueryRowContext(ctx, `SELECT user_id,bundle_id,deleted_at FROM apple_billing_external_subjects WHERE environment=? AND external_id=?`, environment, ev.ExternalID).Scan(&externalOwner, &externalBundle, &externalDeleted)
	if externalErr != nil && !errors.Is(externalErr, sql.ErrNoRows) {
		return SubscriptionApply{}, externalErr
	}
	if externalErr == nil && (externalOwner != ev.UserID || externalBundle != ev.ExternalScope || externalDeleted != 0) {
		return SubscriptionApply{}, ErrExternalSubscriptionOwned
	}

	var attemptID, attemptProduct string
	err = tx.QueryRowContext(ctx, `SELECT id,product_id FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND provider=? AND state IN ('prepared','dispatched')`, ev.UserID, authority.Epoch, ProviderApple).Scan(&attemptID, &attemptProduct)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return SubscriptionApply{}, err
	}
	hasAttempt := err == nil
	immediatePurchase := attemptProduct == ev.AppleDispatchProductID && ev.AppleDispatchPurchase
	resolveAttempt := hasAttempt && hasSubject && subject.AttemptID == attemptID &&
		immediatePurchase

	result, err := applySourceTx(ctx, tx, ev)
	if err != nil {
		return SubscriptionApply{}, err
	}
	if result.Applied {
		result.PurchaseAttemptPending = hasAttempt
		if _, err := tx.ExecContext(ctx, `INSERT INTO apple_billing_external_subjects(environment,external_id,user_id,bundle_id)
 VALUES(?,?,?,?) ON CONFLICT(environment,external_id) DO UPDATE SET
 user_id=excluded.user_id,bundle_id=excluded.bundle_id
 WHERE apple_billing_external_subjects.user_id=excluded.user_id
   AND apple_billing_external_subjects.bundle_id=excluded.bundle_id
   AND apple_billing_external_subjects.deleted_at=0`, environment, ev.ExternalID, ev.UserID, ev.ExternalScope); err != nil {
			return SubscriptionApply{}, err
		}
		if renewal != nil {
			if _, err = applyAppleRenewalStateTx(ctx, tx, *renewal); err != nil {
				return SubscriptionApply{}, err
			}
		}
		if resolveAttempt {
			res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts SET state='resolved' WHERE id=? AND user_id=? AND epoch=? AND state IN ('prepared','dispatched')`, attemptID, ev.UserID, authority.Epoch)
			if err != nil {
				return SubscriptionApply{}, err
			}
			if n, err := res.RowsAffected(); err != nil || n != 1 {
				if err != nil {
					return SubscriptionApply{}, err
				}
				return SubscriptionApply{}, ErrBillingAuthorityConflict
			}
			if err := advanceBillingAuthorityGenerationTx(ctx, tx, authority, ev.Now); err != nil {
				return SubscriptionApply{}, err
			}
			result.PurchaseAttemptPending = false
			result.PurchaseAttemptResolved = true
		}
	}
	return result, tx.Commit()
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

func (s *SQLiteStore) ListAppleSubscriptionSources(ctx context.Context, afterUserID string, limit int) ([]SubscriptionSource, error) {
	if limit <= 0 || limit > 500 {
		return nil, errors.New("account: invalid apple sweep page size")
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE provider=? AND external_id<>'' AND user_id>? ORDER BY user_id LIMIT ?`, ProviderApple, afterUserID, limit)
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
