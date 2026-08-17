package account

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/devicelabel"
)

const sessionCookie = "relayium_session"

// deleteTokenTTL bounds how long a self-serve-deletion confirm link stays
// valid — short, since it's re-requestable and email delivery is normally
// near-instant (mirrors resetTTL's role, kept separate so tuning one never
// silently retunes the other).
const deleteTokenTTL = time.Hour

// CookieSecure reports whether auth cookies should carry the Secure attribute.
// Derived from the base URL scheme: production (https) gets Secure cookies,
// while plain http://localhost development keeps real-browser login working.
func (s *Service) CookieSecure() bool {
	return strings.HasPrefix(s.cfg.BaseURL, "https://")
}

// Routes returns the account API handler. State-changing requests pass through
// CSRFGuard first; the returned http.Handler is not a *ServeMux, so callers must
// treat it as an opaque handler.
func (s *Service) Routes() http.Handler {
	return s.CSRFGuard(s.routeMux())
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

// CSRFGuard rejects state-changing requests (POST/PUT/PATCH/DELETE) whose Origin
// header is present and does not match the site's own origin. This complements
// the SameSite=Lax session cookie as defense-in-depth against CSRF: a cross-site
// attacker's fetch/XHR always sends a foreign Origin, so it is blocked here even
// if a browser or proxy quirk were to weaken SameSite enforcement. Safe methods
// (GET/HEAD/OPTIONS) and requests with no Origin (e.g. top-level OAuth/magic-link
// redirects, non-browser clients) are left alone.
func (s *Service) CSRFGuard(next http.Handler) http.Handler {
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

func (s *Service) routeMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/password/login", s.handlePasswordLogin)
	mux.HandleFunc("POST /api/auth/password/change", s.RequireSession(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/email/verify", s.handleEmailVerify)
	mux.HandleFunc("POST /api/auth/email/resend", s.handleResendVerification)
	mux.HandleFunc("POST /api/auth/password/forgot", s.handleForgotPassword)
	mux.HandleFunc("POST /api/auth/password/reset", s.handleResetPassword)
	// Self-serve account deletion (double opt-in): request is authenticated and
	// only ever emails a confirm link (no destructive action); confirm carries
	// no session (a prior confirm may already have revoked it) — the token
	// itself is the authorization, mirroring the password-reset token pattern.
	//
	// RequireAuth (session cookie OR bearer), for the same reason /api/me and
	// the device list carry it: the native apps hold a rlm_cli_ bearer and no
	// session cookie, so a session-only route puts the one control that can
	// start a deletion out of reach of the app the user is signed into. The
	// widening is bounded to the REQUEST — the only thing it can produce is an
	// email to the account's own address, and only the link in that email can
	// destroy anything. Nothing about the cookie path moves: RequireAuth tries
	// the session cookie first and CSRFGuard still rejects a cookie POST
	// carrying a foreign Origin. `confirm` below stays exactly as it was.
	mux.HandleFunc("POST /api/account/delete/request", s.RequireAuth(s.handleDeleteRequest))
	mux.HandleFunc("POST /api/account/delete/confirm", s.handleDeleteConfirm)
	// Reactivation (Task 4): also unauthed — a frozen account has no live
	// session, so the reactivate token itself is the authorization, exactly
	// like delete/confirm above.
	mux.HandleFunc("POST /api/account/reactivate", s.handleReactivate)
	mux.HandleFunc("GET /api/auth/methods", s.handleAuthMethods)
	if s.cfg.EnableMagic {
		mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
		// GET 只重定向到 SPA 页面（邮件网关预取无副作用）；POST 才消费令牌。见
		// handleMagicVerifyRedirect 的注释。
		mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerifyRedirect)
		mux.HandleFunc("POST /api/auth/magic/verify", s.handleMagicVerify)
	}
	if s.cfg.EnableGoogle {
		mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
		mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	}
	// Sign in with Apple (native app token exchange). Dormant until configured.
	if s.cfg.EnableApple {
		// Registered on EnableApple alone, unlike the browser routes below: it
		// is the app's only way in, so it answers honestly when the .p8 signing
		// material it needs to redeem an authorization code is absent
		// (503 apple_not_configured) rather than disappearing into a 404.
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
	// RequireAuth (session cookie OR bearer) so native/app clients that hold a
	// rlm_cli_ bearer — not a session cookie — can read their own profile and
	// quota. Both are GET reads; bearer requests carry no ambient auth so there
	// is no CSRF surface. The web (cookie) path is unaffected: RequireAuth tries
	// the session cookie first.
	mux.HandleFunc("GET /api/me", s.RequireAuth(s.handleMe))
	mux.HandleFunc("GET /api/me/usage", s.RequireAuth(s.handleMeUsage))
	// B3's pre-mint answer, read-only, for the choose screen (see pairmint.go).
	// It mints nothing; POST /api/pair — which lives on the ROOT mux, because it
	// is bearer-authed — re-asks the same evaluator and is what actually decides.
	// RequireAuth rather than RequireSession for the same reason /api/me carries
	// it: a bearer client may reasonably ask before it tries.
	mux.HandleFunc("GET /api/pair/preflight", s.RequireAuth(s.handlePairPreflight))
	// RequireAuth (session cookie OR bearer), for the same reason /api/me above
	// carries it: the native app's own credential IS one of the rows in this
	// list, so a session-only device list puts the one screen that can revoke it
	// out of reach of the app holding it. Reads and writes both — every one of
	// them is scoped to the caller's user id in the store, so a bearer can only
	// ever see or mutate its own account's devices.
	//
	// POST stays RequireSession on purpose: native login already registers a
	// device when it mints the bearer (see issueBearer), so nothing needs this
	// route, and leaving it session-only keeps a leaked token from minting
	// device rows.
	mux.HandleFunc("GET /api/devices", s.RequireAuth(s.handleListDevices))
	mux.HandleFunc("POST /api/devices", s.RequireSession(s.handleUpsertDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", s.RequireAuth(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.RequireAuth(s.handleDeleteDevice))
	// Device Inbox (Phase 1A). All RequireAuth; the device-self vs.
	// account-scoped split is enforced INSIDE the handlers, not by the wrapper,
	// because both halves need the same credential resolution and only some of
	// them additionally require the bearer to be bound to this device row. See
	// the authorization-model comment at the top of deviceinbox.go.
	//
	// Device-self: enrolment, keys, presence — assertions only the machine
	// holding the private key may make.
	mux.HandleFunc("PUT /api/devices/{id}/inbox", s.RequireAuth(s.handleRegisterDeviceInbox))
	mux.HandleFunc("POST /api/devices/{id}/inbox/keys", s.RequireAuth(s.handleRegisterDeviceKey))
	mux.HandleFunc("POST /api/devices/{id}/inbox/heartbeat", s.RequireAuth(s.handleDeviceInboxHeartbeat))
	mux.HandleFunc("POST /api/devices/{id}/inbox/offline", s.RequireAuth(s.handleDeviceInboxOffline))
	// Account-scoped: revocation has to work from a DIFFERENT device than the
	// one being revoked, which is the entire point of revoking a lost machine.
	mux.HandleFunc("DELETE /api/devices/{id}/inbox", s.RequireAuth(s.handleDeleteDeviceInbox))
	mux.HandleFunc("GET /api/devices/{id}/inbox/keys", s.RequireAuth(s.handleListDeviceKeys))
	mux.HandleFunc("POST /api/devices/{id}/inbox/keys/{keyId}/revoke", s.RequireAuth(s.handleRevokeDeviceKey))
	// Device Inbox task queue (Phase 1B). Same wrapper, same in-handler split:
	// create/list/read/delete are account-scoped (the browser is the primary
	// sender), while pending/claim/report/accept are device-self because they
	// assert what a machine is doing with a file. See deviceinbox_task.go.
	s.registerDeviceInboxTaskRoutes(mux)
	// The account's own view of its pair-room storage, and the control that
	// releases it (pairroom_owner.go). RequireAuth for the same reason /api/me and
	// DELETE /api/files/{id} carry it: both are scoped to the caller's user id in
	// the store, so a bearer can only ever see or release its OWN rooms, and the
	// native apps have the same right to see what they are charged for.
	//
	// Registered UNCONDITIONALLY — deliberately not behind s.preUpload. That flag
	// stops rooms being created; turning it off after one exists must not strand
	// that room's ciphertext on an account with no way to see or release it. With
	// it off and no room ever created, these two simply have nothing to report.
	mux.HandleFunc("GET /api/pair-rooms", s.RequireAuth(s.handlePairRoomHoldings))
	mux.HandleFunc("DELETE /api/pair-rooms/{id}", s.RequireAuth(s.handleReleasePairRoom))
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
	// The App Store purchase-attribution token. RequireAuth (not RequireSession)
	// because the native apps authenticate with a bearer token and this is the
	// one billing call they make; POST because it may mint the token. See
	// handleAppleAccountToken for why it is not a credential.
	mux.HandleFunc("POST /api/billing/apple/account-token", s.RequireAuth(s.handleAppleAccountToken))
	// The signed-transaction intake the token above exists to be attached to.
	// RequireAuth for the same reason: it is a native call with a bearer token,
	// and the caller's identity is half the decision — the other half is Apple's
	// signature. Unconfigured (no trust roots) it answers 503, so mounting it
	// unconditionally changes nothing for a deployment that has no Apple apps.
	// See billing_apple_transaction.go.
	mux.HandleFunc("POST /api/billing/apple/transaction", s.RequireAuth(s.handleAppleTransaction))
	// What a native build is allowed to SELL, read from the same operator-managed
	// catalog the intake above resolves a purchase through. RequireAuth for the
	// same reason both of those carry it — it is a bearer-authenticated native
	// call — and GET because it reads. Unconfigured it answers the same 503, so a
	// deployment with no Apple apps advertises nothing. See
	// billing_apple_catalog.go.
	mux.HandleFunc("GET /api/billing/apple/catalog", s.RequireAuth(s.handleAppleCatalog))
	mux.HandleFunc("GET /api/plans", s.handlePublicPlans)
	// Stripe webhook: unauthenticated (no session, no CSRF token — Stripe
	// can't provide either), authenticated instead by its own HMAC signature
	// inside handleStripeWebhook. Safe to mount on routeMux/CSRFGuard because
	// CSRFGuard only rejects a state-changing request whose Origin header is
	// PRESENT and mismatched; Stripe's webhook POSTs carry no Origin header at
	// all, so CSRFGuard's `if origin != ""` check is false and it falls
	// through untouched (see CSRFGuard above).
	mux.HandleFunc("POST /api/stripe/webhook", s.handleStripeWebhook)
	// App Store Server Notifications V2: unauthenticated for exactly the reasons
	// the Stripe webhook above is — Apple has no session and no CSRF token — and
	// authenticated instead by the signature on its own payload, verified against
	// trust roots this deployment configured. Apple's POST carries no Origin
	// header, so CSRFGuard falls through it untouched. Unconfigured it answers a
	// retryable 503, so mounting it unconditionally changes nothing for a
	// deployment that has no Apple apps. See billing_apple_notification.go.
	mux.HandleFunc("POST /api/apple/notifications", s.handleAppleNotification)
	// Device-code CLI login flow (RFC 8628-style): start/poll are called by
	// the unauthenticated CLI (it has no credential yet), approve is called
	// by the logged-in web session that confirms the code.
	mux.HandleFunc("POST /api/cli/device/start", s.handleDeviceStart)
	mux.HandleFunc("POST /api/cli/device/poll", s.handleDevicePoll)
	mux.HandleFunc("GET /api/cli/device/pending", s.RequireSession(s.handleDevicePending))
	mux.HandleFunc("POST /api/cli/device/approve", s.RequireSession(s.handleDeviceApprove))
	// GET /device (the human-facing verification_uri) is NOT registered here:
	// routeMux is mounted under /api/, so a pattern for "/device" on it is
	// unreachable. It's registered on the ROOT mux via RegisterDevicePage — see
	// main.go — so relayium.com/device actually resolves to the approval page.
	s.registerFileRoutes(mux)
	return mux
}

// handleConfig exposes the effective stored-transfer limits so clients can
// show upfront size/TTL hints without guessing. Public — no session required.
func (s *Service) handleConfig(w http.ResponseWriter, r *http.Request) {
	st := s.ResolveSettings(r.Context())
	httpx.WriteJSON(w, http.StatusOK, map[string]int64{
		"maxFileSize": st.MaxFileSize,
		"dailyQuota":  st.DailyQuota,
		"defaultTTL":  st.DefaultTTL,
		"maxTTL":      st.MaxTTL,
	})
}

// deviceView is one row of the device list as clients see it.
//
// The JSON tags spell out Go's own default capitalization rather than adopting
// lowerCamel: this response has shipped in that shape since the web devices
// section was built, and `MePage.svelte` reads `d.ID`/`d.Name`/`d.Kind`/
// `d.LastSeenAt` off it today. Renaming them to add a field would break a live
// client for no benefit; a NEW field is additive and simply ignored by clients
// that don't know it.
type deviceView struct {
	ID         string `json:"ID"`
	UserID     string `json:"UserID"`
	Name       string `json:"Name"`
	CreatedAt  int64  `json:"CreatedAt"`
	LastSeenAt int64  `json:"LastSeenAt"`
	LastIP     string `json:"LastIP"`
	Kind       string `json:"Kind"`
	// Current marks the device whose bearer token authenticated THIS request,
	// so a native client can label it and warn before revoking itself. False
	// for every row of a cookie-authenticated request: a browser holds a
	// session, not a device-bound token, so none of these rows is "the device
	// you are using" in a way that revoking would end.
	Current bool `json:"Current"`
	// Inbox is the device's Device Inbox enrolment: presence, negotiated
	// capabilities and the active public key a sender wraps a content key to.
	// NULL for a device that has never enrolled (every browser device, and any
	// CLI/app build predating Phase 1A), which is what makes this field additive
	// for the existing web client.
	Inbox *deviceInboxView `json:"Inbox"`
}

func (s *Service) handleListDevices(w http.ResponseWriter, r *http.Request, u User) {
	ds, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Two account-scoped queries rather than two per row: this list is rendered
	// on every visit to the devices page, and a per-device lookup would make it
	// O(devices) round trips against a single-writer SQLite.
	inboxes, err := s.store.ListDeviceInboxes(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	keys, err := s.store.ActiveDeviceKeys(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	currentID := s.bearerDeviceID(r, u.ID)
	out := make([]deviceView, 0, len(ds))
	for _, d := range ds {
		v := deviceView{
			ID: d.ID, UserID: d.UserID, Name: d.Name,
			CreatedAt: d.CreatedAt, LastSeenAt: d.LastSeenAt, LastIP: d.LastIP, Kind: d.Kind,
			// currentID is "" for a cookie caller, and device ids are never
			// empty, so this cannot accidentally mark a row.
			Current: currentID != "" && d.ID == currentID,
		}
		if in, ok := inboxes[d.ID]; ok {
			key, hasKey := keys[d.ID]
			v.Inbox = s.newDeviceInboxView(in, key, hasKey)
		}
		out = append(out, v)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"devices": out})
}

func (s *Service) handleUpsertDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Sanitized, not refused: this is the browser's own self-registration, and
	// failing it would leave the caller with no device at all. A name that
	// sanitizes away entirely is still a bad request — storing "" would produce
	// a nameless row nobody can identify in the revoke confirmation.
	name := devicelabel.Sanitize(in.Name)
	if name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if in.ID == "" {
		in.ID = authx.NewID()
	}
	d, err := s.store.UpsertDevice(r.Context(), Device{
		ID: in.ID, UserID: u.ID, Name: name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Service) handleRenameDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// REFUSED rather than silently sanitized, unlike the CLI's start request and
	// the browser's self-registration. This one is a person typing into a field
	// and pressing save; quietly storing something other than what they typed —
	// a pasted name with an invisible bidi mark, a 300-character paste — leaves
	// them looking at a row whose name they did not choose. Whitespace is the
	// one thing normalized without comment, because trailing spaces are not a
	// decision anybody made.
	if !devicelabel.Acceptable(in.Name) {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_device_name"})
		return
	}
	name := devicelabel.Sanitize(in.Name)
	if err := s.store.RenameDevice(r.Context(), r.PathValue("id"), u.ID, name); errors.Is(err, ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleDeleteDevice(w http.ResponseWriter, r *http.Request, u User) {
	if err := s.store.DeleteDevice(r.Context(), r.PathValue("id"), u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) setSessionCookie(w http.ResponseWriter, sess Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		Expires:  time.Unix(sess.ExpiresAt, 0),
		HttpOnly: true,
		Secure:   s.CookieSecure(),
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
		Secure:   s.CookieSecure(),
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
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// handleMagicVerifyRedirect 只把邮件里的链接转成 SPA 路由，**不碰令牌**。
//
// 以前这里是一个 GET：读 token → 消费掉 → 下发一枚长效会话 cookie → 302。企业邮件网关
// （Proofpoint / Mimecast / Defender Safe Links）会在投递前预取邮件里的每个链接，于是：
//  1. 一次性令牌被扫描器烧掉，用户真的点开时看到"链接已过期"；
//  2. 更糟的是，`Set-Cookie: <多周有效的会话>` 被交给了**扫描器的 HTTP 客户端**——一个活
//     着的登录态被投递进第三方的扫描基础设施。
//
// 现在 GET 只做重定向（对扫描器而言无副作用），真正的消费在 POST /api/auth/magic/verify
// 上，由页面上的一次点击触发。这也让它和另外三条邮件链路（验证邮箱、重置密码、删除
// 确认）终于一致——那三条本来就是"链接指向 SPA 路由、POST 才动令牌"。
//
// **不做有效性预检**：预检要么得消费令牌（回到原点），要么得新加一个"只读探测"接口，
// 而后者会把这个端点变成令牌有效性预言机。让 POST 去判，GET 一律照转。
func (s *Service) handleMagicVerifyRedirect(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	// 令牌留在 query 里：SPA 挂载时会 replaceState 把它从 URL 抹掉（与 /verify-email、
	// /reset-password 同一套做法）。
	http.Redirect(w, r, magicLinkPath+"?token="+url.QueryEscape(token), http.StatusFound)
}

// magicLinkPath 是承接邮件链接的 SPA 路由。必须与 web/src/lib/router.svelte.ts 的
// MAGIC_PATH 一致。
const magicLinkPath = "/magic-link"

func (s *Service) handleMagicVerify(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token := in.Token
	sess, err := s.VerifyMagicLink(r.Context(), token)
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen login: no session cookie. The reactivate token goes back in the
		// JSON body rather than a redirect fragment — the caller is fetch() now,
		// and a body keeps it out of both the URL and the Referer.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	if err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_token"})
		return
	}
	s.setSessionCookie(w, sess)
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	var revokeErr error
	if c, err := r.Cookie(sessionCookie); err == nil {
		revokeErr = s.store.RevokeSession(r.Context(), c.Value)
	}
	const bearerPrefix = "Bearer "
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, bearerPrefix) {
		raw := strings.TrimSpace(h[len(bearerPrefix):])
		if raw != "" {
			if err := s.store.DeleteCLIToken(r.Context(), authx.HashToken(raw)); err != nil {
				revokeErr = err
			}
		}
	}
	s.clearSessionCookie(w)
	if revokeErr != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleUsage(w http.ResponseWriter, r *http.Request, u User) {
	total, err := s.store.UserUsageTotal(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"relayedBytes": total})
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"transfers":     st.TransfersTotal,
		"downloads":     st.DownloadsTotal,
		"uploadBytes":   st.UploadBytes,
		"downloadBytes": st.DownloadBytes,
		"relayBytes":    relay,
	})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	if _, err := s.planForUser(r.Context(), u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if refreshed, err := s.store.GetUserByID(r.Context(), u.ID); err == nil {
		u = refreshed
	} else {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	hasPass, err := s.store.HasPassword(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	linked, _ := s.store.ListIdentityProviders(r.Context(), u.ID)
	// Which provider the entitlement actually comes from. NOT best-effort: this
	// field decides which billing controls the client offers, and its "unknown"
	// value is "" — indistinguishable from the free account that has no
	// subscription at all. Degrading a failed lookup to "" would put a Subscribe
	// call-to-action in front of an App Store subscriber, which is an invitation
	// to pay twice through a provider that cannot see the first subscription.
	// A 500 tells the client it has no state to render, and it retries.
	live, err := s.store.LiveEntitlementProviders(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	appleRenewal, hasAppleRenewal, err := s.store.GetAppleRenewalState(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	appleState := appleRenewalWire(appleRenewal, hasAppleRenewal, s.now())
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
			// hasBilling keeps its ORIGINAL meaning — "this account has a Stripe
			// customer", i.e. the Billing Portal is reachable — because that is
			// what every shipped client uses it for. It is deliberately NOT
			// widened into "is subscribed": an Apple subscriber has no Stripe
			// customer and no portal, and flipping this true for them would put a
			// dead "Manage billing" button in front of them.
			"hasBilling":      u.StripeCustomerID != "",
			"scheduledPlanId": u.ScheduledPlanID,
			"scheduledCycle":  u.ScheduledCycle,
			// '' when unknown (a subscription that predates the column). The UI
			// must not assume monthly in that case — it would render "switch to
			// yearly" as if it were a no-op for someone already billed yearly.
			"billingCycle": u.BillingCycle,
			// Where the entitlement comes from: "" (none), "stripe", "apple",
			// "admin", or "multiple" when more than one provider is live at once.
			// Optional by construction — absent in older server payloads, and ""
			// for every free account — so clients must default it rather than
			// require it.
			"entitlementProvider": entitlementProviderWire(u, live),
			"appleRenewal":        appleState,
		},
	})
}

func appleRenewalWire(r AppleRenewalState, ok bool, now time.Time) map[string]any {
	if !ok {
		return map[string]any{"available": false}
	}
	grace := r.IsInBillingRetry && r.GraceUntil > now.Unix()
	return map[string]any{"available": true, "currentProductId": r.CurrentProductID,
		"renewalProductId": r.AutoRenewProductID, "renewalAt": r.RenewalAt,
		"inBillingRetry": r.IsInBillingRetry, "inGracePeriod": grace, "graceUntil": r.GraceUntil}
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
	if _, err := s.planForUser(ctx, u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if refreshed, err := s.store.GetUserByID(ctx, u.ID); err == nil {
		u = refreshed
	} else {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
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
	// Same rule as /api/me, for the same reason: the plan card renders its
	// billing controls from this response, so "which provider owns this" is
	// either known or the response is refused. Unlike scheduledName above, ""
	// here is not a cosmetic gap — it is the value that means "not subscribed".
	liveProviders, err := s.store.LiveEntitlementProviders(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	appleRenewal, hasAppleRenewal, err := s.store.GetAppleRenewalState(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
			"scheduledCycle":     u.ScheduledCycle,
			// Same field, same rules, as on /api/me: the plan card renders its
			// management controls from this response and must not offer a Stripe
			// action for an entitlement Stripe does not own. "" here means "no
			// paid provider" and nothing else — the lookup above refuses rather
			// than guessing it.
			"entitlementProvider": entitlementProviderWire(u, liveProviders),
			"appleRenewal":        appleRenewalWire(appleRenewal, hasAppleRenewal, s.now()),
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
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
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
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "current password incorrect"})
	case errors.Is(err, ErrWeakPassword):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func (s *Service) handleAuthMethods(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{
		"password": true,
		"google":   s.cfg.EnableGoogle,
		"apple":    s.cfg.EnableApple,
		"magic":    s.cfg.EnableMagic,
	})
}

func (s *Service) writeUser(ctx context.Context, w http.ResponseWriter, code int, u User) {
	hasPass, _ := s.store.HasPassword(ctx, u.ID)
	httpx.WriteJSON(w, code, map[string]any{
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
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	_, err := s.Register(r.Context(), in.Email, in.Password, in.DisplayName)
	switch {
	case errors.Is(err, ErrWeakPassword):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
	case errors.Is(err, ErrPendingDeletion):
		// Task 4: this email (or its canonical sibling) belongs to an account
		// mid-grace-period. Refuse the new registration rather than silently
		// creating a second account on the same address the original owner
		// might still reactivate into.
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{
			"error": "account_pending_deletion",
			"hint":  "an account for this address is scheduled for deletion; use the reactivation link emailed at delete time, or try again after the grace period ends",
		})
	case errors.Is(err, ErrEmailTaken):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
	case errors.Is(err, ErrInvalidEmail):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_email"})
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "verification_sent", "email": normEmail(in.Email)})
	}
}

func (s *Service) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Throttle brute force per email+IP. Keying on both (not email alone) still
	// caps a single source's guessing while denying an attacker the ability to
	// lock a victim out of their own account from unrelated IPs.
	key := normEmail(in.Email) + "|" + s.clientIP(r)
	if s.pwLogins.locked(key, s.now()) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, try again later"})
		return
	}
	sess, err := s.Login(r.Context(), in.Email, in.Password)
	if errors.Is(err, ErrBadCredentials) {
		s.pwLogins.recordFail(key, s.now())
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	if errors.Is(err, ErrEmailUnverified) {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "email_unverified", "email": normEmail(in.Email)})
		return
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen login (Task 4): correct credentials, but the account is
		// pending deletion — no session, HTTP 200 (this is not a credentials
		// failure) carrying the reactivation state instead.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
		Token    string `json:"token"`
		Password string `json:"password"` // optional: confirms the registration password so it's kept
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess, err := s.VerifyEmail(r.Context(), in.Token, in.Password)
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		// Frozen account (blocker fix, mirrors handlePasswordLogin's Task 4
		// guard): no session, HTTP 200 (the token itself was valid) carrying
		// the reactivation state instead.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	if errors.Is(err, ErrInvalidToken) {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_token"})
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
	_ = httpx.DecodeJSONBody(w, r, &in)
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
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	_ = httpx.DecodeJSONBody(w, r, &in)
	email := normEmail(in.Email)
	if email != "" {
		key := email + "|" + s.clientIP(r)
		if !s.resetRequests.locked(key, s.now()) {
			s.resetRequests.recordFail(key, s.now())
			_ = s.RequestPasswordReset(r.Context(), email)
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Token == "" {
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
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	switch {
	case errors.Is(err, ErrWeakPassword):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
		return
	case errors.Is(err, ErrInvalidToken):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_token"})
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
