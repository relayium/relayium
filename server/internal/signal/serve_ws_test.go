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

// A client that pushes past the 1 MiB cumulative signal budget must be closed by
// the server with StatusPolicyViolation. This covers the SetReadLimit + Close
// wiring in ServeWS that the connLimiter unit test cannot reach.
func TestServeWSClosesOnByteBudgetExceeded(t *testing.T) {
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
		handle(r.Context(), c, "testroom", 0, "127.0.0.1")
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	// TypeJoin bytes are never counted against the budget.
	join, _ := json.Marshal(map[string]any{"type": "join", "name": "tester"})
	_ = c.Write(ctx, websocket.MessageText, join)

	// ~40 frames * ~30 KB = ~1.2 MiB > 1 MiB budget, and 40 < the 50-token burst,
	// so the byte budget (not the rate) is what trips. Each frame stays under the
	// 32 KiB read limit.
	payload, _ := json.Marshal(strings.Repeat("y", 30000))
	for i := 0; i < 40; i++ {
		frame, _ := json.Marshal(map[string]any{"type": "signal", "to": "nobody", "data": json.RawMessage(payload)})
		if err := c.Write(ctx, websocket.MessageText, frame); err != nil {
			break // server has closed us; remaining writes error out
		}
	}

	// The join handshake (TypeWelcome + TypePeers) is delivered to this client
	// ahead of the close, so drain reads until the server closes the socket.
	for {
		if _, _, err = c.Read(ctx); err != nil {
			break
		}
	}
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("want PolicyViolation close, got status=%v err=%v", got, err)
	}
}
