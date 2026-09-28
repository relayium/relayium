package account

import (
	"log"
	"net/http"

	"github.com/relayium/relayium/authx"
)

// Step-up factor attempts are throttled per admin SESSION.
//
// A confirmation POST burns its pending token, but minting another is one
// re-submit of the original form away, so without a limit the holder of a
// stolen admin session could keep guessing the second factor (a 6-digit TOTP,
// or the admin password when that is the factor) — which is exactly what the
// second factor exists to stop. After the same threshold admin login uses, the
// session is revoked: whoever holds it has to log in again, and login has its
// own per-IP lockout.
//
// The key is the session alone, not session+IP. Only the session's holder can
// reach this handler, so there is no one else to lock out, and adding the IP
// would hand an attacker a fresh budget per address. The counter lives in the
// admin-login throttle (s.adminLogins) under its own key prefix, so it shares
// that limiter's threshold, window, divisor and bounded-map sweep; an IP key
// never begins with the prefix, so the two never collide. Like every
// loginThrottle it is per-process; the revocation it triggers is in the store
// and so holds on every instance.
const stepUpThrottlePrefix = "stepup:"

func stepUpThrottleKey(sessionTok string) string {
	return stepUpThrottlePrefix + authx.HashToken(sessionTok)
}

// stepUpLocked reports whether this session has used up its factor attempts.
func (s *Service) stepUpLocked(sessionTok string) bool {
	return s.adminLogins.locked(stepUpThrottleKey(sessionTok), s.now())
}

// stepUpRecordFail counts one failed factor and reports whether that failure
// reached the lockout threshold.
func (s *Service) stepUpRecordFail(sessionTok string) bool {
	k := stepUpThrottleKey(sessionTok)
	now := s.now()
	s.adminLogins.recordFail(k, now)
	return s.adminLogins.locked(k, now)
}

// stepUpResetFails clears the count after a factor was accepted.
func (s *Service) stepUpResetFails(sessionTok string) {
	s.adminLogins.reset(stepUpThrottleKey(sessionTok))
}

// refuseStepUpLocked revokes the session and answers 429. Revocation is what
// makes the lock stick across instances and restarts; the cookie is cleared so
// the browser stops presenting a dead session.
func (s *Service) refuseStepUpLocked(w http.ResponseWriter, r *http.Request, sessionTok string) {
	if err := s.Store().DeleteAdminSession(r.Context(), sessionTok); err != nil {
		log.Printf("admin step-up: revoke session after repeated factor failures: %v", err)
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: "", Path: "/admin", MaxAge: -1,
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Error(w, "too many failed second-factor attempts; this admin session has been signed out", http.StatusTooManyRequests)
}
