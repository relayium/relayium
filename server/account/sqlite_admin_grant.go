package account

import (
	"context"
	"database/sql"
	"errors"
)

// adminGrantCols is the column list every grant read shares, so the three
// columns can never be scanned in different orders by two call sites.
const adminGrantCols = `admin_grant_plan_id, admin_grant_granted_at, admin_grant_expires_at`

// AdminPlanGrant reads the administrator entitlement overlay recorded for a
// user. ok is false for an unknown user AND for a user who has never been
// granted anything; both mean "no overlay", and no caller needs to tell them
// apart (GrantAdminPlan is the one path that must, and it checks separately
// inside its own transaction).
//
// This deliberately does NOT filter by the clock. Whether a grant is still in
// force is AdminGrant.Active's decision, made against the caller's own `now` —
// the admin console has to be able to show a lapsed grant, and hiding it here
// would make an expired comp indistinguishable from one that never existed.
func (s *SQLiteStore) AdminPlanGrant(ctx context.Context, userID string) (AdminGrant, bool, error) {
	var g AdminGrant
	err := s.db.QueryRowContext(ctx,
		`SELECT `+adminGrantCols+` FROM users WHERE id = ?`, userID).
		Scan(&g.PlanID, &g.GrantedAt, &g.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminGrant{}, false, nil
	}
	if err != nil {
		return AdminGrant{}, false, err
	}
	return g, g.PlanID != "", nil
}

// GrantAdminPlan records a time-bounded administrator entitlement overlay and
// returns exactly what was written.
//
// Everything that decides the outcome happens INSIDE one transaction, and that
// is the point rather than a detail:
//
//   - the tier is re-checked for existence and active state here, not only in
//     the handler, so a plan retired between the confirmation page and the
//     confirmation POST cannot be granted;
//   - the account's deletion/freeze state is re-checked here, so a deletion
//     request that lands during the confirmation window cannot be overtaken;
//   - extend reads the CURRENT expiry in the same transaction that writes the
//     new one, so two concurrent extends cannot both anchor on the same base and
//     silently collapse into one duration.
//
// What it deliberately does NOT do is as important as what it does. It writes
// exactly three columns on the users row. It does not touch plan_id,
// plan_source, subscription_status, subscription_end, billing_cycle,
// billing_authorities, subscription_sources, billing_purchase_attempts, the
// Stripe customer/subscription identifiers, or the quota accrual columns — so a
// grant cannot move the provider projection, cannot mask a channel that may
// still charge, and cannot cut a quota segment. Provider reconciliation keeps
// running underneath, exactly as if no grant existed.
//
// A provider authority is NOT a refusal here, and that is the deliberate
// difference from SetUserPlanAdmin. That path overwrites the projection, so it
// must refuse an account bound to a money-moving channel; this one adds a
// separate overlay that leaves the channel's own record untouched and visible,
// so the operator is warned rather than blocked.
func (s *SQLiteStore) GrantAdminPlan(ctx context.Context, userID, planID, mode string, days, now int64) (AdminGrant, error) {
	if !validAdminGrantMode(mode) {
		return AdminGrant{}, ErrAdminGrantMode
	}
	if days < adminGrantMinDays || days > adminGrantMaxDays {
		return AdminGrant{}, ErrAdminGrantDuration
	}
	if planID == "" || planID == freePlanID {
		return AdminGrant{}, ErrAdminGrantPlan
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminGrant{}, err
	}
	defer tx.Rollback() // no-op after a successful Commit

	var active int
	if err := tx.QueryRowContext(ctx,
		`SELECT active FROM plans WHERE id = ?`, planID).Scan(&active); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AdminGrant{}, ErrAdminGrantPlan
		}
		return AdminGrant{}, err
	}
	if active == 0 {
		return AdminGrant{}, ErrAdminGrantPlan
	}

	var deletedAt int64
	var cur AdminGrant
	if err := tx.QueryRowContext(ctx,
		`SELECT deleted_at, `+adminGrantCols+` FROM users WHERE id = ?`, userID).
		Scan(&deletedAt, &cur.PlanID, &cur.GrantedAt, &cur.ExpiresAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AdminGrant{}, ErrNotFound
		}
		return AdminGrant{}, err
	}
	// A pending-deletion account is frozen out of every other billing write; an
	// entitlement grant is not the exception. Checked before the hold below
	// because it is the cheaper and the more common of the two.
	if deletedAt > 0 {
		return AdminGrant{}, ErrAdminGrantUnsafeAccount
	}
	if frozen, err := billingUserFrozenTx(ctx, tx, userID, now); err != nil {
		return AdminGrant{}, err
	} else if frozen {
		return AdminGrant{}, ErrAdminGrantUnsafeAccount
	}

	expires, err := adminGrantExpiry(mode, days, now, cur)
	if err != nil {
		return AdminGrant{}, err
	}
	next := AdminGrant{PlanID: planID, GrantedAt: now, ExpiresAt: expires}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET admin_grant_plan_id = ?, admin_grant_granted_at = ?, admin_grant_expires_at = ?
		  WHERE id = ?`,
		next.PlanID, next.GrantedAt, next.ExpiresAt, userID); err != nil {
		return AdminGrant{}, err
	}
	return next, tx.Commit()
}
