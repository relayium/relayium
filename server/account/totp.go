package account

// Admin TOTP has been removed: admin sign-in and step-up are Passkey-only.
//
// The two methods below remain solely because ext.AdminHost (server/ext,
// outside this package) still names them. They hold no secret and accept no
// code: MatchAdminTOTPStep can never succeed and AdminTOTPEnabled is always
// false, so no caller — present or future — can turn a 6-digit code back into
// an admin factor through them. A legacy RELAYIUM_ADMIN_TOTP_SECRET is ignored
// at startup (server/main.go) and never parsed, so an invalid one cannot affect
// boot either.

// MatchAdminTOTPStep always refuses.
func (s *Service) MatchAdminTOTPStep(string) (step int64, ok bool) { return 0, false }

// AdminTOTPEnabled is always false.
func (s *Service) AdminTOTPEnabled() bool { return false }
