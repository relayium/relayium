package account

import "context"

// freePlanFallback is the in-memory Free tier used when a user's plan_id can't
// be resolved (missing row, DB blip). Matches defaultPlans()[0] so enforcement
// never crashes and never silently grants unlimited quota.
func freePlanFallback() Plan { return defaultPlans()[0] }

// planForUser resolves a user's billing tier. A genuine not-found falls back to
// Free with a nil error (a user with a bogus plan_id is legitimately Free); a
// real store error is propagated so the over* gates can fail OPEN rather than
// silently enforcing the Free cap against a paid user during a DB blip.
func (s *Service) planForUser(ctx context.Context, userID string) (Plan, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback(), nil
		}
		return freePlanFallback(), err
	}
	p, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		return freePlanFallback(), err
	}
	if !ok {
		return freePlanFallback(), nil
	}
	return p, nil
}

// currentMonthTraffic sums a user's staged upload+download (usage_monthly) plus
// billable relay (usage_events) for the current month.
func (s *Service) currentMonthTraffic(ctx context.Context, userID string) (int64, error) {
	now := s.now().Unix()
	period := periodOf(now)
	upDown, err := s.store.UserMonthlyUpDown(ctx, userID, period)
	if err != nil {
		return 0, err
	}
	monthStart, _ := monthRange(period)
	relay, err := s.store.UserRelayedSince(ctx, userID, monthStart)
	if err != nil {
		return 0, err
	}
	return upDown + relay, nil
}

// overTraffic reports whether userID's month-to-date traffic plus add exceeds
// their plan's traffic cap. A non-positive cap means "unlimited".
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	cap := plan.TrafficBytes
	if cap <= 0 {
		return false, nil
	}
	used, err := s.currentMonthTraffic(ctx, userID)
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// overStorage reports whether userID's current live storage plus add exceeds
// their plan's storage cap. A non-positive cap means "unlimited".
func (s *Service) overStorage(ctx context.Context, userID string, add int64) (bool, error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	cap := plan.StorageBytes
	if cap <= 0 {
		return false, nil
	}
	used, err := s.store.CurrentStorage(ctx, userID, s.now().Unix())
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// overGlobalStorage reports whether total live storage plus add exceeds the
// global logical cap (SettingStorageDiskCap). cap<=0 disables the check.
func (s *Service) overGlobalStorage(ctx context.Context, add int64) (bool, error) {
	cap := s.resolveSettings(ctx).StorageDiskCap
	if cap <= 0 {
		return false, nil
	}
	used, err := s.store.GlobalStorageUsed(ctx, s.now().Unix())
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// planRetentionCap returns the user's plan retention ceiling in seconds (0 = no
// plan cap; the global clampTTL still applies).
func (s *Service) planRetentionCap(ctx context.Context, userID string) int64 {
	p, _ := s.planForUser(ctx, userID)
	return p.RetentionSecs
}
