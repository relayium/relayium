package account

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
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

// ceremonyKind distinguishes a login ceremony from a registration one. Both
// kinds travel in the same cookie and live in the same map, so without an
// explicit tag either finish handler would accept either ceremony. That matters
// asymmetrically: login/begin needs no authentication at all, so an attacker
// holding only a stolen admin session could mint a ceremony there and spend it
// at register/finish, walking straight around the password+TOTP step-up that
// makes a session leak recoverable rather than permanent. go-webauthn's own
// structural defense (comparing user.WebAuthnID() to session.UserID) cannot
// help here because register/finish deliberately assigns the handle from the
// ceremony — see handleAdminPasskeyRegisterFinish. This tag is what makes that
// assignment safe.
type ceremonyKind string

const (
	ceremonyLogin    ceremonyKind = "login"
	ceremonyRegister ceremonyKind = "register"
)

// passkeyCeremony is one in-flight WebAuthn ceremony. name carries the
// operator-supplied credential label through registration (finish reads the raw
// body as the credential response, so the label cannot ride along there).
type passkeyCeremony struct {
	kind    ceremonyKind
	session webauthn.SessionData
	name    string
	expires time.Time
}

// adminRegistrationOpts pins registration to a discoverable credential with
// user verification, which is what makes username-less one-tap login possible.
//
// existing must be the credentials already registered for this user. They are
// passed to the authenticator as excludeCredentials so it refuses to mint a
// second credential on a device that already holds one. Without that list a
// platform authenticator asked for a *resident* credential under the same
// (rpID, user.id) silently replaces the one it already has and hands back a new
// credential ID — the superseded DB row then lives on forever with
// last_used_at = 0. Since a never-used credential is this feature's only signal
// for a planted backdoor, a merely careless double registration would otherwise
// manufacture a permanent false positive on the single intrusion detector.
// BeginRegistration never populates CredentialExcludeList on its own; this
// option is the only thing that fills it.
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
func (s *Service) putCeremony(w http.ResponseWriter, kind ceremonyKind, sess webauthn.SessionData, name string) bool {
	tok := randToken()
	s.passkeyMu.Lock()
	// Opportunistically drop expired ceremonies so the map stays bounded even
	// between cap rejections.
	now := s.now()
	for k, c := range s.passkeyCeremonies {
		if now.After(c.expires) {
			delete(s.passkeyCeremonies, k)
		}
	}
	if len(s.passkeyCeremonies) >= passkeyCeremonyCap {
		// Reject rather than evict: evicting an existing entry would let an
		// attacker knock a legitimate in-flight login out just by flooding
		// begin. This is an O(1) check, so the rejection path itself cannot
		// become the DoS.
		s.passkeyMu.Unlock()
		return false
	}
	s.passkeyCeremonies[tok] = passkeyCeremony{
		kind: kind, session: sess, name: name, expires: now.Add(passkeyCeremonyTTL),
	}
	s.passkeyMu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: passkeyCeremonyCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(passkeyCeremonyTTL / time.Second),
	})
	return true
}

// takeCeremony consumes the ceremony one-shot: a challenge must never be
// replayable.
func (s *Service) takeCeremony(r *http.Request) (passkeyCeremony, bool) {
	c, err := r.Cookie(passkeyCeremonyCookie)
	if err != nil || c.Value == "" {
		return passkeyCeremony{}, false
	}
	s.passkeyMu.Lock()
	cer, ok := s.passkeyCeremonies[c.Value]
	delete(s.passkeyCeremonies, c.Value)
	s.passkeyMu.Unlock()
	if !ok || s.now().After(cer.expires) {
		return passkeyCeremony{}, false
	}
	return cer, true
}

func (s *Service) handleAdminPasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	assertion, sess, err := rp.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		log.Printf("passkey: BeginDiscoverableLogin failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起验证"})
		return
	}
	if !s.putCeremony(w, ceremonyLogin, *sess, "") {
		log.Printf("passkey: ceremony cap (%d) reached, rejecting login/begin", passkeyCeremonyCap)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "系统繁忙，请稍后再试"})
		return
	}
	writeJSON(w, http.StatusOK, assertion)
}

func (s *Service) handleAdminPasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	// takeCeremony deletes unconditionally, so a wrong-kind attempt burns the
	// ceremony just like a missing/expired one — it cannot be retried, and the
	// response is identical so the two are indistinguishable to a caller.
	cer, ok := s.takeCeremony(r)
	if !ok || cer.kind != ceremonyLogin {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "验证已过期，请重试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
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
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "尚未注册 passkey"})
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
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "验证失败"})
		return
	}
	// CloneWarning means the counter went backwards: two copies of the private
	// key may be in use. The library already tolerates counters that stay at 0
	// (iCloud Keychain and other synced passkeys never increment).
	if cred.Authenticator.CloneWarning {
		s.adminPasskeyLogins.recordFail(ip, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "凭据异常，已拒绝"})
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
	tok := s.newAdminSession("passkey")
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	// adminAuthMethod 从 r 的 cookie 反查会话；这个请求本身还没带上刚铸造的
	// cookie（它只被写进了响应），所以这里手动补一份到 r 上，writeAudit 才能
	// 读出 auth=passkey 而不是空字符串。
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	s.writeAudit(r, AuditLoginOK, "-", nil, StepUpNone)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
