package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/linksession"
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
// not have. Since link pairing (A10) an app peer is linked on a server that
// supports pairing hints (TestCrossnetLinksAnAppThatAnnouncesLink); on a server
// that predates them the CLI still falls to the older handshake, which cannot
// pair with an app, and the user is told what joined and what to do instead.
func TestCrossnetExplainsAnAppOrBrowserPeer(t *testing.T) {
	cases := []struct {
		name, mode   string
		cmd          linksession.Cmd
		want, refuse []string
	}{
		{"send", rzvous.ModeFile, linksession.CmdSend,
			[]string{"app or the web page", "predates app pairing", "relayium receive", "relayium up <file>", "relayium down <link>"}, nil},
		{"text", rzvous.ModeText, linksession.CmdText,
			[]string{"app or the web page", "predates app pairing", "relayium text"}, []string{"relayium up"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := roomServer(t)
			old := startLinkDevProxy(t, hub, true, false) // a server without pairing hints
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			errCh := make(chan error, 1)
			go func() {
				conn, err := crossnetDial(ctx, ldCode, "cli", crossFlags{server: old}, io.Discard, tc.cmd, tc.mode)
				if conn != nil {
					conn.Close()
				}
				errCh <- err
			}()

			// The app: joins the room and answers the way RelayiumKit does.
			app, err := rzvous.Join(ctx, hub, "", "app")
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

// With pairing hints, `send`, `receive` and `text` no longer refuse an app:
// the app's first link/1 hello makes discovery choose the link, and the
// command runs over it (A10). Asserted at the dial: what comes back is a
// link, not the older CLI connection, and no older-CLI commit was sent to the
// app (which would make every shipped app give up on the spot).
func TestCrossnetLinksAnAppThatAnnouncesLink(t *testing.T) {
	for _, tc := range []struct {
		cmd  linksession.Cmd
		mode string
	}{{linksession.CmdSend, rzvous.ModeFile}, {linksession.CmdReceive, rzvous.ModeFile}, {linksession.CmdText, rzvous.ModeText}} {
		t.Run(tc.mode+"/"+fmt.Sprint(tc.cmd), func(t *testing.T) {
			hub := roomServer(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			type res struct {
				conn io.ReadWriteCloser
				err  error
			}
			ch := make(chan res, 1)
			go func() {
				conn, err := crossnetDial(ctx, ldCode, "cli", crossFlags{server: hub}, io.Discard, tc.cmd, tc.mode)
				ch <- res{conn, err}
			}()
			app, err := rzvous.Join(ctx, hub, "", "app")
			if err != nil {
				t.Fatalf("app join: %v", err)
			}
			defer app.Close()
			if err := app.SendSignal(ctx, json.RawMessage(`{"caps":["link/1","preupload/1"]}`)); err != nil {
				t.Fatalf("app hello: %v", err)
			}
			var r res
			select {
			case r = <-ch:
			case <-ctx.Done():
				t.Fatal("the CLI did not answer the app's link hello")
			}
			if r.err != nil {
				t.Fatalf("an app announcing link/1 was refused: %v", r.err)
			}
			h, ok := r.conn.(*linkHandle)
			if !ok {
				t.Fatalf("dial returned %T, want a link", r.conn)
			}
			defer h.Close()
			// What the CLI said to the app: a link hello, never a legacy commit.
			rctx, rcancel := context.WithTimeout(ctx, 3*time.Second)
			defer rcancel()
			got, err := app.RecvSignal(rctx)
			if err != nil {
				t.Fatalf("the CLI never answered the app: %v", err)
			}
			if strings.Contains(string(got), `"kind"`) || !strings.Contains(string(got), "link/1") {
				t.Fatalf("the CLI answered the app with %s", got)
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
			// A server without pairing hints (the only place the older
			// handshake still meets an app), with the roster held back.
			held := rosterHoldingProxy(t, startLinkDevProxy(t, hub, true, false))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := linksession.CmdSend
			if mode == rzvous.ModeText {
				cmd = linksession.CmdText
			}

			errCh := make(chan error, 1)
			go func() {
				conn, err := crossnetDial(ctx, ldCode, "cli", crossFlags{server: held}, io.Discard, cmd, mode)
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
