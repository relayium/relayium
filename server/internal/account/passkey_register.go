package account

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
)

// handleAdminPasskeyRegisterBegin gates registration behind a fresh password +
// TOTP check on top of the existing session. A writable credential table is a
// permanent backdoor if a leaked session alone can add to it; registration is
// rare enough that the extra prompt costs nothing.
func (s *Service) handleAdminPasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "未登录"})
		return
	}
	ip := s.clientIP(r)
	// Step-up really is a password+TOTP check, so its failures belong in the
	// adminLogins bucket rather than the passkey-login one.
	if s.adminLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	step, ok := s.verifyAdminCreds(
		r.FormValue("username"), r.FormValue("password"), r.FormValue("totp"))
	if !ok {
		s.adminLogins.recordFail(ip, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "账号、密码或验证码错误"})
		return
	}
	if s.AdminTOTPEnabled() {
		// Atomically spend the TOTP step; an already-used code fails the step-up
		// like a bad credential (replay guard, multi-instance safe).
		if claimed, cerr := s.store.ClaimTOTPStep(r.Context(), step); cerr != nil || !claimed {
			s.adminLogins.recordFail(ip, s.now())
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "账号、密码或验证码错误"})
			return
		}
	}
	s.adminLogins.reset(ip)

	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil {
		log.Printf("passkey: loading admin passkey user failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取凭据失败"})
		return
	}
	// First registration mints the handle; later ones reuse it so all passkeys
	// belong to one WebAuthn user.
	if len(user.handle) == 0 {
		h := make([]byte, 32)
		if _, err := rand.Read(h); err != nil {
			log.Printf("passkey: minting user handle failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成标识失败"})
			return
		}
		user.handle = h
	}
	name := r.FormValue("name")
	if name == "" {
		name = "未命名设备"
	}
	// Already-registered credentials go out as excludeCredentials so a device
	// that already holds one refuses instead of silently replacing it — see
	// adminRegistrationOpts for why that matters to last_used_at.
	creation, sess, err := rp.BeginRegistration(user, adminRegistrationOpts(user.creds)...)
	if err != nil {
		log.Printf("passkey: BeginRegistration failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起注册"})
		return
	}
	if !s.putCeremony(w, ceremonyRegister, *sess, name) {
		log.Printf("passkey: ceremony cap (%d) reached, rejecting register/begin", passkeyCeremonyCap)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "系统繁忙，请稍后再试"})
		return
	}
	writeJSON(w, http.StatusOK, creation)
}

func (s *Service) handleAdminPasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "未登录"})
		return
	}
	// The kind check is the step-up boundary. login/begin is unauthenticated, so
	// without it a stolen session alone could mint a ceremony there and spend it
	// here, never facing the password+TOTP re-check above. takeCeremony deletes
	// unconditionally, so a wrong-kind attempt is consumed and cannot be retried.
	cer, ok := s.takeCeremony(r)
	if !ok || cer.kind != ceremonyRegister {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "注册已过期，请重试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey: building relying party failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil {
		log.Printf("passkey: loading admin passkey user failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取凭据失败"})
		return
	}
	// The handle minted at begin lives in the ceremony's SessionData, which is
	// the authoritative copy for this ceremony.
	user.handle = cer.session.UserID

	cred, err := rp.FinishRegistration(user, cer.session, r)
	if err != nil {
		log.Printf("passkey: FinishRegistration failed: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "注册验证失败"})
		return
	}
	blob, err := json.Marshal(cred)
	if err != nil {
		log.Printf("passkey: marshaling new credential failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "序列化失败"})
		return
	}
	err = s.store.InsertAdminCredential(r.Context(), AdminCredential{
		ID: b64url(cred.ID), UserHandle: user.handle, CredJSON: blob,
		Name: cer.name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		log.Printf("passkey: InsertAdminCredential failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleAdminPasskeyDelete removes one registered credential.
//
// This used to be deliberately exempt from step-up, on the grounds that
// deleting your own credential can only lock you out and never harms anyone
// else. That reasoning was overridden: credential removal is now treated as a
// high-risk action like the rest, because a stolen session that can silently
// strip the operator's passkeys turns a recoverable compromise into a lockout.
// The gating lives in RegisterAdmin (requireStepUp), not here.
func (s *Service) handleAdminPasskeyDelete(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	if id := r.FormValue("id"); id != "" {
		if err := s.store.DeleteAdminCredential(r.Context(), id); err != nil {
			log.Printf("passkey: DeleteAdminCredential failed: %v", err)
		}
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
