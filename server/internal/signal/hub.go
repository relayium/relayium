package signal

import "sync"

// Conn is the hub's view of a connection; the real websocket adapter implements it.
type Conn interface {
	Send(Envelope)
}

type peer struct {
	id   string
	name string
	conn Conn
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[string]*peer // room key -> peer id -> peer
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[string]*peer)}
}

func (h *Hub) Join(room, id, name string, c Conn) {
	h.JoinLimited(room, id, name, c, 0)
}

// JoinLimited admits a peer unless the room already holds max peers (max <= 0
// means unlimited). Returns false without joining when the room is full.
func (h *Hub) JoinLimited(room, id, name string, c Conn, max int) bool {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[string]*peer)
	}
	if max > 0 && len(h.rooms[room]) >= max {
		h.mu.Unlock()
		return false
	}
	h.rooms[room][id] = &peer{id: id, name: name, conn: c}
	h.mu.Unlock()

	c.Send(Envelope{Type: TypeWelcome, Name: id})
	h.broadcastRoster(room)
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
	h.broadcastRoster(room)
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
