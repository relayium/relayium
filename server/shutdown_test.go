package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// eventLog records the shutdown sequence in order.
type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) add(e string) {
	l.mu.Lock()
	l.events = append(l.events, e)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

func indexOf(events []string, e string) int {
	for i, x := range events {
		if x == e {
			return i
		}
	}
	return -1
}

// listenerServer adapts a real *http.Server to serve on a pre-bound listener,
// so the test knows the port and exercises net/http's real Shutdown.
type listenerServer struct {
	*http.Server
	ln  net.Listener
	log *eventLog
}

func (s *listenerServer) ListenAndServe() error { return s.Serve(s.ln) }
func (s *listenerServer) Shutdown(ctx context.Context) error {
	s.log.add("server.Shutdown")
	return s.Server.Shutdown(ctx)
}

func quietLogf(string, ...any) {}

// TestServeUntilStoppedDrainsThenStopsBackgroundThenClosesStore pins the
// graceful-shutdown order on a real http.Server: a request in flight when the
// signal arrives completes with its response, background loops are cancelled
// only after the drain, and the store is closed exactly once, last.
func TestServeUntilStoppedDrainsThenStopsBackgroundThenClosesStore(t *testing.T) {
	events := &eventLog{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		events.add("request.done")
		_, _ = io.WriteString(w, "finished")
	})
	srv := &listenerServer{Server: &http.Server{Handler: mux}, ln: ln, log: events}

	bg := newBackgroundGroup()
	bg.Go(func(ctx context.Context) {
		<-ctx.Done()
		events.add("background.cancelled")
	})
	var closes atomic.Int32
	closeStore := func() error {
		closes.Add(1)
		events.add("store.Close")
		return nil
	}

	stop, fire := context.WithCancel(context.Background())
	defer fire()
	result := make(chan error, 1)
	go func() {
		result <- serveUntilStopped(stop, srv, bg, closeStore, 5*time.Second, time.Second, quietLogf)
	}()

	type reply struct {
		body string
		err  error
	}
	got := make(chan reply, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/slow")
		if err != nil {
			got <- reply{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		got <- reply{body: string(b), err: err}
	}()
	<-entered
	fire() // the SIGTERM
	// Give Shutdown time to start; the background loop must still be running
	// and the store open while the request is in flight.
	time.Sleep(100 * time.Millisecond)
	if e := events.snapshot(); indexOf(e, "background.cancelled") >= 0 || indexOf(e, "store.Close") >= 0 {
		t.Fatalf("background cancelled or store closed while a request was still in flight: %v", e)
	}
	close(release)

	r := <-got
	if r.err != nil || r.body != "finished" {
		t.Fatalf("in-flight request was not drained: body=%q err=%v", r.body, r.err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("clean shutdown returned %v; it must exit 0", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveUntilStopped did not return")
	}
	if n := closes.Load(); n != 1 {
		t.Fatalf("store closed %d times, want exactly 1", n)
	}
	e := events.snapshot()
	sd, done, bgc, sc := indexOf(e, "server.Shutdown"), indexOf(e, "request.done"), indexOf(e, "background.cancelled"), indexOf(e, "store.Close")
	if sd < 0 || done < 0 || bgc < 0 || sc < 0 || !(sd < done && done < bgc && bgc < sc) {
		t.Fatalf("shutdown order = %v; want server.Shutdown < request.done < background.cancelled < store.Close", e)
	}
	if _, err := http.Get("http://" + ln.Addr().String() + "/slow"); err == nil {
		t.Fatal("server still accepting after shutdown")
	}
}

// fakeServer lets the drain and listener-failure branches be forced.
type fakeServer struct {
	serveErr   error // returned at once by ListenAndServe when non-nil
	hangDrain  bool  // Shutdown waits for its context to expire
	stopped    chan struct{}
	stopOnce   sync.Once
	closeCalls atomic.Int32
}

func newFakeServer() *fakeServer { return &fakeServer{stopped: make(chan struct{})} }

func (f *fakeServer) ListenAndServe() error {
	if f.serveErr != nil {
		return f.serveErr
	}
	<-f.stopped
	return http.ErrServerClosed
}

func (f *fakeServer) Shutdown(ctx context.Context) error {
	if f.hangDrain {
		<-ctx.Done()
		return ctx.Err()
	}
	f.stopOnce.Do(func() { close(f.stopped) })
	return nil
}

func (f *fakeServer) Close() error {
	f.closeCalls.Add(1)
	f.stopOnce.Do(func() { close(f.stopped) })
	return nil
}

// TestServeUntilStoppedBoundsAStuckDrainAndAStuckLoop: a drain that never
// finishes is force-closed at its bound, a background loop that ignores its
// context is abandoned at its bound, and the store is still closed once and the
// stop still counts as clean.
func TestServeUntilStoppedBoundsAStuckDrainAndAStuckLoop(t *testing.T) {
	srv := newFakeServer()
	srv.hangDrain = true
	bg := newBackgroundGroup()
	hold := make(chan struct{})
	defer close(hold)
	bg.Go(func(context.Context) { <-hold }) // ignores cancellation
	var closes atomic.Int32
	stop, fire := context.WithCancel(context.Background())
	fire()
	result := make(chan error, 1)
	go func() {
		result <- serveUntilStopped(stop, srv, bg, func() error { closes.Add(1); return nil },
			200*time.Millisecond, 200*time.Millisecond, quietLogf)
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("signal-initiated stop returned %v; want nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not finish within 3s; its bounds were 200ms + 200ms")
	}
	if srv.closeCalls.Load() != 1 {
		t.Fatalf("stuck drain was not force-closed (Close calls = %d)", srv.closeCalls.Load())
	}
	if closes.Load() != 1 {
		t.Fatalf("store closed %d times, want 1", closes.Load())
	}
}

// TestServeUntilStoppedReturnsListenerFailure: a listener that cannot start is
// still a non-zero exit, as log.Fatal(ListenAndServe()) was.
func TestServeUntilStoppedReturnsListenerFailure(t *testing.T) {
	srv := newFakeServer()
	srv.serveErr = errors.New("listen tcp :8080: bind: address already in use")
	bg := newBackgroundGroup()
	var closes atomic.Int32
	err := serveUntilStopped(context.Background(), srv, bg, func() error { closes.Add(1); return nil },
		time.Second, time.Second, quietLogf)
	if err == nil || err.Error() != srv.serveErr.Error() {
		t.Fatalf("listener failure returned %v; want %v", err, srv.serveErr)
	}
	if bg.ctx.Err() == nil {
		t.Fatal("background context left running after the listener failed")
	}
}

func TestDBOpenFailureIsFatalOnlyForAPublicDeployment(t *testing.T) {
	for _, c := range []struct {
		baseURL string
		fatal   bool
	}{
		{"https://relayium.com", true},
		{"HTTPS://relayium.example", true},
		{" https://relayium.com ", true},
		{"http://localhost:8080", false},
		{"http://relayium.lan", false},
		{"", false},
	} {
		if got := dbOpenFailureIsFatal(c.baseURL); got != c.fatal {
			t.Errorf("dbOpenFailureIsFatal(%q) = %v, want %v", c.baseURL, got, c.fatal)
		}
	}
}
