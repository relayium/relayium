package account

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/relayium/relayium/httpx"
)

// The browser half of adding an admin passkey.
//
//  1. On the server, `relayium-server admin enroll start --name ...` mints a
//     short-lived, single-use grant (stored hashed) bound to this BaseURL's
//     origin and RP ID, and prints https://<host>/admin/enroll#<grant> ONCE.
//  2. The operator opens it. The grant travels in the URL FRAGMENT, which the
//     browser never sends to any server (no access log, no Referer, no proxy
//     sees it); the page's script reads it, strips it from the address bar,
//     and posts it in a request body.
//  3. begin: the grant must be issued, unexpired, for this purpose and this
//     origin/RP ID. A creation challenge with user verification required and
//     every registered credential excluded is stored ON THE ENROLLMENT ROW.
//  4. finish: the WebAuthn response is verified against exactly that challenge
//     (type webauthn.create, origin, RP ID hash, UV flag). Success records a
//     PENDING credential and returns its fingerprint. A pending credential is
//     not in admin_credentials, so it cannot sign in or confirm anything.
//  5. On the server, `admin enroll approve <id> --fingerprint <fp>` checks the
//     fingerprint the operator read off this page and moves the credential into
//     admin_credentials (AdminAuthStore.ApproveEnrollment).
//
// No admin session is consulted at any step: a logged-in browser gains nothing
// here, and enrollment works with zero registered passkeys (first setup and
// lost-all-devices recovery).

const (
	// adminEnrollBodyMax bounds a request body. A WebAuthn attestation with
	// "none" format is well under 2 KiB; packed/TPM attestations with chains
	// can be a few KiB. 64 KiB is generous and still bounded.
	adminEnrollBodyMax = 64 << 10
	// adminEnrollThrottlePrefix keys enrollment failures per IP in the
	// adminLogins throttle (distinct from the step-up "stepup:" prefix).
	adminEnrollThrottlePrefix = "enroll:"
)

type adminEnrollRequest struct {
	Grant      string          `json:"grant"`
	Credential json.RawMessage `json:"credential,omitempty"`
}

// readAdminEnrollRequest parses a bounded JSON body. It never logs the body:
// it carries the grant.
func readAdminEnrollRequest(w http.ResponseWriter, r *http.Request) (adminEnrollRequest, bool) {
	var req adminEnrollRequest
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, adminEnrollBodyMax))
	if err != nil {
		httpx.WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request too large"})
		return req, false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || len(req.Grant) == 0 || len(req.Grant) > 128 {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed request"})
		return req, false
	}
	return req, true
}

func (s *Service) adminEnrollThrottleKey(r *http.Request) string {
	return adminEnrollThrottlePrefix + s.rateLimitIP(r)
}

// adminEnrollBinding reports whether e was issued for the relying party this
// server is serving right now. A grant minted for another base URL (a staging
// host, a typo) must not be spendable here, and the WebAuthn library would
// otherwise only check the origin of the FINISH, not what the grant promised.
func (s *Service) adminEnrollBinding(e AdminEnrollment) (*webauthn.WebAuthn, bool) {
	rp, err := s.adminRP()
	if err != nil {
		log.Printf("passkey enroll: building relying party failed: %v", err)
		return nil, false
	}
	if e.Purpose != adminEnrollmentPurpose || e.Origin != s.selfOrigin() || e.RPID != rp.Config.RPID {
		return nil, false
	}
	return rp, true
}

// adminEnrollUser is the WebAuthn user an enrollment creates a credential for:
// the stable admin handle recorded at start, with every registered credential
// listed so the authenticator excludes devices that already hold one.
func (s *Service) adminEnrollUser(r *http.Request, e AdminEnrollment) (*adminPasskeyUser, error) {
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil {
		return nil, err
	}
	if len(user.handle) > 0 && !bytes.Equal(user.handle, e.UserHandle) {
		return nil, errors.New("enrollment user handle differs from registered passkeys")
	}
	user.handle = e.UserHandle
	return user, nil
}

func adminEnrollNoStore(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
}

// handleAdminEnrollPage serves the static enrollment page. It reads nothing
// from the request beyond the language preference; the grant is in the
// fragment and never reaches this handler.
func (s *Service) handleAdminEnrollPage(w http.ResponseWriter, r *http.Request) {
	adminEnrollNoStore(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = adminEnrollTmpl.Execute(w, adminEnrollData{Lang: adminLangFrom(r), Nonce: CSPNonce(r)})
}

// handleAdminEnrollBegin issues a creation challenge for an issued grant.
func (s *Service) handleAdminEnrollBegin(w http.ResponseWriter, r *http.Request) {
	adminEnrollNoStore(w)
	if !s.passkeyBeginAllowed(w, r) {
		return
	}
	key := s.adminEnrollThrottleKey(r)
	now := s.now()
	if s.adminLogins.locked(key, now) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts; try again later"})
		return
	}
	req, ok := readAdminEnrollRequest(w, r)
	if !ok {
		return
	}
	e, ok, err := s.store.AdminEnrollmentByGrant(r.Context(), req.Grant, now.Unix())
	if err != nil {
		log.Printf("passkey enroll: reading enrollment failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !ok {
		s.adminLogins.recordFail(key, now)
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "this enrollment link is invalid, already used, or expired; start a new one on the server"})
		return
	}
	rp, ok := s.adminEnrollBinding(e)
	if !ok {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "this enrollment link was issued for a different site address"})
		return
	}
	user, err := s.adminEnrollUser(r, e)
	if err != nil {
		log.Printf("passkey enroll: %v", err)
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "start a new enrollment on the server"})
		return
	}
	user.name = s.adminUser()
	creation, sess, err := rp.BeginRegistration(user, adminRegistrationOpts(user.creds)...)
	if err != nil {
		log.Printf("passkey enroll: BeginRegistration failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not start enrollment"})
		return
	}
	blob, err := json.Marshal(sess)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	challengeExpires := now.Add(adminEnrollChallengeTTL).Unix()
	if challengeExpires > e.ExpiresAt {
		challengeExpires = e.ExpiresAt
	}
	set, err := s.store.SetAdminEnrollmentChallenge(r.Context(), e.ID, string(blob), now.Unix(), challengeExpires)
	if err != nil || !set {
		if err != nil {
			log.Printf("passkey enroll: storing challenge failed: %v", err)
		}
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "this enrollment is no longer open"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, creation)
}

// handleAdminEnrollFinish verifies the browser's attestation against the
// enrollment's stored challenge and records a PENDING credential.
func (s *Service) handleAdminEnrollFinish(w http.ResponseWriter, r *http.Request) {
	adminEnrollNoStore(w)
	key := s.adminEnrollThrottleKey(r)
	now := s.now()
	if s.adminLogins.locked(key, now) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts; try again later"})
		return
	}
	req, ok := readAdminEnrollRequest(w, r)
	if !ok {
		return
	}
	e, ok, err := s.store.AdminEnrollmentByGrant(r.Context(), req.Grant, now.Unix())
	if err != nil {
		log.Printf("passkey enroll: reading enrollment failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !ok {
		s.adminLogins.recordFail(key, now)
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "this enrollment link is invalid, already used, or expired; start a new one on the server"})
		return
	}
	fail := func(status int, msg string) {
		// Burn the challenge: a finish is one-shot, valid or not.
		if err := s.store.FailAdminEnrollmentFinish(r.Context(), e.ID, now.Unix()); err != nil {
			log.Printf("passkey enroll: recording failed finish: %v", err)
		}
		s.adminLogins.recordFail(key, now)
		httpx.WriteJSON(w, status, map[string]string{"error": msg})
	}
	if e.Challenge == "" || e.ChallengeExpiresAt <= now.Unix() {
		fail(http.StatusBadRequest, "the passkey prompt expired; reload this page and try again")
		return
	}
	rp, ok := s.adminEnrollBinding(e)
	if !ok {
		fail(http.StatusConflict, "this enrollment link was issued for a different site address")
		return
	}
	var sess webauthn.SessionData
	if err := json.Unmarshal([]byte(e.Challenge), &sess); err != nil {
		fail(http.StatusInternalServerError, "server error")
		return
	}
	if len(req.Credential) == 0 {
		fail(http.StatusBadRequest, "malformed request")
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		fail(http.StatusBadRequest, "passkey verification failed")
		return
	}
	user, err := s.adminEnrollUser(r, e)
	if err != nil {
		log.Printf("passkey enroll: %v", err)
		fail(http.StatusConflict, "start a new enrollment on the server")
		return
	}
	cred, err := rp.CreateCredential(user, sess, parsed)
	if err != nil {
		fail(http.StatusBadRequest, "passkey verification failed")
		return
	}
	// Defence in depth over the library: the credential must carry the UV and
	// UP flags we required at begin.
	if !cred.Flags.UserVerified || !cred.Flags.UserPresent {
		fail(http.StatusBadRequest, "passkey verification failed: user verification is required")
		return
	}
	blob, err := json.Marshal(cred)
	if err != nil {
		fail(http.StatusInternalServerError, "server error")
		return
	}
	fp := adminFingerprintOf(cred.ID, cred.PublicKey)
	done, err := s.store.FinishAdminEnrollment(r.Context(), e.ID, e.Challenge, b64url(cred.ID), blob, fp, now.Unix())
	if err != nil {
		log.Printf("passkey enroll: recording pending credential failed: %v", err)
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !done {
		// Lost a race with another finish, the grant expired meanwhile, or the
		// credential is already registered. Nothing was recorded.
		fail(http.StatusConflict, "this enrollment is no longer open, or this passkey is already registered")
		return
	}
	s.adminLogins.reset(key)
	s.WriteAudit(r, AuditPasskeyEnrollFinish, "enrollment:"+e.ID,
		[]ChangeField{{Field: "state", Old: enrollIssued, New: enrollPending},
			{Field: "fingerprint", Old: "", New: fp}}, StepUpNone)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"enrollment":  e.ID,
		"name":        e.Name,
		"fingerprint": fp,
		"expires_at":  time.Unix(e.ExpiresAt, 0).UTC().Format(time.RFC3339),
	})
}
