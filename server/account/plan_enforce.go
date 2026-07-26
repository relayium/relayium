package account

import "context"

// freePlanFallback is the in-memory Free tier used when a user's plan_id can't
// be resolved (missing row, DB blip). Matches defaultPlans()[0] so enforcement
// never crashes and never silently grants unlimited quota.
//
// It must stay a verbatim copy of defaultPlans()[0] — do NOT normalize
// individual fields here. An earlier draft zeroed DailyQuotaBytes so an
// unresolvable tier would defer to the global setting; that looked prudent but
// silently absorbed a bad Free seed value, turning a loud test failure into a
// behaviour split between users with and without a plans row. The Free tier's
// "inherit the global daily quota" property belongs in defaultPlans() (where
// it's asserted by TestFreePlanFollowsGlobalDailyQuota), not in a fixup here.
func freePlanFallback() Plan { return defaultPlans()[0] }

// planForUser resolves a user's billing tier. A genuine not-found falls back to
// Free with a nil error (a user with a bogus plan_id is legitimately Free); a
// real store error is propagated so the over* gates can fail OPEN rather than
// silently enforcing the Free cap against a paid user during a DB blip.
func (s *Service) planForUser(ctx context.Context, userID string) (Plan, error) {
	u, err := s.Store().GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback(), nil
		}
		return freePlanFallback(), err
	}
	p, ok, err := s.Store().GetPlan(ctx, u.PlanID)
	if err != nil {
		return freePlanFallback(), err
	}
	if !ok {
		return freePlanFallback(), nil
	}
	return p, nil
}

// dailyQuotaFor 给出 userID 当前档位的 24 小时上传额度。档位没配（<= 0）时回落
// 到全局 SettingDailyQuota——存量 plans 行都是 0，这让迁移后的行为保持不变。
func (s *Service) dailyQuotaFor(ctx context.Context, userID string) (int64, error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return 0, err
	}
	if plan.DailyQuotaBytes > 0 {
		return plan.DailyQuotaBytes, nil
	}
	return s.ResolveSettings(ctx).DailyQuota, nil
}

// currentMonthTraffic sums a user's staged upload+download (usage_monthly) plus
// billable relay (usage_events) for the current month.
func (s *Service) currentMonthTraffic(ctx context.Context, userID string) (int64, error) {
	now := s.Now().Unix()
	period := periodOf(now)
	upDown, err := s.Store().UserMonthlyUpDown(ctx, userID, period)
	if err != nil {
		return 0, err
	}
	monthStart, _ := monthRange(period)
	relay, err := s.Store().UserRelayedSince(ctx, userID, monthStart)
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
	u, err := s.Store().GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback().TrafficBytes, nil
		}
		return 0, err
	}
	plan, ok, err := s.Store().GetPlan(ctx, u.PlanID)
	if err != nil {
		return 0, err
	}
	if !ok {
		plan = freePlanFallback()
	}

	period := periodOf(s.Now().Unix())
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

// remainingTraffic 返回 userID 当月还剩多少流量字节。unlimited=true 表示该项没有
// 上限（cap <= 0），此时 remaining 无意义。剩余量可能为负（改档后额度缩水等），
// 由调用方自行 clamp。
//
// overTraffic 就建在它上面，两者共用同一个 monthlyTrafficCap（含月中改档的分段
// 折算）和同一个 currentMonthTraffic——不要在别处另算一份"剩余流量"，那必然会
// 和分段折算走散。
func (s *Service) remainingTraffic(ctx context.Context, userID string) (remaining int64, unlimited bool, err error) {
	cap, err := s.monthlyTrafficCap(ctx, userID)
	if err != nil {
		return 0, false, err
	}
	if cap <= 0 {
		return 0, true, nil
	}
	used, err := s.currentMonthTraffic(ctx, userID)
	if err != nil {
		return 0, false, err
	}
	return cap - used, false, nil
}

// overTraffic reports whether userID's month-to-date traffic plus add exceeds
// their monthly traffic allowance. A non-positive cap means "unlimited".
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	remaining, unlimited, err := s.remainingTraffic(ctx, userID)
	if err != nil {
		return false, err
	}
	if unlimited {
		return false, nil
	}
	// used+add > cap ⟺ add > cap-used，与改写前逐字等价。
	return add > remaining, nil
}

// remainingStorage 返回 userID 还能再存多少字节。unlimited=true 表示档位没有存储
// 上限。同上：overStorage 建在它上面，保证两条路读的是同一个 cap 和同一个 used。
func (s *Service) remainingStorage(ctx context.Context, userID string) (remaining int64, unlimited bool, err error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return 0, false, err
	}
	if plan.StorageBytes <= 0 {
		return 0, true, nil
	}
	used, err := s.Store().CurrentStorage(ctx, userID, s.Now().Unix())
	if err != nil {
		return 0, false, err
	}
	return plan.StorageBytes - used, false, nil
}

// overStorage reports whether userID's current live storage plus add exceeds
// their plan's storage cap. A non-positive cap means "unlimited".
func (s *Service) overStorage(ctx context.Context, userID string, add int64) (bool, error) {
	remaining, unlimited, err := s.remainingStorage(ctx, userID)
	if err != nil {
		return false, err
	}
	if unlimited {
		return false, nil
	}
	return add > remaining, nil
}

// remainingDailyQuota 返回 userID 滚动 24 小时窗口内还剩多少上传额度。
//
// 这里没有 unlimited 出口：日额度 <= 0 在既有语义里是"什么都传不了"，不是"无限"
// ——finalize 把 quota 原样交给 ReserveUpload，那边判的是 used+bytes > quota，
// quota=0 时任何字节都会被拒。所以这里也不能把 0 解释成无限。
func (s *Service) remainingDailyQuota(ctx context.Context, userID string) (int64, error) {
	quota, err := s.dailyQuotaFor(ctx, userID)
	if err != nil {
		return 0, err
	}
	used, err := s.Store().UserUploadedSince(ctx, userID, s.Now().Unix()-dayWindow)
	if err != nil {
		return 0, err
	}
	return quota - used, nil
}

// overGlobalStorage reports whether total live storage plus add exceeds the
// global logical cap (SettingStorageDiskCap). cap<=0 disables the check.
func (s *Service) overGlobalStorage(ctx context.Context, add int64) (bool, error) {
	cap := s.ResolveSettings(ctx).StorageDiskCap
	if cap <= 0 {
		return false, nil
	}
	used, err := s.Store().GlobalStorageUsed(ctx, s.Now().Unix())
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// persistStoredFile commits a stored file to the store. For billable
// (central-stored) uploads it is the AUTHORITATIVE, fail-closed storage gate:
// it resolves the owner's plan cap and the global disk cap and enforces both
// atomically inside CreateStoredFileWithinStorageCaps, so concurrent uploads
// cannot race past the caps the way the cheap pre-write over* checks (which
// fail open) allow. Own-node uploads (enforceCaps=false) skip caps entirely —
// they land on the user's own disk and are never metered against a plan.
//
// Returns reason "" on success, "storage" (owner cap) or "global" (disk cap)
// when a cap is hit, or a non-nil err on a real store failure (caller 500s and
// drops the blob — never admits an upload against an unknown cap).
func (s *Service) persistStoredFile(ctx context.Context, f StoredFile, enforceCaps bool) (reason string, err error) {
	if !enforceCaps {
		return "", s.Store().CreateStoredFile(ctx, f)
	}
	plan, err := s.planForUser(ctx, f.UserID)
	if err != nil {
		return "", err
	}
	globalCap := s.ResolveSettings(ctx).StorageDiskCap
	ok, reason, err := s.Store().CreateStoredFileWithinStorageCaps(ctx, f, s.Now().Unix(), plan.StorageBytes, globalCap)
	if err != nil {
		return "", err
	}
	if !ok {
		return reason, nil
	}
	return "", nil
}

// uploadWriteCap bounds how many bytes a single-shot BILLABLE upload may stream
// to disk before the authoritative post-write gates run. The cheap pre-gate only
// trusts a client-declared Content-Length, so a chunked or understated length
// sails through it and would otherwise let a client write a full MaxFileSize
// (1 GiB) blob just to have it rejected and dropped — disk-churn DoS. Cap the
// write at the tightest of maxFileSize, the remaining daily quota, and the
// remaining storage, each with a minBillableBytes slack so an upload exactly at
// a limit isn't truncated. A store-read error leaves that dimension uncapped
// (fail open — the authoritative gates still reject over-limit uploads on the
// real byte count); the floor keeps a quota-exhausted user from churning more
// than one minimum object.
func (s *Service) uploadWriteCap(ctx context.Context, userID string, maxFileSize int64) int64 {
	cap := maxFileSize
	if rem, err := s.remainingDailyQuota(ctx, userID); err == nil {
		if c := rem + minBillableBytes; c < cap {
			cap = c
		}
	}
	if rem, unlimited, err := s.remainingStorage(ctx, userID); err == nil && !unlimited {
		if c := rem + minBillableBytes; c < cap {
			cap = c
		}
	}
	if cap < minBillableBytes {
		cap = minBillableBytes
	}
	return cap
}

// planRetentionCap returns the user's plan retention ceiling in seconds (0 = no
// plan cap; the global clampTTL still applies).
func (s *Service) planRetentionCap(ctx context.Context, userID string) int64 {
	p, err := s.planForUser(ctx, userID)
	if err != nil {
		// Fail OPEN (no cap): a transient plan-read error must not silently clamp a
		// paying user's file to the free-tier retention — it would expire early with
		// no signal. Matches the over* gates' fail-open stance; 0 means "no cap".
		return 0
	}
	return p.RetentionSecs
}
