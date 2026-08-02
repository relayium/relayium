package rzvous

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
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
		handle(r.Context(), c, "testroom", 0, "127.0.0.1")
		c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
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
