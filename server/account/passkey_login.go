package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
)

const (
	// passkeyCeremonyCookie ties a begin call to its finish call. The library
	// requires SessionData be anchored to the user agent and not client-modifiable.
	passkeyCeremonyCookie = "relayium_admin_ceremony"
	passkeyCeremonyTTL    = 5 * time.Minute
	// passkeyCeremonyCap bounds the number of concurrent in-flight ceremonies.
	// login/begin requires no authentication, so without a cap an unauthenticated
	// client could loop on begin and hold one live webauthn.SessionData per call
	// for the full TTL, growing the map without bound and turning putCeremony's
	// expiry sweep into an ever-larger O(n) scan taken under passkeyMu. The
	// legitimate concurrent-ceremony count for a single-admin panel is tiny, so
	// this can stay generous without ever affecting real use.
	passkeyCeremonyCap = 2000
)

// ceremonyKind distinguishes a login ceremony from a step-up one. Both kinds
// travel in the same cookie and live in the same table, so without an explicit
// tag either consumer would accept either ceremony. That matters
// asymmetrically: login/begin needs no authentication at all, so without the
// tag a stolen admin session could mint a ceremony there and spend it as a
// step-up. (Browser registration ceremonies no longer exist: a new passkey is
// enrolled through a grant-bound challenge stored on its enrollment row, see
// admin_enroll.go, and can never be satisfied by either kind below.)
type ceremonyKind string

const (
	ceremonyLogin ceremonyKind = "login"
	// ceremonyStepUp is minted by /admin/stepup/passkey/begin and spent by
	// verifyStepUpPasskey, which rejects any other kind.
	ceremonyStepUp ceremonyKind = "stepup"
)

// passkeyCeremony is one in-flight WebAuthn ceremony. name carries the
// operator-supplied credential label through registration (finish reads the raw
// body as the credential response, so the label cannot ride along there).
type passkeyCeremony struct {
	kind    ceremonyKind
	session webauthn.SessionData
	name    string
	expires time.Time
	// generation is the admin auth generation this ceremony began under (-1
	// for a row from an older binary). A ceremony begun before a revocation
	// can never yield a session or a step-up afterwards — see admin_auth_state.
	generation int64
}

// adminRegistrationOpts pins enrollment to a discoverable credential with
// user verification, which is what makes username-less one-tap login possible.
//
// existing must be the credentials already registered for this user. They are
// passed to the authenticator as excludeCredentials so it refuses to mint a
// second credential on a device that already holds one. Without that list a
// platform authenticator asked for a *resident* credential under the same
// (rpID, user.id) silently replaces the one it already has and hands back a new
// credential ID — the superseded DB row then lives on forever with
// last_used_at = 0. BeginRegistration never populates CredentialExcludeList on
// its own; this option is the only thing that fills it.
func adminRegistrationOpts(existing []webauthn.Credential) []webauthn.RegistrationOption {
	exclude := make([]protocol.CredentialDescriptor, 0, len(existing))
	for i := range existing {
		exclude = append(exclude, existing[i].Descriptor())
	}
	return []webauthn.RegistrationOption{
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
	}
}

// putCeremony stores sess under a fresh cookie-borne token and returns true,
// or returns false without writing a cookie if the in-flight ceremony cap is
// already at passkeyCeremonyCap. On false, the caller must reject the request
// rather than fall through — see passkeyCeremonyCap's comment for why.
//
// kind is a parameter rather than a field set by the caller afterwards so that
// a ceremony cannot be stored untagged: the compiler forces every present and
// future call site to state which ceremony it is minting.
func (s *Service) putCeremony(ctx context.Context, w http.ResponseWriter, kind ceremonyKind, sess webauthn.SessionData, name string) bool {
	blob, err := json.Marshal(sess)
	if err != nil {
		return false
	}
	tok := authx.RandToken()
	now := s.now().Unix()
	// The store transaction drops expired rows + enforces the cap (reject, not
	// evict — see passkeyCeremonyCap) + inserts, so the challenge is spendable on
	// any instance exactly once.
	ok, err := s.store.PutPasskeyCeremony(ctx, tok, string(kind), string(blob), name,
		now, now+int64(passkeyCeremonyTTL.Seconds()), passkeyCeremonyCap)
	if err != nil || !ok {
		return false
	}
	http.SetCookie(w, &http.Cookie{
		Name: passkeyCeremonyCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(passkeyCeremonyTTL / time.Second),
	})
	return true
}

// takeCeremony consumes the ceremony one-shot: a challenge must never be
// replayable. The atomic DELETE ... RETURNING in the store makes the claim
// exactly-once across instances.
func (s *Service) takeCeremony(r *http.Request) (passkeyCeremony, bool) {
	c, err := r.Cookie(passkeyCeremonyCookie)
	if err != nil || c.Value == "" {
		return passkeyCeremony{}, false
	}
	kind, blob, name, expires, gen, ok, err := s.store.TakePasskeyCeremony(r.Context(), c.Value)
	if err != nil || !ok || s.now().Unix() > expires {
		return passkeyCeremony{}, false
	}
	var sess webauthn.SessionData
	if err := json.Unmarshal([]byte(blob), &sess); err != nil {
		return passkeyCeremony{}, false
	}
	return passkeyCeremony{kind: ceremonyKind(kind), session: sess, name: name, expires: time.Unix(expires, 0), generation: gen}, true
}

// HandleAdminStepUpPasskeyBegin issues a WebAuthn assertion challenge for a
// step-up passkey confirmation. It requires an existing admin session — the
// step-up sits on top of an already-authenticated operator — and mints a
// ceremonyStepUp. verifyStepUpPasskey refuses any other kind, so a challenge
// obtained here cannot be diverted, and one obtained at the unauthenticated
// login/begin cannot be spent here.
func (s *Service) HandleAdminStepUpPasskeyBegin(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "未登录"})
		return
	}
	if !s.passkeyBeginAllowed(w, r) {
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	assertion, sess, err := rp.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		log.Printf("passkey: step-up BeginDiscoverableLogin failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起验证"})
		return
	}
	if !s.putCeremony(r.Context(), w, ceremonyStepUp, *sess, "") {
		log.Printf("passkey: ceremony cap (%d) reached, rejecting stepup/begin", passkeyCeremonyCap)
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "系统繁忙，请稍后再试"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, assertion)
}

// stepUpProof is what a verified factor is bound to: the auth generation it
// was proved under and, for a passkey, the credential that produced it.
// HandleAdminConfirm re-checks both at the final authorization point, after
// verification, so a revocation landing while the proof was being verified
// (or its credential written back) refuses the action.
type stepUpProof struct {
	generation   int64
	credentialID string // "" for grace
}

// verifyStepUpPasskey validates the WebAuthn assertion a confirmation POST
// carries in its factor_assertion field against a ceremonyStepUp challenge. It
// is the passkey arm of verifyStepUpFactor and returns false on any failure —
// wrong kind, absent/expired ceremony, malformed or invalid assertion, or a
// clone-warning counter — so the pending action is left unapplied.
func (s *Service) verifyStepUpPasskey(r *http.Request) (stepUpProof, bool) {
	// takeCeremony deletes unconditionally, so a wrong-kind or replayed attempt
	// burns the challenge just like a valid one — it cannot be retried.
	cer, ok := s.takeCeremony(r)
	if !ok || cer.kind != ceremonyStepUp {
		return stepUpProof{}, false
	}
	// The revocation fence: a step-up challenge issued before any revocation
	// (revoke-all, or revoking a passkey) cannot confirm anything after it.
	// Pre-fence rows carry -1 and always fail here.
	if gen, err := s.store.AdminAuthGeneration(r.Context()); err != nil || gen != cer.generation {
		return stepUpProof{}, false
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		return stepUpProof{}, false
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil || len(user.creds) == 0 {
		if err != nil {
			log.Printf("passkey: loading admin passkey user failed: %v", err)
		}
		return stepUpProof{}, false
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(
		strings.NewReader(r.FormValue("factor_assertion")))
	if err != nil {
		return stepUpProof{}, false
	}
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		if !bytes.Equal(userHandle, user.handle) {
			return nil, errors.New("unknown user handle")
		}
		return user, nil
	}
	cred, err := rp.ValidateDiscoverableLogin(handler, cer.session, parsed)
	if err != nil {
		return stepUpProof{}, false
	}
	// A backwards-going sign counter (two copies of the key in use) is refused
	// here exactly as it is at login.
	if cred.Authenticator.CloneWarning {
		return stepUpProof{}, false
	}
	// Best effort: a failed sign-counter / last_used_at write-back must not fail
	// an otherwise valid step-up.
	if blob, err := json.Marshal(cred); err == nil {
		if err := s.store.TouchAdminCredential(r.Context(), b64url(cred.ID), blob, s.now().Unix()); err != nil {
			log.Printf("passkey: step-up TouchAdminCredential failed: %v", err)
		}
	}
	// The generation equality was checked above, BEFORE the cryptography, so
	// an obviously stale ceremony is not even verified. It is not the final
	// word: HandleAdminConfirm re-checks generation + credential after this
	// returns (stepUpProof), which is what defeats a revocation that lands
	// during verification or the write-back above.
	return stepUpProof{generation: cer.generation, credentialID: b64url(cred.ID)}, true
}

func (s *Service) HandleAdminPasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !s.passkeyBeginAllowed(w, r) {
		return
	}
	ip := s.rateLimitIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	assertion, sess, err := rp.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		log.Printf("passkey: BeginDiscoverableLogin failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起验证"})
		return
	}
	if !s.putCeremony(r.Context(), w, ceremonyLogin, *sess, "") {
		log.Printf("passkey: ceremony cap (%d) reached, rejecting login/begin", passkeyCeremonyCap)
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "系统繁忙，请稍后再试"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, assertion)
}

func (s *Service) HandleAdminPasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.rateLimitIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	// takeCeremony deletes unconditionally, so a wrong-kind attempt burns the
	// ceremony just like a missing/expired one — it cannot be retried, and the
	// response is identical so the two are indistinguishable to a caller.
	cer, ok := s.takeCeremony(r)
	if !ok || cer.kind != ceremonyLogin {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "验证已过期，请重试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil || len(user.creds) == 0 {
		// A store failure and a genuinely empty table get the same response on
		// purpose — the caller is unauthenticated and must not learn which.
		// The operator, however, needs to tell a DB outage apart from "nobody
		// registered a passkey yet", so the distinction goes to the log only.
		if err != nil {
			log.Printf("passkey: loading admin passkey user failed: %v", err)
		} else {
			log.Printf("passkey: login attempted with no credentials registered")
		}
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "尚未注册 passkey"})
		return
	}
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		if !bytes.Equal(userHandle, user.handle) {
			return nil, errors.New("unknown user handle")
		}
		return user, nil
	}
	_, cred, err := rp.FinishPasskeyLogin(handler, cer.session, r)
	if err != nil {
		s.adminPasskeyLogins.recordFail(ip, s.now())
		// Recorded without any detail from the request: a failed assertion
		// carries nothing an operator needs, and the audit row must never hold
		// attacker-supplied bytes.
		s.WriteAudit(r, AuditLoginFail, "-", nil, StepUpNone)
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "验证失败"})
		return
	}
	// CloneWarning means the counter went backwards: two copies of the private
	// key may be in use. The library already tolerates counters that stay at 0
	// (iCloud Keychain and other synced passkeys never increment).
	if cred.Authenticator.CloneWarning {
		s.adminPasskeyLogins.recordFail(ip, s.now())
		s.WriteAudit(r, AuditLoginFail, "passkey:"+b64url(cred.ID), nil, StepUpNone)
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "凭据异常，已拒绝"})
		return
	}
	blob, err := json.Marshal(cred)
	if err == nil {
		// Best effort: a failed write-back must not block a valid login.
		if err := s.store.TouchAdminCredential(r.Context(), b64url(cred.ID), blob, s.now().Unix()); err != nil {
			log.Printf("passkey: TouchAdminCredential failed: %v", err)
		}
	} else {
		// Realistically unreachable for a webauthn.Credential, but silently
		// losing the sign-counter/last_used_at write-back would otherwise go
		// unnoticed.
		log.Printf("passkey: marshaling credential for write-back failed: %v", err)
	}
	s.adminPasskeyLogins.reset(ip)
	// The session is bound to THIS credential: revoking it at the terminal
	// ends this session, and the session stops validating the moment the
	// credential row is gone even if that delete raced this insert.
	tok, err := s.newAdminSession(r.Context(), b64url(cred.ID), cer.generation)
	if errors.Is(err, ErrAdminSessionRefused) {
		// The credential was revoked, or every session was revoked, after this
		// ceremony began — possibly after the assertion above was verified.
		// The store refused atomically; nothing was issued.
		s.WriteAudit(r, AuditLoginFail, "passkey:"+b64url(cred.ID), nil, StepUpNone)
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "登录期间凭据或会话已被撤销，请重新登录"})
		return
	}
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "服务器错误"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionAbsoluteTTL / time.Second),
	})
	// adminAuthMethod 从 r 的 cookie 反查会话；这个请求本身还没带上刚铸造的
	// cookie（它只被写进了响应），所以这里手动补一份到 r 上，WriteAudit 才能
	// 读出 auth=passkey 而不是空字符串。
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	s.WriteAudit(r, AuditLoginOK, "passkey:"+b64url(cred.ID), nil, StepUpNone)
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
