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
//
// lan says whether this is the code-less same-network room. Installation
// presence (Envelope.DeviceID/Active and TypeActivate) is honoured there and
// ONLY there: a pairing-code room is a two-participant capability room, where
// grouping two connections into one device would silently break a user pairing
// two tabs of one browser. Gating it here rather than trusting the client to
// omit the field makes that a property of the server.
func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string, lan bool) {
	return ServeWSHooked(h, idgen, WSHooks{})
}

// WSHooks are the optional callbacks a connection's lifetime fires.
//
// Grouped into a struct rather than added as parameters because there are now
// three of them and they arrive together from one wiring site. A zero WSHooks
// is exactly the unobserved behaviour ServeWS has always had.
//
// Every one of them runs on the connection's READ GOROUTINE. None may block:
// anything touching a database or the network belongs on a goroutine of its
// own, or every frame that room handles waits behind it.
type WSHooks struct {
	// Join fires after a connection is admitted.
	Join RoomJoinObserver
	// Leave fires after an admitted connection has been removed from its room.
	Leave RoomLeaveObserver
	// Renew handles an `ice-renew` frame from an admitted, non-LAN connection.
	Renew RenewRequestHandler
}

// RoomJoinObserver is told, after a connection is admitted, which room it joined
// and how many connections that room now holds.
//
// It exists for exactly one thing: the pre-upload lifecycle has to learn that a
// pairing code was claimed, and it must learn it from the SERVER's own view of
// the room rather than from a client saying so — a client-asserted join would be
// a free extension of the ciphertext's deadline, granted to the one party the
// deadline constrains.
//
// Called on the connection's read goroutine. An implementation MUST NOT block:
// anything that touches a database or the network belongs on a goroutine of its
// own, or every join in the room waits for it.
//
// `id` is the server-stamped id of the connection that just joined and
// `members` is the room's exact membership at that instant, both captured under
// the admission lock. Renewal authority is frozen from `members`, so a list
// read afterwards would not do: a pairing-code room that loses a peer frees a
// slot a replacement can take while the code is still live.
type RoomJoinObserver func(room, id string, peers int, members []string)

// RoomLeaveObserver is told that an admitted connection has left its room.
//
// It is the end of a renewal grant, and it is deliberately the SOCKET leaving
// rather than a roster change: a roster can lose an id to a device handover,
// while this fires once, from the connection's own teardown, for a connection
// that really is gone.
type RoomLeaveObserver func(room, id string)

// RenewRequestHandler receives one well-formed `ice-renew` payload from an
// admitted connection, already attributed to the room and id the SERVER stamped
// on it. It must return promptly; see WSHooks.
type RenewRequestHandler func(room, id string, req RenewRequest)

// ServeWSObserved is ServeWS plus a join observer. nil observer == ServeWS.
func ServeWSObserved(h *Hub, idgen func() string, observe RoomJoinObserver) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string, lan bool) {
	return ServeWSHooked(h, idgen, WSHooks{Join: observe})
}

// ServeWSHooked is ServeWS with every optional callback.
func ServeWSHooked(h *Hub, idgen func() string, hooks WSHooks) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string, lan bool) {
	observe := hooks.Join
	return func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string, lan bool) {
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
				// After the hub has removed it, so anything the hook decides
				// (a renewal grant dying, above all) cannot be contradicted by
				// a room this connection is somehow still in.
				if hooks.Leave != nil {
					hooks.Leave(room, id)
				}
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

			// Every decoded frame spends this connection's budget exactly once.
			// The only exemption is the single join that admits the connection:
			// it either sets joined (every later join is charged) or is refused
			// and the socket closes, so one connection can spend it once.
			//
			// Charged HERE, above the switch, because a frame no branch handles —
			// an unknown type, `null` (which decodes to a zero Envelope), a repeat
			// join — costs the same read and JSON parse as one that is handled.
			// The branches below must not charge again.
			if !(e.Type == TypeJoin && !joined) {
				if ok, reason := lim.admit(len(data)); !ok {
					_ = c.Close(websocket.StatusPolicyViolation, reason)
					return
				}
			}
			switch e.Type {
			case TypeJoin:
				if !joined {
					device, active := "", false
					var proto ProtoHint
					if lan {
						device, active = e.DeviceID, e.Active
					} else {
						// The link-pairing hint is a pairing-code room
						// concept; the LAN room ignores it entirely (no echo,
						// no roster field), mirroring how a code room ignores
						// deviceId.
						proto = e.Proto
					}
					if admitted, peers, members := h.JoinDeviceLimitedObservedMembers(room, id, e.Name, conn, maxPeers, clientIP, device, active, proto...); admitted {
						joined = true
						cancelJoin() // joined in time — stop the join deadline
						if observe != nil {
							// peers and members are the admission-time snapshot
							// captured under the insertion lock. The callback
							// itself is outside that lock.
							observe(room, id, peers, members)
						}
					} else {
						return // room full — close the connection
					}
				}
			case TypeActivate:
				// Already charged above, including when this arrives before the
				// join — otherwise this frame type would be a free flood channel
				// for anyone holding a socket.
				//
				// Only ever this connection's own (room, id) — never a target
				// named by the frame, which carries nothing the server reads.
				if joined && lan {
					h.Activate(room, id)
				}
			case TypeICERenew:
				// Charged above like every other frame, so a flood of these
				// costs a flood's worth of budget and closes the connection at
				// the same point any other flood would.
				//
				// Gated on `joined` for the reason TypeSignal is: the room and
				// the id are what the server stamped on an ADMITTED connection,
				// and renewal authority is exactly membership of that room. A
				// pre-join frame carries no membership to speak of.
				//
				// Never on the LAN room: it issues no relay credentials, so
				// there is nothing there to renew.
				//
				// A payload that will not decode is dropped in silence. It has
				// already been charged, and answering it would turn a malformed
				// frame into a reply channel.
				if joined && !lan && hooks.Renew != nil {
					// Strict: exactly two positive uint32 keys, checked before
					// anything reaches a grant. See ParseRenewRequest.
					if req, ok := ParseRenewRequest(e.Data); ok {
						hooks.Renew(room, id, req)
					}
				}
			case TypeSignal:
				// Forwarding is a membership action, so it needs an admitted
				// connection — not merely a budget. Hub.Relay resolves `to`
				// inside the room and never checks the SENDER, so without this
				// an un-joined socket holding an admitted peer's opaque
				// server-issued id could push frames into a room it was never
				// let into, bypassing room capacity and the join observer; and,
				// never being on the roster, it would also never produce the
				// `left` frame that tells the peer it is gone.
				//
				// Charged above regardless: a pre-join signal costs what it
				// cost to receive, it just does not travel.
				if joined {
					e.From = id
					// The hint is server-authored on welcome/roster only. A
					// peer cannot make one appear on a relayed frame.
					e.Proto = nil
					h.Relay(room, e)
				}
			}
		}
	}
}
