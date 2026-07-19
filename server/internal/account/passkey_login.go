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
)

// passkeyCeremony is one in-flight WebAuthn ceremony. name carries the
// operator-supplied credential label through registration (finish reads the raw
// body as the credential response, so the label cannot ride along there).
type passkeyCeremony struct {
	session webauthn.SessionData
	name    string
	expires time.Time
}

// adminRegistrationOpts pins registration to a discoverable credential with
// user verification, which is what makes username-less one-tap login possible.
func adminRegistrationOpts() []webauthn.RegistrationOption {
	return []webauthn.RegistrationOption{
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	}
}

func (s *Service) putCeremony(w http.ResponseWriter, sess webauthn.SessionData, name string) {
	tok := randToken()
	s.passkeyMu.Lock()
	// Opportunistically drop expired ceremonies so the map stays bounded.
	now := s.now()
	for k, c := range s.passkeyCeremonies {
		if now.After(c.expires) {
			delete(s.passkeyCeremonies, k)
		}
	}
	s.passkeyCeremonies[tok] = passkeyCeremony{
		session: sess, name: name, expires: now.Add(passkeyCeremonyTTL),
	}
	s.passkeyMu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: passkeyCeremonyCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(passkeyCeremonyTTL / time.Second),
	})
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
	s.putCeremony(w, *sess, "")
	writeJSON(w, http.StatusOK, assertion)
}

func (s *Service) handleAdminPasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	cer, ok := s.takeCeremony(r)
	if !ok {
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
	}
	s.adminPasskeyLogins.reset(ip)
	tok := s.newAdminSession()
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
