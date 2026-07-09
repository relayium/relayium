package signal

import (
	"sync"
	"time"
)

// Conn is the hub's view of a connection; the real websocket adapter implements it.
type Conn interface {
	Send(Envelope)
}

// maxRooms bounds the total number of concurrent signaling rooms so the hub
// cannot be driven to exhaust memory by opening unbounded distinct rooms.
// Tunable.
const maxRooms = 5000

// rosterDebounce coalesces roster broadcasts to at most one per room per window
// (leading edge + trailing flush), damping churn from rapid Join/Leave. Tunable.
const rosterDebounce = 200 * time.Millisecond

type peer struct {
	id   string
	name string
	conn Conn
}

type roomBroadcast struct {
	nextAllowed time.Time // earliest instant a new leading broadcast may fire
	pending     bool      // a change occurred inside the window, not yet broadcast
	armed       bool      // a trailing timer is scheduled
}

type Hub struct {
	mu        sync.Mutex
	rooms     map[string]map[string]*peer // room key -> peer id -> peer
	bcast     map[string]*roomBroadcast   // room key -> debounce state
	now       func() time.Time
	afterFunc func(time.Duration, func())
}

func NewHub() *Hub {
	return newHub(time.Now, func(d time.Duration, f func()) { time.AfterFunc(d, f) })
}

// newHub builds a Hub with an injectable clock and timer so the roster debounce
// is deterministically testable without wall-clock sleeps.
func newHub(now func() time.Time, after func(time.Duration, func())) *Hub {
	return &Hub{
		rooms:     make(map[string]map[string]*peer),
		bcast:     make(map[string]*roomBroadcast),
		now:       now,
		afterFunc: after,
	}
}

func (h *Hub) Join(room, id, name string, c Conn) {
	h.JoinLimited(room, id, name, c, 0, "")
}

// JoinLimited admits a peer unless the room already holds max peers (max <= 0
// means unlimited). Returns false without joining when the room is full. The
// welcome carries clientIP back to the joining peer only — it is never put in
// the roster broadcast to other peers.
func (h *Hub) JoinLimited(room, id, name string, c Conn, max int, clientIP string) bool {
	h.mu.Lock()
	if h.rooms[room] == nil {
		if len(h.rooms) >= maxRooms {
			h.mu.Unlock()
			return false // global room cap: refuse to create a new room
		}
		h.rooms[room] = make(map[string]*peer)
	}
	if max > 0 && len(h.rooms[room]) >= max {
		h.mu.Unlock()
		return false
	}
	h.rooms[room][id] = &peer{id: id, name: name, conn: c}
	h.mu.Unlock()

	c.Send(Envelope{Type: TypeWelcome, Name: id, IP: clientIP})
	h.scheduleRoster(room)
	return true
}

func (h *Hub) Leave(room, id string) {
	h.mu.Lock()
	if h.rooms[room] != nil {
		delete(h.rooms[room], id)
		if len(h.rooms[room]) == 0 {
			delete(h.rooms, room)
		}
	}
	h.mu.Unlock()
	h.scheduleRoster(room)
}

func (h *Hub) Relay(room string, e Envelope) {
	h.mu.Lock()
	var target *peer
	if h.rooms[room] != nil {
		target = h.rooms[room][e.To]
	}
	h.mu.Unlock()
	if target != nil {
		target.conn.Send(e)
	}
}

func (h *Hub) broadcastRoster(room string) {
	h.mu.Lock()
	members := h.rooms[room]
	roster := make([]Peer, 0, len(members))
	conns := make([]Conn, 0, len(members))
	for _, p := range members {
		roster = append(roster, Peer{ID: p.id, Name: p.name})
		conns = append(conns, p.conn)
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.Send(Envelope{Type: TypePeers, Peers: roster})
	}
}

// scheduleRoster requests a roster broadcast for room, coalescing to at most one
// per rosterDebounce window. The lock is released before afterFunc/broadcastRoster
// so a synchronous test timer cannot deadlock.
func (h *Hub) scheduleRoster(room string) {
	h.mu.Lock()
	rb := h.bcast[room]
	if rb == nil {
		rb = &roomBroadcast{}
		h.bcast[room] = rb
	}
	now := h.now()
	if !now.Before(rb.nextAllowed) {
		rb.nextAllowed = now.Add(rosterDebounce)
		rb.pending = false
		h.mu.Unlock()
		h.broadcastRoster(room)
		h.pruneBcast(room)
		return
	}
	rb.pending = true
	arm := !rb.armed
	if arm {
		rb.armed = true
	}
	delay := rb.nextAllowed.Sub(now)
	h.mu.Unlock()
	if arm {
		h.afterFunc(delay, func() { h.flushRoster(room) })
	}
}

// flushRoster fires the trailing broadcast at the end of a window when changes
// coalesced during it.
func (h *Hub) flushRoster(room string) {
	h.mu.Lock()
	rb := h.bcast[room]
	if rb == nil {
		h.mu.Unlock()
		return
	}
	rb.armed = false
	if !rb.pending {
		h.mu.Unlock()
		return
	}
	rb.pending = false
	rb.nextAllowed = h.now().Add(rosterDebounce)
	h.mu.Unlock()
	h.broadcastRoster(room)
	h.pruneBcast(room)
}

// pruneBcast drops debounce state for a room that is now empty and idle, keeping
// the bcast map bounded.
func (h *Hub) pruneBcast(room string) {
	h.mu.Lock()
	rb := h.bcast[room]
	if rb != nil && !rb.pending && !rb.armed && h.rooms[room] == nil {
		delete(h.bcast, room)
	}
	h.mu.Unlock()
}
