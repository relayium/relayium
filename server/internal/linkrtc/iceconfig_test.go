package linkrtc

// The Web's own cases as vectors: web/src/lib/ice-config.test.ts
// (chooseRtcConfig, fetchIceConfig relay status), web/src/lib/ice.test.ts
// (fetchIceServers, relayDenied, hasTurnServer) and
// web/src/lib/ice-liveness.test.ts (hostile bodies, stalls). Each Go case
// names the Web case it mirrors.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// ---------------------------------------------------------------- helpers

var stunOnly = []any{map[string]any{"urls": "stun:relay.example:3478"}}

var legacyTURN = map[string]any{"urls": []any{"turn:legacy.example:3478"}, "username": "u", "credential": "c"}

func relayJSON(id string) map[string]any {
	return map[string]any{"id": id, "iceServers": []any{
		map[string]any{"urls": []any{"turn:" + id + ".example:3478"}, "username": "u-" + id, "credential": "c-" + id},
	}}
}

func mustParse(t *testing.T, body any) ICEConfig {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	cfg, ok := ParseICEConfig(b)
	if !ok {
		t.Fatalf("not a configuration: %s", b)
	}
	cfg.Status = relayStatusOf(cfg, "483920")
	return cfg
}

func turnURLs(servers []ICEServer) []string {
	var out []string
	for _, s := range servers {
		for _, u := range s.URLs {
			if isTURNURL(u) {
				out = append(out, u)
			}
		}
	}
	return out
}

func eq(a, b []string) bool {
	return strings.Join(a, "\x00") == strings.Join(b, "\x00") && len(a) == len(b)
}

// ---------------------------------------------------------------- chooseRtcConfig (ice-config.test.ts)

func TestChooseRTCConfigWebVectors(t *testing.T) {
	tok, fra := relayJSON("tok"), relayJSON("fra")
	cases := []struct {
		name     string // the Web's `it(...)`
		body     map[string]any
		selected string
		relay    bool
		turn     []string
		all      []string // full URL list when checked
	}{
		{"uses only the agreed relay, relay-only, once one has been picked",
			map[string]any{"iceServers": append(append([]any{}, stunOnly...), legacyTURN), "relays": []any{tok, fra}}, "fra",
			true, []string{"turn:fra.example:3478"}, nil},
		{"still relays when no relay was picked and the pool is the only source of TURN",
			map[string]any{"iceServers": stunOnly, "relays": []any{tok, fra}}, "",
			true, []string{"turn:tok.example:3478", "turn:fra.example:3478"}, nil},
		{"unions the legacy entry with the pool rather than choosing between them",
			map[string]any{"iceServers": append(append([]any{}, stunOnly...), legacyTURN), "relays": []any{tok}}, "",
			true, []string{"turn:legacy.example:3478", "turn:tok.example:3478"}, nil},
		{"falls back to the union when the selected id is not in the pool",
			map[string]any{"iceServers": stunOnly, "relays": []any{tok}}, "gone",
			true, []string{"turn:tok.example:3478"}, nil},
		{"keeps policy 'all' when there is no TURN anywhere (LAN)",
			map[string]any{"iceServers": stunOnly, "relays": []any{}}, "",
			false, nil, []string{"stun:relay.example:3478"}},
		{"keeps policy 'all' for an empty config (the /api/ice-failed fallback)",
			map[string]any{"iceServers": []any{}, "relays": []any{}}, "",
			false, nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ch := ChooseRTCConfig(mustParse(t, c.body), c.selected)
			if ch.RelayOnly != c.relay {
				t.Errorf("relay-only %t, want %t", ch.RelayOnly, c.relay)
			}
			if got := turnURLs(ch.ICEServers); !eq(got, c.turn) {
				t.Errorf("turn urls %q, want %q", got, c.turn)
			}
			if !c.relay {
				var all []string
				for _, s := range ch.ICEServers {
					all = append(all, s.URLs...)
				}
				if !eq(all, c.all) {
					t.Errorf("servers %q, want %q", all, c.all)
				}
			}
			wc, err := ch.WebRTC()
			if err != nil {
				t.Fatal(err)
			}
			want := webrtc.ICETransportPolicyAll
			if c.relay {
				want = webrtc.ICETransportPolicyRelay
			}
			if wc.ICETransportPolicy != want {
				t.Errorf("pion policy %v, want %v", wc.ICETransportPolicy, want)
			}
		})
	}

	t.Run("bounds how many pool relays the fallback allocates against", func(t *testing.T) {
		var relays []any
		for i := 0; i < MaxFallbackRelays+3; i++ {
			relays = append(relays, relayJSON(fmt.Sprintf("r%d", i)))
		}
		ch := ChooseRTCConfig(mustParse(t, map[string]any{"iceServers": []any{}, "relays": relays}), "")
		if n := len(turnURLs(ch.ICEServers)); n != MaxFallbackRelays {
			t.Fatalf("%d relays, want %d", n, MaxFallbackRelays)
		}
	})
	t.Run("keeps every relay of a production-sized pool", func(t *testing.T) {
		var relays []any
		for i := 0; i < 5; i++ {
			relays = append(relays, relayJSON(fmt.Sprintf("prod%d", i)))
		}
		ch := ChooseRTCConfig(mustParse(t, map[string]any{"iceServers": []any{}, "relays": relays}), "")
		if n := len(turnURLs(ch.ICEServers)); n != 5 {
			t.Fatalf("%d relays, want 5", n)
		}
	})
}

// ---------------------------------------------------------------- hasTurnServer (ice.test.ts)

func TestHasTURNServerWebVectors(t *testing.T) {
	cases := []struct {
		body any
		want bool
	}{
		{[]any{map[string]any{"urls": []any{"stun:s:3478"}}}, false},
		{[]any{}, false},
		{[]any{map[string]any{"urls": []any{"turn:t:3478"}, "username": "u", "credential": "c"}}, true},
		{[]any{map[string]any{"urls": "turns:t:5349", "username": "u", "credential": "c"}}, true},
		{[]any{map[string]any{"urls": "stun:s:3478"}, map[string]any{"urls": []any{"turn:t:3478"}}}, true},
		{[]any{map[string]any{"urls": "stun:saturn.example.com:3478"}}, false},
	}
	for i, c := range cases {
		if got := HasTURNServer(sanitizeICEServers(roundTrip(t, c.body))); got != c.want {
			t.Errorf("case %d: %t, want %t", i, got, c.want)
		}
	}
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	b, _ := json.Marshal(v)
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// ---------------------------------------------------------------- the /api/ice client

// iceStub is a scripted /api/ice. Each request takes the next reply; the last
// one repeats. It records every request so the tests can count them: the
// count IS the money assertion (one credential issuance per link, M1; no
// re-request on a denial, M3).
type iceStub struct {
	t       *testing.T
	mu      sync.Mutex
	replies []func(w http.ResponseWriter, r *http.Request)
	n       atomic.Int32
	urls    []string
}

func (s *iceStub) serve(w http.ResponseWriter, r *http.Request) {
	i := int(s.n.Add(1)) - 1
	s.mu.Lock()
	s.urls = append(s.urls, r.URL.String())
	reply := s.replies[min(i, len(s.replies)-1)]
	s.mu.Unlock()
	reply(w, r)
}

func jsonReply(status int, body any, hdr ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(hdr); i += 2 {
			w.Header().Set(hdr[i], hdr[i+1])
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

func rawReply(status int, body string, hdr ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(hdr); i += 2 {
			w.Header().Set(hdr[i], hdr[i+1])
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

type fetchRun struct {
	cfg    ICEConfig
	calls  int
	slept  []time.Duration
	stub   *iceStub
	server *httptest.Server
}

func runFetch(t *testing.T, fetcher ICEFetcher, replies ...func(http.ResponseWriter, *http.Request)) fetchRun {
	t.Helper()
	stub := &iceStub{t: t, replies: replies}
	srv := httptest.NewServer(http.HandlerFunc(stub.serve))
	t.Cleanup(srv.Close)
	var slept []time.Duration
	if fetcher.Sleep == nil {
		fetcher.Sleep = func(_ context.Context, d time.Duration) { slept = append(slept, d) }
	}
	ep, err := ICEEndpoint("ws"+strings.TrimPrefix(srv.URL, "http"), "483920")
	if err != nil {
		t.Fatal(err)
	}
	cfg := fetcher.FetchICEConfig(context.Background(), ep, "483920")
	return fetchRun{cfg: cfg, calls: int(stub.n.Load()), slept: slept, stub: stub, server: srv}
}

func TestICEEndpoint(t *testing.T) {
	cases := map[string]string{
		"wss://relayium.com":           "https://relayium.com/api/ice?code=483920",
		"ws://127.0.0.1:8080":          "http://127.0.0.1:8080/api/ice?code=483920",
		"https://self.example/sub/ws":  "https://self.example/api/ice?code=483920",
		"http://h:1/x?y=1#f":           "http://h:1/api/ice?code=483920",
		"wss://user:pw@relayium.com/a": "https://relayium.com/api/ice?code=483920",
	}
	for in, want := range cases {
		got, err := ICEEndpoint(in, "483920")
		if err != nil || got != want {
			t.Errorf("%q: %q %v, want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"ftp://x", "relayium.com", "wss://"} {
		if _, err := ICEEndpoint(bad, "483920"); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

func TestFetchICEConfigWebVectors(t *testing.T) {
	stunTurn := map[string]any{"iceServers": []any{stunOnly[0], legacyTURN}}
	cases := []struct {
		name    string
		replies []func(http.ResponseWriter, *http.Request)
		status  RelayStatus
		calls   int
		servers int // len(ICEServers)
	}{
		// ice-config.test.ts "fetchIceConfig relay status"
		{"reports ok when a code room was issued a relay",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, stunTurn)}, RelayOK, 1, 2},
		{"reports ok when the relay arrives only through the pool",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": stunOnly, "relays": []any{relayJSON("tok")}})}, RelayOK, 1, 1},
		{"passes through the server's own reason for withholding a relay (quota)",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": stunOnly, "relayDenied": "quota"})}, RelayQuota, 1, 1},
		{"passes through the server's own reason for withholding a relay (unverified)",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": stunOnly, "relayDenied": "unverified"})}, RelayUnverified, 1, 1},
		{"reports none when a code room came back with no relay and no reason",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": stunOnly})}, RelayNone, 1, 1},
		{"does not retry a rate limit, and says so",
			[]func(http.ResponseWriter, *http.Request){rawReply(429, "")}, RelayRateLimited, 1, 0},
		{"retries a 5xx",
			[]func(http.ResponseWriter, *http.Request){rawReply(503, ""), jsonReply(200, stunTurn)}, RelayOK, 2, 2},
		{"keeps a denial's specific reason and does not retry it (quota)",
			[]func(http.ResponseWriter, *http.Request){jsonReply(403, map[string]any{"relayDenied": "quota"})}, RelayQuota, 1, 0},
		{"keeps a denial's specific reason and does not retry it (unverified)",
			[]func(http.ResponseWriter, *http.Request){jsonReply(403, map[string]any{"relayDenied": "unverified"})}, RelayUnverified, 1, 0},
		{"does not retry a 4xx it cannot explain",
			[]func(http.ResponseWriter, *http.Request){rawReply(400, "")}, RelayUnavailable, 1, 0},
		{"does not retry a 200 whose body is not JSON",
			[]func(http.ResponseWriter, *http.Request){rawReply(200, "<!doctype html><html>")}, RelayUnavailable, 1, 0},
		{"does not retry at all when Retry-After is long",
			[]func(http.ResponseWriter, *http.Request){rawReply(503, "", "Retry-After", "3600")}, RelayUnavailable, 1, 0},
		// ice.test.ts "fallback to an empty list on a non-ok response" (a 500 is retried once, then empty)
		{"falls back to an empty list (never a third-party STUN) on a non-ok response",
			[]func(http.ResponseWriter, *http.Request){rawReply(500, "")}, RelayUnavailable, 2, 0},
		// ice-liveness "keeps a server's own denial reason over an empty sanitised pool"
		{"keeps a server's own denial reason over an empty sanitised pool",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": []any{map[string]any{"urls": 42}}, "relays": []any{}, "relayDenied": "quota"})}, RelayQuota, 1, 0},
		{"does not invent a denial from a non-string relayDenied",
			[]func(http.ResponseWriter, *http.Request){jsonReply(200, map[string]any{"iceServers": []any{map[string]any{"urls": "stun:s:3478"}}, "relayDenied": map[string]any{"reason": "quota"}})}, RelayNone, 1, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := runFetch(t, ICEFetcher{}, c.replies...)
			if r.cfg.Status != c.status || r.calls != c.calls || len(r.cfg.ICEServers) != c.servers {
				t.Fatalf("status %q calls %d servers %d; want %q %d %d", r.cfg.Status, r.calls, len(r.cfg.ICEServers), c.status, c.calls, c.servers)
			}
			if c.status != RelayOK && c.status != RelayNone && c.status != RelayQuota && c.status != RelayUnverified && len(r.cfg.ICEServers) != 0 {
				t.Fatalf("a failure must return the empty list, got %+v", r.cfg.ICEServers)
			}
			for _, u := range r.stub.urls {
				if u != "/api/ice?code=483920" {
					t.Errorf("requested %q", u)
				}
			}
		})
	}

	t.Run("retries a network error", func(t *testing.T) {
		var n atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if n.Add(1) == 1 {
				hj, _ := w.(http.Hijacker)
				c, _, _ := hj.Hijack()
				_ = c.Close() // a reset connection: a network error
				return
			}
			jsonReply(200, stunTurn)(w, r)
		}))
		defer srv.Close()
		ep, _ := ICEEndpoint(srv.URL, "483920")
		cfg := ICEFetcher{Sleep: func(context.Context, time.Duration) {}}.FetchICEConfig(context.Background(), ep, "483920")
		if cfg.Status != RelayOK || n.Load() != 2 {
			t.Fatalf("status %q after %d requests", cfg.Status, n.Load())
		}
	})

	t.Run("waits exactly as long as a short Retry-After asks", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(503, "", "Retry-After", "3"), jsonReply(200, stunTurn))
		if r.cfg.Status != RelayOK || r.calls != 2 || len(r.slept) != 1 || r.slept[0] != 3*time.Second {
			t.Fatalf("status %q calls %d slept %v", r.cfg.Status, r.calls, r.slept)
		}
	})
	t.Run("uses the 1.2 s backoff without Retry-After", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(502, ""), jsonReply(200, stunTurn))
		if r.calls != 2 || len(r.slept) != 1 || r.slept[0] != ICERetryDelay {
			t.Fatalf("calls %d slept %v", r.calls, r.slept)
		}
	})
	t.Run("never more than two requests", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(503, ""))
		if r.cfg.Status != RelayUnavailable || r.calls != 2 {
			t.Fatalf("status %q calls %d", r.cfg.Status, r.calls)
		}
	})
}

// ice-liveness.test.ts: every hostile 200 body classifies instead of failing.
func TestFetchICEConfigHostileBodies(t *testing.T) {
	malformed := []struct {
		name string
		body string
	}{
		{"relays is an object, not a list", `{"iceServers":[],"relays":{}}`},
		{"a null server entry", `{"iceServers":[null]}`},
		{"a numeric urls", `{"iceServers":[{"urls":42}]}`},
		{"a pool entry with no iceServers", `{"iceServers":[],"relays":[{"id":"tok"}]}`},
		{"a pool entry that is not an object", `{"relays":["tok"]}`},
		{"a pool entry with no id", `{"relays":[{"iceServers":[{"urls":"turn:t:3478"}]}]}`},
		{"urls is an object", `{"iceServers":[{"urls":{"turn":"turn:t:3478"}}]}`},
		{"a list of non-strings in urls", `{"iceServers":[{"urls":[42,null]}]}`},
		{"iceServers is a string", `{"iceServers":"turn:t:3478"}`},
		{"the body is null", `null`},
		{"the body is a bare array", `[{"urls":"turn:t:3478"}]`},
		{"the body is a number", `7`},
		{"trailing garbage", `{"iceServers":[]} x`},
		{"invalid JSON", `{"iceServers":[`},
	}
	for _, m := range malformed {
		t.Run(m.name, func(t *testing.T) {
			r := runFetch(t, ICEFetcher{}, rawReply(200, m.body))
			switch r.cfg.Status {
			case RelayNone, RelayUnavailable, RelayOK:
			default:
				t.Fatalf("status %q", r.cfg.Status)
			}
			if r.calls != 1 {
				t.Fatalf("a 200 answer was re-requested (%d calls)", r.calls)
			}
			if HasTURNServer(ChooseRTCConfig(r.cfg, "").ICEServers) {
				t.Fatalf("a malformed body produced a relay: %+v", r.cfg)
			}
		})
	}

	t.Run("keeps the valid siblings of a malformed entry", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(200, `{"iceServers":[null,{"urls":42},{"urls":["turn:good.example:3478"],"username":"u","credential":"c"}]}`))
		if r.cfg.Status != RelayOK || len(r.cfg.ICEServers) != 1 || r.cfg.ICEServers[0].URLs[0] != "turn:good.example:3478" ||
			r.cfg.ICEServers[0].Username != "u" || r.cfg.ICEServers[0].Credential != "c" {
			t.Fatalf("%+v", r.cfg)
		}
	})
	t.Run("keeps the valid relays of a pool with one malformed member", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(200, `{"relays":[{"id":7},null,{"id":"fra","iceServers":[{"urls":["turn:fra.example:3478"],"username":"u","credential":"c"}]}]}`))
		if r.cfg.Status != RelayOK || len(r.cfg.Relays) != 1 || r.cfg.Relays[0].ID != "fra" {
			t.Fatalf("%+v", r.cfg)
		}
	})
	t.Run("drops only the unusable URLs of an otherwise usable entry", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(200, `{"iceServers":[{"urls":["turn:t:3478",42,null,""],"username":"u","credential":"c"}]}`))
		if r.cfg.Status != RelayOK || len(r.cfg.ICEServers) != 1 || !eq(r.cfg.ICEServers[0].URLs, []string{"turn:t:3478"}) {
			t.Fatalf("%+v", r.cfg)
		}
	})
	t.Run("a non-string credential is refused only when building the connection", func(t *testing.T) {
		r := runFetch(t, ICEFetcher{}, rawReply(200, `{"iceServers":[{"urls":["turn:t:3478"],"username":12345,"credential":"c"}]}`))
		if r.cfg.Status != RelayOK {
			t.Fatalf("status %q", r.cfg.Status)
		}
		if _, err := ChooseRTCConfig(r.cfg, "").WebRTC(); err == nil {
			t.Fatal("want ErrUnusableICEServer")
		}
		if _, ok := EarliestTURNExpiry(r.cfg.ICEServers); ok {
			t.Fatal("a non-string username stated an expiry")
		}
	})
	t.Run("an oversized body is unreadable, not retried", func(t *testing.T) {
		big := `{"iceServers":[{"urls":"stun:s:1","pad":"` + strings.Repeat("a", ICEMaxBody) + `"}]}`
		r := runFetch(t, ICEFetcher{}, rawReply(200, big))
		if r.cfg.Status != RelayUnavailable || r.calls != 1 {
			t.Fatalf("status %q calls %d", r.cfg.Status, r.calls)
		}
	})
}

// ice-liveness: a stalled status line or body is bounded, and the stall is
// the one transient shape the single retry is for.
func TestFetchICEConfigStallsAreBounded(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch n.Add(1) {
		case 1: // headers never arrive
			select {
			case <-release:
			case <-r.Context().Done():
			}
		default: // headers arrive, body never completes
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"iceServers":[`))
			w.(http.Flusher).Flush()
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
	}))
	defer srv.Close()
	ep, _ := ICEEndpoint(srv.URL, "483920")
	start := time.Now()
	cfg := ICEFetcher{AttemptTimeout: 150 * time.Millisecond, Sleep: func(context.Context, time.Duration) {}}.
		FetchICEConfig(context.Background(), ep, "483920")
	if cfg.Status != RelayUnavailable || n.Load() != 2 {
		t.Fatalf("status %q after %d requests", cfg.Status, n.Load())
	}
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("took %v", el)
	}
}

// The pairing code goes only to the configured server: no redirect is
// followed (a redirect answer is "unavailable", and not retried).
func TestFetchICEConfigFollowsNoRedirect(t *testing.T) {
	var other atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		other.Add(1)
		jsonReply(200, map[string]any{"iceServers": []any{legacyTURN}})(w, r)
	}))
	defer elsewhere.Close()
	r := runFetch(t, ICEFetcher{}, func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, elsewhere.URL+"/api/ice?"+req.URL.RawQuery, http.StatusFound)
	})
	if other.Load() != 0 || r.cfg.Status != RelayUnavailable || r.calls != 1 {
		t.Fatalf("redirect followed=%d status %q calls %d", other.Load(), r.cfg.Status, r.calls)
	}
}

func TestRetryAfterParse(t *testing.T) {
	cases := []struct {
		in   string
		d    time.Duration
		have bool
	}{
		{"", 0, false}, {"3", 3 * time.Second, true}, {" 3 ", 3 * time.Second, true}, {"1.5", 1500 * time.Millisecond, true},
		{" ", 0, true}, {"-1", 0, false}, {"NaN", 0, false}, {"Infinity", 0, false},
		{"Wed, 21 Oct 2015 07:28:00 GMT", 0, false},
	}
	for _, c := range cases {
		d, ok := retryAfter(c.in)
		if d != c.d || ok != c.have {
			t.Errorf("%q: %v %t, want %v %t", c.in, d, ok, c.d, c.have)
		}
	}
}
