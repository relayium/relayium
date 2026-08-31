package signal

import (
	"sort"
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
	// deviceID groups several connections of ONE installation (a browser's tabs)
	// into one advertised device. "" means "no installation identity": an older
	// client, a native client, or a rejected id — each of those stays a device
	// of its own, exactly as before.
	deviceID string
	// joinSeq/activeSeq come from one hub-wide counter, so "joined later" and
	// "focused later" are directly comparable. activeSeq is 0 for a connection
	// that has never said it is the current page.
	joinSeq   uint64
	activeSeq uint64
}

// beats reports whether p should represent its device group instead of best.
// Most recently focused wins; with nobody focused the most recently opened page
// wins; the id is a final tiebreak so the choice never depends on Go's map
// iteration order (which changes between broadcasts).
func (p *peer) beats(best *peer) bool {
	if best == nil {
		return true
	}
	if p.activeSeq != best.activeSeq {
		return p.activeSeq > best.activeSeq
	}
	if p.joinSeq != best.joinSeq {
		return p.joinSeq > best.joinSeq
	}
	return p.id < best.id
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
	seq       uint64                      // monotonic join/activation ordering, under mu
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
	return h.JoinDeviceLimited(room, id, name, c, max, clientIP, "", false)
}

// JoinDeviceLimited is JoinLimited plus the optional installation identity that
// groups one browser's tabs into a single advertised device.
//
// deviceID is untrusted input and is only honoured when it has the exact
// specified shape (ValidDeviceID); anything else is dropped and the connection
// behaves exactly like a pre-device client. active marks a page that is already
// the current/focused one, so the first roster it appears in already routes
// there rather than to whichever sibling tab happens to sort first.
//
// Capacity: a connection joining a device group that is ALREADY in the room does
// not consume a logical slot. Room capacity counts devices a user could pick,
// and a second tab of a device already listed adds no entry to anyone's roster.
// The transport-level caps (per-IP and global concurrent connections) are
// unaffected and remain the bound on how many sockets one address may hold.
func (h *Hub) JoinDeviceLimited(room, id, name string, c Conn, max int, clientIP, deviceID string, active bool) bool {
	admitted, _ := h.JoinDeviceLimitedObserved(room, id, name, c, max, clientIP, deviceID, active)
	return admitted
}

// JoinDeviceLimitedObserved is JoinDeviceLimited plus the connection count at
// the exact successful-admission instant. The count is captured under the same
// hub lock that inserts the peer; reading PeerCount afterwards is racy because
// that peer can leave before the second lock acquisition. Welcome and roster
// delivery remain outside the lock, as does every caller's observer callback.
func (h *Hub) JoinDeviceLimitedObserved(room, id, name string, c Conn, max int, clientIP, deviceID string, active bool) (admitted bool, peers int) {
	if !ValidDeviceID(deviceID) {
		deviceID = ""
	}
	h.mu.Lock()
	if h.rooms[room] == nil {
		if len(h.rooms) >= maxRooms {
			h.mu.Unlock()
			return false, 0 // global room cap: refuse to create a new room
		}
		h.rooms[room] = make(map[string]*peer)
	}
	if max > 0 && h.logicalDeviceCount(room) >= max && !h.hasDevice(room, deviceID) {
		h.mu.Unlock()
		return false, 0
	}
	h.seq++
	p := &peer{id: id, name: name, conn: c, deviceID: deviceID, joinSeq: h.seq}
	if active && deviceID != "" {
		p.activeSeq = h.seq
	}
	h.rooms[room][id] = p
	peers = len(h.rooms[room])
	h.mu.Unlock()

	c.Send(Envelope{Type: TypeWelcome, Name: id, IP: clientIP})
	h.scheduleRoster(room)
	return true, peers
}

// PeerCount is how many connections the room currently holds.
//
// Connections, not devices: a pairing-code room admits exactly two and does not
// group tabs (JoinDeviceLimited honours device grouping on the LAN room only),
// so "the room holds two" is precisely "this code is paired" there. Used by the
// join observer (ServeWSObserved) to tell the pre-upload lifecycle that the code
// has been claimed.
func (h *Hub) PeerCount(room string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms[room])
}

// logicalDeviceCount returns how many selectable devices the room currently
// contains. Connections with a valid installation id share one slot; legacy or
// identity-less connections each consume their own slot. Caller holds h.mu.
func (h *Hub) logicalDeviceCount(room string) int {
	devices := make(map[string]struct{})
	loners := 0
	for _, p := range h.rooms[room] {
		if p.deviceID == "" {
			loners++
			continue
		}
		devices[p.deviceID] = struct{}{}
	}
	return len(devices) + loners
}

// hasDevice reports whether room already holds a connection of this
// installation. Caller holds h.mu. An empty deviceID is never a group.
func (h *Hub) hasDevice(room, deviceID string) bool {
	if deviceID == "" {
		return false
	}
	for _, p := range h.rooms[room] {
		if p.deviceID == deviceID {
			return true
		}
	}
	return false
}

// Activate records that the sender's own connection is now the page the user is
// looking at, so requests aimed at its device reach this tab rather than a
// background one.
//
// Scoped to (room, id) — the pair the server itself stamped on the connection —
// so a client can only ever move its own connection. It is a no-op for a
// connection with no installation identity, or when the outcome cannot change,
// in which case no roster broadcast is spent.
func (h *Hub) Activate(room, id string) {
	h.mu.Lock()
	members := h.rooms[room]
	p := members[id]
	if p == nil || p.deviceID == "" {
		h.mu.Unlock()
		return
	}
	// Only a group with a sibling can hand the device over; re-activating the
	// page that already represents it changes nothing anyone can observe.
	changes := false
	for _, other := range members {
		if other != p && other.deviceID == p.deviceID && other.beats(p) {
			changes = true
			break
		}
	}
	if !changes {
		h.mu.Unlock()
		return
	}
	h.seq++
	p.activeSeq = h.seq
	h.mu.Unlock()
	h.scheduleRoster(room)
}

func (h *Hub) Leave(room, id string) {
	h.mu.Lock()
	members := h.rooms[room]
	departed := members[id]
	if departed == nil {
		h.mu.Unlock()
		return
	}
	delete(members, id)
	// A roster change cannot distinguish a focus handoff from a physical page
	// closing: both can replace the advertised representative id. Notify other
	// installations of the actual close explicitly so they can preserve live
	// sessions during the former and end them during the latter. Sibling tabs
	// never see or target one another, so do not disclose their hidden ids.
	remaining := make([]Conn, 0, len(members))
	for _, p := range members {
		if departed.deviceID != "" && p.deviceID == departed.deviceID {
			continue
		}
		remaining = append(remaining, p.conn)
	}
	if len(members) == 0 {
		delete(h.rooms, room)
	}
	h.mu.Unlock()
	for _, c := range remaining {
		c.Send(Envelope{Type: TypeLeft, Peer: id})
	}
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

// delivery is one recipient and the roster it is owed. Rosters are per-recipient
// because grouping makes them genuinely differ: a page must not be offered its
// own installation's other tabs.
type delivery struct {
	conn  Conn
	peers []Peer
}

// rosterEntry is one advertised device: the peer that represents it, plus the
// installation it belongs to ("" for a peer with no installation identity).
// The device id is used only to decide who must NOT be told about it; it is
// never put on the wire.
type rosterEntry struct {
	device string
	peer   Peer
}

func (h *Hub) broadcastRoster(room string) {
	h.mu.Lock()
	members := h.rooms[room]
	// One representative per installation, plus every identity-less peer as
	// itself. Computed once for the room, then filtered per recipient.
	reps := make(map[string]*peer, len(members)) // deviceID -> representative
	var loners []*peer
	for _, p := range members {
		if p.deviceID == "" {
			loners = append(loners, p)
			continue
		}
		if p.beats(reps[p.deviceID]) {
			reps[p.deviceID] = p
		}
	}
	// The full advertised list, sorted once. Every recipient's roster is a subset
	// of it in the same order, so nobody's list can reshuffle between two
	// broadcasts of the same membership (Go map iteration is randomised, and
	// selection bound to a row's position is how the wrong device gets picked).
	all := make([]rosterEntry, 0, len(reps)+len(loners))
	for device, rep := range reps {
		all = append(all, rosterEntry{device: device, peer: Peer{ID: rep.id, Name: rep.name}})
	}
	for _, p := range loners {
		all = append(all, rosterEntry{peer: Peer{ID: p.id, Name: p.name}})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].peer.Name != all[j].peer.Name {
			return all[i].peer.Name < all[j].peer.Name
		}
		return all[i].peer.ID < all[j].peer.ID
	})
	out := make([]delivery, 0, len(members))
	for _, recipient := range members {
		peers := make([]Peer, 0, len(all))
		for _, e := range all {
			// A client with an installation identity is never shown its own
			// pages: they are not send targets, and listing them under one
			// shared device name is what let a peer pick the wrong page.
			if e.device != "" && e.device == recipient.deviceID {
				continue
			}
			// A client with no installation identity keeps the roster shape it
			// was written against, which includes itself; it filters its own id
			// by comparing against the welcome. Only a device-aware client gets
			// the self-omitting shape.
			if e.device == "" && recipient.deviceID != "" && e.peer.ID == recipient.id {
				continue
			}
			peers = append(peers, e.peer)
		}
		out = append(out, delivery{conn: recipient.conn, peers: peers})
	}
	h.mu.Unlock()
	for _, d := range out {
		d.conn.Send(Envelope{Type: TypePeers, Peers: d.peers})
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
