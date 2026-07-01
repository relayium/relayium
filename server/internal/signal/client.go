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
)

type wsConn struct {
	ctx context.Context
	c   *websocket.Conn
	mu  sync.Mutex // serialize writes
}

func (w *wsConn) Send(e Envelope) {
	b, err := EncodeEnvelope(e)
	if err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.Write(w.ctx, websocket.MessageText, b)
}

// ServeWS handles one websocket client for its whole lifetime.
func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
	return func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
		id := idgen()
		conn := &wsConn{ctx: ctx, c: c}
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
