package signal

import (
	"context"
	"sync"
	"sync/atomic"
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

// joinTimeout bounds how long a connection may sit BEFORE it joins a room. A
// legitimate client sends Join immediately on open, so 30s is generous; an
// un-joined connection otherwise just holds a per-IP slot (kept alive by the
// ping goroutine) — a cheap slow-hold. We deliberately do NOT bound idle AFTER
// join: a minted code waits for its peer, and the signaling socket sits idle for
// the whole transfer (the data flows peer-to-peer over WebRTC, not here).
//
// Stored as nanoseconds behind an atomic, not a plain var, so tests can shrink
// it (see setJoinTimeoutForTest in join_timeout_test.go) without racing a
// ServeWS goroutine from this — or a neighbouring — test that is concurrently
// reading it via joinTimeout() below at context.WithTimeout time. Production
// code sets it once here at init and never writes it again.
var joinTimeoutNS atomic.Int64

func init() {
	joinTimeoutNS.Store(int64(30 * time.Second))
}

// joinTimeout returns the current join deadline.
func joinTimeout() time.Duration {
	return time.Duration(joinTimeoutNS.Load())
}

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
		// Explicit single-frame cap: a real signaling frame is a few KB. Anything
		// larger is rejected by coder/websocket at read time (ends the loop).
		c.SetReadLimit(maxFrameBytes)

		id := idgen()
		conn := newWSConn(ctx, c)
		lim := newConnLimiter(time.Now)
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

		// Until the client joins, reads run under a join deadline so an un-joined
		// connection can't hold a slot indefinitely. Once joined, reads use the
		// plain connection context (unbounded idle is legitimate — see joinTimeout).
		joinCtx, cancelJoin := context.WithTimeout(ctx, joinTimeout())
		defer cancelJoin()

		malformed := 0 // 连续解不开的帧数，见下面的 maxMalformedFrames

		for {
			readCtx := ctx
			if !joined {
				readCtx = joinCtx
			}
			_, data, err := c.Read(readCtx)
			if err != nil {
				return
			}
			e, err := DecodeEnvelope(data)
			if err != nil {
				// 畸形帧同样计入这条连接的预算。以前是直接 continue：解析失败的帧
				// 既不算字节也不算次数，于是一个已加入的对端可以无限地灌垃圾，
				// 每一帧都白白吃掉一次 JSON 解析——所有速率限制都绕过去了，只因为
				// 它发的是**解不开**的东西而不是解得开的东西。
				if ok, reason := lim.admit(len(data)); !ok {
					_ = c.Close(websocket.StatusPolicyViolation, reason)
					return
				}
				// 连续多帧都解不开，说明对面不是一个正常客户端（正常客户端发的每一帧
				// 都是自己拼的 JSON）。断开，别陪着它烧 CPU。
				malformed++
				if malformed >= maxMalformedFrames {
					_ = c.Close(websocket.StatusPolicyViolation, "too many malformed frames")
					return
				}
				continue
			}
			malformed = 0 // 一条正常帧就重置：偶发的坏帧不该累积成断线
			switch e.Type {
			case TypeJoin:
				if !joined {
					if h.JoinLimited(room, id, e.Name, conn, maxPeers, clientIP) {
						joined = true
						cancelJoin() // joined in time — stop the join deadline
					} else {
						return // room full — close the connection
					}
				}
			case TypeSignal:
				// Count the raw frame bytes; join frames are never counted.
				if ok, reason := lim.admit(len(data)); !ok {
					_ = c.Close(websocket.StatusPolicyViolation, reason)
					return
				}
				e.From = id
				h.Relay(room, e)
			}
		}
	}
}
