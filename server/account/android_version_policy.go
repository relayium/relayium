package account

import (
	_ "embed"
	"net/http"
)

// The Android advisory policy is served verbatim. It deliberately contains no
// minimum and no URL: the app may only turn this recommendation into a card
// after the separately fetched official release feed names the exact same
// version/build and passes its immutable GitHub-asset checks.
//
//go:embed android_client_policy.json
var androidClientPolicyJSON []byte

func (s *Service) handleAndroidVersionPolicy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(androidClientPolicyJSON)
}
