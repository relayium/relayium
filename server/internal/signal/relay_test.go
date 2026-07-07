package signal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelayPipesAndMeters(t *testing.T) {
	var mu sync.Mutex
	recorded := map[string]int64{}
	deps := RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "owner1", code == "123456" },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record: func(ctx context.Context, sid, owner, code string, b int64) {
			mu.Lock()
			recorded[owner] = b // MAX semantics: last running total wins
			mu.Unlock()
		},
		NewID: func() string { return "sess1" },
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		return c
	}
	a := dial()
	b := dial()
	defer a.Close(websocket.StatusNormalClosure, "")
	defer b.Close(websocket.StatusNormalClosure, "")

	if err := a.Write(ctx, websocket.MessageBinary, []byte("hello-peer")); err != nil {
		t.Fatalf("a write: %v", err)
	}
	typ, got, err := b.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(got) != "hello-peer" {
		t.Fatalf("b read = %q typ=%v err=%v", got, typ, err)
	}

	// Let a metering tick land.
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	total := recorded["owner1"]
	mu.Unlock()
	if total < int64(len("hello-peer")) {
		t.Fatalf("metered %d bytes, want >= %d", total, len("hello-peer"))
	}
}

func TestRelayParkTimeoutReleasesFirstPeer(t *testing.T) {
	deps := RelayDeps{
		OwnerOf:     func(code string) (string, bool) { return "owner1", code == "123456" },
		OverQuota:   func(ctx context.Context, owner string) bool { return false },
		Record:      func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:       func() string { return "sess" },
		ParkTimeout: 100 * time.Millisecond,
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// A single peer parks; the server must release it after parkTimeout. The
	// blocking Read returns an error once the server closes the parked conn — no
	// sleep racing the timeout.
	a, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
	if err != nil {
		t.Fatalf("dial a: %v", err)
	}
	defer a.Close(websocket.StatusNormalClosure, "")
	if _, _, err := a.Read(ctx); err == nil {
		t.Fatal("expected parked peer to be closed after park timeout, got nil error")
	}

	// The rendezvous slot must be free again: a fresh pair on the SAME code
	// relays cleanly. If the stale waiting[code] entry had leaked, b would pair
	// with a's dead conn instead and this relay would fail.
	b, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
	if err != nil {
		t.Fatalf("dial b: %v", err)
	}
	defer b.Close(websocket.StatusNormalClosure, "")
	d, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
	if err != nil {
		t.Fatalf("dial d: %v", err)
	}
	defer d.Close(websocket.StatusNormalClosure, "")

	if err := b.Write(ctx, websocket.MessageBinary, []byte("ping")); err != nil {
		t.Fatalf("b write: %v", err)
	}
	typ, got, err := d.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(got) != "ping" {
		t.Fatalf("d read = %q typ=%v err=%v", got, typ, err)
	}
}

func TestRelayKeepsActiveOneWayTransferAlive(t *testing.T) {
	// One-directional bulk stream (like the CLI: sender streams, receiver silent)
	// for well over idleTimeout total. A session-scoped idle timeout must keep it
	// alive; a per-direction-read deadline would kill the silent reverse pipe.
	deps := RelayDeps{
		OwnerOf:     func(code string) (string, bool) { return "owner1", code == "123456" },
		OverQuota:   func(ctx context.Context, owner string) bool { return false },
		Record:      func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:       func() string { return "sess" },
		IdleTimeout: 200 * time.Millisecond,
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		return c
	}
	sender := dial()
	receiver := dial()
	defer sender.Close(websocket.StatusNormalClosure, "")
	defer receiver.Close(websocket.StatusNormalClosure, "")

	const n = 20 // 20 * 50ms = 1s of one-directional traffic >> 200ms idleTimeout
	for i := 0; i < n; i++ {
		if err := sender.Write(ctx, websocket.MessageBinary, []byte("chunk")); err != nil {
			t.Fatalf("write %d (session torn down mid-transfer?): %v", i, err)
		}
		typ, got, err := receiver.Read(ctx)
		if err != nil || typ != websocket.MessageBinary || string(got) != "chunk" {
			t.Fatalf("read %d = %q typ=%v err=%v (session torn down mid-transfer?)", i, got, typ, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestRelayTearsDownIdleSession(t *testing.T) {
	// No traffic in either direction for > idleTimeout → watchdog closes both.
	deps := RelayDeps{
		OwnerOf:     func(code string) (string, bool) { return "owner1", code == "123456" },
		OverQuota:   func(ctx context.Context, owner string) bool { return false },
		Record:      func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:       func() string { return "sess" },
		IdleTimeout: 100 * time.Millisecond,
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		return c
	}
	a := dial()
	b := dial()
	defer a.Close(websocket.StatusNormalClosure, "")
	defer b.Close(websocket.StatusNormalClosure, "")

	// Neither side writes; the blocking Read returns an error once the watchdog
	// tears the idle session down.
	if _, _, err := a.Read(ctx); err == nil {
		t.Fatal("expected idle session to be closed, got nil error")
	}
}

func TestRelayRejectsUnknownCode(t *testing.T) {
	deps := RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "", false },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:     func() string { return "x" },
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "?code=nope")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}
