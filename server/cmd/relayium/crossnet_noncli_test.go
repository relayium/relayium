package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/signal"
)

// roomServer is a one-room rendezvous: whoever dials it shares a room, which is
// all a pairing code does.
func roomServer(t *testing.T) string {
	t.Helper()
	hub := signal.NewHub()
	var seq int32
	handle := signal.ServeWS(hub, func() string { return "peer" + string(rune('A'+atomic.AddInt32(&seq, 1))) })
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "testroom", 0, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// Reported hands-on, 2026-09-21: `relayium send` minted a code, the code was
// typed into a native app, and the sender died with "rzvous: unexpected
// handshake message " -- the trailing blank being the kind the app's signal does
// not have. The pairing cannot work (pinned-TLS TCP on one side, WebRTC on the
// other), so the refusal stays; what changes is that the user is told what
// joined and what to do instead.
func TestCrossnetExplainsAnAppOrBrowserPeer(t *testing.T) {
	cases := []struct {
		name, mode   string
		want, refuse []string
	}{
		{"send", rzvous.ModeFile,
			[]string{"app or the web page", "relayium receive", "relayium up <file>", "relayium down <link>"}, nil},
		{"text", rzvous.ModeText,
			[]string{"app or the web page", "relayium text"}, []string{"relayium up"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := roomServer(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			errCh := make(chan error, 1)
			go func() {
				conn, err := crossnetConn(ctx, "", "cli", crossFlags{server: base}, io.Discard, tc.mode)
				if conn != nil {
					conn.Close()
				}
				errCh <- err
			}()

			// The app: joins the room and answers the way RelayiumKit does.
			app, err := rzvous.Join(ctx, base, "", "app")
			if err != nil {
				t.Fatalf("app join: %v", err)
			}
			defer app.Close()
			if err := app.SendSignal(ctx, json.RawMessage(`{"commit":"AAAA"}`)); err != nil {
				t.Fatalf("app send: %v", err)
			}

			got := <-errCh
			if got == nil {
				t.Fatal("paired with a peer that does not speak the CLI transport")
			}
			msg := got.Error()
			if strings.Contains(msg, "unexpected handshake message") || strings.Contains(msg, "rzvous:") {
				t.Errorf("still the internal error: %q", msg)
			}
			for _, w := range tc.want {
				if !strings.Contains(msg, w) {
					t.Errorf("message lacks %q: %q", w, msg)
				}
			}
			for _, r := range tc.refuse {
				if strings.Contains(msg, r) {
					t.Errorf("message must not offer %q here: %q", r, msg)
				}
			}
		})
	}
}
