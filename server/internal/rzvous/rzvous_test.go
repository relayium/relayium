package rzvous

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/signal"
)

// startHub spins up the real signaling server on an httptest server and returns
// its ws:// base URL. Both test peers share a fixed room so they pair.
func startHub(t *testing.T) string {
	t.Helper()
	hub := signal.NewHub()
	var seq int32
	// ServeWS runs each connection on its own HTTP handler goroutine, so newID
	// must be safe for concurrent calls.
	newID := func() string { n := atomic.AddInt32(&seq, 1); return "peer" + string(rune('A'+n)) }
	handle := signal.ServeWS(hub, newID)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		// lan=false: this fixture stands in for a pairing-code room, which is
		// where the CLI rendezvous actually runs.
		handle(r.Context(), c, "testroom", 0, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// Welcome and roster are separate frames. A client must not use an empty
// selfID to interpret an early roster, or it can select its own entry and loop
// every subsequent signal back to itself.
func TestJoinWaitsForWelcomeBeforeSelectingTheRosterPeer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		if _, _, err := c.Read(r.Context()); err != nil {
			return
		}
		for _, env := range []signal.Envelope{
			{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "self"}, {ID: "peer"}}},
			{Type: signal.TypeWelcome, Name: "self"},
		} {
			data, err := signal.EncodeEnvelope(env)
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), websocket.MessageText, data); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := Join(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), "", "client")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	if s.SelfID() != "self" || s.PeerID() != "peer" {
		t.Fatalf("joined as self=%q peer=%q, want self/peer", s.SelfID(), s.PeerID())
	}
}

// A code that can't be a pairing code must fail before the dial, and say why.
// The user-visible bug this pins: `relayium send f.zip K7M4XR` (a made-up code,
// and since the format change an impossible one — codes are digits) spent a
// round trip to come back with "expected handshake response status code 101 but
// got 403", which names neither the code nor anything the user can act on.
func TestJoinRejectsMalformedCodeWithoutDialing(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	defer srv.Close()
	base := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Join(ctx, base, "K7M4XR", "sender")
	if err == nil {
		t.Fatal("Join with a malformed code succeeded")
	}
	if n := atomic.LoadInt32(&hits); n != 0 {
		t.Errorf("malformed code still dialed the server %d time(s)", n)
	}
	// Derived from the constant, not typed out: this assertion existed to keep
	// the CLI copy honest, and a hard-coded number makes it go stale the first
	// time the TTL moves — which is exactly what happened at 5 -> 30 minutes.
	lifetime := fmt.Sprintf("%d minutes", signal.CodeTTLSeconds/60)
	for _, want := range []string{"K7M4XR", "6 digits (0-9)", lifetime, "issued by the server"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	// serverURL is whatever --server points at. Naming the first-party host
	// tells a self-hoster their own instance's codes come from a service they
	// deliberately are not using.
	if strings.Contains(err.Error(), "relayium.com") {
		t.Errorf("error %q hard-codes the first-party issuer", err)
	}
}

// A well-formed but unknown/expired code is refused by the server with 403 and
// an explanatory body; the CLI must surface that body rather than the raw
// handshake failure.
func TestJoinSurfacesServerRefusalBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
	}))
	defer srv.Close()
	base := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Join(ctx, base, "726122", "sender")
	if err == nil {
		t.Fatal("Join against a 403 server succeeded")
	}
	if !strings.Contains(err.Error(), "invalid or expired pairing code") {
		t.Errorf("error %q drops the server's explanation", err)
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("%d minutes", signal.CodeTTLSeconds/60)) {
		t.Errorf("error %q does not mention the code lifetime", err)
	}
}

func TestJoinPairsTwoPeersAndRelaysSignals(t *testing.T) {
	base := startHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// LAN room (no code): both peers share the httptest loopback IP → same room.
	aCh := make(chan *Session, 1)
	go func() {
		a, err := Join(ctx, base, "", "alice")
		if err != nil {
			t.Errorf("join a: %v", err)
			return
		}
		aCh <- a
	}()
	b, err := Join(ctx, base, "", "bob")
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh
	if a.PeerID() != b.SelfID() || b.PeerID() != a.SelfID() {
		t.Fatalf("peer ids not mutual: a self=%s peer=%s, b self=%s peer=%s",
			a.SelfID(), a.PeerID(), b.SelfID(), b.PeerID())
	}

	if err := a.SendSignal(ctx, json.RawMessage(`{"hi":1}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	got, err := b.RecvSignal(ctx)
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if strings.TrimSpace(string(got)) != `{"hi":1}` {
		t.Fatalf("relayed data = %s", got)
	}
}

// Join keeps what the peer said before the roster named it and replays it
// through RecvSignal: in arrival order, only from the selected peer, and
// before anything read off the wire afterwards (CI run 35877948854: a CLI
// facing an app waited out its deadline for a commit it had already dropped).
func TestJoinReplaysSignalsThatBeatTheRoster(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	joinFrame := make(chan []byte, 1)
	base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, join []byte) {
		joinFrame <- join
		for _, e := range []signal.Envelope{
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":1}`)},
			{Type: signal.TypeWelcome, Name: "self"},
			{Type: signal.TypeSignal, From: "gone", Data: json.RawMessage(`{"i":"x"}`)},
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":2}`)},
			{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "peer"}, {ID: "self"}}},
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":3}`)},
		} {
			if writeEnv(ctx, c, e) != nil {
				return
			}
		}
		_, _, _ = c.Read(ctx)
	})
	s, err := Join(ctx, base, "", "c")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	defer s.Close()
	if s.SelfID() != "self" || s.PeerID() != "peer" {
		t.Fatalf("self %q peer %q", s.SelfID(), s.PeerID())
	}
	// The wire is unchanged: Join still sends no hint.
	want, _ := signal.EncodeEnvelope(signal.Envelope{Type: signal.TypeJoin, Name: "c"})
	if got := <-joinFrame; !bytes.Equal(got, want) {
		t.Fatalf("join frame = %s, want %s", got, want)
	}
	for _, w := range []string{`{"i":1}`, `{"i":2}`, `{"i":3}`} {
		got, err := s.RecvSignal(ctx)
		if err != nil {
			t.Fatalf("RecvSignal (want %s): %v", w, err)
		}
		if string(got) != w {
			t.Fatalf("RecvSignal = %s, want %s", got, w)
		}
	}
}

// Join holds the early signals under JoinRoom's bounds and fails closed past
// them rather than silently dropping a frame.
func TestJoinCaptureOverflowFailsClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
		_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypeWelcome, Name: "self"})
		for i := 0; i <= MaxCapturedFrames; i++ {
			if err := writeEnv(ctx, c, signal.Envelope{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{}`)}); err != nil {
				closed <- err
				return
			}
		}
		_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "self"}, {ID: "peer"}}})
		_, _, err := c.Read(ctx)
		closed <- err
	})
	s, err := Join(ctx, base, "", "c")
	if !errors.Is(err, ErrCaptureOverflow) || s != nil {
		if s != nil {
			s.Close()
		}
		t.Fatalf("Join = %v, %v; want ErrCaptureOverflow", s, err)
	}
	if cerr := <-closed; websocket.CloseStatus(cerr) != websocket.StatusPolicyViolation {
		t.Fatalf("server saw %v, want a policy-violation close", cerr)
	}
}

// CLI to CLI on the real hub, with the race forced: one side's commit reaches
// the other before the other's roster does. Both sides are the production
// Join + DoHandshake; before Join kept early signals, the held side waited for
// a commit it had discarded and the pairing hung.
func TestJoinHandshakeSurvivesACommitThatBeatsTheRoster(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hub := startHub(t)
	held := startRosterHoldingProxy(t, hub)
	idA, _ := secure.NewIdentity()
	idB, _ := secure.NewIdentity()
	type res struct {
		h   *Handshake
		err error
	}
	aCh := make(chan res, 1)
	go func() {
		s, err := Join(ctx, hub, "", "a")
		if err != nil {
			aCh <- res{err: err}
			return
		}
		defer s.Close()
		h, err := DoHandshake(ctx, s, idA, []string{"1.1.1.1:1"}, ModeText)
		aCh <- res{h, err}
	}()
	s, err := Join(ctx, held, "", "b")
	if err != nil {
		t.Fatalf("held join: %v", err)
	}
	defer s.Close()
	hb, err := DoHandshake(ctx, s, idB, []string{"2.2.2.2:2"}, ModeText)
	if err != nil {
		t.Fatalf("held side: %v", err)
	}
	ra := <-aCh
	if ra.err != nil {
		t.Fatalf("direct side: %v", ra.err)
	}
	if ra.h.SAS != hb.SAS || ra.h.IsServer == hb.IsServer {
		t.Fatalf("SAS %s/%s, roles %v/%v", ra.h.SAS, hb.SAS, ra.h.IsServer, hb.IsServer)
	}
	if hb.PeerFingerprint != idA.Fingerprint || ra.h.PeerFingerprint != idB.Fingerprint {
		t.Fatal("pinned fingerprints wrong")
	}
}
