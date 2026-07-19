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

// monthlyTrafficCap 返回用户当月的流量上限。通常就是其档位的整月 cap；只有当
// 本月改过档时，才把当月拆成若干段、每段按 cap × 该段占全月的比例相加（写侧
// 见 accrueQuotaTx）。返回值 <= 0 表示"无限"，与 overTraffic/overStorage 的既
// 有约定一致。
//
// 这里没有复用 planForUser：分段计算既要档位也要用户行上的三个配额字段，而
// planForUser 只返回 Plan。错误处理沿用同一条原则——真实的 store 错误往上传，
// 让门 fail-open；查不到的用户/档位才回落到 Free。
func (s *Service) monthlyTrafficCap(ctx context.Context, userID string) (int64, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback().TrafficBytes, nil
		}
		return 0, err
	}
	plan, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		return 0, err
	}
	if !ok {
		plan = freePlanFallback()
	}

	period := periodOf(s.now().Unix())
	// 本月没改过档（含全部存量用户，三列都是零值）→ 整月满额。
	if u.QuotaAccruedPeriod != period {
		return plan.TrafficBytes, nil
	}
	// 无限档不参与比例计算，否则会被算成一个有限的小数字。
	if plan.TrafficBytes <= 0 {
		return plan.TrafficBytes, nil
	}

	segStart, monthStart, monthEnd := segmentBounds(period, u.PlanStartedAt)
	monthSecs := monthEnd - monthStart
	segSecs := monthEnd - segStart
	// prorate 自带 segSecs<=0/monthSecs<=0 的守卫（返回0），但那两种退化情况
	// 下这里的语义是"当前段没有额外贡献"，不是"cap是0"——所以不能直接把
	// prorate 的返回值当作最终 cap，还是要落到 accrued 之上。monthRange 解析
	// 失败（period 格式错）时 monthStart==monthEnd==0，segSecs 会是 0，prorate
	// 照样返回0，结果自然退化成只剩 accrued，语义不变。
	return u.QuotaAccruedBytes + prorate(plan.TrafficBytes, segSecs, monthSecs), nil
}

// overTraffic reports whether userID's month-to-date traffic plus add exceeds
// their monthly traffic allowance. A non-positive cap means "unlimited".
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	cap, err := s.monthlyTrafficCap(ctx, userID)
	if err != nil {
		return false, err
	}
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
