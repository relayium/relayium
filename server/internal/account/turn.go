package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
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
	// H1: brute-forcing the 6-digit pairing code (10^6 space, 15-min TTL) would
	// steal a victim's TURN credentials; cap per-IP attempts. 5/min/IP.
	if s.iceLimiter != nil && !s.iceLimiter.Allow(s.clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	servers := s.stunServers()
	code := r.URL.Query().Get("code")
	owner := ""
	validCode := false
	if code != "" && s.pairCodeOwner != nil {
		owner, validCode = s.pairCodeOwner(code)
	}
	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()
	relayDenied := ""

	// Sybil dampener: only a verified account may consume paid relay bandwidth.
	// Deny only when we positively know the email is unverified; on any read
	// error, fall through (fail-open) so a DB blip never blocks a real user.
	if validCode {
		if verified, err := s.store.EmailVerified(r.Context(), owner); err == nil && !verified {
			validCode = false
			relayDenied = "unverified"
		}
	}

	// Interim relay cap: withhold TURN when the code's owner is over the monthly
	// free relay allowance. On a read error, fail open (issue TURN) rather than
	// blocking a legit transfer. Per-plan quota (billing phase-1) supersedes this.
	if validCode {
		st := s.resolveSettings(r.Context())
		since, _ := monthRange(periodOf(now.Unix()))
		used, err := s.store.UserRelayedSince(r.Context(), owner, since)
		if err != nil {
			log.Printf("relay metering read failed for owner %s: %v (fail-open, issuing relay)", owner, err)
		} else if used >= st.RelayMonthlyFree {
			validCode = false
			relayDenied = "quota"
		}
	}

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

	if relayDenied != "" {
		resp["relayDenied"] = relayDenied
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
