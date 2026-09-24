package linkrtc

// The `/api/ice` client, its sanitizer and the relay policy, ported from
// web/src/lib/ice.ts (A09b). The Web is the authority: every rule here names
// the Web function it mirrors, and iceconfig_test.go runs the Web's own test
// cases (ice-config.test.ts, ice.test.ts) as vectors.
//
// # Money (A09b M1, M3)
//
// `/api/ice?code=` issues TURN credentials whose bytes are billed to the
// pairing code's OWNER (server/account/turn.go handleICE). The server is
// unchanged; this is one more consumer, held to the Web's discipline:
//
//   - one request per link, plus at most ONE retry and only for a transient
//     failure (network error, timeout, 5xx with no or a short Retry-After);
//   - a deliberate denial (`relayDenied`: quota / unverified), a 429, any other
//     4xx and an unreadable body are ANSWERS and are never retried;
//   - nothing here ever re-requests on its own later: FetchICEConfig is called
//     once by the caller, and it returns a classification instead of an error.
//
// # Policy (A09-DESIGN §4.1, first stage)
//
// ChooseRTCConfig is `chooseRtcConfig`: relay-only whenever the merged list
// carries a TURN server, otherwise "all". The CLI uses exactly the Web's rule
// for every pair in A09b (CLI↔CLI included), so a relayed CLI transfer is
// metered to the code owner by construction, like a browser's. `ice-direct/1`
// (A09c) is the only thing that will ever relax it.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

// ICEServer is one sanitized `iceServers` entry. URLs holds only the non-empty
// strings the server sent (sanitizeIceServers). Username and Credential are
// kept as the server sent them; a present value that is not a string is kept
// as "bad" rather than repaired, and only building a PeerConnection refuses it
// (the browser's constructor is where the Web meets it too).
type ICEServer struct {
	URLs       []string
	Username   string
	Credential string

	hasUsername, badUsername     bool
	hasCredential, badCredential bool
}

// UsernameString is the username when the server sent a string.
func (s ICEServer) UsernameString() (string, bool) {
	return s.Username, s.hasUsername && !s.badUsername
}

// RelayEntry is one member of the multi-relay pool (`relays[]`).
type RelayEntry struct {
	ID         string
	Region     string
	ICEServers []ICEServer
}

// RelayStatus is `RelayAvailability`: why (or whether) a relay is available.
type RelayStatus string

const (
	RelayOK          RelayStatus = "ok"
	RelayQuota       RelayStatus = "quota"       // the code owner's monthly relay allowance is spent
	RelayUnverified  RelayStatus = "unverified"  // the code owner's email is unverified
	RelayRateLimited RelayStatus = "ratelimited" // 429: never retried
	RelayUnavailable RelayStatus = "unavailable" // /api/ice could not be read at all
	RelayNone        RelayStatus = "none"        // read fine, named a code, carried no TURN
)

// ICEConfig is `IceConfig`.
type ICEConfig struct {
	ICEServers  []ICEServer
	Relays      []RelayEntry
	RelayDenied string
	Status      RelayStatus
}

// MaxFallbackRelays is `MAX_FALLBACK_RELAYS`: how many pool relays the
// no-selection fallback folds in. Each costs one TURN allocation during ICE.
const MaxFallbackRelays = 8

// Timing of FetchICEConfig (ice.ts ICE_ATTEMPT_TIMEOUT_MS, ICE_RETRY_DELAY_MS,
// ICE_MAX_RETRY_AFTER_MS).
const (
	ICEAttemptTimeout = 8 * time.Second
	ICERetryDelay     = 1200 * time.Millisecond
	ICEMaxRetryAfter  = 5 * time.Second
	// ICEMaxBody bounds what one response may make this process buffer. The
	// Web has no such bound (the browser owns it); a CLI must have one. A body
	// over it is unreadable ("unavailable"), exactly like a non-JSON body.
	ICEMaxBody = 1 << 20
)

// isTURNURL is the Web's `u.startsWith("turn:") || u.startsWith("turns:")`.
func isTURNURL(u string) bool { return strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") }

// HasTURNServer is `hasTurnServer`: whether the list carries a turn:/turns:
// URL. Only then is relay-only safe.
func HasTURNServer(servers []ICEServer) bool {
	for _, s := range servers {
		for _, u := range s.URLs {
			if isTURNURL(u) {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------- sanitizer

// sanitizeICEServers is `sanitizeIceServers`: entries that address at least
// one thing. A `urls` string must be non-empty; an array keeps its non-empty
// string members; anything else addresses nothing and is dropped. Valid
// siblings survive a malformed neighbour.
func sanitizeICEServers(v any) []ICEServer {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []ICEServer
	for _, raw := range arr {
		obj, ok := raw.(map[string]any)
		if !ok {
			continue // null, number, string, array: not an entry
		}
		var urls []string
		switch u := obj["urls"].(type) {
		case string:
			if u == "" {
				continue
			}
			urls = []string{u}
		case []any:
			for _, x := range u {
				if s, ok := x.(string); ok && s != "" {
					urls = append(urls, s)
				}
			}
			if len(urls) == 0 {
				continue
			}
		default:
			continue // addresses nothing
		}
		s := ICEServer{URLs: urls}
		if v, ok := obj["username"]; ok {
			s.hasUsername = true
			if str, ok := v.(string); ok {
				s.Username = str
			} else {
				s.badUsername = true
			}
		}
		if v, ok := obj["credential"]; ok {
			s.hasCredential = true
			if str, ok := v.(string); ok {
				s.Credential = str
			} else {
				s.badCredential = true
			}
		}
		out = append(out, s)
	}
	return out
}

// sanitizeRelays is `sanitizeRelays`: pool entries with a non-empty string
// id. An entry whose iceServers did not survive is KEPT with an empty list
// (it contributes nothing to ChooseRTCConfig and no relay to HasTURNServer).
func sanitizeRelays(v any) []RelayEntry {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []RelayEntry
	for _, raw := range arr {
		obj, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, ok := obj["id"].(string)
		if !ok || id == "" {
			continue
		}
		region, _ := obj["region"].(string)
		out = append(out, RelayEntry{ID: id, Region: region, ICEServers: sanitizeICEServers(obj["iceServers"])})
	}
	return out
}

// ParseICEConfig is `toIceConfig` over raw bytes: a body that is not a JSON
// object is not a configuration (ok=false). Status is left for the caller
// (relayStatusOf needs the code).
func ParseICEConfig(body []byte) (ICEConfig, bool) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&v); err != nil {
		return ICEConfig{}, false
	}
	if dec.More() {
		return ICEConfig{}, false // trailing bytes: not what res.json() accepts
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return ICEConfig{}, false
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return ICEConfig{}, false
	}
	cfg := ICEConfig{
		ICEServers: sanitizeICEServers(obj["iceServers"]),
		Relays:     sanitizeRelays(obj["relays"]),
		Status:     RelayOK,
	}
	if d, ok := obj["relayDenied"].(string); ok {
		cfg.RelayDenied = d
	}
	return cfg, true
}

// relayStatusOf is the Web's function of the same name. The server's own
// reason wins; otherwise a code-scoped answer with no TURN anywhere is "none".
func relayStatusOf(cfg ICEConfig, code string) RelayStatus {
	if cfg.RelayDenied == string(RelayQuota) || cfg.RelayDenied == string(RelayUnverified) {
		return RelayStatus(cfg.RelayDenied)
	}
	if code == "" {
		return RelayOK
	}
	for _, r := range cfg.Relays {
		if HasTURNServer(r.ICEServers) {
			return RelayOK
		}
	}
	if HasTURNServer(cfg.ICEServers) {
		return RelayOK
	}
	return RelayNone
}

// ---------------------------------------------------------------- policy

// RTCChoice is `chooseRtcConfig`'s result.
type RTCChoice struct {
	ICEServers []ICEServer
	// RelayOnly is iceTransportPolicy "relay"; false is "all".
	RelayOnly bool
}

// ChooseRTCConfig is `chooseRtcConfig`. With a selected relay id present in
// the pool: that relay only, relay-only. Otherwise the legacy top-level list
// plus the first MaxFallbackRelays pool entries, relay-only iff that union
// carries a TURN server. A09b never selects (relay-RTT agreement is A09d), so
// the CLI passes "".
func ChooseRTCConfig(cfg ICEConfig, selectedRelayID string) RTCChoice {
	if selectedRelayID != "" {
		for _, r := range cfg.Relays {
			if r.ID == selectedRelayID {
				return RTCChoice{ICEServers: append([]ICEServer(nil), r.ICEServers...), RelayOnly: true}
			}
		}
	}
	merged := append([]ICEServer(nil), cfg.ICEServers...)
	for i, r := range cfg.Relays {
		if i >= MaxFallbackRelays {
			break
		}
		merged = append(merged, r.ICEServers...)
	}
	return RTCChoice{ICEServers: merged, RelayOnly: HasTURNServer(merged)}
}

// ErrUnusableICEServer: an entry carries a username or credential that is not
// a string. The browser's RTCPeerConnection constructor is where the Web meets
// the same entry; building the Pion configuration is where the CLI does.
var ErrUnusableICEServer = errors.New("linkrtc: ICE server entry has a non-string username or credential")

// WebRTC builds the Pion configuration for this choice.
func (c RTCChoice) WebRTC() (webrtc.Configuration, error) {
	cfg := webrtc.Configuration{ICETransportPolicy: webrtc.ICETransportPolicyAll}
	if c.RelayOnly {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	for _, s := range c.ICEServers {
		if s.badUsername || s.badCredential {
			return webrtc.Configuration{}, ErrUnusableICEServer
		}
		srv := webrtc.ICEServer{URLs: append([]string(nil), s.URLs...), Username: s.Username}
		if s.hasCredential {
			srv.Credential = s.Credential
		}
		cfg.ICEServers = append(cfg.ICEServers, srv)
	}
	return cfg, nil
}

// ---------------------------------------------------------------- fetch

// ICEEndpoint turns the CLI's --server URL (ws/wss/http/https, the same value
// rzvous dials) into the /api/ice URL for code. Like rzvous, the path is
// replaced, not appended.
func ICEEndpoint(server, code string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return "", fmt.Errorf("linkrtc: server URL scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("linkrtc: server URL has no host")
	}
	u.Path, u.RawPath, u.Fragment, u.User = "/api/ice", "", "", nil
	u.RawQuery = ""
	if code != "" {
		u.RawQuery = "code=" + url.QueryEscape(code)
	}
	return u.String(), nil
}

// ICEFetcher performs FetchICEConfig. The zero value is production.
type ICEFetcher struct {
	// Client performs the request. nil: a client that follows NO redirect, so
	// the pairing code is only ever sent to the configured server.
	Client *http.Client
	// Test hooks; zero means the ice.ts values.
	AttemptTimeout time.Duration
	RetryDelay     time.Duration
	MaxRetryAfter  time.Duration
	// Sleep waits between the two attempts; nil sleeps on a timer (ctx-bound).
	Sleep func(ctx context.Context, d time.Duration)
}

var noRedirectClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type iceRead struct {
	ok         bool
	cfg        ICEConfig
	status     RelayStatus
	retryable  bool
	retryAfter time.Duration
	hasRetry   bool
}

// FetchICEConfig is `fetchIceConfig` for a pairing code: at most two requests
// (one retry, transient failures only), each bounded end to end — status line
// AND body — by AttemptTimeout. It cannot fail: every failure is classified
// into Status and returned with an EMPTY server list (never a third-party
// STUN, ice.ts FALLBACK).
func (f ICEFetcher) FetchICEConfig(ctx context.Context, endpoint, code string) ICEConfig {
	read := f.readOnce(ctx, endpoint)
	wait := f.retryDelay()
	if !read.ok && read.hasRetry {
		wait = read.retryAfter
	}
	if !read.ok && read.retryable && wait <= f.maxRetryAfter() && ctx.Err() == nil {
		f.sleep(ctx, wait)
		if ctx.Err() == nil {
			read = f.readOnce(ctx, endpoint)
		}
	}
	if !read.ok {
		return ICEConfig{Status: read.status}
	}
	cfg := read.cfg
	cfg.Status = relayStatusOf(cfg, code)
	return cfg
}

func (f ICEFetcher) attemptTimeout() time.Duration {
	if f.AttemptTimeout > 0 {
		return f.AttemptTimeout
	}
	return ICEAttemptTimeout
}

func (f ICEFetcher) retryDelay() time.Duration {
	if f.RetryDelay > 0 {
		return f.RetryDelay
	}
	return ICERetryDelay
}

func (f ICEFetcher) maxRetryAfter() time.Duration {
	if f.MaxRetryAfter > 0 {
		return f.MaxRetryAfter
	}
	return ICEMaxRetryAfter
}

func (f ICEFetcher) sleep(ctx context.Context, d time.Duration) {
	if f.Sleep != nil {
		f.Sleep(ctx, d)
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// readOnce is `readIceConfig` + `attemptIceConfig`: one bounded attempt.
func (f ICEFetcher) readOnce(ctx context.Context, endpoint string) iceRead {
	actx, cancel := context.WithTimeout(ctx, f.attemptTimeout())
	defer cancel()
	client := f.Client
	if client == nil {
		client = noRedirectClient
	}
	req, err := http.NewRequestWithContext(actx, http.MethodGet, endpoint, nil)
	if err != nil {
		return iceRead{status: RelayUnavailable} // not a request at all: repeating cannot help
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		// Network error or the attempt deadline: the transient shape the one
		// retry exists for (a stall included, ice.ts ATTEMPT_EXPIRED).
		return iceRead{status: RelayUnavailable, retryable: true}
	}
	defer res.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(res.Body, ICEMaxBody+1))
	if res.StatusCode == http.StatusTooManyRequests {
		return iceRead{status: RelayRateLimited} // never retried: it spends the next token
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if readErr == nil && len(body) <= ICEMaxBody {
			if d := deniedReason(body); d != "" {
				return iceRead{status: d} // an answer, not a failure: never retried
			}
		}
		r := iceRead{status: RelayUnavailable, retryable: res.StatusCode >= 500}
		r.retryAfter, r.hasRetry = retryAfter(res.Header.Get("Retry-After"))
		return r
	}
	if readErr != nil {
		if actx.Err() != nil && ctx.Err() == nil {
			// The attempt deadline fired inside the body: a stall, retryable.
			return iceRead{status: RelayUnavailable, retryable: true}
		}
		return iceRead{status: RelayUnavailable}
	}
	if len(body) > ICEMaxBody {
		return iceRead{status: RelayUnavailable}
	}
	cfg, ok := ParseICEConfig(body)
	if !ok {
		return iceRead{status: RelayUnavailable} // 200 that is not a configuration: not retried
	}
	return iceRead{ok: true, cfg: cfg}
}

// deniedReason is the Web's: `relayDenied` "quota" / "unverified" from a
// non-2xx JSON body.
func deniedReason(body []byte) RelayStatus {
	var b struct {
		RelayDenied any `json:"relayDenied"`
	}
	if json.Unmarshal(body, &b) != nil {
		return ""
	}
	switch b.RelayDenied {
	case string(RelayQuota):
		return RelayQuota
	case string(RelayUnverified):
		return RelayUnverified
	}
	return ""
}

// retryAfter is `retryAfterMs`: a delta-seconds value (JavaScript Number over
// the trimmed header: "" after trimming is 0, a non-finite or negative value
// is ignored). HTTP-date values are ignored, as on the Web.
func retryAfter(raw string) (time.Duration, bool) {
	if raw == "" {
		return 0, false
	}
	t := strings.TrimSpace(raw)
	if t == "" {
		return 0, true
	}
	secs, err := strconv.ParseFloat(t, 64)
	if err != nil || math.IsNaN(secs) || math.IsInf(secs, 0) || secs < 0 {
		return 0, false
	}
	if secs > float64(math.MaxInt64/int64(time.Second)) {
		return time.Duration(math.MaxInt64), true
	}
	return time.Duration(secs * float64(time.Second)), true
}
