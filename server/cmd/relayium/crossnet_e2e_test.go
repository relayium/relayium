package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// inProcServer runs the rendezvous (/ws) + relay (/relay) for a fixed code,
// entirely in-process on an httptest server, and returns its ws:// base URL.
// Mirrors the working helper in internal/rzvous/rzvous_test.go: signal.NewHub
// has no Run method, and signal.ServeWS returns a connection handler (not an
// http.HandlerFunc), so it must be invoked after websocket.Accept.
func inProcServer(t *testing.T, code string) string {
	t.Helper()
	hub := signal.NewHub()
	var mu sync.Mutex
	n := 0
	newID := func() string { mu.Lock(); defer mu.Unlock(); n++; return "p" + strconv.Itoa(n) }
	handle := signal.ServeWS(hub, newID)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		// Fixed LAN-style room so both peers pair regardless of the code query
		// param the rzvous client sends; the code itself is only checked by /relay.
		handle(r.Context(), c, "testroom", 0, "test-ip")
		c.Close(websocket.StatusNormalClosure, "")
	})

	deps := signal.RelayDeps{
		OwnerOf:   func(c string) (string, bool) { return "owner", c == code },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, c string, b int64) {},
		NewID:     newID,
	}
	mux.HandleFunc("/relay", signal.RelayHandler(deps))

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestCrossnetEndToEndOverRelay(t *testing.T) {
	code := "123456"
	server := inProcServer(t, code)

	// Source file to send.
	srcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "hello.txt"), []byte("cross-network!"), 0o644); err != nil {
		t.Fatal(err)
	}
	dstDir := t.TempDir()

	// Force relay (no reachable direct candidate on loopback across "networks").
	sendArgs := []string{"send", "--server", server, "--relay-only", filepath.Join(srcDir, "hello.txt"), code}
	recvArgs := []string{"receive", "--server", server, "--relay-only", code, dstDir}

	errc := make(chan int, 2)
	go func() {
		var o, e bytes.Buffer
		errc <- Run(recvArgs, &o, &e)
	}()
	// Small stagger so the receiver parks on the relay first (either order works).
	time.Sleep(100 * time.Millisecond)
	go func() {
		var o, e bytes.Buffer
		errc <- Run(sendArgs, &o, &e)
	}()

	for i := 0; i < 2; i++ {
		select {
		case code := <-errc:
			if code != 0 {
				t.Fatalf("a peer exited %d", code)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("timeout waiting for transfer")
		}
	}

	got, err := os.ReadFile(filepath.Join(dstDir, "hello.txt"))
	if err != nil || string(got) != "cross-network!" {
		t.Fatalf("received = %q err=%v", got, err)
	}
}
