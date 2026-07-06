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

// relayEntry describes one member of the TURN pool: its id/region plus a
// ready-to-use iceServers list (the TURN URLs with a fresh ephemeral credential).
// The client measures RTT to each and both peers converge on the fastest common id.
type relayEntry struct {
	ID         string      `json:"id"`
	Region     string      `json:"region,omitempty"`
	STUN       string      `json:"stun,omitempty"`
	ICEServers []ICEServer `json:"iceServers"`
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
	code := r.URL.Query().Get("code")
	owner := ""
	validCode := false
	if code != "" && s.pairCodeOwner != nil {
		owner, validCode = s.pairCodeOwner(code)
	}
	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()

	// The credential username embeds the owner userID (and code) so coturn→Redis→
	// metering attributes relay bytes to the owning account.
	token := owner + "." + code

	// Legacy single TURN stays in the top-level iceServers so older clients (that
	// don't read `relays`) keep working unchanged.
	if validCode && s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, s.cfg.TURNURLs))
	}

	resp := map[string]any{"iceServers": servers}

	// Multi-relay pool: one self-contained entry per relay, each with its own
	// ephemeral credential, so the client can measure and pick the fastest.
	if validCode && len(s.cfg.TURNRelays) > 0 {
		relays := make([]relayEntry, 0, len(s.cfg.TURNRelays))
		for _, rc := range s.cfg.TURNRelays {
			if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 {
				continue // skip a misconfigured relay rather than emitting a dead entry
			}
			relays = append(relays, relayEntry{
				ID:         rc.ID,
				Region:     rc.Region,
				STUN:       rc.STUN,
				ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)},
			})
		}
		if len(relays) > 0 {
			resp["relays"] = relays
		}
	}

	writeJSON(w, http.StatusOK, resp)
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
