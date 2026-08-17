package account

import (
	"context"
	"database/sql"
)

func (s *SQLiteStore) ApplyAppleRenewalState(ctx context.Context, r AppleRenewalState) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO apple_renewal_states
 (user_id,external_id,bundle_id,current_product_id,auto_renew_product_id,in_billing_retry,grace_until,renewal_at,event_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(user_id) DO UPDATE SET external_id=excluded.external_id,bundle_id=excluded.bundle_id,
 current_product_id=excluded.current_product_id,auto_renew_product_id=excluded.auto_renew_product_id,
 in_billing_retry=excluded.in_billing_retry,grace_until=excluded.grace_until,renewal_at=excluded.renewal_at,
 event_at=excluded.event_at,updated_at=excluded.updated_at
 WHERE excluded.event_at > apple_renewal_states.event_at`, r.UserID, r.ExternalID, r.BundleID, r.CurrentProductID,
		r.AutoRenewProductID, appleBoolInt(r.IsInBillingRetry), r.GraceUntil, r.RenewalAt, r.EventAt, r.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func appleBoolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (s *SQLiteStore) GetAppleRenewalState(ctx context.Context, userID string) (AppleRenewalState, bool, error) {
	var r AppleRenewalState
	var retry int
	err := s.reader().QueryRowContext(ctx, `SELECT user_id,external_id,bundle_id,current_product_id,
 auto_renew_product_id,in_billing_retry,grace_until,renewal_at,event_at,updated_at
 FROM apple_renewal_states WHERE user_id=?`, userID).Scan(&r.UserID, &r.ExternalID, &r.BundleID, &r.CurrentProductID,
		&r.AutoRenewProductID, &retry, &r.GraceUntil, &r.RenewalAt, &r.EventAt, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return AppleRenewalState{}, false, nil
	}
	if err != nil {
		return AppleRenewalState{}, false, err
	}
	r.IsInBillingRetry = retry != 0
	return r, true, nil
}
