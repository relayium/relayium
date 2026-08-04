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

// wsTestServer spins up a ServeWS-backed /ws endpoint and returns its ws:// URL.
func wsTestServer(t *testing.T) string {
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
		handle(r.Context(), c, "testroom", 0, "127.0.0.1", true)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
}

// testJoinTimeout is the shrunk join deadline these tests install via
// setJoinTimeoutForTest so they don't wait out the real 30s production value.
const testJoinTimeout = 200 * time.Millisecond

// setJoinTimeoutForTest overrides the atomic-backed join deadline (client.go's
// joinTimeoutNS) for the duration of a test, returning a restore func for the
// caller to defer. Going through the atomic — rather than a plain package var
// — is what keeps this race-free under -race: a ServeWS goroutine left running
// from this (or a neighbouring) test can be reading joinTimeout() concurrently
// with the restore below.
func setJoinTimeoutForTest(d time.Duration) (restore func()) {
	prev := joinTimeoutNS.Swap(int64(d))
	return func() { joinTimeoutNS.Store(prev) }
}

// A connection that never joins is reaped shortly after joinTimeout, so it can't
// hold a per-IP slot indefinitely.
func TestServeWSReapsUnjoinedConnection(t *testing.T) {
	defer setJoinTimeoutForTest(testJoinTimeout)()

	url := wsTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	// Never send Join. The server must close us shortly after joinTimeout.
	start := time.Now()
	for {
		if _, _, err = c.Read(ctx); err != nil {
			break
		}
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("un-joined connection not reaped promptly (took %v)", elapsed)
	}
}

// A joined connection that then sits idle PAST joinTimeout stays open — the
// join deadline must not bound legitimate post-join idle (waiting for a peer, or
// an in-progress peer-to-peer transfer that leaves signaling silent).
func TestServeWSJoinedConnectionSurvivesIdle(t *testing.T) {
	defer setJoinTimeoutForTest(testJoinTimeout)()

	url := wsTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	join, _ := json.Marshal(map[string]any{"type": "join", "name": "tester"})
	if err := c.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatalf("write join: %v", err)
	}

	// Drain everything the server sends; report if/when it closes us. If the join
	// deadline had wrongly applied post-join, the server would close shortly after
	// joinTimeout and this fires quickly.
	closed := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				closed <- err
				return
			}
		}
	}()

	select {
	case err := <-closed:
		t.Fatalf("joined connection was wrongly closed after idle: %v", err)
	case <-time.After(3 * testJoinTimeout):
		// Stayed open well past the join deadline — correct.
	}
}
