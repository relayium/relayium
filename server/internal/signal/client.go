package signal

import (
	"context"
	"sync"

	"github.com/coder/websocket"
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
