package account

import "context"

// RelayOverQuota reports whether the owner is at/over the monthly relay cap.
func (s *Service) RelayOverQuota(ctx context.Context, owner string) bool {
	if owner == "" {
		return false
	}
	st := s.resolveSettings(ctx)
	since, _ := monthRange(periodOf(s.now().Unix()))
	used, err := s.store.UserRelayedSince(ctx, owner, since)
	if err != nil {
		return false // fail open, matching handleICE
	}
	return used >= st.RelayMonthlyFree
}

// RecordRelaySession records a relay session's running byte total under a
// stable session id (RecordUsage keeps the max per id).
func (s *Service) RecordRelaySession(ctx context.Context, sessionID, owner, code string, bytes int64) {
	if owner == "" {
		return
	}
	_ = s.store.RecordUsage(ctx, UsageEvent{
		AllocID:      "relay:" + sessionID,
		Token:        code,
		UserID:       owner,
		RelayedBytes: bytes,
		RecordedAt:   s.now().Unix(),
	})
}
