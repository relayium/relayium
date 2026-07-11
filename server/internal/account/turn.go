package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"time"
)

// nodeOnlineWindow bounds how long since its last heartbeat a node is still
// offered in the pool. 3x the node heartbeat interval (nodeHeartbeatInterval).
const nodeOnlineWindow = 90 * time.Second

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

	// Strict mode ("only my nodes") withholds our fleet pool and legacy TURN,
	// offering only the owner's own self-hosted nodes. Computed once and reused
	// by both the legacy top-level entry and the relay-pool block below. A read
	// error (including user-not-found) falls back to non-strict — the reliable
	// default that never accidentally strands a transfer without relay.
	strict := false
	if validCode {
		if u, err := s.store.GetUserByID(r.Context(), owner); err == nil {
			strict = u.OnlyOwnNodes
		}
	}

	// Legacy single TURN stays in the top-level iceServers so older clients (that
	// don't read `relays`) keep working unchanged. Withheld in strict mode.
	if validCode && !strict && s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, s.cfg.TURNURLs))
	}

	resp := map[string]any{"iceServers": servers}

	// Multi-relay pool: the owner's own nodes are always included (free
	// self-hosted relay); the fleet pool (online self-registered fleet nodes ∪
	// legacy static RELAYIUM_TURN_RELAYS) is unioned in only when not strict.
	// Each entry carries its own ephemeral credential so the client can measure
	// RTT and pick the fastest. Dynamic nodes win a shared id.
	if validCode {
		relays := make([]relayEntry, 0)
		seen := map[string]bool{}
		since := now.Add(-nodeOnlineWindow).Unix()

		// The owner's own nodes (free relay), always included.
		if own, err := s.store.UserNodes(r.Context(), owner, since); err == nil {
			for _, n := range own {
				if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 {
					continue
				}
				relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
					ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
				seen[n.ID] = true
			}
		} else {
			log.Printf("ice: UserNodes read failed: %v (own-node routing skipped)", err)
		}

		if !strict {
			// Per-node monthly traffic hard cap: skip any fleet node whose
			// relayed bytes this month have reached its admin-set limit. Computed
			// once per request; a read error fails open (no node withheld).
			monthStart, _ := monthRange(periodOf(now.Unix()))
			monthlyUsed, muErr := s.store.NodeRelayedSince(r.Context(), monthStart)
			if muErr != nil {
				log.Printf("ice: NodeRelayedSince read failed: %v (traffic caps not enforced this request)", muErr)
			}
			if nodes, err := s.store.OnlineNodes(r.Context(), since); err == nil {
				for _, n := range nodes {
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					if n.TrafficLimitBytes > 0 && monthlyUsed[n.ID] >= n.TrafficLimitBytes {
						continue // over monthly traffic cap — withhold this node
					}
					relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
						ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
					seen[n.ID] = true
				}
			} else {
				log.Printf("ice: OnlineNodes read failed: %v (static-only)", err)
			}
			for _, rc := range s.cfg.TURNRelays {
				if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 || seen[rc.ID] {
					continue // skip misconfigured or already-covered-by-a-dynamic-node
				}
				relays = append(relays, relayEntry{ID: rc.ID, Region: rc.Region, STUN: rc.STUN,
					ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)}})
			}
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
