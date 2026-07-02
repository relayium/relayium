package signal

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Heartbeat cadence. coder/websocket does not ping on its own, so an idle room
// (e.g. a minted pairing code whose recipient hasn't joined yet) would sit
// silent and get reaped by NAT/load-balancer idle timeouts. A periodic ping
// keeps the path warm and detects a dead peer within pingInterval+pingTimeout.
const (
	pingInterval = 25 * time.Second
	pingTimeout  = 10 * time.Second
	// writeTimeout bounds a single frame write. The hub broadcasts to every peer
	// on one goroutine, so a stuck/slow consumer with no write deadline could
	// wedge the whole room until coder/websocket's own ~35s guard fires. Ten
	// seconds is generous for a live signaling frame yet fails a dead peer fast.
	writeTimeout = 10 * time.Second
)

type wsConn struct {
	ctx          context.Context
	c            *websocket.Conn
	mu           sync.Mutex // serialize writes
	writeTimeout time.Duration
	// writeFn performs the actual frame write; a field so tests can inject a
	// blocking writer without a live socket. Defaults to c.Write.
	writeFn func(ctx context.Context, typ websocket.MessageType, p []byte) error
}

// newWSConn wires a wsConn to a live websocket with the default write timeout.
func newWSConn(ctx context.Context, c *websocket.Conn) *wsConn {
	return &wsConn{ctx: ctx, c: c, writeTimeout: writeTimeout, writeFn: c.Write}
}

// send writes one already-encoded frame under a write deadline derived from the
// connection context, returning any write/timeout error.
func (w *wsConn) send(b []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	ctx, cancel := context.WithTimeout(w.ctx, w.writeTimeout)
	defer cancel()
	return w.writeFn(ctx, websocket.MessageText, b)
}

func (w *wsConn) Send(e Envelope) {
	b, err := EncodeEnvelope(e)
	if err != nil {
		return
	}
	if err := w.send(b); err != nil {
		// A slow or stuck consumer must not stall the shared broadcast path. On
		// write timeout (or any write error) close the socket: coder/websocket
		// has already torn down the frame stream, and this unblocks the Read loop
		// so the hub drops this peer.
		if w.c != nil {
			_ = w.c.Close(websocket.StatusPolicyViolation, "slow consumer")
		}
	}
}

// ServeWS handles one websocket client for its whole lifetime.
func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
	return func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
		id := idgen()
		conn := newWSConn(ctx, c)
		joined := false
		defer func() {
			if joined {
				h.Leave(room, id)
			}
		}()

		// Keepalive: ping on an interval; a failed ping means the peer is gone, so
		// close the socket to unblock the Read loop below. Stops when ctx is done
		// (the handler returning cancels r.Context()).
		go func() {
			t := time.NewTicker(pingInterval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					pctx, cancel := context.WithTimeout(ctx, pingTimeout)
					err := c.Ping(pctx)
					cancel()
					if err != nil {
						_ = c.Close(websocket.StatusGoingAway, "ping timeout")
						return
					}
				}
			}
		}()

		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			e, err := DecodeEnvelope(data)
			if err != nil {
				continue
			}
			switch e.Type {
			case TypeJoin:
				if !joined {
					if h.JoinLimited(room, id, e.Name, conn, maxPeers, clientIP) {
						joined = true
					} else {
						return // room full — close the connection
					}
				}
			case TypeSignal:
				e.From = id
				h.Relay(room, e)
			}
		}
	}
}
