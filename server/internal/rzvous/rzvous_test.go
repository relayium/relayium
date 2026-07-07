package rzvous

import (
	"context"
	"encoding/json"
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
