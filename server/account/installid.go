package account

import "encoding/base64"

// An installation identifier is a client-generated, account-independent lookup
// hint: 32 random bytes, RawURLEncoding, 43 characters. The native app keeps
// one per installation across logout so a re-login lands on the device row it
// already owns instead of minting a third row for one machine.
//
// It is NOT a credential. Nothing here authenticates: the server may consult it
// only after a human has approved a device-code flow, and only within the
// approving account. See handleDeviceApprove and ApproveAndRegisterDeviceAuth.
const installIDLen = 43

// installIDBytes is the entropy behind those 43 characters. 32 bytes is chosen
// so that a collision between two independently generated installations is not
// a case anyone has to reason about; the collision handling that does exist
// (see ApproveAndRegisterDeviceAuth) is there for a restored disk clone, not for
// birthday luck.
const installIDBytes = 32

// validInstallID accepts exactly the canonical spelling and nothing else.
//
// Strict() is the load-bearing call, not decoration. A 32-byte value leaves two
// unused bits in its final base64 character, and a permissive decoder accepts
// four spellings of the same bytes. Since this string is used as a lookup KEY —
// compared as text, indexed as text — accepting more than one spelling would let
// one installation present two identities, or two strings claim one row. The
// same rule the Device Inbox public-key encoding already follows.
//
// An identifier that fails here is not a refusal of the login: the caller drops
// the hint and the flow proceeds exactly as it does for a client that sent none,
// which is a fresh device row. A malformed hint must never be stored, because a
// stored value that no current client can reproduce is a row that can never be
// matched again and a string no rule governs.
func validInstallID(s string) bool {
	if len(s) != installIDLen {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return err == nil && len(raw) == installIDBytes
}
