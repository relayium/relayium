package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

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

	var existing BillingAuthority
	err = tx.QueryRowContext(ctx, `SELECT user_id, provider, external_scope, apple_environment, apple_account_token, epoch, intent_id, created_at, updated_at FROM billing_authorities WHERE user_id=?`, in.UserID).
		Scan(&existing.UserID, &existing.Provider, &existing.ExternalScope, &existing.AppleEnvironment, &existing.AppleAccountToken, &existing.Epoch, &existing.IntentID, &existing.CreatedAt, &existing.UpdatedAt)
	if err == nil {
		if existing.Provider != in.Provider || existing.ExternalScope != in.ExternalScope || existing.AppleAccountToken != in.AppleAccountToken {
			return BillingAuthority{}, ErrBillingAuthorityConflict
		}
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return BillingAuthority{}, err
	}

	var planID, planSource string
	if err := tx.QueryRowContext(ctx, `SELECT plan_id, plan_source FROM users WHERE id=?`, in.UserID).Scan(&planID, &planSource); err != nil {
		return BillingAuthority{}, err
	}
	if planSource == SourceAdmin && planID != "" && planID != freePlanID {
		return BillingAuthority{}, ErrBillingAuthorityConflict
	}
	rows, err := tx.QueryContext(ctx, `SELECT provider, plan_id, status, period_end, external_scope FROM subscription_sources WHERE user_id=?`, in.UserID)
	if err != nil {
		return BillingAuthority{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var provider, sourcePlan, status, scope string
		var end int64
		if err := rows.Scan(&provider, &sourcePlan, &status, &end, &scope); err != nil {
			return BillingAuthority{}, err
		}
		live := sourcePlan != "" && sourcePlan != freePlanID && liveSubStatus(status) && (end == 0 || in.Now <= 0 || end > in.Now)
		if live && (provider != in.Provider || (provider == ProviderApple && scope != "" && scope != in.ExternalScope)) {
			return BillingAuthority{}, ErrBillingAuthorityConflict
		}
	}
	if err := rows.Err(); err != nil {
		return BillingAuthority{}, err
	}
	intentID := authx.NewID()
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_authorities(user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`, in.UserID, in.Provider, in.ExternalScope, "", in.AppleAccountToken, intentID, in.Now, in.Now); err != nil {
		return BillingAuthority{}, err
	}
	out := BillingAuthority{UserID: in.UserID, Provider: in.Provider, ExternalScope: in.ExternalScope, AppleAccountToken: in.AppleAccountToken, Epoch: 1, IntentID: intentID, CreatedAt: in.Now, UpdatedAt: in.Now}
	return out, tx.Commit()
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

type BillingPurchaseAttempt struct {
	ID, UserID, Provider, ExternalScope, ProductID, State string
	Epoch, CreatedAt                                      int64
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
	var current BillingAuthority
	if err := tx.QueryRowContext(ctx, `SELECT user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at FROM billing_authorities WHERE user_id=?`, authority.UserID).
		Scan(&current.UserID, &current.Provider, &current.ExternalScope, &current.AppleEnvironment, &current.AppleAccountToken, &current.Epoch, &current.IntentID, &current.CreatedAt, &current.UpdatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	if current != authority {
		return BillingPurchaseAttempt{}, false, ErrBillingAuthorityConflict
	}
	var out BillingPurchaseAttempt
	err = tx.QueryRowContext(ctx, `SELECT id,user_id,provider,external_scope,product_id,state,epoch,created_at FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND state IN ('prepared','dispatched')`, authority.UserID, authority.Epoch).
		Scan(&out.ID, &out.UserID, &out.Provider, &out.ExternalScope, &out.ProductID, &out.State, &out.Epoch, &out.CreatedAt)
	if err == nil {
		return out, false, nil
	}
	if err != sql.ErrNoRows {
		return BillingPurchaseAttempt{}, false, err
	}
	out = BillingPurchaseAttempt{ID: authx.NewID(), UserID: authority.UserID, Provider: authority.Provider, ExternalScope: authority.ExternalScope, ProductID: productID, State: "prepared", Epoch: authority.Epoch, CreatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_purchase_attempts(id,user_id,provider,external_scope,product_id,state,epoch,created_at) VALUES(?,?,?,?,?,'prepared',?,?)`, out.ID, out.UserID, out.Provider, out.ExternalScope, out.ProductID, out.Epoch, out.CreatedAt); err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	return out, true, tx.Commit()
}

func (s *SQLiteStore) MarkBillingPurchaseDispatched(ctx context.Context, userID, attemptID string, epoch int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE billing_purchase_attempts SET state='dispatched' WHERE id=? AND user_id=? AND epoch=? AND state='prepared'`, attemptID, userID, epoch)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
