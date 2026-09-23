package rzvous

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/signal"
)

func wsURL(srv *httptest.Server) string { return "ws" + strings.TrimPrefix(srv.URL, "http") }

// startObservedHub is startHub (the real signal.ServeWS hub, one code room)
// with deterministic ids "peer1", "peer2", ... and a join observer.
func startObservedHub(t *testing.T, observe signal.RoomJoinObserver) string {
	t.Helper()
	hub := signal.NewHub()
	var seq int32
	newID := func() string { return fmt.Sprintf("peer%d", atomic.AddInt32(&seq, 1)) }
	handle := signal.ServeWSObserved(hub, newID, observe)
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
	return wsURL(srv)
}

// startRosterHoldingProxy is a TEST-ONLY transparent WebSocket relay in front
// of a real hub. Toward its client it holds back every `peers` frame until at
// least one `signal` frame has been forwarded, then releases them after it. It
// makes the race the hub's roster debounce opens in production -- a peer's
// first signal overtaking our roster -- happen on every run instead of on an
// unlucky schedule. Everything else passes through byte-for-byte.
func startRosterHoldingProxy(t *testing.T, upstream string) string {
	return startProxy(t, upstream, true, false)
}

// startOldHubProxy is a TEST-ONLY EMULATION OF A HUB THAT PREDATES A08a: it
// relays to the real hub and deletes every `proto` field from welcome and
// peers frames. It keeps the old-hub tests meaningful after the real hub
// learns the hint.
func startOldHubProxy(t *testing.T, upstream string) string {
	return startProxy(t, upstream, false, true)
}

func stripProto(b []byte) []byte {
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return b
	}
	delete(m, "proto")
	if peers, ok := m["peers"].([]any); ok {
		for _, p := range peers {
			if pm, ok := p.(map[string]any); ok {
				delete(pm, "proto")
			}
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return b
	}
	return out
}

func startProxy(t *testing.T, upstream string, holdRoster, oldHub bool) string {
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
			if oldHub && (env.Type == signal.TypeWelcome || env.Type == signal.TypePeers) {
				b = stripProto(b)
			}
			if !holdRoster {
				released = true
			}
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
	return wsURL(srv)
}

// startHintStubHub is a TEST-ONLY STAND-IN FOR THE A08a SERVER HINT, written
// because the real hub in this tree does not implement A08a yet. It is a
// two-party room that follows A08-DESIGN §3.3: a join's `proto` is accepted
// only as an array of at most 4 known tokens (today exactly "link/1"), echoed
// on welcome, and carried on the peer's roster entry; anything else is absent.
// It also records every raw join frame it receives. Replace its use with the
// real hub once A08a lands.
type hintStub struct {
	mu    sync.Mutex
	joins [][]byte
	conns map[string]*websocket.Conn
	proto map[string][]string
	names map[string]string
	order []string
	seq   int
}

func startHintStubHub(t *testing.T) (string, *hintStub) {
	t.Helper()
	st := &hintStub{conns: map[string]*websocket.Conn{}, proto: map[string][]string{}, names: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx := r.Context()
		var id string
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			env, err := signal.DecodeEnvelope(b)
			if err != nil {
				return
			}
			switch env.Type {
			case signal.TypeJoin:
				var raw struct {
					Proto json.RawMessage `json:"proto"`
				}
				_ = json.Unmarshal(b, &raw)
				var list []string
				if json.Unmarshal(raw.Proto, &list) != nil || len(list) > 4 {
					list = nil
				}
				for _, p := range list {
					if p != ProtoLink {
						list = nil
						break
					}
				}
				st.mu.Lock()
				st.joins = append(st.joins, b)
				st.seq++
				id = fmt.Sprintf("hint%d", st.seq)
				st.conns[id], st.proto[id], st.names[id] = c, list, env.Name
				st.order = append(st.order, id)
				st.mu.Unlock()
				welcome := map[string]any{"type": signal.TypeWelcome, "name": id}
				if len(list) > 0 {
					welcome["proto"] = list
				}
				wb, _ := json.Marshal(welcome)
				_ = c.Write(ctx, websocket.MessageText, wb)
				st.broadcast(ctx)
			case signal.TypeSignal:
				st.mu.Lock()
				to := st.conns[env.To]
				st.mu.Unlock()
				if to != nil {
					env.From = id
					sb, _ := signal.EncodeEnvelope(env)
					_ = to.Write(ctx, websocket.MessageText, sb)
				}
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return wsURL(srv), st
}

func (st *hintStub) broadcast(ctx context.Context) {
	st.mu.Lock()
	peers := make([]map[string]any, 0, len(st.order))
	for _, id := range st.order {
		p := map[string]any{"id": id, "name": st.names[id]}
		if len(st.proto[id]) > 0 {
			p["proto"] = st.proto[id]
		}
		peers = append(peers, p)
	}
	b, _ := json.Marshal(map[string]any{"type": signal.TypePeers, "peers": peers})
	conns := make([]*websocket.Conn, 0, len(st.conns))
	for _, c := range st.conns {
		conns = append(conns, c)
	}
	st.mu.Unlock()
	for _, c := range conns {
		_ = c.Write(ctx, websocket.MessageText, b)
	}
}

// startScriptedServer runs script on the one connection a test makes, after
// reading (and handing it) the client's join frame.
func startScriptedServer(t *testing.T, script func(ctx context.Context, c *websocket.Conn, join []byte)) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		_, join, err := c.Read(r.Context())
		if err != nil {
			return
		}
		script(r.Context(), c, join)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return wsURL(srv)
}

func writeEnv(ctx context.Context, c *websocket.Conn, e signal.Envelope) error {
	b, err := signal.EncodeEnvelope(e)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, b)
}

func rawJoin(ctx context.Context, t *testing.T, base, name string) (*websocket.Conn, string) {
	t.Helper()
	c, _, err := websocket.Dial(ctx, base+"/ws", nil)
	if err != nil {
		t.Fatalf("raw dial: %v", err)
	}
	if err := writeEnv(ctx, c, signal.Envelope{Type: signal.TypeJoin, Name: name}); err != nil {
		t.Fatalf("raw join: %v", err)
	}
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("raw welcome: %v", err)
		}
		env, _ := signal.DecodeEnvelope(b)
		if env.Type == signal.TypeWelcome {
			return c, env.Name
		}
	}
}

// The production race, on the real hub: peer1 is in the room and has just
// caused a roster broadcast, so the hub's 200 ms debounce holds back the
// roster that would tell us about it. peer1 learns our id and speaks at once
// (an older CLI sends its commit as soon as its own roster names us). JoinRoom
// must hand those frames back, in order.
func TestJoinRoomCapturesSignalsThatBeatTheDebouncedRoster(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	joined := make(chan string, 4)
	base := startObservedHub(t, func(room, id string, peers int, members []string) { joined <- id })

	a, aID := rawJoin(ctx, t, base, "old-cli")
	defer a.Close(websocket.StatusNormalClosure, "")
	<-joined // a's own admission

	frames := []string{`{"kind":"commit","commit":"AAAA"}`, `{"n":2}`}
	sent := make(chan error, 1)
	go func() {
		bID := <-joined
		for _, f := range frames {
			if err := writeEnv(ctx, a, signal.Envelope{Type: signal.TypeSignal, To: bID, Data: json.RawMessage(f)}); err != nil {
				sent <- err
				return
			}
		}
		sent <- nil
	}()

	room, err := JoinRoom(ctx, base, "", "new-cli", []string{ProtoLink})
	if err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	defer room.Session.Close()
	if err := <-sent; err != nil {
		t.Fatalf("peer send: %v", err)
	}
	if room.PeerID != aID || room.Session.PeerID() != aID || room.SelfID != room.Session.SelfID() {
		t.Fatalf("room = self %q peer %q, want peer %q", room.SelfID, room.PeerID, aID)
	}
	if len(room.Captured) != len(frames) {
		t.Fatalf("captured %d frames %q, want %d (signals sent before the debounced roster were lost)", len(room.Captured), room.Captured, len(frames))
	}
	for i, f := range frames {
		if string(room.Captured[i]) != f {
			t.Errorf("captured[%d] = %s, want %s", i, room.Captured[i], f)
		}
	}
}

// Old hub: a hub that predates A08a never echoes the hint. Two hinted
// JoinRooms still pair, and both report "no server hints". The real hub sits
// behind startOldHubProxy so this stays an old hub after A08a lands.
func TestJoinRoomDetectsAHubWithoutHints(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := startOldHubProxy(t, startHub(t))
	aCh := make(chan *Room, 1)
	go func() {
		r, err := JoinRoom(ctx, base, "", "a", []string{ProtoLink})
		if err != nil {
			t.Errorf("join a: %v", err)
		}
		aCh <- r
	}()
	b, err := JoinRoom(ctx, base, "", "b", []string{ProtoLink})
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh
	if a == nil {
		t.FailNow()
	}
	defer a.Session.Close()
	defer b.Session.Close()
	if a.PeerID != b.SelfID || b.PeerID != a.SelfID {
		t.Fatalf("not mutual: a %s->%s, b %s->%s", a.SelfID, a.PeerID, b.SelfID, b.PeerID)
	}
	for _, r := range []*Room{a, b} {
		if r.ServerHints || r.PeerHint {
			t.Errorf("%s: ServerHints=%v PeerHint=%v on a hub without hints", r.SelfID, r.ServerHints, r.PeerHint)
		}
	}
}

// Welcome echo, against the A08a stand-in: a hinted join is echoed and the
// peer's roster entry carries the hint; an unhinted join (nil proto) gets no
// echo, its roster entry no hint, and its join frame is byte-identical to the
// one Join sends.
func TestJoinRoomDetectsTheWelcomeEchoAndPeerHint(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("both hinted", func(t *testing.T) {
		base, _ := startHintStubHub(t)
		aCh := make(chan *Room, 1)
		go func() {
			r, err := JoinRoom(ctx, base, "", "a", []string{ProtoLink})
			if err != nil {
				t.Errorf("join a: %v", err)
			}
			aCh <- r
		}()
		b, err := JoinRoom(ctx, base, "", "b", []string{ProtoLink})
		if err != nil {
			t.Fatalf("join b: %v", err)
		}
		a := <-aCh
		if a == nil {
			t.FailNow()
		}
		for _, r := range []*Room{a, b} {
			if !r.ServerHints || !r.PeerHint {
				t.Errorf("%s: ServerHints=%v PeerHint=%v, want both", r.SelfID, r.ServerHints, r.PeerHint)
			}
		}
	})

	t.Run("one unhinted", func(t *testing.T) {
		base, st := startHintStubHub(t)
		hCh := make(chan *Room, 1)
		go func() {
			r, err := JoinRoom(ctx, base, "", "hinted", []string{ProtoLink})
			if err != nil {
				t.Errorf("join hinted: %v", err)
			}
			hCh <- r
		}()
		u, err := JoinRoom(ctx, base, "", "plain", nil)
		if err != nil {
			t.Fatalf("join plain: %v", err)
		}
		h := <-hCh
		if h == nil {
			t.FailNow()
		}
		if !h.ServerHints || h.PeerHint {
			t.Errorf("hinted side: ServerHints=%v PeerHint=%v, want true/false", h.ServerHints, h.PeerHint)
		}
		if u.ServerHints || !u.PeerHint {
			t.Errorf("plain side: ServerHints=%v PeerHint=%v, want false/true", u.ServerHints, u.PeerHint)
		}
		want, _ := signal.EncodeEnvelope(signal.Envelope{Type: signal.TypeJoin, Name: "plain"})
		st.mu.Lock()
		defer st.mu.Unlock()
		found := false
		for _, j := range st.joins {
			if bytes.Contains(j, []byte(`"plain"`)) {
				found = true
				if !bytes.Equal(j, want) {
					t.Errorf("unhinted join = %s, want Join's exact frame %s", j, want)
				}
			}
			if bytes.Contains(j, []byte(`"hinted"`)) && !bytes.Contains(j, []byte(`"proto":["link/1"]`)) {
				t.Errorf("hinted join %s does not carry the hint", j)
			}
		}
		if !found {
			t.Error("stub never saw the unhinted join")
		}
	})
}

// The hint is server-authored and never trusted for shape: anything other than
// a string array containing "link/1" byte-for-byte is absent.
func TestJoinRoomTreatsMalformedHintsAsAbsent(t *testing.T) {
	for _, bad := range []string{`"link/1"`, `[1]`, `["LINK/1"]`, `[" link/1"]`, `null`, `{}`, `["link/1",2]`} {
		t.Run(bad, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
				_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"welcome","name":"self","proto":`+bad+`}`))
				_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"peers","peers":[{"id":"self","name":"s"},{"id":"peer","name":"p","proto":`+bad+`}]}`))
				_, _, _ = c.Read(ctx)
			})
			r, err := JoinRoom(ctx, base, "", "c", []string{ProtoLink})
			if err != nil {
				t.Fatalf("JoinRoom: %v", err)
			}
			defer r.Session.Close()
			if r.PeerID != "peer" || r.ServerHints || r.PeerHint {
				t.Errorf("peer=%q ServerHints=%v PeerHint=%v, want peer/false/false", r.PeerID, r.ServerHints, r.PeerHint)
			}
		})
	}
	// Control: the well-formed value is recognised by the same script.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"welcome","name":"self","proto":["link/1"]}`))
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"peers","peers":[{"id":"self","name":"s"},{"id":"peer","name":"p","proto":["link/1"]}]}`))
		_, _, _ = c.Read(ctx)
	})
	r, err := JoinRoom(ctx, base, "", "c", []string{ProtoLink})
	if err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	defer r.Session.Close()
	if !r.ServerHints || !r.PeerHint {
		t.Errorf("well-formed hint not recognised: ServerHints=%v PeerHint=%v", r.ServerHints, r.PeerHint)
	}
	// A server echo we did not ask for is not "server supports hints" as far as
	// this client can tell: it sent nothing to be echoed.
	base = startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"welcome","name":"self","proto":["link/1"]}`))
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"peers","peers":[{"id":"self","name":"s"},{"id":"peer","name":"p"}]}`))
		_, _, _ = c.Read(ctx)
	})
	r, err = JoinRoom(ctx, base, "", "c", nil)
	if err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	defer r.Session.Close()
	if r.ServerHints {
		t.Error("ServerHints true for an unhinted join")
	}
}

// Captured keeps only the selected peer's frames, in order, and a signal that
// arrives before Welcome is captured too.
func TestJoinRoomCapturesOnlyTheSelectedPeersSignals(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
		for _, e := range []signal.Envelope{
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":1}`)},
			{Type: signal.TypeWelcome, Name: "self"},
			{Type: signal.TypeSignal, From: "gone", Data: json.RawMessage(`{"i":"x"}`)},
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":2}`)},
			{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "peer"}, {ID: "self"}}},
			{Type: signal.TypeSignal, From: "peer", Data: json.RawMessage(`{"i":3}`)},
		} {
			if writeEnv(ctx, c, e) != nil {
				return
			}
		}
		_, _, _ = c.Read(ctx)
	})
	r, err := JoinRoom(ctx, base, "", "c", nil)
	if err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	defer r.Session.Close()
	if got := fmt.Sprintf("%s", r.Captured); got != `[{"i":1} {"i":2}]` {
		t.Fatalf("captured = %s, want [{\"i\":1} {\"i\":2}]", got)
	}
	// The first signal after the room view is complete is the Session's, not a
	// second copy of anything captured.
	next, err := r.Session.RecvSignal(ctx)
	if err != nil || string(next) != `{"i":3}` {
		t.Fatalf("next = %s, %v; want {\"i\":3}", next, err)
	}
}

// Overflow fails closed at exactly the documented bounds, counting frames from
// every sender, and closes the connection.
func TestJoinRoomCaptureOverflowFailsClosed(t *testing.T) {
	type frame struct {
		from string
		size int
	}
	repeat := func(n int, f frame) []frame {
		out := make([]frame, n)
		for i := range out {
			out[i] = f
		}
		return out
	}
	payload := func(n int) json.RawMessage {
		// A JSON string of exactly n bytes including its quotes.
		return json.RawMessage(`"` + strings.Repeat("x", n-2) + `"`)
	}
	cases := []struct {
		name     string
		frames   []frame
		overflow bool
	}{
		{"64 frames fit", repeat(MaxCapturedFrames, frame{"peer", 8}), false},
		{"65 frames overflow", repeat(MaxCapturedFrames+1, frame{"peer", 8}), true},
		{"65 frames overflow even from another id", append(repeat(MaxCapturedFrames, frame{"other", 8}), frame{"peer", 8}), true},
		{"256 KiB fits", repeat(16, frame{"peer", MaxCapturedBytes / 16}), false},
		{"256 KiB + 1 overflows", append(repeat(16, frame{"peer", MaxCapturedBytes / 16}), frame{"peer", 3}), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			closed := make(chan error, 1)
			base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
				_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypeWelcome, Name: "self"})
				for _, f := range tc.frames {
					if err := writeEnv(ctx, c, signal.Envelope{Type: signal.TypeSignal, From: f.from, Data: payload(f.size)}); err != nil {
						closed <- err
						return
					}
				}
				_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "self"}, {ID: "peer"}}})
				_, _, err := c.Read(ctx)
				closed <- err
			})
			r, err := JoinRoom(ctx, base, "", "c", nil)
			if !tc.overflow {
				if err != nil {
					t.Fatalf("JoinRoom: %v", err)
				}
				defer r.Session.Close()
				want := 0
				for _, f := range tc.frames {
					if f.from == "peer" {
						want++
					}
				}
				if len(r.Captured) != want {
					t.Fatalf("captured %d, want %d", len(r.Captured), want)
				}
				return
			}
			if !errors.Is(err, ErrCaptureOverflow) || r != nil {
				n := -1
				if r != nil {
					n = len(r.Captured)
					r.Session.Close()
				}
				t.Fatalf("JoinRoom returned a room (captured %d) and err %v; want ErrCaptureOverflow", n, err)
			}
			if cerr := <-closed; websocket.CloseStatus(cerr) != websocket.StatusPolicyViolation {
				t.Fatalf("server saw %v, want the client to close with policy violation", cerr)
			}
		})
	}
}

// The legacy path end to end on the real hub: an older CLI (unchanged Join +
// DoHandshake) sends its commit as soon as its roster names us, and that commit
// reaches us before our own roster does (held by the proxy on every run). The
// new side captures it, and DoHandshakeFromPeerCommit replays it into the
// existing handshake. Both modes, plus a mismatch that is reported rather than
// hidden.
func TestLegacyHandshakeFromACapturedCommitInteroperates(t *testing.T) {
	for _, tc := range []struct{ oldMode, newMode string }{
		{ModeFile, ModeFile},
		{ModeText, ModeText},
		{ModeText, ModeFile},
	} {
		t.Run(tc.oldMode+"/"+tc.newMode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			hub := startHub(t)
			proxied := startRosterHoldingProxy(t, hub)

			idOld, _ := secure.NewIdentity()
			idNew, _ := secure.NewIdentity()
			type res struct {
				h    *Handshake
				self string
				err  error
			}
			oldCh := make(chan res, 1)
			go func() {
				s, err := Join(ctx, hub, "", "old")
				if err != nil {
					oldCh <- res{err: err}
					return
				}
				defer s.Close()
				h, err := DoHandshake(ctx, s, idOld, []string{"1.1.1.1:1"}, tc.oldMode)
				oldCh <- res{h, s.SelfID(), err}
			}()

			room, err := JoinRoom(ctx, proxied, "", "new", []string{ProtoLink})
			if err != nil {
				t.Fatalf("JoinRoom: %v", err)
			}
			defer room.Session.Close()
			// An older CLI never hints. ServerHints is not asserted: it depends
			// on whether the real hub in this tree has A08a yet, and the legacy
			// path must work either way.
			if room.PeerHint {
				t.Fatal("an unhinted old CLI was reported as hinted")
			}
			if len(room.Captured) != 1 {
				t.Fatalf("captured %d frames, want the old CLI's commit", len(room.Captured))
			}
			hn, err := DoHandshakeFromPeerCommit(ctx, room.Session, idNew, []string{"2.2.2.2:2"}, tc.newMode, room.Captured[0])
			if err != nil {
				t.Fatalf("new side: %v", err)
			}
			ro := <-oldCh
			if ro.err != nil {
				t.Fatalf("old side: %v", ro.err)
			}
			ho := ro.h
			if ro.self != room.PeerID {
				t.Fatalf("paired with %q, old CLI is %q", room.PeerID, ro.self)
			}
			if ho.SAS != hn.SAS {
				t.Fatalf("SAS disagree: %s vs %s", ho.SAS, hn.SAS)
			}
			if ho.PeerFingerprint != idNew.Fingerprint || hn.PeerFingerprint != idOld.Fingerprint {
				t.Fatal("pinned fingerprints wrong")
			}
			if ho.IsServer == hn.IsServer {
				t.Fatal("both peers picked the same TLS role")
			}
			if len(hn.PeerCandidates) != 1 || hn.PeerCandidates[0] != "1.1.1.1:1" ||
				len(ho.PeerCandidates) != 1 || ho.PeerCandidates[0] != "2.2.2.2:2" {
				t.Fatalf("candidates: new got %v, old got %v", hn.PeerCandidates, ho.PeerCandidates)
			}
			wire := func(m string) string {
				if m == ModeFile {
					return ""
				}
				return m
			}
			if hn.PeerMode != wire(tc.oldMode) || ho.PeerMode != wire(tc.newMode) {
				t.Fatalf("modes: new saw %q, old saw %q", hn.PeerMode, ho.PeerMode)
			}
			if got, want := ModeCompatible(tc.newMode, hn.PeerMode), tc.oldMode == tc.newMode; got != want {
				t.Fatalf("ModeCompatible = %v, want %v", got, want)
			}
		})
	}
}

// Same rule as Join (TestJoinWaitsForWelcomeBeforeSelectingTheRosterPeer): a
// roster that arrives before Welcome is not interpreted, or our own entry
// would be taken for the peer.
func TestJoinRoomWaitsForWelcomeBeforeSelectingTheRosterPeer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := startScriptedServer(t, func(ctx context.Context, c *websocket.Conn, _ []byte) {
		_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypePeers, Peers: []signal.Peer{{ID: "self"}, {ID: "peer"}}})
		_ = writeEnv(ctx, c, signal.Envelope{Type: signal.TypeWelcome, Name: "self"})
		_, _, _ = c.Read(ctx)
	})
	r, err := JoinRoom(ctx, base, "", "c", []string{ProtoLink})
	if err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	defer r.Session.Close()
	if r.SelfID != "self" || r.PeerID != "peer" {
		t.Fatalf("joined as self=%q peer=%q, want self/peer", r.SelfID, r.PeerID)
	}
}
