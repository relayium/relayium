package account

import (
	_ "embed"
	"net/http"
)

// The iOS client policy, served verbatim at GET /api/client-policy/ios.
//
// Same shape of decision as the Windows route beside it, for the same
// reasons:
//
//   - It is a FILE, served byte for byte, so the iOS decoder
//     (`IOSVersionPolicy.decode` in RelayiumAppKit) and this server cannot
//     drift: `IOSVersionSupportTests` decodes these same bytes.
//   - It is INERT. Revision 1 is exactly the app's embedded floor: no
//     minimum, no recommendation, and no channel availability — so every iOS
//     build reads "nothing to offer". Choosing a real minimum is an owner
//     decision (C02) and is deliberately not made here.
//   - There is no admin form. The availability fields are what let the app
//     offer an update, and a version may only appear in one after it is
//     verified obtainable on that channel: `appStoreVersion` once it is
//     publicly live on the App Store, `testFlightVersion` once testers can
//     install it. With no verified iOS release catalogue to validate a form
//     against, an editable field could advertise a build nobody can get.
//     Changing this file is a reviewed code change that must advance
//     `policyRevision`.
//
// The client refuses, whole, any document whose requirement exceeds every
// channel's availability, so a mistaken edit here fails open (no notice)
// rather than asking users for a build they cannot install.
//
//go:embed ios_client_policy.json
var iosClientPolicyJSON []byte

func (s *Service) handleIOSVersionPolicy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	// A cached policy is a policy that cannot be corrected when it matters.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(iosClientPolicyJSON)
}
