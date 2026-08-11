package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/relayium/relayium/httpx"
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
// to relay across strict/symmetric NATs.
//
// 它**确实**会泄漏配对码是否有效：状态码永远是 200，但响应体里有没有 turn: 条目
// 直接对应码的有效性。以前这里写着"never reveals code validity"，那句是假的——
// 而一句写错的安全声明比没有声明更糟，后来的改动会依赖它。
//
// 不打算把响应做成一致的：那意味着对无效码也签发中继凭据，等于把付费带宽白送给
// 任何人，代价远大于这个预言机本身。真正的边界是码的熵（10^6，见 signal.CodeLen）
// 加上**跨端点共享的**每 IP 猜测预算：/ws 和这里是同一个预言机的两半，各自记账就
// 等于把预算加起来（攻击者分摊到两个端点，一分钟能试的不同码翻倍）。所以两端现在
// 共用一个 CodeGuessLimiter（main.go 注入同一个对象），每 IP 每分钟 5 个**不同**的
// 候选码，无论怎么在两个端点之间拆分；各端点自己的请求限流仍在，用来挡重复请求的
// 纯负载。注意这是单进程口径，多实例见 PerInstanceThreshold。
func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
	// H1: 猜中一个活着的配对码就能偷走受害者的 TURN 凭据（并让对方为流量买单）。
	// 两道闸：① 本端点的请求限流（5 次/分钟/IP，挡重复请求的负载）；② 与 /ws 共享的
	// 不同候选码预算（见 signal.CodeGuessLimiter），后者才是"一个 IP 一分钟能试几个
	// 码"的真实上限。码空间是 10^6（6 位十进制数字，见 signal.CodeLen），TTL 5 分钟
	// （见 signal.CodeTTLSeconds）。
	// s.clientIP is resolved inside each guard rather than once up front: tests
	// build a bare &Service{} with no clientIP and no limiters, and an
	// unconditional call would nil-panic on them.
	if s.iceLimiter != nil && !s.iceLimiter.Allow(s.clientIP(r)) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	servers := s.stunServers()
	code := r.URL.Query().Get("code")
	// 空码是 LAN 请求（只要 STUN），不是对配对码的猜测，不记账也不拦。
	if code != "" && s.codeGuesses != nil && !s.codeGuesses.AllowCode(s.clientIP(r), code) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	owner := ""
	validCode := false
	if code != "" && s.pairCodeOwner != nil {
		owner, validCode = s.pairCodeOwner(code)
	}

	// Feed every invalid non-empty code into the process-wide brute-force breaker
	// (shared with /ws, which sheds invalid joins while OPEN). We deliberately do
	// NOT force valid codes to STUN-only while the breaker is OPEN: doing so —
	// 1fd64db's original behaviour — turned a cheap guess-flood (≈7 source IPs is
	// enough to hold the breaker OPEN) into a fleet-wide relay outage, stranding
	// every legitimate hard-NAT / CGNAT transfer for the whole cooldown, which is
	// a far worse and easier-to-trigger harm than the marginal protection it gave.
	// An attacker only obtains a (victim-billed) credential by actually GUESSING a
	// live code, which is already bounded by the per-IP 5/min cap, the
	// email-verified relay gate, and the owner's own monthly traffic cap; the
	// breaker withholding creds on such a rare successful guess bought little. So,
	// symmetric with /ws: invalid codes get STUN-only (they always did), valid
	// codes keep working.
	if code != "" && !validCode && s.iceBreaker != nil {
		if open, logNow := s.iceBreaker.RecordInvalid(); open && logNow {
			log.Printf("WARNING: pairing-code guess breaker OPEN — shedding invalid /ws joins; /api/ice valid codes unaffected")
		}
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

	// Per-plan traffic gate: withhold TURN once the code's owner's monthly
	// traffic allowance (relay + staged upload/download combined) is spent —
	// including at exactly zero left, which is the same boundary the pre-mint
	// gate refuses at, so a code that could not be minted cannot be relayed
	// either. P2P direct still works; only relay is withheld. Fail-open on a
	// read error.
	if validCode {
		if spent, err := s.trafficAllowanceSpent(r.Context(), owner); err != nil {
			log.Printf("relay quota read failed for owner %s: %v (fail-open, issuing relay)", owner, err)
		} else if spent {
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
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, withTCPTransport(s.cfg.TURNURLs)))
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
		// Second dedup key: the physical relay. `seen` catches a repeated id;
		// this catches one machine offered under two ids -- a static config
		// entry and a registered node at the same address, or a node that lost
		// state.json and re-registered with a fresh id while its old row is
		// still inside nodeOnlineWindow. See claimAddrs.
		//
		// Precedence across sources is positional, not freshness-based: the
		// own-nodes loop below claims an address before the fleet loop ever
		// runs, so an own-node row wins regardless of which heartbeat is newer.
		// A stale own-node row (up to nodeOnlineWindow, 90s, after the box
		// actually died) can therefore suppress a live fleet row at the same
		// address, handing the client only the dead credential -- before this
		// dedup existed, the client would have probed both and the dead one
		// would simply have failed to answer. Near-unreachable in practice --
		// one process binds a host:port, and the node agent owns its own TURN
		// secret, so the surviving row is normally the authoritative one anyway
		// -- but it is the one scenario where this dedup turns "one working
		// entry plus one dead entry" into "only the dead one". Worth knowing
		// before reordering these three loops.
		seenAddr := map[string]bool{}
		since := now.Add(-nodeOnlineWindow).Unix()

		// Node URLs go out exactly as the node registered them: relayium-node
		// is UDP-only, so widening them would advertise a candidate that can
		// never allocate. See withTCPTransport.
		//
		// The owner's own nodes (free relay), always included.
		if own, err := s.store.UserNodes(r.Context(), owner, since); err == nil {
			for _, n := range own {
				if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 {
					continue
				}
				if !claimAddrs(seenAddr, n.URLs) {
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
			// Per-node monthly traffic cap: withhold any fleet node that has
			// reached 90% of its effective cap. The 90% is a *scheduling*
			// reserve, not the hard stop — traffic is checked once at ICE time
			// but accrues for the whole session, so a node sitting at 99.9%
			// would still be handed out and then blow well past its cap. The
			// node's own 100% blackhole (counter.go overTraffic) is the hard
			// gate; this leaves it 10% to drain established sessions with.
			// Computed once per request; a read error fails open.
			monthStart, _ := monthRange(periodOf(now.Unix()))
			monthlyUsed, muErr := s.store.NodeRelayedSince(r.Context(), monthStart)
			if muErr != nil {
				log.Printf("ice: NodeRelayedSince read failed: %v (traffic caps not enforced this request)", muErr)
			}
			st := s.ResolveSettings(r.Context())
			if nodes, err := s.store.OnlineNodes(r.Context(), since); err == nil {
				for _, n := range nodes {
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					if cap := usableTraffic(resolveNodeTrafficLimit(n, st)); cap > 0 && monthlyUsed[n.ID] >= cap {
						continue // at/over the 90% scheduling reserve — withhold this node
					}
					if !claimAddrs(seenAddr, n.URLs) {
						continue
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
				if !claimAddrs(seenAddr, rc.URLs) {
					continue // a dynamic node already covers this machine
				}
				relays = append(relays, relayEntry{ID: rc.ID, Region: rc.Region, STUN: rc.STUN,
					ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, withTCPTransport(rc.URLs))}})
			}
		}
		if len(relays) > 0 {
			resp["relays"] = relays
		}
	}

	if relayDenied != "" {
		resp["relayDenied"] = relayDenied
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

// turnCredentials builds a coturn TURN-REST ephemeral credential. The shared
// static-auth-secret lets coturn validate the credential (and read the expiry
// embedded in the username) with no per-credential server state. HMAC-SHA1 is
// the construction mandated by the TURN REST mechanism, not a security choice.
//
// `urls` is passed through verbatim. Whether a relay also answers on TCP is a
// property of that relay, so the decision belongs at the call site — see
// withTCPTransport.
func turnCredentials(secret, token string, expiry int64, urls []string) ICEServer {
	username := fmt.Sprintf("%d:%s", expiry, token)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return ICEServer{URLs: urls, Username: username, Credential: cred}
}

// withTCPTransport pairs every bare `turn:` URL with its explicit
// `?transport=tcp` sibling, UDP first.
//
// A `turn:host:3478` URL means UDP only to a browser. coturn listens on TCP at
// the same port, but nothing says so, and a network that drops UDP (some
// cellular, corporate and campus networks) then gathers no relay candidate at
// all — on a path that forces iceTransportPolicy "relay", leaving nothing to
// fall back to. UDP stays first so ICE still prefers it and a working network
// selects exactly the pair it selected before; an unanswered TCP candidate
// costs one allocation attempt and is then ignored.
//
// **Only for relays we know answer on TCP.** relayium-node runs a UDP-only pion
// server (one PacketConnConfig, no ListenerConfigs), so advertising TCP for a
// fleet or BYO node would hand every client a candidate that can never allocate.
// That is why the two static, deployer-configured sources call this and the two
// node-sourced ones do not.
//
// A URL that already carries a query is left alone: RFC 7065 defines exactly one
// TURN URI parameter, so a `?` means the deployer chose a transport explicitly.
// `turns:` is left alone too — it is TLS over TCP by definition.
func withTCPTransport(urls []string) []string {
	out := make([]string, 0, len(urls)*2)
	seen := make(map[string]bool, len(urls)*2)
	add := func(u string) {
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	for _, u := range urls {
		add(u)
		if !strings.HasPrefix(u, "turn:") || strings.Contains(u, "?") {
			continue
		}
		add(u + "?transport=tcp")
	}
	return out
}
