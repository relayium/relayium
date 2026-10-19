package account

import "net/http"

// The browser used to add admin passkeys (register begin/finish, gated by a
// password+TOTP re-check) and delete them (behind step-up). Both are gone:
// admin sign-in is Passkey-only, so a logged-in browser that could add a key
// would turn one stolen session into a permanent backdoor, and one that could
// delete keys would turn it into a lockout. Credentials are now enrolled with
// a terminal-issued grant and approved at the terminal (admin_enroll.go,
// AdminAuthStore), and revoked only from the terminal.
//
// These three methods remain solely because ext.AdminHost (server/ext, outside
// this package) still names them. They are not mounted on any route
// (RegisterAdmin mounts handleAdminRemovedEndpoint on the old paths), read
// nothing from the request, and can neither add nor remove a credential even
// when called directly with a valid admin session.

// HandleAdminPasskeyRegisterBegin is inert: always 410, no side effect.
func (s *Service) HandleAdminPasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	s.handleAdminRemovedEndpoint(w, r)
}

// HandleAdminPasskeyRegisterFinish is inert: always 410, no side effect.
func (s *Service) HandleAdminPasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	s.handleAdminRemovedEndpoint(w, r)
}

// HandleAdminPasskeyDelete is inert: always 410, no side effect.
func (s *Service) HandleAdminPasskeyDelete(w http.ResponseWriter, r *http.Request) {
	s.handleAdminRemovedEndpoint(w, r)
}
