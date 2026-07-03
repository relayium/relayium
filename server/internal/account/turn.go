package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
)

// ICEServer is one entry of an RTCConfiguration.iceServers list, serialized to
// the shape the browser's RTCPeerConnection expects.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// stunServers returns the configured STUN entries (always offered, no credentials).
func (s *Service) stunServers() []ICEServer {
	if len(s.cfg.STUNURLs) == 0 {
		return nil
	}
	return []ICEServer{{URLs: s.cfg.STUNURLs}}
}

// handleICE serves the RTCConfiguration.iceServers list. STUN is always
// included; a TURN entry with an ephemeral credential is added only when the
// request names a live pairing code (?code=<code>) AND a TURN secret is
// configured. Without this, pairing-code transfers would be STUN-only and fail
// to relay across strict/symmetric NATs. It always returns 200 and never
// reveals code validity.
func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
	servers := s.stunServers()
	if s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		// The credential username embeds the pairing code so coturn validates it
		// and relay accounting can key usage by code.
		if code := r.URL.Query().Get("code"); code != "" && s.validatePairCode != nil && s.validatePairCode(code) {
			expiry := s.now().Add(s.cfg.TURNCredTTL).Unix()
			servers = append(servers, turnCredentials(s.cfg.TURNSecret, code, expiry, s.cfg.TURNURLs))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"iceServers": servers})
}

// turnCredentials builds a coturn TURN-REST ephemeral credential. The shared
// static-auth-secret lets coturn validate the credential (and read the expiry
// embedded in the username) with no per-credential server state. HMAC-SHA1 is
// the construction mandated by the TURN REST mechanism, not a security choice.
func turnCredentials(secret, token string, expiry int64, urls []string) ICEServer {
	username := fmt.Sprintf("%d:%s", expiry, token)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return ICEServer{URLs: urls, Username: username, Credential: cred}
}
