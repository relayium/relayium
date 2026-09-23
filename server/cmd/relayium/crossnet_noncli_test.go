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

// rosterHoldingProxy is a TEST-ONLY transparent WebSocket relay in front of a
// rendezvous. Toward its client it holds back every `peers` frame until one
// `signal` frame has been forwarded, then releases them after it; everything
// else passes through byte-for-byte. It makes the race the hub's roster
// debounce opens in production -- the other side's first signal overtaking
// our roster -- happen on every run instead of on a loaded CI runner only
// (go.yml race-rest, run 35877948854).
func rosterHoldingProxy(t *testing.T, upstream string) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		down, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer down.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		up, _, err := websocket.Dial(ctx, upstream+"/ws", nil)
		if err != nil {
			return
		}
		defer up.Close(websocket.StatusNormalClosure, "")
		go func() {
			defer cancel()
			for {
				typ, b, err := down.Read(ctx)
				if err != nil {
					return
				}
				if err := up.Write(ctx, typ, b); err != nil {
					return
				}
			}
		}()
		var held [][]byte
		released := false
		for {
			typ, b, err := up.Read(ctx)
			if err != nil {
				return
			}
			env, _ := signal.DecodeEnvelope(b)
			if !released && env.Type == signal.TypePeers {
				held = append(held, b)
				continue
			}
			if err := down.Write(ctx, typ, b); err != nil {
				return
			}
			if !released && env.Type == signal.TypeSignal {
				released = true
				for _, h := range held {
					if err := down.Write(ctx, websocket.MessageText, h); err != nil {
						return
					}
				}
				held = nil
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// The hosted-CI failure of TestCrossnetExplainsAnAppOrBrowserPeer/text, made
// deterministic: the app learns of the CLI and sends its first signal before
// the hub's debounced roster has told the CLI about the app. The CLI must
// still explain what joined -- promptly, not after its whole deadline -- which
// needs rzvous.Join to keep a signal that beats the roster instead of
// dropping it. Also a real product race: a CLI facing an app could hang.
func TestCrossnetExplainsAnAppThatSpeaksBeforeTheRoster(t *testing.T) {
	for _, mode := range []string{rzvous.ModeFile, rzvous.ModeText} {
		t.Run(mode, func(t *testing.T) {
			hub := roomServer(t)
			held := rosterHoldingProxy(t, hub)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			errCh := make(chan error, 1)
			go func() {
				conn, err := crossnetConn(ctx, "", "cli", crossFlags{server: held}, io.Discard, mode)
				if conn != nil {
					conn.Close()
				}
				errCh <- err
			}()

			app, err := rzvous.Join(ctx, hub, "", "app")
			if err != nil {
				t.Fatalf("app join: %v", err)
			}
			defer app.Close()
			if err := app.SendSignal(ctx, json.RawMessage(`{"commit":"AAAA"}`)); err != nil {
				t.Fatalf("app send: %v", err)
			}

			select {
			case got := <-errCh:
				if got == nil {
					t.Fatal("paired with a peer that does not speak the CLI transport")
				}
				if !strings.Contains(got.Error(), "app or the web page") {
					t.Fatalf("CLI did not explain the app peer: %q", got)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("CLI still waiting 2 s after the app spoke: the app's signal that beat the roster was dropped")
			}
		})
	}
}
