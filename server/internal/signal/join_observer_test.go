package signal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The pre-upload lifecycle learns that a pairing code was claimed from THIS
// observation and from nothing else, so what it reports has to be exactly right:
// the minter's own connection is not a join, and the second participant is.

type observation struct {
	room  string
	peers int
}

// observedWSServer runs ServeWSObserved over a real websocket and records every
// observation.
func observedWSServer(t *testing.T, room string, maxPeers int) (*httptest.Server, func() []observation) {
	t.Helper()
	hub := NewHub()
	var seq int32
	newID := func() string { n := atomic.AddInt32(&seq, 1); return "p" + strconv.Itoa(int(n)) }

	var mu sync.Mutex
	var seen []observation
	handle := ServeWSObserved(hub, newID, func(room string, peers int) {
		mu.Lock()
		seen = append(seen, observation{room, peers})
		mu.Unlock()
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, room, maxPeers, "127.0.0.1", false)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []observation {
		mu.Lock()
		defer mu.Unlock()
		return append([]observation(nil), seen...)
	}
}

func joinWS(t *testing.T, srv *httptest.Server, name string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	join, _ := json.Marshal(map[string]any{"type": "join", "name": name})
	if err := c.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatalf("join: %v", err)
	}
	// The welcome is written before the observer fires; reading it means the join
	// has been processed, so the assertions below need no sleep.
	if _, _, err := c.Read(ctx); err != nil {
		t.Fatalf("welcome: %v", err)
	}
	return c
}

// waitFor polls until the observer has recorded at least n entries. The observer
// runs on the connection's own goroutine, so this converges immediately in
// practice; the loop exists so a slow machine cannot make the test flaky.
func waitFor(t *testing.T, snapshot func() []observation, n int) []observation {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := snapshot()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("observer recorded %d joins, want %d: %+v", len(got), n, got)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestServeWSObservedReportsTheSecondParticipant(t *testing.T) {
	room := PairRoomFor("424242")
	srv, snapshot := observedWSServer(t, room, 2)

	sender := joinWS(t, srv, "sender")
	defer sender.CloseNow()
	got := waitFor(t, snapshot, 1)
	if got[0].room != room || got[0].peers != 1 {
		t.Fatalf("minter's own join reported as %+v, want peers=1 in %s", got[0], room)
	}

	receiver := joinWS(t, srv, "receiver")
	defer receiver.CloseNow()
	got = waitFor(t, snapshot, 2)
	if got[1].peers != 2 {
		t.Fatalf("second participant reported %d peers, want 2", got[1].peers)
	}
	// The room name has to survive the round trip intact: the account layer
	// recovers the code from it, and a mangled prefix means the lifecycle
	// silently never fires.
	code, ok := strings.CutPrefix(got[1].room, PairRoomPrefix)
	if !ok || code != "424242" {
		t.Fatalf("room %q did not yield its code", got[1].room)
	}
}

func TestServeWSObservedCallsObserverOutsideHubLock(t *testing.T) {
	hub := NewHub()
	observed := make(chan int, 1)
	handle := ServeWSObserved(hub, func() string { return "outside-lock" }, func(room string, peers int) {
		// PeerCount takes the hub mutex. If the observer is invoked while the
		// admission lock is held, this synchronous call deadlocks.
		observed <- hub.PeerCount(room)
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "lock-room", 2, "127.0.0.1", false)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := joinWS(t, srv, "peer")
	defer c.CloseNow()
	select {
	case peers := <-observed:
		if peers != 1 {
			t.Fatalf("PeerCount in observer = %d, want 1", peers)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("observer blocked while reacquiring hub lock")
	}
}

func TestServeWSObservedConsumesAdmissionTimePeerSnapshot(t *testing.T) {
	source, err := os.ReadFile("client.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"if admitted, peers := h.JoinDeviceLimitedObserved(",
		"observe(room, peers)",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("ServeWSObserved wiring lacks %q", required)
		}
	}
	if strings.Contains(text, "observe(room, h.PeerCount(room))") {
		t.Fatal("ServeWSObserved re-reads PeerCount after admission instead of consuming the locked snapshot")
	}
}

// A refused join (the room is full) must not be reported: it did not happen, and
// reporting it would let a third connection re-stamp a code as claimed.
func TestServeWSObservedIgnoresRefusedJoins(t *testing.T) {
	room := PairRoomFor("434343")
	srv, snapshot := observedWSServer(t, room, 2)

	a := joinWS(t, srv, "a")
	defer a.CloseNow()
	b := joinWS(t, srv, "b")
	defer b.CloseNow()
	waitFor(t, snapshot, 2)

	// A third connection is refused by JoinDeviceLimited (maxPeers=2); the server
	// closes it without ever admitting it.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	join, _ := json.Marshal(map[string]any{"type": "join", "name": "third"})
	_ = c.Write(ctx, websocket.MessageText, join)
	_, _, _ = c.Read(ctx) // the close

	time.Sleep(50 * time.Millisecond)
	if got := snapshot(); len(got) != 2 {
		t.Fatalf("a refused join was observed: %+v", got)
	}
}

// ServeWS is ServeWSObserved with no observer, and must stay behaviourally
// identical for every caller that never asked for one.
func TestServeWSWithoutObserverStillServes(t *testing.T) {
	hub := NewHub()
	handle := ServeWS(hub, func() string { return "solo" })
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "lanroom", 0, "127.0.0.1", true)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := joinWS(t, srv, "only")
	defer c.CloseNow()
	if got := hub.PeerCount("lanroom"); got != 1 {
		t.Fatalf("PeerCount = %d, want 1", got)
	}
	if got := hub.PeerCount("no-such-room"); got != 0 {
		t.Fatalf("PeerCount of an empty room = %d, want 0", got)
	}
}
