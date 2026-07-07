package signal

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type RelayDeps struct {
	OwnerOf   func(code string) (string, bool)
	OverQuota func(ctx context.Context, owner string) bool
	Record    func(ctx context.Context, sessionID, owner, code string, bytes int64)
	NewID     func() string
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
func (rr *relayRendezvous) pair(code string, self *websocket.Conn) (partner *websocket.Conn, isFirst bool, done chan struct{}) {
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
	m := <-w.ready
	return m.conn, true, m.done
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

		partner, isFirst, done := rr.pair(code, c)
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
		go pipe(ctx, c, partner, &total, deps, sid, owner, code, errc)
		go pipe(ctx, partner, c, &total, deps, sid, owner, code, errc)
		<-errc
		c.Close(websocket.StatusNormalClosure, "")
		partner.Close(websocket.StatusNormalClosure, "")
	}
}

func pipe(ctx context.Context, from, to *websocket.Conn, total *atomic.Int64, deps RelayDeps, sid, owner, code string, errc chan<- error) {
	var lastRecord time.Time
	for {
		typ, data, err := from.Read(ctx)
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
