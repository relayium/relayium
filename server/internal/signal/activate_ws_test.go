package signal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// wsFixture starts a one-room signaling server and returns a dialer for it.
// Kept local to this file: the presence tests need to choose the room's LAN-ness
// per server, which the existing budget test has no reason to parameterise.
func wsFixture(t *testing.T, room string, maxPeers int, lan bool) (dial func() *websocket.Conn, ctx context.Context) {
	t.Helper()
	hub := NewHub()
	var seq int32
	newID := func() string { n := atomic.AddInt32(&seq, 1); return "p" + strconv.Itoa(int(n)) }
	handle := ServeWS(hub, newID)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, room, maxPeers, "127.0.0.1", lan)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return func() *websocket.Conn {
		t.Helper()
		c, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		t.Cleanup(func() { c.CloseNow() })
		return c
	}, ctx
}

func writeFrame(t *testing.T, ctx context.Context, c *websocket.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// readRoster reads until a roster naming at least `want` peers arrives (or the
// read fails), returning the last roster seen. Observable-condition waiting, not
// a sleep: the hub debounces broadcasts.
func readRoster(t *testing.T, ctx context.Context, c *websocket.Conn, want int) []Peer {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last []Peer
	for time.Now().Before(deadline) {
		rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, data, err := c.Read(rctx)
		cancel()
		if err != nil {
			return last
		}
		e, err := DecodeEnvelope(data)
		if err != nil || e.Type != TypePeers {
			continue
		}
		last = e.Peers
		if len(last) >= want {
			return last
		}
	}
	return last
}

// A pairing-code room must be untouched by installation presence: two tabs of
// one browser pairing with each other by code are two participants, and merging
// them would silently break that flow. The gate is the server's, not a promise
// about what the client chooses to send.
func TestCodeRoomIgnoresDeviceID(t *testing.T) {
	dial, ctx := wsFixture(t, "c:123456", 2, false /* lan */)
	a := dial()
	b := dial()
	writeFrame(t, ctx, a, map[string]any{"type": "join", "name": "Tab1", "deviceId": devA, "active": true})
	writeFrame(t, ctx, b, map[string]any{"type": "join", "name": "Tab2", "deviceId": devA})

	roster := readRoster(t, ctx, b, 2)
	if len(roster) != 2 {
		t.Fatalf("a code room must keep both participants, got %+v", roster)
	}
}

// The same two frames in the code-less LAN room do group — this is what makes
// the test above a statement about the room type rather than about the payload.
func TestLanRoomGroupsDeviceID(t *testing.T) {
	dial, ctx := wsFixture(t, "ip:198.51.100.4", 0, true /* lan */)
	a1 := dial()
	a2 := dial()
	b := dial()
	writeFrame(t, ctx, a1, map[string]any{"type": "join", "name": "A", "deviceId": devA, "active": true})
	writeFrame(t, ctx, a2, map[string]any{"type": "join", "name": "A", "deviceId": devA})
	writeFrame(t, ctx, b, map[string]any{"type": "join", "name": "B", "deviceId": devB})

	roster := readRoster(t, ctx, b, 1)
	if len(roster) != 1 {
		t.Fatalf("B must be offered one entry for the two A pages, got %+v", roster)
	}
}

// An activation frame is a client-controlled message like any other, so it has
// to be charged to the per-connection budget. Otherwise a peer that has already
// joined can flood the server with a frame type that costs nothing.
func TestActivateFramesSpendTheConnectionBudget(t *testing.T) {
	dial, ctx := wsFixture(t, "ip:198.51.100.5", 0, true /* lan */)
	c := dial()
	writeFrame(t, ctx, c, map[string]any{"type": "join", "name": "flooder", "deviceId": devA})

	// The rate bucket is burst 50, refilled 10/s. Well past it in one go, so the
	// rate — not the byte budget (these frames are tiny) — is what trips.
	frame, _ := json.Marshal(map[string]any{"type": TypeActivate})
	for i := 0; i < 300; i++ {
		if err := c.Write(ctx, websocket.MessageText, frame); err != nil {
			break // already closed by the server
		}
	}
	var err error
	for {
		if _, _, err = c.Read(ctx); err != nil {
			break
		}
	}
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("an activation flood must be closed with PolicyViolation, got status=%v err=%v", got, err)
	}
}
