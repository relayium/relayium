package signal

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// defaultParkTimeout bounds how long the first peer waits for a partner before
// the server releases its rendezvous slot, closes the parked websocket, and
// returns — without it a "sender starts, receiver never runs" case leaks the
// goroutine, the FD, and the waiting[code] entry forever (coder/websocket has
// no background pinger, so the dead client is never noticed).
const defaultParkTimeout = 30 * time.Second

// defaultIdleTimeout tears down a paired-but-silent session: each relay read is
// given this bounded deadline, so a stalled peer no longer holds both websockets
// open indefinitely.
const defaultIdleTimeout = 60 * time.Second

type RelayDeps struct {
	OwnerOf   func(code string) (string, bool)
	OverQuota func(ctx context.Context, owner string) bool
	Record    func(ctx context.Context, sessionID, owner, code string, bytes int64)
	NewID     func() string
	// ParkTimeout / IdleTimeout override the defaults above (<=0 uses default).
	// Injected per-handler rather than global so tests can shrink them without a
	// data race against running relay goroutines.
	ParkTimeout time.Duration
	IdleTimeout time.Duration
}

// relayMatch is handed to the parked first peer once a second peer arrives:
// the second peer's conn plus a done channel the second peer closes once its
// pipe goroutines finish, so the first peer's handler knows when to return.
type relayMatch struct {
	conn *websocket.Conn
	done chan struct{}
}

type relayWaiter struct {
	conn  *websocket.Conn
	ready chan relayMatch // receives the second peer's conn
}

type relayRendezvous struct {
	mu      sync.Mutex
	waiting map[string]*relayWaiter
}

func newRelayRendezvous() *relayRendezvous {
	return &relayRendezvous{waiting: map[string]*relayWaiter{}}
}

// pair blocks until a partner arrives for code; the first caller parks, the
// second caller matches and wakes the first. Returns (partnerConn, isFirst,
// done). Exactly one side (the non-first, matching caller) owns the
// bidirectional pipe for the session and must close done when it finishes so
// the first caller's handler can return — this keeps a single reader
// goroutine per websocket.Conn (coder/websocket forbids concurrent Reads on
// the same conn).
func (rr *relayRendezvous) pair(code string, self *websocket.Conn, parkTimeout time.Duration) (partner *websocket.Conn, isFirst bool, done chan struct{}) {
	rr.mu.Lock()
	if w, ok := rr.waiting[code]; ok {
		delete(rr.waiting, code)
		rr.mu.Unlock()
		done = make(chan struct{})
		w.ready <- relayMatch{conn: self, done: done} // hand ourselves to the parked first peer
		return w.conn, false, done
	}
	w := &relayWaiter{conn: self, ready: make(chan relayMatch, 1)}
	rr.waiting[code] = w
	rr.mu.Unlock()

	select {
	case m := <-w.ready:
		return m.conn, true, m.done
	case <-time.After(parkTimeout):
		// No partner arrived in time. Drop our slot, but only if it is still
		// ours: a second peer may have just claimed it under the lock (deleted
		// the entry and buffered a send on w.ready). Re-check identity under the
		// mutex to avoid racing that claim.
		rr.mu.Lock()
		if cur, ok := rr.waiting[code]; ok && cur == w {
			delete(rr.waiting, code)
			rr.mu.Unlock()
			return nil, true, nil // timed out; caller closes self
		}
		rr.mu.Unlock()
		// A partner claimed us concurrently; its send is buffered (cap 1), so
		// receive it and proceed as a normal paired first peer.
		m := <-w.ready
		return m.conn, true, m.done
	}
}

func RelayHandler(deps RelayDeps) http.HandlerFunc {
	rr := newRelayRendezvous()
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		owner, ok := deps.OwnerOf(code)
		if code == "" || !ok {
			http.Error(w, "unknown code", http.StatusForbidden)
			return
		}
		if deps.OverQuota(r.Context(), owner) {
			http.Error(w, "relay quota exceeded", http.StatusForbidden)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1) // file bytes; no small default cap

		parkTO := deps.ParkTimeout
		if parkTO <= 0 {
			parkTO = defaultParkTimeout
		}
		idleTO := deps.IdleTimeout
		if idleTO <= 0 {
			idleTO = defaultIdleTimeout
		}

		partner, isFirst, done := rr.pair(code, c, parkTO)
		if partner == nil {
			c.Close(websocket.StatusInternalError, "no partner")
			return
		}

		if isFirst {
			// The matching (second) peer's handler goroutine below owns the
			// bidirectional pipe and both conn's lifecycle; we just keep this
			// handler open until the session ends so the HTTP request (and
			// its websocket) isn't torn down mid-transfer.
			<-done
			return
		}

		sid := deps.NewID()
		var total atomic.Int64 // written from both pipe goroutines
		ctx := context.Background()
		defer func() { deps.Record(ctx, sid, owner, code, total.Load()) }()
		defer close(done)

		// Pipe self→partner, accumulating bytes; a second goroutine pipes the
		// reverse direction. Either side closing ends the session.
		errc := make(chan error, 2)
		go pipe(ctx, c, partner, &total, deps, sid, owner, code, idleTO, errc)
		go pipe(ctx, partner, c, &total, deps, sid, owner, code, idleTO, errc)
		<-errc
		c.Close(websocket.StatusNormalClosure, "")
		partner.Close(websocket.StatusNormalClosure, "")
	}
}

func pipe(ctx context.Context, from, to *websocket.Conn, total *atomic.Int64, deps RelayDeps, sid, owner, code string, idleTimeout time.Duration, errc chan<- error) {
	var lastRecord time.Time
	for {
		// Bound each read so a silent paired session is torn down instead of
		// pinning both websockets open forever. When one direction times out its
		// error ends the session (the handler closes both conns), which also
		// unblocks any Write stuck on the other goroutine.
		rctx, rcancel := context.WithTimeout(ctx, idleTimeout)
		typ, data, err := from.Read(rctx)
		rcancel()
		if err != nil {
			errc <- err
			return
		}
		if err := to.Write(ctx, typ, data); err != nil {
			errc <- err
			return
		}
		n := total.Add(int64(len(data)))
		if time.Since(lastRecord) > time.Second {
			deps.Record(ctx, sid, owner, code, n)
			lastRecord = time.Now()
		}
	}
}
