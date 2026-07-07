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
