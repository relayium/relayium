package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const sessionCookie = "relayium_session"

// deleteTokenTTL bounds how long a self-serve-deletion confirm link stays
// valid — short, since it's re-requestable and email delivery is normally
// near-instant (mirrors resetTTL's role, kept separate so tuning one never
// silently retunes the other).
const deleteTokenTTL = time.Hour

// cookieSecure reports whether auth cookies should carry the Secure attribute.
// Derived from the base URL scheme: production (https) gets Secure cookies,
// while plain http://localhost development keeps real-browser login working.
func (s *Service) cookieSecure() bool {
	return strings.HasPrefix(s.cfg.BaseURL, "https://")
}

// Routes returns the account API handler. State-changing requests pass through
// csrfGuard first; the returned http.Handler is not a *ServeMux, so callers must
// treat it as an opaque handler.
func (s *Service) Routes() http.Handler {
	return s.csrfGuard(s.routeMux())
}

// selfOrigin is the scheme://host the app is served from, derived from BaseURL.
// Cross-site requests carrying a different Origin on an unsafe method are
// rejected. Empty when BaseURL is unparseable, which disables the Origin check
// (SameSite=Lax cookies remain the backstop).
func (s *Service) selfOrigin() string {
	u, err := url.Parse(s.cfg.BaseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// csrfGuard rejects state-changing requests (POST/PUT/PATCH/DELETE) whose Origin
// header is present and does not match the site's own origin. This complements
// the SameSite=Lax session cookie as defense-in-depth against CSRF: a cross-site
// attacker's fetch/XHR always sends a foreign Origin, so it is blocked here even
// if a browser or proxy quirk were to weaken SameSite enforcement. Safe methods
// (GET/HEAD/OPTIONS) and requests with no Origin (e.g. top-level OAuth/magic-link
// redirects, non-browser clients) are left alone.
func (s *Service) csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		// Sign in with Apple's callback is a legitimate cross-site form_post from
		// appleid.apple.com — it necessarily carries a foreign Origin, so it must
		// be exempted here. The `state` cookie (checked in handleAppleWebCallback)
		// is its CSRF defense instead.
		if r.Method == http.MethodPost && r.URL.Path == "/api/auth/apple/web/callback" {
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			if self := s.selfOrigin(); self != "" && origin != self {
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requireOrigin rejects requests that carry no Origin header. csrfGuard
// deliberately exempts those (top-level form posts, native clients need it),
// but the passkey JSON endpoints are only ever called by fetch, which always
// sends Origin — so a missing one there is a forgery signal, not a legitimate
// client. Compose as csrfGuard(requireOrigin(h)).
func (s *Service) requireOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == "" {
			http.Error(w, "origin required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Service) routeMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/password/login", s.handlePasswordLogin)
	mux.HandleFunc("POST /api/auth/password/change", s.RequireSession(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/email/verify", s.handleEmailVerify)
	mux.HandleFunc("POST /api/auth/email/resend", s.handleResendVerification)
	mux.HandleFunc("POST /api/auth/password/forgot", s.handleForgotPassword)
	mux.HandleFunc("POST /api/auth/password/reset", s.handleResetPassword)
	// Self-serve account deletion (double opt-in): request is session-authed and
	// only ever emails a confirm link (no destructive action); confirm carries
	// no session (a prior confirm may already have revoked it) — the token
	// itself is the authorization, mirroring the password-reset token pattern.
	mux.HandleFunc("POST /api/account/delete/request", s.RequireSession(s.handleDeleteRequest))
	mux.HandleFunc("POST /api/account/delete/confirm", s.handleDeleteConfirm)
	// Reactivation (Task 4): also unauthed — a frozen account has no live
	// session, so the reactivate token itself is the authorization, exactly
	// like delete/confirm above.
	mux.HandleFunc("POST /api/account/reactivate", s.handleReactivate)
	mux.HandleFunc("GET /api/auth/methods", s.handleAuthMethods)
	if s.cfg.EnableMagic {
		mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
		mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerify)
	}
	if s.cfg.EnableGoogle {
		mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
		mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	}
	// Sign in with Apple (native app token exchange). Dormant until configured.
	if s.cfg.EnableApple {
		mux.HandleFunc("POST /api/auth/apple/native", s.handleAppleNative)
		// Browser Sign in with Apple: additionally gated on appleWebConfigured
		// so a half-configured deploy (EnableApple set but no Services ID/team/
		// key yet) never exposes a 500-ing button.
		if s.appleWebConfigured() {
			mux.HandleFunc("GET /api/auth/apple/web/start", s.handleAppleWebStart)
			mux.HandleFunc("POST /api/auth/apple/web/callback", s.handleAppleWebCallback)
		}
	}
	// Native (iOS/macOS) app login: same credential guards as the cookie login
	// but returns a bearer token the app stores in the Keychain.
	mux.HandleFunc("POST /api/auth/native/login", s.handleNativeLogin)
	// Manage linked login methods (session- or bearer-authed).
	mux.HandleFunc("DELETE /api/auth/identities/{provider}", s.RequireAuth(s.handleUnlinkIdentity))
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	mux.HandleFunc("GET /api/me/usage", s.RequireSession(s.handleMeUsage))
	mux.HandleFunc("GET /api/devices", s.RequireSession(s.handleListDevices))
	mux.HandleFunc("POST /api/devices", s.RequireSession(s.handleUpsertDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", s.RequireSession(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.RequireSession(s.handleDeleteDevice))
	mux.HandleFunc("GET /api/ice", s.handleICE)
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/usage", s.RequireSession(s.handleUsage))
	mux.HandleFunc("GET /api/stats", s.RequireSession(s.handleStats))
	// BYO user node management (SP3): session-authed, CSRF-guarded like the
	// rest of routeMux — distinct from the bearer-authed /api/nodes/register
	// and /api/nodes/heartbeat mounted directly on the root mux.
	mux.HandleFunc("POST /api/nodes/provision", s.RequireSession(s.handleProvisionNode))
	mux.HandleFunc("GET /api/nodes/mine", s.RequireSession(s.handleMyNodes))
	mux.HandleFunc("DELETE /api/nodes/{id}", s.RequireSession(s.handleDeleteMyNode))
	mux.HandleFunc("PUT /api/nodes/{id}/label", s.RequireSession(s.handleRenameMyNode))
	mux.HandleFunc("POST /api/nodes/{id}/check", s.RequireSession(s.handleCheckNode))
	mux.HandleFunc("PUT /api/me/strict-nodes", s.RequireSession(s.handleStrictNodes))
	// Billing (phase-2): checkout/portal are session-authed like the rest of
	// routeMux (CSRF-guarded by Routes()); /api/plans is public (like
	// /api/files/{id}/meta) so the pricing UI can render signed out.
	mux.HandleFunc("POST /api/billing/checkout", s.RequireSession(s.handleBillingCheckout))
	mux.HandleFunc("POST /api/billing/change-plan", s.RequireSession(s.handleBillingChangePlan))
	mux.HandleFunc("POST /api/billing/preview", s.RequireSession(s.handleBillingPreview))
	mux.HandleFunc("POST /api/billing/cancel-scheduled-change", s.RequireSession(s.handleBillingCancelScheduledChange))
	mux.HandleFunc("POST /api/billing/portal", s.RequireSession(s.handleBillingPortal))
	mux.HandleFunc("GET /api/plans", s.handlePublicPlans)
	// Stripe webhook: unauthenticated (no session, no CSRF token — Stripe
	// can't provide either), authenticated instead by its own HMAC signature
	// inside handleStripeWebhook. Safe to mount on routeMux/csrfGuard because
	// csrfGuard only rejects a state-changing request whose Origin header is
	// PRESENT and mismatched; Stripe's webhook POSTs carry no Origin header at
	// all, so csrfGuard's `if origin != ""` check is false and it falls
	// through untouched (see csrfGuard above).
	mux.HandleFunc("POST /api/stripe/webhook", s.handleStripeWebhook)
	// Device-code CLI login flow (RFC 8628-style): start/poll are called by
	// the unauthenticated CLI (it has no credential yet), approve is called
	// by the logged-in web session that confirms the code.
	mux.HandleFunc("POST /api/cli/device/start", s.handleDeviceStart)
	mux.HandleFunc("POST /api/cli/device/poll", s.handleDevicePoll)
	mux.HandleFunc("GET /api/cli/device/pending", s.RequireSession(s.handleDevicePending))
	mux.HandleFunc("POST /api/cli/device/approve", s.RequireSession(s.handleDeviceApprove))
	// GET /device is the human-facing verification_uri the CLI shows
	// (RFC 8628-style): server-rendered, session-gated for the authed view,
	// public for the anon "please sign in" view. Session-authed POSTs to
	// approve happen client-side via fetch, see devicepage.go.
	mux.HandleFunc("GET /device", s.handleDevicePage)
	s.registerFileRoutes(mux)
	return mux
}

// handleConfig exposes the effective stored-transfer limits so clients can
// show upfront size/TTL hints without guessing. Public — no session required.
func (s *Service) handleConfig(w http.ResponseWriter, r *http.Request) {
	st := s.resolveSettings(r.Context())
	writeJSON(w, http.StatusOK, map[string]int64{
		"maxFileSize": st.MaxFileSize,
		"dailyQuota":  st.DailyQuota,
		"defaultTTL":  st.DefaultTTL,
		"maxTTL":      st.MaxTTL,
	})
}

func (s *Service) handleListDevices(w http.ResponseWriter, r *http.Request, u User) {
	ds, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": ds})
}

func (s *Service) handleUpsertDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if in.ID == "" {
		in.ID = newID()
	}
	d, err := s.store.UpsertDevice(r.Context(), Device{
		ID: in.ID, UserID: u.ID, Name: in.Name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Service) handleRenameDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.store.RenameDevice(r.Context(), r.PathValue("id"), u.ID, in.Name); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleDeleteDevice(w http.ResponseWriter, r *http.Request, u User) {
	if err := s.store.DeleteDevice(r.Context(), r.PathValue("id"), u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) setSessionCookie(w http.ResponseWriter, sess Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		Expires:  time.Unix(sess.ExpiresAt, 0),
		HttpOnly: true,
		Secure:   s.cookieSecure(),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cookieSecure(),
		SameSite: http.SameSiteLaxMode,
	})
}

// RequireSession wraps a handler, injecting the authenticated user or 401ing.
func (s *Service) RequireSession(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, ok, err := s.ValidateSession(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r, u)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Service) handleMagicRequest(w http.ResponseWriter, r *http.Request) {
	email := normEmail(r.FormValue("email"))
	// Rate-limit per email+IP so the endpoint can't be turned into an email bomb.
	// Each request counts toward the limit; past the threshold we silently skip
	// sending. Always respond 200 regardless — of send success, unknown email, or
	// throttle state — so neither account existence nor the limit leaks.
	if email != "" {
		key := email + "|" + s.clientIP(r)
		if !s.magicRequests.locked(key, s.now()) {
			s.magicRequests.recordFail(key, s.now())
			_ = s.RequestMagicLink(r.Context(), email)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleMagicVerify(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	sess, err := s.VerifyMagicLink(r.Context(), token)
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen login (Task 4): no session cookie, redirect carrying a fresh
		// reactivate token instead of the usual post-login "/".
		// Fragment, not query: keeps the reactivate token out of server logs and
		// Referer (see oauth.go's frozen-login redirect).
		http.Redirect(w, r, "/#account=pending_deletion&token="+url.QueryEscape(pd.ReactivateToken), http.StatusFound)
		return
	}
	if err != nil {
		http.Redirect(w, r, "/?login=expired", http.StatusFound)
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = s.store.RevokeSession(r.Context(), c.Value)
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleUsage(w http.ResponseWriter, r *http.Request, u User) {
	total, err := s.store.UserUsageTotal(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"relayedBytes": total})
}

// handleStats serves the personal-center aggregates: lifetime upload/download
// counts and bytes (user_stats) plus TURN relay bytes (usage_events). All are
// the caller's own totals; no per-event data or downloader identity is exposed.
func (s *Service) handleStats(w http.ResponseWriter, r *http.Request, u User) {
	st, err := s.store.GetUserStats(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	relay, err := s.store.UserUsageTotal(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"transfers":     st.TransfersTotal,
		"downloads":     st.DownloadsTotal,
		"uploadBytes":   st.UploadBytes,
		"downloadBytes": st.DownloadBytes,
		"relayBytes":    relay,
	})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	hasPass, err := s.store.HasPassword(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	linked, _ := s.store.ListIdentityProviders(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "displayName": u.DisplayName,
			"hasPassword": hasPass, "emailVerified": u.EmailVerified,
			"linkedMethods": loginMethods(hasPass, linked),
			"onlyOwnNodes":  u.OnlyOwnNodes,
			// Billing (phase-2): plan + subscription state and whether a Stripe
			// customer exists yet (gates the "Manage billing" button in the UI).
			"planId":             u.PlanID,
			"subscriptionStatus": u.SubscriptionStatus,
			"subscriptionEnd":    u.SubscriptionEnd,
			"hasBilling":         u.StripeCustomerID != "",
			"scheduledPlanId":    u.ScheduledPlanID,
			// '' when unknown (a subscription that predates the column). The UI
			// must not assume monthly in that case — it would render "switch to
			// yearly" as if it were a no-op for someone already billed yearly.
			"billingCycle": u.BillingCycle,
		},
	})
}

// handleMeUsage 报告调用者当月的配额位置：当月流量对当月上限（可能因为月中改
// 档而按段计算），以及当前存活存储对档位上限。cap == 0 表示无限，前端据此隐
// 藏进度条。
//
// 这是用户侧第一个能看到配额的接口。在它之前，用户只有撞上 429 才知道自己超
// 了；而 /api/stats 报的是**终身累计**，和真正生效的当月配额是两个数，反而误
// 导人。
func (s *Service) handleMeUsage(w http.ResponseWriter, r *http.Request, u User) {
	ctx := r.Context()
	now := s.now().Unix()
	period := periodOf(now)
	_, monthEnd := monthRange(period)

	traffic, err := s.currentMonthTraffic(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	trafficCap, err := s.monthlyTrafficCap(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	storage, err := s.store.CurrentStorage(ctx, u.ID, now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	plan, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		plan = freePlanFallback()
	}

	// isTop: 用户已经在最高档时，卡片要把"升级"换成"已是最高档"——把 Max 用户
	// 往定价页赶是负体验。用 ListPlans 而不是新加一个 store 方法，是因为 plans
	// 表只有个位数行、且已被 /api/plans 以同样方式读取；新增接口方法还得在所有
	// 测试替身里实现，不划算。
	//
	// 默认 false（fail-closed），只有在**成功枚举出 plans、确实看到了 active 档、
	// 且其中没有比当前档更高的**时才置 true。这个方向是刻意选的，不要"简化"回
	// `isTop := true` 再找反例——两个方向的误报代价严重不对称：
	//   - 误报 false：Max 用户多看到一个"升级"按钮，点进去发现没得升，轻微尴尬。
	//   - 误报 true：ListPlans 出错（DB 抖一下）或 plans 表意外为空时，全站每个
	//     用户（含免费用户）的会员卡都会显示"已是最高档"，升级入口整体消失，而
	//     且静默、用户与我们都无感知——等于掐断变现路径。
	// 空 plans 表（或全是 inactive）同样得到 false：我们没有任何依据宣称用户已
	// 经在最高档。
	isTop := false
	if plans, perr := s.store.ListPlans(ctx); perr == nil {
		sawActive, higher := false, false
		for _, p := range plans {
			if !p.Active {
				continue
			}
			sawActive = true
			if p.SortOrder > plan.SortOrder {
				higher = true
				break
			}
		}
		isTop = sawActive && !higher
	}

	// 对外一律把"无限"规约成 0，前端只需判断一个值。
	storageCap := plan.StorageBytes
	if storageCap < 0 {
		storageCap = 0
	}
	if trafficCap < 0 {
		trafficCap = 0
	}
	// 已计划降级目标的展示名——用于卡片上的"待生效降级"提示。best-effort：
	// 查不到（档位下架/id 打错）就留空字符串，绝不能让整个 usage 接口报错。
	scheduledName := ""
	if u.ScheduledPlanID != "" {
		if sp, ok, _ := s.store.GetPlan(ctx, u.ScheduledPlanID); ok {
			scheduledName = sp.Name
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"period":   period,
		"resetsAt": monthEnd,
		"traffic":  map[string]any{"used": traffic, "cap": trafficCap},
		"storage":  map[string]any{"used": storage, "cap": storageCap},
		// 套餐信息复用上面已经查出的 plan 行，不额外打 DB。
		// trafficBytes 是这个档的**标称**月上限，和上面 traffic.cap 不同：后者
		// 对月中改过档的用户是按段折算过的实际额度。卡片要宣传的是标称值。
		"plan": map[string]any{
			"id":                 plan.ID,
			"name":               plan.Name,
			"storageBytes":       nonNegCap(plan.StorageBytes),
			"trafficBytes":       nonNegCap(plan.TrafficBytes),
			"retentionSecs":      nonNegCap(plan.RetentionSecs),
			"priceMonthly":       plan.PriceMonthly,
			"priceYearly":        plan.PriceYearly,
			"isTop":              isTop,
			"subscriptionStatus": u.SubscriptionStatus,
			"subscriptionEnd":    u.SubscriptionEnd,
			"billingCycle":       u.BillingCycle,
			"scheduledPlanId":    u.ScheduledPlanID,
			"scheduledPlanName":  scheduledName,
		},
	})
}

// nonNegCap 把"无限"的各种内部表示（负数）规约成对外约定的 0。前端只判断一个值。
func nonNegCap(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func (s *Service) handleChangePassword(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	currentSessionID := ""
	if c, err := r.Cookie(sessionCookie); err == nil {
		currentSessionID = c.Value
	}
	err := s.ChangePassword(r.Context(), u, currentSessionID, in.CurrentPassword, in.NewPassword)
	switch {
	case errors.Is(err, ErrBadCredentials):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "current password incorrect"})
	case errors.Is(err, ErrWeakPassword):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func (s *Service) handleAuthMethods(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"password": true,
		"google":   s.cfg.EnableGoogle,
		"apple":    s.cfg.EnableApple,
		"magic":    s.cfg.EnableMagic,
	})
}

func (s *Service) writeUser(ctx context.Context, w http.ResponseWriter, code int, u User) {
	hasPass, _ := s.store.HasPassword(ctx, u.ID)
	writeJSON(w, code, map[string]any{
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "displayName": u.DisplayName,
			"hasPassword": hasPass, "emailVerified": u.EmailVerified,
		},
	})
}

func (s *Service) handleRegister(w http.ResponseWriter, r *http.Request) {
	// H2a: POST /api/auth/register sends one verification email per new address,
	// so an un-limited endpoint is an email bomb + Sybil mint. 5/min/IP.
	if s.registerLimiter != nil && !s.registerLimiter.Allow(s.clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	_, err := s.Register(r.Context(), in.Email, in.Password, in.DisplayName)
	switch {
	case errors.Is(err, ErrWeakPassword):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
	case errors.Is(err, ErrPendingDeletion):
		// Task 4: this email (or its canonical sibling) belongs to an account
		// mid-grace-period. Refuse the new registration rather than silently
		// creating a second account on the same address the original owner
		// might still reactivate into.
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "account_pending_deletion",
			"hint":  "an account for this address is scheduled for deletion; use the reactivation link emailed at delete time, or try again after the grace period ends",
		})
	case errors.Is(err, ErrEmailTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
	case errors.Is(err, ErrInvalidEmail):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_email"})
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "verification_sent", "email": normEmail(in.Email)})
	}
}

func (s *Service) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Throttle brute force per email+IP. Keying on both (not email alone) still
	// caps a single source's guessing while denying an attacker the ability to
	// lock a victim out of their own account from unrelated IPs.
	key := normEmail(in.Email) + "|" + s.clientIP(r)
	if s.pwLogins.locked(key, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, try again later"})
		return
	}
	sess, err := s.Login(r.Context(), in.Email, in.Password)
	if errors.Is(err, ErrBadCredentials) {
		s.pwLogins.recordFail(key, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	if errors.Is(err, ErrEmailUnverified) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "email_unverified", "email": normEmail(in.Email)})
		return
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen login (Task 4): correct credentials, but the account is
		// pending deletion — no session, HTTP 200 (this is not a credentials
		// failure) carrying the reactivation state instead.
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.pwLogins.reset(key)
	u, err := s.store.GetUserByID(r.Context(), sess.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(r.Context(), w, http.StatusOK, u)
}

func (s *Service) handleEmailVerify(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess, err := s.VerifyEmail(r.Context(), in.Token)
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen account (blocker fix, mirrors handlePasswordLogin's Task 4
		// guard): no session, HTTP 200 (the token itself was valid) carrying
		// the reactivation state instead.
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	if errors.Is(err, ErrInvalidToken) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_token"})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), sess.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(r.Context(), w, http.StatusOK, u)
}

func (s *Service) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	email := normEmail(in.Email)
	// Anti-enumeration + anti-bomb: throttle per email+IP; only resend when the
	// account exists AND is still unverified; always respond 200.
	if email != "" {
		key := email + "|" + s.clientIP(r)
		if !s.verifyRequests.locked(key, s.now()) {
			s.verifyRequests.recordFail(key, s.now())
			if uid, _, ok, _ := s.store.GetCredentials(r.Context(), email); ok {
				if verified, _ := s.store.EmailVerified(r.Context(), uid); !verified {
					if u, err := s.store.GetUserByID(r.Context(), uid); err == nil {
						_ = s.SendVerifyEmail(r.Context(), u)
					}
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	email := normEmail(in.Email)
	if email != "" {
		key := email + "|" + s.clientIP(r)
		if !s.resetRequests.locked(key, s.now()) {
			s.resetRequests.recordFail(key, s.now())
			_ = s.RequestPasswordReset(r.Context(), email)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess, err := s.ResetPassword(r.Context(), in.Token, in.NewPassword)
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen account (blocker fix, mirrors handlePasswordLogin's Task 4
		// guard): no session, HTTP 200 (the token itself was valid) carrying
		// the reactivation state instead — the password is left unchanged
		// (ResetPassword checks DeletedAt before mutating anything).
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	switch {
	case errors.Is(err, ErrWeakPassword):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
		return
	case errors.Is(err, ErrInvalidToken):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_token"})
		return
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), sess.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(r.Context(), w, http.StatusOK, u)
}
